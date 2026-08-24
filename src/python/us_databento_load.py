#!/usr/bin/env python3
"""Databento OHLCV-1d jobs -> one Parquet table.

    data/raw/databento/*.zip           (one per Databento job)
        │  read IN PLACE — never extracted
        ▼
    data/extracts_us/_meta/databento_ohlcv.parquet

THREE MEMBER ENCODINGS, ALL HANDLED, ALL DIFFERENT
  A job ships one member per trading day in whichever encoding was requested:

    .csv       plain          read with pandas
    .csv.zst   zstd           DuckDB decompresses natively
    .dbn.zst   binary + zstd  the `databento` package decodes it

  The DBN path does MORE than decode. A DBN job cut with map_symbols=false
  carries no symbol on the records at all — only instrument_id — and DBNStore
  resolves symbols from the embedded symbology. It also applies the price scale
  itself, so `pretty_px: false` must NOT be re-applied afterwards or every price
  is scaled twice. That is why scaling is keyed on the ENCODING, not just the
  manifest flag.

WHY THIS STREAMS INTO DUCKDB
  A full-market job is ~11,500 symbols x ~2,100 sessions, around 24M bars.
  Concatenating that in pandas before writing needs several GB and gains
  nothing. Each member is appended to an on-disk DuckDB table instead, and
  series_id is computed in SQL at the end, where it needs the whole history per
  symbol anyway.

THE TRAP: A TICKER IS NOT AN INSTRUMENT
  When a ticker has been REUSED, labelling every row with the resolved symbol
  silently concatenates two unrelated instruments into one series. Measured on
  the first pull:

      IBIT  258-day gap, resumes 2024-01-11 (the iShares trust's first day)
            close 20.84 -> open 27.27,  volume 1 -> 15,917,037
      SPCX   67-day gap, resumes 2026-06-12
            close 21.95 -> open 150.00, volume 4,077 -> 219,552,085

  A 52-week high computed across those seams is nonsense, and nothing in the
  file marks them. `instrument_id` cannot rescue it either: it is reassigned per
  session, so TSLA carried 873 distinct ids over 2,089 days.

  So the seam is detected from the only signal left — a listing gap — and
  recorded as `series_id`. Nothing is dropped. Callers group by
  (symbol, series_id) and cannot accidentally span a reuse. db.js partitions
  every window that way.

SINGLE VENUE, NOT THE TAPE
  XNAS.ITCH is Nasdaq-executed volume only. For Nasdaq-primary listings the
  close should match the official closing auction, but VOLUME is a fraction of
  consolidated — comparing it against a consolidated source measures Nasdaq
  market share, not activity. `dataset` is carried per row so a reader can tell
  which venue a bar came from.

Usage:
    python src/python/us_databento_load.py            # every zip in data/raw/databento
    python src/python/us_databento_load.py --zip <path>
    python src/python/us_databento_load.py --limit 30 # first N sessions, smoke test
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import tempfile
import time
import zipfile
from pathlib import Path

import duckdb
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("databento")

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "databento"
OUT = ROOT / "data" / "extracts_us" / "_meta" / "databento_ohlcv.parquet"

# Calendar days without a bar that mark a candidate listing gap. Generous on
# purpose: a real halt is days, a relisting is months. On its own this is NOT
# sufficient to call a reuse — see REUSE_MIN_VOLUME below and the comment at
# the series_id computation.
GAP_DAYS = 20

# A gap only becomes a series split when trading resumes at a volume that
# looks like a genuinely different, actively-traded instrument: at least
# REUSE_MIN_VOLUME shares AND at least REUSE_VOL_RATIO times the volume on the
# last bar before the gap. Calibrated against the full-market file: IBIT
# (ratio 15.9M) and SPCX (ratio 53,851) clear this by 3-4 orders of magnitude;
# an illiquid preferred share resuming thin trading after a lull does not.
REUSE_MIN_VOLUME = 100_000
REUSE_VOL_RATIO = 20

BAR_COLS = ["symbol", "date", "open", "high", "low", "close",
            "volume", "instrument_id", "dataset", "job"]

MEMBER_SUFFIXES = (".csv", ".csv.zst", ".dbn.zst")


def job_meta(z: zipfile.ZipFile) -> tuple[str | None, bool, str | None]:
    """(dataset, pretty_px, schema) from metadata.json.

    Read from the manifest rather than parsed out of filenames: the member names
    carry a dataset prefix, but the manifest is what Databento guarantees.
    """
    if "metadata.json" not in z.namelist():
        return None, True, None
    md = json.loads(z.read("metadata.json"))
    q = md.get("query") or {}
    pretty = bool((md.get("customizations") or {}).get("pretty_px", True))
    return q.get("dataset"), pretty, q.get("schema")


def frame_from_dbn(raw: bytes) -> pd.DataFrame:
    """One .dbn.zst member -> a frame with a real `symbol` column.

    Imported lazily so a CSV-only job does not require the dependency.
    """
    import databento as db

    df = db.DBNStore.from_bytes(raw).to_df().reset_index()
    # to_df() has already applied the price scale, so the caller must not.
    return df


def read_member(z: zipfile.ZipFile, name: str, tmp: Path) -> pd.DataFrame:
    if name.endswith(".dbn.zst"):
        return frame_from_dbn(z.read(name))
    if name.endswith(".csv.zst"):
        # DuckDB has no reader for the ZIP container, so the member is staged;
        # it decompresses zstd natively from a path.
        p = tmp / Path(name).name
        p.write_bytes(z.read(name))
        con = duckdb.connect()
        df = con.execute(f"SELECT * FROM read_csv('{p.as_posix()}')").df()
        con.close()
        p.unlink(missing_ok=True)
        return df
    return pd.read_csv(io.BytesIO(z.read(name)))


def normalise(df: pd.DataFrame, dataset: str, job: str, scale: bool) -> pd.DataFrame:
    """One member's frame -> BAR_COLS, typed and dated."""
    # ts_event is a STRING from the pandas path and a TIMESTAMP from the DuckDB
    # and DBN paths, so neither .str[:10] nor .dt works for both. Daily bars are
    # stamped at UTC midnight; normalise to UTC before taking the date or a
    # positive-offset local timezone rolls every bar back a day.
    ts = df["ts_event"]
    if pd.api.types.is_datetime64_any_dtype(ts):
        parsed = pd.to_datetime(ts, utc=True).dt.tz_convert(None)
    else:
        parsed = pd.to_datetime(ts.astype(str).str[:10])
    df["date"] = parsed.dt.normalize()

    for c in ("open", "high", "low", "close", "volume"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    if scale:
        # Fixed-point integers at 1e-9. AAPL's open arrives as 312520000000 for
        # $312.52 — off by nine orders of magnitude, and nothing about the value
        # looks wrong enough to catch by eye.
        for c in ("open", "high", "low", "close"):
            df[c] = df[c] * 1e-9

    df["dataset"] = dataset
    df["job"] = job
    return df[BAR_COLS]


def main() -> None:
    p = argparse.ArgumentParser(description="load Databento ohlcv-1d jobs -> parquet")
    p.add_argument("--zip", help="a single job zip; default is every zip under data/raw/databento")
    p.add_argument("--limit", type=int, default=0, help="cap sessions per job (smoke test)")
    a = p.parse_args()

    zips = [Path(a.zip)] if a.zip else sorted(RAW.glob("*.zip"))
    if not zips:
        raise SystemExit(f"no zips found under {RAW}")
    missing = [z for z in zips if not z.is_file()]
    if missing:
        raise SystemExit(f"no such file: {missing[0]}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    work = OUT.parent / ".databento_work.duckdb"
    work.unlink(missing_ok=True)
    con = duckdb.connect(str(work))
    con.execute("""CREATE TABLE bars (
        symbol VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE,
        close DOUBLE, volume DOUBLE, instrument_id BIGINT,
        dataset VARCHAR, job VARCHAR)""")

    t0 = time.time()
    total = 0
    with tempfile.TemporaryDirectory(prefix="dbn_") as tmpdir:
        tmp = Path(tmpdir)
        for zpath in zips:
            z = zipfile.ZipFile(zpath)
            dataset, pretty_px, schema = job_meta(z)
            if schema and schema != "ohlcv-1d":
                raise SystemExit(f"{zpath.name}: schema is {schema}, expected ohlcv-1d")
            names = sorted(n for n in z.namelist() if n.endswith(MEMBER_SUFFIXES))
            if not names:
                log.warning("%s holds no readable members", zpath.name)
                continue
            if a.limit:
                names = names[: a.limit]
            is_dbn = names[0].endswith(".dbn.zst")
            # Scaling is keyed on ENCODING as well as the flag: DBNStore.to_df()
            # already applied it, so honouring pretty_px there would scale twice.
            scale = (not pretty_px) and not is_dbn
            log.info("%s: %d sessions, %s, pretty_px=%s -> scale=%s",
                     zpath.name, len(names), "dbn" if is_dbn else "csv", pretty_px, scale)

            for i, name in enumerate(names, 1):
                try:
                    df = normalise(read_member(z, name, tmp), dataset or zpath.stem,
                                   zpath.stem, scale)
                    con.register("_m", df)
                    con.execute("INSERT INTO bars SELECT * FROM _m")
                    con.unregister("_m")
                    total += len(df)
                except Exception as e:
                    log.warning("skip %s: %s", name, e)
                if i % 250 == 0:
                    log.info("  %d/%d sessions, %d bars, %.0fs",
                             i, len(names), total, time.time() - t0)

    n = con.execute("SELECT count(*) FROM bars").fetchone()[0]
    if not n:
        raise SystemExit("nothing loaded")
    log.info("%d bars staged in %.0fs", n, time.time() - t0)

    # Two jobs can overlap, and re-running must not double the bars.
    # (symbol, date, dataset) is the natural key.
    con.execute("""CREATE TABLE deduped AS
        SELECT * EXCLUDE (rn) FROM (
          SELECT *, row_number() OVER (
            PARTITION BY symbol, date, dataset ORDER BY job DESC) AS rn
          FROM bars) WHERE rn = 1""")
    dropped = n - con.execute("SELECT count(*) FROM deduped").fetchone()[0]
    if dropped:
        log.info("dropped %d duplicate bars across jobs", dropped)

    # series_id in SQL: a cumulative count of listing gaps per symbol. The first
    # bar of each symbol has a NULL gap, which is not > GAP_DAYS, so every
    # symbol starts at series 1.
    #
    # GAP ALONE IS NOT ENOUGH — found running this at full-market scale. The
    # 10-symbol trial validated GAP_DAYS against IBIT and SPCX, where the gap
    # happened to coincide with genuine relistings. Across the full market,
    # 5,983 of 23,749 symbols got flagged this way, some split into 40-51
    # "series" — PCG-C (a real PG&E preferred share) split 42 times over
    # illiquid trading gaps while its price moved a continuous $21->$18 across
    # the whole span and volume stayed in the hundreds throughout. That is one
    # instrument trading thinly for eight years, not 42 different ones.
    #
    # What actually distinguished IBIT and SPCX was not the gap, it was the
    # DISCONTINUITY at it: volume 1 -> 15,917,037 for IBIT (ratio 15.9M),
    # 4,077 -> 219,552,085 for SPCX (ratio 53,851). An illiquid name resuming
    # thin trading shows no such jump — checked across every gap in the file,
    # 31,426 of 31,627 (99.4%) have neither a liquid resuming volume nor a
    # large ratio. Requiring BOTH conditions drops flagged symbols from 5,983
    # to 191, a plausible count for genuine reuse across the market's history
    # (delistings, reverse mergers, recycled symbols), while IBIT and SPCX
    # still pass by four and three orders of magnitude respectively.
    con.execute(f"""CREATE TABLE final AS
        WITH gapped AS (
          SELECT *,
                 date_diff('day',
                     lag(date) OVER (PARTITION BY symbol ORDER BY date), date) AS gap,
                 lag(volume) OVER (PARTITION BY symbol ORDER BY date) AS prev_volume
          FROM deduped
        )
        SELECT symbol,
               1 + sum(CASE WHEN gap > {GAP_DAYS}
                              AND volume >= {REUSE_MIN_VOLUME}
                              AND volume >= {REUSE_VOL_RATIO} * GREATEST(prev_volume, 1)
                            THEN 1 ELSE 0 END)
                     OVER (PARTITION BY symbol ORDER BY date) AS series_id,
               date, open, high, low, close, volume, instrument_id, dataset, job
        FROM gapped""")
    con.execute("""CREATE TABLE out AS
        SELECT symbol, series_id, symbol || '#' || series_id AS series_symbol,
               date, open, high, low, close, volume, instrument_id, dataset, job
        FROM final ORDER BY symbol, series_id, date""")

    seams = con.execute("""SELECT symbol, max(series_id) AS n FROM out
        GROUP BY 1 HAVING max(series_id) > 1 ORDER BY 2 DESC, 1""").fetchall()
    if seams:
        log.warning("ticker reuse detected in %d symbols", len(seams))
        for sym, k in seams[:10]:
            log.warning("  %s split into %d series", sym, k)
        if len(seams) > 10:
            log.warning("  ... and %d more", len(seams) - 10)
    else:
        log.info("no ticker reuse detected")

    con.execute(f"COPY out TO '{OUT.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    rows, syms, lo, hi = con.execute(
        "SELECT count(*), count(DISTINCT symbol), min(date), max(date) FROM out").fetchone()
    con.close()
    work.unlink(missing_ok=True)  # scratch only; the parquet is the output

    log.info("wrote %s (%.1f MiB) — %d bars, %d symbols, %s -> %s in %.0fs",
             OUT, OUT.stat().st_size / 1048576, rows, syms, lo, hi, time.time() - t0)


if __name__ == "__main__":
    main()

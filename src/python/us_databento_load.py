#!/usr/bin/env python3
"""Databento OHLCV-1d zips -> one Parquet table.

    data/raw/databento/*.zip           (one per Databento job)
        │  read IN PLACE — never extracted
        ▼
    data/extracts_us/_meta/databento_ohlcv.parquet

WHY NOT JUST READ THE CSVs
  A job ships one CSV per trading day — 2,089 of them for a 2018-2026 pull, each
  around 600 bytes. Extracting produces thousands of tiny files for a few MB of
  data. zipfile serves any member by name, so the archive stays one file.

THE TRAP: A TICKER IS NOT AN INSTRUMENT
  `map_symbols: true` resolves the raw symbol across the whole window and labels
  every row with it. When a ticker has been REUSED, that silently concatenates
  two unrelated instruments into one series. Measured in the first pull:

      IBIT  258-day gap, resumes 2024-01-11 (the iShares trust's first day)
            close 20.84 -> open 27.27,  volume 1 -> 15,917,037
      SPCX   67-day gap, resumes 2026-06-12
            close 21.95 -> open 150.00, volume 4,077 -> 219,552,085

  A 52-week high or a return computed across those seams is nonsense, and
  nothing in the file marks them. `instrument_id` cannot rescue it either: it is
  reassigned per session, so TSLA alone carries 873 distinct ids over 2,089 days.

  So the seam is detected here, from the only signal left — a listing gap — and
  recorded as `series_id`. Nothing is dropped: IBIT keeps all 742 rows, but the
  pre-2024 ones are series 1 and the trust is series 2. Callers group by
  (symbol, series_id) and cannot accidentally span a reuse. GAP_DAYS is
  deliberately generous; a real halt is days, a relisting is months.

SINGLE VENUE, NOT THE TAPE
  XNAS.ITCH is Nasdaq-executed volume only. For Nasdaq-primary listings the
  close should match the official closing auction, but VOLUME is a fraction of
  consolidated — comparing it against Yahoo's consolidated volume in us_prices
  measures Nasdaq market share, not activity. `dataset` is carried per row so a
  reader can tell which venue a bar came from.

Usage:
    python src/python/us_databento_load.py            # every zip in data/raw/databento
    python src/python/us_databento_load.py --zip <path>
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

# Calendar days without a bar that mark a new listing rather than a halt.
GAP_DAYS = 20


def read_zip(zpath: Path) -> pd.DataFrame:
    """One Databento job zip -> a frame of every bar in it.

    Handles both member encodings Databento ships. A plain-CSV job is read
    straight out of the archive; a .csv.zst job cannot be, because DuckDB has no
    reader for the ZIP container and the `zstandard` package is not a
    dependency. Those members are staged to a temp dir and read in ONE DuckDB
    pass over the glob -- DuckDB decompresses zstd natively, and 2,000 separate
    reads would otherwise dominate the run.
    """
    z = zipfile.ZipFile(zpath)
    names = sorted(n for n in z.namelist() if n.endswith((".csv", ".csv.zst")))
    if not names:
        log.warning("%s holds no CSV members", zpath.name)
        return pd.DataFrame()

    # metadata.json records what the job was actually cut from. Read it rather
    # than parsing filenames: the names carry a dataset prefix, but the manifest
    # is what Databento guarantees.
    dataset = schema = None
    pretty_px = True
    if "metadata.json" in z.namelist():
        md = json.loads(z.read("metadata.json"))
        q = md.get("query") or {}
        dataset, schema = q.get("dataset"), q.get("schema")
        # pretty_px False means prices are FIXED-POINT integers at 1e-9. Read as
        # published they are off by nine orders of magnitude -- AAPL arrives as
        # 312520000000 for $312.52 -- and nothing about the value looks wrong
        # enough to catch by eye.
        pretty_px = bool((md.get("customizations") or {}).get("pretty_px", True))
    if schema and schema != "ohlcv-1d":
        raise SystemExit(f"{zpath.name}: schema is {schema}, this loader expects ohlcv-1d")

    zst = [n for n in names if n.endswith(".zst")]
    if zst:
        with tempfile.TemporaryDirectory(prefix="dbn_") as tmp:
            for n in zst:
                (Path(tmp) / Path(n).name).write_bytes(z.read(n))
            con = duckdb.connect()
            glob = (Path(tmp) / "*.csv.zst").as_posix()
            df = con.execute(
                f"SELECT * FROM read_csv('{glob}', union_by_name=true)").df()
            con.close()
        plain = [n for n in names if not n.endswith(".zst")]
        if plain:
            df = pd.concat([df] + [pd.read_csv(io.BytesIO(z.read(n))) for n in plain],
                           ignore_index=True)
    else:
        df = pd.concat([pd.read_csv(io.BytesIO(z.read(n))) for n in names],
                       ignore_index=True)

    if not pretty_px:
        for c in ("open", "high", "low", "close"):
            df[c] = pd.to_numeric(df[c], errors="coerce") * 1e-9
        log.info("%s: fixed-point prices scaled by 1e-9", zpath.name)

    df["dataset"] = dataset or zpath.stem
    df["job"] = zpath.stem
    log.info("%s: %d bars over %d sessions (%s)", zpath.name, len(df), len(names), dataset)
    return df


def add_series_id(df: pd.DataFrame) -> pd.DataFrame:
    """Split each symbol's history wherever a listing gap says the ticker moved."""
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    gap = df.groupby("symbol")["date"].diff().dt.days
    # cumsum over "this row starts a new series" — first row of each symbol has a
    # NaN diff, which is not > GAP_DAYS, so every symbol starts at series 1.
    df["series_id"] = (gap > GAP_DAYS).groupby(df["symbol"]).cumsum() + 1
    df["series_symbol"] = df["symbol"] + "#" + df["series_id"].astype(str)
    return df


def main() -> None:
    p = argparse.ArgumentParser(description="load Databento ohlcv-1d zips -> parquet")
    p.add_argument("--zip", help="a single job zip; default is every zip under data/raw/databento")
    a = p.parse_args()

    zips = [Path(a.zip)] if a.zip else sorted(RAW.glob("*.zip"))
    if not zips:
        raise SystemExit(f"no zips found under {RAW}")
    missing = [z for z in zips if not z.is_file()]
    if missing:
        raise SystemExit(f"no such file: {missing[0]}")

    t0 = time.time()
    frames = [f for f in (read_zip(z) for z in zips) if not f.empty]
    if not frames:
        raise SystemExit("nothing to load")
    df = pd.concat(frames, ignore_index=True)

    # ts_event arrives as a STRING from the pandas path and as a TIMESTAMP from
    # the DuckDB/zst path, so neither .str[:10] nor .dt works for both. Daily
    # bars are stamped at UTC midnight; normalise to UTC before taking the date
    # or a positive-offset local timezone rolls every bar to the previous day.
    ts = df["ts_event"]
    if pd.api.types.is_datetime64_any_dtype(ts):
        parsed = pd.to_datetime(ts, utc=True).dt.tz_convert(None)
    else:
        parsed = pd.to_datetime(ts.astype(str).str[:10])
    df["date"] = parsed.dt.normalize()
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # Two jobs can overlap in time, and re-running a pull must not double the
    # bars. (symbol, date, dataset) is the natural key; last write wins.
    before = len(df)
    df = df.drop_duplicates(subset=["symbol", "date", "dataset"], keep="last")
    if before != len(df):
        log.info("dropped %d duplicate bars across jobs", before - len(df))

    df = add_series_id(df)

    seams = df[df["series_id"] > 1].groupby("symbol")["series_id"].max()
    if not seams.empty:
        for sym, n in seams.items():
            log.warning("ticker reuse: %s split into %d series", sym, n)
    else:
        log.info("no ticker reuse detected")

    out = df[[
        "symbol", "series_id", "series_symbol", "date",
        "open", "high", "low", "close", "volume",
        "instrument_id", "dataset", "job",
    ]].sort_values(["symbol", "series_id", "date"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.register("_out", out)
    con.execute(f"COPY _out TO '{OUT.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.close()
    log.info("wrote %s — %d bars, %d symbols, %s -> %s in %.0fs",
             OUT, len(out), out["symbol"].nunique(),
             out["date"].min().date(), out["date"].max().date(), time.time() - t0)


if __name__ == "__main__":
    main()

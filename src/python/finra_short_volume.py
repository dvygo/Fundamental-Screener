#!/usr/bin/env python3
"""FINRA Reg SHO daily short sale volume -> Parquet, accumulated.

    finra.org daily-short-sale-volume-files   (the catalog page)
        │  links DISCOVERED from the page, never constructed
        ▼
    cdn.finra.org/.../CNMSshvol<YYYYMMDD>.txt   (pipe-delimited)
        ▼
    data/extracts_us/_meta/finra_short_volume.parquet

THE LOCAL FILE IS THE ARCHIVE
  The catalog page carries a ROLLING WINDOW — 15 trading dates when this was
  written. Miss a run and those dates are gone from the page; FINRA points at
  monthly files or a query API for older data. So this appends rather than
  replaces, and the Parquet is the only complete history we will have. Run it
  daily. Dates already stored are skipped, so re-running is free and safe.

SIX FILES PER DAY, ONE LOADED
  The page publishes CNMS, FNQC, FNRA, FNSQ, FNYX and FORF for each date.
  CNMS is the consolidated NMS file — the TRFs plus the ADF combined for
  exchange-listed securities — and is the only one read here. The others are
  its per-facility components, plus FORF for OTC securities, which are a
  different universe. Loading CNMS alongside its own components would double
  count.

WHAT THIS IS NOT
  1. Not the whole market. These are trades reported to a TRF/ADF — off-exchange
     execution, dark pools and internalisers. Exchange-executed volume is NOT
     here. Measured on 2026-08-21, TSLA showed 28,090,470 shares off-exchange
     against 14,657,671 on Nasdaq: two non-overlapping slices, neither of them
     consolidated. Do not compare this `total_volume` with us_prices.volume.

  2. Not short interest. This is shares sold short during the session, a large
     part of which is market makers hedging inventory — mechanical, not a view
     on the stock. Short interest (open positions) is a different file, loaded
     by finra_short_interest.py.

  3. Not a signal at face value. Median short ratio across the 1,101 symbols
     with over 1M shares on 2026-08-21 was 0.505. AAPL sat at 0.504 — dead
     average; NVDA at 0.367 was BELOW it. A screen on "short volume above 50%"
     fires on half the market every day. Only deviation from a symbol's own
     baseline carries information, so the ratio is left to the query layer
     rather than being baked in here as though it meant something alone.

Usage:
    python src/python/finra_short_volume.py             # fetch what is new
    python src/python/finra_short_volume.py --all       # re-fetch every listed date
"""
from __future__ import annotations

import argparse
import io
import logging
import re
import time
from pathlib import Path

import duckdb
import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("finra-shvol")

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "extracts_us" / "_meta" / "finra_short_volume.parquet"

CATALOG = ("https://www.finra.org/finra-data/browse-catalog/"
           "short-sale-volume-data/daily-short-sale-volume-files")
# Consolidated NMS only — see the module docstring on why the other five are
# deliberately skipped. This CLASSIFIES discovered links; it never builds one.
CNMS = re.compile(r"https://cdn\.finra\.org/[^\"']*/CNMSshvol(\d{8})\.txt", re.I)

UA = "Fundamental-Screener research (contact: narasimhadeshik@gmail.com)"
PAUSE = 0.5  # between file fetches; this is a courtesy, not a rate limit


def discover(client: httpx.Client) -> dict[str, str]:
    """Catalog page -> {YYYYMMDD: url}. Links come from the page, never built."""
    r = client.get(CATALOG)
    r.raise_for_status()
    found = {m.group(1): m.group(0) for m in CNMS.finditer(r.text)}
    log.info("catalog lists %d consolidated dates", len(found))
    return found


def already_stored() -> set[str]:
    if not OUT.exists():
        return set()
    con = duckdb.connect()
    rows = con.execute(
        f"SELECT DISTINCT strftime(as_of, '%Y%m%d') FROM read_parquet('{OUT.as_posix()}')"
    ).fetchall()
    con.close()
    return {r[0] for r in rows}


def main() -> None:
    p = argparse.ArgumentParser(description="load FINRA daily short sale volume")
    p.add_argument("--all", action="store_true",
                   help="re-fetch every date the page lists, not just new ones")
    a = p.parse_args()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    have = set() if a.all else already_stored()
    if have:
        log.info("%d dates already stored", len(have))

    t0 = time.time()
    frames: list[pd.DataFrame] = []
    with httpx.Client(headers={"User-Agent": UA}, follow_redirects=True, timeout=60) as client:
        listed = discover(client)
        todo = sorted(d for d in listed if d not in have)
        if not todo:
            log.info("nothing new on the page")
            return
        log.info("fetching %d new dates: %s -> %s", len(todo), todo[0], todo[-1])

        for i, day in enumerate(todo, 1):
            try:
                r = client.get(listed[day])
                r.raise_for_status()
                # Pipe-delimited despite serving as text/plain.
                df = pd.read_csv(io.BytesIO(r.content), sep="|")
                # The files carry a trailing summary row with no symbol; it would
                # otherwise arrive as a NaN-symbol row in the middle of the store.
                df = df[df["Symbol"].notna()]
                frames.append(df)
            except Exception as e:
                log.warning("skip %s: %s", day, e)
            if i % 10 == 0:
                log.info("%d/%d fetched", i, len(todo))
            time.sleep(PAUSE)

    if not frames:
        log.warning("nothing fetched")
        return

    new = pd.concat(frames, ignore_index=True)
    new = new.rename(columns={
        "Date": "as_of", "Symbol": "symbol", "ShortVolume": "short_volume",
        "ShortExemptVolume": "short_exempt_volume", "TotalVolume": "total_volume",
        "Market": "markets",
    })
    new["as_of"] = pd.to_datetime(new["as_of"], format="%Y%m%d")
    new["symbol"] = new["symbol"].astype(str).str.strip().str.upper()
    for c in ("short_volume", "short_exempt_volume", "total_volume"):
        # Volumes are FRACTIONAL in this feed (509558.830081) because
        # fractional-share trades are aggregated in. Not an integer column.
        new[c] = pd.to_numeric(new[c], errors="coerce")
    new = new[["as_of", "symbol", "short_volume", "short_exempt_volume",
               "total_volume", "markets"]]

    con = duckdb.connect()
    con.register("_new", new)
    if OUT.exists():
        # Read the existing store BEFORE overwriting it — COPY to the same path
        # we are reading from would truncate the input mid-query.
        con.execute(f"CREATE TABLE store AS SELECT * FROM read_parquet('{OUT.as_posix()}')")
        con.execute("INSERT INTO store SELECT * FROM _new")
    else:
        con.execute("CREATE TABLE store AS SELECT * FROM _new")
    # Belt and braces against a --all re-run: one row per symbol per day.
    con.execute("""CREATE TABLE deduped AS
        SELECT * EXCLUDE (rn) FROM (
          SELECT *, row_number() OVER (PARTITION BY as_of, symbol ORDER BY total_volume DESC) AS rn
          FROM store) WHERE rn = 1""")
    n, days, syms = con.execute(
        "SELECT count(*), count(DISTINCT as_of), count(DISTINCT symbol) FROM deduped").fetchone()
    con.execute(f"COPY (SELECT * FROM deduped ORDER BY as_of, symbol) "
                f"TO '{OUT.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.close()

    log.info("wrote %s — %d rows, %d dates, %d symbols in %.0fs",
             OUT, n, days, syms, time.time() - t0)


if __name__ == "__main__":
    main()

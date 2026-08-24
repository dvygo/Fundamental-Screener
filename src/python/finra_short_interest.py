#!/usr/bin/env python3
"""FINRA biweekly equity short interest -> Parquet, accumulated.

    finra.org equity-short-interest/files      (the catalog page)
        │  links DISCOVERED from the page, never constructed
        ▼
    cdn.finra.org/.../shrt<YYYYMMDD>.csv       (pipe-delimited, see below)
        ▼
    data/extracts_us/_meta/finra_short_interest.parquet

WHAT IT REPLACES
  finviz's Short Interest, Short Ratio and Short Float, from the primary source.
  Checked against the 2026-07-31 settlement: AAPL currentShortPositionQuantity
  is 141,606,163, and finviz publishes "Short Interest 141.61M". Same number,
  one vendor removed — and this one carries the previous period, the change,
  and a settlement date the vendor grid does not show.

  Note this is OPEN SHORT POSITIONS, not the daily short sale volume loaded by
  finra_short_volume.py. The two get conflated constantly and mean different
  things: this is a stock, that is a flow.

THE .csv IS PIPE-DELIMITED
  Despite the extension. Parsing it as comma-separated does not fail cleanly —
  it dies on the first issuer name containing a comma ("Expected 1 fields in
  line 29, saw 2"), which reads as a corrupt download rather than a wrong
  delimiter.

THE LOCAL FILE IS THE ARCHIVE
  The catalog page shows only the current month's settlements — two files when
  this was written. Older ones exist in FINRA's OTC archives, but the page we
  discover from is a rolling window, so this appends and never replaces.

THE JUNE 2021 BREAK — matters only if you backfill
  FINRA states that before June 2021 these files carry OTC securities ONLY and
  do not reflect short interest in exchange-listed securities. A naive backfill
  therefore produces one continuous-looking series whose UNIVERSE changes
  mid-way, with no error and no gap. `market_class` is carried per row so the
  scope of any window is visible rather than assumed; current files span OTC,
  NNM, NYSE, ARCA, SC, BZX and AMEX.

Usage:
    python src/python/finra_short_interest.py           # fetch what is new
    python src/python/finra_short_interest.py --all     # re-fetch every listed file
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
log = logging.getLogger("finra-shrt")

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "extracts_us" / "_meta" / "finra_short_interest.parquet"

CATALOG = "https://www.finra.org/finra-data/browse-catalog/equity-short-interest/files"
# CLASSIFIES discovered links; never builds one.
SHRT = re.compile(r"https://cdn\.finra\.org/[^\"']*/shrt(\d{8})\.csv", re.I)

UA = "Fundamental-Screener research (contact: narasimhadeshik@gmail.com)"
PAUSE = 0.5

# Source column -> ours. The source names are verbose camelCase; these are the
# names the rest of the repo uses.
COLS = {
    "settlementDate": "settlement_date",
    "symbolCode": "symbol",
    "issueName": "issue_name",
    "marketClassCode": "market_class",
    "issuerServicesGroupExchangeCode": "exchange_code",
    "currentShortPositionQuantity": "short_interest",
    "previousShortPositionQuantity": "short_interest_prev",
    "averageDailyVolumeQuantity": "avg_daily_volume",
    "daysToCoverQuantity": "days_to_cover",
    "changePercent": "change_pct",
    "changePreviousNumber": "change_shares",
    "stockSplitFlag": "split_flag",
    "revisionFlag": "revision_flag",
}


def discover(client: httpx.Client) -> dict[str, str]:
    r = client.get(CATALOG)
    r.raise_for_status()
    found = {m.group(1): m.group(0) for m in SHRT.finditer(r.text)}
    log.info("catalog lists %d settlement files", len(found))
    return found


def already_stored() -> set[str]:
    if not OUT.exists():
        return set()
    con = duckdb.connect()
    rows = con.execute(
        f"SELECT DISTINCT strftime(settlement_date, '%Y%m%d') "
        f"FROM read_parquet('{OUT.as_posix()}')"
    ).fetchall()
    con.close()
    return {r[0] for r in rows}


def main() -> None:
    p = argparse.ArgumentParser(description="load FINRA biweekly equity short interest")
    p.add_argument("--all", action="store_true", help="re-fetch every file the page lists")
    a = p.parse_args()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    have = set() if a.all else already_stored()
    if have:
        log.info("%d settlements already stored", len(have))

    t0 = time.time()
    frames: list[pd.DataFrame] = []
    with httpx.Client(headers={"User-Agent": UA}, follow_redirects=True, timeout=120) as client:
        listed = discover(client)
        todo = sorted(d for d in listed if d not in have)
        if not todo:
            log.info("nothing new on the page")
            return
        log.info("fetching %d new settlements: %s", len(todo), ", ".join(todo))

        for day in todo:
            try:
                r = client.get(listed[day])
                r.raise_for_status()
                frames.append(pd.read_csv(io.BytesIO(r.content), sep="|"))
            except Exception as e:
                log.warning("skip %s: %s", day, e)
            time.sleep(PAUSE)

    if not frames:
        log.warning("nothing fetched")
        return

    new = pd.concat(frames, ignore_index=True)
    missing = [c for c in COLS if c not in new.columns]
    if missing:
        # Loud rather than silent: a renamed source column would otherwise
        # arrive as a column of nulls that looks like missing data.
        log.warning("source is missing expected columns: %s", missing)
    new = new.rename(columns=COLS)
    keep = [v for v in COLS.values() if v in new.columns]
    new = new[keep]

    new["settlement_date"] = pd.to_datetime(new["settlement_date"], errors="coerce")
    new["symbol"] = new["symbol"].astype(str).str.strip().str.upper()
    for c in ("short_interest", "short_interest_prev", "avg_daily_volume",
              "days_to_cover", "change_pct", "change_shares"):
        if c in new.columns:
            new[c] = pd.to_numeric(new[c], errors="coerce")

    con = duckdb.connect()
    con.register("_new", new)
    if OUT.exists():
        con.execute(f"CREATE TABLE store AS SELECT * FROM read_parquet('{OUT.as_posix()}')")
        con.execute("INSERT INTO store BY NAME SELECT * FROM _new")
    else:
        con.execute("CREATE TABLE store AS SELECT * FROM _new")
    con.execute("""CREATE TABLE deduped AS
        SELECT * EXCLUDE (rn) FROM (
          SELECT *, row_number() OVER (
            PARTITION BY settlement_date, symbol ORDER BY short_interest DESC) AS rn
          FROM store) WHERE rn = 1""")
    n, days, syms = con.execute(
        "SELECT count(*), count(DISTINCT settlement_date), count(DISTINCT symbol) "
        "FROM deduped").fetchone()
    con.execute(f"COPY (SELECT * FROM deduped ORDER BY settlement_date, symbol) "
                f"TO '{OUT.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.close()

    log.info("wrote %s — %d rows, %d settlements, %d symbols in %.0fs",
             OUT, n, days, syms, time.time() - t0)


if __name__ == "__main__":
    main()

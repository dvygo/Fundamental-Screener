#!/usr/bin/env python3
"""Consolidate shareholding XBRL facts -> data/store/shareholding_facts.parquet.

Closes a real gap: the API reads this file in three places (db.js builds a
`shareholding_facts` view over it, companies.js queries it twice for the
FII/DII drill-down fallback) but NOTHING in src/python wrote it. It existed only
as an artefact of a run nobody could repeat, so losing the file meant losing the
data. This is the missing producer.

    data/extracts/<date>/CF-Shareholding-Pattern-<date>.parquet   (xbrl_populate.py)
        │  union with whatever the store already holds, then dedup
        ▼
    data/store/shareholding_facts.parquet

WHY IT UNIONS INSTEAD OF REBUILDING

  The existing store file holds 932,983 rows; the per-day parquets currently on
  disk yield 932,519. Those 464 rows came from a day whose extract is no longer
  present, and a straight rebuild would delete them while reporting success.
  So the store is treated as another input, not as output to be replaced, and
  the result is the union of everything ever seen. Running this can only ever
  add rows.

  Dedup is on the whole fact tuple. The same filing appearing in two per-day
  folders is the normal case (an index CSV lists a filing until it ages out),
  not an anomaly, so identical rows collapse rather than accumulate.

Atomic write: a temp file then os.replace, so the running API's DuckDB view
never observes a half-written parquet — same discipline as insider_load.py.

Usage:
    python src/python/shareholding_facts_load.py
    python src/python/shareholding_facts_load.py --dry-run
"""
from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

import duckdb

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("shareholding_facts")

ROOT = Path(__file__).resolve().parents[2]
EXTRACTS = ROOT / "data" / "extracts"
STORE = ROOT / "data" / "store"
OUT = STORE / "shareholding_facts.parquet"

PER_DAY_GLOB = (EXTRACTS / "*" / "CF-Shareholding-Pattern-*.parquet").as_posix()

COLS = ["filing_type", "source_symbol", "source_company", "xbrl_url", "tag",
        "value", "context_ref", "period_type", "period_start", "period_end",
        "period_instant", "unit", "decimals", "dims"]


def main() -> None:
    p = argparse.ArgumentParser(description="consolidate shareholding XBRL facts")
    p.add_argument("--dry-run", action="store_true", help="report counts, write nothing")
    a = p.parse_args()

    con = duckdb.connect()
    cols = ", ".join(COLS)

    sources = []
    n_day = con.execute(
        f"SELECT count(*) FROM read_parquet('{PER_DAY_GLOB}', union_by_name=true)"
    ).fetchone()[0] if list(EXTRACTS.glob("*/CF-Shareholding-Pattern-*.parquet")) else 0
    if n_day:
        sources.append(f"SELECT {cols} FROM read_parquet('{PER_DAY_GLOB}', union_by_name=true)")
    log.info("per-day parquets: %d rows", n_day)

    n_store = 0
    if OUT.is_file():
        n_store = con.execute(f"SELECT count(*) FROM read_parquet('{OUT.as_posix()}')").fetchone()[0]
        sources.append(f"SELECT {cols} FROM read_parquet('{OUT.as_posix()}')")
    log.info("existing store: %d rows", n_store)

    if not sources:
        raise SystemExit("nothing to consolidate — no per-day parquets and no existing store")

    union_sql = "\nUNION ALL\n".join(sources)
    total = con.execute(f"SELECT count(*) FROM ({union_sql})").fetchone()[0]
    distinct = con.execute(f"SELECT count(*) FROM (SELECT DISTINCT {cols} FROM ({union_sql}))").fetchone()[0]
    log.info("union %d rows -> %d distinct (%d duplicates collapsed)",
             total, distinct, total - distinct)

    # Loud if the rebuild would shed anything: that means a per-day extract has
    # gone missing since the store was last written, and the union is the only
    # thing standing between us and silent data loss.
    if n_store and distinct < n_store:
        log.error("refusing to write: %d distinct < %d already in the store", distinct, n_store)
        raise SystemExit(1)
    if n_store:
        log.info("net change: +%d rows", distinct - n_store)

    if a.dry_run:
        log.info("dry run — nothing written")
        return

    STORE.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".parquet.tmp")
    con.execute(
        f"COPY (SELECT DISTINCT {cols} FROM ({union_sql})) "
        f"TO '{tmp.as_posix()}' (FORMAT PARQUET)"
    )
    os.replace(tmp, OUT)
    con.close()
    log.info("done: %s (%d facts)", OUT, distinct)


if __name__ == "__main__":
    main()

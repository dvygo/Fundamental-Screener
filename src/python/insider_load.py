"""Insider-trading loader — NSE's filing INDEX CSV -> one consolidated Parquet.

The insider index (unlike the shareholding one) carries no numbers inline: qty
and value live inside each filing's XBRL. So this reuses the XBRL populator's
fetch+shred, but drives it off the *broad* index CSV (2020-07 → today, one file,
with the ticker SYMBOL right there) instead of a single day's folder, and lands
everything in a single lossless fact table:

    data/raw/CF-Insider-Trading-equities-<range>.csv   (SYMBOL, COMPANY, …, XBRL url)
        │   fetch each .xml (cached under data/raw/xbrl, paced, resumable)
        │   shred -> one row per (context, tag, value), nothing dropped
        ▼
    data/store/insider.parquet   (same lossless schema xbrl_populate.py writes)

Same lossless long-table shape as the per-day parquets, so the API's insider
pivot (MainI filing facts + per-person DisclosureN contexts) reads it unchanged
— it just points at one file spanning all days instead of a per-day glob.

Resumable two ways: fetched XML is cached (a re-run re-shreds cached filings for
free and only fetches the gaps), and the Parquet is checkpointed every
--checkpoint filings so a long run stays queryable if interrupted.

Usage:
    python src/python/insider_load.py                 # all filings (paced)
    python src/python/insider_load.py --max-fetch 200 # cap live fetches this run
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import logging
import time
from pathlib import Path

import duckdb
import httpx

from xbrl_populate import UA, DELAY, XML_CACHE, fetch, shred

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("insider_load")

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
STORE = ROOT / "data" / "store"

INDEX_GLOB = "CF-Insider-Trading-equities-*.csv"
OUT = STORE / "insider.parquet"

COLS = ["filing_type", "source_symbol", "source_company", "xbrl_url", "tag",
        "value", "context_ref", "period_type", "period_start", "period_end",
        "period_instant", "unit", "decimals", "dims"]


def collect_jobs() -> list[tuple[str, str, str]]:
    """-> [(symbol, company, xbrl_url), …] from every insider index CSV, deduped
    on url (the broad file supersets the narrower ones)."""
    files = sorted(RAW.glob(INDEX_GLOB))
    if not files:
        raise SystemExit(f"no insider index CSV under {RAW}/ ({INDEX_GLOB})")
    seen: dict[str, tuple[str, str, str]] = {}
    for f in files:
        with open(f, encoding="utf-8-sig", errors="replace", newline="") as fh:
            r = csv.reader(fh)
            hdr = [h.strip().replace("\n", " ").strip() for h in next(r)]
            si = next((i for i, h in enumerate(hdr) if h.upper().startswith("SYMBOL")), None)
            ci = next((i for i, h in enumerate(hdr) if "COMPANY" in h.upper()), None)
            xi = next((i for i, h in enumerate(hdr) if "xbrl" in h.lower()), None)
            if xi is None:
                log.warning("%s: no XBRL column, skipping", f.name)
                continue
            for row in r:
                if len(row) <= xi:
                    continue
                url = row[xi].strip()
                if not url.lower().endswith(".xml"):
                    continue
                seen[url] = (
                    row[si].strip() if si is not None and si < len(row) else "",
                    row[ci].strip() if ci is not None and ci < len(row) else "",
                    url,
                )
    log.info("collected %d distinct insider filings from %d file(s)", len(seen), len(files))
    return list(seen.values())


def write_parquet(facts: list[dict]) -> None:
    """Atomic: write a temp file then os.replace, so a reader (the running API's
    DuckDB view) never sees a half-written checkpoint."""
    import os
    STORE.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".parquet.tmp")
    con = duckdb.connect()
    con.execute("CREATE OR REPLACE TABLE facts (" + ", ".join(f"{c} VARCHAR" for c in COLS) + ")")
    if facts:
        con.executemany(
            "INSERT INTO facts VALUES (" + ",".join("?" * len(COLS)) + ")",
            [[r.get(c) for c in COLS] for r in facts],
        )
    con.execute(f"COPY facts TO '{tmp.as_posix()}' (FORMAT parquet)")
    con.close()
    os.replace(tmp, OUT)


def run(max_fetch: int, checkpoint: int) -> None:
    jobs = collect_jobs()
    facts: list[dict] = []
    fetched = cached = failed = 0
    with httpx.Client(headers={"User-Agent": UA, "Referer": "https://www.nseindia.com/"},
                      timeout=30, follow_redirects=True) as client:
        for i, (sym, comp, url) in enumerate(jobs, 1):
            hit = (XML_CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".xml")).is_file()
            if not hit and max_fetch and fetched >= max_fetch:
                continue  # fetch budget spent — leave for a later run
            try:
                xml, from_cache = fetch(client, url)
                facts.extend(shred(xml, "insider", sym, comp, url))
                if from_cache:
                    cached += 1
                else:
                    fetched += 1
                    time.sleep(DELAY)
            except Exception as e:  # degrade gracefully, skip the filing
                failed += 1
                log.warning("skip %s: %s", sym or comp, e)
            if i % 25 == 0:
                log.info("%d/%d (fetched %d, cached %d, failed %d, %d facts)",
                         i, len(jobs), fetched, cached, failed, len(facts))
            if checkpoint and fetched and fetched % checkpoint == 0:
                write_parquet(facts)
                log.info("checkpoint: wrote %d facts after %d fetches", len(facts), fetched)

    write_parquet(facts)
    by_sym = len({f["source_symbol"] for f in facts if f["source_symbol"]})
    log.info("done: %s (%d facts, %d symbols); fetched %d, cached %d, failed %d",
             OUT, len(facts), by_sym, fetched, cached, failed)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Shred insider XBRL from the broad index -> one Parquet")
    ap.add_argument("--max-fetch", type=int, default=0, help="cap LIVE fetches this run (0 = all)")
    ap.add_argument("--checkpoint", type=int, default=200, help="write Parquet every N fetches (0 = only at end)")
    args = ap.parse_args()
    run(args.max_fetch, args.checkpoint)

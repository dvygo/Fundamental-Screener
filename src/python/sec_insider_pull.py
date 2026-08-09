#!/usr/bin/env python3
"""SEC insider filings (Forms 3/4/5) -> quarter-partitioned TSVs.

The US counterpart to insider_load.py. Where NSE makes us fetch and shred one
XBRL document per filing over the network, the SEC publishes the whole thing
already structured: the "Insider Transactions Data Sets" are the XML portion of
every Form 3, 4 and 5, flattened to TSV, one zip per quarter, Jan 2006 onward.

    sec.gov  Insider Transactions Data Sets  (page listing every quarterly zip)
        │  read the .zip hrefs OFF THE PAGE, download, unpack
        ▼
    data/extracts_sec/<YYYYqN>/SUBMISSION.tsv        accession, filing date,
        │                                            ISSUERTRADINGSYMBOL, AFF10B5ONE
        │                      REPORTINGOWNER.tsv    who, officer/director/10% flags
        │                      NONDERIV_TRANS.tsv    the actual buy/sell events
        │                      DERIV_TRANS.tsv       options and other derivatives
        │                      (+ holdings, footnotes, signatures, readme)

TWO THINGS THAT BREAK A NAIVE LOADER, both found by testing:

  1. A generic User-Agent gets 403. The SEC's fair-access policy wants a
     descriptive one naming the tool and a contact. Same shape as Wikipedia's
     rule in us_market_pull.py — the UA string below is load-bearing.

  2. The download paths are NOT uniform. The newest quarter sits under
     /files/datastandardsinnovation/... while older ones are under
     /files/structureddata/... . Building URLs from a %Y q%N pattern would
     silently skip the current quarter — the freshest and most wanted data.
     So quarter URLs are DISCOVERED from the page's anchors and only
     CLASSIFIED by pattern, never constructed. This is the project's standing
     rule about fabricated URLs, and here it has teeth.

Idempotent: a quarter whose folder already holds the TSVs is skipped, so
pulling the recent few now and backfilling all ~82 later re-downloads nothing.

Usage:
    python src/python/sec_insider_pull.py --recent 8     # last 8 quarters (default)
    python src/python/sec_insider_pull.py --all          # every quarter, 2006 -> now
    python src/python/sec_insider_pull.py --list         # show what's available
"""
from __future__ import annotations

import argparse
import io
import logging
import re
import time
import zipfile
from pathlib import Path

import httpx

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("sec_insider")

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "extracts_sec"

BASE = "https://www.sec.gov"
INDEX_URL = f"{BASE}/data-research/sec-markets-data/insider-transactions-data-sets"

# Declarative UA per the SEC's fair-access policy. A library default gets 403.
UA = "Fundamental-Screener/1.0 (research tool; contact narasimhadeshik@gmail.com)"
DELAY = 0.4  # SEC asks for <= 10 req/s; we are far under that

# Classifies a discovered href and pulls the quarter out of it. Never used to
# BUILD a URL — only to recognise and label one that the page actually offered.
QTR_RE = re.compile(r"/([12][09]\d{2})q([1-4])_form345\.zip$", re.I)

# The tables we care about; the rest of the zip is extracted too (lossless).
EXPECTED = ["SUBMISSION.tsv", "REPORTINGOWNER.tsv", "NONDERIV_TRANS.tsv", "DERIV_TRANS.tsv"]


def discover() -> list[tuple[str, str]]:
    """-> [(quarter, absolute_url), …] newest first, read off the index page."""
    r = httpx.get(INDEX_URL, headers={"User-Agent": UA}, follow_redirects=True, timeout=60)
    r.raise_for_status()
    found: dict[str, str] = {}
    for href in re.findall(r'href="([^"]+\.zip)"', r.text, re.I):
        m = QTR_RE.search(href)
        if not m:
            continue
        quarter = f"{m.group(1)}q{m.group(2)}"
        found[quarter] = href if href.startswith("http") else f"{BASE}{href}"
    if not found:
        raise SystemExit(f"no quarterly zips found at {INDEX_URL} — page layout may have changed")
    out = sorted(found.items(), key=lambda kv: kv[0], reverse=True)
    log.info("%d quarters available: %s … %s", len(out), out[0][0], out[-1][0])
    return out


def already_have(quarter: str) -> bool:
    d = OUT / quarter
    return d.is_dir() and all((d / t).is_file() for t in EXPECTED)


def pull(quarter: str, url: str) -> None:
    d = OUT / quarter
    d.mkdir(parents=True, exist_ok=True)
    r = httpx.get(url, headers={"User-Agent": UA}, follow_redirects=True, timeout=300)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        z.extractall(d)
    kept = sorted(p.name for p in d.iterdir() if p.is_file())
    log.info("%s: %.1f MiB -> %d files (%s)", quarter, len(r.content) / 1048576, len(kept),
             ", ".join(n for n in kept if n.endswith(".tsv"))[:80])


def main() -> None:
    p = argparse.ArgumentParser(description="SEC Forms 3/4/5 quarterly data sets")
    p.add_argument("--recent", type=int, default=8, help="how many newest quarters (default 8)")
    p.add_argument("--all", action="store_true", help="every quarter back to 2006")
    p.add_argument("--list", action="store_true", help="list available quarters and exit")
    a = p.parse_args()

    quarters = discover()
    if a.list:
        for q, u in quarters:
            print(f"  {q}  {'HAVE' if already_have(q) else '    '}  {u}")
        return

    todo = quarters if a.all else quarters[: a.recent]
    fetched = skipped = failed = 0
    for q, url in todo:
        if already_have(q):
            skipped += 1
            continue
        try:
            pull(q, url)
            fetched += 1
        except Exception as e:  # degrade gracefully: one bad quarter isn't the run
            failed += 1
            log.warning("skip %s: %s", q, e)
        time.sleep(DELAY)
    log.info("done: fetched %d, already had %d, failed %d -> %s", fetched, skipped, failed, OUT)


if __name__ == "__main__":
    main()

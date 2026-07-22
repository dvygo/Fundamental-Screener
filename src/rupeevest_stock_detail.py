"""Loop `get_stock_detail_new` over every fincode — lossless, resumable.

For one stock this returns every scheme holding it, each row already bound
to `fund_mgr1` (manager name) + `fund_manager_code` (stable per-person id,
reused across every scheme that manager runs) + a 4-month quantity trend.
Running it across all fincodes in the stock master gives the full
stock<->scheme<->manager graph in one pass — this is what
`build_rupeevest_index.py` later derives fincode_index / fund_manager_index
from.

Cached per-fincode (`data/raw/rupeevest/stock_detail/<fincode>.json`), so a
killed/interrupted run just resumes — re-run picks up wherever it left off,
same discipline as `xbrl_populate.py`'s XML cache.

Each stock's own `/Mutual-Fund-Holdings/<fincode>` page must be visited
before the detail POST for that fincode — confirmed empirically: a shared
seed page only "primes" that one stock's server-side session state
(matching cookie `stock_query_nw`); every other fincode 204s until its own
page is hit first. So this is 2 requests per stock (page visit + POST), not
1 — pacing budgets for that.

Usage:
    python src/rupeevest_stock_detail.py                 # all fincodes
    python src/rupeevest_stock_detail.py --limit 20       # first 20 (testing)
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from build_rupeevest_index import (
    OUT_DIR as INDEX_OUT_DIR,
    _write_csv,
    build_fincode_index,
    build_fund_manager_index,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("rupeevest_stock_detail")

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw" / "rupeevest"
DETAIL_DIR = RAW_DIR / "stock_detail"

BASE_URL = "https://www.rupeevest.com"
SEED_PAGE = f"{BASE_URL}/Mutual-Fund-Holdings/100325"
DETAIL_URL = f"{BASE_URL}/mf_stock_portfolio/get_stock_detail_new"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
DELAY = 1.5
REBUILD_EVERY = 20  # rebuild both indexes every N successful fetches


def _rebuild_indexes():
    _write_csv(build_fincode_index(), INDEX_OUT_DIR / "fincode_index.csv")
    _write_csv(build_fund_manager_index(), INDEX_OUT_DIR / "fund_manager_index.csv")


def _latest_search_dump() -> Path:
    candidates = sorted(RAW_DIR.glob("search_*.json"))
    if not candidates:
        raise SystemExit("no search_*.json found — run src/rupeevest_pull.py first")
    return candidates[-1]


def _visit_stock_page(client: httpx.Client, fincode: int) -> str:
    """Primes this fincode's server-side session state; returns fresh csrf token."""
    resp = client.get(f"{BASE_URL}/Mutual-Fund-Holdings/{fincode}")
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    tag = soup.select_one('meta[name="csrf-token"]')
    if tag is None or not tag.get("content"):
        raise RuntimeError(f"no csrf-token meta tag on page for fincode {fincode}")
    return tag["content"]


def run(limit: int):
    DETAIL_DIR.mkdir(parents=True, exist_ok=True)

    search_path = _latest_search_dump()
    rows = json.loads(search_path.read_text(encoding="utf-8"))
    fincodes = [r["fincode"] for r in rows]
    log.info("loaded %d fincodes from %s", len(fincodes), search_path.name)

    todo = [fc for fc in fincodes if not (DETAIL_DIR / f"{fc}.json").exists()]
    log.info("%d already cached, %d to fetch", len(fincodes) - len(todo), len(todo))
    if limit:
        todo = todo[:limit]
        log.info("capped to %d for this run", len(todo))

    if not todo:
        log.info("nothing to do")
        return

    with httpx.Client(headers={"User-Agent": UA}, follow_redirects=True,
                       timeout=30) as client:
        fetched = failed = empty = 0
        for i, fincode in enumerate(todo, 1):
            page_url = f"{BASE_URL}/Mutual-Fund-Holdings/{fincode}"
            try:
                token = _visit_stock_page(client, fincode)
                resp = client.post(
                    DETAIL_URL,
                    data={"fincode": str(fincode)},
                    headers={
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "X-Requested-With": "XMLHttpRequest",
                        "X-CSRF-Token": token,
                        "Referer": page_url,
                    },
                )
                resp.raise_for_status()
                if not resp.text.strip():
                    empty += 1
                    log.warning("empty response for fincode %s (204/no data)", fincode)
                    continue
                data = resp.json()
                (DETAIL_DIR / f"{fincode}.json").write_text(
                    json.dumps(data, ensure_ascii=False), encoding="utf-8")
                fetched += 1
                if fetched % REBUILD_EVERY == 0:
                    log.info("rebuilding indexes (%d fetched so far)...", fetched)
                    _rebuild_indexes()
            except Exception as e:
                failed += 1
                log.warning("skip fincode %s: %s", fincode, e)
            if i % 25 == 0:
                log.info("%d/%d (fetched %d, empty %d, failed %d)",
                          i, len(todo), fetched, empty, failed)
            time.sleep(DELAY)

    log.info("done: fetched %d, failed %d", fetched, failed)
    log.info("final index rebuild...")
    _rebuild_indexes()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Pull get_stock_detail_new for every fincode (paced, resumable)")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap number of NEW fincodes fetched this run; 0 = all")
    args = ap.parse_args()
    run(args.limit)

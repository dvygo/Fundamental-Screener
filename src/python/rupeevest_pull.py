"""Pull rupeevest's stock master list (fincode <-> NSE symbol), lossless.

`get_search_data_stock` is a bare GET, no query params, dumping rupeevest's
full stock universe in one shot (confirmed via captured browser requests: no
query string, no request body, same response every time). Needs a session
cookie + Rails CSRF token, both obtained by visiting a real page first —
standard anti-forgery, not a login gate.

Response's `stock_search` field already embeds "<name> | <BSE code> | <NSE
symbol>" — the join key back to our own NSE bhavcopy data, no separate
reconciliation needed.

Usage:
    python src/rupeevest_pull.py
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("rupeevest_pull")

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "raw" / "rupeevest"

BASE_URL = "https://www.rupeevest.com"
SEED_PAGE = f"{BASE_URL}/Mutual-Fund-Holdings/100325"  # any real page works
SEARCH_URL = f"{BASE_URL}/mf_stock_portfolio/get_search_data_stock"
BUY_URL = f"{BASE_URL}/stock_price_difference/get_compare_data_stock"
SELL_URL = f"{BASE_URL}/stock_price_difference/get_compare_data_stock_1"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


def _get_csrf_token(client: httpx.Client) -> str:
    resp = client.get(SEED_PAGE)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    tag = soup.select_one('meta[name="csrf-token"]')
    if tag is None or not tag.get("content"):
        raise RuntimeError("no csrf-token meta tag found on seed page")
    return tag["content"]


def _fetch_json(client: httpx.Client, token: str, url: str) -> dict:
    resp = client.get(
        url,
        headers={
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": token,
            "Referer": SEED_PAGE,
        },
    )
    resp.raise_for_status()
    return resp.json()


def pull_all() -> dict[str, list[dict]]:
    with httpx.Client(headers={"User-Agent": UA}, follow_redirects=True,
                       timeout=30) as client:
        token = _get_csrf_token(client)
        log.info("session established, csrf token acquired")

        out = {}
        for name, url in [("search", SEARCH_URL), ("buy", BUY_URL), ("sell", SELL_URL)]:
            data = _fetch_json(client, token, url)
            key = next(iter(data), None)
            rows = data.get(key, []) if key else []
            log.info("%s: response key=%r, %d rows", name, key, len(rows))
            out[name] = rows
    return out


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    all_data = pull_all()
    stamp = f"{date.today():%Y%m%d}"

    for name, rows in all_data.items():
        out_path = OUT_DIR / f"{name}_{stamp}.json"
        out_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False),
                             encoding="utf-8")
        log.info("wrote %s (%d rows)", out_path, len(rows))

    search_rows = all_data["search"]
    with_symbol = sum(1 for r in search_rows
                       if len(r.get("stock_search", "").split("|")) == 3
                       and r["stock_search"].split("|")[2].strip())
    print(f"\nsearch (stock master): {len(search_rows)} rows, "
          f"{with_symbol} with parseable NSE symbol")
    print(f"buy (net MF buying):   {len(all_data['buy'])} rows")
    print(f"sell (net MF selling): {len(all_data['sell'])} rows")
    print(f"\nsample buy row:  {all_data['buy'][0] if all_data['buy'] else None}")
    print(f"sample sell row: {all_data['sell'][0] if all_data['sell'] else None}")


if __name__ == "__main__":
    main()

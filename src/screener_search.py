"""B3 — fund manager involvement, via screener.in's authenticated full-text search.

Scope note (see context/sources.md): `/full-text-search/?q=` requires login AND
is disallowed by robots.txt's `?q=` rule regardless of authentication. This is
a deliberate, narrow exception the project owner accepted for this one
endpoint — not a general authenticated posture for screener.in. Everything
else in this project keeps to the public-page stance.

What it returns is a weak signal: every company page whose text contains the
manager's name (bio mentions, shareholding notes, commentary — no relevance
filter, no verification the mention is actually about fund holdings). That's
the ceiling of what full-text search gives; real holdings are B7/8, a
different and much bigger effort (see sources.md).

Credentials: SCREENER_USERNAME / SCREENER_PASSWORD in a gitignored root
`.env` — never passed on the command line or committed.

Usage:
    python src/screener_search.py "Radhika Gupta"
    python src/screener_search.py "Radhika Gupta" "Vaibhav Sanghavi" --out data/fund_managers
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import time
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("screener_search")

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "https://www.screener.in"
REQUEST_DELAY = 4.0  # same pacing discipline as screener_company.py
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


class ScreenerError(RuntimeError):
    """Base exception for this module."""


class AuthenticationError(ScreenerError):
    """Raised when login fails."""


def _load_dotenv(path: Path):
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


class ScreenerSession:
    """Authenticated session limited to what B3 needs: login + full-text search."""

    def __init__(self, username: str, password: str):
        self.client = httpx.Client(
            headers={"User-Agent": UA}, follow_redirects=True, timeout=20,
        )
        self._login(username, password)

    def close(self):
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    def _login(self, username: str, password: str):
        login_url = f"{BASE_URL}/login/"
        page = self.client.get(login_url)
        soup = BeautifulSoup(page.text, "html.parser")
        token_tag = soup.select_one('input[name="csrfmiddlewaretoken"]')
        if token_tag is None or not token_tag.get("value"):
            raise AuthenticationError("login page had no CSRF token")

        resp = self.client.post(
            login_url,
            data={
                "username": username,
                "password": password,
                "csrfmiddlewaretoken": token_tag["value"],
            },
            headers={"Referer": login_url},
        )
        if str(resp.url).rstrip("/").endswith("/login"):
            raise AuthenticationError("login failed — check credentials")
        log.info("logged in as %s", username)

    def full_text_search(self, query: str) -> list[dict]:
        """-> [{company, symbol, url}, ...]. Raw search hits, no relevance filter."""
        resp = self.client.get(f"{BASE_URL}/full-text-search/", params={"q": query})
        soup = BeautifulSoup(resp.text, "html.parser")

        results = []
        seen = set()
        for block in soup.select("div.margin-top-20.margin-bottom-36"):
            company_tag = block.select_one("span.hover-link")
            link_tag = block.select_one('a[href^="/company/"]')
            if not (company_tag and link_tag):
                continue
            href = link_tag["href"]
            symbol = href.strip("/").split("/")[1] if "/" in href.strip("/") else ""
            key = (company_tag.get_text(strip=True), symbol)
            if key in seen:
                continue
            seen.add(key)
            results.append({
                "company": company_tag.get_text(strip=True),
                "symbol": symbol,
                "url": BASE_URL + href,
            })
        return results


def run(names: list[str], out_dir: Path | None):
    _load_dotenv(ROOT / ".env")
    username = os.environ.get("SCREENER_USERNAME")
    password = os.environ.get("SCREENER_PASSWORD")
    if not username or not password:
        raise SystemExit(
            "SCREENER_USERNAME / SCREENER_PASSWORD not set — put them in a "
            "gitignored .env at the repo root"
        )

    with ScreenerSession(username, password) as sess:
        for i, name in enumerate(names):
            log.info("searching: %s", name)
            hits = sess.full_text_search(name)
            print(f"\n=== {name} ({len(hits)} hits) ===")
            for h in hits:
                print(f"  {h['symbol']:<15} {h['company']}")
            if out_dir:
                out_dir.mkdir(parents=True, exist_ok=True)
                path = out_dir / f"{name.replace(' ', '_')}.csv"
                with open(path, "w", encoding="utf-8", newline="") as fh:
                    w = csv.DictWriter(fh, fieldnames=["company", "symbol", "url"])
                    w.writeheader()
                    w.writerows(hits)
                log.info("wrote %s", path)
            if i < len(names) - 1:
                time.sleep(REQUEST_DELAY)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="B3 — fund manager involvement via screener.in full-text search")
    ap.add_argument("names", nargs="+", help="fund manager name(s) to search")
    ap.add_argument("--out", type=Path, default=None,
                    help="write results as CSV into this directory")
    args = ap.parse_args()
    run(args.names, args.out)

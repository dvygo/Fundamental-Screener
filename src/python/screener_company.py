"""Fundamental-Screener — scrape company dossiers from screener.in.

A screener.in company page (/company/{code}/) is fully server-rendered: one GET
returns the key ratios, 10-year P&L / balance-sheet / cash-flow / ratios tables,
quarterly results, shareholding, pros/cons and an About blurb. No login, no JS.

Politeness (screener.in's ToS restricts automated access; this project uses it
as primary by explicit choice, so it behaves):
  - a real identifying User-Agent
  - a hard delay between live requests
  - raw HTML cached to data/raw/screener/{code}.html — re-runs parse from cache
    and never re-hit the site
robots.txt is respected: only /company/{code}/ is fetched (allowed); user pages
and search query-params are not.

Output: data/companies/{code}.json  (one dossier per company)

Usage:
    python src/screener_company.py RELIANCE TCS INFY
    python src/screener_company.py --file data/universe.txt      # codes, one per line
    python src/screener_company.py RELIANCE --refresh            # ignore cache
"""

import asyncio
import json
import logging
import re
import sys
import time
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("screener")
logging.getLogger("httpx").setLevel(logging.WARNING)

BASE = "https://www.screener.in"
RAW_DIR = Path("data/raw/screener")
OUT_DIR = Path("data/companies")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
REQUEST_DELAY = 4.0  # seconds between live fetches — deliberately gentle
RETRIES = 3

# ₹ and stray whitespace the page sprinkles into numbers.
_CLEAN = str.maketrans({"₹": "", "\xa0": " ", ",": ""})


def clean_num(text: str) -> str:
    """A ratio value as-shown, minus the rupee sign and thousands commas."""
    return re.sub(r"\s+", " ", text.translate(_CLEAN)).strip()


def parse_top_ratios(soup: BeautifulSoup) -> dict:
    """The headline ratios block: Market Cap, P/E, ROCE, ROE, …"""
    out: dict[str, str] = {}
    for li in soup.select("#top-ratios li"):
        name = li.select_one(".name")
        value = li.select_one(".value")
        if name and value:
            out[re.sub(r"\s+", " ", name.get_text(" ", strip=True))] = clean_num(
                value.get_text(" ", strip=True)
            )
    return out


def parse_table(soup: BeautifulSoup, section_id: str) -> list[dict]:
    """A financial table (#profit-loss, #balance-sheet, …) as row dicts keyed by
    the period columns."""
    table = soup.select_one(f"#{section_id} table")
    if not table:
        return []
    periods = [th.get_text(strip=True) for th in table.select("thead th")]
    rows: list[dict] = []
    for tr in table.select("tbody tr"):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        label = re.sub(r"\s+", " ", cells[0].get_text(" ", strip=True)).strip("+ ")
        if not label:
            continue
        values = {
            periods[i]: clean_num(c.get_text(" ", strip=True))
            for i, c in enumerate(cells[1:], start=1)
            if i < len(periods)
        }
        rows.append({"item": label, "values": values})
    return rows


def parse_list(soup: BeautifulSoup, selector: str) -> list[str]:
    return [
        re.sub(r"\s+", " ", li.get_text(" ", strip=True))
        for li in soup.select(selector)
        if li.get_text(strip=True)
    ]


def parse_company(code: str, html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    name_el = soup.select_one("h1")
    about_el = soup.select_one("section#analysis .about, .company-profile p, section#analysis p")
    links = [
        a["href"]
        for a in soup.select("section#analysis a[href], .company-links a[href]")
        if a.get("href", "").startswith("http")
    ]
    return {
        "code": code,
        "name": name_el.get_text(strip=True) if name_el else code,
        "url": f"{BASE}/company/{code}/",
        "about": re.sub(r"\s+", " ", about_el.get_text(" ", strip=True)) if about_el else "",
        "website_links": sorted(set(links))[:6],
        "ratios": parse_top_ratios(soup),
        "pros": parse_list(soup, ".pros li"),
        "cons": parse_list(soup, ".cons li"),
        "profit_loss": parse_table(soup, "profit-loss"),
        "balance_sheet": parse_table(soup, "balance-sheet"),
        "cash_flow": parse_table(soup, "cash-flow"),
        "ratios_history": parse_table(soup, "ratios"),
        "quarterly": parse_table(soup, "quarters"),
        "shareholding": parse_table(soup, "shareholding"),
    }


async def fetch_html(client: httpx.AsyncClient, code: str, refresh: bool) -> str | None:
    """Return the company page HTML, from cache unless --refresh. Live fetches
    are delayed and retried; the raw HTML is cached so re-parses never re-hit."""
    cache = RAW_DIR / f"{code}.html"
    if cache.exists() and not refresh:
        return cache.read_text(encoding="utf-8")

    url = f"{BASE}/company/{code}/"
    for attempt in range(RETRIES):
        try:
            resp = await client.get(url)
            if resp.status_code == 200 and "top-ratios" in resp.text:
                RAW_DIR.mkdir(parents=True, exist_ok=True)
                cache.write_text(resp.text, encoding="utf-8")
                return resp.text
            if resp.status_code in (429, 403):
                log.warning("%s: %s — screener is throttling, backing off", code, resp.status_code)
                await asyncio.sleep(REQUEST_DELAY * (attempt + 2))
                continue
            log.warning("%s: HTTP %s", code, resp.status_code)
            return None
        except httpx.HTTPError:
            await asyncio.sleep(REQUEST_DELAY * (attempt + 1))
    return None


async def main() -> int:
    argv = sys.argv[1:]
    refresh = "--refresh" in argv
    codes: list[str] = []
    if "--file" in argv:
        path = Path(argv[argv.index("--file") + 1])
        codes = [
            l.strip().upper()
            for l in path.read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.startswith("#")
        ]
    codes += [a.upper() for a in argv if not a.startswith("--") and a not in codes]
    # drop the --file argument value from positional codes
    if "--file" in argv:
        codes = [c for c in codes if c != Path(argv[argv.index("--file") + 1]).name.upper()]
    codes = list(dict.fromkeys(codes))
    if not codes:
        log.error("No company codes. Usage: python src/screener_company.py RELIANCE TCS")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    log.info("Scraping %d companies from screener.in (delay %.1fs)", len(codes), REQUEST_DELAY)
    ok = 0
    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT, "Accept-Language": "en-IN,en;q=0.9"},
        timeout=30.0,
        follow_redirects=True,
    ) as client:
        for i, code in enumerate(codes):
            was_cached = (RAW_DIR / f"{code}.html").exists() and not refresh
            html = await fetch_html(client, code, refresh)
            if not html:
                log.warning("%-14s skipped (no page)", code)
            else:
                dossier = parse_company(code, html)
                (OUT_DIR / f"{code}.json").write_text(
                    json.dumps(dossier, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                r = dossier["ratios"]
                log.info(
                    "%-14s %-34s P/E %-7s MCap %s",
                    code,
                    dossier["name"][:34],
                    r.get("Stock P/E", "-"),
                    r.get("Market Cap", "-"),
                )
                ok += 1
            # pace only real fetches, and not after the last one
            if not was_cached and html and i + 1 < len(codes):
                time.sleep(REQUEST_DELAY)

    log.info("Wrote %d/%d dossiers to %s", ok, len(codes), OUT_DIR)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

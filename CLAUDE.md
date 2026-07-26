# Fundamental-Screener

Builds per-company **dossiers** for Indian listed companies — fundamentals, key
ratios, 10-year financials, and news — aggregated from several sources. Primary
source is **screener.in** (by explicit choice; see `context/sources.md` for the
ToS/politeness stance). Sibling project to [Fund-Manager-Web-Scraper], reusing
the same toolkit and discipline.

Read `context/sources.md` before touching scrapers.

## Stack

- Python 3.11+, `httpx` + BeautifulSoup/lxml; Crawl4AI (Playwright) for JS-heavy
  or bot-protected pages
- `feedparser` for news RSS

## Layout

- `src/` — one script per source/stage (`screener_company.py` first)
- `setup/` — `requirements.txt`
- `context/` — source assessment and design notes
- `data/companies/` — parsed dossiers (committed)
- `data/bod/` — **raw manual drops** (NSE/BSE bhavcopies, daily reports) — the pre-processing inbox (committed)
- `data/backup/YYYYMMDD/` — mirror of every processed file also written to MinIO (committed; DR)
- `data/raw/` — cached scrape HTML + downloaded index CSVs / XBRL cache (gitignored; re-fetchable)
- `data/store/` — **consolidated single-file filing store** (gitignored; derived). Quarterly/event
  filing data is NOT day-partitioned: `shareholding.parquet` (promoter/public % per symbol per
  quarter, whole history, from the NSE shareholding index via `src/python/shareholding_load.py`) and
  `insider.parquet` (lossless insider XBRL shred via `src/python/insider_load.py`). Daily *market*
  data (bhavcopy, 52w, circuit, corp actions) stays day-partitioned under `data/extracts/`.

Storage tiering (disk → MinIO, services read MinIO only): see `context/storage.md`.

## Commands

```bash
pip install -r setup/requirements.txt
playwright install chromium                 # only if a scraper needs the browser
python src/screener_company.py RELIANCE TCS INFY
python src/screener_company.py --file data/universe.txt
```

## Conventions

- **Never fabricate a URL** — fetch only real listing codes / discovered links,
  followed to their final destination.
- **Cache and pace** — raw HTML is cached to `data/raw/`; live requests are
  delayed. Re-runs parse from cache, not the network. Respect `robots.txt`.
- **Degrade gracefully** — a blocked/changed page skips that company and logs
  it; never abort the run or emit half-empty records as complete.
- Parsed JSON/CSV outputs go to `data/`, committed; raw HTML stays local.

# Fundamental-Screener

Builds per-company **dossiers** for Indian listed companies — fundamentals, key
ratios, 10-year financials, and news — aggregated from several sources. Primary
source is **screener.in** (by explicit choice; see `context/sources.md` for the
ToS/politeness stance). Sibling project to [Fund-Manager-Web-Scraper], reusing
the same toolkit and discipline.

Read `context/sources.md` before touching scrapers.

## Taking over? Do this first

New-agent onboarding — **follow in order, don't skip**:

1. **Read the onboarding spine.** `context/00-start-here.md` → `07`, in order — the
   guided tour of the whole system (architecture, data, storage, the HUNT
   scoreboard, the frontend submodule, current state, and the mission).
2. **Build memory next.** *Before changing any code*, write the durable facts you
   learned into your persistent project memory: the architecture and ports, the
   **HUNT scoring model + its five honesty rules**, the data-coverage caveat, the
   secret/commit constraints, and the open threads. Memory before code.
3. **Then refactor** — per `context/07-your-mission.md`, with its guardrails (secret
   guard first, `tsc`/`eslint` clean, verify against real data, commit only when asked).

## Stack

- Python 3.11+, `httpx` + BeautifulSoup/lxml; Crawl4AI (Playwright) for JS-heavy
  or bot-protected pages
- `feedparser` for news RSS

## Layout

- `src/` — `python/` (ELT scrapers/loaders), `nodejs/` (REST API on :3000, DuckDB), `nextjs/` (UI submodule → hunt-internal, :3001)
- `setup/` — `requirements.txt`
- `context/` — onboarding spine (`00`–`07`), design notes, `reference/`, `archive/`
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
python src/python/screener_company.py RELIANCE TCS INFY
node src/nodejs/src/server.js                # REST API on :3000
# frontend (submodule): cd src/nextjs && npm install && npm run dev   # :3001
```

## Conventions

- **Never fabricate a URL** — fetch only real listing codes / discovered links,
  followed to their final destination.
- **Cache and pace** — raw HTML is cached to `data/raw/`; live requests are
  delayed. Re-runs parse from cache, not the network. Respect `robots.txt`.
- **Degrade gracefully** — a blocked/changed page skips that company and logs
  it; never abort the run or emit half-empty records as complete.
- Parsed JSON/CSV outputs go to `data/`, committed; raw HTML stays local.

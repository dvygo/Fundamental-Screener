# Fundamental-Screener

Per-company **dossiers** and market-wide **idea-generation screens** for Indian
listed companies — fundamentals, key ratios, 10-year financials, insider trades,
shareholding, corporate actions and news — aggregated from NSE/BSE daily bundles,
SEBI/NSE XBRL filings and screener.in.

Sibling to [Fund-Manager-Web-Scraper](https://github.com/dvygo/Fund-Manager-Web-Scraper).
The Next.js UI lives in its own repo, [hunt-internal](https://github.com/dvygo/hunt-internal),
and is wired in here as the `src/nextjs` submodule.

## What it does

Signals over noise: the app surfaces where to *look* — new 52-week highs/lows,
gainers/losers, insider buying, corporate actions and stock-tagged news — and
ranks how those signals **converge** on each stock in the **HUNT** scoreboard.
None of it is advice; it's a map of where attention is concentrating, per the
*Idea Hunting Framework* in [context/requirements/](context/requirements/). See
[context/PLAN.md](context/PLAN.md) for the layered design.

## Architecture

Three tiers, one direction of flow:

```
NSE/BSE daily bundles · XBRL filings · screener.in · LiveMint RSS
        │  ingest / scrape (paced, cached, robots-respecting)
        ▼
src/python/          ELT — httpx + BeautifulSoup/lxml, Crawl4AI (Playwright),
                     feedparser; shred XBRL → Parquet, land raw → MinIO (WORM)
        ▼
data/extracts, data/store    disk = schema-on-read source of truth
   +  MinIO  raw/ (object-locked) + delta/   — docker/docker-compose.yml
        ▼
src/nodejs/          REST API on :3000 — Express 5 + DuckDB (schema-on-read over
                     the CSV/Parquet globs); live screener.in / RSS scraping
        ▼
src/nextjs/          Next.js UI on :3001  (submodule → hunt-internal)
```

- **Python** owns static-file extraction and the ELT loaders.
- **Node** serves JSON and does the on-demand screener.in / RSS scraping.
- **DuckDB** runs every screen as schema-on-read SQL — no warehouse to operate.

## Layout

| Path | What |
|---|---|
| `src/python/` | ELT: ingest, XBRL shred, loaders, screener scrapers, screens CLI |
| `src/nodejs/` | REST API (`src/server.js`) + DuckDB views (`src/db.js`) |
| `src/nextjs/` | **submodule** → the Next.js frontend (hunt-internal) |
| `data/extracts/` | daily NSE/BSE bundles + XBRL cache (gitignored; re-fetchable) |
| `data/store/` | consolidated single-file filing stores (Parquet; derived) |
| `data/companies/` | parsed dossiers (committed) |
| `context/` | design notes, source assessment, [plan](context/PLAN.md), [deploy](context/DEPLOY.md), requirements |
| `docker/` | MinIO (WORM `raw/` bucket + `delta/`) compose |
| `setup/` | `requirements.txt` |

## Quickstart

```bash
# 1. clone WITH the frontend submodule
git clone --recurse-submodules git@github.com:dvygo/Fundamental-Screener.git
#    already cloned?  git submodule update --init src/nextjs

# 2. Python ELT
python -m venv .venv && source .venv/bin/activate
pip install -r setup/requirements.txt
playwright install chromium            # only if a scraper needs the browser

# 3. storage (optional — MinIO WORM audit layer)
docker compose -f docker/docker-compose.yml up -d

# 4. API  (:3000)
cd src/nodejs && npm install && node src/server.js

# 5. UI   (:3001, needs the API up)
cd src/nextjs && npm install && npm run dev
```

Full run/deploy story in [context/DEPLOY.md](context/DEPLOY.md); read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Sources & etiquette

screener.in is used by explicit choice; scrapers **cache and pace**, respect
`robots.txt`, and **never fabricate URLs**. Read
[context/sources.md](context/sources.md) before touching any scraper.

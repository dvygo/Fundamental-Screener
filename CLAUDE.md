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
- `data/store/` — **consolidated single-file store** (gitignored; derived). Quarterly/event
  filing data is NOT day-partitioned: `shareholding.parquet` (promoter/public % per symbol per
  quarter, whole history, from the NSE shareholding index via `src/python/shareholding_load.py`),
  `insider.parquet` (lossless insider XBRL shred via `src/python/insider_load.py`) and
  `news.parquet` (LiveMint history via `src/python/livemint_snapshot.py`). Daily *market*
  data (bhavcopy, 52w, circuit, corp actions) stays day-partitioned under `data/extracts/`.
  `shareholding_facts.parquet` is also read by the API but no loader in `src/python/` writes it.

## US market (Markets US / Insider Centric US)

A second board covering US equities, alongside the Indian one. The sidebar's
market dropdown decides which tabs are on offer; the server dropdown separately
decides which API answers them.

| | source | loader | lands in |
|---|---|---|---|
| Prices | Yahoo (yfinance), S&P 500 only | `us_market_pull.py bars` | `data/extracts_us/<YYYYMMDD>/` |
| Fundamentals | Yahoo `.info`, lossless long table | `us_market_pull.py info` | `data/extracts_us/_meta/` |
| Insider filings | SEC Forms 3/4/5 quarterly data sets | `sec_insider_pull.py` | `data/extracts_sec/<YYYYqN>/` |

Both are gitignored and fully re-fetchable — unlike the NSE drop, a missed day
is never lost, since Yahoo and the SEC both serve history.

**Markets US has four screens, not five.** Upper & Lower Circuit has no US
equivalent: per-stock daily price bands are structural to Indian exchanges,
while US halts are intraday LULD and are not published as a daily file. And
every US figure is *derived* — NSE publishes prev-close, gain/loss direction
and an official 52-week list, Yahoo publishes none of them.

**TODO — move Markets US prices to Databento.** A market-wide extract is
already downloaded (XNAS.ITCH, `ohlcv-1d`, ALL_SYMBOLS, 2018-05-01 → 2026-08-07,
2,079 daily files). It is market-wide rather than S&P-500-only, authoritative
rather than an unofficial endpoint, and already one file per session, so it
drops into the existing day-folder layout. Parked for now; the reasoning and
the two traps (`pretty_px: false` means fixed-point prices needing 1e-9 scaling;
`.zst` needs zstandard or DuckDB) are at the top of `us_market_pull.py`.

## Two cadences — don't couple them

The pipeline has two independent clocks. Confusing them is the easiest way to
either corrupt a screen or waste an hour re-running something that didn't need it.

| | **Daily** (market) | **On refresh** (filings + news) |
|---|---|---|
| Trigger | a new BOD drop lands in `data/raw/zip/` | the source index CSV is re-downloaded; news runs once a day |
| Scripts | `extract.py` → `ingest.py` | `insider_load.py`, `shareholding_load.py`, `livemint_snapshot.py` |
| Input | one zip per date, date in the filename | one broad CSV in `data/raw/` spanning years (2020→today) |
| Output | `data/extracts/<YYYYMMDD>/` | one consolidated file in `data/store/` |
| Miss a run? | that session is gone — the drop is not re-requestable | harmless for filings (re-read the same CSV); **fatal for news** (LiveMint's window is ~a week) |

The filing loaders are **decoupled from the daily cycle** — they read a single
index CSV covering the whole history, not a day's folder, so running `extract.py`
does not oblige you to run them, and re-running them does not need fresh dailies.

`xbrl_populate.py` is the exception: it is the older *per-day* path
(`data/extracts/<date>/CF-*.csv` → a `.parquet` beside it) and is still imported
by `insider_load.py` for its `fetch`/`shred` helpers. Reach for it only when you
want a specific day's facts; the store loaders are the current route.

Storage tiering (disk → MinIO, services read MinIO only): see `context/storage.md`.

## Commands

```bash
pip install -r setup/requirements.txt
playwright install chromium                 # only if a scraper needs the browser
python src/python/screener_company.py RELIANCE TCS INFY
python src/python/extract.py                 # daily: raw zips -> data/extracts/<date>/
python src/python/livemint_snapshot.py       # daily: LiveMint sitemaps -> data/store/news.parquet
python src/python/insider_load.py            # on refresh of the index CSV
python src/python/shareholding_load.py       # on refresh of the index CSV
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

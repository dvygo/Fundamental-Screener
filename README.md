# Fundamental-Screener

A screening and dossier engine for Indian listed companies. It combines three
inputs — daily **exchange bhavcopies**, **screener.in** fundamentals, and
**corporate-announcement news** — into per-company dossiers and cross-market
screens (52-week triggers, gainers/losers, insider and promoter activity).

Primary fundamentals source is **screener.in** (by explicit choice; see
[`context/sources.md`](context/sources.md) for the politeness/ToS stance).
Storage is auditable by design — see [`context/storage.md`](context/storage.md).

> Read `context/` before touching scrapers or storage.

---

## What it produces (client requirements)

Requirements live in [`context/requirement.md`](context/requirement.md). They map
to three layers:

### Layer A — Bhavcopy screens (from daily NSE/BSE files)

| # | Screen | Notes |
|---|--------|-------|
| A1 | **52-week high trigger** — last trading day | stocks that hit a new 52w high that day |
| A2 | **52-week high — N-day event count** | how many times each stock triggered a 52w high over the last N days |
| A3 | **52-week low** — same as A1/A2 | last-day trigger + N-day event count |
| A4 | **Top gainers / losers** | two separate tables |
| A5 | **Gainers — N-day recurrence** | how often a stock appeared in top gainers over N days |

Source files already land in `data/raw/bod/` (e.g. `CM_52_wk_High_low_*.csv`,
`sec_bhavdata_full_*.csv`, `MA*.csv`). N is a run parameter.

### Layer B — screener.in signals (per company)

| # | Signal |
|---|--------|
| B1 | **Insider buying** — quantity of shares + value |
| B2 | **Promoter holding** + change in promoter holding |
| B3 | **Top portfolio-manager / asset-manager holdings** |
| B4 | **Symbol drill-down** — market cap, current price, stock P/E, EPS, change in promoter holding, change in FII, change in DII, promoter holding over last 3 years, current promoter holding |

Clicking any symbol in an A- or B-list opens its B4 drill-down.

### Layer C — Announcement engine (news)

Sources: **BSE corporate announcements**, **NSE corporate filings**, company
investor-relations pages. Each announcement is classified into an event type:

`Order book update` · `Capex` · `Results` · `Fund raise` · `Board meeting` ·
`Credit rating` · `Acquisition` · `Expansion` · `Regulatory approval`

---

## Status

| Component | State |
|-----------|-------|
| `src/screener_company.py` — dossier scraper (ratios, 10y financials, quarters, pros/cons) | **built, verified** (RELIANCE, TCS, INFY) |
| Docker MinIO storage (WORM `raw/` + versioned `delta/`) | **built, verified** |
| Storage architecture (dual-write, tiering) | **documented** |
| Layer A — bhavcopy screens (A1–A5) | planned |
| Layer B — insider/promoter/holdings + drill-down (B1–B4) | planned (scraper covers base ratios; holdings breakdown pending) |
| Layer C — announcement engine (BSE/NSE, classification) | planned |
| `src/ingest.py` — bod → MinIO + backup dual-write | planned |

---

## Stack

- **Python 3.11+**, `httpx` + BeautifulSoup/lxml; Crawl4AI (Playwright) for
  JS-heavy or bot-protected pages
- `feedparser` for news RSS
- **MinIO** (S3 object store) — serving layer, WORM object-lock on `raw/`
- **Delta Lake** — time-series financials with time-travel audit
- **DuckDB** — in-process query over the lake (no Trino/Spark at this scale)

---

## Layout

```
src/                        one script per source/stage
  extract.py                UNO — decompress raw drop -> data/extracts (root)
  ingest.py                 push data/extracts -> MinIO raw/ (WORM) + backup
  xbrl_populate.py          shred filing XBRL -> Bronze parquet -> MinIO
  screens.py                Layer A screens (req 1-5) via DuckDB over MinIO
  screener_company.py       screener.in dossier scraper
setup/requirements.txt
context/                    source, storage, requirement docs
data/
  companies/                parsed dossiers  {CODE}.json   (committed)
  raw/bod/YYYYMMDD/         raw manual exchange drops — pristine (gitignored)
  extracts/YYYYMMDD/        decompressed working ROOT (gitignored, rebuildable)
  raw/screener/             cached scrape HTML (gitignored, re-fetchable)
  backup/YYYYMMDD/          DR mirror of what went to MinIO (payload gitignored;
                            only _ingest_manifest.json committed)
docker/                     MinIO compose + WORM/versioning provisioning
```

## Pipeline

```
data/raw/bod/<date>/     raw manual drops (some .zip/.gz)
      │  UNO  extract.py            decompress + copy all, flat
      ▼
data/extracts/<date>/    working root — everything downstream reads here
      │  ingest.py                  push -> MinIO raw/ (WORM) + backup
      ▼
MinIO raw/               ── xbrl_populate.py ──► MinIO bronze/ (facts parquet)
      │  screens.py (DuckDB httpfs, schema-on-read)
      ▼
Layer A screens (req 1-5)
```

Storage tiering (disk → MinIO; services read MinIO only):
see [`context/storage.md`](context/storage.md).

---

## Quickstart

```bash
pip install -r setup/requirements.txt
playwright install chromium              # only if a scraper needs the browser

# storage layer
cd docker && cp .env.example .env        # set real MinIO creds
docker compose up -d                     # MinIO :9000 (API) / :9001 (console)

# daily pipeline for one date folder (operator dropped files per BOD.md)
python src/extract.py       20260717     # UNO: decompress -> data/extracts
python src/ingest.py        20260717     # -> MinIO raw/ (WORM) + backup
python src/xbrl_populate.py 20260717     # filings XBRL -> Bronze (paced; resumable)
python src/screens.py all --n 30 --top 20   # Layer A screens (req 1-5)

# fundamentals dossier (screener.in, separate)
python src/screener_company.py RELIANCE TCS INFY
```

---

## Conventions

- **Never fabricate a URL** — fetch only real listing codes / discovered links,
  followed to their final destination.
- **Cache and pace** — raw HTML is cached to `data/raw/`; live requests are
  delayed; re-runs parse from cache. Respect `robots.txt`.
- **Degrade gracefully** — a blocked/changed page skips that company and logs
  it; never abort a run or emit half-empty records as complete.
- **Dual-write** — every processed file goes to both MinIO and
  `data/backup/YYYYMMDD/`; services read MinIO only.
- Parsed JSON/CSV outputs are committed; raw HTML stays local.

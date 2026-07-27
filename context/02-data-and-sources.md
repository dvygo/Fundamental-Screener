# 02 · Data & sources

## Where the data comes from

- **Daily market bundle** (NSE/BSE) — an operator downloads it per
  [reference/bod-runbook.md](reference/bod-runbook.md) into `data/raw/bod/`, then
  `extract.py` decompresses/flattens it to `data/extracts/<YYYYMMDD>/`. **Never
  skip a day** — each session's prices/52w/gainers exist only in that day's file.
  Pull with a **1-day lag** (a same-day pull is silently partial).
- **Filings** (insider, shareholding) — **decoupled from the daily cycle.** Each
  loader reads one broad NSE index CSV out of `data/raw/` covering the whole
  history (2020 → today), fetches the XBRL each row links to, and lands a single
  consolidated file in `data/store/`: `insider_load.py` → `insider.parquet`,
  `shareholding_load.py` → `shareholding.parquet`. They are driven by the index
  CSV being re-downloaded, not by a BOD drop — a new daily neither requires nor
  benefits from re-running them, and they need no fresh dailies to run.
  `xbrl_populate.py` is the older per-day path (`data/extracts/<date>/CF-*.csv`
  → `.parquet` beside it), kept for single-day work and for the `fetch`/`shred`
  helpers `insider_load.py` imports.
- **Live scrapes (Node)** — screener.in (login-gated full-text-search + on-demand
  dossiers) and the LiveMint companies RSS, revalidated on a short TTL so the
  tab tracks a feed that gains stories all day. Both paced and cached.
- **News history (Python)** — LiveMint publishes no archive; its Google-News
  sitemaps hold about a week. `livemint_snapshot.py` captures both once a day
  into `data/raw/livemint/sitemap/<YYYYMMDD>/` and accrues them into
  `data/store/news.parquet`. `yesterday.xml` is the completed day and the
  authoritative record; `today.xml` is the day so far, kept only as
  partial-recovery insurance. **Miss a day and it is unrecoverable** — there is
  no backfill to request, unlike a bhavcopy.
- **rupeevest** — real per-scheme fund-manager holdings (see
  [06](06-state-and-open-threads.md) and `archive/TODO2.md`).

## Read the data dictionary before touching a screen

Every file in a day's drop — columns, purpose, which requirement it feeds — is in
[reference/findings.md](reference/findings.md). In particular, **three different
"high/low" concepts** that are easy to confuse:

| File | Concept |
|---|---|
| `CM_52_wk_High_low` | true **52-week** high/low (corporate-action adjusted) |
| `hl<d>` | new **day** high/low |
| `bh<d>` | price-**band (circuit)** hit — H = upper, L = lower |

## Etiquette (read before any scraper)

[sources.md](sources.md) is the ToS/politeness stance. The four rules:

1. Never fabricate a URL. 2. Cache and pace; respect `robots.txt`.
3. Degrade gracefully. 4. Parsed outputs are committed; raw HTML stays local.

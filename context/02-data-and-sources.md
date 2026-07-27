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
| `CM_52_wk_High_low` | 52-week high/low, **corporate-action adjusted** |
| `hl<d>` | new **52-week** high/low *events*, unadjusted (Equity + ETFs) |
| `bh<d>` | price-**band (circuit)** hit — H = upper, L = lower |
| `pd<d>` | full market data incl. `HI_52_WK` / `LO_52_WK`, unadjusted |
| `gl<d>` | NSE's own gainers/losers, sectioned Nifty 50 / Next 50 / Other |

**`hl<d>` is 52-week, not day-range** — this table said "day high/low" until 2026-07-27
and that was wrong. The bundle's own `readme.txt` says only "securities which have
reached a new high or a new low", which reads either way, so it was checked against
the data: for 23 Jul, `hl.PREVIOUS` equals the *prior session's 52-week high* in
38/38 rows, but its prior day-high in only 23/38 (BOSCH: PREVIOUS 42565 = 22 Jul
`HI_52_WK`, not its 41635 day high). It also carries 71 rows against 2,387 traded
EQ securities — a day-range list would be all of them.

**`CM_52_wk_High_low_<date>.csv` is the only source for the 52-week screens.**
`hl<d>` and `pd<d>` also carry 52-week figures, but the bundle's `readme.txt`
states both are *unadjusted* for bonus/split/rights — so after a corporate action
they disagree with the adjusted series and a stock can look like it broke a high
it never broke. `db.js`'s `hi52`/`lo52` views glob `CM_52_wk_High_low*` and
nothing else; keep it that way. Use `hl`/`pd` for anything but the 52-week
screens, and never mix the adjusted and unadjusted figures in one screen.

## Etiquette (read before any scraper)

[sources.md](sources.md) is the ToS/politeness stance. The four rules:

1. Never fabricate a URL. 2. Cache and pace; respect `robots.txt`.
3. Degrade gracefully. 4. Parsed outputs are committed; raw HTML stays local.

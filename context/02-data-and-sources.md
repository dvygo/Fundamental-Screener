# 02 · Data & sources

## Where the data comes from

- **Daily market bundle** (NSE/BSE) — an operator downloads it per
  [reference/bod-runbook.md](reference/bod-runbook.md) into `data/raw/bod/`, then
  `extract.py` decompresses/flattens it to `data/extracts/<YYYYMMDD>/`. **Never
  skip a day** — each session's prices/52w/gainers exist only in that day's file.
  Pull with a **1-day lag** (a same-day pull is silently partial).
- **Weekly filings** (insider, shareholding, results, announcements, board
  meetings, corporate actions) — CSVs with XBRL links, shredded to Parquet by
  `xbrl_populate.py` / `insider_load.py` / `shareholding_load.py`.
- **Live scrapes (Node)** — screener.in (login-gated full-text-search + on-demand
  dossiers) and the LiveMint companies RSS. Both paced and cached.
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

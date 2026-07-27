# 00 · Start here

You're taking over **Fundamental-Screener** — an idea-generation engine for Indian
listed equities. This is the onboarding track. Read `00 → 07` in order, then do
what [07-your-mission.md](07-your-mission.md) says: **build memory, then refactor.**

## The one-paragraph version

Daily NSE/BSE market bundles + SEBI/NSE XBRL filings + screener.in + LiveMint news
flow through a **Python ELT** into disk stores (and a WORM MinIO lake), get served
as schema-on-read **DuckDB** SQL by a **Node/Express** API on `:3000`, and are
rendered by a **Next.js** UI on `:3001`. The headline output is **HUNT** — a
convergence scoreboard that ranks stocks by how many independent signals (insider
buys, 52-week breaks, gainers/losers, corporate actions, news keywords) land on
them. It ranks where to *look*, never what to buy.

## Read in this order

| # | File | You'll know |
|---|------|-------------|
| 00 | this | the mission + the map |
| 01 | [architecture](01-architecture.md) | the three tiers, repos, ports, where code lives |
| 02 | [data & sources](02-data-and-sources.md) | what data exists, where it comes from, the rules |
| 03 | [storage](03-storage.md) | disk ↔ MinIO tiering, WORM |
| 04 | [signals & HUNT](04-signals-and-hunt.md) | the screens, the scoreboard, the framework |
| 05 | [frontend](05-frontend.md) | the UI submodule and its tabs |
| 06 | [state & open threads](06-state-and-open-threads.md) | what's built, what's pending |
| 07 | [your mission](07-your-mission.md) | build memory, then refactor |

## Ground rules (non-negotiable, from day one)

- **Never fabricate a URL.** Fetch only real, discovered links to their destination.
- **Cache and pace** every scrape; respect `robots.txt`. Re-runs read cache.
- **Degrade gracefully** — skip and log a bad page; never emit a half-empty record
  as complete.
- **Secrets** (`src/nodejs/.env`, screener creds) and `data/raw/` are **never**
  committed. Run the secret guard before every commit — see
  [../CONTRIBUTING.md](../CONTRIBUTING.md).

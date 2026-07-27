# PLAN

The screener is built in layers. Each is market data made queryable; together
they feed the **HUNT** convergence board — the thing the whole system exists to
produce.

## Layer A — market-wide screens (`Markets`)

Scan every EQ symbol each session. All schema-on-read DuckDB over the daily
NSE/BSE bundles in `data/extracts/` (`src/nodejs/src/db.js` + `screens.js`):

- **52-week high / low** — new highs/lows over the window, with the corporate-
  action-adjusted value from the *latest* snapshot per (symbol, date).
- **Gainers / Losers — N-day recurrence** — how often a name sits in the top-20
  by %-change across the window.
- **Upper / Lower circuit** — real band-hitters from the NSE PR bundle.

## Layer B — stock-centric drill-down (`Stock Centric`)

Per-symbol: insider trades (NSE PIT XBRL, `data/store/insider.parquet`), promoter
& public shareholding history (`shareholding.parquet`), market cap / P/E / EPS
(daily files), FII/DII deltas. screener.in is the primary drill-down source,
scraped on demand; our own stores are the fallback (and the intended v2 primary).

## Layer C — flow (`Insider Centric`, `Corporate Actions`, `News`)

- **Insider Centric** — market-wide insider trades over the last N days.
- **Corporate Actions** — dividends/splits/bonus/rights/buybacks with ex/record
  dates, bucketed from the `bc<date>.csv` purpose text.
- **News** — the LiveMint companies RSS, each headline tagged with the NSE
  symbol(s) it names (brand-phrase matcher over the security master).

## HUNT — the convergence scoreboard

The payload (see the *Idea Hunting Framework*, `context/requirements/`). Every
tripwire carries flat points; a name accrues them over a rolling window and the
highest total floats up. Convergence — many independent signals on one name — is
the tell. It ranks **where to look first**, never what to buy.

| Signal | Points |
|---|---|
| Insider **open-market** buy (Market Purchase / Block Deal) | 5 each, deduped per trade |
| Fresh 52-week high / low | 5 + 1 per additional new-high session |
| News keyword — strong / medium / light | 3 / 2 / 1 |
| Corporate action — rights / bonus·split·buyback | 2 / 1 |
| Daily gainer / loser | 1 per session in the top-20 |

**Honesty rules** (framework Part 3), enforced in `src/nodejs/src/hunt.js`:
rolling ~21-**session** window (oldest rolls off); count per signal *per session*,
not per mention (insider trades deduped, news headlines deduped); repetition
accumulates; fluff scores 0.

### Not yet wired (tracked, deliberately 0)

- **Volume ×1.5 confirmer** — needs a per-stock volume baseline.
- **Sector tailwind / headwind (±2)** — no sector-signal source yet.
- **Results / Orderbook / Capex announcements feed** — no dedicated feed; only
  the LiveMint headline proxy scores these keywords today.

## Storage roadmap

v1 reads local disk (`data/extracts`, `data/store`). v2 flips the DuckDB globs to
`s3://raw/` and serves from MinIO only (services read MinIO, not disk) — the WORM
`raw/` bucket makes the source drops tamper-evident. See
[storage.md](storage.md).

## Known data-coverage caveat

Only a handful of daily bhavcopies are loaded, while the insider store spans
~2 months. Price-derived signals (52w, gainers, losers) therefore reflect the
loaded sessions; they extend toward a full 21 as more dailies land. HUNT's window
is a session-equivalent calendar span so the richer feeds aren't starved.

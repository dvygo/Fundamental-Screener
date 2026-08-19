# Decision — what feeds the Live lane

**Status: decided 2026-08-19, not built.** Pairs with `us-source-lanes.md`.

## The split

Within the **Live** lane, sources are assigned by what each is actually good at:

| | source | page |
|---|---|---|
| **Fundamentals** | finviz | `/quote.ashx?t=<TICKER>` |
| **Technicals / prices** | Yahoo (yfinance) | already loaded |
| **Insider** | finviz | `/insidertrading` |

The **SEC** lane is untouched by this: `companyfacts` for financials, the
quarterly bulk data sets for insider.

Yahoo `.info` does carry fundamental fields (`forwardPE`, `debtToEquity`,
`grossMargins`, …) and 91,088 facts of it are already on disk. This decision
supersedes those for display — finviz's fundamentals table is richer and better
organised — but the parquet stays: it is the fallback when a finviz scrape
fails, and it holds market-derived fields worth keeping regardless.

## robots.txt, checked 2026-08-19

`/quote.ashx` is **not restricted** — no rule in the 53-line file touches it.

The constraint is elsewhere, and it shapes the loader:

    Disallow: /screener?*                    <- bulk route is OFF LIMITS
    Disallow: /export, /portfolio_export
    Disallow: /api/v1/screener-export-csv
    Disallow: /insidertrading*search=        <- the search variant only

A handful of specific screener views are explicitly `Allow`ed (topgainers,
newhigh, latestbuys, …), but nothing that yields a fundamentals table for an
arbitrary ticker.

**So there is no permitted bulk route.** Fundamentals must be fetched per
stock: 503 requests per refresh, paced. That is the same shape as
`us_market_pull.py info`, which takes ~10 paced minutes for the same universe —
budget for that, and make it resumable so a failure halfway does not discard
the work. The first version of the `.info` loader lost a full 10-minute run by
doing all its fetching before discovering it could not write; do the writability
check first.

## Why this pairing

**finviz for fundamentals** — it is a presentation layer over data the SEC and
exchanges publish, but it does the normalisation we would otherwise write
ourselves: consistent ratios across companies, sensible units, a stable table.

**Yahoo for technicals** — already loaded, already day-partitioned, already
feeding the four Markets US screens. Nothing to add.

The lane stays internally honest on freshness because both are effectively
current: finviz's fundamentals track the latest filing, Yahoo's bars are T-1.
Neither is filing-time in the way the SEC lane is.

## Consequences to accept

**Two scrapes, not one.** `/insidertrading` and `/quote.ashx` are separate
loaders with different shapes: the first is a rolling market-wide window that
must be scheduled or history is lost, the second is per-ticker and re-runnable
at will since it always reports current state.

**No provenance, by prior decision.** Per-row filing links are off; integrity is
asserted on the methodology page. That page must now name finviz as the source
of the Live lane's fundamentals as well as its insider data, and say plainly
that it is a third party rather than a regulator.

**Fragility doubles.** Two HTML surfaces to break instead of one. The Yahoo
`.info` parquet is the fallback for the fundamentals half; there is no fallback
for the insider half short of the SEC lane, which is exactly what the lane split
already gives the reader.

## Still parked

**Databento** remains off. See the block at the top of `us_market_pull.py` —
market-wide instead of S&P 500 only, authoritative, already one file per
session. It replaces Yahoo for prices when it happens, which would leave Yahoo
serving nothing in this lane and the technical half moving to Databento.

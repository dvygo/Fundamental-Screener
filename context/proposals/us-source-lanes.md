# Decision — US tabs split into two source lanes

**Status: decided 2026-08-19, not built.**

## The rule

The US board runs as two parallel lanes, and a deep link never crosses between
them:

    Insider Centric (Live)    ──→ Stock Centric (Live)
    Insider Centric (Archive) ──→ Stock Centric (Archive)

Click a ticker on a Live table and you land on the Live company page. Click one
on an Archive table and you land on the Archive company page. The lane you are
in is the lane you stay in.

| lane | how it arrives | provenance | ToS | clock |
|---|---|---|---|---|
| **Live** | scraped per request | none | grey | now |
| **Archive** | bulk files, downloaded whole | accession / settlement date / job id | clean | source's own calendar |

**Live** sources: finviz, Yahoo. **Archive** sources: SEC bulk (submissions,
companyfacts, Forms 3/4/5, 13F), FINRA (short interest, daily short volume),
Databento (OHLCV).

### The tag is "(Archive)", not "(SEC)" — decided 2026-08-24

The lane started as SEC-only, so the first pages shipped as `(SEC)`. It has
since taken on FINRA and Databento, and 13F is queued. Labelling a
Databento-priced panel "SEC" asserts a regulator vouched for it, which is the
exact class of mislabel this whole split exists to prevent.

`(Archive)` is true of every source in the lane and stays true when a sixth
arrives. It also reads as the natural opposite of `(Live)`, so a reader needs no
legend. Rejected alternatives: **(Filed)** — Databento prices are filed with
nobody; **(Official)** — Databento is a licensed redistributor, not a regulator;
**(Primary)** — accurate, but in a sidebar "primary" reads as *main/default*;
**(Bulk)** — describes our delivery mechanism, not anything a reader wants.

Archive's one weakness is that it implies stale, and mostly this lane is not:
FINRA short volume is same-day, SEC submissions T+2, Databento daily. Only
`companyfacts` and 13F are genuinely quarter-lagged. That is why every page
carries a freshness line built from its own `/coverage` endpoint, showing real
dates rather than an impression — the stamp tells the truth the tag cannot.

### Markets US is the exception — offline only

Markets US has **no Live mirror and no tag**. Since 2026-08-24 it reads
Databento exclusively (`us_daily`), and Yahoo has become an on-demand per-symbol
fetch rather than a bulk source.

A tag only earns its place where there is a pair to distinguish. Tagging a tab
that has no mirror adds noise and implies a sibling that does not exist.

## Why this shape, and what it fixes

The earlier objection to splitting Stock Centric by source was that a single
company view mixes clocks: reported EPS is weeks old while P/E moves live, so
one "as of" stamp over the page misrepresents both.

**Separating the lanes end to end removes that problem rather than labelling
it.** A SEC page is uniformly filing-time; a Live page is uniformly current.
Each page can carry ONE honest freshness stamp because everything on it shares a
clock. That is better than per-panel badges on a blended page — the reader never
has to hold two different "as of" dates in their head at once.

It also means the two lanes can disagree, visibly, which is a feature. If the
scraped feed shows a trade the SEC bulk has not published yet, that is real
information, not an inconsistency to paper over.

## What it costs

**`SymbolCell` currently hardcodes its target.** In `DataTable.tsx` the ticker
link always points at `/stock-centric`, which is why every US table today is a
dead end — it lands on the India tab, which has no US data and flips the sidebar
back to India. Lane routing needs that target to become a prop, e.g.
`symbolHref`, threaded from whichever screen owns the table. `DataTable` is
shared with the India tabs, so the default must stay `/stock-centric` or those
regress.

**Five US tabs.** Markets US, plus two lanes × two tabs. Worth checking the
sidebar still reads well at that width, and whether Markets US belongs in a lane
(it is Yahoo-sourced, so arguably Live).

**Two Stock Centric implementations.** They share a shell but not their data
layer: SEC reads `companyfacts` (XBRL, reported), Live reads `sp500_info`
(Yahoo, market-derived). Resist merging them later "to reduce duplication" —
the separation IS the feature.

## Open

- ~~Does Markets US join the Live lane, or stay standalone?~~ **Settled
  2026-08-24: standalone, Archive-only, untagged.** It is Databento-sourced.
- Do the lane names appear as tab suffixes — `Insider Centric US (Archive)` — or
  as a lane switcher alongside the market dropdown? Suffixes are simpler; a
  switcher scales better if a third lane ever appears. Suffixes are what shipped.
- HUNT US, when it happens, has to pick a lane or explicitly straddle both.
- India's tabs have the same split unnamed — NSE bulk drops are Archive,
  screener.in and LiveMint are Live — but no tab says so. Worth tagging for the
  same reason the US ones are, or worth deciding the India board is
  single-lane and leaving it alone.

## Built so far

| tab | Archive | Live |
|---|---|---|
| Stock Centric US | ✅ `sec_us.js`, companyfacts + submissions + Databento | ✅ `stock_us.js`, finviz + Yahoo |
| Markets US | ✅ Databento (`us_daily`) | — by design |
| Insider Centric US | ✅ SEC Forms 3/4/5 quarterly | ⚠️ `us_insider_live` exists, board does not read it |
| FINRA short data | ✅ `finra_us.js`, five endpoints | — |
| 13F | ❌ not loaded | — |

Two gaps, both cheap: Insider Centric US is one query from its Live mirror, and
`finra_us.js` serves five working endpoints that no page calls.

---

## TODO — split `src/python/` into india/ and us/

Not done (deferred 2026-08-19). The frontend (`components/india|us/`) and the
API (`src/nodejs/src/india|us/`) are already split; Python still has all 19
loaders in one folder.

The move itself is trivial. The catch is the same one the API split hit: every
loader derives the repo root as `Path(__file__).resolve().parents[2]`, which is
correct at `src/python/` and wrong one level deeper. Each moved file needs
`parents[3]`.

Python has no bundling step, so unlike the API there is no second resolution
mode to keep in agreement — a plain depth fix is enough, and no `paths.py`
indirection is required. Sibling imports also keep working, since Python puts
the script's own directory on `sys.path` (this matters for
`insider_load.py`, which imports `fetch`/`shred` from `xbrl_populate.py`).

Suggested split — `us/`: `us_market_pull.py`, `sec_insider_pull.py`.
`india/`: everything else. `data_sync.py` stays at the root; it syncs `data/`
wholesale and belongs to neither market.

Every documented command path changes with it (CLAUDE.md, the example env
files, this folder), so grep for `src/python/` and update in the same commit.

# Decision — US tabs split into two source lanes

**Status: decided 2026-08-19, not built.**

## The rule

The US board runs as two parallel lanes, and a deep link never crosses between
them:

    Insider Centric (Live) ──→ Stock Centric (Live)
    Insider Centric (SEC)  ──→ Stock Centric (SEC)

Click a ticker on a Live table and you land on the Live company page. Click one
on a SEC table and you land on the SEC company page. The lane you are in is the
lane you stay in.

| lane | insider source | company source | freshness |
|---|---|---|---|
| **Live** | finviz scrape of Form 4s | Yahoo `.info` | same-day / continuous |
| **SEC** | SEC quarterly bulk data sets | SEC XBRL `companyfacts` | filing-time, weeks to months old |

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

- Does Markets US join the Live lane, or stay standalone? It is Yahoo-sourced.
- Do the lane names appear as tab suffixes — `Insider Centric US (SEC)` — or as
  a lane switcher alongside the market dropdown? Suffixes are simpler; a
  switcher scales better if a third lane ever appears.
- HUNT US, when it happens, has to pick a lane or explicitly straddle both.

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

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

### What decides whether a source CAN be on-demand — decided 2026-08-24

Not who publishes it. **The shape it ships in.**

| source | shape | on-demand possible? |
|---|---|---|
| `submissions.zip`, `companyfacts.zip` | whole market, one file | no — bulk or nothing |
| FINRA daily / biweekly | whole market, one file per period | no |
| Databento jobs | whole market, one job | no |
| SEC quarterly ownership sets | whole market, one zip | no |
| Form 4 / 3 / 5 XML | one filing | **yes** |
| Yahoo bars | one symbol | **yes** |
| finviz quote page | one symbol | **yes** |

There is no such thing as "just AAPL's row" of a FINRA daily file, so
whole-market sources stay bulk whatever we would prefer. Everything per-entity
is fetched on demand and never stored as history.

**No backfills.** The only things held offline are the bulk archives above. In
particular, crawling Form 4 XML to reconstruct history is explicitly rejected:
10.7M filings at SEC's 10 req/s ceiling is weeks of fetching, and the quarterly
ownership sets already contain it.

### Two tabs are Archive-only — exceptions to the two-lane rule

**Markets US** (decided 2026-08-24). Reads Databento exclusively via `us_daily`;
Yahoo is an on-demand per-symbol fetch, not a bulk source.

**Insider Centric US** (decided 2026-08-24). Stays on the SEC quarterly
ownership sets. This is what settles whether those sets survive the on-demand
shift: they do, because the board *is* them. Value-ranked views — biggest buys,
net insider flow — need shares x price across thousands of filings at once, and
that can be neither computed from the `submissions` index nor fetched per
symbol, because the board is many symbols by definition.

Both are still **tagged `(Archive)`**, despite having no Live mirror.

The first call here was that a tag only earns its place where there is a pair
to distinguish. That was overruled, and the better reasoning is: the tag is a
statement about the DATA, not a disambiguator between siblings. A reader
arriving at the sidebar cold learns that Markets US and Insider Centric US are
bulk primary data without having to notice that no `(Live)` twin sits beside
them. An untagged tab reads as *unclassified*, not as *no mirror exists*.

    Stock Centric US (Archive)  |  Stock Centric US (Live)
    Markets US (Archive)
    Insider Centric US (Archive)

The consequence for the Live lane: `us_insider_live` (finviz, 19,525 rows) gets
no board of its own. It stays where it already is — the per-symbol insider panel
on Stock Centric US (Live).

### The quarterly archive is COMPLETE — the XML adds no fields, only freshness

Checked against 2026q2. The sets ship eight tables, and they are the flattened
form of the same XML:

| table | cols | carries |
|---|---|---|
| `SUBMISSION` | 14 | issuer, symbol, **`aff10b5one`** |
| `REPORTINGOWNER` | 13 | name, relationship, title, address |
| `NONDERIV_TRANS` | 28 | code, shares, price, holdings after, ownership |
| `DERIV_TRANS` | 42 | options — exercise price, expiration, underlying |
| `FOOTNOTES` | 3 | footnote text the other tables reference by id |
| `NONDERIV_HOLDING`, `DERIV_HOLDING`, `OWNER_SIGNATURE` | | |

The 10b5-1 flag is in there. So the ONLY thing per-filing XML buys is latency:
T+2 instead of ~7 weeks. No extra field, nothing the archive cannot answer.

That makes on-demand XML a **freshness feature, not a completeness one** — worth
having on the Live lane's per-symbol insider panel, where finviz sits today,
and worth nothing at all on Insider Centric US, which is Archive-only.

**Currently only 3 of the 8 tables are read** (`SUBMISSION`, `REPORTINGOWNER`,
`NONDERIV_TRANS`, in `db.js`). `DERIV_TRANS` is unread, so option grants,
exercises and expirations — a large part of how executives are actually paid and
how they actually exit — are on disk and invisible. `FOOTNOTES` is unread too,
which is why every `*_fn` column in the transaction tables currently points at
nothing.

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

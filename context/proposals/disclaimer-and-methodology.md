# Proposal — a disclaimer and a methodology page

**Status: proposed, not built.** This is a feature recommendation with a TODO
list, not a description of anything that exists. Nothing in this document is
wired up.

## Why

Every number this app shows is traceable to a file we downloaded, and every
awkward judgement about those files has already been made and commented in the
code. None of it is visible to whoever reads the dashboard. A reader currently
cannot tell whether "new 52-week high" means an exchange said so or we computed
it, and those are different claims.

The prompt for this was [mtf.trading](https://mtf.trading/methodology), a public
MTF dashboard that publishes exactly this: an "i" button explaining what the
site is, and a methodology page naming every source file, every aggregation
rule, and its own honest caveats. It is a small amount of writing that converts
a pile of charts into something a stranger can audit.

This also lines up with the project's own honesty rules — the ones the HUNT
scoreboard already follows internally. Surfacing them is the missing half.

## What to build

### 1. The "i" button — what this is

Small info affordance in the header, opening a short panel:

- what the dashboard is, in two sentences
- sources named at a high level (NSE disclosures, screener.in, SEC, LiveMint)
- not affiliated with NSE, BSE, SEBI or the SEC
- **last data refresh**, per source — this matters more for us than for most,
  because the pipeline is deliberately a day behind and a stale extract is
  otherwise indistinguishable from a quiet market
- link through to the methodology page

### 2. `/methodology` — sources, rules, caveats

The substance already exists as code comments; this is mostly transcription.

**Sources** — one row per file, what it contributes, and the loader that reads it:

| feeds | source | loader |
|---|---|---|
| prices, gainers/losers | NSE `sec_bhavdata_full`, `gl<date>` | `extract.py` |
| 52-week highs/lows | NSE `CM_52_wk_High_low<date>` | `extract.py` |
| circuit hits | NSE `bh<date>` | `extract.py` |
| corporate actions | NSE `bc<date>` | `extract.py` |
| market cap, P/E | NSE `mcap<date>`, `PE_<date>` | `extract.py` |
| promoter holding | NSE shareholding index CSV | `shareholding_load.py` |
| insider (India) | NSE insider index + filing XBRL | `insider_load.py` |
| news | LiveMint `today.xml` / `yesterday.xml` | `livemint_snapshot.py` |
| company dossiers | screener.in | `screener_company.py` |
| US prices | Yahoo via yfinance, S&P 500 | `us_market_pull.py` |
| US fundamentals | Yahoo `.info`, lossless long table | `us_market_pull.py` |
| US insider | SEC Forms 3/4/5 quarterly data sets | `sec_insider_pull.py` |
| S&P 500 roster | Wikipedia list of S&P 500 companies | `us_market_pull.py` |

**Aggregation rules** — the decisions a reader cannot infer from the output:

- Main board is **EQ only**; BE is excluded.
- `gl<date>` bridges to `NSE_CM_security<date>` across **all series** with
  `DelFlg='N'`, not EQ-only — filtering the master to EQ drops the entire SME
  board and cost us a third of the name matches when we first tried it.
- `hl<date>` is a **52-week** high/low list, not a day range. Verified 38/38
  against the prior session's 52-week high, versus 23/38 for its day high.
- Last-session panels take `max(as_of)` over the files actually on disk, so a
  missing T-1 quietly means an older session rather than an error. The panel
  prints the real date it used.
- Recurrence screens rank each session independently and count appearances;
  ranking carries an explicit symbol tiebreaker and averages run over DECIMAL,
  because without either the same query returned different rows run to run.

**US-specific, and worth stating plainly:**

- Markets US has **four** screens, not five. Upper/lower circuit has no US
  equivalent — per-stock daily price bands are structural to Indian exchanges,
  while US halts are intraday LULD and are not published as a daily file.
- US 52-week levels and % moves are **computed by us** over 252 trailing
  sessions. NSE publishes prev-close, direction and an official 52-week list;
  Yahoo publishes none of them. These are not the same kind of claim and the
  page should say so.
- SEC insider screens are **open-market only** by default. `TRANS_CODE`
  separates decisions (P/S) from compensation mechanics (A grants, F tax
  withholding, M option exercises), and the latter outnumber real purchases
  roughly 7:1 — counting them turns "insider buying" into a vesting calendar.
- 10b5-1 plan sales are counted separately: a sale scheduled months in advance
  is weak evidence of present conviction.

**Honest caveats** — the section that earns the rest its credibility:

- SEC data is filer-entered and contains real errors. `trans_date` spans
  0024-10-02 to 2028-03-19; `price_per_share` reaches $1.63bn. Both are bounded
  before use, and rows outside the bounds keep their other fields rather than
  disappearing.
- `AFF10B5ONE` arrives in five encodings, so "not stated" is preserved as
  unknown rather than collapsed into "no".
- Yahoo is an unofficial endpoint. Batched downloads can drop a symbol silently
  under cache contention; a completeness guard re-fetches and names anything
  still missing.
- `shareholding_facts.parquet` is read by the API but **no loader writes it** —
  it cannot currently be regenerated if lost.
- Coverage is finite: NSE extracts start where the backfilled drops start, and
  a missed LiveMint day is unrecoverable (their window is about a week).

### 3. Deliberately NOT proposed

mtf.trading also publishes open JSON endpoints, bulk downloads and embeddable
badges. **Skip those.** This app sits behind auth on a private box; exposing
public endpoints is a separate decision about publishing data, and should not
arrive as a side effect of adding a disclaimer.

## TODO

- [ ] `/methodology` route + page (static content, no API calls)
- [ ] "i" button in the header, opening the short panel, linking to it
- [ ] per-source "last refresh" — needs an API endpoint reporting `max(as_of)`
      per feed; today nothing exposes freshness
- [ ] decide whether the India/USA market switcher should scope the page, or
      whether one page covers both
- [ ] fix or delete `shareholding_facts.parquet` before publishing a caveat
      about it — better to close the gap than document it

## Open question

Whether to state coverage start dates per feed. It is the most useful thing on
the page for anyone running a screen over a long window, and the most annoying
to keep accurate, since it changes whenever a backfill lands. Probably compute
it rather than write it down.

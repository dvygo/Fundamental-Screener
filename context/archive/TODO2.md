# TODO2 — deferred to v2

## UPDATE 2026-07-22 — B7/B8 resolved via rupeevest, adapters not needed

The "check gated screener.in/rupeevest before building 40 adapters" bet paid
off. rupeevest.com gives real per-scheme holdings **already bound to fund
manager name**, no AMC-by-AMC parsing:

- `mf_stock_portfolio/get_search_data_stock` (bare GET) — full stock master,
  1,746 rows, `fincode` id + `stock_search` embedding BSE code + NSE symbol.
  Pulled live, saved `data/raw/rupeevest/search_20260722.json`.
- `stock_price_difference/get_compare_data_stock[,_1]` (bare GET, 2 calls) —
  full-market net MF buying (538 rows) / selling (620 rows), one month,
  sector + cap classification. Pulled live, saved same folder.
- `mf_stock_portfolio/get_stock_detail_new` (POST, body `fincode=<id>`) — for
  one stock, every scheme holding it: `s_name1` (scheme), `fund_house` (AMC),
  `schemecode`, **`fund_mgr1` (real manager name)**, `aum`, `percent_aum`,
  and `month_name_1..4` (quantity across last 4 disclosed months — trend
  built in). Verified live against Reliance Industries (fincode 100325):
  ~90+ schemes returned, managers named directly (Sankaran Naren, Sandeep
  Tandon, Manish Gunwani, etc).
  - `fund_manager_code` is a **stable per-person id**, reused across every
    scheme that manager runs (Sandeep Tandon = 791 on all Quant schemes,
    Atul Mehra = 995 across 3 Motilal Oswal funds) — real join key across
    schemes/AMCs, not just free-text name matching. This is the strongest
    version of B3 possible: every stock a specific manager touches, by id.
  - top-level response also carries `month_name_3`/`month_name_4` as actual
    calendar labels (e.g. `"Apr-26"`, `"Mar-26"`) — the 4-month trend window
    resolves to real dates, not anonymous sequence numbers.

All 3 need only session cookie + Rails CSRF token (no login) — script in
`src/rupeevest_pull.py` already does the handshake for the first two.

Next (not yet built): loop `get_stock_detail_new` over all 1,746 fincodes
from the master list, paced (same discipline as `xbrl_populate.py`'s 3s
delay), landing lossless per-fincode JSON under
`data/raw/rupeevest/stock_detail/<fincode>.json`. That single loop replaces
the entire per-AMC adapter fleet below — leaving it here as historical
record of why the simpler path was worth checking first, not as a live plan.

---

## B7/B8 — per-AMC portfolio-disclosure adapters: PUSHED TO v2 (superseded above)

Investigated deep (2026-07-21/22): 3 real AMCs' monthly disclosure files
(360.one, bajajamc.com, icicipruamc.com), multiple months each. Confirmed:

- structurally different per AMC (zip-of-files vs one-file-many-sheets vs
  one-file-few-sheets), AND
- **unstable even within one AMC across its own months** — sheet tab
  naming/order drifts (360 ONE), filenames get cosmetically renamed
  (ICICI: `Silver ETF Fund of Fund` → `Silver ETF FOF`, same fund), stray
  export artifacts appear/disappear (Bajaj's phantom `null` 10th column).
- real scheme identity only recoverable per-AMC (sheet tab code for
  Bajaj/ICICI, row1 boilerplate text for 360 ONE) — needs its own
  resolution step before any column-mapping.

Conclusion: correctly building this (per-AMC adapters, each individually
audited against source subtotals + a rename/drift test case, feeding a
shared normalizer) is real engineering effort — one adapter per AMC,
times ~40 AMCs, each needing its own audit. Too much for what this signal
is worth right now.

**Decision: defer.** Before investing in the 40-adapter build, check
whether a **gated scrape of screener.in or rupeevest** (or similar
aggregator) already exposes the same fund-holdings signal pre-normalized
— cheaper than reverse-engineering 40 AMCs' Excel conventions ourselves.
If one of those sources holds up, it replaces this entire adapter-fleet
plan; if not, come back to the per-AMC approach above (design already
worked out, just not built).

Not started: no `src/holdings/` scaffold, no adapters. Real files stay
under `data/raw/mf-amc/<domain>/` for whenever this resumes.

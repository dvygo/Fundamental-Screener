# 06 · State & open threads

## Built & verified

- **Layer A** market screens (Markets), **Layer B** Stock Centric drill-down,
  **Layer C** Insider Centric / Corporate Actions / News, **Firms & Asset
  Managers**, and the **HUNT** convergence board.
- Node API (`:3000`) + Next.js UI (`:3001`, submodule).
- MinIO WORM lake — built and proven, currently **deferred/torn down** (v1 = disk).
- screener.in dossier scraper; rupeevest handshake (`rupeevest_pull.py`).

## Open threads

Grounded in `archive/TODO.md`, `archive/TODO2.md`, and recent work. **Verify against
code — archived TODOs are historical, not current truth.**

- **HUNT unwired signals** — volume ×1.5 confirmer; sector tailwind/headwind (±2);
  a dedicated Results/Orderbook/Capex **announcements feed** (only the LiveMint
  keyword proxy scores these today).
- **Data coverage** — closed. A backfill on 2026-07-27 took `data/extracts/` from
  5 sessions to **54 trading sessions** (`2026-05-08` → `2026-07-24`, 78 date
  folders including non-trading days, 162k EQ rows), so HUNT's rolling ~21-session
  window is comfortably satisfiable. Note the drop repeats the previous session's
  bhavcopy on non-trading days under the new date's filename — 67 bhavcopy files,
  54 distinct sessions — which lands duplicate rows in `prices`. The screens
  already absorb this via `SELECT DISTINCT as_of, symbol, pct_change`, so don't
  "fix" it by deleting files, but keep the `DISTINCT` if you rewrite them.
- **News history** — starts 2026-07-27 and only accrues forward; LiveMint has no
  archive. See `livemint_snapshot.py`. Not yet scheduled, and a missed day cannot
  be recovered.
- **`shareholding_facts.parquet` has no producer** — `db.js` and `companies.js`
  read it, the file exists in `data/store/`, but nothing in `src/python/` writes
  it. Find or rewrite the loader before anyone needs to rebuild it.
- **Layer C classifier** — announcement → event type (order book / capex / results
  / fund raise / board meeting / credit rating / acquisition / expansion /
  approval). Rules/keyword first, LLM later. Sources already land.
- **v1 → v2 storage** — flip `db.js` read globs to `s3://raw/…` (MinIO cutover).
- **Fund-manager holdings (B3 / B7 / B8)** — solved via rupeevest (`archive/TODO2.md`):
  `get_stock_detail_new` gives real manager names + a stable `fund_manager_code`.
  The paced per-fincode loop over the 1,746-stock master isn't built yet.
- **SQL parity** — the same screen SQL is maintained by hand in `screens.py`
  (Python) and `screens.js` (Node). Dedupe to one source of truth.
- **Security master** — one table mapping symbol ↔ ISIN ↔ BSE scripcode ↔ screener
  code; pieces exist in mcap + insider XBRL.

Historical detail and superseded plans: `archive/`.

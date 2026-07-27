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
- **Data coverage** — only ~5 daily bhavcopies are loaded, so price-derived signals
  (52w, gainers/losers) are thin; insider spans ~2 months. Load more dailies.
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

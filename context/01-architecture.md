# 01 · Architecture

Three tiers, one direction of flow. Deeper: [PLAN.md](PLAN.md), [DEPLOY.md](DEPLOY.md).

```
NSE/BSE daily bundles          SEBI/NSE filing index CSVs · LiveMint sitemaps
        │  per BOD drop                │  on index refresh / once a day
        │  extract.py, ingest.py       │  insider_load, shareholding_load,
        │                              │  livemint_snapshot
        ▼                              ▼
data/extracts/<YYYYMMDD>/          data/store/*.parquet
  (day-partitioned market data)      (consolidated, whole history)
        │                              │   + MinIO raw/ (WORM) · delta/   [v2]
        └──────────────┬───────────────┘
                       ▼
src/nodejs/  REST API on :3000 — Express 5 + DuckDB schema-on-read over the globs;
             also does live screener.in / RSS scraping
        ▼
src/nextjs/  Next.js UI on :3001   (submodule → hunt-internal)
```

## Where the code lives

| Area | Path | Key files |
|---|---|---|
| ELT — daily | `src/python/` | `extract.py`, `ingest.py` |
| ELT — on refresh | `src/python/` | `insider_load.py`, `shareholding_load.py`, `livemint_snapshot.py` (all → `data/store/`, decoupled from the daily cycle) |
| ELT — other | `src/python/` | `xbrl_populate.py` (legacy per-day shred + `fetch`/`shred` helpers), `screens.py`, `screener_company.py`, `screener_search.py`, `rupeevest_*.py` |
| API (Node, ESM) | `src/nodejs/src/` | `server.js` (routes), `db.js` (**DuckDB base views**), `screens.js`, `companies.js`, `corporate.js`, `news.js`, `firms.js`, `hunt.js`, `screener.js` |
| UI (Next.js) | `src/nextjs/` | **submodule** → hunt-internal (see [05](05-frontend.md)) |

## Ports

`3000` API · `3001` UI · `9000/9001` MinIO (S3 API / console).

## The DuckDB spine

`src/nodejs/src/db.js` defines schema-on-read **views** over the CSV/Parquet globs
in `data/extracts` and `data/store`; every screen is SQL over those views — no
warehouse to operate. Query params interpolated into SQL (INTERVAL/LIMIT) must be
**validated integers** (see `server.js` `intParam`).

> **Known duplication:** screen SQL exists in *both* `src/python/screens.py` and
> `src/nodejs/src/screens.js`; parity is maintained by hand today. That's a
> refactor target — see [06](06-state-and-open-threads.md) / [07](07-your-mission.md).

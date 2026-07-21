# TODO / Roadmap

Architecture: **ELT**. Land raw whole (lossless) → **MinIO** (storage of truth,
WORM). Transform at query time with **DuckDB** reading MinIO over S3. Nothing is
stripped at load; screens are SQL, not baked files.

**v1 (now) = disk only. MinIO/WORM = v2.** Focus v1: fill daily data + backfill.

```
UNO    raw drop → data/extracts/ (decompress zip/gz + copy all)   [DONE]
QUERY  DuckDB over data/extracts/*/  runs screen SQL              [DONE 1-5]
XBRL   filings → data/bronze/ parquet (disk)                      [DONE]
--- v2 ---
LAND   data/extracts → MinIO raw/ (WORM) + backup                 [built, deferred]
SERVE  DuckDB --httpfs--> s3://raw/                               [deferred]
```

Pipeline order (v1): `extract.py` (UNO, the root) → `screens.py` /
`xbrl_populate.py`, all reading `data/extracts/`. `ingest.py` + `--push` are the
v2 MinIO path (MinIO currently torn down). Raw drop stays pristine.

---

## Done — process UNO + push to MinIO
- [x] `src/extract.py` (UNO) — decompress `data/raw/bod/<date>/` (.zip/.gz) + copy
      all → `data/extracts/<date>/` (flat working root). Collision-safe.
- [x] `src/ingest.py` — push `data/extracts/<date>/` → MinIO `raw/` (WORM) + mirror
      to `data/backup/`. sha256 manifest, idempotent, WORM-verified.

## NEXT — query layer (DuckDB over MinIO)
- [ ] `httpfs`/S3 config → DuckDB reads `s3://raw/...` directly (no local truth file).
- [ ] land format decision: keep raw CSV, or convert to **Parquet** at ingest
      (all columns, lossless) for columnar speed. Parquet preferred once volume grows.
- [ ] `sql/screens/` views (schema-on-read, all casts here):
  - [ ] A1/A3 — 52-week high/low **triggers, last session** (key on real `as_of`).
  - [ ] A2 — 52w-high **N-day event count** per symbol.
  - [ ] A4 — top gainers / losers (two views, configurable depth).
  - [ ] A5 — gainers **N-day recurrence** count.
  - [ ] B2 — promoter holding + **change** (from shareholding).
  - [ ] B4 — symbol drill-down: mcap, price, P/E, EPS, promoter/FII/DII + deltas.

## XBRL detail (lossless facts, ELT)
- [ ] `src/xbrl.py` — fetch per-filing XBRL from `nsearchives`, parse **every fact**
      into a long table `xbrl_facts(filing_url, tag, context, period, unit, value)`.
      Nothing chosen/dropped — pivot in SQL.
- [ ] wire insider / shareholding / results filings through it (shared engine).
- [ ] paced fetch (~3s), cached, degrade-on-error.

## Dedupe (the rolling 1-month window overlap)
- [ ] dedupe **before** MinIO write, keyed on filing identity (XBRL url / broadcast
      ts+symbol), NOT filename — filenames repeat across month windows.
- [ ] a "seen filing ids" ledger (DuckDB/Delta table), checked at ingest.
- [ ] (discuss with user — deferred by design.)

## Layer C — announcements engine
- [ ] land NSE announcements / board-meetings / corporate-actions CSVs (already in BOD.md).
- [ ] add BSE corporate announcements source.
- [ ] classifier → event type: order book / capex / results / fund raise / board
      meeting / credit rating / acquisition / expansion / regulatory approval.
      Rules/keyword first, LLM later.

## Screener (fundamentals narrative, separate from NSE)
- [ ] `screener_company.py` already parses ratios/financials. Extend for:
  - [ ] B1 insider (cross-check vs NSE), B3 top PM/asset-manager holdings.
- [ ] B3 source decision: screener "Shareholding" vs AMFI monthly MF portfolios.

## Security master (join key)
- [ ] one table mapping symbol ↔ ISIN ↔ BSE scripcode ↔ screener code.
      Pieces already in mcap + insider XBRL — assemble.

## Ops
- [ ] daily scheduler (one EOD run over the day's folder).
- [ ] reset/rehydrate proven: wipe MinIO, replay `data/backup/` → raw.
- [ ] verify insider-page URL slug in BOD.md (row 1 unverified).

## Output
- [ ] frontend: clickable A/B lists → B4 drill-down. Static site vs API — decide.

## Done
- [x] screener dossier scraper (`screener_company.py`).
- [x] docker MinIO — WORM `raw/` + versioned `delta/`, proven immutable.
- [x] storage tiering documented (`context/storage.md`).
- [x] BOD.md operator download runbook.
- [x] proved XBRL→facts parse (insider filing, plain lxml).
- [x] ELT decision (replaces the lossy `parse_bod.py` ETL cut).

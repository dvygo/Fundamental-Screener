# 03 · Storage

Full rationale: [storage.md](storage.md).

## v1 — disk is the source of truth (today)

| Path | What | Committed? |
|---|---|---|
| `data/extracts/<YYYYMMDD>/` | day-partitioned market data (bhavcopy, 52w, circuit, corp actions) | no (gitignored, re-fetchable) |
| `data/store/` | **consolidated** single-file stores — `insider.parquet`, `shareholding.parquet`, `news.parquet` (whole history, not day-partitioned) | no (derived) |
| `data/companies/` | parsed dossiers | yes |
| `data/raw/` | cached scrape HTML + downloaded index CSVs / XBRL cache | **no — never commit** |
| `data/backup/<YYYYMMDD>/` | DR mirror of what went to MinIO | manifest only |

The DuckDB views in `db.js` glob `data/extracts` and `data/store` directly.

**The two write on different clocks.** `data/extracts/` fills per BOD drop;
`data/store/` fills when a source index CSV is re-downloaded (filings) or once a
day (news). Neither obliges the other — see the cadence table in
[../CLAUDE.md](../CLAUDE.md).

Derived is not the same as re-derivable. `data/extracts/` rebuilds from the raw
zips offline; `insider.parquet` / `shareholding.parquet` rebuild from their index
CSV plus the cached XBRL. `news.parquet` cannot be rebuilt past the ~week
LiveMint exposes — its raw snapshots are the only copy, and both they and the
store are gitignored, so `data_sync.py` push is the sole preservation path.

## v2 — MinIO lake (built, currently deferred)

`docker/docker-compose.yml` provisions:

- **`raw/`** — created **with object-lock (WORM)** + versioning. Landed
  bhavcopies can't be overwritten or deleted within the retention window:
  tamper-evidence for the audit trail. The mode is set in `docker/.env` —
  GOVERNANCE ships as the default, COMPLIANCE is the production intent (nobody
  can delete before expiry, not even root). See `storage.md`.
- **`lake/`** — versioned, and deliberately **NOT** object-locked. Holds the
  DuckLake tables written by `src/python/lake_sync.py`; DuckLake must be able to
  rewrite and expire its own Parquet during compaction. This replaced the
  planned `delta/` bucket, which was never written to.

The cutover is mechanical: flip the read globs in `src/nodejs/src/db.js` from local
paths to `s3://raw/…`. Services then read MinIO, not disk.

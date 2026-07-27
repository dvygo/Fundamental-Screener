# 03 · Storage

Full rationale: [storage.md](storage.md).

## v1 — disk is the source of truth (today)

| Path | What | Committed? |
|---|---|---|
| `data/extracts/<YYYYMMDD>/` | day-partitioned market data (bhavcopy, 52w, circuit, corp actions) | no (gitignored, re-fetchable) |
| `data/store/` | **consolidated** single-file filing stores — `insider.parquet`, `shareholding.parquet` (whole history, not day-partitioned) | no (derived) |
| `data/companies/` | parsed dossiers | yes |
| `data/raw/` | cached scrape HTML + downloaded index CSVs / XBRL cache | **no — never commit** |
| `data/backup/<YYYYMMDD>/` | DR mirror of what went to MinIO | manifest only |

The DuckDB views in `db.js` glob `data/extracts` and `data/store` directly.

## v2 — MinIO lake (built, currently deferred)

`docker/docker-compose.yml` provisions:

- **`raw/`** — created **with object-lock (WORM)** + versioning + a COMPLIANCE
  retention. Landed bhavcopies can't be overwritten or deleted within the window:
  tamper-evidence for the audit trail.
- **`delta/`** — versioned.

The cutover is mechanical: flip the read globs in `src/nodejs/src/db.js` from local
paths to `s3://raw/…`. Services then read MinIO, not disk.

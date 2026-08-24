# Storage architecture

Raw drops are processed once; every processed file is then **dual-written** to
MinIO (the serving layer) and to a dated disk backup (the offline mirror).
**Services read MinIO only** — never the disk.

```
   data/bod/                      <- raw manual drops (bhavcopies, daily reports).
   (unprocessed inbox)               Pre-processing. Not what services see.
        |
        |  src/ingest — process the raw files
        v
      ┌───────────── dual-write ─────────────┐
      v                                       v
   MinIO                                  Disk  data/backup/YYYYMMDD/
     raw/    YYYYMMDD/… (WORM)            (mirror of exactly what went to MinIO,
     lake/   DuckLake tables               partitioned by processing date)
      |
      v
   Services / DuckDB query MinIO only
```

## The three areas

| Location | Stage | Contents | Read by |
|---|---|---|---|
| `data/bod/` | **input** | raw manual drops, as downloaded | ingest only |
| **MinIO** `raw/` + `lake/` | **serving** | processed files (WORM) + DuckLake tables | services / DuckDB |
| `data/backup/YYYYMMDD/` | **backup** | mirror of every file written to MinIO | disaster recovery |

`bod/` is the inbox; `backup/YYYYMMDD/` is the outbox mirror. They hold different
things — raw vs processed.

## Why dual-write

- **MinIO can be rebuilt from disk.** If the MinIO volume is wiped, replay
  `data/backup/YYYYMMDD/` back into `raw/` and rebuild `lake/` with
  `python src/python/lake_sync.py`. Nothing lost.
- **One serving contract.** Services and queries hit MinIO's S3 API only; they
  don't know or care about disk layout.
- **Immutability lives in MinIO.** WORM/object-lock is enforced by the running
  MinIO. The disk backup is disaster recovery, not tamper-evidence — a file on
  disk can be edited; a WORM object in MinIO cannot.

## Reset / rehydrate

```bash
# wipe MinIO (buckets + lock state), keep the disk backup
cd docker && docker compose down -v && docker compose up -d
# replay the processed mirror back into MinIO (raw, WORM)
python src/ingest.py --replay data/backup
# rebuild the lakehouse from the Parquet stores (~25s for 14 tables)
python src/python/lake_sync.py
```

## Rules

- **Process from `bod/`, write to both sinks.** A processed file is never in only
  one place — MinIO and `backup/YYYYMMDD/` always get the same bytes.
- **Date is the partition key** post-processing: `raw/YYYYMMDD/` in MinIO,
  `backup/YYYYMMDD/` on disk, a date column in the DuckLake table. Keep the
  exchange's original filename inside the dated folder.
- **Never object-lock `lake/`.** DuckLake rewrites and expires its own Parquet
  during compaction and snapshot expiry; locking it breaks cleanup and grows the
  bucket without bound. Immutability there comes from snapshots, not storage.
- **Backup payload stays local; only its `_ingest_manifest.json` is committed.**
  The backup folder is a binary DR mirror (raw csv/zip + bronze parquet) — too
  heavy for git. The per-day sha manifest is the committed audit record of what
  was ingested; the bytes live on disk + MinIO. `data/raw/` (cached scrape HTML,
  cached XBRL) stays local too.

## The lakehouse — DuckLake, not Delta

`lake/` holds [DuckLake](https://ducklake.select) tables: metadata in a SQL
catalog (`data/store/lake.ducklake`), data as Parquet in the bucket. It replaced
the planned `delta/` bucket, which was never written to — DuckLake is
DuckDB-native, so it needs no second query engine at this scale, and it reached
1.0 in April 2026.

What it buys: the loaders already write immutable Parquet, so the data is
reproducible — but each run overwrites the file, so *"what did this table say on
the 14th"* was unanswerable. Every `lake_sync.py` run leaves a snapshot, and a
table can be read as of one:

```sql
SELECT * FROM lake.sec_facts AT (VERSION => 12);
```

```bash
python src/python/lake_sync.py --list              # what would sync
python src/python/lake_sync.py --history sec_facts # snapshot log
python src/python/lake_sync.py --tables sec_facts  # one table
```

`lake_sync.py` discovers every `*.parquet` under `data/store/` and
`data/extracts_us/_meta/`, so a new loader's output is published without editing
the script. Each table is a **full replace** — the source Parquets are
themselves full rewrites, so appending would double rows. History lives in the
snapshots, not in the table.

### Retention mode — GOVERNANCE vs COMPLIANCE

`raw/` is object-locked and `docker/.env` picks the mode:

- **GOVERNANCE** (shipped default) — a user holding
  `s3:BypassGovernanceRetention` can still delete. Recoverable.
- **COMPLIANCE** — nobody can delete before expiry: not an admin, not root, not
  by deleting the bucket. At `RAW_RETENTION_DAYS=3650` that commits the disk for
  ten years.

COMPLIANCE is the production intent. Set it on the real box, not on a
workstation.

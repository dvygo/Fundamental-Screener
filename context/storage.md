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
     delta/  tables (versioned)           partitioned by processing date)
      |
      v
   Services / DuckDB query MinIO only
```

## The three areas

| Location | Stage | Contents | Read by |
|---|---|---|---|
| `data/bod/` | **input** | raw manual drops, as downloaded | ingest only |
| **MinIO** `raw/` + `delta/` | **serving** | processed files (WORM) + Delta tables | services / DuckDB |
| `data/backup/YYYYMMDD/` | **backup** | mirror of every file written to MinIO | disaster recovery |

`bod/` is the inbox; `backup/YYYYMMDD/` is the outbox mirror. They hold different
things — raw vs processed.

## Why dual-write

- **MinIO can be rebuilt from disk.** If the MinIO volume is wiped, replay
  `data/backup/YYYYMMDD/` back into `raw/` and rebuild `delta/`. Nothing lost.
- **One serving contract.** Services and queries hit MinIO's S3 API only; they
  don't know or care about disk layout.
- **Immutability lives in MinIO.** WORM/object-lock is enforced by the running
  MinIO. The disk backup is disaster recovery, not tamper-evidence — a file on
  disk can be edited; a WORM object in MinIO cannot.

## Reset / rehydrate

```bash
# wipe MinIO (buckets + lock state), keep the disk backup
cd docker && docker compose down -v && docker compose up -d
# replay the processed mirror back into MinIO (raw WORM + delta)
python src/ingest.py --replay data/backup
```

## Rules

- **Process from `bod/`, write to both sinks.** A processed file is never in only
  one place — MinIO and `backup/YYYYMMDD/` always get the same bytes.
- **Date is the partition key** post-processing: `raw/YYYYMMDD/` in MinIO,
  `backup/YYYYMMDD/` on disk, a date column in Delta. Keep the exchange's
  original filename inside the dated folder.
- **Backup payload stays local; only its `_ingest_manifest.json` is committed.**
  The backup folder is a binary DR mirror (raw csv/zip + bronze parquet) — too
  heavy for git. The per-day sha manifest is the committed audit record of what
  was ingested; the bytes live on disk + MinIO. `data/raw/` (cached scrape HTML,
  cached XBRL) stays local too.

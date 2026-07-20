# Storage architecture

Two tiers, one direction of flow. **Services never read the disk directly — they
read MinIO.** The disk is the durable, offline copy that MinIO is rehydrated from.

```
   ingest (manual drop / scrape)
            |
            v
   Disk  data/bod/YYYYMMDD/…        <- cold archive, source of record on physical
   (dated folders)                     disk. Offline, human-managed, durable belt.
            |
            |  src/ingest → push
            v
   MinIO                             <- the access layer. Everything services use.
     raw/    YYYYMMDD/… (WORM)          Warm + cold live here.
     delta/  tables (versioned)
            |
            v
   Services / DuckDB query MinIO only
```

## Roles

| Tier | What | Who writes | Who reads |
|---|---|---|---|
| **Disk `YYYYMMDD/`** | bhavcopies, daily reports, raw drops | you (manual) + ingest | ingest only |
| **MinIO `raw/`** | same files, WORM/versioned | ingest | services (audit/replay) |
| **MinIO `delta/`** | Delta tables built from raw | ingest | services / DuckDB |

## Why this split

- **Durability without depending on MinIO.** If the MinIO volume is wiped or
  reset, nothing is lost — replay the disk `YYYYMMDD/` folders back into `raw/`
  and rebuild `delta/`. The disk is the backstop.
- **One serving contract.** Services and queries hit MinIO's S3 API only, so
  they don't care where the physical files live or how they're archived. Disk
  layout can change without touching a service.
- **Immutability lives in MinIO.** WORM/object-lock is enforced by the running
  MinIO, not the disk. The disk copy is disaster-recovery, not tamper-evidence
  (a file on disk can be edited; a WORM object in MinIO cannot).

## Reset / rehydrate

```bash
# wipe MinIO (buckets + lock state), keep the disk archive
cd docker && docker compose down -v && docker compose up -d
# replay disk -> MinIO (raw WORM + delta) — see src/ingest
python src/ingest.py --from data/bod --all-dates
```

## Rule

Date is the partition key everywhere: `YYYYMMDD/` on disk, `raw/YYYYMMDD/` in
MinIO, a date column in Delta. Keep the exchange's original filename inside the
dated folder — it already encodes the date and the report type.

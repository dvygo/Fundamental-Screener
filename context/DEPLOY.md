# DEPLOY

How to stand the stack up, locally or on a box. Four moving parts: the storage
layer (MinIO), the Python ELT, the Node API, and the Next.js UI (submodule).

## Ports

| Service | Port | Notes |
|---|---|---|
| Node API | `3000` | `PORT` env overrides |
| Next.js UI | `3001` | fixed in `package.json` scripts |
| MinIO S3 API | `9000` | docker |
| MinIO console | `9001` | docker |

## Environment

| File | Keys | Notes |
|---|---|---|
| `src/nodejs/.env` | screener.in creds, `PORT` | **gitignored** — never commit |
| `src/nextjs/.env.local` | `NEXT_PUBLIC_API_BASE` | e.g. `http://localhost:3000/api`; per-machine |
| docker env / `.env` | `MINIO_ROOT_USER/PASSWORD`, `RAW_RETENTION_DAYS` | see `docker/docker-compose.yml` |

The Node API loads `src/nodejs/.env` natively (Node 24 `loadEnvFile`) and boots
fine without it — screener auth just stays disabled.

## Run order

```bash
# 0. fresh clone: hydrate the submodule
git submodule update --init src/nextjs

# 1. storage (optional, for the WORM audit layer)
cp docker/.env.example docker/.env    # set MINIO_ROOT_PASSWORD before first run
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
#    creates raw/  (object-locked, versioned; retention mode from docker/.env)
#            lake/ (versioned, NOT locked — DuckLake manages it)
python src/python/lake_sync.py        # publish the Parquet stores into lake/

# 2. ELT — two independent cadences, NOT one sequence (see CLAUDE.md)
source .venv/bin/activate

#  2a. daily — runs when a new BOD drop lands in data/raw/zip/
python src/python/extract.py           # decompress -> data/extracts/<YYYYMMDD>/
python src/python/ingest.py            # pull/stage daily bundles

#  2b. daily — news; a missed day is unrecoverable (LiveMint keeps ~a week)
python src/python/livemint_snapshot.py # sitemaps -> data/store/news.parquet

#  2c. on refresh only — driven by the index CSV in data/raw/, not by a drop.
#      Each reads one file spanning 2020->today, so a new daily neither
#      requires nor benefits from re-running these.
python src/python/insider_load.py      # NSE PIT XBRL → data/store/insider.parquet
python src/python/shareholding_load.py # shareholding index → shareholding.parquet

# 3. API
cd src/nodejs && npm install && node src/server.js      # :3000

# 4. UI (needs the API reachable at NEXT_PUBLIC_API_BASE)
cd src/nextjs && npm install
npm run dev            # dev, :3001
# production:
npm run build && npm run start                          # :3001
```

## Storage tiering

Services are meant to read **MinIO**, not disk; disk (`data/extracts`,
`data/store`) is the schema-on-read source of truth in v1. v2 flips the DuckDB
globs in `src/nodejs/src/db.js` to `s3://raw/`. The `raw/` bucket is created
**with object-lock (WORM)** so landed bhavcopies can't be overwritten or deleted
within the retention window — tamper-evidence for the audit trail. Full rationale
in [storage.md](storage.md).

## Data backup — Drive snapshots (rclone)

`src/python/data_sync.py` pushes the whole `data/` tree to the **Fundamental-Screener**
Google shared drive as **manual, append-only, compressed snapshots**: it tars+gzips
`data/` into one `data-YYYYMMDD_T_HHMMSS.tar.gz` and uploads that **single file**
(one big object, not thousands of tiny ones — Drive's per-file overhead makes the
file-by-file approach crawl). It never deletes — losing local files can't touch
earlier snapshots; disaster recovery is `pull` then `tar xzf`. Prune old archives
yourself.

```bash
brew install rclone                                # system prerequisite (Go binary; apt/curl on Linux)
# pigz optional — parallel gzip, used automatically if present for a faster tar
python src/python/data_sync.py config              # resolved config + data size (no secrets)
python src/python/data_sync.py drives              # auth test — lists the shared drive
python src/python/data_sync.py push --dry-run      # preview (builds/uploads nothing)
python src/python/data_sync.py push                # tar.gz data/ -> drive:data-<ts>.tar.gz
python src/python/data_sync.py archive             # build the tar.gz locally only
python src/python/data_sync.py ls                  # list snapshot archives (with sizes)
python src/python/data_sync.py pull data-<ts>.tar.gz --extract   # download + unpack
```

Auth is a Google **service-account** JSON key — a **secret**: gitignored
(`/fundamental-screener-*.json`) and copied to each server's root by hand, never
committed. Non-secret overrides go in a gitignored `.data-sync.env` (see
`setup/data_sync.env.example`). The archive is staged under `/.snapshots/`
(gitignored) and deleted after upload unless `--keep`.

## Production notes

- The API sends `Access-Control-Allow-Origin: *` for local dev; tighten this
  (or front both with one reverse proxy on a shared origin) before exposing it.
- The UI is a normal Next.js server (`npm run start`); it only needs
  `NEXT_PUBLIC_API_BASE` pointing at a reachable API. It can also be hosted from
  its own repo ([hunt-internal](https://github.com/dvygo/hunt-internal))
  independently of this monorepo.
- Keep `src/nodejs/.env` and all `data/raw/` off every image and commit.

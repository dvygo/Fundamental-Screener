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
docker compose -f docker/docker-compose.yml up -d
#    creates raw/ (object-locked, versioned, COMPLIANCE retention) + delta/

# 2. ELT — land + shred (examples; see src/python/)
source .venv/bin/activate
python src/python/ingest.py            # pull/stage daily bundles
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
Google shared drive as **manual, append-only, timestamped snapshots** (`rclone copy`
into `data-YYYYMMDD_T_HHMMSS`). It never deletes — losing local files can't touch
earlier snapshots; disaster recovery is downloading a snapshot by hand.

```bash
brew install rclone                                # system prerequisite (Go binary)
python src/python/data_sync.py config              # resolved config (no secrets)
python src/python/data_sync.py drives              # auth test — lists the shared drive
python src/python/data_sync.py push --dry-run      # preview (uploads nothing)
python src/python/data_sync.py push                # new snapshot: data/ -> drive:data-<ts>
python src/python/data_sync.py ls                  # list existing snapshots
python src/python/data_sync.py pull data-<ts>      # download a snapshot (additive)
```

Auth is a Google **service-account** JSON key — a **secret**: gitignored
(`/fundamental-screener-*.json`) and copied to each server's root by hand, never
committed. Non-secret overrides go in a gitignored `.data-sync.env` (see
`setup/data_sync.env.example`). Each push re-uploads the full ~data size (no
cross-snapshot dedup — that's the point: independent immutable copies).

## Production notes

- The API sends `Access-Control-Allow-Origin: *` for local dev; tighten this
  (or front both with one reverse proxy on a shared origin) before exposing it.
- The UI is a normal Next.js server (`npm run start`); it only needs
  `NEXT_PUBLIC_API_BASE` pointing at a reachable API. It can also be hosted from
  its own repo ([hunt-internal](https://github.com/dvygo/hunt-internal))
  independently of this monorepo.
- Keep `src/nodejs/.env` and all `data/raw/` off every image and commit.

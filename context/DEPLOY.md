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

## Production notes

- The API sends `Access-Control-Allow-Origin: *` for local dev; tighten this
  (or front both with one reverse proxy on a shared origin) before exposing it.
- The UI is a normal Next.js server (`npm run start`); it only needs
  `NEXT_PUBLIC_API_BASE` pointing at a reachable API. It can also be hosted from
  its own repo ([hunt-internal](https://github.com/dvygo/hunt-internal))
  independently of this monorepo.
- Keep `src/nodejs/.env` and all `data/raw/` off every image and commit.

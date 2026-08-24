#!/usr/bin/env python3
"""Publish the Parquet stores into DuckLake on MinIO.

    data/store/*.parquet
    data/extracts_us/_meta/*.parquet
        │
        ▼
    ducklake catalog (data/store/lake.ducklake)  +  s3://lake/fs/  (MinIO)

WHY THIS EXISTS
  The loaders already write immutable Parquet, so the data is reproducible. What
  they cannot answer is "what did this table say on the 14th" — each run
  overwrites the file and the previous state is gone. DuckLake gives every sync
  a snapshot, so a figure served to a client on a given day stays recoverable
  and provable. That is the governance claim context/storage.md wants to make.

TWO BUCKETS, DIFFERENT RULES (see docker/docker-compose.yml)
  raw/   object-locked. Source drops. Nothing here is ever rewritten.
  lake/  writable, and must stay that way. DuckLake rewrites and expires its
         own Parquet during compaction and snapshot expiry; object-locking this
         bucket would break cleanup and grow it without bound. Immutability
         here comes from snapshots, not from the storage layer.

FULL REPLACE, NOT APPEND
  Each table is rewritten wholesale per run. The source Parquets are themselves
  full rewrites (the loaders rebuild them), so appending would double rows. The
  snapshot is what preserves history, not accumulation inside the table.

Usage:
    python src/python/lake_sync.py                 # sync every known table
    python src/python/lake_sync.py --tables sec_facts finra_short_volume
    python src/python/lake_sync.py --list          # show what would sync
    python src/python/lake_sync.py --history sec_facts
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import duckdb

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("lake")

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "data" / "store"
US_META = ROOT / "data" / "extracts_us" / "_meta"
DOCKER_ENV = ROOT / "docker" / ".env"
CATALOG = STORE / "lake.ducklake"
DATA_PATH = "s3://lake/fs/"

# Directories scanned for *.parquet. A new loader's output is picked up without
# editing this file — the table name is the filename stem.
SOURCES = [STORE, US_META]

# Never publish these. lake.ducklake is the catalog itself; the dot-prefixed
# files are loader scratch that should not have survived a run.
SKIP_STEMS = {"lake"}


def load_env() -> dict[str, str]:
    if not DOCKER_ENV.is_file():
        raise SystemExit(
            f"no {DOCKER_ENV} — copy docker/.env.example to docker/.env first")
    env = {}
    for line in DOCKER_ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    for key in ("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"):
        if not env.get(key):
            raise SystemExit(f"{key} missing from {DOCKER_ENV}")
    return env


def discover() -> dict[str, Path]:
    """{table_name: parquet_path}. Filename stem is the table name."""
    found: dict[str, Path] = {}
    for d in SOURCES:
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.parquet")):
            # Loader scratch is dot-prefixed; it is not data.
            if p.name.startswith("."):
                continue
            if p.stem in SKIP_STEMS:
                continue
            if p.stem in found:
                log.warning("duplicate table name %s — keeping %s, skipping %s",
                            p.stem, found[p.stem], p)
                continue
            found[p.stem] = p
    return found


def connect(env: dict[str, str]) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for ext in ("ducklake", "httpfs"):
        con.execute(f"INSTALL {ext}")
        con.execute(f"LOAD {ext}")
    # Credentials are bound, never interpolated into the SQL text, so they do
    # not end up in a query log or an error message.
    con.execute("""CREATE OR REPLACE SECRET minio (
        TYPE s3, KEY_ID ?, SECRET ?,
        ENDPOINT 'localhost:9000', URL_STYLE 'path', USE_SSL false)""",
        [env["MINIO_ROOT_USER"], env["MINIO_ROOT_PASSWORD"]])
    con.execute(f"ATTACH 'ducklake:{CATALOG.as_posix()}' AS lake (DATA_PATH '{DATA_PATH}')")
    return con


def main() -> None:
    p = argparse.ArgumentParser(description="publish Parquet stores into DuckLake")
    p.add_argument("--tables", nargs="*", help="only these tables; default is all")
    p.add_argument("--list", action="store_true", help="show what would sync, then exit")
    p.add_argument("--history", metavar="TABLE", help="show snapshot history and exit")
    a = p.parse_args()

    found = discover()
    if a.list:
        for name, path in found.items():
            log.info("%-28s %8.1f MiB  %s", name, path.stat().st_size / 1048576, path)
        return

    env = load_env()
    con = connect(env)

    if a.history:
        # Every sync leaves a snapshot; this is the point of the exercise.
        df = con.execute("SELECT snapshot_id, snapshot_time, changes FROM lake.snapshots() "
                         "ORDER BY snapshot_id DESC LIMIT 25").df()
        print(df.to_string(index=False))
        con.close()
        return

    wanted = a.tables or list(found)
    missing = [t for t in wanted if t not in found]
    if missing:
        raise SystemExit(f"no parquet found for: {', '.join(missing)}")

    t0 = time.time()
    done = failed = 0
    for name in wanted:
        path = found[name]
        try:
            t1 = time.time()
            # Full replace — see the module docstring on why this is not append.
            con.execute(f"CREATE OR REPLACE TABLE lake.{name} AS "
                        f"SELECT * FROM read_parquet('{path.as_posix()}')")
            n = con.execute(f"SELECT count(*) FROM lake.{name}").fetchone()[0]
            log.info("%-28s %12d rows  %5.0fs", name, n, time.time() - t1)
            done += 1
        except Exception as e:
            failed += 1
            log.warning("FAILED %s: %s", name, e)

    snap = con.execute("SELECT max(snapshot_id) FROM lake.snapshots()").fetchone()[0]
    log.info("synced %d tables (%d failed) in %.0fs — snapshot %s",
             done, failed, time.time() - t0, snap)
    con.close()


if __name__ == "__main__":
    main()

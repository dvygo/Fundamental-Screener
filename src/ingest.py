"""Push one day's raw NSE drop into the storage layer — LOSSLESS (ELT).

    data/raw/bod/<YYYYMMDD>/   (raw manual drops, whole files)
        ├──►  MinIO  raw/<YYYYMMDD>/...   (serving truth, WORM/object-lock)
        └──►  data/backup/<YYYYMMDD>/...  (disk mirror, disaster recovery)

Nothing is parsed or stripped here. Files land verbatim — every column, every
byte — so the query layer (DuckDB over MinIO) transforms at read time. This is
the "Extract-Load" of ELT; the "Transform" is SQL, later.

Idempotent: a key already in MinIO is skipped (don't fight WORM on re-runs).
Every file is hashed (sha256); the manifest is the integrity record and the
future dedupe key.

Env (or docker/.env):
    MINIO_ENDPOINT       default localhost:9000
    MINIO_ROOT_USER      default minioadmin
    MINIO_ROOT_PASSWORD  default minioadmin
    MINIO_SECURE         default false (http)

Usage:
    python src/ingest.py 20260717
    python src/ingest.py 20260717 --dry-run
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from minio import Minio
from minio.error import S3Error

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("ingest")

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "bod"
BACKUP = ROOT / "data" / "backup"
RAW_BUCKET = "raw"


def _load_dotenv(path: Path):
    """Minimal KEY=VALUE loader (no external dep). Does not override real env."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def _client() -> Minio:
    _load_dotenv(ROOT / "docker" / ".env")
    endpoint = os.environ.get("MINIO_ENDPOINT", "localhost:9000")
    secure = os.environ.get("MINIO_SECURE", "false").lower() == "true"
    return Minio(
        endpoint,
        access_key=os.environ.get("MINIO_ROOT_USER", "minioadmin"),
        secret_key=os.environ.get("MINIO_ROOT_PASSWORD", "minioadmin"),
        secure=secure,
    )


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _files(folder: Path):
    """Every file under the day's folder, relative paths preserved."""
    for p in sorted(folder.rglob("*")):
        if p.is_file():
            yield p, p.relative_to(folder).as_posix()


def _exists(client: Minio, bucket: str, key: str) -> bool:
    try:
        client.stat_object(bucket, key)
        return True
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchObject"):
            return False
        raise


def run(date: str, dry_run: bool):
    folder = RAW / date
    if not folder.is_dir():
        raise SystemExit(f"no raw folder: {folder}")

    client = _client()
    # fail loud if MinIO / bucket is not reachable
    try:
        if not client.bucket_exists(RAW_BUCKET):
            raise SystemExit(
                f"bucket '{RAW_BUCKET}' missing — run `docker compose up -d` first"
            )
    except Exception as e:
        raise SystemExit(f"MinIO unreachable: {e}")

    backup_dir = BACKUP / date
    backup_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "date": date,
        "ingested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_folder": str(folder),
        "bucket": RAW_BUCKET,
        "files": {},
    }
    uploaded = skipped = mirrored = 0

    for path, rel in _files(folder):
        if rel.startswith("_ingest_manifest"):
            continue
        key = f"{date}/{rel}"
        digest = _sha256(path)
        size = path.stat().st_size
        manifest["files"][rel] = {"sha256": digest, "size": size, "key": key}

        # 1) MinIO raw/ (WORM) — skip if key already present
        if dry_run:
            log.info("[dry] would upload  %s  (%d B)", key, size)
        elif _exists(client, RAW_BUCKET, key):
            log.info("skip (exists)     %s", key)
            skipped += 1
        else:
            client.fput_object(RAW_BUCKET, key, str(path))
            log.info("uploaded          %s  (%d B)", key, size)
            uploaded += 1

        # 2) disk backup mirror — byte-for-byte copy
        dst = backup_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dry_run:
            pass
        elif dst.exists() and _sha256(dst) == digest:
            pass  # already mirrored, identical
        else:
            shutil.copy2(path, dst)
            mirrored += 1

    # manifest to both sinks (integrity + dedupe key)
    mtext = json.dumps(manifest, indent=2)
    if not dry_run:
        (backup_dir / "_ingest_manifest.json").write_text(mtext, encoding="utf-8")
        mkey = f"{date}/_ingest_manifest.json"
        if not _exists(client, RAW_BUCKET, mkey):
            import io

            data = mtext.encode()
            client.put_object(RAW_BUCKET, mkey, io.BytesIO(data), len(data),
                              content_type="application/json")

    log.info(
        "done %s: %d uploaded, %d skipped, %d mirrored, %d files total%s",
        date, uploaded, skipped, mirrored, len(manifest["files"]),
        " (dry-run)" if dry_run else "",
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Push a day's raw drop to MinIO + backup")
    ap.add_argument("date", help="folder under data/raw/bod, e.g. 20260717")
    ap.add_argument("--dry-run", action="store_true", help="hash + plan, no writes")
    args = ap.parse_args()
    run(args.date, args.dry_run)

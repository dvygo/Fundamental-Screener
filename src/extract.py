"""Process UNO — decompress a day's raw drop into the working root.

    data/raw/bod/<YYYYMMDD>/     (pristine downloads; some are .zip / .gz)
        │  copy every plain file  +  unpack every archive (flat)
        ▼
    data/extracts/<YYYYMMDD>/    (flat, fully decompressed WORKING ROOT)

This is the first step of the pipeline. Everything after it — MinIO ingest,
DuckDB screens, XBRL populate — reads from data/extracts, never from the raw
drop. The raw drop stays pristine on disk as the untouched original.

What it does per file under the date folder:
  *.zip   -> extract all members, flat, into extracts/<date>/
  *.gz    -> decompress to extracts/<date>/<name-without-.gz>   (not .tar.gz)
  other   -> copy verbatim into extracts/<date>/

The archives themselves are NOT re-copied — their contents already land, so the
working root has no redundant .zip/.gz to confuse downstream globbing.

Content-aware placement (idempotent): every write is compared by sha256 against
whatever's already at that name. Identical content -> skipped, no write.
Different content under the same name -> overwritten (logged). Re-running
extract.py on an already-extracted date is therefore a safe no-op, not a pile
of `__dup` files.

Usage:
    python src/extract.py 20260717
    python src/extract.py 20260717 --keep-archives   # also copy the .zip/.gz
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import logging
import zipfile
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("extract")

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "bod"
EXTRACTS = ROOT / "data" / "extracts"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def place(out_dir: Path, name: str, data: bytes) -> str:
    """Write `data` as `name` in out_dir, content-aware, single read/write.

    Returns 'written' (new file), 'replaced' (existing had different content),
    or 'skip' (existing already has this exact content).
    """
    dst = out_dir / name
    if dst.exists():
        if _sha256(dst.read_bytes()) == _sha256(data):
            return "skip"
        dst.write_bytes(data)
        log.warning("replaced (content changed): %s", name)
        return "replaced"
    dst.write_bytes(data)
    return "written"


def run(date: str, keep_archives: bool):
    src = RAW / date
    if not src.is_dir():
        raise SystemExit(f"no raw folder: {src}")
    out = EXTRACTS / date
    out.mkdir(parents=True, exist_ok=True)

    copied = unzipped = gunzipped = skipped = replaced = 0
    for path in sorted(src.rglob("*")):
        if not path.is_file():
            continue
        low = path.name.lower()

        if low.endswith(".zip"):
            with zipfile.ZipFile(path) as z:
                for m in z.infolist():
                    if m.is_dir():
                        continue
                    inner = Path(m.filename).name  # flatten any nesting
                    status = place(out, inner, z.read(m))
                    if status == "written":
                        unzipped += 1
                    elif status == "skip":
                        skipped += 1
                    else:
                        replaced += 1
            log.info("unzip   %-42s -> %d members", path.name, len(z.infolist()))
            if keep_archives:
                status = place(out, path.name, path.read_bytes())
                copied += status == "written"

        elif low.endswith(".gz") and not low.endswith(".tar.gz"):
            inner = path.name[:-3]  # strip .gz
            with gzip.open(path, "rb") as fh:
                data = fh.read()
            status = place(out, inner, data)
            if status == "written":
                gunzipped += 1
                log.info("gunzip  %-42s -> %s", path.name, inner)
            elif status == "skip":
                skipped += 1
            else:
                replaced += 1
            if keep_archives:
                status = place(out, path.name, path.read_bytes())
                copied += status == "written"

        else:
            status = place(out, path.name, path.read_bytes())
            if status == "written":
                copied += 1
            elif status == "skip":
                skipped += 1
            else:
                replaced += 1

    total = len(list(out.iterdir()))
    log.info("done %s: copied %d, unzipped %d, gunzipped %d, skipped(unchanged) %d, "
             "replaced(content changed) %d -> %d files in %s",
             date, copied, unzipped, gunzipped, skipped, replaced, total, out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Process UNO: decompress raw drop -> data/extracts")
    ap.add_argument("date", help="folder under data/raw/bod, e.g. 20260717")
    ap.add_argument("--keep-archives", action="store_true",
                    help="also copy the original .zip/.gz alongside their contents")
    args = ap.parse_args()
    run(args.date, args.keep_archives)

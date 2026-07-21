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

Usage:
    python src/extract.py 20260717
    python src/extract.py 20260717 --keep-archives   # also copy the .zip/.gz
"""

from __future__ import annotations

import argparse
import gzip
import logging
import shutil
import zipfile
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("extract")

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "bod"
EXTRACTS = ROOT / "data" / "extracts"


def _dst(out_dir: Path, name: str) -> Path:
    """Target path; warn + suffix on name collision so nothing is silently lost."""
    dst = out_dir / name
    if dst.exists():
        stem, dot, ext = name.partition(".")
        i = 1
        while dst.exists():
            dst = out_dir / f"{stem}__dup{i}{dot}{ext}"
            i += 1
        log.warning("name collision: %s -> %s", name, dst.name)
    return dst


def run(date: str, keep_archives: bool):
    src = RAW / date
    if not src.is_dir():
        raise SystemExit(f"no raw folder: {src}")
    out = EXTRACTS / date
    out.mkdir(parents=True, exist_ok=True)

    copied = unzipped = gunzipped = 0
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
                    with z.open(m) as fh, open(_dst(out, inner), "wb") as w:
                        shutil.copyfileobj(fh, w)
                    unzipped += 1
            log.info("unzip   %-42s -> %d files", path.name, len(z.infolist()))
            if keep_archives:
                shutil.copy2(path, _dst(out, path.name))
                copied += 1

        elif low.endswith(".gz") and not low.endswith(".tar.gz"):
            inner = path.name[:-3]  # strip .gz
            with gzip.open(path, "rb") as fh, open(_dst(out, inner), "wb") as w:
                shutil.copyfileobj(fh, w)
            gunzipped += 1
            log.info("gunzip  %-42s -> %s", path.name, inner)
            if keep_archives:
                shutil.copy2(path, _dst(out, path.name))
                copied += 1

        else:
            shutil.copy2(path, _dst(out, path.name))
            copied += 1

    total = len(list(out.iterdir()))
    log.info("done %s: copied %d, unzipped %d, gunzipped %d -> %d files in %s",
             date, copied, unzipped, gunzipped, total, out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Process UNO: decompress raw drop -> data/extracts")
    ap.add_argument("date", help="folder under data/raw/bod, e.g. 20260717")
    ap.add_argument("--keep-archives", action="store_true",
                    help="also copy the original .zip/.gz alongside their contents")
    args = ap.parse_args()
    run(args.date, args.keep_archives)

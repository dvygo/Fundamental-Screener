"""Process UNO — decompress the raw drop into the working root.

    data/raw/zip/<file-with-date-in-name>.zip   (pristine downloads)
        │  parse date from filename, recursively unpack every archive
        │  (including archives nested inside archives)
        ▼
    data/extracts/<YYYYMMDD>/    (flat, fully decompressed WORKING ROOT)

This is the first step of the pipeline. Everything after it — MinIO ingest,
DuckDB screens, XBRL populate — reads from data/extracts, never from the raw
drop. The raw drop stays pristine on disk as the untouched original.

Raw drops land flat in data/raw/zip/ (no per-date subfolder) — the date lives
only in the filename, e.g. `Reports-Archives-Multiple-24072026.zip` (DDMMYYYY).
Each top-level file's destination date is parsed from the first run of 8
digits in its name.

What it does per top-level file, recursively:
  *.zip   -> extract every member, flat, into extracts/<date>/
             (a member that is itself .zip/.gz is unpacked in turn)
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
    python src/python/extract.py                # process every file in data/raw/zip/
    python src/python/extract.py 20260724        # only the file(s) dated 24 Jul 2026
    python src/python/extract.py --keep-archives # also copy the top-level .zip/.gz
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import logging
import re
import zipfile
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("extract")

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "zip"
EXTRACTS = ROOT / "data" / "extracts"

DATE_RE = re.compile(r"(\d{2})(\d{2})(\d{4})")  # DDMMYYYY, first match in the filename


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


def parse_date(name: str) -> str | None:
    """DDMMYYYY -> YYYYMMDD from the first 8-digit run in a filename, else None."""
    m = DATE_RE.search(name)
    if not m:
        return None
    dd, mm, yyyy = m.groups()
    return f"{yyyy}{mm}{dd}"


def unpack(name: str, data: bytes, out: Path, counts: dict, keep_archives: bool):
    """Place `data` (named `name`) into `out`, recursing into nested zip/gz."""
    low = name.lower()

    if low.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for m in z.infolist():
                if m.is_dir():
                    continue
                inner = Path(m.filename).name  # flatten any nesting
                unpack(inner, z.read(m), out, counts, keep_archives)
        counts["archives"] += 1
        log.info("unzip   %-42s -> %d members", name, len(z.infolist()))
        if keep_archives:
            status = place(out, name, data)
            counts[status] += 1

    elif low.endswith(".gz") and not low.endswith(".tar.gz"):
        inner = name[:-3]  # strip .gz
        inner_data = gzip.decompress(data)
        unpack(inner, inner_data, out, counts, keep_archives)
        counts["archives"] += 1
        if keep_archives:
            status = place(out, name, data)
            counts[status] += 1

    else:
        status = place(out, name, data)
        counts[status] += 1


def run(date: str | None, keep_archives: bool):
    if not RAW.is_dir():
        raise SystemExit(f"no raw folder: {RAW}")

    # macOS drops an AppleDouble twin (._<name>) beside every file it backs up,
    # and a ._x.zip carries the real name's date and .zip suffix — so it would be
    # dated, then handed to ZipFile, and blow up the whole run on BadZipFile.
    # They reappear after every backup, so skip them here rather than by hand.
    files = sorted(p for p in RAW.rglob("*")
                   if p.is_file() and not p.name.startswith("._") and p.name != ".DS_Store")
    if not files:
        raise SystemExit(f"no files in {RAW}")
    junk = sum(1 for p in RAW.rglob("*")
               if p.is_file() and (p.name.startswith("._") or p.name == ".DS_Store"))
    if junk:
        log.info("ignored %d macOS sidecar file(s) in %s", junk, RAW)

    by_date: dict[str, list[Path]] = {}
    for path in files:
        d = parse_date(path.name)
        if not d:
            log.warning("skip (no date in filename): %s", path.name)
            continue
        if date and d != date:
            continue
        by_date.setdefault(d, []).append(path)

    if date and not by_date:
        raise SystemExit(f"no raw files dated {date} in {RAW}")

    for d, paths in sorted(by_date.items()):
        out = EXTRACTS / d
        out.mkdir(parents=True, exist_ok=True)
        counts = {"written": 0, "replaced": 0, "skip": 0, "archives": 0}
        for path in paths:
            unpack(path.name, path.read_bytes(), out, counts, keep_archives)
        total = len(list(out.iterdir()))
        log.info("done %s: written %d, replaced %d, skipped(unchanged) %d, "
                  "archives unpacked %d -> %d files in %s",
                  d, counts["written"], counts["replaced"], counts["skip"],
                  counts["archives"], total, out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Process UNO: decompress raw drop -> data/extracts")
    ap.add_argument("date", nargs="?", default=None,
                     help="only process files dated YYYYMMDD (default: all files in data/raw/zip)")
    ap.add_argument("--keep-archives", action="store_true",
                    help="also copy the original .zip/.gz alongside their contents")
    args = ap.parse_args()
    run(args.date, args.keep_archives)

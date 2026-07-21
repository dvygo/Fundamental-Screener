"""Sweep NSE bulk-download zips out of your Downloads folder into the raw drop.

With "ask before downloading" on, `nse_report_links.py --auto-download` still
needs one Save-dialog click per file — it can't be scripted away (that's a
native OS dialog). This picks up from there: after you've saved a batch of
`Reports-Archives-Multiple-DDMMYYYY*.zip` files (Chrome appends " (1)", " (2)"
etc. on repeat saves), this unzips each one flat into
`data/raw/bod/<YYYYMMDD>/` — content-aware (via extract.py's `place()`), so
duplicate re-saves of the same date collapse for free instead of piling up.

    ~/Downloads/Reports-Archives-Multiple-20072026.zip
    ~/Downloads/Reports-Archives-Multiple-20072026 (1).zip   <- same content
    ~/Downloads/Reports-Archives-Multiple-20072026 (2).zip   <- same content
        │  unzip each, content-aware place()
        ▼
    data/raw/bod/20260720/    (deduped — one copy of each file)

Usage:
    python src/collect_downloads.py                      # scan ~/Downloads
    python src/collect_downloads.py --dir "D:/dl"         # scan elsewhere
    python src/collect_downloads.py --move-to data/_archived_zips  # relocate zips after
"""

from __future__ import annotations

import argparse
import logging
import re
import shutil
import zipfile
from pathlib import Path

from extract import place  # reuse the same content-aware writer as process UNO

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("collect_downloads")

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "bod"
DEFAULT_DOWNLOADS = Path.home() / "Downloads"

# "Reports-Archives-Multiple-20072026.zip" or "...20072026 (1).zip" -> DDMMYYYY
NAME_RE = re.compile(r"Reports-(?:Archives|Daily)-Multiple-(\d{8})(?:\s*\(\d+\))?\.zip$", re.I)


def _to_yyyymmdd(ddmmyyyy: str) -> str:
    dd, mm, yyyy = ddmmyyyy[:2], ddmmyyyy[2:4], ddmmyyyy[4:]
    return f"{yyyy}{mm}{dd}"


def find_zips(folder: Path):
    """-> [(date_yyyymmdd, path), ...], grouped so same-date dupes are adjacent."""
    found = []
    for p in folder.glob("Reports-*Multiple*.zip"):
        m = NAME_RE.search(p.name)
        if not m:
            log.warning("skip (unrecognized name): %s", p.name)
            continue
        found.append((_to_yyyymmdd(m.group(1)), p))
    return sorted(found)


def run(folder: Path, move_to: Path | None):
    zips = find_zips(folder)
    if not zips:
        log.info("no Reports-*-Multiple-*.zip found in %s", folder)
        return

    by_date: dict[str, list[Path]] = {}
    for ymd, p in zips:
        by_date.setdefault(ymd, []).append(p)

    written = skipped = replaced = 0
    for ymd, paths in by_date.items():
        out_dir = RAW / ymd
        out_dir.mkdir(parents=True, exist_ok=True)
        log.info("=== %s (%d zip%s) -> %s ===", ymd, len(paths),
                 "" if len(paths) == 1 else "s", out_dir)
        for zpath in paths:
            with zipfile.ZipFile(zpath) as z:
                for m in z.infolist():
                    if m.is_dir():
                        continue
                    status = place(out_dir, Path(m.filename).name, z.read(m))
                    if status == "written":
                        written += 1
                    elif status == "skip":
                        skipped += 1
                    else:
                        replaced += 1
            if move_to:
                move_to.mkdir(parents=True, exist_ok=True)
                dest = move_to / zpath.name
                shutil.move(str(zpath), dest)
                log.info("moved %s -> %s", zpath.name, move_to)

    log.info("done: %d dates, %d files written, %d skipped(dup), %d replaced",
             len(by_date), written, skipped, replaced)
    log.info("next: python src/extract.py <date>  for each date above")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Sweep NSE Reports-*-Multiple-*.zip from Downloads into data/raw/bod/<date>/")
    ap.add_argument("--dir", type=Path, default=DEFAULT_DOWNLOADS,
                    help=f"folder to scan (default: {DEFAULT_DOWNLOADS})")
    ap.add_argument("--move-to", type=Path, default=None,
                    help="move processed zips here instead of leaving them in place")
    args = ap.parse_args()
    run(args.dir, args.move_to)

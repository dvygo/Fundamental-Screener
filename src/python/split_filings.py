"""Split a multi-day filings CSV into per-day files under data/extracts/.

NSE's "Download (.csv)" on the filing pages returns every filing in the chosen
date RANGE in one file — rows aren't day-granular. This splits each row by its
own broadcast/dissemination date and appends it into the right day's folder:

    data/raw/<anywhere>/CF-Insider-Trading-....csv   (spans many days)
        │  split by real per-row date
        ▼
    data/extracts/<YYYYMMDD>/CF-Insider-Trading-<YYYYMMDD>.csv   (one day each)
    data/extracts/<YYYYMMDD+1>/CF-Insider-Trading-<YYYYMMDD+1>.csv
    ...

Append-safe: if a day's file already exists (from a prior split or the old
whole-month dump), new rows are merged in and duplicates are dropped. Dedupe
key is the filing's XBRL/ACTION url column (unique per filing); rows without
one fall back to a hash of the full row.

A day folder that gets only filings (no bhavcopy yet) is fine — filings are
weekly, bhavcopy is daily; they don't have to arrive together.

Usage:
    python src/split_filings.py data/raw/year-to-year/CF-Insider-Trading-*.csv
    python src/split_filings.py data/raw/year-to-year          # every CF-*.csv in a folder
"""

from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("split_filings")

ROOT = Path(__file__).resolve().parents[2]
EXTRACTS = ROOT / "data" / "extracts"

# (filename match, date-column fragment, output stem)
SPECS = [
    (r"insider-trading", "BROADCAST", "CF-Insider-Trading"),
    (r"shareholding-pattern", "BROADCAST", "CF-Shareholding-Pattern"),
    (r"cf-fr|financial-results", "Exchange Received", "CF-FR"),
]

_MONTHS = {m: i for i, m in enumerate(
    "jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}


def _to_yyyymmdd(raw: str) -> str | None:
    """'20-Jul-2026 16:33:41' / '01-JUL-2026' -> '20260720'."""
    s = raw.strip()[:11].strip()
    parts = s.replace("-", " ").split()
    if len(parts) != 3:
        return None
    d, mon, y = parts
    m = _MONTHS.get(mon.lower()[:3])
    if not m or not d.isdigit() or not y.isdigit():
        return None
    return f"{y}{m:02d}{int(d):02d}"


def _spec_for(name: str):
    import re
    low = name.lower()
    for pat, date_frag, stem in SPECS:
        if re.search(pat, low):
            return date_frag, stem
    return None


def _read(path: Path):
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
        return list(csv.reader(fh))


def _row_key(hdr, row):
    for i, h in enumerate(hdr):
        if "xbrl" in h.lower() or h.strip().upper() == "ACTION":
            v = row[i].strip() if i < len(row) else ""
            if v and v not in ("-", "NA"):
                return v
    return hashlib.sha1("|".join(row).encode()).hexdigest()


def split_file(path: Path):
    spec = _spec_for(path.name)
    if not spec:
        log.warning("skip (unrecognized filing type): %s", path.name)
        return 0, 0
    date_frag, stem = spec
    rows = _read(path)
    if not rows:
        return 0, 0
    hdr = [h.strip() for h in rows[0]]
    di = next((i for i, h in enumerate(hdr) if date_frag.lower() in h.lower()), None)
    if di is None:
        log.warning("skip (no '%s' column): %s", date_frag, path.name)
        return 0, 0

    by_date: dict[str, list[list[str]]] = {}
    skipped = 0
    for r in rows[1:]:
        if len(r) <= di:
            skipped += 1
            continue
        ymd = _to_yyyymmdd(r[di])
        if not ymd:
            skipped += 1
            continue
        by_date.setdefault(ymd, []).append(r)

    written = 0
    for ymd, day_rows in sorted(by_date.items()):
        out_dir = EXTRACTS / ymd
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{stem}-{ymd}.csv"

        existing_keys = set()
        existing_rows = []
        if out_path.is_file():
            old = _read(out_path)
            if old:
                existing_rows = old[1:]
                existing_keys = {_row_key(hdr, r) for r in existing_rows}

        new_rows = [r for r in day_rows if _row_key(hdr, r) not in existing_keys]
        if not new_rows and existing_rows:
            continue  # nothing new for this day

        with open(out_path, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(hdr)
            w.writerows(existing_rows + new_rows)
        written += len(new_rows)
        log.info("%s  +%-4d rows  (total %d)  <- %s",
                 out_path.relative_to(EXTRACTS), len(new_rows),
                 len(existing_rows) + len(new_rows), path.name)

    return written, skipped


def run(paths: list[str]):
    files: list[Path] = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            files += sorted(p.glob("CF-*.csv"))
        else:
            files += [Path(x) for x in sorted(glob.glob(str(p)))]
    if not files:
        raise SystemExit("no CF-*.csv files matched")

    total_written = total_skipped = 0
    dates_touched = set()
    for f in files:
        log.info("=== %s ===", f.name)
        w, s = split_file(f)
        total_written += w
        total_skipped += s
    log.info("done: %d files, %d rows written, %d rows skipped (unparseable date)",
             len(files), total_written, total_skipped)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Split multi-day CF-*.csv into data/extracts/<date>/")
    ap.add_argument("paths", nargs="+", help="CF-*.csv file(s), glob(s), or a folder")
    args = ap.parse_args()
    run(args.paths)

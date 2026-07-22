"""Derive fincode + fund_manager lookup indexes from landed rupeevest data.

Two lookups, both derived (rebuildable from data/raw/rupeevest/, never truth):

  fincode_index        — one row per stock: fincode, compname, s_name,
                          bse_code, nse_symbol. Parsed straight from the
                          `stock_search` field in the master search dump.

  fund_manager_index    — one row per fund_manager_code: canonical name
                          (fund_mgr1, most-common spelling wins if it ever
                          drifts), distinct fund_houses managed, distinct
                          schemecodes managed, distinct fincodes (stocks)
                          touched. Built by scanning every cached
                          data/raw/rupeevest/stock_detail/<fincode>.json —
                          fund_manager_code is the real join key (stable
                          per person across schemes/AMCs), fund_mgr1 is
                          just its display name.

Run whenever new stock_detail files land (safe to re-run anytime, doesn't
need the full 1,746-stock pull to be complete — builds from whatever is
cached so far).

Usage:
    python src/build_rupeevest_index.py
"""

from __future__ import annotations

import csv
import json
import logging
from collections import Counter, defaultdict
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("build_rupeevest_index")

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw" / "rupeevest"
DETAIL_DIR = RAW_DIR / "stock_detail"
OUT_DIR = ROOT / "data" / "extracts" / "rupeevest"


def _latest(pattern: str) -> Path:
    candidates = sorted(RAW_DIR.glob(pattern))
    if not candidates:
        raise SystemExit(f"no {pattern} found under {RAW_DIR}")
    return candidates[-1]


def build_fincode_index() -> list[dict]:
    search_path = _latest("search_*.json")
    rows = json.loads(search_path.read_text(encoding="utf-8"))
    out = []
    for r in rows:
        parts = [p.strip() for p in r.get("stock_search", "").split("|")]
        bse_code = parts[1] if len(parts) == 3 else ""
        nse_symbol = parts[2] if len(parts) == 3 else ""
        out.append({
            "fincode": r["fincode"],
            "compname": r["compname"],
            "s_name": r.get("s_name", ""),
            "bse_code": bse_code,
            "nse_symbol": nse_symbol,
        })
    log.info("fincode_index: %d rows (from %s)", len(out), search_path.name)
    return out


def build_fund_manager_index() -> list[dict]:
    files = sorted(DETAIL_DIR.glob("*.json"))
    if not files:
        log.warning("no stock_detail files cached yet — run "
                     "src/rupeevest_stock_detail.py first")
        return []

    names = defaultdict(Counter)       # code -> Counter(name -> count)
    fund_houses = defaultdict(set)     # code -> {fund_house, ...}
    schemecodes = defaultdict(set)     # code -> {schemecode, ...}
    fincodes = defaultdict(set)        # code -> {fincode, ...}

    for fp in files:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning("skip %s: %s", fp.name, e)
            continue
        for row in data.get("stock_data", []):
            code = row.get("fund_manager_code")
            if code is None:
                continue
            names[code][row.get("fund_mgr1", "")] += 1
            if row.get("fund_house"):
                fund_houses[code].add(row["fund_house"])
            if row.get("schemecode") is not None:
                schemecodes[code].add(row["schemecode"])
            if row.get("fincode") is not None:
                fincodes[code].add(row["fincode"])

    out = []
    for code in sorted(names):
        canonical_name = names[code].most_common(1)[0][0]
        out.append({
            "fund_manager_code": code,
            "fund_mgr1": canonical_name,
            "fund_houses": "; ".join(sorted(fund_houses[code])),
            "n_schemes": len(schemecodes[code]),
            "n_stocks": len(fincodes[code]),
        })
    log.info("fund_manager_index: %d distinct managers (from %d cached files)",
              len(out), len(files))
    return out


def _write_csv(rows: list[dict], path: Path):
    if not rows:
        log.warning("nothing to write for %s", path.name)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    log.info("wrote %s (%d rows)", path, len(rows))


def main():
    _write_csv(build_fincode_index(), OUT_DIR / "fincode_index.csv")
    _write_csv(build_fund_manager_index(), OUT_DIR / "fund_manager_index.csv")


if __name__ == "__main__":
    main()

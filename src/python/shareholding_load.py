"""Shareholding-pattern loader — NSE's filing INDEX CSV -> one consolidated Parquet.

Unlike the XBRL populator (which shreds each filing's XML for the full category
breakdown), this reads the promoter/public percentages that NSE already puts
*inline* in the "Shareholding Pattern" filing index it lets you download:

    data/raw/CF-Shareholding-Pattern-equities-<range>.csv   (COMPANY, PROMOTER
        │   & PROMOTER GROUP (A), PUBLIC (B), EMPLOYEE TRUSTS (C2), AS ON DATE, …)
        ▼
    data/store/shareholding.parquet   (symbol, company, as_on_date, promoter_pct,
                                        public_pct, employee_trust_pct, …)

Why this exists: the per-day XBRL parquets only cover the handful of days the
populator has run against, so a big name (RELIANCE) that filed on some *other*
day was simply absent. This index CSV spans 2020-01-01 → today in one file, so
promoter holding is available for every company across every quarter it filed —
no per-day gaps, one file to query.

The index keys on COMPANY NAME, not ticker. We attach the NSE symbol by matching
a normalised name against the security master (exact first, then a length-guarded
unique-prefix pass to survive the master's truncated names — "TATA CONSULTANCY
SERV LT" vs "Tata Consultancy Services Limited"). Rows that resolve to no symbol
are still stored (symbol NULL); they just don't surface in the symbol-keyed API.

Store is a single file on purpose (the permanent shape — day partitioning was
wrong for quarterly filing data). Rebuilds in seconds, no network. Re-run after
the security master refreshes so newly-listed symbols resolve.

Usage:
    python src/python/shareholding_load.py
"""

from __future__ import annotations

import csv
import glob
import logging
import re
from datetime import date, datetime
from pathlib import Path

import duckdb

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("shareholding_load")

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
EXTRACTS = ROOT / "data" / "extracts"
STORE = ROOT / "data" / "store"

INDEX_GLOB = "CF-Shareholding-Pattern-equities-*.csv"
OUT = STORE / "shareholding.parquet"

# suffixes/abbreviations the master and the full legal name disagree on
_SUFFIX = re.compile(r"\b(LIMITED|LIMTED|LTD|LIM|LT|PRIVATE|PVT|CORPORATION|CORP)\b")
_ALNUM = re.compile(r"[^A-Z0-9]")


def norm(name: str) -> str:
    """Company name -> comparable key: upper, drop parentheticals, & -> AND,
    strip company suffixes, keep alphanumerics only."""
    s = (name or "").upper()
    s = re.sub(r"\(.*?\)", " ", s)
    s = s.replace("&", " AND ")
    s = _SUFFIX.sub(" ", s)
    return _ALNUM.sub("", s)


def _parse_date(s: str):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.split()[0], fmt).date()
        except ValueError:
            continue
    return None


def _to_float(s: str):
    s = (s or "").strip()
    if not s or s == "-":
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


# ------------------------------------------------------- symbol bridge
def build_symbol_bridge() -> dict[str, str]:
    """norm(company name) -> TckrSymb, from two sources:

      1. the latest security master (covers every listed symbol, but its names
         are truncated — "TATA CONSULTANCY SERV LT"; EQ wins ties);
      2. the insider index CSVs, which carry the ticker SYMBOL beside the *full*
         legal name ("Advait Energy Transitions Limited") — these fill gaps the
         master's truncated/misspelled names miss, without overwriting it.
    """
    bridge: dict[str, str] = {}
    prefer_eq: dict[str, bool] = {}

    masters = sorted(glob.glob(str(EXTRACTS / "*" / "NSE_CM_security_*.csv")))
    if masters:
        with open(masters[-1], encoding="utf-8-sig", newline="") as fh:
            r = csv.reader(fh)
            next(r, None)
            for row in r:
                if len(row) < 4:
                    continue
                sym, series, name = row[1].strip(), row[2].strip(), row[3].strip()
                key = norm(name)
                if not key or not sym:
                    continue
                is_eq = series == "EQ"
                if key not in bridge or (is_eq and not prefer_eq.get(key)):
                    bridge[key] = sym
                    prefer_eq[key] = is_eq
        log.info("symbol bridge: %d names from %s", len(bridge), Path(masters[-1]).name)

    added = 0
    for f in sorted(RAW.glob("CF-Insider-Trading-equities-*.csv")):
        with open(f, encoding="utf-8-sig", errors="replace", newline="") as fh:
            r = csv.reader(fh)
            hdr = [h.strip().replace("\n", " ").strip() for h in next(r)]
            si = next((i for i, h in enumerate(hdr) if h.upper().startswith("SYMBOL")), None)
            ci = next((i for i, h in enumerate(hdr) if "COMPANY" in h.upper()), None)
            if si is None or ci is None:
                continue
            for row in r:
                if len(row) <= max(si, ci):
                    continue
                sym, key = row[si].strip(), norm(row[ci])
                if key and sym and key not in bridge:  # never override the master
                    bridge[key] = sym
                    added += 1
    if added:
        log.info("symbol bridge: +%d full-name mappings from insider index", added)
    return bridge


def resolve(company_key: str, bridge: dict[str, str], keys_sorted: list[str]):
    """Exact match, else the longest security-master key that is a prefix of this
    (full) company key — the master truncates long names. Guard length >= 12 and
    require the winner be unambiguous to avoid short prefixes ('ITC') colliding."""
    if company_key in bridge:
        return bridge[company_key]
    candidates = [k for k in keys_sorted if len(k) >= 12 and company_key.startswith(k)]
    if not candidates:
        return None
    longest = max(len(k) for k in candidates)
    winners = {bridge[k] for k in candidates if len(k) == longest}
    return next(iter(winners)) if len(winners) == 1 else None


# --------------------------------------------------------------- driver
def run() -> None:
    files = sorted(RAW.glob(INDEX_GLOB))
    if not files:
        raise SystemExit(f"no shareholding index CSV under {RAW}/ ({INDEX_GLOB})")
    log.info("reading %d index file(s): %s", len(files), [f.name for f in files])

    bridge = build_symbol_bridge()
    keys_sorted = sorted(bridge, key=len, reverse=True)

    # dedup on (company_key, as_on_date): a quarter can be re-filed/revised —
    # keep the latest submission. Union across the (overlapping) index files.
    best: dict[tuple[str, date], dict] = {}
    seen = 0
    for f in files:
        with open(f, encoding="utf-8-sig", newline="") as fh:
            r = csv.reader(fh)
            hdr = [h.strip().replace("\n", " ").strip() for h in next(r)]
            col = {h.upper(): i for i, h in enumerate(hdr)}

            def g(row, *names):
                for n in names:
                    i = col.get(n)
                    if i is not None and i < len(row):
                        return row[i].strip()
                return ""

            for row in r:
                company = g(row, "COMPANY", "COMPANY NAME")
                as_on = _parse_date(g(row, "AS ON DATE"))
                if not company or as_on is None:
                    continue
                seen += 1
                ck = norm(company)
                submission = _parse_date(g(row, "SUBMISSION DATE"))
                key = (ck, as_on)
                prior = best.get(key)
                if prior and prior["submission_date"] and submission and submission <= prior["submission_date"]:
                    continue
                best[key] = {
                    "symbol": resolve(ck, bridge, keys_sorted),
                    "company": company,
                    "company_key": ck,
                    "as_on_date": as_on,
                    "promoter_pct": _to_float(g(row, "PROMOTER & PROMOTER GROUP (A)")),
                    "public_pct": _to_float(g(row, "PUBLIC (B)")),
                    "employee_trust_pct": _to_float(g(row, "SHARES HELD BY EMPLOYEE TRUSTS (C2)")),
                    "status": g(row, "STATUS") or None,
                    "submission_date": submission,
                    "xbrl_url": g(row, "ACTION") or None,
                }

    rows = list(best.values())
    resolved = sum(1 for x in rows if x["symbol"])
    log.info("%d index rows -> %d unique (company, quarter); %d resolved to a symbol (%d distinct)",
             seen, len(rows), resolved, len({x["symbol"] for x in rows if x["symbol"]}))

    STORE.mkdir(parents=True, exist_ok=True)
    cols = ["symbol", "company", "company_key", "as_on_date", "promoter_pct",
            "public_pct", "employee_trust_pct", "status", "submission_date", "xbrl_url"]
    con = duckdb.connect()
    con.execute("""
        CREATE OR REPLACE TABLE shp (
            symbol VARCHAR, company VARCHAR, company_key VARCHAR, as_on_date DATE,
            promoter_pct DOUBLE, public_pct DOUBLE, employee_trust_pct DOUBLE,
            status VARCHAR, submission_date DATE, xbrl_url VARCHAR)
    """)
    con.executemany(
        "INSERT INTO shp VALUES (" + ",".join("?" * len(cols)) + ")",
        [[x[c] for c in cols] for x in rows],
    )
    con.execute(f"COPY shp TO '{OUT.as_posix()}' (FORMAT parquet)")
    con.close()
    log.info("wrote %s (%d rows)", OUT, len(rows))


if __name__ == "__main__":
    run()

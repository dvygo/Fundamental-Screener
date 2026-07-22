"""XBRL populator — fetch each day's filing XBRL, land every fact, lossless.

ELT, not ETL: nothing is chosen or pivoted here. Every (context, tag, value)
triple from a filing type's XBRLs lands as one row in a Parquet file named
after — and sitting next to — the source CSV it came from:

    data/extracts/<date>/CF-Insider-Trading-<date>.csv        (raw index)
        │  fetch each .xml (cached, paced, resumable)
        │  shred -> one row per fact, nothing dropped
        ▼
    data/extracts/<date>/CF-Insider-Trading-<date>.parquet    (derived facts)

    (same pairing for CF-Shareholding-Pattern-<date> and CF-FR-<date>)

Note the asymmetry this creates: extracts/ was originally "pure raw, rebuilds
from data/raw/bod in seconds, no network." These .parquet files are derived —
rebuilding them means re-fetching XBRL (paced, ~3s/filing). Still landed here
because they're tightly coupled to their source CSV; just know the folder is
no longer uniformly cheap to regenerate.

Why lossless instead of a pivoted/fixed-column table: checked empirically
across 139 real shareholding filings — a fixed category map (13 columns)
silently dropped 34 of 52 real category members actually present (FPI cat-I/
II, KMP, government stake, ...). Structure (which XBRL axis is used) is
consistent; which facts are populated is sparse and varies per filing. A
lossless long table survives that; a hardcoded pivot has to be maintained
forever and quietly loses data it doesn't know about yet.

Presentation (the "screener.in-style" per-company table) is a SQL pivot at
query time over these files, not baked in at populate time — e.g.:

    select category_member, round(try_cast(value as double) * 100, 2) as pct
    from 'data/extracts/*/CF-Shareholding-Pattern-*.parquet'
    where source_symbol = 'BHARTIARTL' and tag = 'ShareholdingAsA...'

Fetched XML is cached under data/raw/xbrl/ (gitignored) so re-runs don't re-hit
NSE. Resumable: cap with --limit while building; run again to add the rest.

Usage:
    python src/xbrl_populate.py 20260717
    python src/xbrl_populate.py 20260717 --types shareholding
    python src/xbrl_populate.py 20260717 --limit 50
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import re
import time
from collections import defaultdict
from pathlib import Path

import duckdb
import httpx
from lxml import etree

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("xbrl_populate")

ROOT = Path(__file__).resolve().parents[1]
EXTRACTS = ROOT / "data" / "extracts"
XML_CACHE = ROOT / "data" / "raw" / "xbrl"

# filing_type -> output stem, matching the source CSV's own naming exactly
TYPE_STEM = {
    "insider": "CF-Insider-Trading",
    "shareholding": "CF-Shareholding-Pattern",
    "results": "CF-FR",
}

DELAY = 3.0
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
XBRLI = "{http://www.xbrl.org/2003/instance}"
XBRLDI = "{http://xbrl.org/2006/xbrldi}"


# ------------------------------------------------------- index -> filings
def _read(path):
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
        return list(csv.reader(fh))


def _url_col(hdr):
    for i, h in enumerate(hdr):
        if "xbrl" in h.lower() or h.strip().upper() == "ACTION":
            return i
    return None


# (regex on filename, filing type key, [symbol_col_frag, company_col_frag])
FILE_SPECS = [
    (r"insider-trading", "insider", "SYMBOL", "COMPANY"),
    (r"shareholding-pattern", "shareholding", None, "COMPANY"),
    (r"^CF-FR-|financial-results", "results", None, "COMPANY"),
]


def _spec_for(name: str):
    for pat, ftype, sym, comp in FILE_SPECS:
        if re.search(pat, name, re.I):
            return ftype, sym, comp
    return None, None, None


def collect(folder: Path, types):
    """-> [(filing_type, symbol, company, xbrl_url), ...]"""
    jobs = []
    for f in sorted(folder.glob("CF-*.csv")):
        ftype, sym_frag, comp_frag = _spec_for(f.name)
        if not ftype or (types and ftype not in types):
            continue
        rows = _read(f)
        if not rows:
            continue
        hdr = [h.strip() for h in rows[0]]
        uc = _url_col(hdr)
        if uc is None:
            log.warning("%s: no xbrl url column", f.name)
            continue
        si = next((i for i, h in enumerate(hdr)
                   if sym_frag and sym_frag.lower() in h.lower()), None)
        ci = next((i for i, h in enumerate(hdr)
                   if comp_frag and comp_frag.lower() in h.lower()), None)
        for r in rows[1:]:
            if len(r) <= uc:
                continue
            url = r[uc].strip()
            if not url.lower().endswith(".xml"):
                continue  # 'xbrl/-' = no filing
            jobs.append((
                ftype,
                r[si].strip() if si is not None else "",
                r[ci].strip() if ci is not None else "",
                url,
            ))
    return jobs


# ------------------------------------------------------------- fetch
def fetch(client, url):
    XML_CACHE.mkdir(parents=True, exist_ok=True)
    cache = XML_CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".xml")
    if cache.is_file():
        return cache.read_bytes(), True
    r = client.get(url)
    r.raise_for_status()
    cache.write_bytes(r.content)
    return r.content, False


# --------------------------------------------------------- shred (lossless)
def _contexts(root):
    ctx = {}
    for c in root.iter(XBRLI + "context"):
        cid = c.get("id")
        p = c.find(XBRLI + "period")
        pt = ps = pe = pi = None
        if p is not None:
            inst = p.find(XBRLI + "instant")
            s = p.find(XBRLI + "startDate")
            e = p.find(XBRLI + "endDate")
            if inst is not None:
                pt, pi = "instant", inst.text
            elif s is not None or e is not None:
                pt = "duration"
                ps = s.text if s is not None else None
                pe = e.text if e is not None else None
        dims = {}
        for m in c.iter(XBRLDI + "explicitMember"):
            dims[m.get("dimension")] = (m.text or "").strip()
        ctx[cid] = {"pt": pt, "ps": ps, "pe": pe, "pi": pi, "dims": dims}
    return ctx


def _units(root):
    units = {}
    for u in root.iter(XBRLI + "unit"):
        measures = [m.text for m in u.iter(XBRLI + "measure") if m.text]
        units[u.get("id")] = "/".join(measures) if measures else None
    return units


def shred(xml_bytes, ftype, symbol, company, url):
    """Every fact -> one row. Nothing chosen, nothing dropped."""
    root = etree.fromstring(xml_bytes)
    ctx = _contexts(root)
    units = _units(root)
    out = []
    for el in root.iter():
        cref = el.get("contextRef")
        if cref is None:
            continue
        val = (el.text or "").strip()
        if not val:
            continue
        c = ctx.get(cref, {})
        out.append({
            "filing_type": ftype,
            "source_symbol": symbol,
            "source_company": company,
            "xbrl_url": url,
            "tag": etree.QName(el).localname,
            "value": val,
            "context_ref": cref,
            "period_type": c.get("pt"),
            "period_start": c.get("ps"),
            "period_end": c.get("pe"),
            "period_instant": c.get("pi"),
            "unit": units.get(el.get("unitRef")) if el.get("unitRef") else None,
            "decimals": el.get("decimals"),
            "dims": json.dumps(c.get("dims") or {}),
        })
    return out


# --------------------------------------------------------------- driver
def run(date: str, types, limit: int):
    folder = EXTRACTS / date
    if not folder.is_dir():
        raise SystemExit(f"no extracts folder: {folder} — run src/extract.py {date} first")

    jobs = collect(folder, set(types) if types else None)
    if limit:
        capped, seen = [], {}
        for j in jobs:
            seen[j[0]] = seen.get(j[0], 0)
            if seen[j[0]] < limit:
                capped.append(j)
                seen[j[0]] += 1
        jobs = capped
    if not jobs:
        raise SystemExit(f"no filings with XBRL found in {folder}")

    by_type = defaultdict(int)
    for j in jobs:
        by_type[j[0]] += 1
    log.info("%d filings to shred %s", len(jobs), dict(by_type))

    facts = []
    fetched = cached = failed = 0
    with httpx.Client(headers={"User-Agent": UA,
                               "Referer": "https://www.nseindia.com/"},
                      timeout=30, follow_redirects=True) as client:
        for i, (ftype, sym, comp, url) in enumerate(jobs, 1):
            try:
                xml, from_cache = fetch(client, url)
                facts.extend(shred(xml, ftype, sym, comp, url))
                if from_cache:
                    cached += 1
                else:
                    fetched += 1
                    time.sleep(DELAY)
            except Exception as e:
                failed += 1
                log.warning("skip %s %s: %s", ftype, sym or comp, e)
            if i % 25 == 0:
                log.info("%d/%d (%d facts)", i, len(jobs), len(facts))

    if not facts:
        raise SystemExit("no facts produced")

    cols = ["filing_type", "source_symbol", "source_company", "xbrl_url",
            "tag", "value", "context_ref", "period_type", "period_start",
            "period_end", "period_instant", "unit", "decimals", "dims"]
    by_ftype = defaultdict(list)
    for f in facts:
        by_ftype[f["filing_type"]].append(f)

    con = duckdb.connect()
    for ftype, rows in by_ftype.items():
        stem = TYPE_STEM.get(ftype, ftype)
        pq = folder / f"{stem}-{date}.parquet"
        con.execute("CREATE OR REPLACE TABLE facts ("
                    + ", ".join(f"{c} VARCHAR" for c in cols) + ")")
        con.executemany(
            "INSERT INTO facts VALUES (" + ",".join("?" * len(cols)) + ")",
            [[r.get(c) for c in cols] for r in rows],
        )
        con.execute(f"COPY facts TO '{pq.as_posix()}' (FORMAT parquet)")
        log.info("wrote %s  (%d facts)", pq.name, len(rows))
    con.close()

    log.info("done %s: %d facts total, fetched %d, cached %d, failed %d",
             date, len(facts), fetched, cached, failed)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Shred filing XBRL -> lossless per-day Parquet")
    ap.add_argument("date", help="folder under data/extracts, e.g. 20260717")
    ap.add_argument("--types", nargs="*",
                    choices=["insider", "shareholding", "results"],
                    help="filing types to populate (default: all found)")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap filings PER TYPE (resumable build); 0 = all")
    args = ap.parse_args()
    run(args.date, args.types, args.limit)

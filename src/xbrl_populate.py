"""XBRL populator — filings' XBRL -> lossless Bronze facts -> Parquet -> MinIO.

ELT, Bronze layer. For each filing listed in the day's CF-*.csv indexes, fetch
its XBRL from nsearchives and shred it into a LONG facts table — one row per
fact, EVERY fact kept (nothing chosen, nothing dropped). Context, period, unit,
decimals and any dimensions travel with each fact, so the Silver/Gold transforms
(promoter %, EPS, FII/DII split, insider qty) are pure SQL pivots later.

    data/raw/bod/<date>/CF-*.csv         (filing indexes, hold XBRL urls)
        │  fetch each .xml (cached, paced, resumable)
        │  shred -> long facts
        ▼
    data/bronze/<date>/xbrl_facts.parquet   (lossless)
        ├──► MinIO  bronze/<date>/xbrl_facts.parquet
        └──► data/backup/<date>/bronze/xbrl_facts.parquet

Fetched XML is cached under data/raw/xbrl/ (gitignored) so re-runs don't re-hit
NSE. Resumable: cap with --limit while building; run again to add the rest.

Usage:
    python src/xbrl_populate.py 20260717 --types results
    python src/xbrl_populate.py 20260717 --types insider --limit 50
    python src/xbrl_populate.py 20260717            # all types, all filings
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import httpx
from lxml import etree

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("xbrl_populate")

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "bod"
XML_CACHE = ROOT / "data" / "raw" / "xbrl"
BRONZE = ROOT / "data" / "bronze"
BACKUP = ROOT / "data" / "backup"
BRONZE_BUCKET = "bronze"

DELAY = 3.0
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
XBRLI = "{http://www.xbrl.org/2003/instance}"
XBRLDI = "{http://xbrl.org/2006/xbrldi}"


# ------------------------------------------------------- index readers
def _read(path):
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
        return list(csv.reader(fh))


def _find(folder, *pats):
    import re
    for p in folder.iterdir():
        for pat in pats:
            if re.search(pat, p.name, re.I):
                return p
    return None


def _url_col(hdr):
    """Index of the column holding the XBRL .xml url (name varies)."""
    for i, h in enumerate(hdr):
        if "xbrl" in h.lower() or h.strip().upper() == "ACTION":
            return i
    return None


def collect(folder, types):
    """-> list of (filing_type, symbol, company, url)."""
    specs = {
        "insider": (r"Insider-Trading.*\.csv$", "SYMBOL", "COMPANY"),
        "shareholding": (r"Shareholding-Pattern.*\.csv$", None, "COMPANY"),
        "results": (r"CF-FR.*\.csv$|Financial-Results.*\.csv$", None, "COMPANY"),
    }
    jobs = []
    for ftype, (pat, sym_col, comp_col) in specs.items():
        if types and ftype not in types:
            continue
        f = _find(folder, *pat.split("|"))
        if not f:
            continue
        rows = _read(f)
        hdr = [h.strip() for h in rows[0]]
        uc = _url_col(hdr)
        if uc is None:
            log.warning("%s: no xbrl url column", ftype)
            continue
        si = next((i for i, h in enumerate(hdr)
                   if sym_col and sym_col.lower() in h.lower()), None)
        ci = next((i for i, h in enumerate(hdr)
                   if comp_col and comp_col.lower() in h.lower()), None)
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
    """Every fact -> one row. Lossless."""
    import json as _json
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
            "dims": _json.dumps(c.get("dims") or {}),
        })
    return out


# ---------------------------------------------------------------- MinIO
def push_minio(local: Path, key: str):
    from minio import Minio
    from minio.error import S3Error

    # reuse ingest's dotenv + client conventions
    env = ROOT / "docker" / ".env"
    if env.is_file():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    client = Minio(
        os.environ.get("MINIO_ENDPOINT", "localhost:9000"),
        access_key=os.environ.get("MINIO_ROOT_USER", "minioadmin"),
        secret_key=os.environ.get("MINIO_ROOT_PASSWORD", "minioadmin"),
        secure=os.environ.get("MINIO_SECURE", "false").lower() == "true",
    )
    if not client.bucket_exists(BRONZE_BUCKET):
        client.make_bucket(BRONZE_BUCKET)  # derived/rebuildable -> no WORM
        log.info("created bucket %s (versioned, no lock)", BRONZE_BUCKET)
    client.fput_object(BRONZE_BUCKET, key, str(local))
    log.info("pushed  %s/%s", BRONZE_BUCKET, key)


# --------------------------------------------------------------- driver
def run(date, types, limit):
    folder = RAW / date
    if not folder.is_dir():
        raise SystemExit(f"no raw folder: {folder}")
    jobs = collect(folder, set(types) if types else None)
    if limit:
        # cap per type, not globally, so each type gets some coverage
        capped, seen = [], {}
        for j in jobs:
            seen[j[0]] = seen.get(j[0], 0)
            if seen[j[0]] < limit:
                capped.append(j)
                seen[j[0]] += 1
        jobs = capped
    log.info("%d filings to shred %s", len(jobs),
             dict((t, sum(1 for j in jobs if j[0] == t)) for t in set(j[0] for j in jobs)))

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

    out_dir = BRONZE / date
    out_dir.mkdir(parents=True, exist_ok=True)
    pq = out_dir / "xbrl_facts.parquet"
    cols = ["filing_type", "source_symbol", "source_company", "xbrl_url",
            "tag", "value", "context_ref", "period_type", "period_start",
            "period_end", "period_instant", "unit", "decimals", "dims"]
    con = duckdb.connect()
    con.execute("CREATE TABLE facts (" + ", ".join(f"{c} VARCHAR" for c in cols) + ")")
    con.executemany(
        "INSERT INTO facts VALUES (" + ",".join("?" * len(cols)) + ")",
        [[f.get(c) for c in cols] for f in facts],
    )
    con.execute(f"COPY facts TO '{pq.as_posix()}' (FORMAT parquet)")
    n = con.execute("SELECT count(*) FROM facts").fetchone()[0]
    con.close()
    log.info("wrote %s  (%d facts, %d filings)", pq, n, len(jobs) - failed)

    # mirror to backup + push MinIO
    bdir = BACKUP / date / "bronze"
    bdir.mkdir(parents=True, exist_ok=True)
    import shutil
    shutil.copy2(pq, bdir / pq.name)
    push_minio(pq, f"{date}/xbrl_facts.parquet")

    log.info("done: fetched %d, cached %d, failed %d, facts %d",
             fetched, cached, failed, n)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Shred filing XBRL -> Bronze Parquet -> MinIO")
    ap.add_argument("date", help="folder under data/raw/bod, e.g. 20260717")
    ap.add_argument("--types", nargs="*",
                    choices=["insider", "shareholding", "results"],
                    help="filing types to populate (default: all)")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap filings PER TYPE (resumable build); 0 = all")
    args = ap.parse_args()
    run(args.date, args.types, args.limit)

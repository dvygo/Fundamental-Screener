"""XBRL populator — enrich each day's filing CSVs with their XBRL detail.

For every CF-*.csv in a date folder, fetch each filing's XBRL (cached, paced,
resumable) and write a WIDE CSV next to the source, named by suffixing the
source filename. Every original column is carried through unchanged; XBRL
detail is APPENDED as new `xbrl_*` columns — nothing from the source is
dropped or replaced. Insider filings that cover several persons/transactions
repeat the original row once per person (one-to-many); shareholding and
results are one-to-one.

    data/extracts/<date>/CF-Insider-Trading-<date>.csv
        -> data/extracts/<date>/CF-Insider-Trading-<date>_xbrlpopulated.csv

    data/extracts/<date>/CF-Shareholding-Pattern-<date>.csv
        -> data/extracts/<date>/CF-Shareholding-Pattern-<date>_xbrlpopulated.csv

    data/extracts/<date>/CF-FR-<date>.csv
        -> data/extracts/<date>/CF-FR-<date>_xbrlpopulated.csv

Field maps below were built by inspecting real filings (see FINDINGS.md):

  insider       one context per person/transaction (has NameOfThePerson) ->
                one output row per context, filing-level fields merged in.
  shareholding  category lives in a context DIMENSION
                (in-bse-shp:CategoryOfShareholdersAxis), not a tag -> pivoted
                into named columns (promoter_pct, fii_pct, dii_pct, ...).
  results       many contexts (current/comparative periods); the "current"
                context is the duration context with the latest period_end
                that carries ProfitLossForPeriod -> one row per filing.

Fetched XML is cached under data/raw/xbrl/ (gitignored) so re-runs don't re-hit
NSE. Resumable: cap with --limit while building; run again to add the rest.

Usage:
    python src/xbrl_populate.py 20260717
    python src/xbrl_populate.py 20260717 --types insider
    python src/xbrl_populate.py 20260717 --limit 50
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import logging
import re
import time
from collections import defaultdict
from pathlib import Path

import httpx
from lxml import etree

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("xbrl_populate")

ROOT = Path(__file__).resolve().parents[1]
EXTRACTS = ROOT / "data" / "extracts"
XML_CACHE = ROOT / "data" / "raw" / "xbrl"

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


# (regex on filename, filing type key)
FILE_SPECS = [
    (r"insider-trading", "insider"),
    (r"shareholding-pattern", "shareholding"),
    (r"^CF-FR-|financial-results", "results"),
]


def _type_for(name: str):
    for pat, ftype in FILE_SPECS:
        if re.search(pat, name, re.I):
            return ftype
    return None


def collect(folder: Path, types):
    """-> {ftype: [(csv_path, header, [(row_dict, url), ...])]}"""
    out = defaultdict(list)
    for f in sorted(folder.glob("CF-*.csv")):
        if f.name.endswith("_xbrlpopulated.csv"):
            continue
        ftype = _type_for(f.name)
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
        pairs = []
        for r in rows[1:]:
            if len(r) < len(hdr):
                r = r + [""] * (len(hdr) - len(r))
            url = r[uc].strip()
            row_dict = dict(zip(hdr, r))
            if url.lower().endswith(".xml"):
                pairs.append((row_dict, url))
        out[ftype].append((f, hdr, pairs))
    return out


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


# --------------------------------------------------------- shred -> contexts
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


def facts_by_context(xml_bytes):
    """context_id -> {tag: value}, plus context_id -> period/dims meta."""
    root = etree.fromstring(xml_bytes)
    ctx = _contexts(root)
    by_ctx = defaultdict(dict)
    for el in root.iter():
        cref = el.get("contextRef")
        if cref is None:
            continue
        val = (el.text or "").strip()
        if not val:
            continue
        by_ctx[cref][etree.QName(el).localname] = val
    return by_ctx, ctx


def _filing_level(by_ctx, tags):
    """First non-empty value for each tag, from any context (filing-wide)."""
    out = {}
    for t in tags:
        for d in by_ctx.values():
            if t in d:
                out[t] = d[t]
                break
    return out


# ------------------------------------------------------------- INSIDER
# Symbol/company/ISIN/regulation/filed-date already exist in the source CF-*
# columns; only NEW fields (the per-person transaction detail) are added.
INSIDER_NEW_COLS = [
    "person", "category", "identification_no", "txn_type", "qty", "value",
    "held_pre", "pct_pre", "held_post", "pct_post", "mode",
    "intimation_date", "exchange", "url",
]


def pivot_insider(by_ctx, ctx, url):
    rows = []
    for cid, d in by_ctx.items():
        if "NameOfThePerson" not in d:
            continue
        rows.append({
            "person": d.get("NameOfThePerson", ""),
            "category": d.get("CategoryOfPerson", ""),
            "identification_no": d.get("IdentificationNumberOfDirectorOrCompany", ""),
            "txn_type": d.get("SecuritiesAcquiredOrDisposedTransactionType", ""),
            "qty": d.get("SecuritiesAcquiredOrDisposedNumberOfSecurity", ""),
            "value": d.get("SecuritiesAcquiredOrDisposedValueOfSecurity", ""),
            "held_pre": d.get("SecuritiesHeldPriorToAcquisitionOrDisposalNumberOfSecurity", ""),
            "pct_pre": d.get("SecuritiesHeldPriorToAcquisitionOrDisposalPercentageOfShareholding", ""),
            "held_post": d.get("SecuritiesHeldPostAcquistionOrDisposalNumberOfSecurity", ""),
            "pct_post": d.get("SecuritiesHeldPostAcquistionOrDisposalPercentageOfShareholding", ""),
            "mode": d.get("ModeOfAcquisitionOrDisposal", ""),
            "intimation_date": d.get("DateOfIntimationToCompany", ""),
            "exchange": d.get("ExchangeOnWhichTheTradeWasExecuted", ""),
            "url": url,
        })
    return rows


# ------------------------------------------------------- SHAREHOLDING
# COMPANY / PROMOTER% / PUBLIC% already exist in the source CF-* columns;
# symbol/ISIN/scrip and the category breakdown (esp. FII/DII) are the new value.
SHP_FILING_TAGS = ["Symbol", "ISIN", "ScripCode",
                   "DateOfReport", "NumberOfShareholders", "WhetherCompanyIsSME"]
# category-axis member -> output column
SHP_CATEGORY_MAP = {
    "InstitutionsDomesticMember": "dii_pct",
    "InstitutionsForeignMember": "fii_pct",
    "MutualFundsOrUTIMember": "mutual_funds_pct",
    "InsuranceCompaniesMember": "insurance_pct",
    "BanksMember": "banks_pct",
    "AlternativeInvestmentFundsMember": "aif_pct",
    "IndividualsOrHinduUndividedFamilyMember": "individuals_pct",
    "NonResidentIndiansMember": "nri_pct",
    "ForeignCompaniesMember": "foreign_companies_pct",
    "BodiesCorporateMember": "bodies_corporate_pct",
    "NonInstitutionsMember": "non_institutions_pct",
}
SHP_NEW_COLS = (
    ["symbol", "isin", "scrip_code", "date_of_report",
     "num_shareholders", "is_sme"]
    + list(SHP_CATEGORY_MAP.values())
    + ["url"]
)
AXIS = "in-bse-shp:CategoryOfShareholdersAxis"


def pivot_shareholding(by_ctx, ctx, url):
    filing = _filing_level(by_ctx, SHP_FILING_TAGS)
    row = {
        "symbol": filing.get("Symbol", ""),
        "isin": filing.get("ISIN", ""),
        "scrip_code": filing.get("ScripCode", ""),
        "date_of_report": filing.get("DateOfReport", ""),
        "num_shareholders": filing.get("NumberOfShareholders", ""),
        "is_sme": filing.get("WhetherCompanyIsSME", ""),
        "url": url,
    }
    for col in SHP_CATEGORY_MAP.values():
        row[col] = ""
    for cid, d in by_ctx.items():
        member = ctx.get(cid, {}).get("dims", {}).get(AXIS)
        if not member:
            continue
        col = SHP_CATEGORY_MAP.get(member.split(":")[-1])
        if col and "ShareholdingAsAPercentageOfTotalNumberOfShares" in d:
            row[col] = d["ShareholdingAsAPercentageOfTotalNumberOfShares"]
    return [row]


# ------------------------------------------------------------- RESULTS
# company/PERIOD ENDED already exist in source; symbol + the actual P&L
# numbers (not in source at all) are the new value.
RESULTS_FILING_TAGS = ["Symbol"]
RESULTS_TAGS = [
    "RevenueFromOperations", "Income", "Expenses", "EmployeeBenefitExpense",
    "OtherExpenses", "OtherIncome", "ProfitBeforeTax", "TaxExpense",
    "CurrentTax", "DeferredTax", "ProfitLossForPeriod",
    "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
    "DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
]
RESULTS_NEW_COLS = (["symbol", "period_start", "period_end"]
                    + list(RESULTS_TAGS) + ["url"])


def pivot_results(by_ctx, ctx, url):
    filing = _filing_level(by_ctx, RESULTS_FILING_TAGS)
    # "current period" = duration context with ProfitLossForPeriod and the
    # latest period_end
    best_cid, best_pe = None, ""
    for cid, d in by_ctx.items():
        c = ctx.get(cid, {})
        if c.get("pt") != "duration" or "ProfitLossForPeriod" not in d:
            continue
        pe = c.get("pe") or ""
        if pe > best_pe:
            best_cid, best_pe = cid, pe
    if best_cid is None:
        return []
    d = by_ctx[best_cid]
    c = ctx[best_cid]
    row = {
        "symbol": filing.get("Symbol", ""),
        "period_start": c.get("ps", ""),
        "period_end": c.get("pe", ""),
        "url": url,
    }
    for t in RESULTS_TAGS:
        row[t] = d.get(t, "")
    return [row]


PIVOTS = {"insider": (pivot_insider, INSIDER_NEW_COLS),
          "shareholding": (pivot_shareholding, SHP_NEW_COLS),
          "results": (pivot_results, RESULTS_NEW_COLS)}


# --------------------------------------------------------------- driver
def populate_file(client, ftype, csv_path: Path, hdr: list[str],
                  pairs: list[tuple[dict, str]], limit: int):
    """pairs = [(original_row_dict, xbrl_url), ...]. Original columns are
    carried through unchanged; new XBRL fields are appended as xbrl_* columns.
    A filing with no XBRL detail (fetch failure) still emits its original row
    once, with the xbrl_* columns blank — never silently dropped."""
    pivot_fn, new_cols = PIVOTS[ftype]
    if limit:
        pairs = pairs[:limit]
    xbrl_cols = [f"xbrl_{c}" for c in new_cols]
    out_cols = hdr + xbrl_cols

    out_rows = []
    fetched = cached = failed = 0
    for i, (orig, url) in enumerate(pairs, 1):
        derived = []
        try:
            xml, from_cache = fetch(client, url)
            by_ctx, ctx = facts_by_context(xml)
            derived = pivot_fn(by_ctx, ctx, url)
            if from_cache:
                cached += 1
            else:
                fetched += 1
                time.sleep(DELAY)
        except Exception as e:
            failed += 1
            log.warning("skip %s: %s", url, e)

        if not derived:
            out_rows.append([orig.get(h, "") for h in hdr] + [""] * len(xbrl_cols))
        else:
            for d in derived:
                out_rows.append([orig.get(h, "") for h in hdr]
                                + [d.get(c, "") for c in new_cols])
        if i % 25 == 0:
            log.info("  %s: %d/%d", csv_path.name, i, len(pairs))

    out_path = csv_path.with_name(csv_path.stem + "_xbrlpopulated.csv")
    with open(out_path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(out_cols)
        w.writerows(out_rows)
    log.info("%s  (%d rows, fetched %d cached %d failed %d) <- %s",
             out_path.name, len(out_rows), fetched, cached, failed, csv_path.name)
    return len(out_rows), fetched, cached, failed


def run(date: str, types, limit: int):
    folder = EXTRACTS / date
    if not folder.is_dir():
        raise SystemExit(f"no extracts folder: {folder} — run src/extract.py {date} first")

    by_type = collect(folder, set(types) if types else None)
    if not by_type:
        raise SystemExit(f"no CF-*.csv filings found in {folder}")

    total_rows = total_fetched = total_cached = total_failed = 0
    with httpx.Client(headers={"User-Agent": UA,
                               "Referer": "https://www.nseindia.com/"},
                      timeout=30, follow_redirects=True) as client:
        for ftype, files in by_type.items():
            for csv_path, hdr, pairs in files:
                log.info("=== %s (%d filings) ===", csv_path.name, len(pairs))
                r, f, c, x = populate_file(client, ftype, csv_path, hdr, pairs, limit)
                total_rows += r
                total_fetched += f
                total_cached += c
                total_failed += x

    log.info("done %s: %d rows written, fetched %d, cached %d, failed %d",
             date, total_rows, total_fetched, total_cached, total_failed)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Enrich a day's filing CSVs with XBRL detail (wide, suffixed CSV per source)")
    ap.add_argument("date", help="folder under data/extracts, e.g. 20260717")
    ap.add_argument("--types", nargs="*",
                    choices=["insider", "shareholding", "results"],
                    help="filing types to populate (default: all found)")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap filings PER FILE (resumable build); 0 = all")
    args = ap.parse_args()
    run(args.date, args.types, args.limit)

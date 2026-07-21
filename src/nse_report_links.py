"""Generate NSE "all-reports" bulk-download links for a date range.

The all-reports page's "Multiple file Download" button fires a GET to
/api/reports with a `date` + `archives` (the "Select All Reports" list) query,
returning a zip (Reports-Archives-Multiple-DDMMYYYY.zip). That endpoint sits
behind Akamai Bot Manager — the response only succeeds from a real browser
that already carries valid Akamai sensor cookies (_abck/bm_sz/ak_bmsc/bm_sv).
This script does NOT try to script around that (no bot-detection evasion) —
it only builds the correctly-formed URL (captured from a real browser
DevTools session, not fabricated) for each date in the range, latest first,
for you to open/click yourself in a real browser.

The `archives` list below is exactly what NSE's own "Select All Reports"
checkbox produces (captured verbatim) — every capital-market/equities archive
report on that page, one zip per day.

Usage:
    python src/nse_report_links.py --from 20260701 --to 20260720
    python src/nse_report_links.py --from 20260701 --to 20260720 > links.txt
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from urllib.parse import quote

BASE = "https://www.nseindia.com/api/reports"

# Verbatim "Select All Reports" archive list, captured from a real browser
# request against https://www.nseindia.com/all-reports (capital-market/equities).
ARCHIVES = [
    {"name": "NSE Market Pulse (.pdf)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - VaR Margin Rates (1st intra-day)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - VaR Margin Rates (2nd intra-day)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - VaR Margin Rates (3rd intra-day)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - VaR Margin Rates (4th intra-day)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - VaR Margin Rates (End of day)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - VaR Margin Rates (Begin of day)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Daily Volatility", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Category-wise Turnover", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Bhavcopy(csv)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Common Bhavcopy (csv)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Bhavcopy (PR.zip)", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Short Selling", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Market Activity Report", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Security-wise Delivery Positions", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Margin Trading Disclosure", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "Client Funding", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "VaR Multiplier files", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "ALBM Yield Statistics", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "Extreme Loss Margin", "type": "archives", "category": "capital-market", "section": "equities"},
    {"name": "CM - Security Catergory Impact Cost (.T01)", "type": "monthly-reports", "category": "capital-market", "section": "equities"},
    {"name": "SME - BHAVCOPY (.csv)", "type": "monthly-reports", "category": "capital-market", "section": "equities"},
    {"name": "Bhavcopy File (DAT)", "type": "monthly-reports", "category": "capital-market", "section": "equities"},
    {"name": "Full Bhavcopy and Security Deliverable data", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "CM - Mode of Trading", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "CM-UDiFF Common Bhavcopy Final (zip)", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "Surveillance Indicator", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "Surveillance Indicator New", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "CM - MII - Security File (.gz) (NSE Listed securities)", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "52 Week High Low Report", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "CM - Close out prices (.csv)", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "PE Ratio", "type": "daily-reports", "category": "capital-market", "section": "equities"},
    {"name": "CM - MII - Security File (.gz) (NSE Listed and BSE Exclusive securities)", "type": "daily-reports", "category": "capital-market", "section": "equities"},
]

_ARCHIVES_Q = quote(json.dumps(ARCHIVES, separators=(",", ":")))


def url_for(d: date) -> str:
    date_str = d.strftime("%d-%b-%Y")  # "20-Jul-2026", matches captured format
    return f"{BASE}?archives={_ARCHIVES_Q}&date={date_str}&type=Archives"


def daterange(d_from: date, d_to: date):
    """Latest first."""
    n = (d_to - d_from).days
    for i in range(n, -1, -1):
        yield d_from + timedelta(days=i)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Print NSE all-reports bulk-download links for a date range (latest first)")
    ap.add_argument("--from", dest="date_from", required=True, help="YYYYMMDD")
    ap.add_argument("--to", dest="date_to", required=True, help="YYYYMMDD")
    args = ap.parse_args()

    d_from = date(int(args.date_from[:4]), int(args.date_from[4:6]), int(args.date_from[6:8]))
    d_to = date(int(args.date_to[:4]), int(args.date_to[4:6]), int(args.date_to[6:8]))
    if d_from > d_to:
        raise SystemExit("--from must be <= --to")

    for d in daterange(d_from, d_to):
        print(url_for(d))

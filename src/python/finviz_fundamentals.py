#!/usr/bin/env python3
"""finviz fundamentals -> lossless long table (Live lane).

Feeds Stock Centric US (Live). Per `context/proposals/us-live-lane-sources.md`:
fundamentals from finviz, technicals from Yahoo.

    finviz  /quote.ashx?t=<TICKER>  (301 -> /stock?t=<TICKER>)
        │  the ratio grid: ~12 tables of 14 label/value pairs
        ▼
    data/extracts_us/_meta/finviz_fundamentals.parquet   (symbol, key, value)
    data/extracts_us/_meta/finviz_insider.parquet        (per-stock Form 4 + 144)

TWO THINGS FOUND BY TESTING, both of which break a naive scraper:

  1. /quote.ashx 301-REDIRECTS to /stock?t=. Without follow-redirects you get a
     0-byte body and an empty parse, not an error. robots.txt (checked
     2026-08-19) restricts neither path.

  2. There is NO permitted bulk route. robots.txt disallows /screener?*, so
     fundamentals must be fetched one ticker at a time — 503 paced requests.
     Budget ~10 minutes, and keep it resumable.

LONG FORMAT, not fixed columns, for the reason xbrl_populate.py records: finviz
publishes ~70 fields and the set drifts. A fixed column list silently drops
whatever was added since it was written. One row per (symbol, key, value)
survives that.

The insider table on the same page is captured too, because it is free once the
page is fetched — and unlike the SEC bulk it includes **Form 144 "Proposed
Sale"** rows, which are filed BEFORE a sale. A leading indicator the SEC
quarterly data does not give us.

Usage:
    python src/python/finviz_fundamentals.py --limit 5     # smoke test
    python src/python/finviz_fundamentals.py               # all constituents
"""
from __future__ import annotations

import argparse
import io
import logging
import time
from pathlib import Path

import duckdb
import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("finviz")

ROOT = Path(__file__).resolve().parents[2]
META = ROOT / "data" / "extracts_us" / "_meta"
ROSTER = META / "sp500_constituents.csv"

BASE = "https://finviz.com/quote.ashx?t="
# finviz serves a JS-shell to unfamiliar agents; a browser UA gets the rendered
# table. Unlike Wikipedia and the SEC, a descriptive tool UA is NOT what works
# here — this is the one source in the repo that wants a browser string.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
DELAY = 1.2  # polite: this is a third party, not a regulator


def fetch(client: httpx.Client, symbol: str) -> str:
    r = client.get(BASE + symbol, headers={"User-Agent": UA},
                   follow_redirects=True, timeout=40)  # 301 -> /stock?t=
    r.raise_for_status()
    return r.text


def parse(html: str, symbol: str) -> tuple[list[dict], pd.DataFrame | None]:
    tables = pd.read_html(io.StringIO(html), flavor="lxml")
    facts: list[dict] = []
    insider = None
    for t in tables:
        # The ratio grid arrives as 14-row label/value blocks. Matching on
        # shape[1] == 2 alone is NOT enough: the news feed is also two columns,
        # and it dragged whole headlines in as "keys" — 354 distinct keys for
        # three symbols, most of them article titles. Requiring 14 rows AND
        # short values keeps the grid and rejects prose.
        if t.shape == (14, 2):
            for k, v in t.itertuples(index=False):
                k, v = str(k).strip(), str(v).strip()
                if not k or not v or k.lower() == "nan":
                    continue
                if len(k) > 30 or len(v) > 40:  # a ratio label/value is short
                    continue
                facts.append({"symbol": symbol, "key": k, "value": v})
        elif "Insider Trading" in [str(c) for c in t.columns]:
            insider = t.assign(symbol=symbol)
    return facts, insider


def main() -> None:
    p = argparse.ArgumentParser(description="finviz fundamentals -> parquet")
    p.add_argument("--limit", type=int, default=0, help="cap symbols; 0 = all")
    a = p.parse_args()

    if not ROSTER.is_file():
        raise SystemExit(f"no roster at {ROSTER} — run us_market_pull.py roster first")
    symbols = [s.strip().upper().replace(".", "-")
               for s in pd.read_csv(ROSTER)["Symbol"].astype(str)]
    if a.limit:
        symbols = symbols[: a.limit]

    # Prove we can write BEFORE spending the network time. The first .info
    # loader fetched all 503 symbols and then died on the write, losing the lot.
    META.mkdir(parents=True, exist_ok=True)
    probe = META / ".finviz_probe.parquet"
    con = duckdb.connect()
    con.execute(f"COPY (SELECT 1 AS ok) TO '{probe.as_posix()}' (FORMAT PARQUET)")
    probe.unlink(missing_ok=True)

    facts: list[dict] = []
    insiders: list[pd.DataFrame] = []
    ok = failed = 0
    with httpx.Client() as client:
        for i, sym in enumerate(symbols, 1):
            try:
                f, ins = parse(fetch(client, sym), sym)
                if not f:
                    raise ValueError("no label/value pairs parsed")
                facts.extend(f)
                if ins is not None:
                    insiders.append(ins)
                ok += 1
            except Exception as e:  # third party: expect failures, never abort
                failed += 1
                log.warning("skip %s: %s", sym, e)
            if i % 25 == 0:
                log.info("%d/%d (ok %d, failed %d, %d facts)", i, len(symbols), ok, failed, len(facts))
            time.sleep(DELAY)

    if not facts:
        raise SystemExit("nothing parsed — finviz layout may have changed")

    out = META / "finviz_fundamentals.parquet"
    con.register("f", pd.DataFrame(facts))
    con.execute(f"COPY f TO '{out.as_posix()}' (FORMAT PARQUET)")
    log.info("wrote %s (%d facts, %d symbols; failed %d)", out, len(facts), ok, failed)

    if insiders:
        oi = META / "finviz_insider.parquet"
        df = pd.concat(insiders, ignore_index=True)
        df.columns = [str(c).strip().lower().replace(" ", "_").replace("#", "num_")
                      .replace("(", "").replace(")", "").replace("$", "usd") for c in df.columns]
        con.register("ins", df)
        con.execute(f"COPY ins TO '{oi.as_posix()}' (FORMAT PARQUET)")
        log.info("wrote %s (%d rows) — includes Form 144 proposed sales", oi, len(df))
    con.close()


if __name__ == "__main__":
    main()

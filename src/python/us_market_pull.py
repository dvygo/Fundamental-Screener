#!/usr/bin/env python3
"""US market loader — S&P 500 daily bars + fundamentals, via yfinance.

TODO — REPLACE YAHOO WITH DATABENTO. Not being worked on now; this note exists
so the decision isn't re-litigated later.

  A market-wide Databento extract is already in hand (paid subscription):
      dataset XNAS.ITCH, schema ohlcv-1d, symbols ALL_SYMBOLS
      2018-05-01 -> 2026-08-07, 2,079 trading days, ~409 MB zipped
      one zstd-compressed CSV per day + metadata.json + condition.json

  Why it wins on every axis that matters here:
    * MARKET-WIDE, not just the S&P 500 — the 503-name universe is a limitation
      of the Yahoo path, not a choice, and it silently excludes every small cap.
    * Authoritative exchange data rather than an unofficial, unstable endpoint
      that fails with "database is locked" and needs a completeness guard.
    * Already one file per session, so it drops straight into the
      data/extracts_us/<YYYYMMDD>/ layout the API globs — the db.js views and
      all four screens should carry over with only the column names remapped.
    * 2018 onward gives far more 52-week context than the 5y pulled here.

  Two things to get right when it happens:
    * pretty_px is FALSE in this extract, so prices are fixed-point integers and
      need 1e-9 scaling. Reading them raw yields prices a billion times too
      large — the same class of error as the SEC per-share field.
    * .zst needs zstandard (or DuckDB, which reads zstd CSV natively) — the
      stdlib zipfile/gzip path used by extract.py will not open these.

  Yahoo would still be the source for .info fundamentals; Databento is prices
  only. So this replaces pull_bars, not the whole module.


Temporary US counterpart to the NSE daily pipeline, feeding the "Markets US"
tab. NSE hands us authoritative per-session files; Yahoo has no equivalent, so
the shape is inverted: one long history per symbol is fetched, then SPLIT into
day-partitioned files that mirror data/extracts/<date>/ exactly.

    en.wikipedia.org  List of S&P 500 companies   (roster: symbol, sector, CIK, …)
        │
        │  yfinance: full daily history per symbol
        ▼
    data/extracts_us/<YYYYMMDD>/sp500_bars_<YYYYMMDD>.csv    (one row per symbol)
    data/extracts_us/_meta/sp500_constituents.csv            (the roster)
    data/extracts_us/_meta/sp500_info.parquet                (lossless .info shred)

ELT, not ETL — deliberately, and consistent with xbrl_populate.py. Every column
yfinance returns is written; nothing is selected, renamed or rounded here.
`.info` is a ragged dict (a few hundred keys, wildly sparse and not stable
across symbols), so it lands as a LONG table — one row per (symbol, key, value)
— for the same reason the XBRL shred does: a fixed column list silently drops
whatever the source added since it was written. Derived values (pct_change,
52-week highs, gainer ranks) are NOT computed here; they are SQL over the glob
in the API, exactly as on the NSE side.

WHY THE HISTORY GOES BACK FURTHER THAN THE SCREENS
  To know a stock set a NEW 52-week high on day D you need the 52 weeks BEFORE
  D. Pulling only the screened window would make every early day look like a
  new high. Default 5y gives ~4 years of screenable sessions with full context.

Yahoo is unofficial and unstable — treat a failure as expected, not
exceptional. A symbol that fails is logged and skipped; the run continues.

Usage:
    python src/python/us_market_pull.py bars            # roster + bars -> day folders
    python src/python/us_market_pull.py bars --period 2y
    python src/python/us_market_pull.py info            # .info shred (503 paced calls)
    python src/python/us_market_pull.py roster          # refresh the roster only
"""
from __future__ import annotations

import argparse
import io
import logging
import time
from datetime import datetime
from pathlib import Path

import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("us_market")

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "extracts_us"
META = OUT / "_meta"

# Wikimedia blocks generic browser User-Agents; their policy asks for a
# descriptive one naming the tool and a contact. Sending Chrome's UA here gets a
# 403, so this string is load-bearing, not decoration.
WIKI_UA = "Fundamental-Screener/1.0 (research tool; contact narasimhadeshik@gmail.com)"
SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"

DELAY = 0.6  # pacing for the per-symbol .info calls


def fetch_roster() -> pd.DataFrame:
    """The S&P 500 constituent table, every column Wikipedia publishes."""
    r = httpx.get(SP500_URL, headers={"User-Agent": WIKI_UA}, follow_redirects=True, timeout=30)
    r.raise_for_status()
    # flavor=lxml: pandas' default path wants html5lib, which we don't ship.
    df = pd.read_html(io.StringIO(r.text), flavor="lxml")[0]
    df.columns = [str(c).strip() for c in df.columns]
    log.info("roster: %d constituents, cols=%s", len(df), list(df.columns))
    return df


def save_roster(df: pd.DataFrame) -> None:
    META.mkdir(parents=True, exist_ok=True)
    df.to_csv(META / "sp500_constituents.csv", index=False)
    log.info("wrote %s", META / "sp500_constituents.csv")


def yahoo_symbol(sym: str) -> str:
    """Wikipedia writes class shares with a dot (BRK.B); Yahoo uses a dash."""
    return sym.strip().upper().replace(".", "-")


def pull_bars(symbols: list[str], period: str) -> pd.DataFrame:
    """Full daily history for every symbol, as one long frame.

    yf.download batches internally, which is far kinder to Yahoo (and far
    faster) than 503 sequential Ticker.history() calls.
    """
    import yfinance as yf

    log.info("downloading %d symbols, period=%s", len(symbols), period)
    raw = yf.download(
        tickers=symbols,
        period=period,
        interval="1d",
        group_by="ticker",
        auto_adjust=False,  # keep BOTH Close and Adj Close — dropping either is a choice we don't make here
        actions=True,       # dividends + splits ride along
        threads=True,
        progress=False,
    )
    if raw is None or raw.empty:
        raise SystemExit("yfinance returned nothing — Yahoo may be blocking this host")

    # Wide (symbol, field) columns -> long rows, keeping every field present.
    long = raw.stack(level=0, future_stack=True).rename_axis(["Date", "Symbol"]).reset_index()
    long = long.dropna(how="all", subset=[c for c in long.columns if c not in ("Date", "Symbol")])
    log.info("got %d symbol-days, fields=%s",
             len(long), [c for c in long.columns if c not in ("Date", "Symbol")])

    # Completeness guard. yf.download runs threaded and shares one SQLite cache;
    # under contention a symbol can fail with "database is locked" and simply be
    # ABSENT from the frame — no exception, no gap in the shape, just a missing
    # ticker. Observed on the first run here. Silent partial data is worse than a
    # loud failure, so re-fetch whatever is missing, sequentially.
    missing = sorted(set(symbols) - set(long["Symbol"].unique()))
    if missing:
        log.warning("%d symbol(s) missing from the batch, retrying serially: %s",
                    len(missing), missing[:10])
        import yfinance as yf  # noqa: F811
        recovered, lost = [], []
        for sym in missing:
            try:
                h = yf.Ticker(sym).history(period=period, interval="1d", auto_adjust=False)
                if h is None or h.empty:
                    lost.append(sym)
                    continue
                h = h.reset_index()
                h["Symbol"] = sym
                recovered.append(h)
            except Exception as e:
                lost.append(sym)
                log.warning("skip %s: %s", sym, e)
            time.sleep(DELAY)
        if recovered:
            long = pd.concat([long, pd.concat(recovered, ignore_index=True)], ignore_index=True)
            log.info("recovered %d symbol(s) on retry", len(recovered))
        if lost:
            # Loud, and named: a caller must be able to see exactly what is absent.
            log.error("%d symbol(s) UNAVAILABLE, not in output: %s", len(lost), lost)

    have = long["Symbol"].nunique()
    log.info("coverage: %d/%d symbols (%.1f%%)", have, len(symbols), 100 * have / len(symbols))
    return long


def write_day_partitions(long: pd.DataFrame) -> None:
    """Split the long frame into data/extracts_us/<YYYYMMDD>/ — one file per session."""
    long = long.copy()
    long["Date"] = pd.to_datetime(long["Date"])
    written = 0
    for day, chunk in long.groupby(long["Date"].dt.strftime("%Y%m%d"), sort=True):
        d = OUT / day
        d.mkdir(parents=True, exist_ok=True)
        chunk.sort_values("Symbol").to_csv(d / f"sp500_bars_{day}.csv", index=False)
        written += 1
    log.info("wrote %d session folders under %s", written, OUT)


def pull_info(symbols: list[str], limit: int) -> None:
    """Lossless .info shred -> long parquet. Paced; failures skip, never abort."""
    import yfinance as yf

    # Preflight. This run costs ~10 minutes of paced network calls and keeps
    # every fact in memory until the end, so anything that can stop the WRITE
    # must be proven before the FETCH starts — the first attempt discovered a
    # missing parquet engine only after all 503 symbols were already fetched.
    import duckdb
    META.mkdir(parents=True, exist_ok=True)
    probe = META / ".write_probe.parquet"
    con = duckdb.connect()
    con.execute(f"COPY (SELECT 1 AS ok) TO '{probe.as_posix()}' (FORMAT PARQUET)")
    con.close()
    probe.unlink(missing_ok=True)

    rows: list[dict] = []
    todo = symbols[:limit] if limit else symbols
    ok = failed = 0
    for i, sym in enumerate(todo, 1):
        try:
            info = yf.Ticker(sym).info or {}
            for k, v in info.items():
                if v is None or isinstance(v, (list, dict)):
                    # Containers can't go in a flat long table; recorded as JSON
                    # rather than dropped, so nothing is silently lost.
                    v = None if v is None else __import__("json").dumps(v)
                rows.append({"symbol": sym, "key": str(k), "value": None if v is None else str(v)})
            ok += 1
        except Exception as e:  # Yahoo is unofficial: expect failures
            failed += 1
            log.warning("skip %s: %s", sym, e)
        if i % 25 == 0:
            log.info("%d/%d (ok %d, failed %d, %d facts)", i, len(todo), ok, failed, len(rows))
        time.sleep(DELAY)

    META.mkdir(parents=True, exist_ok=True)
    out = META / "sp500_info.parquet"
    # DuckDB, not pandas.to_parquet: to_parquet needs pyarrow or fastparquet,
    # and we ship neither — the first run fetched all 503 symbols over ~10
    # paced minutes and then threw ImportError on this line, losing the lot.
    # insider_load.py already writes its parquet through DuckDB, so this both
    # removes the dependency and matches how the rest of the repo does it.
    import duckdb
    con = duckdb.connect()
    con.register("facts", pd.DataFrame(rows))
    con.execute(f"COPY facts TO '{out.as_posix()}' (FORMAT PARQUET)")
    con.close()
    log.info("done: %s (%d facts, %d symbols; failed %d)", out, len(rows), ok, failed)


def main() -> None:
    p = argparse.ArgumentParser(description="S&P 500 bars + fundamentals via yfinance")
    p.add_argument("cmd", choices=["bars", "info", "roster"])
    p.add_argument("--period", default="5y",
                   help="yfinance period for bars (default 5y; needs >1y for 52-week context)")
    p.add_argument("--limit", type=int, default=0, help="cap symbols (info only); 0 = all")
    a = p.parse_args()

    roster = fetch_roster()
    save_roster(roster)
    if a.cmd == "roster":
        return

    symbols = [yahoo_symbol(s) for s in roster["Symbol"].astype(str)]
    if a.cmd == "bars":
        write_day_partitions(pull_bars(symbols, a.period))
    else:
        pull_info(symbols, a.limit)


if __name__ == "__main__":
    main()

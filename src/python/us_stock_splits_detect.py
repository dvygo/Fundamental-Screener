#!/usr/bin/env python3
"""Detect US stock splits -> data/store/us_stock_splits.parquet.

No single source gives (company, exact date, exact ratio) directly, so this
cross-validates three already-loaded primary sources instead of trusting one:

    sec_facts (EntityCommonStockSharesOutstanding)   -> WHICH company, WHICH
                                                          filing-bounded window
    databento_ohlcv (raw close, per session)         -> the EXACT day and the
                                                          EXACT ratio actually
                                                          traded

THE STORED ratio IS NEVER ROUNDED OR SNAPPED TO A CLEAN FRACTION
It is always `open[effective_date] / close[effective_date - 1]`, full float
precision, straight off Databento's raw bars. A real split's implied ratio
lands close to a human-recognizable fraction (2.0, 0.1, ...) but is not forced
onto one — see the AAPL cases below, both off by under 1%. Forcing it to
"exactly 4.0" would introduce error the raw computation did not have; the
adjustment factor's job is making the price series continuous, not matching a
label a human recognizes.

WHY SHARES OUTSTANDING IS THE CANDIDATE SOURCE, NOT THE RATIO CONCEPT
XBRL has a purpose-built concept, StockholdersEquityNoteStockSplitConversionRatio1,
that states a declared ratio directly. It was tried first and rejected as the
PRIMARY detector: only 2,365 filers use it, against 15,174 for
EntityCommonStockSharesOutstanding (every filer reports this — it is a required
cover-page item). AAPL itself has ZERO facts under the ratio concept despite two
well-known splits (7-for-1 in 2014, 4-for-1 in 2020) — a detector keyed on that
concept alone would have missed Apple's own history.

THE TRIGGER NEEDS A TOLERANCE BAND — THIS IS NOT THE SAME MISTAKE AS ROUNDING
Checked directly: AAPL's 2020 split computes as 17.00180e9 / 4.275634e9 =
3.976440 -- 0.6% off clean 4.0, because ordinary share activity (buybacks,
ESOP) landed in the same reporting quarter. An exact-membership test
(`ratio == 4.0`) would silently miss it. A relative-tolerance test
(`abs(ratio/4.0 - 1) < CANDIDATE_TOLERANCE`) is required, and it is a threshold
decision like GAP_DAYS or REUSE_MIN_VOLUME elsewhere in this project — it only
decides what gets INVESTIGATED. It never touches the number that gets stored or
applied; that always comes from the raw price computation below. Checked that
this band is safe: AAPL's own routine quarterly buyback noise sits at
0.98-1.006 across 60+ consecutive quarters, nowhere near any clean split
fraction — real splits and organic share-count drift do not overlap.

CONFIRMATION, NOT ASSUMPTION
A shares-outstanding candidate is only written as a real split if Databento
independently shows a same-symbol, same-window price move in the expected
direction and rough magnitude (day-over-day ratio within
CONFIRM_TOLERANCE of 1/shares_ratio). Candidates that don't confirm — wrong
symbol mapping, no Databento coverage, or the shares-outstanding jump was
something else (a large one-time issuance, not a split) — are written with
ratio=NULL and confidence='unconfirmed', visible for audit but excluded from
any price adjustment. Nothing is applied on a guess.

Usage:
    python src/python/us_stock_splits_detect.py
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import duckdb
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("splits")

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "data" / "store"
FACTS = STORE / "sec_facts.parquet"
FILERS = STORE / "sec_filers.parquet"
DBN = ROOT / "data" / "extracts_us" / "_meta" / "databento_ohlcv.parquet"
OUT = STORE / "us_stock_splits.parquet"

# Relative tolerance for the CANDIDATE TRIGGER only (shares-outstanding ratio
# vs a recognizable split fraction). Calibrated against real cases: AAPL's two
# splits sit at 0.6% and 0.7% off clean; routine buyback drift never comes
# closer than several percent to any fraction on this list. 3% leaves margin
# without reaching into buyback-noise territory.
CANDIDATE_TOLERANCE = 0.03

# Relative tolerance for CONFIRMING a candidate against Databento's actual
# price move. Looser than the candidate trigger because the price move is
# corroboration, not the primary filter, and can carry its own noise (the
# session's open vs the true first post-split print, e.g.).
CONFIRM_TOLERANCE = 0.15

# Forward splits (ratio > 1) and their reverse counterparts, both directions,
# covering the common cases. A ratio need only be close to ONE of these to
# trigger a candidate.
CLEAN_RATIOS = [
    2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 50, 100,
    3 / 2, 5 / 4, 5 / 3, 4 / 3,
]
CLEAN_RATIOS += [1 / r for r in CLEAN_RATIOS]


def nearest_clean_ratio(ratio: float) -> float | None:
    for c in CLEAN_RATIOS:
        if abs(ratio / c - 1) < CANDIDATE_TOLERANCE:
            return c
    return None


def main() -> None:
    t0 = time.time()
    con = duckdb.connect()

    log.info("finding shares-outstanding candidates...")
    # DISTINCT on (cik, end, val) first: two filings can report the same
    # period end (e.g. an 8-K then the 10-Q), and lag() over undeduplicated
    # rows emits a spurious val/val = 1.000000 "candidate" between them. Found
    # running this against AAPL, where it wrongly paired 2009-10-16 with itself.
    con.execute(f"""
        CREATE TABLE periods AS
        SELECT DISTINCT cik, "end", val
        FROM read_parquet('{FACTS.as_posix()}')
        WHERE concept = 'EntityCommonStockSharesOutstanding' AND val > 0
    """)
    con.execute("""
        CREATE TABLE pairs AS
        SELECT cik, "end",
               lag("end") OVER (PARTITION BY cik ORDER BY "end") AS prev_end,
               val,
               lag(val) OVER (PARTITION BY cik ORDER BY "end") AS prev_val
        FROM periods
    """)
    pairs = con.execute("""
        SELECT cik, prev_end, "end", prev_val, val, val / prev_val AS shares_ratio
        FROM pairs WHERE prev_val > 0
    """).fetchall()
    log.info("%d consecutive filing pairs", len(pairs))

    candidates = []
    for cik, prev_end, end, prev_val, val, shares_ratio in pairs:
        clean = nearest_clean_ratio(shares_ratio)
        if clean is not None:
            candidates.append((cik, prev_end, end, shares_ratio, clean))
    log.info("%d candidates within %.0f%% of a clean split ratio",
             len(candidates), CANDIDATE_TOLERANCE * 100)

    # cik -> symbol(s), same dash-normalisation as us_sec_symbol in db.js.
    con.execute(f"""
        CREATE TABLE cik_symbol AS
        SELECT cik, upper(replace(trim(unnest(str_split(tickers, ','))), '.', '-')) AS symbol
        FROM read_parquet('{FILERS.as_posix()}')
        WHERE tickers IS NOT NULL AND tickers <> ''
    """)
    con.execute(f"CREATE VIEW dbn AS SELECT * FROM read_parquet('{DBN.as_posix()}')")

    confirmed = unconfirmed = no_symbol = 0
    rows = []
    for cik, prev_end, end, shares_ratio, clean in candidates:
        syms = [r[0] for r in con.execute(
            "SELECT symbol FROM cik_symbol WHERE cik = ?", [cik]).fetchall()]
        if not syms:
            no_symbol += 1
            rows.append((None, cik, None, None, None, shares_ratio, clean,
                         "unconfirmed_no_symbol", str(prev_end), str(end)))
            continue

        best = None
        for sym in syms:
            # Bars in the filing-bounded window, in the SAME series only —
            # crossing a Databento series_id boundary here would be comparing
            # two different instruments, the exact trap us_databento_load.py
            # exists to prevent.
            bars = con.execute("""
                SELECT date, series_id, open, close,
                       lag(close) OVER (PARTITION BY series_id ORDER BY date) AS prev_close
                FROM dbn WHERE symbol = ? AND date BETWEEN ? AND ?
                ORDER BY date
            """, [sym, prev_end, end]).fetchall()
            for date, series_id, open_, close, prev_close in bars:
                if not prev_close or prev_close <= 0:
                    continue
                day_ratio = open_ / prev_close
                # Expect price to move opposite shares outstanding: a forward
                # split (shares_ratio > 1) should show day_ratio ~= 1/shares_ratio.
                expected = 1 / shares_ratio
                if abs(day_ratio / expected - 1) < CONFIRM_TOLERANCE:
                    dev = abs(day_ratio / expected - 1)
                    if best is None or dev < best[-1]:
                        best = (sym, date, day_ratio, dev)

        if best:
            sym, date, day_ratio, _ = best
            rows.append((sym, cik, str(date), day_ratio, "price_implied",
                        shares_ratio, clean, "confirmed", str(prev_end), str(end)))
            confirmed += 1
        else:
            rows.append((syms[0], cik, None, None, None, shares_ratio, clean,
                        "unconfirmed_no_price_match", str(prev_end), str(end)))
            unconfirmed += 1

    log.info("%d confirmed, %d unconfirmed (no price match), %d no symbol mapping",
             confirmed, unconfirmed, no_symbol)

    df = pd.DataFrame(rows, columns=[
        "symbol", "cik", "effective_date", "ratio", "ratio_source",
        "shares_ratio", "nearest_clean_ratio", "confidence",
        "window_start", "window_end",
    ])
    con.register("_rows", df)
    con.execute(f"""
        COPY (SELECT * FROM _rows ORDER BY confidence, symbol, effective_date)
        TO '{OUT.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    log.info("wrote %s (%.1f KiB) in %.0fs",
             OUT, OUT.stat().st_size / 1024, time.time() - t0)


if __name__ == "__main__":
    main()

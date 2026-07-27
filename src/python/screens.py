"""Layer A screens (requirement.md 1-5) - DuckDB SQL over bhavcopy on disk.

ELT: nothing pre-baked. Reads bhavcopy CSVs straight from the decompressed
working root (`data/extracts/*/`) and computes the screens at query time. As
more daily folders land, the N-day screens (2, 3, 5) deepen automatically - the
DISTINCT on event dates also absorbs the weekly download overlap (no manual
dedupe needed).

(v1 reads local disk. MinIO/WORM serving is v2 - flip the globs back to
`s3://raw/` and restore the httpfs/S3 config in connect() when that lands.)

Screens:
  1  52-week HIGH trigger - last session
  2  52-week HIGH - event count over last N days (per symbol)
  3  52-week LOW  - last session + N-day count
  4  Top gainers / losers - two tables
  5  Top gainers - recurrence count over last N days (per symbol)

Usage:
  python src/screens.py 1
  python src/screens.py 2 --n 30
  python src/screens.py 4 --top 20
  python src/screens.py all --n 30 --top 20
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
EXTRACTS = ROOT / "data" / "extracts"


def connect():
    con = duckdb.connect()
    _base_views(con)
    return con


# NSE month names are UPPERCASE ("23-JUL-2025"); strptime %b matches case-insensitively.
_D = "try_strptime({0}, '%d-%b-%Y')::date"


def _base_views(con):
    bhav = f"{EXTRACTS.as_posix()}/*/sec_bhavdata_full*.csv"
    wk = f"{EXTRACTS.as_posix()}/*/CM_52_wk_High_low*.csv"
    sec = f"{EXTRACTS.as_posix()}/*/NSE_CM_security_*.csv"
    bh = f"{EXTRACTS.as_posix()}/*/bh*.csv"

    # daily EQ prices, one row per (symbol, session)
    con.execute(f"""
      CREATE OR REPLACE VIEW prices AS
      SELECT {_D.format('date1')} AS as_of,
             trim(symbol) AS symbol, trim(series) AS series,
             TRY_CAST(prev_close AS DOUBLE) AS prev_close,
             TRY_CAST(close_price AS DOUBLE) AS close,
             TRY_CAST(ttl_trd_qnty AS DOUBLE) AS qty,
             TRY_CAST(turnover_lacs AS DOUBLE) AS turnover_lacs,
             round((TRY_CAST(close_price AS DOUBLE) - TRY_CAST(prev_close AS DOUBLE))
                   / nullif(TRY_CAST(prev_close AS DOUBLE), 0) * 100, 2) AS pct_change
      FROM read_csv('{bhav}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
      WHERE trim(series) = 'EQ'
    """)

    # a 52-week HIGH "event" = a (symbol, date) the high was set on.
    # DISTINCT collapses the same event repeated across overlapping daily files.
    con.execute(f"""
      CREATE OR REPLACE VIEW hi52 AS
      SELECT DISTINCT trim(symbol) AS symbol, trim(series) AS series,
             {_D.format('_52_week_high_date')} AS event_date,
             TRY_CAST(replace(adjusted_52_week_high, ' ', '') AS DOUBLE) AS price
      FROM read_csv('{wk}', header=true, all_varchar=true, normalize_names=true,
                    skip=2, union_by_name=true)
      WHERE {_D.format('_52_week_high_date')} IS NOT NULL AND trim(series) = 'EQ'
    """)
    con.execute(f"""
      CREATE OR REPLACE VIEW lo52 AS
      SELECT DISTINCT trim(symbol) AS symbol, trim(series) AS series,
             {_D.format('_52_week_low_dt')} AS event_date,
             TRY_CAST(replace(adjusted_52_week_low, ' ', '') AS DOUBLE) AS price
      FROM read_csv('{wk}', header=true, all_varchar=true, normalize_names=true,
                    skip=2, union_by_name=true)
      WHERE {_D.format('_52_week_low_dt')} IS NOT NULL AND trim(series) = 'EQ'
    """)

    # official company name per symbol (NSE security master), exact FinInstrmNm
    # string as-is. Not every symbol has an EQ row (SME board symbols only ever
    # list under SM/SL/SQ/ST) so this doesn't filter by series - just picks the
    # most recent date folder's row per symbol (name is the same across series).
    con.execute(f"""
      CREATE OR REPLACE VIEW security AS
      SELECT symbol, company_name FROM (
        SELECT trim(tckrsymb) AS symbol, trim(fininstrmnm) AS company_name,
               row_number() OVER (PARTITION BY trim(tckrsymb) ORDER BY filename DESC, sctysrs) AS rn
        FROM read_csv('{sec}', header=true, all_varchar=true, normalize_names=true,
                      filename=true, union_by_name=true)
      ) WHERE rn = 1
    """)

    # upper/lower circuit hitters - real NSE data, not a heuristic: bh<date>.csv
    # ("securities which have hit their price bands during the day", per NSE's
    # own readme.txt shipped in the daily PR bundle). H = upper, L = lower.
    # No date column in the file itself - as_of comes from the YYYYMMDD extracts
    # folder embedded in the file's own path.
    con.execute(f"""
      CREATE OR REPLACE VIEW circuit AS
      SELECT strptime(regexp_extract(filename, '/(\\d{{8}})/[^/]+$', 1), '%Y%m%d')::date AS as_of,
             trim(symbol) AS symbol, trim(series) AS series, trim(highlow) AS hit
      FROM read_csv('{bh}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
      WHERE trim(series) = 'EQ'
    """)


def _show(con, title, sql):
    print(f"\n=== {title} ===")
    rel = con.execute(sql)
    cols = [d[0] for d in rel.description]
    rows = rel.fetchall()
    if not rows:
        print("(no rows)")
        return
    w = [max(len(str(cols[i])), max(len(str(r[i])) for r in rows)) for i in range(len(cols))]
    print("  " + "  ".join(str(cols[i]).ljust(w[i]) for i in range(len(cols))))
    print("  " + "  ".join("-" * w[i] for i in range(len(cols))))
    for r in rows[:50]:
        print("  " + "  ".join(str(r[i]).ljust(w[i]) for i in range(len(cols))))
    if len(rows) > 50:
        print(f"  ... {len(rows)} rows")


# ---------------------------------------------------------------- screens
def screen1(con, **_):
    _show(con, "1 - 52-week HIGH trigger - last session", """
      WITH d AS (SELECT max(event_date) md FROM hi52)
      SELECT h.event_date, h.symbol, s.company_name, h.series, h.price
      FROM hi52 h
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = h.symbol
      WHERE h.event_date = d.md
      ORDER BY h.symbol
    """)


def screen2(con, n, **_):
    _show(con, f"2 - 52-week HIGH - events in last {n} days (per symbol)", f"""
      WITH d AS (SELECT max(event_date) md FROM hi52)
      SELECT h.symbol, s.company_name,
             count(DISTINCT h.event_date) AS high_events,
             min(h.event_date) AS first_event, max(h.event_date) AS last_event
      FROM hi52 h
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = h.symbol
      WHERE h.event_date > d.md - INTERVAL {n} DAY
      GROUP BY h.symbol, s.company_name
      ORDER BY high_events DESC, h.symbol
    """)


def screen3(con, n, **_):
    _show(con, "3a - 52-week LOW trigger - last session", """
      WITH d AS (SELECT max(event_date) md FROM lo52)
      SELECT l.event_date, l.symbol, s.company_name, l.series, l.price
      FROM lo52 l
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = l.symbol
      WHERE l.event_date = d.md
      ORDER BY l.symbol
    """)
    _show(con, f"3b - 52-week LOW - events in last {n} days (per symbol)", f"""
      WITH d AS (SELECT max(event_date) md FROM lo52)
      SELECT l.symbol, s.company_name,
             count(DISTINCT l.event_date) AS low_events,
             min(l.event_date) AS first_event, max(l.event_date) AS last_event
      FROM lo52 l
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = l.symbol
      WHERE l.event_date > d.md - INTERVAL {n} DAY
      GROUP BY l.symbol, s.company_name
      ORDER BY low_events DESC, l.symbol
    """)


def screen4(con, top, **_):
    _show(con, f"4a - Top {top} GAINERS - last session", f"""
      WITH d AS (SELECT max(as_of) md FROM prices)
      SELECT p.symbol, s.company_name, p.close, p.prev_close, p.pct_change, p.qty, p.turnover_lacs
      FROM prices p
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = p.symbol
      WHERE p.as_of = d.md AND p.pct_change IS NOT NULL
      ORDER BY p.pct_change DESC LIMIT {top}
    """)
    _show(con, f"4b - Top {top} LOSERS - last session", f"""
      WITH d AS (SELECT max(as_of) md FROM prices)
      SELECT p.symbol, s.company_name, p.close, p.prev_close, p.pct_change, p.qty, p.turnover_lacs
      FROM prices p
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = p.symbol
      WHERE p.as_of = d.md AND p.pct_change IS NOT NULL
      ORDER BY p.pct_change ASC LIMIT {top}
    """)


def screen5(con, n, top, **_):
    _show(con, f"5 - Top-gainer recurrence - last {n} days, top {top}/session", f"""
      WITH d AS (SELECT max(as_of) md FROM prices),
      ranked AS (
        SELECT as_of, symbol, pct_change,
               row_number() OVER (PARTITION BY as_of ORDER BY pct_change DESC) AS rnk
        FROM prices, d
        WHERE pct_change IS NOT NULL AND as_of > d.md - INTERVAL {n} DAY
      )
      SELECT r.symbol, s.company_name,
             count(*) AS times_in_top,
             round(avg(r.pct_change), 2) AS avg_pct,
             max(r.as_of) AS last_seen
      FROM ranked r
      LEFT JOIN security s ON s.symbol = r.symbol
      WHERE r.rnk <= {top}
      GROUP BY r.symbol, s.company_name
      ORDER BY times_in_top DESC, avg_pct DESC
    """)


def screen6(con, **_):
    _show(con, "6a - UPPER circuit - last session", """
      WITH d AS (SELECT max(as_of) md FROM circuit)
      SELECT c.as_of, c.symbol, s.company_name, c.series
      FROM circuit c
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = c.symbol
      WHERE c.as_of = d.md AND c.hit = 'H'
      ORDER BY c.symbol
    """)
    _show(con, "6b - LOWER circuit - last session", """
      WITH d AS (SELECT max(as_of) md FROM circuit)
      SELECT c.as_of, c.symbol, s.company_name, c.series
      FROM circuit c
      CROSS JOIN d
      LEFT JOIN security s ON s.symbol = c.symbol
      WHERE c.as_of = d.md AND c.hit = 'L'
      ORDER BY c.symbol
    """)


SCREENS = {1: screen1, 2: screen2, 3: screen3, 4: screen4, 5: screen5, 6: screen6}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Layer A screens over MinIO bhavcopy")
    ap.add_argument("screen", help="1-6 or 'all'")
    ap.add_argument("--n", type=int, default=30, help="N-day window (screens 2,3,5)")
    ap.add_argument("--top", type=int, default=20, help="depth (screens 4,5)")
    args = ap.parse_args()
    con = connect()
    which = SCREENS.keys() if args.screen == "all" else [int(args.screen)]
    for s in which:
        SCREENS[s](con, n=args.n, top=args.top)

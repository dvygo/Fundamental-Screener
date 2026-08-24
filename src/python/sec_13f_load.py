#!/usr/bin/env python3
"""SEC Form 13F data sets -> two Parquet tables. Institutional holdings.

    data/raw/sec13f/*_form13f.zip     (one per quarterly data set, ~99 MB each)
        │  read IN PLACE — never extracted
        ▼
    data/store/sec_13f_filings.parquet    one row per 13F filing
    data/store/sec_13f_holdings.parquet   one row per reported position

WHAT THIS IS
  Who owns what. Every manager with over $100M in 13(f) securities reports each
  position at quarter end: issuer, CUSIP, market value, share count, whether it
  is a put or a call, and — the part no vendor summary carries — how much of the
  vote they actually control.

  `voting_auth_sole` vs `_shared` vs `_none` is what separates a real position
  from custody. An index fund holding 700M shares with no voting authority is a
  different fact from an activist holding 7M with sole authority.

THE FILE IS ORGANISED BY FILING DATE, NOT PERIOD
  The Mar-May 2026 data set contains 71 distinct periodofreport values going
  back to 30-JUN-2008, because managers file late amendments for old quarters.
  A loader that assumes one file == one quarter mis-dates everything in it. Both
  dates are therefore kept: `period` is what the holdings describe, `filed` is
  when the filing arrived.

VALUES ARE DOLLARS FROM 2023, THOUSANDS BEFORE
  SEC moved Form 13F value reporting from thousands to whole dollars. Because
  the archive is organised by FILING date, the convention is uniform within a
  file and keyed to when it was filed, not to the period it covers — a
  2026-filed amendment for a 2019 quarter reports dollars. Verified on the
  Mar-May 2026 set: median value-per-share is $50-90 for every period in it,
  including 2019, so no scale break appears inside one file.

  `value_usd` normalises both conventions; `value_raw` keeps what was filed.
  NOTE: the pre-2023 branch is UNVERIFIED — no older data set has been loaded
  yet. The loader logs loudly when it takes that path so the first old file
  gets checked rather than trusted.

AMENDMENTS ARE KEPT
  A manager who amends a filing appears twice for the same position. In the
  Mar-May 2026 set Vanguard reports NVDA at both $268.519bn and $268.324bn with
  identical share counts — original and amendment. Summing naively inflates
  everything; that file's raw total is $81.5 trillion, which is not a real
  number. Both rows are kept, `is_amendment` marks them, and it is the caller's
  job to pick a vintage — the same rule companyfacts follows for restatements.

Usage:
    python src/python/sec_13f_load.py                  # every zip in data/raw/sec13f
    python src/python/sec_13f_load.py --zip <path>
"""
from __future__ import annotations

import argparse
import logging
import os
import tempfile
import time
import zipfile
from pathlib import Path

import duckdb

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("sec13f")

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "sec13f"
STORE = ROOT / "data" / "store"

FILINGS_OUT = STORE / "sec_13f_filings.parquet"
HOLDINGS_OUT = STORE / "sec_13f_holdings.parquet"

# Filings on or after this date report whole dollars; earlier ones thousands.
DOLLARS_FROM = "2023-01-01"

# The four tables actually used. SIGNATURE, OTHERMANAGER and OTHERMANAGER2 are
# left unread: signatures are administrative, and the othermanager linkage is
# only meaningful for the joint-filing edge case, which nothing queries yet.
TABLES = ["SUBMISSION", "COVERPAGE", "INFOTABLE", "SUMMARYPAGE"]

READ = ("read_csv('{p}', delim='\t', header=true, all_varchar=true, "
        "normalize_names=true, union_by_name=true)")


def stage(con: duckdb.DuckDBPyConnection, zips: list[Path], tmp: str) -> None:
    """Extract the needed TSVs from every zip into one temp dir, then view them.

    Members are staged rather than read in place because DuckDB cannot read
    inside a ZIP container. One directory holding every zip's copy of a table
    lets a single read_csv glob cover the whole archive set.
    """
    for zp in zips:
        z = zipfile.ZipFile(zp)
        have = set(z.namelist())
        for t in TABLES:
            name = f"{t}.tsv"
            if name not in have:
                log.warning("%s has no %s", zp.name, name)
                continue
            out = Path(tmp) / f"{t}__{zp.stem}.tsv"
            out.write_bytes(z.read(name))
        log.info("staged %s", zp.name)

    for t in TABLES:
        glob = (Path(tmp) / f"{t}__*.tsv").as_posix()
        con.execute(f"CREATE OR REPLACE VIEW {t} AS SELECT * FROM "
                    + READ.format(p=glob))


def main() -> None:
    p = argparse.ArgumentParser(description="shred SEC Form 13F data sets -> parquet")
    p.add_argument("--zip", help="a single data set; default is every zip in data/raw/sec13f")
    a = p.parse_args()

    zips = [Path(a.zip)] if a.zip else sorted(RAW.glob("*.zip"))
    if not zips:
        raise SystemExit(f"no zips found under {RAW}")
    missing = [z for z in zips if not z.is_file()]
    if missing:
        raise SystemExit(f"no such file: {missing[0]}")

    STORE.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    con = duckdb.connect()

    with tempfile.TemporaryDirectory(prefix="sec13f_") as tmp:
        stage(con, zips, tmp)

        # One row per filing. COVERPAGE carries the manager; SUBMISSION the
        # dates. Periods are NSE-style DD-MON-YYYY, so strptime, not a cast:
        # comparing them as text sorts alphabetically and silently returns a
        # nonsense range rather than an error.
        con.execute(f"""
            CREATE OR REPLACE TABLE filings AS
            SELECT s.accession_number                              AS accn,
                   s.cik,
                   -- BOTH dates are DD-MON-YYYY and BOTH need strptime. Using a
                   -- plain TRY_CAST on filing_date returned NULL for all 11,761
                   -- rows, which made the dollars-vs-thousands test below NULL,
                   -- fall through to ELSE, and inflate every value 1000x. It
                   -- looked plausible -- Vanguard's NVDA position read $268
                   -- trillion instead of $268 billion -- and nothing errored.
                   try_strptime(s.filing_date, '%d-%b-%Y')::date    AS filed,
                   try_strptime(s.periodofreport, '%d-%b-%Y')::date AS period,
                   s.submissiontype                                AS submission_type,
                   c.filingmanager_name                            AS manager,
                   c.filingmanager_city                            AS manager_city,
                   c.filingmanager_stateorcountry                  AS manager_state,
                   c.crdnumber                                     AS crd_number,
                   c.reporttype                                    AS report_type,
                   lower(trim(c.isamendment)) IN ('y','yes','true','1') AS is_amendment,
                   c.amendmentno                                   AS amendment_no,
                   c.amendmenttype                                 AS amendment_type,
                   TRY_CAST(p.tableentrytotal AS BIGINT)           AS positions_reported,
                   TRY_CAST(p.tablevaluetotal AS DOUBLE)           AS value_total_raw
            FROM SUBMISSION s
            LEFT JOIN COVERPAGE   c ON c.accession_number = s.accession_number
            LEFT JOIN SUMMARYPAGE p ON p.accession_number = s.accession_number
        """)

        # One row per position. Joined to filings so every holding carries its
        # manager and both dates without a second lookup downstream.
        con.execute(f"""
            CREATE OR REPLACE TABLE holdings AS
            SELECT f.accn, f.cik, f.filed, f.period, f.manager, f.is_amendment,
                   i.infotable_sk                          AS position_sk,
                   i.nameofissuer                          AS issuer,
                   i.titleofclass                          AS class,
                   i.cusip,
                   nullif(trim(i.figi), '')                AS figi,
                   TRY_CAST(i._value AS DOUBLE)            AS value_raw,
                   -- Normalised to dollars. Pre-2023 filings report thousands;
                   -- keyed on FILED, not period, because the archive is
                   -- organised by filing date and a late amendment uses the
                   -- convention in force when it was filed.
                   CASE WHEN f.filed >= DATE '{DOLLARS_FROM}'
                        THEN TRY_CAST(i._value AS DOUBLE)
                        ELSE TRY_CAST(i._value AS DOUBLE) * 1000 END AS value_usd,
                   TRY_CAST(i.sshprnamt AS DOUBLE)         AS shares,
                   i.sshprnamttype                         AS shares_type,
                   nullif(trim(i.putcall), '')             AS put_call,
                   i.investmentdiscretion                  AS discretion,
                   TRY_CAST(i.voting_auth_sole   AS DOUBLE) AS voting_sole,
                   TRY_CAST(i.voting_auth_shared AS DOUBLE) AS voting_shared,
                   TRY_CAST(i.voting_auth_none   AS DOUBLE) AS voting_none
            FROM INFOTABLE i
            JOIN filings f ON f.accn = i.accession_number
        """)

        nf, nh = (con.execute("SELECT count(*) FROM filings").fetchone()[0],
                  con.execute("SELECT count(*) FROM holdings").fetchone()[0])
        old = con.execute(
            f"SELECT count(*) FROM filings WHERE filed < DATE '{DOLLARS_FROM}'").fetchone()[0]
        if old:
            log.warning("%d filings predate %s — their values were scaled x1000 to "
                        "dollars. THIS BRANCH IS UNVERIFIED; spot-check one before "
                        "trusting it.", old, DOLLARS_FROM)

        mgrs, periods = con.execute(
            "SELECT count(DISTINCT manager), count(DISTINCT period) FROM filings").fetchone()
        amend = con.execute("SELECT count(*) FROM filings WHERE is_amendment").fetchone()[0]
        log.info("%d filings (%d amendments) / %d holdings / %d managers / %d periods",
                 nf, amend, nh, mgrs, periods)

        for tbl, out in (("filings", FILINGS_OUT), ("holdings", HOLDINGS_OUT)):
            con.execute(f"COPY (SELECT * FROM {tbl} ORDER BY period DESC, accn) "
                        f"TO '{out.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
            log.info("wrote %s (%.1f MiB)", out, out.stat().st_size / 1048576)

    con.close()
    log.info("done in %.0fs", time.time() - t0)


if __name__ == "__main__":
    main()

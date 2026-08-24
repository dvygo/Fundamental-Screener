#!/usr/bin/env python3
"""SEC EDGAR submissions bulk -> two Parquet tables. Full market.

    submissions.zip  (1.45 GB, 987,372 entries)
        │  read IN PLACE — never extracted
        ▼
    data/store/sec_filers.parquet    one row per filer   (~982k)
    data/store/sec_filings.parquet   one row per filing  (millions)

WHY THE ZIP IS NEVER EXTRACTED
  987,372 files is pathological for NTFS. Extracting to disk creates all of
  them; extracting into single-node MinIO is WORSE, because it stores each
  object as a directory holding an xl.meta plus data parts — roughly 987k
  directories and ~2M files, on the same filesystem. Neither solves the problem
  they were reached for. Python's zipfile reads the central directory once
  (2.9s measured) and then serves any member by name in ~4ms, so the archive
  stays one file and this shreds straight out of it.

THE TRAP: HISTORY IS SPLIT ACROSS TWO PLACES
  A filer's JSON carries `filings.recent`, which is CAPPED near 1,000 filings.
  Everything older lives in separate `CIK…-submissions-NNN.json` entries listed
  under `filings.files`. Apple: recent covers 2015-06-04 -> 2026-08-20 (1,001
  filings) while an overflow file holds 1994-01-26 -> 2015-06-02 (1,240 more).
  Read only the main files and 32 years silently becomes 11 — no error, no gap,
  just a truncated history. Both are read here, which is also why the archive
  holds 982,023 main entries and 5,349 overflow ones rather than one per filer.

Rows are batched into an on-disk DuckDB rather than accumulated in Python:
millions of filing rows will not fit comfortably in memory, and a crash halfway
through a 10-minute run should not cost the whole run.

Usage:
    python src/python/sec_submissions_load.py --zip <path>
    python src/python/sec_submissions_load.py --zip <path> --limit 5000   # smoke test
"""
from __future__ import annotations

import argparse
import json
import logging
import time
import zipfile
from pathlib import Path

import duckdb
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("sec_submissions")

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "data" / "store"

# The columnar arrays SEC uses inside both `filings.recent` and the overflow
# files. Same field set in each, which is why one reader handles both.
FILING_COLS = [
    "accessionNumber", "filingDate", "reportDate", "acceptanceDateTime", "act",
    "form", "fileNumber", "filmNumber", "items", "core_type", "size",
    "isXBRL", "isInlineXBRL", "isXBRLNumeric", "primaryDocument",
    "primaryDocDescription",
]

def _join(seq) -> str | None:
    """Comma-join a list, dropping nulls.

    SEC ships null entries inside tickers / exchanges / formerNames — a plain
    ",".join() raises "expected str instance, NoneType found" and, because the
    whole filer is wrapped in one try, took that filer AND ALL ITS FILINGS out
    of the output. 299 filers were lost this way before the guard.
    """
    vals = [str(x) for x in (seq or []) if x is not None and str(x) != ""]
    return ",".join(vals) or None


FILER_COLS = [
    "cik", "name", "tickers", "exchanges", "sic", "sic_description",
    "entity_type", "ein", "fiscal_year_end", "category",
    "state_of_incorporation", "former_names", "filing_count",
]

BATCH = 200_000  # rows per flush


def _rows_from_block(cik: str, block: dict) -> list[tuple]:
    """A columnar filing block -> row tuples. Arrays are parallel by index."""
    n = len(block.get("accessionNumber") or [])
    if not n:
        return []
    cols = [block.get(c) or [None] * n for c in FILING_COLS]
    out = []
    for i in range(n):
        vals = []
        for c in cols:
            v = c[i] if i < len(c) else None
            # `items` is a list on 8-Ks; flatten so the column stays scalar.
            vals.append(",".join(v) if isinstance(v, list) else v)
        out.append((cik, *[None if v == "" else v for v in vals]))
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="shred SEC submissions.zip -> parquet")
    p.add_argument("--zip", required=True, help="path to submissions.zip")
    p.add_argument("--limit", type=int, default=0, help="cap filers (smoke test); 0 = all")
    a = p.parse_args()

    zpath = Path(a.zip)
    if not zpath.is_file():
        raise SystemExit(f"no such file: {zpath}")

    STORE.mkdir(parents=True, exist_ok=True)
    # On-disk, not :memory: — millions of filing rows would otherwise have to
    # fit in RAM alongside the shredding.
    work = STORE / ".sec_submissions.duckdb"
    work.unlink(missing_ok=True)
    con = duckdb.connect(str(work))
    con.execute(f"""CREATE TABLE filings (cik VARCHAR, {
        ", ".join(f'"{c}" VARCHAR' for c in FILING_COLS)})""")
    con.execute(f"""CREATE TABLE filers ({", ".join(f'"{c}" VARCHAR' for c in FILER_COLS)})""")

    z = zipfile.ZipFile(zpath)
    names = z.namelist()
    mains = [n for n in names if "-submissions-" not in n and n.endswith(".json")]
    overflow: dict[str, list[str]] = {}
    for n in names:
        if "-submissions-" in n:
            overflow.setdefault(n.split("-submissions-")[0] + ".json", []).append(n)
    if a.limit:
        mains = mains[: a.limit]
    log.info("%d filers, %d with overflow history", len(mains), len(overflow))

    fb: list[tuple] = []
    rb: list[tuple] = []
    t0 = time.time()
    done = failed = 0

    def flush():
        # register + INSERT FROM, NOT executemany. executemany binds one
        # statement per row and crawls at this volume — a 3,000-filer smoke test
        # had not finished in ten minutes, which extrapolates to days for the
        # full market. Handing DuckDB a whole frame is a single bulk insert.
        nonlocal fb, rb
        if rb:
            df = pd.DataFrame(rb, columns=["cik", *FILING_COLS]).astype(str)
            con.register("_rb", df)
            con.execute("INSERT INTO filings SELECT * FROM _rb")
            con.unregister("_rb")
            rb = []
        if fb:
            df = pd.DataFrame(fb, columns=FILER_COLS).astype(str)
            con.register("_fb", df)
            con.execute("INSERT INTO filers SELECT * FROM _fb")
            con.unregister("_fb")
            fb = []

    for i, name in enumerate(mains, 1):
        try:
            d = json.loads(z.read(name))
            cik = str(d.get("cik") or name[3:13]).lstrip("0") or "0"
            filings = d.get("filings") or {}
            rows = _rows_from_block(cik, filings.get("recent") or {})
            # The older history, without which long-lived filers are truncated.
            for ov in overflow.get(name, []):
                rows += _rows_from_block(cik, json.loads(z.read(ov)))
            rb.extend(rows)
            fb.append((
                cik,
                d.get("name"),
                _join(d.get("tickers")),
                _join(d.get("exchanges")),
                d.get("sic"), d.get("sicDescription"), d.get("entityType"),
                d.get("ein"), d.get("fiscalYearEnd"), d.get("category"),
                d.get("stateOfIncorporation"),
                _join(x.get("name") for x in (d.get("formerNames") or [])),
                str(len(rows)),
            ))
            done += 1
        except Exception as e:
            failed += 1
            if failed <= 5:
                log.warning("skip %s: %s", name, e)
        if len(rb) >= BATCH:
            flush()
        if i % 100_000 == 0:
            log.info("%d/%d filers, %.0fs elapsed", i, len(mains), time.time() - t0)

    flush()
    nf = con.execute("SELECT count(*) FROM filers").fetchone()[0]
    ng = con.execute("SELECT count(*) FROM filings").fetchone()[0]
    log.info("shredded %d filers / %d filings in %.0fs (failed %d)",
             nf, ng, time.time() - t0, failed)

    for tbl, out in (("filers", STORE / "sec_filers.parquet"),
                     ("filings", STORE / "sec_filings.parquet")):
        con.execute(f"COPY {tbl} TO '{out.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        log.info("wrote %s (%.1f MiB)", out, out.stat().st_size / 1048576)
    con.close()
    work.unlink(missing_ok=True)  # scratch only; the parquets are the output


if __name__ == "__main__":
    main()

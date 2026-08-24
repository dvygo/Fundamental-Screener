#!/usr/bin/env python3
"""SEC EDGAR companyfacts bulk -> two Parquet tables. Full market.

    companyfacts.zip  (1.31 GB, 20,251 entries)
        │  read IN PLACE — never extracted, same reason as submissions
        ▼
    data/store/sec_facts.parquet      one row per reported fact  (~110M)
    data/store/sec_concepts.parquet   one row per (taxonomy, concept)

WHAT THIS IS
  The numbers inside the filings. `submissions.zip` is the index — it says Apple
  filed a 10-K on 2009-10-27. This says net income in it was $3,496,000,000.
  Together they are the whole SEC lane; the join key is `accn`.

  Only 20,251 filers appear here versus 982,022 in submissions, because a filer
  shows up only once it has reported XBRL. Funds, individuals filing Forms 3/4
  and shell registrants have submissions rows and no facts.

RESTATEMENTS ARE KEPT, DELIBERATELY
  Apple's FY2007 net income appears twice for the SAME period:

      3,496,000,000  accn 0001193125-09-214859  form 10-K    filed 2009-10-27
      3,495,000,000  accn 0001193125-10-012091  form 10-K/A  filed 2010-01-25

  Not a duplicate — the amended filing revised it. Deduplicating on
  (concept, start, end) would silently pick one and destroy the only record that
  the figure ever moved. That audit trail is the entire reason for preferring
  this source over a vendor grid, so every fact is kept and the caller decides
  which vintage it wants (latest `filed` for current, or as-of a date for
  point-in-time).

TWO SHAPES OF FACT
  Duration facts (revenue, net income) carry `start` AND `end`.
  Instant facts (assets, cash, share counts) carry `end` only — `start` is null.
  Both land in the same table; a null `start` is the marker, not missing data.

LABELS LIVE IN A SEPARATE TABLE
  Each concept carries a `label` and a prose `description` — repeated on every
  one of its facts in the source JSON. Inlining them would add hundreds of bytes
  to each of 110M rows for text that varies only by concept. They go to
  sec_concepts.parquet instead, first-seen wins.

UNITS ARE NOT ALL MONEY
  Sampling found USD, EUR, GBP, CAD, CNY, HKD, ARS, EGP, plus per-share variants
  and non-financial counters: shares, Employee, Segment, Restaurant, Lease,
  Bitcoin, CryptoAsset, Rate, Integer. The unit is carried per row and callers
  MUST filter on it — summing across units produces nonsense.

Rows batch into an on-disk DuckDB rather than accumulating in Python: 110M rows
will not fit in memory, and a crash partway through should not cost the run.

Usage:
    python src/python/sec_companyfacts_load.py --zip <path>
    python src/python/sec_companyfacts_load.py --zip <path> --limit 200   # smoke test
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
log = logging.getLogger("sec_companyfacts")

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "data" / "store"

FACT_COLS = [
    "cik", "taxonomy", "concept", "unit",
    "start", "end", "val", "fy", "fp", "form", "filed", "frame", "accn",
]
CONCEPT_COLS = ["taxonomy", "concept", "label", "description"]

BATCH = 500_000  # fact rows per flush


def main() -> None:
    p = argparse.ArgumentParser(description="shred SEC companyfacts.zip -> parquet")
    p.add_argument("--zip", required=True, help="path to companyfacts.zip")
    p.add_argument("--limit", type=int, default=0, help="cap filers (smoke test); 0 = all")
    a = p.parse_args()

    zpath = Path(a.zip)
    if not zpath.is_file():
        raise SystemExit(f"no such file: {zpath}")

    STORE.mkdir(parents=True, exist_ok=True)
    work = STORE / ".sec_companyfacts.duckdb"
    work.unlink(missing_ok=True)
    con = duckdb.connect(str(work))
    # Typed, unlike the submissions loader. `val` is queried numerically by every
    # consumer, and at 110M rows an all-VARCHAR table costs real disk for a cast
    # that would then have to happen on every read.
    con.execute("""CREATE TABLE facts (
        cik VARCHAR, taxonomy VARCHAR, concept VARCHAR, unit VARCHAR,
        start DATE, "end" DATE, val DOUBLE, fy INTEGER, fp VARCHAR,
        form VARCHAR, filed DATE, frame VARCHAR, accn VARCHAR)""")
    con.execute("""CREATE TABLE concepts (
        taxonomy VARCHAR, concept VARCHAR, label VARCHAR, description VARCHAR)""")

    z = zipfile.ZipFile(zpath)
    names = [n for n in z.namelist() if n.endswith(".json")]
    names.sort()  # CIK########## is zero-padded, so this clusters output by filer
    if a.limit:
        names = names[: a.limit]
    log.info("%d filers with XBRL facts", len(names))

    rb: list[tuple] = []
    seen: dict[tuple[str, str], tuple] = {}
    t0 = time.time()
    done = failed = coerced = 0

    def flush():
        # register + INSERT FROM, not executemany — the submissions loader was
        # two orders of magnitude slower on executemany at a quarter of this
        # volume.
        nonlocal rb, coerced
        if not rb:
            return
        df = pd.DataFrame(rb, columns=FACT_COLS)
        # `val` is documented as numeric but is filer-typed; coerce rather than
        # abort, and COUNT what was coerced so a systematic problem is visible
        # instead of arriving as a column of quiet nulls.
        raw = df["val"]
        num = pd.to_numeric(raw, errors="coerce")
        coerced += int((num.isna() & raw.notna()).sum())
        df["val"] = num
        for c in ("start", "end", "filed"):
            df[c] = pd.to_datetime(df[c], errors="coerce").dt.date
        df["fy"] = pd.to_numeric(df["fy"], errors="coerce").astype("Int64")
        con.register("_rb", df)
        con.execute("INSERT INTO facts SELECT * FROM _rb")
        con.unregister("_rb")
        rb = []

    for i, name in enumerate(names, 1):
        try:
            d = json.loads(z.read(name))
            cik = str(d.get("cik") or name[3:13]).lstrip("0") or "0"
            for tax, cs in (d.get("facts") or {}).items():
                for concept, body in (cs or {}).items():
                    key = (tax, concept)
                    if key not in seen:
                        seen[key] = (tax, concept, body.get("label"), body.get("description"))
                    for unit, arr in (body.get("units") or {}).items():
                        for f in arr or ():
                            rb.append((
                                cik, tax, concept, unit,
                                f.get("start"), f.get("end"), f.get("val"),
                                f.get("fy"), f.get("fp"), f.get("form"),
                                f.get("filed"), f.get("frame"), f.get("accn"),
                            ))
            done += 1
        except Exception as e:
            failed += 1
            if failed <= 5:
                log.warning("skip %s: %s", name, e)
        if len(rb) >= BATCH:
            flush()
        if i % 2000 == 0:
            log.info("%d/%d filers, %.0fs elapsed", i, len(names), time.time() - t0)

    flush()
    if seen:
        cdf = pd.DataFrame(list(seen.values()), columns=CONCEPT_COLS)
        con.register("_cb", cdf)
        con.execute("INSERT INTO concepts SELECT * FROM _cb")
        con.unregister("_cb")

    nf = con.execute("SELECT count(*) FROM facts").fetchone()[0]
    nc = con.execute("SELECT count(*) FROM concepts").fetchone()[0]
    log.info("shredded %d filers / %d facts / %d concepts in %.0fs (failed %d)",
             done, nf, nc, time.time() - t0, failed)
    if coerced:
        log.warning("%d fact values were non-numeric and stored as NULL", coerced)

    for tbl, out in (("facts", STORE / "sec_facts.parquet"),
                     ("concepts", STORE / "sec_concepts.parquet")):
        con.execute(f"COPY {tbl} TO '{out.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        log.info("wrote %s (%.1f MiB)", out, out.stat().st_size / 1048576)
    con.close()
    work.unlink(missing_ok=True)  # scratch only; the parquets are the output


if __name__ == "__main__":
    main()

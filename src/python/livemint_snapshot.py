"""LiveMint news-sitemap snapshotter — a daily capture that accrues into history.

LiveMint publishes no archive. Its only machine-readable index is the pair of
Google-News sitemaps named in robots.txt, and they hold roughly a *week*:

    robots.txt  ──Sitemap:──▶  /sitemap/today.xml      (~95 urls)
                               /sitemap/yesterday.xml  (~195 urls)
        │   fetched once a day, saved verbatim
        ▼
    data/raw/livemint/sitemap/<YYYYMMDD>/{today,yesterday}.xml
        │   every snapshot on disk re-parsed, deduped by url
        ▼
    data/store/news.parquet   (url, title, section, publication_date, lastmod,
                                keywords, first_seen, last_seen, revisions, …)

Why this exists: the live feed in src/nodejs/src/news.js caches to a single
`today.xml` that is overwritten on every run, so nothing older than the current
fetch survives — HUNT's news signal has no history to score over. Miss a week
here and that week is gone for good: unlike a bhavcopy there is no backfill to
re-request, which is exactly why this runs daily and never deletes.

The two sitemaps are disjoint and partitioned by publication day — measured
2026-07-27, today.xml held 95 urls (94 of them published that day) and
yesterday.xml 195 (181 published the day before), sharing exactly zero.

The asymmetry that matters: today.xml is the day *so far*, truncated at fetch
time, while yesterday.xml is the day *completed* (94 stories mid-morning vs 181
for the finished day). So yesterday.xml is the authoritative historical record
and today.xml is only partial-recovery insurance — if a day's run is missed, its
yesterday.xml is gone for good and the prior day's today.xml is all that
survives of it. Both are captured; only yesterday.xml should be served as
history. Note yesterday.xml also carries a few stories published in the early
hours of the current day (to ~03:30 IST), so any union with a live pull of
today.xml must dedup on url.

Snapshots are keyed by IST date (the source publishes IST) so the partition is
the same no matter what timezone the box runs in. Re-running on the same day is
a no-op unless --force; the store is always rebuilt from whatever is on disk, so
it is idempotent and needs no checkpoint.

Async to the BOD process — nothing here touches data/extracts.

Usage:
    python src/python/livemint_snapshot.py                 # fetch + rebuild store
    python src/python/livemint_snapshot.py --force         # re-fetch today's snapshot
    python src/python/livemint_snapshot.py --rebuild-only  # no network, rebuild only
"""

from __future__ import annotations

import argparse
import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import duckdb
import httpx

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("livemint_snapshot")

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOTS = ROOT / "data" / "raw" / "livemint" / "sitemap"
STORE = ROOT / "data" / "store"
OUT = STORE / "news.parquet"

# The sitemap URLs are never written down here — they are read out of
# robots.txt, which is both the discovery mechanism and the permission to fetch
# them. Only these two are wanted; the rest of the Sitemap: lines are sections,
# liveblogs and commodity-price feeds with no news dates.
ROBOTS_URL = "https://www.livemint.com/robots.txt"
WANTED = ("today.xml", "yesterday.xml")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124 Safari/537.36")
DELAY_S = 2.0  # between requests — two small files, but pace anyway

IST = timezone(timedelta(hours=5, minutes=30))

NS = {
    "sm": "http://www.sitemaps.org/schemas/sitemap/0.9",
    "news": "http://www.google.com/schemas/sitemap-news/0.9",
    "image": "http://www.google.com/schemas/sitemap-image/1.1",
    "xhtml": "http://www.w3.org/1999/xhtml",
}

# LiveMint slugs end in the numeric story id: ...-11785129584411.html
_MSID = re.compile(r"-(\d{6,})\.html?$")


# ------------------------------------------------------------- discovery
def discover_sitemaps(client: httpx.Client) -> dict[str, str]:
    """robots.txt -> {'today.xml': url, 'yesterday.xml': url}.

    Returns only what robots actually advertises; a missing entry is logged and
    skipped rather than guessed at."""
    r = client.get(ROBOTS_URL)
    r.raise_for_status()
    found: dict[str, str] = {}
    for line in r.text.splitlines():
        if not line.lower().startswith("sitemap:"):
            continue
        url = line.split(":", 1)[1].strip()
        name = urlparse(url).path.rsplit("/", 1)[-1]
        if name in WANTED and name not in found:
            found[name] = url
    for name in WANTED:
        if name not in found:
            log.warning("robots.txt no longer advertises %s — skipping it", name)
    return found


# -------------------------------------------------------------- capture
def capture(client: httpx.Client, day: date, force: bool) -> int:
    """Fetch each advertised sitemap into data/raw/.../<YYYYMMDD>/. Returns the
    number of files written."""
    targets = discover_sitemaps(client)
    if not targets:
        log.error("no news sitemaps advertised in robots.txt — nothing to capture")
        return 0

    outdir = SNAPSHOTS / day.strftime("%Y%m%d")
    outdir.mkdir(parents=True, exist_ok=True)

    written = 0
    for i, (name, url) in enumerate(sorted(targets.items())):
        dest = outdir / name
        if dest.exists() and not force:
            log.info("%s already captured (%s) — skipping", name, dest.relative_to(ROOT))
            continue
        if i:
            time.sleep(DELAY_S)
        try:
            resp = client.get(url)
            resp.raise_for_status()
        except httpx.HTTPError as e:  # one bad fetch must not lose the other
            log.error("fetch failed for %s: %s", url, e)
            continue
        dest.write_bytes(resp.content)
        written += 1
        log.info("captured %s -> %s (%d bytes)", url, dest.relative_to(ROOT), len(resp.content))
    return written


# ---------------------------------------------------------------- parse
def _text(el, path: str):
    node = el.find(path, NS)
    if node is None or node.text is None:
        return None
    s = node.text.strip()
    return s or None


def _ts(s: str | None):
    """'2026-07-27T11:24:57+05:30' -> aware datetime; None if unparseable."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        log.debug("unparseable timestamp %r", s)
        return None


def parse_snapshot(path: Path) -> list[dict]:
    """One sitemap file -> a row per <url>. A malformed file is skipped, not
    fatal — the rest of the history still rebuilds."""
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        log.error("skipping malformed %s: %s", path.relative_to(ROOT), e)
        return []

    rows = []
    for u in root.findall("sm:url", NS):
        loc = _text(u, "sm:loc")
        if not loc:
            continue
        parts = [p for p in urlparse(loc).path.split("/") if p]
        amp = u.find("xhtml:link", NS)
        m = _MSID.search(loc)
        rows.append({
            "url": loc,
            "msid": m.group(1) if m else None,
            "title": _text(u, "news:news/news:title"),
            "section": parts[0] if len(parts) > 1 else None,
            "subsection": parts[1] if len(parts) > 2 else None,
            "publication_date": _ts(_text(u, "news:news/news:publication_date")),
            "lastmod": _ts(_text(u, "sm:lastmod")),
            "keywords": _text(u, "news:news/news:keywords"),
            "language": _text(u, "news:news/news:publication/news:language"),
            "amp_url": amp.get("href") if amp is not None else None,
            "image_url": _text(u, "image:image/image:loc"),
        })
    return rows


# ---------------------------------------------------------------- store
def rebuild() -> int:
    """Re-read every snapshot on disk into one deduped Parquet.

    A url recurs across snapshot days (a story lingers in the window for about a
    week). Collapse on url, keeping the *earliest* publication_date
    observed — the point-in-time fact — while lastmod tracks the latest revision
    and `revisions` counts how many distinct lastmods we ever saw, which is the
    tell that the headline text we hold is no longer what was published."""
    files = sorted(SNAPSHOTS.glob("*/*.xml"))
    if not files:
        log.warning("no snapshots under %s — store not written", SNAPSHOTS)
        return 0

    best: dict[str, dict] = {}
    seen_rows = 0
    for f in files:
        snap_day = datetime.strptime(f.parent.name, "%Y%m%d").date()
        # Which sitemap this row came from. A story legitimately appears in BOTH
        # over its lifetime — in today.xml on the day it ran, then again in the
        # next day's yesterday.xml — so this can't be a per-row label that
        # survives dedup. `shard` records the most authoritative sighting:
        # 'yesterday' the moment we ever see it in a completed day, else
        # 'today'. That is exactly the rule the API serves history by.
        shard = f.stem
        for row in parse_snapshot(f):
            seen_rows += 1
            prior = best.get(row["url"])
            if prior is None:
                best[row["url"]] = {
                    **row,
                    "shard": shard,
                    "first_seen": snap_day,
                    "last_seen": snap_day,
                    "_lastmods": {row["lastmod"]} if row["lastmod"] else set(),
                }
                continue
            if shard == "yesterday":
                prior["shard"] = "yesterday"
            prior["first_seen"] = min(prior["first_seen"], snap_day)
            prior["last_seen"] = max(prior["last_seen"], snap_day)
            if row["publication_date"] and (
                prior["publication_date"] is None
                or row["publication_date"] < prior["publication_date"]
            ):
                prior["publication_date"] = row["publication_date"]
            if row["lastmod"]:
                prior["_lastmods"].add(row["lastmod"])
                if prior["lastmod"] is None or row["lastmod"] > prior["lastmod"]:
                    prior["lastmod"] = row["lastmod"]
                    prior["title"] = row["title"]  # newest revision's headline
            for k in ("keywords", "image_url", "amp_url", "msid", "language"):
                if prior[k] is None and row[k] is not None:
                    prior[k] = row[k]

    rows = list(best.values())
    for r in rows:
        r["revisions"] = max(len(r.pop("_lastmods")), 1)
        r["source"] = "livemint"

    days = {f.parent.name for f in files}
    pubs = [r["publication_date"] for r in rows if r["publication_date"]]
    log.info("%d snapshot file(s) over %d day(s), %d url rows -> %d unique urls",
             len(files), len(days), seen_rows, len(rows))
    if pubs:
        log.info("publication span: %s .. %s", min(pubs).date(), max(pubs).date())

    cols = ["url", "msid", "title", "section", "subsection", "publication_date",
            "lastmod", "keywords", "language", "amp_url", "image_url",
            "shard", "first_seen", "last_seen", "revisions", "source"]
    STORE.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("""
        CREATE OR REPLACE TABLE news (
            url VARCHAR, msid VARCHAR, title VARCHAR, section VARCHAR,
            subsection VARCHAR, publication_date TIMESTAMPTZ, lastmod TIMESTAMPTZ,
            keywords VARCHAR, language VARCHAR, amp_url VARCHAR, image_url VARCHAR,
            shard VARCHAR, first_seen DATE, last_seen DATE, revisions INTEGER,
            source VARCHAR)
    """)
    con.executemany(
        "INSERT INTO news VALUES (" + ",".join("?" * len(cols)) + ")",
        [[r[c] for c in cols] for r in rows],
    )
    con.execute(f"COPY news TO '{OUT.as_posix()}' (FORMAT parquet)")
    con.close()
    log.info("wrote %s (%d rows)", OUT, len(rows))
    return len(rows)


# --------------------------------------------------------------- driver
def run(force: bool = False, rebuild_only: bool = False) -> None:
    if not rebuild_only:
        day = datetime.now(IST).date()
        with httpx.Client(headers={"User-Agent": UA}, timeout=30.0,
                          follow_redirects=True) as client:
            capture(client, day, force)
    rebuild()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true",
                    help="re-fetch even if today's snapshot exists")
    ap.add_argument("--rebuild-only", action="store_true",
                    help="skip the network, rebuild the store from disk")
    a = ap.parse_args()
    run(force=a.force, rebuild_only=a.rebuild_only)

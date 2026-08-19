# TODO — Insider Centric US (Live)

**Status: proposed, not built.** Two loaders are described here. Neither exists.

## The problem

Insider Centric US is structurally weeks behind, and it is not a bug.

The SEC's Insider Transactions Data Sets are **quarterly bulk**: a quarter's
filings only appear after that quarter closes. Measured on 2026-08-19, the
newest transaction we hold is **2026-06-30** — seven weeks stale, and it will
drift to nearly four months before `2026q3` publishes in October, then snap
back. finviz.com/insidertrading showed filings from the same day.

Both read the SEC. Different doors: finviz reads the live filing feed, we read
the archive.

## Loader A — EDGAR daily index (the durable answer)

Layer same-day Form 4s on top of the quarterly bulk. The bulk stays the clean
historical spine (2006 onward, already flattened, 8 quarters loaded); the daily
feed covers the trailing weeks the archive has not caught up to. Exactly the
two-cadence split the NSE side already runs.

EDGAR is **free** — no key, no payment, no paid tier. Only the fair-access rules
apply, which we already follow elsewhere: a declarative User-Agent (a generic
one gets 403) and <= 10 req/s.

**DISCOVER the paths, do not construct them.** Two 403s were spent confirming
this: `.../daily-index/2026/QR3/form.20260818.idx`, written from memory, is
wrong. EDGAR exposes real directory listings as JSON, verified working:

    https://www.sec.gov/Archives/edgar/daily-index/index.json
      -> {"directory":{"item":[{"name":"1994","type":"dir","href":"1994/"}, ...

Walk that down — year, then quarter, then day — reading each level's
`index.json` rather than guessing filenames. This is the same rule that already
caught us on the quarterly zips, where the newest quarter lives under
`/files/datastandardsinnovation/` while the other 81 are under
`/files/structureddata/`; a pattern would have silently skipped the freshest
data. Here it is not silent, it is a 403, but the rule is the same.

Still to confirm (one more level of the walk): the exact index filename inside a
day directory, and whether the Form 4 rows carry enough to resolve an accession
number without a second fetch.

## Loader B — finviz scrape (the quick answer)

Cheaper to build: the page is already aggregated and human-readable.

**robots.txt permits the page we want.** Checked 2026-08-19:

    Disallow: /insidertrading*search=      <- only the search variant
    Disallow: /export
    Disallow: /api/v1/screener-export-csv  <- the Export button

So `https://finviz.com/insidertrading` is allowed; the export endpoints are
not. **Scrape the HTML table, never the export CSV** — that is the line
robots.txt draws and the project's standing rule is to respect it.

Their columns map onto what we already return:

| finviz | ours |
|---|---|
| Ticker | `symbol` |
| Owner | `owner_name` |
| Relationship | `relationship` + `officer_title` |
| Date | `trans_date` |
| Transaction | `trans_code` |
| Cost | `price_per_share` |
| #Shares | `shares` |
| Value ($) | `value_usd` |
| #Shares Total | `shares_after` |
| SEC Form 4 (link) | — we hold `ACCESSION_NUMBER`, no link built yet |
| — | **`plan_10b5_1`** — finviz does not show this |

### Three honest caveats

**It is a rolling window.** ~200 rows covering a few days. Miss a run and those
filings are gone from our copy for good — the same trap as LiveMint's sitemaps
and RSS generally. If this ships, it must be scheduled from day one, unlike
every other US loader, which can be re-run at will because Yahoo and the SEC
both serve history.

**It is a derivative.** finviz parses Form 4s; the SEC publishes them. Scraping
a middleman when the authoritative source is free costs us provenance — a
finviz row cannot be traced back to a filing the way an accession number can,
which is the opposite of what the methodology-page proposal argues for.

**It is fragile.** HTML layout changes break it without warning. EDGAR's
formats are documented and stable.

## Recommendation

Build **A**, not B. B is a stopgap that acquires a scheduling obligation and
loses provenance, to save work on a loader we want regardless.

If B ships first for speed, treat it as temporary and keep the accession number
question open — without it, rows cannot be reconciled against the bulk data
when the quarter finally publishes, and the two sources will silently disagree.

## Also worth taking from that page

**Form 144.** finviz includes proposed sales. Form 144 is filed BEFORE a sale —
intent, where Form 4 is after the fact. A leading indicator we do not load at
all, from either source.

**A link to the filing.** Their Form 4 column links to the EDGAR document.
That is the back-traceability the methodology proposal argues for, applied per
row. We hold `ACCESSION_NUMBER`, which is what EDGAR URLs are built from —
verify the URL shape against a real filing rather than constructing it.

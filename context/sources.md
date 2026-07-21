# Data Sources

Per-company dossiers = **fundamentals + key ratios + news**, aggregated per listed
Indian company. Honest assessment of each source, and how we treat it.

## Primary — screener.in

**What it gives:** a company page (`/company/{code}/`) is fully server-rendered —
one GET returns Market Cap, P/E, ROCE, ROE, Book Value, Dividend Yield, Face
Value, High/Low, plus 10-year P&L / balance-sheet / cash-flow / ratios tables,
quarterly results, shareholding, pros/cons and an About blurb. No login wall for
the page itself, no JavaScript needed.

**robots.txt (respected):** company pages are *allowed*. Disallowed and avoided:
`/user/*`, search query-params (`?q=`, `?sort=`, `?limit=`, `?page=`),
`/company/source/quarter/*`. The CSV export at `/user/company/export/{id}/` is
under `/user/` — off-limits and login-gated, so we parse the HTML instead.

**ToS caveat:** screener.in's terms restrict automated access. This project uses
it as the primary source by explicit choice, so we behave: a real identifying
User-Agent, a hard delay between requests, and **raw HTML cached to
`data/raw/screener/`** (gitignored) so re-parsing never re-hits the site. If they
rate-limit or block, that's expected — the scrape degrades, it doesn't hammer.

## News — RSS + sitemaps (livemint, moneycontrol, …)

News sites publish RSS feeds and news sitemaps (the same discovery pattern used
elsewhere). We read those for per-company / per-sector headlines rather than
scraping article bodies. Only discovered URLs are stored.

## Deliberately skipped — Google Finance

No public API (retired 2012), aggressive bot protection, and a layout that
changes often. yfinance (Yahoo) or the screener numbers give the same data far
more reliably, so Google Finance is not worth the fragility.

## NSE all-reports bulk download — manual only, by design

`nseindia.com/all-reports` has a "Multiple file Download" button that fires
`GET /api/reports?archives=[...]&date=DD-Mon-YYYY&type=Archives`, returning a
zip of every selected report for that day. That endpoint sits behind **Akamai
Bot Manager** — it only succeeds carrying real Akamai sensor cookies
(`_abck`, `bm_sz`, `ak_bmsc`, `bm_sv`), issued by real-browser JS challenges.
Confirmed: a plain `curl`/Playwright request gets `403` / `HTTP2_PROTOCOL_ERROR`
(connection reset) even though `nsearchives.nseindia.com` — the static archive
subdomain we already use — is unprotected.

We do **not** script around this (no cookie replay, no stealth/headless
evasion) — that's automation specifically built to defeat an anti-bot product,
out of scope regardless of the data being public. `src/nse_report_links.py`
only builds the correctly-formed URL per date (the query shape captured from a
real browser DevTools session) and prints it — a human clicks it in their own
authenticated browser. Bhavcopy/filings continue via the existing manual
download + `src/extract.py` pipeline (see `BOD.md`).

## Company universe (seed)

screener uses NSE symbols as company codes (`/company/RELIANCE/`). The list of
which companies to fetch is seeded from the authoritative exchange listing (NSE
equity list), the same way the AMC pipeline seeded from AMFI — an authoritative
roster first, then per-entity enrichment.

## Rules carried over

- **Never fabricate a URL.** Only fetch codes from a real listing / discovered
  links, followed to their final destination.
- **Cache and pace.** Raw HTML is cached; requests are delayed. Re-runs parse
  from cache, not the network.
- **Degrade gracefully.** A blocked or changed page skips that company and logs
  it; it never aborts the run or emits half-empty records as if complete.

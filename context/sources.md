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

## B3 — fund manager involvement (authenticated, accepted tradeoff)

`screener.in/full-text-search/?q=<name>` is the only practical source found for
"which companies is this fund manager associated with" (B3, scoped narrowly —
involvement only, not full holdings; see B7/8 below for that). Two things are
true about this endpoint:

- It **requires login** — unauthenticated requests redirect to `/register/`.
- It uses `?q=`, which our own `robots.txt` reading disallows site-wide,
  **regardless of authentication** — logging in doesn't change what the
  directive covers.

This is a deliberate, explicit exception to the public-page-only stance above,
made by the project owner with the tradeoff understood — not a default. It's
scoped to this one endpoint (fund-manager search), not a blanket authenticated
posture for the rest of screener.in.

- Credentials live in a **gitignored root `.env`** (`SCREENER_USERNAME`,
  `SCREENER_PASSWORD`) — never in chat, never committed.
- Same discipline as everywhere else: real UA, paced requests, cached results,
  degrade gracefully on block/rate-limit.
- Implementation: `src/screener_search.py`.

## B7/8 — fund manager REAL holdings (separate, later, bigger)

Investigated `amfiindia.com/online-center/portfolio-disclosure` — it's a
**directory, not a data host**: clicking an AMC tile opens a new tab to that
AMC's own site (confirmed: ICICI Prudential → `icicipruamc.com/media-center/
downloads?...FortnightlyPortfolioDisclosures`). SEBI's "publish on AMC site AND
AMFI site" mandate is satisfied by AMFI linking out, not mirroring files. Real
per-scheme holdings (with fund manager name, per SEBI's mandated format) means
scraping **~40 individual AMC websites**, each its own page structure — a
separate, later phase, not a B3 blocker.

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

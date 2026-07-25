From Bhav copy

1. %2 week high triogger last day (clarify)
2. Last n days filter >> no of events of 52 week high trigger OK
3. same 2 points for 52 week low OK

4. Top gainers and losers ( different tables) [LIVE or EOD, Clarify]
5. Last n days how many evernts of occurence in top gainers [EOD only]


From screener.com 

1. Insider Buying >> Qty of share and value OK NSE
2. Promoteer holding and change in promoter holding OK NSE
3. Interests of top Portfolio managers and asset managers

4. on lcicking on any of the synmbol from any of the avoe list 
  MArket cap, current price , stock pe , change in promoter holdiong, eps, change in ffii , change in dii, change in promoter last 3 years, current promoter hldg


5. News SCrap
   cOrporate announceemnts
Layer B: Announcement Engine

Use:

BSE corporate announcements
NSE corporate filings
Company investor relations pages

Output:

Order book update
Capex
Results
Fund raise
Board meeting
Credit rating
Acquisition
Expansion
Regulatory approval

---

# Build order (Layer A — Bhav copy — first, in this order)

Cleaned restatement of the Bhav-copy screens. Build 1 → 2 → 3 → 4 → 5.
All ELT: DuckDB SQL over bhavcopy landed in MinIO (`s3://raw/*/`).

1. **52-week HIGH trigger — last day.** Stocks that hit a new 52-week high on the
   most recent session. Source: `CM_52_wk_High_low` (52w-high date == session).
2. **52-week HIGH — last N days event count.** Per stock, how many distinct
   sessions in the last N days it triggered a new 52-week high.
3. **52-week LOW — last day + last N days.** Same as 1 and 2, for new 52-week lows.
4. **Top gainers & losers — two separate tables.** From `sec_bhavdata_full`, ranked
   by % change (gainers desc, losers asc). Configurable depth.
5. **Top gainers — last N days recurrence.** Per stock, how many sessions in the
   last N days it appeared in that session's top gainers.

> N-day screens (2, 3, 5) grow correct as daily bhavcopy folders accumulate;
> with one day landed, N-day count = 1 for each triggered stock.

---

# AMFI sources to study (found 2026-07-22, all verified live)

- **https://portal.amfiindia.com/spages/NAVAll.txt** — gives the complete report,
  EOD/latest. This is the scheme master: every live scheme, Scheme Code, ISIN
  (growth + dividend), Scheme Name, NAV, Date — 17k+ lines, updated daily.
  Not a flat table — AMC name and category appear as bare header lines between
  data rows, need stateful parsing (track "current AMC" while walking down).
  Decide: BOD or EOD pull for this project's cadence.
- **https://www.amfiindia.com/net-asset-value** — check out, likely a UI wrapper
  around the same NAV data (unverified structure beyond page-load).
- **https://www.amfiindia.com/net-asset-value/nav-history** — check out,
  presumably historical NAV lookup (unverified structure beyond page-load).
- **https://www.amfiindia.com/otherdata/scheme-details** — check out, possibly
  richer per-scheme metadata than NAVAll.txt (unverified structure).

Context: none of these give fund-MANAGER names — confirmed AMFI's
portfolio-disclosure and factsheet pages both just link out to each AMC's own
site (checked live, both bounce to e.g. icicipruamc.com). Manager-to-scheme
binding stays a 40-AMC problem (B7/8), not solved by any AMFI page.

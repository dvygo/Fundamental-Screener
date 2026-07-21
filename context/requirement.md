From Bhav copy

1. %2 week high triogger last day 
2. Last n days filter >> no of events of 52 week high trigger
3. same 2 points for 52 week low

4. Top gainers and losers ( different tables)
5. Last n days how many evernts of occiurence in top gainers


From screener.com 

1. Insider Buying >> Qty of share and value
2. Promoteer holding and change in promoter holding
3. HOldings of top Portfolio managers and asset managers

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

# BOD — Download Runbook

For the data-entry operator. Two jobs, two rhythms:

- **DAILY** — the market files (Step 1). Every trading day, after close (~6 PM).
- **WEEKLY** — the filings (Step 2). Once a week (pick a fixed day, e.g. Friday EOD).

All files go under:
`C:\Users\PC\Desktop\CLAUDE2\Fundamental-Screener\data\raw\bod\`

Use the date for `YYYYMMDD` (example: 20 July 2026 → `20260720`).

---

## STEP 1 — DAILY market files (NSE bhavcopy bundle)

Every trading day. Make a folder **`NSECM_YYYYMMDD`** and download all the daily
CM reports into it (the set you already download — bhavcopy, 52-week high/low,
PR zip, PE, etc.).

> One folder per day. **Never skip a day** — each day's prices/52-week/gainers
> exist only in that day's file; a later download cannot recover a missed day.

> **Download with a 1-day lag, not same-day.** NSE publishes this bundle
> progressively — confirmed: a same-day pull for date D got only 8/22 files
> (missing bhavcopy, PR-zip, security master); pulling the *next* day got the
> complete 22. So: download **date D's files on D+1 or later**, never on D
> itself, or you'll silently get a partial drop.

---

## STEP 2 — WEEKLY filings (once a week)

Make **one** folder named **`NSEFILINGS_YYYYMMDD`** (the date you download).

On each page below: set the date range to the **last 10 days**, then click
**"Download (.csv)"** (top-right of the table). Save every csv into that folder.

> Why 10 days for a weekly job: 7 days since last pull + 3 days extra. The extra
> re-catches filings that were **revised** after first posting. Overlap is fine —
> the system removes duplicates automatically (keyed on filing id, not filename).

| # | What | Click this link |
|---|------|-----------------|
| 1 | **Insider Trading** | https://www.nseindia.com/companies-listing/corporate-filings-insider-trading |
| 2 | **Shareholding Pattern** | https://www.nseindia.com/companies-listing/corporate-filings-shareholding-pattern |
| 3 | **Financial Results** | https://www.nseindia.com/companies-listing/corporate-filings-financial-results |
| 4 | **Announcements** | https://www.nseindia.com/companies-listing/corporate-filings-announcements |
| 5 | **Board Meetings** | https://www.nseindia.com/companies-listing/corporate-filings-board-meetings |
| 6 | **Corporate Actions** | https://www.nseindia.com/companies-listing/corporate-filings-actions |

If a link opens the wrong page, open **Announcements** (row 4) and use the left
sidebar — it lists all six filing types.

---

## STEP 3 — Check

```
data\raw\bod\
├── NSECM_YYYYMMDD\        ← DAILY market files (Step 1, one per trading day)
│     BhavCopy_...zip, PR...zip, PE...csv, CM_52_wk_High_low...csv, ...
└── NSEFILINGS_YYYYMMDD\   ← WEEKLY, 6 filing csvs (Step 2, once a week)
      CF-Insider-Trading-...csv
      CF-Shareholding-Pattern-...csv
      CF-Financial-Results-...csv
      CF-Announcements-...csv
      CF-Board-Meetings-...csv
      CF-Corporate-Actions-...csv
```

---

## Rules

- **Don't rename the files.** Keep the exchange's original filename (holds the date).
- **Bhavcopy = daily, no gaps.** Filings = weekly, **last-10-day** range.
- **Save, don't open-and-resave.** Downloaded csv straight into the folder.
- Missed the weekly filing pull? Next time widen the range to cover the gap
  (e.g. last 17 days). Overlap is always safe — duplicates are removed.

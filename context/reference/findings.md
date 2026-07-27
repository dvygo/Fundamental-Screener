# FINDINGS — NSE daily drop, file-by-file

Reference for every file in a day's extract (`data/extracts/<date>/`), based on
the 2026-07-17 drop. Columns, purpose, and which requirement each feeds.

Sources: **standalone** = downloaded on its own; **PR-zip** = came inside
`PR<ddmmyy>.zip` (14 inner files). Naming is `<name><ddmmyy>` or `<name>_<ddmmyyyy>`.

> Three different "high/low" concepts — don't confuse them:
> `CM_52_wk_High_low` = true **52-week** H/L · `hl` = new **day** high/low ·
> `bh` = price-**band (circuit)** hit.

---

## A · Prices (Layer A base, req 4 gainers/losers)

| File | Src | Key columns | Feeds |
|---|---|---|---|
| `sec_bhavdata_full_<d>.csv` | standalone | SYMBOL, SERIES, DATE1, PREV_CLOSE, CLOSE_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, DELIV_QTY, DELIV_PER | **prices view + gainers/losers (screens.py)**. Has delivery qty/%. |
| `BhavCopy_..._F_0000.csv` | standalone (.zip) | TradDt, ISIN, TckrSymb, SctySrs, OpnPric, ClsPric, TtlTradgVol, DELIV… | New-format full CM dump (ISIN-keyed). Superset of prices. |
| `pr<d>.csv` | PR-zip | MKT, SECURITY, PREV_CL_PR, CLOSE_PRICE, HI_52_WK, LO_52_WK | Security-wise market data + index. 52wk here is **unadjusted**. |
| `pd<d>.csv` | PR-zip | + SYMBOL, SERIES vs pr | Same as pr but adds symbol/series codes. |
| `tt<d>.csv` | PR-zip | SECURITY, CLOSE_PRIC, NET_TRDQTY, NET_TRDVAL | Top 25 securities by traded value. |

## B · 52-week / day high-low / circuits (Layer A, req 1-3)

| File | Src | Key columns | Feeds |
|---|---|---|---|
| `CM_52_wk_High_low_<d>.csv` | standalone | SYMBOL, SERIES, Adjusted_52_Week_High, 52_Week_High_Date, Adjusted_52_Week_Low, 52_Week_Low_DT | **52-week triggers (screens.py req 1-3)**. Adjusted for splits/bonus. 2 disclaimer lines on top; lags session by 1 day. |
| `hl<d>.csv` | PR-zip | SECURITY, NEW, PREVIOUS, NEW_STATUS (H/L) | **New day-high / day-low** list (not 52wk). |
| `bh<d>.csv` | PR-zip | SYMBOL, SERIES, SECURITY, HIGH/LOW (H/L) | **Price-BAND (circuit) hits** — H = upper circuit, L = lower. |
| `gl<d>.csv` | PR-zip | GAIN_LOSS, SECURITY, CLOSE_PRIC, PREV_CL_PR, PERCENT_CG | NSE's **official gainers/losers** (Nifty50 / Next50 / others). Cross-check screen 4. |

## C · Valuation (Layer B4 drill-down)

| File | Src | Key columns | Feeds |
|---|---|---|---|
| `mcap<d>.csv` | PR-zip | Trade Date, Symbol, Series, Category, Face Value, Issue Size, Close Price, **Market Cap(Rs.)** | **B4 market cap** — all listed+permitted companies. |
| `PE_<d>.csv` | standalone | SYMBOL, SYMBOL P/E, ADJUSTED P/E | **B4 stock P/E** (and adjusted). |

## D · Filings → XBRL (Layer B, via xbrl_populate.py)

| File | Src | Key columns | Feeds |
|---|---|---|---|
| `CF-Insider-Trading-*.csv` | standalone | SYMBOL, COMPANY, REGULATION, **\*\*XBRL** (url) | **B1 insider** — qty/value/person from XBRL. |
| `CF-Shareholding-Pattern-*.csv` | standalone | COMPANY, **PROMOTER & PROMOTER GROUP (A)**, PUBLIC (B), EMPLOYEE TRUSTS (C2), AS ON DATE, **ACTION** (xbrl url) | **B2 promoter %** inline; FII/DII split in XBRL. |
| `CF-FR-*.csv` | standalone | COMPANY, PERIOD, PERIOD ENDED, AUDITED, CONSOLIDATED, **\*\*XBRL** | **B4 EPS + C Results** — numbers in XBRL. |

## E · Announcements & actions (Layer C)

| File | Src | Key columns | Feeds |
|---|---|---|---|
| `an<d>.txt` | PR-zip | `COMPANY SYMBOL : CATEGORY SYMBOL : detail` | **C announcements** — already semi-classified (e.g. "Credit Rating"). |
| `bm<d>.txt` | PR-zip | `COMPANY SYMBOL : BM DATE : BM PURPOSE` | **C board meetings** — with meeting date + purpose. |
| `bc<d>.csv` | PR-zip | SERIES, SYMBOL, RECORD_DT, EX_DT, **PURPOSE** | **C corporate actions — FORWARD-LOOKING.** ~57% future-dated ex-dates. Purposes: DIV, INTEREST, FVSPLT, MERGER, REDEMPTION. = upcoming dividend/split/action calendar. |

## F · Extra signals (optional screens later)

| File | Src | Key columns | Use |
|---|---|---|---|
| `MTO_<d>.DAT` | standalone | security-wise delivery position | delivery % (accumulation signal). |
| `shortselling_<d>.csv` | standalone | Security Name, Symbol, Trade Date, Quantity | short-sale activity. |
| `CMVOLT_<d>.CSV` | standalone | Symbol, close, daily & annualised volatility | volatility screen. |
| `sme<d>.csv` | PR-zip + standalone | SME market data (OHLC, 52wk) | SME board (note: two copies → `__dup1`). |
| `etf<d>.csv` | PR-zip | ETF market data | ETFs. |
| `corpbond<d>.csv` | PR-zip | corporate bond market data | debt. |

## G · Surveillance / reference / risk (not needed for req 1-5)

| File | Src | What |
|---|---|---|
| `NSE_CM_security_<d>.csv.gz` | standalone | **Security master** — FinInstrmId, TckrSymb, ISIN, ParVal, lot size, book-closure dates. Join key candidate. |
| `REG_IND<d>.csv`, `REG1_IND<d>.csv` | standalone | Surveillance flags per scrip — GSM, **ASM**, IRP/insolvency, unsolicited-SMS. Risk overlay. |
| `C_CATG_*.T01` | standalone | Collateral/category per ISIN. Risk/margin. |
| `C_VAR1_*_1..6.DAT` | standalone | VaR margin rates per security (6 snapshots/day). Risk. |
| `FCM_INTRM_BC*.DAT` | standalone | Intraday/interim bhavcopy (fixed-width). Superseded by EOD bhavcopy. |
| `CSQR_M_<d>.csv` | standalone | Security-wise quarterly settlement / result flag (sparse). |
| `MA<d>.csv` | standalone | Market-activity narrative (Nifty intraday commentary). Text. |
| `readme.txt` | PR-zip | NSE's own description of the PR-zip files. |

---

## Requirement coverage from this drop

- **Req 1-3** (52wk) → `CM_52_wk_High_low` ✓ built
- **Req 4** (gainers/losers) → `sec_bhavdata_full` (computed) ✓ built; `gl` = official cross-check
- **Req 5** (N-day recurrence) → accumulate daily `sec_bhavdata_full` ✓ built
- **B1/B2/B4/Results** → `CF-*` filings + XBRL ✓ Bronze built
- **Layer C** → `an` (announcements, pre-tagged), `bm` (board), `bc` (actions, forward-looking) — sources in hand, classifier pending
- **B4 mcap/PE** → `mcap`, `PE` — landed, not yet wired into a drill-down

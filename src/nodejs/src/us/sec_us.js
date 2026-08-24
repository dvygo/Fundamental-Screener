// Stock Centric US (SEC lane) — as-filed financials from EDGAR.
//
// The other lane (stock_us.js) is finviz + Yahoo: current, vendor-computed,
// unverifiable. This one is the registrant's own filings: lagged by the filing
// calendar, but every figure carries the accession number of the document it
// came from. Per context/proposals/us-source-lanes.md the two stay separate
// rather than being blended into one "best available" number.
//
// THREE THINGS THE SOURCE DOES THAT NAIVE SQL GETS WRONG
//
// 1. Restatements. The same concept and period appear more than once when an
//    amendment revised the figure — Apple's FY2007 NetIncomeLoss is 3,496M in
//    the 10-K and 3,495M in the 10-K/A. The loader keeps both deliberately.
//    Everything here picks the LATEST vintage by `filed`, and secStockFacts
//    exposes the full history so a reader can see the revision.
//
// 2. Duration collision. A 10-Q reports one concept for one period_end twice:
//    the quarter and the year-to-date. Apple's 2026-07-31 10-Q carries
//    NetIncomeLoss at both 29,789M (the quarter) and 101,464M (nine months).
//    Every duration query here filters on period_days or it is off by 3x.
//
// 3. Revenue has no single concept. Measured over the full archive:
//    Revenues 9,400 filers, RevenueFromContractWithCustomerExcludingAssessedTax
//    4,952, SalesRevenueNet 3,881. It is partly the ASC 606 transition, so the
//    right concept changes WITHIN one company's history. Hence a COALESCE
//    ladder rather than a column.

import { queryJson } from '#db.js';

// SEC writes class shares with a dash (BRK-B); rosters and users type a dot.
// us_sec_symbol is normalised to the dash form, so callers normalise to match.
export const normSymbol = (s) => String(s ?? '').trim().toUpperCase().replace(/\./g, '-');

// Latest vintage per (concept, unit, period). Shared by every query below so
// they cannot disagree about which restatement is current.
const LATEST = `
  WITH me AS (
    SELECT cik FROM us_sec_symbol WHERE symbol = ? LIMIT 1
  ),
  ranked AS (
    SELECT f.*,
           row_number() OVER (
             PARTITION BY f.concept, f.unit, f.period_start, f.period_end
             ORDER BY f.filed DESC, f.accn DESC
           ) AS vintage
    FROM us_sec_facts f
    WHERE f.cik = (SELECT cik FROM me)
      AND f.taxonomy IN ('us-gaap', 'dei')
  ),
  current_facts AS (SELECT * FROM ranked WHERE vintage = 1)
`;

// A fiscal year is not exactly 365 days — 52/53-week retail calendars land
// anywhere in this band, and anything narrower drops those filers entirely.
const ANNUAL = 'period_days BETWEEN 340 AND 380';

/** Who this ticker is, per the registrant's own filings. */
export function secStockProfile(symbol) {
  return queryJson(`
    SELECT s.symbol, s.cik, s.name, s.exchanges, s.sic_description
    FROM us_sec_symbol s
    WHERE s.symbol = ?
  `, [normSymbol(symbol)]);
}

/**
 * Annual financials, one row per fiscal year end.
 *
 * Duration facts (revenue, income) and instant facts (assets, equity, cash)
 * are collected separately and joined on period_end, because instants have no
 * period_start at all — a single WHERE on period_days would discard them.
 */
export function secStockAnnual(symbol) {
  return queryJson(`
    ${LATEST},
    dur AS (
      SELECT period_end, concept, val, form, filed, accn
      FROM current_facts WHERE ${ANNUAL}
    ),
    inst AS (
      SELECT period_end, concept, val
      FROM current_facts WHERE period_days IS NULL
    ),
    years AS (SELECT DISTINCT period_end FROM dur)
    SELECT
      y.period_end AS fiscal_year_end,
      coalesce(
        max(d.val) FILTER (WHERE d.concept = 'Revenues'),
        max(d.val) FILTER (WHERE d.concept = 'RevenueFromContractWithCustomerExcludingAssessedTax'),
        max(d.val) FILTER (WHERE d.concept = 'RevenueFromContractWithCustomerIncludingAssessedTax'),
        max(d.val) FILTER (WHERE d.concept = 'SalesRevenueNet')
      ) AS revenue,
      max(d.val) FILTER (WHERE d.concept = 'GrossProfit')          AS gross_profit,
      max(d.val) FILTER (WHERE d.concept = 'OperatingIncomeLoss')  AS operating_income,
      max(d.val) FILTER (WHERE d.concept = 'NetIncomeLoss')        AS net_income,
      coalesce(
        max(d.val) FILTER (WHERE d.concept = 'EarningsPerShareDiluted'),
        max(d.val) FILTER (WHERE d.concept = 'EarningsPerShareBasicAndDiluted')
      ) AS eps_diluted,
      max(d.val) FILTER (WHERE d.concept = 'NetCashProvidedByUsedInOperatingActivities') AS cash_from_ops,
      max(i.val) FILTER (WHERE i.concept = 'Assets')                                 AS assets,
      max(i.val) FILTER (WHERE i.concept = 'Liabilities')                            AS liabilities,
      max(i.val) FILTER (WHERE i.concept = 'StockholdersEquity')                     AS equity,
      max(i.val) FILTER (WHERE i.concept = 'CashAndCashEquivalentsAtCarryingValue')  AS cash,
      -- Provenance for the row: which filing the income statement came from.
      max(d.form)  FILTER (WHERE d.concept = 'NetIncomeLoss') AS form,
      max(d.filed) FILTER (WHERE d.concept = 'NetIncomeLoss') AS filed,
      max(d.accn)  FILTER (WHERE d.concept = 'NetIncomeLoss') AS accn
    FROM years y
    LEFT JOIN dur  d ON d.period_end = y.period_end
    LEFT JOIN inst i ON i.period_end = y.period_end
    GROUP BY y.period_end
    ORDER BY y.period_end DESC
  `, [normSymbol(symbol)]);
}

/**
 * Every vintage of one concept — the audit view.
 *
 * This is the query the whole lane exists for: it shows a figure, when it was
 * filed, on which form, under which accession, and whether it was later
 * revised. `vintage` 1 is current; anything higher was superseded.
 */
export function secStockFacts(symbol, concept, limit) {
  return queryJson(`
    WITH me AS (
      SELECT cik FROM us_sec_symbol WHERE symbol = ? LIMIT 1
    )
    SELECT f.concept, f.unit, f.period_start, f.period_end, f.period_days,
           f.val, f.fy, f.fp, f.form, f.filed, f.accn,
           row_number() OVER (
             PARTITION BY f.concept, f.unit, f.period_start, f.period_end
             ORDER BY f.filed DESC, f.accn DESC
           ) AS vintage
    FROM us_sec_facts f
    WHERE f.cik = (SELECT cik FROM me)
      AND f.concept = ?
    ORDER BY f.period_end DESC, f.filed DESC
    LIMIT ${limit}
  `, [normSymbol(symbol), concept]);
}

/**
 * Filing history from the submissions index.
 *
 * `items` carries the 8-K item codes (2.02 results, 5.02 exec departure), which
 * is what makes this usable as a US announcements feed rather than a bare list.
 */
export function secStockFilings(symbol, limit, form) {
  const formFilter = form ? 'AND upper(f.form) = upper(?)' : '';
  const params = form
    ? [normSymbol(symbol), form]
    : [normSymbol(symbol)];
  return queryJson(`
    WITH me AS (
      SELECT cik FROM us_sec_symbol WHERE symbol = ? LIMIT 1
    )
    SELECT f.filed, f.form, f.period, f.items, f.accn, f.document, f.document_desc
    FROM us_sec_filings f
    WHERE f.cik = (SELECT cik FROM me)
      ${formFilter}
    ORDER BY f.filed DESC NULLS LAST
    LIMIT ${limit}
  `, params);
}

/**
 * What this lane holds for a symbol — powers the page's freshness stamp.
 *
 * The lane's honesty depends on the page stating a real "as of" rather than
 * implying one, so the numbers here are counted, not assumed.
 */
export function secStockCoverage(symbol) {
  const s = normSymbol(symbol);
  return queryJson(`
    WITH me AS (SELECT cik FROM us_sec_symbol WHERE symbol = ? LIMIT 1)
    SELECT 'sec-facts' AS source,
           count(*) AS records,
           max(filed)::VARCHAR AS as_of
    FROM us_sec_facts WHERE cik = (SELECT cik FROM me)
    UNION ALL
    SELECT 'sec-filings', count(*), max(filed)::VARCHAR
    FROM us_sec_filings WHERE cik = (SELECT cik FROM me)
    UNION ALL
    SELECT 'databento-bars', count(*), max(as_of)::VARCHAR
    FROM us_dbn_prices WHERE symbol = ?
  `, [s, s]);
}

/**
 * Databento daily bars, newest first.
 *
 * series_symbol travels with every row on purpose. Where a ticker has been
 * reused the rows belong to different instruments, and the caller needs to see
 * that rather than read one continuous history that never existed.
 */
export function secStockBars(symbol, days) {
  return queryJson(`
    SELECT as_of, series_symbol, open, high, low, close, volume,
           pct_change, hi_252d, lo_252d, dataset
    FROM us_dbn_prices
    WHERE symbol = ?
      AND as_of > (SELECT max(as_of) FROM us_dbn_prices WHERE symbol = ?) - INTERVAL ${days} DAY
    ORDER BY as_of DESC
  `, [normSymbol(symbol), normSymbol(symbol)]);
}

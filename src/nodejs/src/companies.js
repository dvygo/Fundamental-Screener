// Stock-centric (Layer B) — per-symbol insider trading (B1) and promoter
// shareholding (B2), shredded from lossless XBRL facts (src/python/xbrl_populate.py).
// Only covers the dates that script has been run against so far - see db.js.

import { queryJson } from './db.js';
import { screenerDrilldown, screenerPromoters, screenerInsider } from './screener.js';

// Distinct series codes present in the latest security master (EQ, BE, BL, SM…),
// alphabetical — feeds the Stock Centric series dropdown.
export async function listSeries() {
  // Letter-leading codes first (EQ, BE, SM, ST… — the equity/SME series), then
  // the numeric NCD/bond codes, alphabetical within each group. Keeps the
  // common equity series near the top of a long list.
  const rows = await queryJson(
    `SELECT DISTINCT series FROM security_master WHERE series <> ''
     ORDER BY regexp_matches(series, '^[A-Za-z]') DESC, series`,
  );
  return rows.map((r) => r.series);
}

// Symbol/name typeahead over the latest security master, scoped to one series
// (default 'EQ'; the sentinel 'ALL' drops the series filter). Returns the exact
// NSE strings the UI shows as "TckrSymb (FinInstrmNm) (ISIN)". Prefix matches on
// the ticker rank first. DISTINCT collapses the rare dup rows before ranking.
export function searchCompanies(q, series = 'EQ') {
  const like = `%${q}%`;
  const prefix = `${q}%`;
  return queryJson(
    `
    SELECT symbol, company_name, isin FROM (
      SELECT DISTINCT symbol, company_name, isin
      FROM security_master
      WHERE (symbol ILIKE ? OR company_name ILIKE ?)
        AND (? = 'ALL' OR series = ?)
    )
    ORDER BY (symbol ILIKE ?) DESC, symbol
    LIMIT 20
  `,
    [like, like, series, series, prefix],
  );
}

// B1 - insider buying + trades. Primary source is screener.in's login-gated
// "Insider Trades" tab, scraped ON DEMAND when a symbol is opened in Stock
// Centric (person, category, signed qty = buy/sell, avg price, value in lacs).
// Falls back to our own NSE PIT filings (companyInsiderOwn) when screener has no
// page / login is unavailable - that lossless store is the intended v2 source.
export async function companyInsider(symbol) {
  // screener primary; a transient screener failure falls back to our own NSE
  // PIT filings (always available) instead of erroring.
  try {
    const screener = await screenerInsider(symbol);
    if (screener && screener.length) return screener;
  } catch {
    /* fall through to own data */
  }
  return companyInsiderOwn(symbol);
}

// v2 source: our own lossless NSE PIT XBRL (data/store/insider.parquet). Kept as
// the fallback until we shift fully off screener.
// Each filing's MainI context carries the filing-level facts (symbol, date);
// each person/transaction sits in its own "DisclosureN" context within the
// same filing.
export function companyInsiderOwn(symbol) {
  return queryJson(
    `
    WITH main AS (
      SELECT xbrl_url, source_symbol AS symbol, source_company AS company,
             max(CASE WHEN tag = 'DateOfFiling' THEN value END) AS filing_date
      FROM insider_facts
      WHERE context_ref = 'MainI'
      GROUP BY xbrl_url, source_symbol, source_company
    ),
    disclosures AS (
      SELECT xbrl_url, context_ref,
             max(CASE WHEN tag = 'NameOfThePerson' THEN value END) AS person_name,
             max(CASE WHEN tag = 'CategoryOfPerson' THEN value END) AS category,
             max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedTransactionType' THEN value END) AS txn_type,
             max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedNumberOfSecurity' THEN value END) AS qty,
             max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedValueOfSecurity' THEN value END) AS value
      FROM insider_facts
      WHERE context_ref LIKE 'Disclosure%'
      GROUP BY xbrl_url, context_ref
    )
    SELECT m.filing_date, d.person_name, d.category, d.txn_type,
           TRY_CAST(d.qty AS DOUBLE) AS qty, TRY_CAST(d.value AS DOUBLE) AS value
    FROM main m
    JOIN disclosures d USING (xbrl_url)
    WHERE m.symbol = ?
    ORDER BY m.filing_date DESC
  `,
    [symbol],
  );
}

// Insider Centric (market-wide) — every insider trade filed in the last `days`
// sessions across ALL symbols, from our own NSE PIT XBRL store (data/store/
// insider.parquet). Buys, sells and pledge events, newest first. Anchored to the
// latest filing date in the data (not wall-clock) so it always returns the most
// recent window even if the backfill is a day behind. `days` is a validated
// positive int (interpolated - DuckDB INTERVAL doesn't take bound params).
export function insiderRecent(days) {
  return queryJson(`
    WITH main AS (
      SELECT xbrl_url, source_symbol AS symbol, source_company AS company,
             max(CASE WHEN tag = 'DateOfFiling' THEN value END) AS filing_date
      FROM insider_facts
      WHERE context_ref = 'MainI'
      GROUP BY xbrl_url, source_symbol, source_company
    ),
    disc AS (
      SELECT xbrl_url, context_ref,
             max(CASE WHEN tag = 'NameOfThePerson' THEN value END) AS person,
             max(CASE WHEN tag = 'CategoryOfPerson' THEN value END) AS category,
             max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedTransactionType' THEN value END) AS txn_type,
             max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedNumberOfSecurity' THEN value END) AS qty,
             max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedValueOfSecurity' THEN value END) AS value,
             max(CASE WHEN tag = 'ModeOfAcquisitionOrDisposal' THEN value END) AS mode,
             max(CASE WHEN tag = 'DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyToDate' THEN value END) AS txn_date
      FROM insider_facts
      WHERE context_ref LIKE 'Disclosure%'
      GROUP BY xbrl_url, context_ref
    ),
    mx AS (SELECT max(TRY_CAST(filing_date AS DATE)) md FROM main)
    SELECT m.filing_date, m.symbol, m.company, d.person, d.category, d.txn_type,
           TRY_CAST(d.qty AS DOUBLE) AS qty, TRY_CAST(d.value AS DOUBLE) AS value,
           d.mode, d.txn_date
    FROM main m
    JOIN disc d USING (xbrl_url)
    CROSS JOIN mx
    WHERE TRY_CAST(m.filing_date AS DATE) >= mx.md - INTERVAL ${days} DAY
      AND d.person IS NOT NULL
    ORDER BY m.filing_date DESC, m.symbol, d.context_ref
  `);
}

// B4 - symbol drill-down: market cap, current price, stock P/E, EPS (price/PE),
// and current % + change (latest filing vs prior) for promoter, FII
// (InstitutionsForeign) and DII (InstitutionsDomestic). Daily metrics come from
// mcap/PE files (available for every EQ symbol); the shareholding deltas need
// >=2 filings in the populated XBRL window, so they're null for symbols that
// didn't file there (only 20260720-25 populated so far).
const PROMOTER_DIM = '{"in-bse-shp:CategoryOfShareholdersAxis": "in-bse-shp:ShareholdingOfPromoterAndPromoterGroupMember"}';
const FII_DIM = '{"in-bse-shp:CategoryOfShareholdersAxis": "in-bse-shp:InstitutionsForeignMember"}';
const DII_DIM = '{"in-bse-shp:CategoryOfShareholdersAxis": "in-bse-shp:InstitutionsDomesticMember"}';

// Primary source is screener.in (scraped on demand, full B4 reference layout:
// market cap, price, high/low, P/E, EPS, promoter/FII/DII changes, public
// holding, 3yr promoter change). Falls back to the NSE-daily + XBRL metrics
// below only when a symbol has no screener page (or the scrape is blocked).
export async function companyDrilldown(symbol) {
  // screener is primary; a transient screener failure falls back to our own
  // NSE-daily + XBRL metrics rather than erroring (drilldown data is always
  // available from one source or the other).
  try {
    const screener = await screenerDrilldown(symbol);
    if (screener) return screener;
  } catch {
    /* fall through to NSE own-data */
  }
  const nse = await nseDrilldown(symbol);
  return nse ? { ...nse, high: null, low: null, promoter_change_3yr: null, public_pct: null, source: 'nse' } : null;
}

async function nseDrilldown(symbol) {
  const rows = await queryJson(
    `
    WITH k AS (SELECT ? AS symbol),
    shp AS (
      SELECT meta.symbol, meta.report_date, cat.category, cat.pct
      FROM (
        SELECT xbrl_url,
               max(CASE WHEN tag = 'Symbol' THEN value END) AS symbol,
               max(CASE WHEN tag = 'DateOfReport' THEN value END) AS report_date
        FROM shareholding_facts
        WHERE context_ref IN ('MainD', 'MainI')
        GROUP BY xbrl_url
      ) meta
      JOIN (
        SELECT xbrl_url,
               CASE dims WHEN '${PROMOTER_DIM}' THEN 'promoter'
                         WHEN '${FII_DIM}' THEN 'fii'
                         WHEN '${DII_DIM}' THEN 'dii' END AS category,
               TRY_CAST(value AS DOUBLE) * 100 AS pct
        FROM shareholding_facts
        WHERE tag = 'ShareholdingAsAPercentageOfTotalNumberOfShares'
          AND dims IN ('${PROMOTER_DIM}', '${FII_DIM}', '${DII_DIM}')
      ) cat USING (xbrl_url)
      WHERE meta.symbol = (SELECT symbol FROM k)
    ),
    ranked AS (
      SELECT symbol, category, report_date, pct,
             row_number() OVER (PARTITION BY symbol, category ORDER BY report_date DESC) AS rn
      FROM shp
    ),
    sh AS (
      SELECT symbol,
        max(report_date) FILTER (WHERE rn = 1) AS report_date,
        max(report_date) FILTER (WHERE rn = 2) AS prior_report_date,
        round(max(pct) FILTER (WHERE category = 'promoter' AND rn = 1), 2) AS promoter_pct,
        round(max(pct) FILTER (WHERE category = 'promoter' AND rn = 1)
            - max(pct) FILTER (WHERE category = 'promoter' AND rn = 2), 2) AS promoter_change,
        round(max(pct) FILTER (WHERE category = 'fii' AND rn = 1), 2) AS fii_pct,
        round(max(pct) FILTER (WHERE category = 'fii' AND rn = 1)
            - max(pct) FILTER (WHERE category = 'fii' AND rn = 2), 2) AS fii_change,
        round(max(pct) FILTER (WHERE category = 'dii' AND rn = 1), 2) AS dii_pct,
        round(max(pct) FILTER (WHERE category = 'dii' AND rn = 1)
            - max(pct) FILTER (WHERE category = 'dii' AND rn = 2), 2) AS dii_change
      FROM ranked GROUP BY symbol
    )
    SELECT k.symbol, sec.company_name,
           m.market_cap, m.close_price AS current_price, m.face_value,
           pe.symbol_pe AS stock_pe,
           CASE WHEN pe.symbol_pe > 0 THEN round(m.close_price / pe.symbol_pe, 2) END AS eps,
           sh.promoter_pct, sh.promoter_change,
           sh.fii_pct, sh.fii_change,
           sh.dii_pct, sh.dii_change,
           sh.report_date, sh.prior_report_date
    FROM k
    LEFT JOIN security sec ON sec.symbol = k.symbol
    LEFT JOIN mcap_latest m ON m.symbol = k.symbol
    LEFT JOIN pe_latest pe ON pe.symbol = k.symbol
    LEFT JOIN sh ON sh.symbol = k.symbol
  `,
    [symbol],
  );
  return rows[0] ?? null;
}

// B2 (names) - the promoter roster behind the aggregate %: each promoter entity
// with its holding per quarter, scraped on demand from screener.in (the
// individual names aren't in the NSE index CSV, only the aggregate). Null when
// the symbol has no screener page.
export function companyPromoters(symbol) {
  return screenerPromoters(symbol);
}

// B2 - promoter holding % per quarter, whole history, most recent first. Comes
// straight from the shareholding filing index (promoter_history store), so every
// quarter a symbol filed is present - the caller diffs consecutive rows for the
// quarter-over-quarter change. as_on_date is the quarter end (ISO, so it sorts
// chronologically and the UI renders it DD-MM-YY).
export function companyShareholding(symbol) {
  return queryJson(
    `
    SELECT as_on_date, promoter_pct, public_pct, employee_trust_pct, status
    FROM promoter_history
    WHERE symbol = ?
    ORDER BY as_on_date DESC
  `,
    [symbol],
  );
}

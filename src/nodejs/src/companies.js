// Stock-centric (Layer B) — per-symbol insider trading (B1) and promoter
// shareholding (B2), shredded from lossless XBRL facts (src/python/xbrl_populate.py).
// Only covers the dates that script has been run against so far - see db.js.

import { queryJson } from './db.js';
import { screenerDrilldown } from './screener.js';

export function searchCompanies(q) {
  const like = `%${q}%`;
  const prefix = `${q}%`;
  return queryJson(
    `
    SELECT symbol, company_name
    FROM security
    WHERE symbol ILIKE ? OR company_name ILIKE ?
    ORDER BY (symbol ILIKE ?) DESC, symbol
    LIMIT 20
  `,
    [like, like, prefix],
  );
}

// B1 - insider buying/selling: qty + value per disclosed transaction.
// Each filing's MainI context carries the filing-level facts (symbol, date);
// each person/transaction sits in its own "DisclosureN" context within the
// same filing.
export function companyInsider(symbol) {
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
  const screener = await screenerDrilldown(symbol);
  if (screener) return screener;

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

// B2 - promoter holding % (ShareholdingOfPromoterAndPromoterGroup category)
// per filing, most recent first. "Change" is left to the caller to diff
// consecutive rows - with only a few days of XBRL populated so far, most
// symbols will have 0-1 rows here (no history yet to diff against).
export function companyShareholding(symbol) {
  return queryJson(
    `
    WITH meta AS (
      SELECT xbrl_url,
             max(CASE WHEN tag = 'Symbol' THEN value END) AS symbol,
             max(CASE WHEN tag = 'NameOfTheCompany' THEN value END) AS company,
             max(CASE WHEN tag = 'DateOfReport' THEN value END) AS report_date
      FROM shareholding_facts
      WHERE context_ref IN ('MainD', 'MainI')
      GROUP BY xbrl_url
    ),
    promoter AS (
      SELECT xbrl_url, TRY_CAST(value AS DOUBLE) AS promoter_frac
      FROM shareholding_facts
      WHERE tag = 'ShareholdingAsAPercentageOfTotalNumberOfShares'
        AND dims = '{"in-bse-shp:CategoryOfShareholdersAxis": "in-bse-shp:ShareholdingOfPromoterAndPromoterGroupMember"}'
    )
    SELECT m.company, m.report_date, round(p.promoter_frac * 100, 2) AS promoter_pct
    FROM meta m
    JOIN promoter p USING (xbrl_url)
    WHERE m.symbol = ?
    ORDER BY m.report_date DESC
  `,
    [symbol],
  );
}

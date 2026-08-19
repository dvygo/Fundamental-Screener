// Firms & Asset Managers (Layer C) — a screener.in full-text search over filings,
// announcements and concall transcripts. The query is either the user's own text
// (e.g. "Aequitas") or a fund manager picked from the rupeevest fund-manager
// index (data/extracts/rupeevest/fund_manager_index.csv). Results are the
// companies that mention the term, deduped to one row each. Screener owns the
// scraping (src/screener.js); this module just serves the pick-list and delegates.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '#paths.js';
import { queryJson } from '#db.js';
import { screenerFullTextSearch } from '#india/screener.js';


// The static rupeevest index (fund_manager_code, fund_mgr1, fund_houses,
// n_schemes, n_stocks). DuckDB reads it straight off disk.
const FMI = path.join(ROOT, 'data', 'extracts', 'rupeevest', 'fund_manager_index.csv').split(path.sep).join('/');
// SEBI-registered wealth managers (sibling project Fund-Manager-Web-Scraper's
// wealth_managers.csv): every AMC / PMS / AIF / RIA firm, one row each.
const WM = path.join(ROOT, 'data', 'extracts', 'sebi', 'wealth_managers.csv').split(path.sep).join('/');

// sebi_type in the CSV -> short code the four dropdowns are keyed on.
const SEBI_TYPE = {
  'portfolio-managers': 'pms',
  aif: 'aif',
  'mutual-funds': 'amc',
  'investment-advisers': 'ria',
};

// Trailing generic words in a firm's registered name — a full-text search wants
// the distinctive brand ("Aequitas"), not "Aequitas Investment Consultancy
// Private Limited". Keep the leading tokens up to the first generic one (max 3).
const FIRM_GENERIC = new Set(['INVESTMENT', 'INVESTMENTS', 'CONSULTANCY', 'ADVISORS', 'ADVISERS', 'ADVISORY',
  'CAPITAL', 'PARTNERS', 'MANAGEMENT', 'MANAGERS', 'MANAGER', 'ASSET', 'ASSETS', 'FUND', 'FUNDS', 'FINANCIAL',
  'FINANCE', 'SERVICES', 'WEALTH', 'PORTFOLIO', 'SECURITIES', 'PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'INDIA',
  'CO', 'COMPANY', 'TRUST', 'TRUSTEE', 'TRUSTEES', 'AMC', 'MUTUAL', 'BROKING', 'BROKERS', 'HOLDINGS', 'HOLDING',
  'GLOBAL', 'ALTERNATES', 'ALTERNATE', 'ALTERNATIVE', 'AIF', 'AND', '&']);

function firmSearchTerm(name) {
  const toks = String(name).trim().split(/\s+/).filter(Boolean);
  const lead = [];
  for (const t of toks) {
    if (FIRM_GENERIC.has(t.toUpperCase().replace(/[.,]/g, '')) && lead.length) break;
    lead.push(t);
    if (lead.length >= 3) break;
  }
  return (lead.join(' ') || name).trim();
}

// The rupeevest fund-manager index — the pick-list of managers the user can run
// a search for, alphabetical. Static file, so this just projects the CSV.
export function listFundManagers() {
  return queryJson(
    `
    SELECT trim(fund_mgr1) AS manager, trim(fund_houses) AS fund_house,
           TRY_CAST(n_schemes AS INTEGER) AS n_schemes,
           TRY_CAST(n_stocks AS INTEGER) AS n_stocks
    FROM read_csv('${FMI.replace(/'/g, "''")}', header=true, all_varchar=true)
    WHERE trim(fund_mgr1) <> ''
    ORDER BY lower(trim(fund_mgr1))
  `,
  );
}

// The SEBI wealth-manager universe — one row per registered firm, tagged with a
// short `type` (pms/aif/amc/ria) the frontend splits into its four dropdowns,
// plus a `search_term` (distinctive brand) to full-text search when picked.
export async function listFirms() {
  const rows = await queryJson(
    `
    SELECT trim(name) AS name, sebi_type,
           nullif(trim(category), '') AS category,
           nullif(trim(city), '') AS city,
           nullif(trim(website), '') AS website,
           trim(reg_no) AS reg_no
    FROM read_csv('${WM.replace(/'/g, "''")}', header=true, all_varchar=true)
    WHERE trim(name) <> ''
    ORDER BY lower(trim(name))
  `,
  );
  return rows
    .map((r) => ({
      name: r.name,
      type: SEBI_TYPE[r.sebi_type] ?? 'other',
      category: r.category,
      city: r.city,
      website: r.website,
      reg_no: r.reg_no,
      search_term: firmSearchTerm(r.name),
    }))
    .filter((r) => r.type !== 'other');
}

// Run the full-text search for a firm / asset manager / free-text query.
export function firmSearch(query) {
  return screenerFullTextSearch(query);
}

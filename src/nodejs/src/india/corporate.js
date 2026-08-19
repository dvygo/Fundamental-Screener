// Layer C - corporate actions (requirement.md: dividends, splits, bonus, etc.
// with ex-date / record-date), from the bc<date>.csv daily PR-bundle file.
// Market-wide list joined to the security master for the official company name.

import { queryJson } from '#db.js';

export function corporateActions() {
  return queryJson(`
    SELECT c.ex_date, c.record_date, c.symbol, s.company_name, c.category, c.purpose
    FROM corp_actions c
    LEFT JOIN security s ON s.symbol = c.symbol
    ORDER BY c.ex_date DESC NULLS LAST, c.symbol
  `);
}

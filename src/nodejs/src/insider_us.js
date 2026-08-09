// Insider Centric US — SEC Forms 3/4/5, the counterpart to insiderRecent().
//
// Scoped to S&P 500 names by joining us_roster, because that is the universe
// Markets US covers; the SEC data itself spans every US issuer (7,420 tickers
// in the loaded quarters), so widening later is a matter of dropping the join.
//
// TWO THINGS THESE SCREENS REFUSE TO BLUR
//
// 1. Open-market only, by default. TRANS_CODE distinguishes a decision from a
//    payroll event: P (purchase) and S (sale) are discretionary, while A
//    (grant), F (shares withheld for tax) and M (option exercise) are
//    compensation mechanics. In the loaded quarters A+F+M outnumber P by
//    nearly 7:1, so counting them as "insider buying" would bury the signal
//    under vesting schedules. Most retail screens get this wrong.
//
// 2. 10b5-1 plans are reported, not hidden. A sale under a pre-arranged plan
//    was scheduled months earlier and says little about what the insider
//    thinks today; a discretionary sale says rather more. The flag rides along
//    so the reader can weigh them differently.

import { queryJson } from './db.js';

// Anchored on the data, not on today's clock: the SEC publishes quarterly, so
// "recent" means recent relative to what has actually been loaded. Using
// current_date would silently return nothing for most of each quarter.
const WINDOW = (days) => `
  t.trans_date > (SELECT max(trans_date) FROM sec_insider_trans) - INTERVAL ${days} DAY
`;

/** Market-wide S&P 500 insider trades, most recent first. */
export function usInsiderRecent(days, openMarketOnly = true) {
  return queryJson(`
    SELECT t.symbol, t.issuer_name, t.owner_name, t.relationship, t.officer_title,
           t.trans_date, t.filing_date, t.form_type, t.trans_code,
           t.acquired_disposed, t.shares, t.price_per_share, t.value_usd,
           t.shares_after, t.plan_10b5_1
    FROM sec_insider_trans t
    JOIN us_roster r ON r.symbol = t.symbol
    WHERE ${WINDOW(days)}
      AND t.trans_date IS NOT NULL
      ${openMarketOnly ? "AND t.is_open_market" : ''}
    ORDER BY t.trans_date DESC, t.value_usd DESC NULLS LAST, t.symbol
    LIMIT 500
  `);
}

/** Net open-market buying vs selling per symbol over the window. */
export function usInsiderNet(days) {
  return queryJson(`
    SELECT t.symbol, r.company_name, r.sector,
           count(*) FILTER (WHERE t.trans_code = 'P') AS buys,
           count(*) FILTER (WHERE t.trans_code = 'S') AS sells,
           round(sum(t.value_usd) FILTER (WHERE t.trans_code = 'P')::DECIMAL(24,2), 0) AS buy_usd,
           round(sum(t.value_usd) FILTER (WHERE t.trans_code = 'S')::DECIMAL(24,2), 0) AS sell_usd,
           -- Discretionary sales counted separately: a 10b5-1 sale was
           -- scheduled in advance and is weak evidence of present sentiment.
           count(*) FILTER (WHERE t.trans_code = 'S' AND t.plan_10b5_1 IS NOT TRUE)
             AS sells_discretionary,
           count(DISTINCT t.owner_name) AS insiders,
           max(t.trans_date) AS last_trade
    FROM sec_insider_trans t
    JOIN us_roster r ON r.symbol = t.symbol
    WHERE ${WINDOW(days)} AND t.trans_date IS NOT NULL AND t.is_open_market
    GROUP BY t.symbol, r.company_name, r.sector
    ORDER BY buys DESC, buy_usd DESC NULLS LAST, t.symbol
  `);
}

/** Every filed trade for one symbol, open-market and otherwise. */
export function usInsiderForSymbol(symbol) {
  return queryJson(`
    SELECT t.trans_date, t.filing_date, t.owner_name, t.relationship, t.officer_title,
           t.form_type, t.trans_code, t.acquired_disposed, t.shares,
           t.price_per_share, t.value_usd, t.shares_after, t.ownership, t.plan_10b5_1,
           t.is_open_market
    FROM sec_insider_trans t
    WHERE t.symbol = ?
    ORDER BY t.trans_date DESC NULLS LAST, t.value_usd DESC NULLS LAST
    LIMIT 500
  `, [symbol]);
}

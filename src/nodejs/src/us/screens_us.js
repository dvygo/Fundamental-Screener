// Markets US screens — the S&P 500 counterpart to screens.js.
//
// Four screens, not five. The NSE board's fifth is Upper & Lower Circuit, which
// has no US equivalent: per-stock daily price bands are a structural feature of
// Indian exchanges. US markets halt via LULD, which is intraday and not
// published as a daily file, so inventing a column for it would be fabricating
// a signal. The slot is simply absent.
//
// Shape, ordering and tiebreaker rules deliberately mirror screens.js so the
// same frontend components render both boards without special-casing.
//
// WHAT IS DERIVED, AND WHY IT MATTERS
//   NSE publishes prev-close, the gain/loss direction and a 52-week high/low
//   list as authoritative files; screens.js reads them. Yahoo publishes none of
//   those, so `us_prices` computes them from the bar history (see db.js). A US
//   "new 52-week high" is therefore our calculation over trailing sessions, not
//   an exchange's declaration. It is labelled as such in the UI.

import { queryJson } from '../db.js';

// A symbol only qualifies for a 52-week screen once we actually hold 52 weeks
// of its bars. Without this guard every symbol's earliest session trivially
// sets a "record" (the trailing window contains only itself), which would fill
// the board with noise on the oldest dates and on recent IPOs / index joiners.
const FULL_YEAR = 'sessions_seen >= 252';

/** New 52-week highs over the last N days, most frequent first. */
export function usHigh52wEvents(n) {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM us_prices)
    SELECT p.symbol, r.company_name, r.sector,
           count(DISTINCT p.as_of) AS high_events,
           min(p.as_of) AS first_event, max(p.as_of) AS last_event,
           round(max(p.hi_52w)::DECIMAL(18,4), 2) AS high_52w
    FROM us_prices p
    CROSS JOIN d
    LEFT JOIN us_roster r ON r.symbol = p.symbol
    WHERE p.as_of > d.md - INTERVAL ${n} DAY
      AND ${FULL_YEAR} AND p.high >= p.hi_52w
    GROUP BY p.symbol, r.company_name, r.sector
    ORDER BY high_events DESC, p.symbol
  `);
}

/** New 52-week lows over the last N days, most frequent first. */
export function usLow52wEvents(n) {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM us_prices)
    SELECT p.symbol, r.company_name, r.sector,
           count(DISTINCT p.as_of) AS low_events,
           min(p.as_of) AS first_event, max(p.as_of) AS last_event,
           round(min(p.lo_52w)::DECIMAL(18,4), 2) AS low_52w
    FROM us_prices p
    CROSS JOIN d
    LEFT JOIN us_roster r ON r.symbol = p.symbol
    WHERE p.as_of > d.md - INTERVAL ${n} DAY
      AND ${FULL_YEAR} AND p.low <= p.lo_52w
    GROUP BY p.symbol, r.company_name, r.sector
    ORDER BY low_events DESC, p.symbol
  `);
}

// How often a symbol sat in the day's top `top` gainers over the last N days.
// Repetition is the signal, not a single spike — same premise as screen5.
//
// The rank window carries an explicit `symbol` tiebreaker and avg() runs over
// DECIMAL, both for the reasons learned on the NSE side: without the tiebreaker
// symbols tied at the cutoff swap between identical requests, and float
// addition isn't associative so a parallelised avg() rounds differently run to
// run. Both bugs are invisible until you diff two payloads.
export function usGainersRecurrence(n, top) {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM us_gainloss)
    SELECT g.symbol, g.company_name, g.sector,
           count(*) AS times_in_top,
           round(avg(g.pct_change::DECIMAL(12,4)), 2) AS avg_pct,
           min(g.as_of) AS first_seen, max(g.as_of) AS last_seen
    FROM us_gainloss g
    CROSS JOIN d
    WHERE g.as_of > d.md - INTERVAL ${n} DAY AND g.gain_rank <= ${top}
    GROUP BY g.symbol, g.company_name, g.sector
    ORDER BY times_in_top DESC, avg_pct DESC, g.symbol
  `);
}

/** Losers mirror: how often a symbol sat in the day's bottom `top`. */
export function usLosersRecurrence(n, top) {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM us_gainloss)
    SELECT g.symbol, g.company_name, g.sector,
           count(*) AS times_in_bottom,
           round(avg(g.pct_change::DECIMAL(12,4)), 2) AS avg_pct,
           min(g.as_of) AS first_seen, max(g.as_of) AS last_seen
    FROM us_gainloss g
    CROSS JOIN d
    WHERE g.as_of > d.md - INTERVAL ${n} DAY AND g.lose_rank <= ${top}
    GROUP BY g.symbol, g.company_name, g.sector
    ORDER BY times_in_bottom DESC, avg_pct ASC, g.symbol
  `);
}

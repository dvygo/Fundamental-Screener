// Stock Centric US (Live lane) — per-company fundamentals.
//
// Sources, per context/proposals/us-live-lane-sources.md:
//   finviz  fundamentals (declared primary for this lane)
//   Yahoo   .info — fallback only, and market-derived fields finviz omits
//   Yahoo   daily bars — the technical half, already in us_prices
//
// The two fundamentals tables are LONG (symbol, key, value) and stay that way.
// finviz publishes ~84 keys and the set drifts; a fixed column list would
// silently drop whatever was added since it was written — the same lesson
// xbrl_populate.py records about shareholding categories.
//
// Every row carries its `source`, because the lane's honesty rests on the
// reader being able to see which figure came from where. That is the one thing
// the "no per-row filing links" decision did NOT give up.

import { queryJson } from '#db.js';

/**
 * Fundamentals for one symbol, finviz first, Yahoo filling gaps.
 *
 * The anti-join is deliberate rather than a UNION: where both sources publish
 * the same key, finviz wins outright, because mixing two vendors' definitions
 * of the same ratio under one label is exactly the blending the lane split
 * exists to avoid. Yahoo appears only for keys finviz did not supply.
 */
export function usStockFundamentals(symbol) {
  return queryJson(`
    WITH fv AS (
      SELECT key, value, source FROM us_fundamentals WHERE symbol = ?
    ),
    yh AS (
      SELECT key, value, source FROM us_info WHERE symbol = ?
        AND key NOT IN (SELECT key FROM fv)
    )
    SELECT * FROM fv
    UNION ALL
    SELECT * FROM yh
    ORDER BY source, key
  `, [symbol, symbol]);
}

/**
 * Price history for the technical half, newest first.
 *
 * days = 0 returns everything held for the symbol; the page defaults to that.
 *
 * LIMIT over an ordered read, which fixes two things the old
 * `as_of > (SELECT max(as_of) FROM us_prices) - INTERVAL n DAY` got wrong:
 *
 *  1. It counted CALENDAR days while the heading said "sessions", so 90 asked
 *     for 90 and returned about 62 — weekends and holidays ate the rest.
 *  2. Worse, that max(as_of) was the MARKET-WIDE latest session, not this
 *     symbol's. Any symbol whose last bar predates the market's — delisted,
 *     halted, or simply not carried lately — had the window anchored past the
 *     end of its own history and came back short or completely empty, which
 *     reads as "no data held" rather than "no recent data".
 *
 * Ordering by as_of DESC and taking the first n rows is anchored to the
 * symbol's own history by construction, so neither failure is reachable.
 */
export function usStockPrices(symbol, days) {
  const limit = Number(days) > 0 ? `LIMIT ${Number(days)}` : '';
  return queryJson(`
    SELECT as_of, open, high, low, close, volume, pct_change, hi_52w, lo_52w
    FROM us_prices
    WHERE symbol = ?
    ORDER BY as_of DESC
    ${limit}
  `, [symbol]);
}

/**
 * What we hold for a symbol, and from where — powers the freshness stamp.
 *
 * The lane split means one honest "as of" per page, but only if the page can
 * state it. Nothing else exposes per-source coverage, so a UI showing "finviz ·
 * live" would be asserting something it never checked.
 */
export function usStockCoverage(symbol) {
  return queryJson(`
    SELECT 'finviz'  AS source, count(*) AS facts, NULL AS as_of
      FROM us_fundamentals WHERE symbol = ?
    UNION ALL
    SELECT 'yahoo-info', count(*), NULL FROM us_info WHERE symbol = ?
    UNION ALL
    SELECT 'yahoo-bars', count(*), max(as_of)::VARCHAR FROM us_prices WHERE symbol = ?
  `, [symbol, symbol, symbol]);
}

/**
 * Insider trades for one symbol — the Live lane's answer to the India board's
 * insider table. Same-day, and includes Form 144 proposed sales the SEC
 * quarterly bulk does not carry.
 */
export function usStockInsider(symbol) {
  return queryJson(`
    SELECT trans_date, owner_name, relationship, transaction,
           shares, price_per_share, value_usd, shares_after, is_proposed
    FROM us_insider_live
    WHERE symbol = ?
    ORDER BY value_usd DESC NULLS LAST
  `, [symbol]);
}

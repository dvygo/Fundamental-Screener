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
 * Every price bar held for the symbol, newest first. No row cap, no window.
 *
 * The `days` parameter is gone rather than defaulted — see secStockBars for
 * why. What it replaced also had a sharper bug worth remembering: the window
 * was `as_of > (SELECT max(as_of) FROM us_prices) - INTERVAL n DAY`, and that
 * max had NO symbol predicate, so it anchored to the MARKET's latest session
 * rather than this symbol's. Any symbol whose last bar predated the market's —
 * delisted, halted, not carried lately — came back short or empty, reading as
 * "no data held" instead of "no recent data". Ordering by the symbol's own
 * rows cannot reproduce that.
 */
export function usStockPrices(symbol) {
  return queryJson(`
    SELECT as_of, open, high, low, close, volume, pct_change, hi_52w, lo_52w
    FROM us_prices
    WHERE symbol = ?
    ORDER BY as_of DESC
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

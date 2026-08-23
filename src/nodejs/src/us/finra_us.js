// FINRA short data — the primary source for what finviz publishes as
// Short Interest, Short Ratio and Short Float.
//
// Two different measures live here and are kept apart on purpose:
//
//   short INTEREST  open short positions, biweekly. A stock.
//   short VOLUME    shares sold short in a session, daily. A flow.
//
// They get conflated constantly. A stock with heavy short interest and one with
// heavy daily short volume are not the same claim, and blending them under one
// "short" label would be exactly the vendor behaviour this lane replaces.
//
// THE RATIO IS NOT A SIGNAL BY ITSELF
// Median short ratio across liquid symbols is ~0.505 — half of every short sale
// is a market maker hedging inventory, which is mechanical rather than
// directional. A screen on "short volume above 50%" fires on half the market
// every day. So every query here returns the deviation from the symbol's OWN
// baseline alongside the raw ratio, and `sessions` says how much history that
// baseline rests on.

import { queryJson } from '#db.js';

/** Latest short interest settlement for one symbol, newest first. */
export function finraShortInterest(symbol, limit) {
  return queryJson(`
    SELECT settlement_date, symbol, issue_name, market_class,
           short_interest, short_interest_prev, change_shares, change_pct,
           avg_daily_volume, days_to_cover
    FROM us_finra_short_interest
    WHERE symbol = ?
    ORDER BY settlement_date DESC
    LIMIT ${limit}
  `, [String(symbol).trim().toUpperCase()]);
}

/**
 * Daily short volume for one symbol, with its deviation from baseline.
 *
 * `vs_baseline` is the number worth reading: +0.08 means eight points more of
 * the day's off-exchange volume was sold short than is normal FOR THIS SYMBOL.
 * The raw ratio is returned too, but on its own it mostly measures how much
 * market-making the stock attracts.
 */
export function finraShortVolume(symbol, days) {
  return queryJson(`
    SELECT v.as_of, v.short_volume, v.short_exempt_volume, v.total_volume,
           round(v.short_ratio, 4) AS short_ratio,
           round(b.baseline_ratio, 4) AS baseline_ratio,
           round(v.short_ratio - b.baseline_ratio, 4) AS vs_baseline,
           b.sessions AS baseline_sessions,
           v.markets
    FROM us_finra_short_volume v
    LEFT JOIN us_finra_short_baseline b ON b.symbol = v.symbol
    WHERE v.symbol = ?
      AND v.as_of > (SELECT max(as_of) FROM us_finra_short_volume) - INTERVAL ${days} DAY
    ORDER BY v.as_of DESC
  `, [String(symbol).trim().toUpperCase()]);
}

/**
 * Symbols whose latest session sits furthest from their own baseline.
 *
 * The liquidity floor is not cosmetic: a symbol trading a few thousand shares
 * can post a 1.00 ratio on a single print, which would otherwise dominate the
 * board with noise. min_sessions guards the other end — a baseline drawn from
 * two days is not a baseline.
 */
export function finraShortVolumeOutliers(minVolume, minSessions, limit) {
  return queryJson(`
    WITH latest AS (SELECT max(as_of) AS d FROM us_finra_short_volume)
    SELECT v.symbol, v.as_of,
           v.total_volume,
           round(v.short_ratio, 4) AS short_ratio,
           round(b.baseline_ratio, 4) AS baseline_ratio,
           round(v.short_ratio - b.baseline_ratio, 4) AS vs_baseline,
           b.sessions AS baseline_sessions
    FROM us_finra_short_volume v
    JOIN us_finra_short_baseline b ON b.symbol = v.symbol
    WHERE v.as_of = (SELECT d FROM latest)
      AND v.total_volume >= ${minVolume}
      AND b.sessions >= ${minSessions}
      AND v.short_ratio IS NOT NULL
    ORDER BY abs(v.short_ratio - b.baseline_ratio) DESC
    LIMIT ${limit}
  `);
}

/**
 * Largest biweekly moves in short interest, latest settlement.
 *
 * change_pct comes from FINRA rather than being recomputed — it is their
 * published figure, and recalculating it would quietly diverge wherever they
 * adjust for a split (which is what the source's split flag marks).
 */
export function finraShortInterestMovers(minInterest, limit) {
  return queryJson(`
    WITH latest AS (SELECT max(settlement_date) AS d FROM us_finra_short_interest)
    SELECT symbol, issue_name, market_class, settlement_date,
           short_interest, short_interest_prev, change_shares, change_pct,
           days_to_cover
    FROM us_finra_short_interest
    WHERE settlement_date = (SELECT d FROM latest)
      AND short_interest >= ${minInterest}
    ORDER BY abs(change_pct) DESC NULLS LAST
    LIMIT ${limit}
  `);
}

/** What the FINRA lane holds for a symbol — feeds the freshness stamp. */
export function finraCoverage(symbol) {
  const s = String(symbol).trim().toUpperCase();
  return queryJson(`
    SELECT 'finra-short-interest' AS source, count(*) AS records,
           max(settlement_date)::VARCHAR AS as_of
    FROM us_finra_short_interest WHERE symbol = ?
    UNION ALL
    SELECT 'finra-short-volume', count(*), max(as_of)::VARCHAR
    FROM us_finra_short_volume WHERE symbol = ?
  `, [s, s]);
}

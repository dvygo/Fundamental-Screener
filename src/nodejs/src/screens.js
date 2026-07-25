// Layer A screens (requirement.md 1-5), ported from src/python/screens.py.
// Same SQL, JSON out instead of a pretty-printed table.

import { queryJson } from './db.js';

export function screen1_high52wLastDay() {
  return queryJson(`
    WITH d AS (SELECT max(event_date) md FROM hi52)
    SELECT h.event_date, h.symbol, s.company_name, h.series, h.price
    FROM hi52 h
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = h.symbol
    WHERE h.event_date = d.md
    ORDER BY h.symbol
  `);
}

export function screen2_high52wEvents(n) {
  return queryJson(`
    WITH d AS (SELECT max(event_date) md FROM hi52)
    SELECT h.symbol, s.company_name,
           count(DISTINCT h.event_date) AS high_events,
           min(h.event_date) AS first_event, max(h.event_date) AS last_event
    FROM hi52 h
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = h.symbol
    WHERE h.event_date > d.md - INTERVAL ${n} DAY
    GROUP BY h.symbol, s.company_name
    ORDER BY high_events DESC, h.symbol
  `);
}

export function screen3a_low52wLastDay() {
  return queryJson(`
    WITH d AS (SELECT max(event_date) md FROM lo52)
    SELECT l.event_date, l.symbol, s.company_name, l.series, l.price
    FROM lo52 l
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = l.symbol
    WHERE l.event_date = d.md
    ORDER BY l.symbol
  `);
}

export function screen3b_low52wEvents(n) {
  return queryJson(`
    WITH d AS (SELECT max(event_date) md FROM lo52)
    SELECT l.symbol, s.company_name,
           count(DISTINCT l.event_date) AS low_events,
           min(l.event_date) AS first_event, max(l.event_date) AS last_event
    FROM lo52 l
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = l.symbol
    WHERE l.event_date > d.md - INTERVAL ${n} DAY
    GROUP BY l.symbol, s.company_name
    ORDER BY low_events DESC, l.symbol
  `);
}

export function screen4a_gainers(top) {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM prices)
    SELECT p.symbol, s.company_name, p.close, p.prev_close, p.pct_change, p.qty, p.turnover_lacs
    FROM prices p
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = p.symbol
    WHERE p.as_of = d.md AND p.pct_change IS NOT NULL
    ORDER BY p.pct_change DESC LIMIT ${top}
  `);
}

export function screen4b_losers(top) {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM prices)
    SELECT p.symbol, s.company_name, p.close, p.prev_close, p.pct_change, p.qty, p.turnover_lacs
    FROM prices p
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = p.symbol
    WHERE p.as_of = d.md AND p.pct_change IS NOT NULL
    ORDER BY p.pct_change ASC LIMIT ${top}
  `);
}

export function screen5_gainersRecurrence(n, top) {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM prices),
    ranked AS (
      SELECT as_of, symbol, pct_change,
             row_number() OVER (PARTITION BY as_of ORDER BY pct_change DESC) AS rnk
      FROM prices, d
      WHERE pct_change IS NOT NULL AND as_of > d.md - INTERVAL ${n} DAY
    )
    SELECT r.symbol, s.company_name,
           count(*) AS times_in_top,
           round(avg(r.pct_change), 2) AS avg_pct,
           max(r.as_of) AS last_seen
    FROM ranked r
    LEFT JOIN security s ON s.symbol = r.symbol
    WHERE r.rnk <= ${top}
    GROUP BY r.symbol, s.company_name
    ORDER BY times_in_top DESC, avg_pct DESC
  `);
}

export function screen6a_upperCircuit() {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM circuit)
    SELECT c.as_of, c.symbol, s.company_name, c.series
    FROM circuit c
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = c.symbol
    WHERE c.as_of = d.md AND c.hit = 'H'
    ORDER BY c.symbol
  `);
}

export function screen6b_lowerCircuit() {
  return queryJson(`
    WITH d AS (SELECT max(as_of) md FROM circuit)
    SELECT c.as_of, c.symbol, s.company_name, c.series
    FROM circuit c
    CROSS JOIN d
    LEFT JOIN security s ON s.symbol = c.symbol
    WHERE c.as_of = d.md AND c.hit = 'L'
    ORDER BY c.symbol
  `);
}

// HUNT — the convergence scoreboard from the Idea Hunting Framework
// (context/requirements/20260717/Idea Hunting Framework.pdf, Part 3). Every
// signal we already surface carries a flat point value; a name accrues points
// each time a signal fires on it over a rolling window, and the highest running
// total floats to the top. Convergence is the tell — the more independent
// tripwires land on one name, the harder it's worth a look. This ranks WHERE to
// look first; it never says what to buy.
//
// Points (framework Part 3), scored from the data we actually hold:
//   insider open-market buy              5   per Market Purchase / Block Deal, DEDUPED
//                                            to one per (person, date, qty, value) — a
//                                            filing that repeats a trade across contexts
//                                            counts once (ESOP/gift/off-market = 0; sell = flag)
//   52-week high/low                     5   first new high/low in the window,
//                                            +1 for each additional new-high/low session
//   news keyword (strong/medium/light) 3/2/1 highest-strength keyword per tagged article
//   corporate announcement (raise/action) 2/1 Rights = 2; Bonus / Split / Buyback = 1
//   daily gainer / loser                 1   per session the name sits in the top-20 list
//
// The five "rules that keep it honest" (framework Part 3):
//   1. Window = a rolling N *trading sessions* (default 21 ≈ 1 month, per the
//      framework's own equivalence). Implemented as the calendar span that covers
//      N sessions (~7 calendar days per 5 sessions), anchored to the latest
//      bhavcopy date, so the oldest rolls off as new sessions land. A pure
//      session-count off price data isn't usable yet — only a handful of daily
//      bhavcopies are loaded, whereas insider filings span ~2 months, so a
//      price-session count would wrongly starve the insider lookback. Each feed
//      contributes whatever falls in the span; price signals extend toward a full
//      21 as more dailies load.
//   2. Count per signal, per SESSION, not per mention. 52w counts distinct
//      new-high dates; gainers/losers count distinct (session, symbol); insider is
//      deduped to distinct trades; news dedupes repeated headlines.
//   3. Repetition across days accumulates — a fresh breakout that keeps making new
//      highs keeps earning (+1 per new-high session).
//   4. Fluff is capped — routine "General/Business Update" filler carries no
//      keyword, so it scores 0 and never climbs.
//   5. Volume ×1.5 confirmer — NOT yet applied (needs a per-stock volume baseline).
// Also not yet wired (no data source): sector tailwind / headwind (+2 / -2) and a
// dedicated Results / Orderbook / Capex announcements feed — left at 0 so the
// board stays honest about what it measures.

import { queryJson } from './db.js';
import { getNews } from './news.js';

// "On the gainers / losers list" = the top-N by %-change that session.
const TOP = 20;

// News keyword buckets (framework Part 2), highest strength first. LiveMint is
// our single news *and* announcement sensor ("news... catches capex cycles";
// "announcements are the same information"), so a headline is scored against the
// union of both keyword tables — minus bonus / split / rights, which the
// corp_actions column already scores from the NSE feed (no double count). The
// strongest keyword present scores the article once per tagged stock; \w* catches
// plurals/variants. "Issue"/"Update" are read-only fluff in the framework —
// never scored, so filler never climbs the board (rule 4).
const NEWS_BUCKETS = [
  { pts: 3, re: /\b(demand|capex|approval|trigger|growth|results?|orderbook)\w*/i },
  { pts: 2, re: /\b(supply|constraint|budget|manufactur|qip)\w*/i },
  { pts: 1, re: /\b(valuation|moat)\w*/i },
];

function newsPointsFor(title) {
  for (const b of NEWS_BUCKETS) if (b.re.test(title)) return b.pts;
  return 0;
}

// Per-symbol news points from today's tagged LiveMint feed. Each distinct story
// scores once per stock it names (rule 2: "same story across papers counts
// once" — we dedupe repeated headlines); a symbol accrues across separate
// developments. Degrades to an empty map if the feed is unreachable, so the
// board still renders. News is a single session (today's feed) — we don't retain
// per-day snapshots, so it contributes the current session only, not a rolling
// N-session sum.
async function newsBySymbol() {
  const map = new Map(); // symbol -> { pts, company_name }
  const seen = new Set(); // normalized titles already counted (rule 2 dedupe)
  try {
    const articles = await getNews();
    for (const a of articles) {
      const pts = newsPointsFor(a.title);
      if (pts === 0 || !a.symbols?.length) continue;
      const key = a.title.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      for (const s of a.symbols) {
        const cur = map.get(s.symbol) ?? { pts: 0, company_name: s.company_name };
        cur.pts += pts;
        map.set(s.symbol, cur);
      }
    }
  } catch {
    /* feed down — score the DB signals only */
  }
  return map;
}

// The DuckDB-sourced signals, each returned as the POINTS it contributes so the
// columns literally sum to the score. One unified rolling window: the calendar
// span covering the last N sessions (`days` = the session-equivalent, computed
// in huntBoard), anchored to the latest bhavcopy date, so every date-based signal
// shares one boundary and the oldest rolls off as new sessions arrive.
const boardSql = (days) => `
  WITH
  -- rule 1: window lower bound = latest market session minus the ~N-session span.
  sb AS (SELECT max(as_of) - INTERVAL ${days} DAY AS lo FROM prices),
  hi AS (
    SELECT symbol, count(DISTINCT event_date) AS ev
    FROM hi52 CROSS JOIN sb
    WHERE event_date >= sb.lo
    GROUP BY symbol
  ),
  lo AS (
    SELECT symbol, count(DISTINCT event_date) AS ev
    FROM lo52 CROSS JOIN sb
    WHERE event_date >= sb.lo
    GROUP BY symbol
  ),
  win AS (
    SELECT DISTINCT p.as_of, p.symbol, p.pct_change
    FROM prices p CROSS JOIN sb
    WHERE p.pct_change IS NOT NULL AND p.as_of >= sb.lo
  ),
  gain AS (
    SELECT symbol, count(*) AS sess FROM (
      SELECT symbol, row_number() OVER (PARTITION BY as_of ORDER BY pct_change DESC) AS rnk FROM win
    ) WHERE rnk <= ${TOP} GROUP BY symbol
  ),
  lose AS (
    SELECT symbol, count(*) AS sess FROM (
      SELECT symbol, row_number() OVER (PARTITION BY as_of ORDER BY pct_change ASC) AS rnk FROM win
    ) WHERE rnk <= ${TOP} GROUP BY symbol
  ),
  ins_main AS (
    SELECT xbrl_url, source_symbol AS symbol,
           max(CASE WHEN tag = 'DateOfFiling' THEN value END) AS filing_date
    FROM insider_facts WHERE context_ref = 'MainI'
    GROUP BY xbrl_url, source_symbol
  ),
  ins_disc AS (
    SELECT xbrl_url, context_ref,
           max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedTransactionType' THEN value END) AS txn_type,
           max(CASE WHEN tag = 'ModeOfAcquisitionOrDisposal' THEN value END) AS mode,
           max(CASE WHEN tag = 'NameOfThePerson' THEN value END) AS person,
           max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedNumberOfSecurity' THEN value END) AS qty,
           max(CASE WHEN tag = 'SecuritiesAcquiredOrDisposedValueOfSecurity' THEN value END) AS val
    FROM insider_facts WHERE context_ref LIKE 'Disclosure%'
    GROUP BY xbrl_url, context_ref
  ),
  ins AS (
    -- Only OPEN-MARKET buys score (framework: "especially clustered, open-market
    -- buying") — ESOP / gift / off-market / inter-se / allotment are routine comp
    -- or family/primary transfers, not conviction. DEDUPED to one buy per
    -- (person, to-date, qty, value): the XBRL repeats a single trade across 2-3
    -- disclosure contexts, and rule 2 counts the story once, not per mention.
    SELECT symbol, count(*) AS buys FROM (
      SELECT DISTINCT m.symbol, d.person, d.val, d.qty
      FROM ins_main m JOIN ins_disc d USING (xbrl_url) CROSS JOIN sb
      WHERE TRY_CAST(m.filing_date AS DATE) >= sb.lo
        AND d.txn_type = 'Buy' AND d.mode IN ('Market Purchase', 'Block Deal')
    ) GROUP BY symbol
  ),
  ca AS (
    SELECT symbol,
           sum(CASE category WHEN 'Rights' THEN 2 WHEN 'Bonus' THEN 1
                             WHEN 'Split' THEN 1 WHEN 'Buyback' THEN 1 ELSE 0 END) AS pts
    FROM corp_actions
    WHERE category IN ('Rights', 'Bonus', 'Split', 'Buyback')
    GROUP BY symbol
  ),
  syms AS (
    SELECT symbol FROM hi UNION SELECT symbol FROM lo UNION SELECT symbol FROM gain
    UNION SELECT symbol FROM lose UNION SELECT symbol FROM ins UNION SELECT symbol FROM ca
  )
  SELECT s.symbol, sec.company_name,
         coalesce(ins.buys, 0) * 5 AS pts_insider,
         CASE WHEN coalesce(hi.ev, 0) + coalesce(lo.ev, 0) > 0
              THEN 4 + coalesce(hi.ev, 0) + coalesce(lo.ev, 0) ELSE 0 END AS pts_52w,
         coalesce(gain.sess, 0) AS pts_gainers,
         coalesce(lose.sess, 0) AS pts_losers,
         coalesce(ca.pts, 0) AS pts_corp_actions
  FROM syms s
  LEFT JOIN ins  ON ins.symbol  = s.symbol
  LEFT JOIN hi   ON hi.symbol   = s.symbol
  LEFT JOIN lo   ON lo.symbol   = s.symbol
  LEFT JOIN gain ON gain.symbol = s.symbol
  LEFT JOIN lose ON lose.symbol = s.symbol
  LEFT JOIN ca   ON ca.symbol   = s.symbol
  LEFT JOIN security sec ON sec.symbol = s.symbol
  WHERE s.symbol IS NOT NULL AND s.symbol <> ''
`;

// The full board: one row per name any signal fired on in the window, with the
// points each family contributed (columns sum to `score`), how many distinct
// families fired (`signals` — the convergence count), ranked highest total
// first. `sessions` is a validated positive int (interpolated — DuckDB LIMIT /
// INTERVAL don't take bound params).
export async function huntBoard(sessions) {
  // N trading sessions ≈ the calendar span at ~5 sessions per 7 days (framework:
  // "21 trading sessions (~1 month)" → 21 → 30 days).
  const days = Math.ceil((sessions * 7) / 5);
  const [rows, news] = await Promise.all([queryJson(boardSql(days)), newsBySymbol()]);
  const num = (v) => Number(v) || 0;
  const board = new Map(); // symbol -> row

  for (const r of rows) {
    board.set(r.symbol, {
      symbol: r.symbol,
      company_name: r.company_name ?? null,
      insider: num(r.pts_insider),
      high_low_52w: num(r.pts_52w),
      gainers: num(r.pts_gainers),
      losers: num(r.pts_losers),
      corp_actions: num(r.pts_corp_actions),
      news: 0,
    });
  }
  // Fold in news — including names tagged only in the feed with no DB signal yet.
  for (const [symbol, v] of news) {
    const cur = board.get(symbol) ?? {
      symbol, company_name: v.company_name ?? null,
      insider: 0, high_low_52w: 0, gainers: 0, losers: 0, corp_actions: 0, news: 0,
    };
    cur.news += v.pts;
    if (!cur.company_name && v.company_name) cur.company_name = v.company_name;
    board.set(symbol, cur);
  }

  const out = [];
  for (const v of board.values()) {
    const parts = [v.insider, v.high_low_52w, v.gainers, v.losers, v.corp_actions, v.news];
    const score = parts.reduce((a, b) => a + b, 0);
    if (score === 0) continue;
    out.push({
      symbol: v.symbol,
      company_name: v.company_name,
      score,
      signals: parts.filter((p) => p > 0).length, // distinct families that fired
      insider: v.insider,
      high_low_52w: v.high_low_52w,
      gainers: v.gainers,
      losers: v.losers,
      corp_actions: v.corp_actions,
      news: v.news,
    });
  }
  // Highest total floats up; convergence (more independent signals) breaks ties.
  out.sort((a, b) => b.score - a.score || b.signals - a.signals || a.symbol.localeCompare(b.symbol));
  return out;
}

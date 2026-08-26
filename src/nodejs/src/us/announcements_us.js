// Announcements US — the 8-K feed for the side pane.
//
// The US counterpart to context/proposals/announcements-tab.md, which was
// written against NSE's an<date>.txt. Worth recording that the two ends of that
// proposal invert here: the parts it called hard on the India side do not exist
// on this one.
//
//   * SYMBOL. The proposal warns that NSE embeds the symbol at the end of the
//     company name, so "splitting needs care — match the trailing token against
//     security_master". An 8-K carries a CIK, so the symbol is a join, not a
//     parse. 89.4% of the last 90 days' filings resolve; the rest are funds,
//     trusts and other registrants with no ticker, which is a fact about them
//     rather than a miss.
//
//   * CATEGORY. The proposal's step 2 is bucketing free-text NSE subjects with
//     keyword rules. The SEC ships a structured item code per event, assigned
//     by the filer. The mapping below groups those codes; it never guesses.
//
//   * TIMESTAMP AND LINK. The proposal's §2 revision says the India digest has
//     neither, and plans a second index download to recover them. Both are
//     already on the 8-K row at 100% coverage over the last 90 days.
//
// NO VERDICT, and that is deliberate. §3 of the proposal is explicit that a
// sentiment call is an OPINION and must not be presented in the same register
// as disclosure. Every field below is either filed by the company or a lookup
// table of the SEC's own item numbering.

import { queryJson } from '#db.js';

// SEC 8-K item numbering (Form 8-K, General Instruction B).
//
// `priority` picks the headline when a filing carries several items, lowest
// first — a filing that is both "material agreement" and "Reg FD disclosure"
// leads with the agreement, because that is the event and the disclosure is the
// wrapper. It is a display order, NOT a materiality ranking: nothing here
// asserts that a 5.02 matters more to a reader than a 2.02.
const ITEMS = [
  // code, label, category, priority
  ['1.03', 'Bankruptcy or receivership',            'Distress',   1],
  ['4.02', 'Non-reliance on prior financials',      'Distress',   2],
  ['3.01', 'Delisting notice',                      'Distress',   3],
  ['2.06', 'Material impairment',                   'Distress',   4],
  ['2.05', 'Exit or disposal costs',                'Distress',   5],
  ['4.01', 'Change of auditor',                     'Distress',   6],
  ['5.01', 'Change in control',                     'Leadership', 7],
  ['2.01', 'Completed acquisition or disposal',     'Deal',       8],
  ['1.01', 'Material definitive agreement',         'Deal',       9],
  ['1.02', 'Terminated material agreement',         'Deal',      10],
  ['5.02', 'Director or officer change',            'Leadership',11],
  ['2.02', 'Results of operations',                 'Results',   12],
  ['3.02', 'Unregistered equity sale',              'Financing', 13],
  ['2.03', 'Direct financial obligation created',   'Financing', 14],
  ['2.04', 'Obligation acceleration triggered',     'Financing', 15],
  ['3.03', 'Modified security-holder rights',       'Governance',16],
  ['5.03', 'Charter or bylaw amendment',            'Governance',17],
  ['5.07', 'Shareholder vote',                      'Governance',18],
  ['5.08', 'Shareholder director nominations',      'Governance',19],
  ['5.06', 'Shell company status change',           'Governance',20],
  ['5.05', 'Code of ethics amendment',              'Governance',21],
  ['5.04', 'Trading suspension, benefit plans',     'Governance',22],
  ['1.04', 'Mine safety',                           'Other',     23],
  ['7.01', 'Regulation FD disclosure',              'Disclosure',24],
  ['8.01', 'Other events',                          'Disclosure',25],
];

const caseOn = (col, idx, fallback) =>
  `CASE ${ITEMS.map(([code, ...rest]) => `WHEN '${code}' THEN ${
    typeof rest[idx] === 'number' ? rest[idx] : `'${String(rest[idx]).replace(/'/g, "''")}'`
  }`).join(' ')} ELSE ${fallback} END`.replace('CASE ', `CASE ${col} `);

/**
 * Recent 8-K filings, newest first, one row per filing.
 *
 * ITEM 9.01 IS DROPPED, and it is the single most common code — 11,820 of the
 * last 90 days' items against 3,984 for the next one. "Financial Statements and
 * Exhibits" is the notice that an attachment rides along with a real item, not
 * an event of its own. Left in, the noisiest code would be the loudest thing in
 * the feed. This is the same call the proposal makes for NSE, where "most of
 * the 2,584 daily rows are routine compliance filings; the value is in
 * filtering those OUT".
 *
 * A filing whose ONLY item is 9.01 therefore disappears entirely, which is
 * correct: it carries no event this feed can name.
 */
export function usAnnouncements(days, limit) {
  return queryJson(`
    WITH one_symbol AS (
      -- A CIK can list several tickers (share classes). Pick one so a filing
      -- appears once: shortest, then alphabetical, which is the tiebreak
      -- gl_symbol already uses on the NSE side and prefers the ordinary line
      -- over the class variants.
      SELECT cik, symbol, name, sic_description, exchanges FROM (
        SELECT cik, symbol, name, sic_description, exchanges,
               row_number() OVER (PARTITION BY cik ORDER BY length(symbol), symbol) AS rn
        FROM us_sec_symbol
      ) WHERE rn = 1
    ),
    k AS (
      SELECT accn, cik, filed, period, accepted, items, document
      FROM us_sec_filings
      WHERE form = '8-K' AND items IS NOT NULL AND items <> ''
    ),
    f0 AS (
      -- Anchored to the newest filing day IN THE DATA, not to current_date.
      --
      -- days=1 therefore means "the last day that actually filed", which is
      -- yesterday whenever the EDGAR archive is current and is still a full
      -- day of real filings when it is not. Anchoring on current_date instead
      -- would empty the pane on a weekend, a holiday, or any day the archive
      -- has not been refreshed — and an empty pane reads as "nothing was
      -- announced" rather than "we have not pulled it yet". Same reasoning as
      -- the NSE screens picking max(as_of) off their view.
      SELECT * FROM k
      WHERE filed > (SELECT max(filed) FROM k) - INTERVAL ${days} DAY
    ),
    f AS (
      SELECT *,
             -- The first DATE on which the market could have traded on this
             -- filing. EDGAR acceptance stamps are UTC — verified from their
             -- own distribution, which peaks at 20:00-21:00 UTC (16:00-17:00
             -- ET, right after the close) and runs to 02:00 UTC (22:00 ET,
             -- EDGAR's cutoff) with nothing between 02:00 and 06:00. Read as
             -- ET those hours would be impossible.
             --
             -- So an after-close filing must NOT be scored against the session
             -- it was filed on: that session had already ended. Tredegar's
             -- 21:30 UTC = 17:30 ET filing is the exact case — showing the
             -- 20-AUG bar as its "reaction" would be reporting a move that
             -- happened before the filing existed.
             --
             -- Converted through America/New_York rather than subtracting a
             -- fixed offset, so the 16:00 close lands correctly in both EDT
             -- (UTC-4) and EST (UTC-5).
             CASE
               WHEN accepted IS NULL THEN filed
               WHEN hour(timezone('America/New_York', timezone('UTC', accepted))) >= 16
                 THEN filed + INTERVAL 1 DAY
               ELSE filed
             END AS tradable_from
      FROM f0
    ),
    -- FIRST SESSION ON OR AFTER THE FILING DATE.
    --
    -- This is a FACT, not a verdict: the close and move of a real bar on a
    -- stated date. It deliberately does not claim the filing CAUSED the move,
    -- which is why the date always travels with the number.
    --
    -- Bounded to a 10-day lookahead so this cannot scan the whole 19M-row bar
    -- table per filing; a symbol with no bar in that window simply has no
    -- reaction, which is honest for a delisted or untraded name.
    react AS (
      SELECT accn, as_of, close, pct_change FROM (
        SELECT f.accn, p.as_of, p.close, p.pct_change,
               row_number() OVER (PARTITION BY f.accn ORDER BY p.as_of) AS rn
        FROM f
        JOIN one_symbol s ON s.cik = f.cik
        JOIN us_dbn_prices p
          ON p.symbol = s.symbol
         AND p.as_of >= f.tradable_from
         AND p.as_of <= f.tradable_from + INTERVAL 10 DAY
      ) WHERE rn = 1
    ),
    ex AS (
      -- DISTINCT, and it is load-bearing. A filing is listed once PER CIK that
      -- references it — co-registrants, a parent and its financing subsidiary —
      -- so sec_filings holds 219 rows for 210 accessions on a typical day, one
      -- accession carrying three. Their items strings are identical, so
      -- aggregating without DISTINCT repeated every code two or three times:
      -- item_count was inflated, the "+N more" badge lied, and the detail panel
      -- rendered "1.01 Material definitive agreement" three times over.
      SELECT DISTINCT accn, item FROM (
        SELECT accn, trim(unnest(str_split(items, ','))) AS item FROM f
      ) WHERE item <> '' AND item <> '9.01'
    ),
    lab AS (
      SELECT accn, item,
             ${caseOn('item', 0, "'Item ' || item")}  AS label,
             ${caseOn('item', 1, "'Other'")}          AS category,
             ${caseOn('item', 2, '99')}               AS priority
      FROM ex
    ),
    agg AS (
      SELECT accn,
             -- The headline is the highest-priority item's label; the rest stay
             -- visible as codes so nothing is hidden by the choice.
             arg_min(label, priority)    AS headline,
             arg_min(category, priority) AS category,
             string_agg(item, ', ' ORDER BY item) AS item_codes,
             -- Every item spelled out, for the hover detail. The row can only
             -- show one headline; this is what the reader opens to see the
             -- rest, so a filing that is BOTH an agreement and an equity sale
             -- does not look like only the first.
             string_agg(item || '  ' || label, ' | ' ORDER BY item) AS items_detail,
             count(*) AS item_count
      FROM lab GROUP BY accn
    )
    SELECT * EXCLUDE (rn) FROM (
    SELECT row_number() OVER (
             -- Same co-registrant problem on the output side: without this the
             -- feed shows one filing two or three times, once per registrant.
             -- Shortest-then-alphabetical symbol is the tiebreak one_symbol and
             -- gl_symbol already use, and it favours the parent's ordinary
             -- ticker over a subsidiary's.
             PARTITION BY f.accn ORDER BY length(s.symbol), s.symbol
           ) AS rn,
           s.symbol,
           s.name AS company,
           nullif(trim(s.sic_description), '') AS sector,
           nullif(trim(s.exchanges), '') AS exchanges,
           a.headline,
           a.category,
           a.item_codes,
           a.items_detail,
           a.item_count,
           f.filed,
           -- The date the EVENT happened, which an 8-K states separately from
           -- when it was filed. They differ often enough to matter: a filing on
           -- the 20th can be reporting something from the 17th.
           f.period AS event_date,
           f.accepted,
           r.as_of AS react_date,
           r.close AS react_close,
           r.pct_change AS react_pct,
           -- EDGAR's archive path wants the accession number without dashes in
           -- the directory and the plain CIK, so it is assembled rather than
           -- stored: .../data/<cik>/<accn-no-dashes>/<primaryDocument>
           'https://www.sec.gov/Archives/edgar/data/' || f.cik || '/'
             || replace(f.accn, '-', '') || '/' || f.document AS url
    FROM agg a
    JOIN f ON f.accn = a.accn
    JOIN one_symbol s ON s.cik = f.cik
    LEFT JOIN react r ON r.accn = a.accn
    ) WHERE rn = 1
    ORDER BY accepted DESC NULLS LAST, symbol
    LIMIT ${limit}
  `);
}

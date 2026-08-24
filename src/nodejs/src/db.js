// Layer A base views — DuckDB SQL over data/extracts/*/ (bhavcopy on disk).
// Mirrors src/python/screens.py's _base_views() exactly; single source of
// truth for the screen SQL lives in the Python CLI, this just reuses it.
//
// v1 reads local disk. MinIO/WORM serving is v2 — flip the globs to
// `s3://raw/` when that lands.

import { DuckDBInstance } from '@duckdb/node-api';
import path from 'node:path';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROOT } from '#paths.js';


const EXTRACTS = path.join(ROOT, 'data', 'extracts').split(path.sep).join('/');
// US working root — S&P 500 bars from Yahoo, split into the same YYYYMMDD day
// folders as the NSE extracts so FOLDER_DATE and the screen SQL carry over
// unchanged. Built by src/python/us_market_pull.py.
const EXTRACTS_US = path.join(ROOT, 'data', 'extracts_us').split(path.sep).join('/');
// SEC Forms 3/4/5 quarterly data sets, one folder per <YYYYqN>.
// Built by src/python/sec_insider_pull.py.
const EXTRACTS_SEC = path.join(ROOT, 'data', 'extracts_sec').split(path.sep).join('/');
// Consolidated single-file store (permanent shape for filing data — quarterly/
// event filings were never a good fit for day partitioning). Built by
// src/python/shareholding_load.py and src/python/insider_load.py.
const STORE = path.join(ROOT, 'data', 'store').split(path.sep).join('/');

// NSE month names are UPPERCASE ("23-JUL-2025"); strptime %b matches case-insensitively.
const D = (col) => `try_strptime(${col}, '%d-%b-%Y')::date`;

// The YYYYMMDD extracts folder a file came from. read_csv's `filename` carries
// the OS's own separator, so the '/([0-9]{8})/' regex this replaced matched
// nothing on Windows — every extraction returned '', which crashed the circuit
// view outright (strptime('') throws) and broke the rest silently: max('') = ''
// made security_master's "latest file only" filter match every file, and the
// hi52 / lo52 / mcap / pe "newest folder wins" dedups fell back to arbitrary
// order. parse_path(..., 'both_slash') splits on either separator; [-2] is the
// folder holding the file. Don't reach for a bare '([0-9]{8})' here — these
// filenames carry their own 8-digit DDMMYYYY stamp (bh21052026.csv).
const FOLDER_DATE = (col = 'filename') => `parse_path(${col}, 'both_slash')[-2]`;

let connectionPromise = null;

async function createConnection() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  const bhav = `${EXTRACTS}/*/sec_bhavdata_full*.csv`;
  const wk = `${EXTRACTS}/*/CM_52_wk_High_low*.csv`;
  const sec = `${EXTRACTS}/*/NSE_CM_security_*.csv`;
  const bh = `${EXTRACTS}/*/bh*.csv`;
  const gl = `${EXTRACTS}/*/gl*.csv`;
  const mcapCsv = `${EXTRACTS}/*/mcap*.csv`;
  const peCsv = `${EXTRACTS}/*/PE_*.csv`;
  const bc = `${EXTRACTS}/*/bc*.csv`;
  // Filing facts now live in one consolidated file each (not a per-day glob).
  const promoterStore = `${STORE}/shareholding.parquet`;
  const insiderStore = `${STORE}/insider.parquet`;
  const shareholdingFactsStore = `${STORE}/shareholding_facts.parquet`;

  await connection.run(`
    CREATE OR REPLACE VIEW prices AS
    SELECT ${D('date1')} AS as_of,
           trim(symbol) AS symbol, trim(series) AS series,
           TRY_CAST(prev_close AS DOUBLE) AS prev_close,
           TRY_CAST(close_price AS DOUBLE) AS close,
           TRY_CAST(ttl_trd_qnty AS DOUBLE) AS qty,
           TRY_CAST(turnover_lacs AS DOUBLE) AS turnover_lacs,
           round((TRY_CAST(close_price AS DOUBLE) - TRY_CAST(prev_close AS DOUBLE))
                 / nullif(TRY_CAST(prev_close AS DOUBLE), 0) * 100, 2) AS pct_change
    FROM read_csv('${bhav}', header=true, all_varchar=true, normalize_names=true,
                  filename=true, union_by_name=true)
    WHERE trim(series) = 'EQ'
  `);

  // One row per (symbol, high-date) = the value from the LATEST daily snapshot.
  // adjusted_52_week_high is corporate-action-adjusted and changes across files
  // for the same high-date after a bonus/split; a plain DISTINCT would keep both
  // the stale and adjusted values, so we keep only the most-recent file's figure.
  await connection.run(`
    CREATE OR REPLACE VIEW hi52 AS
    SELECT symbol, series, event_date, price FROM (
      SELECT trim(symbol) AS symbol, trim(series) AS series,
             ${D('_52_week_high_date')} AS event_date,
             TRY_CAST(replace(adjusted_52_week_high, ' ', '') AS DOUBLE) AS price,
             row_number() OVER (
               PARTITION BY trim(symbol), ${D('_52_week_high_date')}
               ORDER BY ${FOLDER_DATE()} DESC
             ) AS rn
      FROM read_csv('${wk}', header=true, all_varchar=true, normalize_names=true,
                    skip=2, filename=true, union_by_name=true)
      WHERE ${D('_52_week_high_date')} IS NOT NULL AND trim(series) = 'EQ'
    ) WHERE rn = 1
  `);

  await connection.run(`
    CREATE OR REPLACE VIEW lo52 AS
    SELECT symbol, series, event_date, price FROM (
      SELECT trim(symbol) AS symbol, trim(series) AS series,
             ${D('_52_week_low_dt')} AS event_date,
             TRY_CAST(replace(adjusted_52_week_low, ' ', '') AS DOUBLE) AS price,
             row_number() OVER (
               PARTITION BY trim(symbol), ${D('_52_week_low_dt')}
               ORDER BY ${FOLDER_DATE()} DESC
             ) AS rn
      FROM read_csv('${wk}', header=true, all_varchar=true, normalize_names=true,
                    skip=2, filename=true, union_by_name=true)
      WHERE ${D('_52_week_low_dt')} IS NOT NULL AND trim(series) = 'EQ'
    ) WHERE rn = 1
  `);

  // official company name per symbol (NSE security master), exact FinInstrmNm
  // string as-is. Not every symbol has an EQ row (SME board symbols only ever
  // list under SM/SL/SQ/ST) so this doesn't filter by series - just picks the
  // most recent date folder's row per symbol (name is the same across series).
  //
  // TABLE, not a view — and this one matters. As a view it re-read every
  // NSE_CM_security_*.csv in every date folder on every query that shows a
  // company name, which is most of them. Free at 5 folders, 1.8s at 58:
  // measured 2026-07-27, the recurrence endpoint spent 2,288ms of its 2,943ms
  // right here, and it grows with each backfill. Materialised it reads in 6ms.
  //
  // Restricting the glob to the newest file was tried and rejected: the
  // filename filter isn't pushed down (still 1,062ms) and it drops the 137
  // delisted/suspended symbols that only appear in older masters.
  //
  // Trade-off is staleness — this snapshots at connection time, so a symbol
  // listed after the API booted has no name until restart. Everything
  // date-partitioned (prices, hi52, circuit) stays a view and stays live.
  await connection.run(`
    CREATE OR REPLACE TABLE security AS
    SELECT symbol, company_name FROM (
      SELECT trim(tckrsymb) AS symbol, trim(fininstrmnm) AS company_name,
             row_number() OVER (PARTITION BY trim(tckrsymb) ORDER BY filename DESC, sctysrs) AS rn
      FROM read_csv('${sec}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
    ) WHERE rn = 1
  `);

  // Search-facing security master — the LATEST cm_security file only (its
  // YYYYMMDD folder is the max across the extracts), one row per (symbol,
  // series) with the exact NSE strings: TckrSymb, SctySrs, FinInstrmNm, ISIN.
  // The Stock Centric search filters on this by series (default EQ), so the
  // whole per-series universe is queryable, not a single deduped row per symbol.
  //
  // Also a TABLE, same reason as `security`: "the latest file" is computed from
  // max(file_date) *after* reading them all, so as a view it paid the full
  // 58-file scan on every search keystroke.
  await connection.run(`
    CREATE OR REPLACE TABLE security_master AS
    WITH raw AS (
      SELECT trim(tckrsymb) AS symbol, trim(sctysrs) AS series,
             trim(fininstrmnm) AS company_name, trim(isin) AS isin,
             ${FOLDER_DATE()} AS file_date
      FROM read_csv('${sec}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
    )
    SELECT DISTINCT symbol, series, company_name, isin
    FROM raw
    WHERE file_date = (SELECT max(file_date) FROM raw) AND symbol <> ''
  `);

  // upper/lower circuit hitters - real NSE data, not a heuristic: bh<date>.csv
  // ("securities which have hit their price bands during the day", per NSE's
  // own readme.txt shipped in the daily PR bundle). H = upper, L = lower.
  // No date column in the file itself - as_of comes from the YYYYMMDD extracts
  // folder embedded in the file's own path.
  // NSE's own gainers/losers list (gl<date>.csv), the authoritative source for
  // which stocks moved and by how much: GAIN_LOSS is NSE's G/L flag and
  // PERCENT_CG its own % change, so nothing is recomputed from close/prev_close.
  //
  // It keys on company name only — no symbol, no series — so it has to be
  // bridged through the security master. Two traps, both measured 2026-07-27:
  //
  //  * Do NOT filter the master to series 'EQ'. gl covers the SME boards too and
  //    those never list as EQ (SM/SL/SQ/ST), so an EQ-only bridge resolved just
  //    64.7% of names and silently dropped 1,346 real listings. Across all
  //    series it resolves 96.6% with zero unmatched.
  //  * DelFlg='N' is what disambiguates. A name like "TATA CONSUMER PRODUCT LTD"
  //    maps to both TATACONSUM and the dead TATACON-RE rights entitlement;
  //    honouring the master's delete flag drops the corpse (135 names still tie,
  //    broken below by preferring EQ, then the shorter symbol).
  //
  // The series filter is what keeps debt off an equity board, NOT the symbol
  // being non-null — NCDs have symbols too (1025SCL34 was ranking as a top
  // "gainer" until this landed). Main board is EQ only: BE is the trade-to-trade
  // segment and anything genuinely listed there also carries an EQ row, so
  // including it bought nothing and widened the ambiguity. SME keeps SM/ST/SL/SQ
  // — those boards never issue an EQ row at all, and dropping them silently lost
  // 1,346 real listings. Bonds and SGBs sit on numeric/letter debt series (18,
  // Z8, N9, U9), so they stay unresolved and the screens' `symbol IS NOT NULL`
  // drops them.
  //
  // read_csv's normalize_names mangles the SECURITY column to `_security`
  // (leading underscore) — it collides with a reserved word. Don't "fix" it.
  await connection.run(`
    CREATE OR REPLACE TABLE gl_symbol AS
    SELECT name_key, symbol FROM (
      SELECT upper(trim(fininstrmnm)) AS name_key, trim(tckrsymb) AS symbol,
             row_number() OVER (
               PARTITION BY upper(trim(fininstrmnm))
               ORDER BY (trim(sctysrs) = 'EQ') DESC,
                        length(trim(tckrsymb)), trim(tckrsymb)
             ) AS rn
      FROM read_csv('${sec}', header=true, all_varchar=true, normalize_names=true,
                    union_by_name=true)
      WHERE trim(delflg) = 'N' AND trim(fininstrmnm) <> ''
        AND trim(sctysrs) IN ('EQ', 'SM', 'ST', 'SL', 'SQ')
    ) WHERE rn = 1
  `);

  // One row per (session, security) with NSE's direction and % move, carrying
  // the resolved symbol. Rows that still don't bridge (bonds, SGBs — gl is not
  // equity-only) keep a NULL symbol rather than being dropped, so a screen can
  // decide for itself whether to require one.
  await connection.run(`
    CREATE OR REPLACE VIEW gainloss AS
    SELECT * FROM (
      SELECT try_strptime(${FOLDER_DATE()}, '%Y%m%d')::date AS as_of,
             b.symbol AS symbol,
             trim(g._security) AS security_name,
             trim(g.gain_loss) AS direction,
             TRY_CAST(trim(g.percent_cg) AS DOUBLE) AS pct_change,
             TRY_CAST(trim(g.close_pric) AS DOUBLE) AS close,
             TRY_CAST(trim(g.prev_cl_pr) AS DOUBLE) AS prev_close
      FROM read_csv('${gl}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true) g
      LEFT JOIN gl_symbol b ON b.name_key = upper(trim(g._security))
      WHERE trim(g.gain_loss) IN ('G', 'L')
    ) WHERE as_of IS NOT NULL AND pct_change IS NOT NULL
  `);

  //
  // try_strptime, not strptime, and unparseable rows are dropped rather than
  // raised: a single file whose path doesn't yield a YYYYMMDD folder used to
  // take the entire view down with "Could not parse string ''", which surfaced
  // as a 500 on both circuit screens. One odd file should cost its own rows,
  // not every session's. The screens pick max(as_of) off this view, so a
  // missing T-1 just means the last session that actually shipped a bh file
  // wins — no hard fail when the newest folder is a holiday or a partial drop.
  await connection.run(`
    CREATE OR REPLACE VIEW circuit AS
    SELECT * FROM (
      SELECT try_strptime(${FOLDER_DATE()}, '%Y%m%d')::date AS as_of,
             trim(symbol) AS symbol, trim(series) AS series, trim(highlow) AS hit
      FROM read_csv('${bh}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
      WHERE trim(series) = 'EQ'
    ) WHERE as_of IS NOT NULL
  `);

  // Layer B (stock-centric) — consolidated single-file stores, all history in
  // one file each (no per-day gaps). Promoter/public % come straight from the
  // shareholding filing index (src/python/shareholding_load.py); insider qty/
  // value are the lossless XBRL shred (src/python/insider_load.py).

  // Promoter holding per (symbol, quarter): the whole 2020->today series, so a
  // symbol's history and its change are queryable regardless of which day it
  // filed. symbol is resolved at load time (NULL where a name didn't map).
  await connection.run(`
    CREATE OR REPLACE VIEW promoter_history AS
    SELECT symbol, company, as_on_date, promoter_pct, public_pct,
           employee_trust_pct, status, submission_date
    FROM read_parquet('${promoterStore}')
    WHERE symbol IS NOT NULL
  `);

  // Insider trading — lossless facts (grows as the backfill runs; the file is
  // checkpointed). Missing file => empty view so the API still boots.
  await connection.run(`
    CREATE OR REPLACE VIEW insider_facts AS
    SELECT * FROM read_parquet('${insiderStore}', union_by_name=true)
  `);
  // Shareholding XBRL facts — only still used by the NSE FII/DII drill-down
  // fallback (screener.in is the primary source). Consolidated from the days
  // xbrl_populate.py had run against.
  await connection.run(`
    CREATE OR REPLACE VIEW shareholding_facts AS
    SELECT * FROM read_parquet('${shareholdingFactsStore}', union_by_name=true)
  `);

  // B4 drill-down daily metrics: latest market cap (mcap<date>.csv) and P/E
  // (PE_<date>.csv) per EQ symbol. as_of = the YYYYMMDD extracts folder in the
  // file's path (most recent session wins), same trick as the circuit view.
  await connection.run(`
    CREATE OR REPLACE VIEW mcap_latest AS
    SELECT symbol, market_cap, close_price, face_value FROM (
      SELECT trim(symbol) AS symbol, trim(series) AS series,
             TRY_CAST(trim(market_caprs) AS DOUBLE) AS market_cap,
             TRY_CAST(trim(close_pricepaid_up_valuers) AS DOUBLE) AS close_price,
             TRY_CAST(trim(face_valuers) AS DOUBLE) AS face_value,
             row_number() OVER (PARTITION BY trim(symbol)
               ORDER BY ${FOLDER_DATE()} DESC) AS rn
      FROM read_csv('${mcapCsv}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
      WHERE trim(series) = 'EQ'
    ) WHERE rn = 1
  `);
  await connection.run(`
    CREATE OR REPLACE VIEW pe_latest AS
    SELECT symbol, symbol_pe, adjusted_pe FROM (
      SELECT trim(symbol) AS symbol, TRY_CAST(symbol_pe AS DOUBLE) AS symbol_pe,
             -- PE_<date>.csv ships BOTH figures and they diverge after a bonus,
             -- split or rights (THERMAX 71.33 vs 75.95). Only symbol_pe used to
             -- be read, so the adjusted one was invisible; carry both and let
             -- the drilldown show them side by side rather than pick silently.
             TRY_CAST(adjusted_pe AS DOUBLE) AS adjusted_pe,
             row_number() OVER (PARTITION BY trim(symbol)
               ORDER BY ${FOLDER_DATE()} DESC) AS rn
      FROM read_csv('${peCsv}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
    ) WHERE rn = 1
  `);

  // Layer C - corporate actions. bc<date>.csv ("corporate action details for
  // securities", per NSE's PR-bundle readme): dividends, splits, bonus, rights,
  // interest, buybacks, meetings - each with ex-date + record-date. Dates are
  // already ISO. Files overlap across daily downloads (an action stays listed
  // until its ex-date passes), so DISTINCT dedups. PURPOSE is free text; bucket
  // it into a category with keyword rules. EQ only, per the project-wide filter.
  await connection.run(`
    CREATE OR REPLACE VIEW corp_actions AS
    SELECT DISTINCT
      trim(symbol) AS symbol, trim(series) AS series,
      nullif(trim(ex_dt), '') AS ex_date,
      nullif(trim(record_dt), '') AS record_date,
      CASE
        WHEN upper(purpose) LIKE '%INTEREST%' THEN 'Interest'
        WHEN upper(purpose) LIKE 'DIV%' OR upper(purpose) LIKE '%DIVIDEND%'
          OR upper(purpose) LIKE 'INTDIV%' OR upper(purpose) LIKE '%SPDV%' THEN 'Dividend'
        WHEN upper(purpose) LIKE '%FVSPLT%' OR upper(purpose) LIKE '%SPLIT%'
          OR upper(purpose) LIKE '%SUB-DIV%' THEN 'Split'
        WHEN upper(purpose) LIKE '%BONUS%' THEN 'Bonus'
        WHEN upper(purpose) LIKE '%RIGHT%' THEN 'Rights'
        WHEN upper(purpose) LIKE '%BUY%BACK%' THEN 'Buyback'
        WHEN upper(purpose) LIKE '%AGM%' OR upper(purpose) LIKE '%EGM%'
          OR upper(purpose) LIKE '%MEETING%' THEN 'Meeting'
        WHEN upper(purpose) LIKE '%AMALGAMAT%' OR upper(purpose) LIKE '%MERGER%'
          OR upper(purpose) LIKE '%SCHEME%' OR upper(purpose) LIKE '%ARRANGEMENT%' THEN 'Restructuring'
        ELSE 'Other'
      END AS category,
      trim(purpose) AS purpose
    FROM read_csv('${bc}', header=true, all_varchar=true, normalize_names=true,
                  filename=true, union_by_name=true)
    WHERE trim(series) = 'EQ' AND nullif(trim(purpose), '') IS NOT NULL
  `);

  // ---------------------------------------------------------------- Markets US
  //
  // Temporary S&P 500 counterpart to the NSE screens, fed by Yahoo via
  // src/python/us_market_pull.py. The day-folder layout is identical, so
  // FOLDER_DATE works unchanged.
  //
  // THE IMPORTANT DIFFERENCE FROM THE NSE SIDE: NSE publishes prev-close, the
  // gain/loss direction and a 52-week high/low list as authoritative files. For
  // the US there is no such thing, so every one of those is DERIVED here from
  // the bar history. That is the honest place for it — same as the NSE screens
  // deriving from NSE's files rather than baking values in at load time — but
  // it means a US "new 52-week high" is our computation, not an exchange's.
  // TABLE, not VIEW, for the same reason as the SEC tables: as views these
  // re-parsed 1,255 day files on every request. Views are lazy, so the
  // startup warm-up created them without reading anything and the first real
  // query still paid the full parse — 26s, past the Vercel proxy's 25s budget,
  // which surfaced as a 502 in production rather than merely a slow page.
  // Materialising moves it into the warm-up where it is paid once.
  // No usBars glob any more: data/extracts_us/<YYYYMMDD>/sp500_bars_*.csv is no
  // longer read. Databento backs us_daily and Yahoo is an on-demand fetch, so
  // those 1,257 day folders are history on disk that nothing queries. Dropping
  // the glob is most of why startup fell from 10.6s to 8.3s.
  const usRoster = `${EXTRACTS_US}/_meta/sp500_constituents.csv`;

  await connection.run(`
    CREATE OR REPLACE TABLE us_roster AS
    SELECT trim(symbol) AS wiki_symbol,
           -- Wikipedia writes class shares with a dot (BRK.B), Yahoo with a
           -- dash (BRK-B). Bars carry the Yahoo form, so bridge on that.
           replace(trim(symbol), '.', '-') AS symbol,
           -- _security, not security: normalize_names underscore-prefixes
           -- reserved words, the same way NSE's SECURITY becomes _security.
           -- And "GICS Sub-Industry" normalises to gics_subindustry — the
           -- hyphen is dropped rather than becoming an underscore.
           trim(_security) AS company_name,
           trim(gics_sector) AS sector,
           trim(gics_subindustry) AS sub_industry
    FROM read_csv('${usRoster}', header=true, all_varchar=true, normalize_names=true)
  `);

  // Confirmed stock splits only. Built by src/python/us_stock_splits_detect.py:
  // cross-validates SEC shares-outstanding jumps against Databento's own price
  // series, and writes ratio=NULL for anything it could not independently
  // confirm rather than guessing. Only 'confirmed' rows are loaded here — an
  // unconfirmed candidate must never adjust a real price.
  //
  // Small (927 confirmed rows against a full market), materialised as a TABLE
  // so both us_daily and us_dbn_prices below can join it without re-reading
  // the source Parquet's confidence column repeatedly.
  const splitsFile = path.join(ROOT, 'data', 'store', 'us_stock_splits.parquet');
  const splitsP = `${STORE}/us_stock_splits.parquet`;
  // fsSync.existsSync directly, not the has() helper — that is declared later
  // in this function (Stock Centric US Live lane section) and this table is
  // built earlier, before has() exists in scope.
  if (fsSync.existsSync(splitsFile)) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_stock_splits AS
      SELECT symbol, cik, effective_date::DATE AS effective_date, ratio
      FROM read_parquet('${splitsP}')
      WHERE confidence = 'confirmed'
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_stock_splits AS
      SELECT NULL::VARCHAR AS symbol, NULL::VARCHAR AS cik,
             NULL::DATE AS effective_date, NULL::DOUBLE AS ratio WHERE FALSE
    `);
  }

  // One row per (session, symbol). DATABENTO ONLY.
  //
  // Yahoo is no longer a bulk source for this table. It is an on-demand fetch
  // for symbols Databento does not carry, so it never lands in the stored
  // history and never sits beside a Databento row in the same window. That
  // matters because the two are not the same measurement: Databento's close is
  // the last Nasdaq-executed trade and its volume is Nasdaq-executed only,
  // where Yahoo's are consolidated. Blending them would make a volume-ranked
  // screen rank the feed rather than the activity.
  //
  // The old data/extracts_us/<YYYYMMDD>/sp500_bars_*.csv folders are therefore
  // NOT read here any more. They stay on disk as history; nothing queries them.
  //
  // If the Databento parquet is absent this table is EMPTY, not silently
  // repopulated from Yahoo. A board showing nothing is honest; a board showing
  // a different feed under the same column headings is not.
  //
  // adj_open/adj_high/adj_low/adj_close ARE REAL NOW, computed from
  // us_stock_splits. Raw open/high/low/close are left untouched beside them —
  // never mutated, same principle as companyfacts restatements — so a caller
  // can audit the adjustment by comparing the two directly.
  //
  // cum_factor is exp(sum(ln(ratio))), not a PRODUCT aggregate: DuckDB has no
  // built-in product(). Ratios are always > 0 (real close/close prints), so
  // the log-sum-exp identity is exact. It multiplies every bar strictly BEFORE
  // a confirmed split's effective_date by that split's ratio (and by every
  // later split's ratio too, compounding) — bars on or after the last split
  // get factor 1, i.e. raw == adjusted, matching the current share count.
  //
  // stock_splits carries the ratio on its OWN effective date, NULL elsewhere —
  // NULL, not 0. The detector has real coverage gaps (history before
  // Databento's 2018-05-01 start, unmapped tickers), so "we found no confirmed
  // split here" is not the same claim as "we verified none happened."
  const dbnBarsFile = path.join(ROOT, 'data', 'extracts_us', '_meta', 'databento_ohlcv.parquet');
  const dbnBars = `${EXTRACTS_US}/_meta/databento_ohlcv.parquet`;

  if (fsSync.existsSync(dbnBarsFile)) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_daily AS
      -- series_id survives into this table: it is what keeps a reused ticker's
      -- two instruments apart, and dropping it here would undo the loader's
      -- guard the moment a window function partitions by symbol alone.
      WITH raw AS (
        SELECT date::date AS as_of, symbol, series_id, open, high, low, close, volume
        FROM read_parquet('${dbnBars}')
        WHERE date IS NOT NULL AND close IS NOT NULL
      ),
      factor AS (
        SELECT r.symbol, r.as_of, exp(sum(ln(s.ratio))) AS cum_factor
        FROM raw r
        JOIN us_stock_splits s ON s.symbol = r.symbol AND s.effective_date > r.as_of
        GROUP BY r.symbol, r.as_of
      )
      SELECT r.as_of, r.symbol, r.series_id,
             r.open, r.high, r.low, r.close,
             r.close * COALESCE(f.cum_factor, 1.0) AS adj_close,
             r.open  * COALESCE(f.cum_factor, 1.0) AS adj_open,
             r.high  * COALESCE(f.cum_factor, 1.0) AS adj_high,
             r.low   * COALESCE(f.cum_factor, 1.0) AS adj_low,
             r.volume,
             NULL::DOUBLE AS dividends,
             sp.ratio AS stock_splits,
             'databento' AS source
      FROM raw r
      LEFT JOIN factor f ON f.symbol = r.symbol AND f.as_of = r.as_of
      LEFT JOIN us_stock_splits sp ON sp.symbol = r.symbol AND sp.effective_date = r.as_of
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_daily AS
      SELECT NULL::DATE AS as_of, NULL::VARCHAR AS symbol, NULL::BIGINT AS series_id,
             NULL::DOUBLE AS open, NULL::DOUBLE AS high, NULL::DOUBLE AS low,
             NULL::DOUBLE AS close, NULL::DOUBLE AS adj_close, NULL::DOUBLE AS adj_open,
             NULL::DOUBLE AS adj_high, NULL::DOUBLE AS adj_low, NULL::DOUBLE AS volume,
             NULL::DOUBLE AS dividends, NULL::DOUBLE AS stock_splits,
             NULL::VARCHAR AS source WHERE FALSE
    `);
  }

  // Derived per-session move + trailing 52-week extremes.
  //
  // 252 rows ~= one trading year. The window is ROWS, not RANGE over dates, so
  // a symbol's own trading days are counted and holidays don't shorten it.
  // `sessions_seen` exists so a screen can refuse to call something a 52-week
  // high when we simply don't hold 52 weeks of history for it yet — without
  // that guard every symbol's earliest bars look like records.
  await connection.run(`
    CREATE OR REPLACE TABLE us_prices AS
    SELECT
      as_of, symbol, series_id, source,
      open, high, low, close, adj_open, adj_high, adj_low, adj_close, volume,
      -- prev_close, pct_change, hi_52w, lo_52w are computed off ADJUSTED
      -- values, not raw. Raw stays exposed alongside for audit, but a
      -- 52-week high computed on raw prices across a split boundary is not a
      -- real record: verified against NVDA's actual 2024-06-10 10-for-1 split,
      -- the raw hi_252d read ~$1,255 for a full year afterward while the stock
      -- traded at $128-144 -- an unreachable ceiling that silently kept the
      -- 52-week-high screen from ever firing for it. See
      -- src/python/us_stock_splits_detect.py and
      -- context/proposals/us-source-lanes.md for the full finding.
      lag(adj_close) OVER w AS prev_close,
      CASE WHEN lag(adj_close) OVER w > 0
           THEN round((adj_close - lag(adj_close) OVER w) / lag(adj_close) OVER w * 100, 4)
      END AS pct_change,
      max(adj_high) OVER w52 AS hi_52w,
      min(adj_low)  OVER w52 AS lo_52w,
      count(*)  OVER w52 AS sessions_seen
    FROM us_daily
    -- PARTITION BY (symbol, series_id), never symbol alone. A reused ticker
    -- holds two unrelated instruments under one symbol — IBIT is a penny stock
    -- until 2022 and the iShares trust from 2024-01-11 — and a window spanning
    -- the seam would produce a 52-week high drawn from a different company.
    -- The loader detects the seam; this is where that work is either honoured
    -- or silently thrown away.
    WINDOW
      w   AS (PARTITION BY symbol, series_id ORDER BY as_of),
      w52 AS (PARTITION BY symbol, series_id ORDER BY as_of
              ROWS BETWEEN 251 PRECEDING AND CURRENT ROW)
  `);

  // Gainers/losers per session, ranked. The tiebreaker on symbol is deliberate:
  // without it the rank window is nondeterministic and two identical requests
  // can return different rows (this bit the NSE recurrence screens).
  await connection.run(`
    CREATE OR REPLACE TABLE us_gainloss AS
    SELECT p.as_of, p.symbol, r.company_name, r.sector,
           p.close, p.prev_close, p.pct_change, p.volume,
           CASE WHEN p.pct_change >= 0 THEN 'G' ELSE 'L' END AS direction,
           row_number() OVER (PARTITION BY p.as_of ORDER BY p.pct_change DESC, p.symbol) AS gain_rank,
           row_number() OVER (PARTITION BY p.as_of ORDER BY p.pct_change ASC,  p.symbol) AS lose_rank
    FROM us_prices p
    LEFT JOIN us_roster r ON r.symbol = p.symbol
    WHERE p.pct_change IS NOT NULL
  `);

  // ------------------------------------------- Stock Centric US (Live lane)
  //
  // finviz fundamentals + the Yahoo .info shred, both lossless long tables
  // (symbol, key, value). Kept long rather than pivoted for the reason
  // xbrl_populate.py records: a fixed column list silently drops whatever the
  // source added since it was written, and finviz publishes ~84 keys that
  // drift. The UI pivots at query time instead.
  //
  // Yahoo is the FALLBACK here, not a peer: finviz is the Live lane's declared
  // fundamentals source, but a scrape can fail for a symbol, and .info still
  // carries market-derived fields finviz does not publish.
  const finvizFacts = `${EXTRACTS_US}/_meta/finviz_fundamentals.parquet`;
  const yahooInfo = `${EXTRACTS_US}/_meta/sp500_info.parquet`;

  // read_parquet over a file that may not exist yet would take the whole
  // connection down, so each is registered only when present. A missing feed
  // should cost its own tab, not every screen in the app.
  const has = (p) => fsSync.existsSync(p);

  if (has(path.join(ROOT, 'data', 'extracts_us', '_meta', 'finviz_fundamentals.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_fundamentals AS
      SELECT upper(trim(symbol)) AS symbol, trim(key) AS key, trim(value) AS value,
             'finviz' AS source
      FROM read_parquet('${finvizFacts}')
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_fundamentals AS
      SELECT NULL::VARCHAR AS symbol, NULL::VARCHAR AS key,
             NULL::VARCHAR AS value, NULL::VARCHAR AS source WHERE FALSE
    `);
  }

  if (has(path.join(ROOT, 'data', 'extracts_us', '_meta', 'sp500_info.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_info AS
      SELECT upper(trim(symbol)) AS symbol, trim(key) AS key, trim(value) AS value,
             'yahoo' AS source
      FROM read_parquet('${yahooInfo}')
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_info AS
      SELECT NULL::VARCHAR AS symbol, NULL::VARCHAR AS key,
             NULL::VARCHAR AS value, NULL::VARCHAR AS source WHERE FALSE
    `);
  }

  // Per-company insider trades, scraped alongside the fundamentals page. This
  // is the LIVE lane's insider source: same-day, where the SEC bulk lags a
  // quarter. It also carries Form 144 "Proposed Sale" rows — intent filed
  // BEFORE a trade — which the quarterly data set does not have at all.
  if (has(path.join(ROOT, 'data', 'extracts_us', '_meta', 'finviz_insider.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_insider_live AS
      SELECT upper(trim(symbol)) AS symbol,
             trim(insider_trading) AS owner_name,
             trim(relationship) AS relationship,
             trim(date) AS trans_date,
             trim(transaction) AS transaction,
             -- These arrive already numeric: pandas inferred DOUBLE when the
             -- scrape was written, so trim()/replace() on them is a type error.
             TRY_CAST(cost AS DOUBLE) AS price_per_share,
             TRY_CAST(num_shares AS DOUBLE) AS shares,
             TRY_CAST(value_usd AS DOUBLE) AS value_usd,
             TRY_CAST(num_shares_total AS DOUBLE) AS shares_after,
             -- Form 144 is intent to sell, filed ahead of the trade; Form 4 is
             -- after the fact. Flagged rather than filtered so a reader can
             -- weigh a signalled sale differently from a completed one.
             trim(transaction) = 'Proposed Sale' AS is_proposed
      FROM read_parquet('${EXTRACTS_US}/_meta/finviz_insider.parquet')
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_insider_live AS
      SELECT NULL::VARCHAR AS symbol, NULL::VARCHAR AS owner_name,
             NULL::VARCHAR AS relationship, NULL::VARCHAR AS trans_date,
             NULL::VARCHAR AS transaction, NULL::DOUBLE AS price_per_share,
             NULL::DOUBLE AS shares, NULL::DOUBLE AS value_usd,
             NULL::DOUBLE AS shares_after, NULL::BOOLEAN AS is_proposed WHERE FALSE
    `);
  }

  // ------------------------------------------------- Insider Centric US (SEC)
  //
  // Forms 3/4/5 from the SEC's quarterly data sets. Unlike the NSE side, which
  // shreds one XBRL document per filing over the network, this arrives already
  // flattened — so there is no shred step, just SQL over the TSVs.
  // TABLE, not VIEW — the same call this made on security/security_master.
  // As views these re-parsed every quarter's TSVs on each request: 386k
  // submissions, 586k transactions and 481k owner rows, which cost 26.7s on the
  // first hit and 0.69s once DuckDB had them cached. That first hit is fatal
  // rather than merely slow, because the Vercel proxy gives upstream 25s — so
  // the cold request timed out and the tab appeared broken. Materialising moves
  // the cost to startup, where it is paid once and nobody is waiting on it.
  // Trade-off: new quarters need an API restart to appear, which matches the
  // SEC's quarterly cadence.
  const secSub = `${EXTRACTS_SEC}/*/SUBMISSION.tsv`;
  const secOwner = `${EXTRACTS_SEC}/*/REPORTINGOWNER.tsv`;
  const secTrans = `${EXTRACTS_SEC}/*/NONDERIV_TRANS.tsv`;

  // Tab-delimited, and dates are NSE's own DD-MON-YYYY shape, so D() applies.
  // filing_date must be PARSED, not compared as text: min/max over the raw
  // string sorts alphabetically ('01-APR-2025' < '31-OCT-2025'), which silently
  // returns a nonsense range rather than an error.
  const SEC_READ = (glob) =>
    `read_csv('${glob}', delim='\t', header=true, all_varchar=true,
              normalize_names=true, union_by_name=true)`;

  await connection.run(`
    CREATE OR REPLACE TABLE sec_submission AS
    SELECT trim(accession_number) AS accession,
           ${D('filing_date')} AS filing_date,
           ${D('period_of_report')} AS period_of_report,
           trim(document_type) AS form_type,
           trim(issuercik) AS issuer_cik,
           trim(issuername) AS issuer_name,
           upper(trim(issuertradingsymbol)) AS symbol,
           -- AFF10B5ONE flags a pre-arranged 10b5-1 plan, and it arrives in
           -- FIVE encodings across quarters: '1'/'0', 'true'/'false', and
           -- blank. A truthiness test on the raw text would read 'false' as
           -- true. Normalised to a real boolean, with blank left NULL rather
           -- than assumed false — "not stated" is not "no".
           CASE lower(nullif(trim(aff10b5one), ''))
             WHEN '1' THEN TRUE  WHEN 'true'  THEN TRUE
             WHEN '0' THEN FALSE WHEN 'false' THEN FALSE
           END AS plan_10b5_1
    FROM ${SEC_READ(secSub)}
  `);

  await connection.run(`
    CREATE OR REPLACE TABLE sec_owner AS
    SELECT trim(accession_number) AS accession,
           trim(rptownername) AS owner_name,
           nullif(trim(rptowner_relationship), '') AS relationship,
           nullif(trim(rptowner_title), '') AS officer_title
    FROM ${SEC_READ(secOwner)}
  `);

  // The transactions themselves. TRANS_CODE is the whole story and is why a
  // naive "insider buying" screen misleads:
  //   P = open-market purchase, S = open-market sale   <- discretionary, informative
  //   A = grant/award, F = shares withheld for tax, M = option exercise
  //     <- compensation mechanics, NOT decisions to buy or sell
  // In the loaded quarters A+F+M outnumber P nearly 7:1, so counting them as
  // "buys" would drown the signal. is_open_market marks the distinction and the
  // screens use it rather than hiding the other codes outright.
  await connection.run(`
    CREATE OR REPLACE TABLE sec_insider_trans AS
    SELECT s.symbol, s.issuer_name, s.filing_date, s.form_type, s.plan_10b5_1,
           o.owner_name, o.relationship, o.officer_title,
           -- Bounded, because these dates are TYPED BY FILERS and the raw
           -- column spans 0024-10-02 to 2028-03-19 — mistyped years and dates
           -- in the future. A screen anchored on max(trans_date) would centre
           -- its window on a typo and return nothing. This is nastier than the
           -- NSE equivalent, where as_of comes from folder names we control.
           -- Implausible dates become NULL rather than being dropped: the row
           -- still counts, it just can't take part in a time window.
           CASE WHEN ${D('t.trans_date')} BETWEEN DATE '2006-01-01' AND current_date
                THEN ${D('t.trans_date')} END AS trans_date,
           trim(t.trans_code) AS trans_code,
           trim(t.trans_acquired_disp_cd) AS acquired_disposed,
           TRY_CAST(t.trans_shares AS DOUBLE) AS shares,
           TRY_CAST(t.trans_pricepershare AS DOUBLE) AS price_per_share,
           -- Same story on price: the raw column reaches $1.63bn PER SHARE,
           -- filers putting a total where a unit price belongs. One such row
           -- computes to ~$95 quadrillion and would own any value ranking on
           -- its own. Above $100k/share the figure is not credible for a
           -- listed equity, so value_usd is withheld while shares and the raw
           -- price stay visible — the trade is real even when its price isn't.
           CASE WHEN TRY_CAST(t.trans_pricepershare AS DOUBLE) BETWEEN 0 AND 100000
                THEN TRY_CAST(t.trans_shares AS DOUBLE)
                   * TRY_CAST(t.trans_pricepershare AS DOUBLE) END AS value_usd,
           TRY_CAST(t.shrs_ownd_folwng_trans AS DOUBLE) AS shares_after,
           trim(t.direct_indirect_ownership) AS ownership,
           trim(t.trans_code) IN ('P', 'S') AS is_open_market
    FROM ${SEC_READ(secTrans)} t
    JOIN sec_submission s ON s.accession = trim(t.accession_number)
    LEFT JOIN sec_owner  o ON o.accession = trim(t.accession_number)
  `);

  // ================================================== SEC bulk archives (US)
  //
  // Built by sec_submissions_load.py (the filing index) and
  // sec_companyfacts_load.py (the numbers inside those filings). They join on
  // accession number: sec_filings says Apple filed a 10-K on 2009-10-27,
  // us_sec_facts says net income in it was $3,496,000,000.
  //
  // THESE STAY VIEWS, unlike every other US table here.
  //
  // Materialising was right for the insider TSVs because read_csv re-parsed
  // every quarter's rows on each request — 26.7s cold, which the proxy's 25s
  // budget turned into a broken tab. Parquet is a different animal: columnar,
  // with per-row-group min/max statistics, and both files were written
  // clustered by cik (the loaders iterate zero-padded CIK filenames in order).
  // A `WHERE cik = ?` therefore touches a few row groups rather than the file.
  // Measured cold on the 125,308,448-row facts file: 0.31s for the first
  // company, 0.02s after. Copying 125M rows into memory to shave that would
  // cost gigabytes of RAM for no user-visible gain.
  const storeFile = (name) => path.join(ROOT, 'data', 'store', name);
  const secFilersP = `${STORE}/sec_filers.parquet`;
  const secFilingsP = `${STORE}/sec_filings.parquet`;
  const secFactsP = `${STORE}/sec_facts.parquet`;
  const secConceptsP = `${STORE}/sec_concepts.parquet`;

  // Ticker -> CIK, taken from what registrants actually filed rather than a
  // maintained list. The roster we scraped has already drifted: it carries EQR
  // for CIK 906107, where the registrant's own submission says VMRK.
  //
  // Symbols are normalised to SEC's dash form. The class-share tickers are the
  // reason — the S&P roster writes BRK.B and BF.B, SEC writes BRK-B and BF-B,
  // and without this the join silently loses them. Callers must normalise the
  // incoming symbol the same way.
  if (has(storeFile('sec_filers.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_sec_symbol AS
      WITH exploded AS (
        SELECT cik, name, exchanges, sic_description,
               unnest(str_split(tickers, ',')) AS raw_symbol
        FROM read_parquet('${secFilersP}')
        WHERE tickers IS NOT NULL AND tickers <> ''
      )
      SELECT upper(replace(trim(raw_symbol), '.', '-')) AS symbol,
             cik, name, exchanges, sic_description
      FROM exploded
      WHERE trim(raw_symbol) <> ''
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_sec_symbol AS
      SELECT NULL::VARCHAR AS symbol, NULL::VARCHAR AS cik, NULL::VARCHAR AS name,
             NULL::VARCHAR AS exchanges, NULL::VARCHAR AS sic_description WHERE FALSE
    `);
  }

  // The filing index. Dates arrive as VARCHAR (the loader keeps the archive's
  // own strings) and are cast here, not there — TRY_CAST so a malformed date
  // costs that one column rather than the row.
  if (has(storeFile('sec_filings.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE VIEW us_sec_filings AS
      SELECT cik,
             accessionNumber AS accn,
             TRY_CAST(filingDate AS DATE) AS filed,
             TRY_CAST(reportDate AS DATE) AS period,
             form,
             items,
             primaryDocument AS document,
             primaryDocDescription AS document_desc,
             isXBRL = '1' AS is_xbrl
      FROM read_parquet('${secFilingsP}')
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE VIEW us_sec_filings AS
      SELECT NULL::VARCHAR AS cik, NULL::VARCHAR AS accn, NULL::DATE AS filed,
             NULL::DATE AS period, NULL::VARCHAR AS form, NULL::VARCHAR AS items,
             NULL::VARCHAR AS document, NULL::VARCHAR AS document_desc,
             NULL::BOOLEAN AS is_xbrl WHERE FALSE
    `);
  }

  // The reported facts. `period_days` is derived here because without it the
  // table is a trap: a 10-Q reports the SAME concept for the SAME period_end
  // twice — once for the quarter and once year-to-date. Apple's 2026-07-31
  // 10-Q carries NetIncomeLoss at both 101,464,000,000 (nine months) and
  // 29,789,000,000 (the quarter). Picking one without checking the duration
  // gets you a number that is off by a factor of three and looks plausible.
  // Instant facts (balance sheet) have no start at all, hence the NULL.
  if (has(storeFile('sec_facts.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE VIEW us_sec_facts AS
      SELECT cik, taxonomy, concept, unit,
             start AS period_start,
             "end" AS period_end,
             CASE WHEN start IS NOT NULL
                  THEN date_diff('day', start, "end") END AS period_days,
             val, fy, fp, form, filed, frame, accn
      FROM read_parquet('${secFactsP}')
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE VIEW us_sec_facts AS
      SELECT NULL::VARCHAR AS cik, NULL::VARCHAR AS taxonomy, NULL::VARCHAR AS concept,
             NULL::VARCHAR AS unit, NULL::DATE AS period_start, NULL::DATE AS period_end,
             NULL::BIGINT AS period_days, NULL::DOUBLE AS val, NULL::INTEGER AS fy,
             NULL::VARCHAR AS fp, NULL::VARCHAR AS form, NULL::DATE AS filed,
             NULL::VARCHAR AS frame, NULL::VARCHAR AS accn WHERE FALSE
    `);
  }

  // 14,041 concept labels, split out of the facts by the loader so the prose
  // is not repeated on 125M rows. Small enough to materialise.
  if (has(storeFile('sec_concepts.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_sec_concepts AS
      SELECT taxonomy, concept, label, description FROM read_parquet('${secConceptsP}')
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_sec_concepts AS
      SELECT NULL::VARCHAR AS taxonomy, NULL::VARCHAR AS concept,
             NULL::VARCHAR AS label, NULL::VARCHAR AS description WHERE FALSE
    `);
  }

  // ------------------------------------------------------- Databento bars
  //
  // Built by src/python/us_databento_load.py. Small enough to materialise.
  //
  // EVERY WINDOW PARTITIONS BY series_id, NOT SYMBOL. That is the whole point
  // of the loader's reuse guard: `IBIT` covers a penny instrument until 2022
  // and the iShares trust from 2024-01-11, and a 252-day high spanning the two
  // is meaningless. Partitioning by symbol alone would quietly reintroduce it.
  //
  // hi_252d/lo_252d are OUR computation over trailing sessions, not an
  // exchange's declaration — the same caveat lib/screens-us.ts records for the
  // Yahoo board. And this is XNAS: Nasdaq-executed volume only, a fraction of
  // consolidated, so `volume` here is not comparable with us_prices.volume.
  const dbnP = `${EXTRACTS_US}/_meta/databento_ohlcv.parquet`;
  if (has(path.join(ROOT, 'data', 'extracts_us', '_meta', 'databento_ohlcv.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_dbn_prices AS
      -- Same split-adjustment as us_daily above, against the same
      -- us_stock_splits table -- this and us_daily read the identical source
      -- Parquet but serve different consumers (Markets US vs the Archive
      -- lane's per-symbol bars), so the fix has to land in both.
      WITH raw AS (
        SELECT symbol, series_id, series_symbol, date AS as_of,
               open, high, low, close, volume, dataset
        FROM read_parquet('${dbnP}')
      ),
      factor AS (
        SELECT r.symbol, r.as_of, exp(sum(ln(s.ratio))) AS cum_factor
        FROM raw r
        JOIN us_stock_splits s ON s.symbol = r.symbol AND s.effective_date > r.as_of
        GROUP BY r.symbol, r.as_of
      ),
      adjusted AS (
        SELECT r.*,
               r.close * COALESCE(f.cum_factor, 1.0) AS adj_close,
               r.open  * COALESCE(f.cum_factor, 1.0) AS adj_open,
               r.high  * COALESCE(f.cum_factor, 1.0) AS adj_high,
               r.low   * COALESCE(f.cum_factor, 1.0) AS adj_low
        FROM raw r
        LEFT JOIN factor f ON f.symbol = r.symbol AND f.as_of = r.as_of
      )
      SELECT symbol, series_id, series_symbol, as_of,
             open, high, low, close, adj_open, adj_high, adj_low, adj_close,
             volume, dataset,
             lag(adj_close) OVER w AS prev_close,
             CASE WHEN lag(adj_close) OVER w > 0
                  THEN round((adj_close - lag(adj_close) OVER w) / lag(adj_close) OVER w * 100, 2)
             END AS pct_change,
             max(adj_high) OVER w252 AS hi_252d,
             min(adj_low)  OVER w252 AS lo_252d
      FROM adjusted
      WINDOW w AS (PARTITION BY symbol, series_id ORDER BY as_of),
             w252 AS (PARTITION BY symbol, series_id ORDER BY as_of
                      ROWS BETWEEN 251 PRECEDING AND CURRENT ROW)
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_dbn_prices AS
      SELECT NULL::VARCHAR AS symbol, NULL::BIGINT AS series_id,
             NULL::VARCHAR AS series_symbol, NULL::DATE AS as_of,
             NULL::DOUBLE AS open, NULL::DOUBLE AS high, NULL::DOUBLE AS low,
             NULL::DOUBLE AS close,
             NULL::DOUBLE AS adj_open, NULL::DOUBLE AS adj_high,
             NULL::DOUBLE AS adj_low, NULL::DOUBLE AS adj_close,
             NULL::DOUBLE AS volume, NULL::VARCHAR AS dataset,
             NULL::DOUBLE AS prev_close, NULL::DOUBLE AS pct_change,
             NULL::DOUBLE AS hi_252d, NULL::DOUBLE AS lo_252d WHERE FALSE
    `);
  }

  // ------------------------------------------------------------- FINRA
  //
  // Built by src/python/finra_short_volume.py and finra_short_interest.py.
  // Both small enough to materialise.
  //
  // These are the primary source for what finviz publishes as Short Interest,
  // Short Ratio and Short Float. Verified on the 2026-07-31 settlement: AAPL
  // short_interest is 141,606,163 and finviz shows "141.61M". Same number, one
  // vendor removed, and this one carries the previous period and a settlement
  // date the grid does not show.
  const finraVolP = `${EXTRACTS_US}/_meta/finra_short_volume.parquet`;
  const finraIntP = `${EXTRACTS_US}/_meta/finra_short_interest.parquet`;
  const usMeta = (name) => path.join(ROOT, 'data', 'extracts_us', '_meta', name);

  // Daily short sale VOLUME — a flow, and off-exchange only (TRF/ADF reported).
  // Exchange-executed volume is not in it: on 2026-08-21 TSLA showed 28,090,470
  // here against 14,657,671 on Nasdaq. So total_volume is NOT comparable with
  // us_prices.volume, and nothing here should be joined to it as though it were.
  if (has(usMeta('finra_short_volume.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_finra_short_volume AS
      SELECT as_of, symbol, short_volume, short_exempt_volume, total_volume, markets,
             CASE WHEN total_volume > 0
                  THEN short_volume / total_volume END AS short_ratio
      FROM read_parquet('${finraVolP}')
    `);

    // The ratio is meaningless on its own. Median across symbols with real
    // volume sits at ~0.505 — half of every short sale is a market maker
    // hedging inventory, not a view on the stock. A screen on "above 50%"
    // therefore fires on half the market every day.
    //
    // So the baseline is each symbol's OWN median, and what callers read is the
    // deviation from it. Note `sessions`: the catalog page only exposes a
    // rolling window, so early baselines rest on a handful of days and widen as
    // the local store accumulates. It is carried per row precisely so a thin
    // baseline is visible rather than silently trusted.
    await connection.run(`
      CREATE OR REPLACE TABLE us_finra_short_baseline AS
      SELECT symbol,
             median(short_ratio) AS baseline_ratio,
             count(*) AS sessions
      FROM us_finra_short_volume
      WHERE short_ratio IS NOT NULL AND total_volume > 100000
      GROUP BY symbol
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_finra_short_volume AS
      SELECT NULL::DATE AS as_of, NULL::VARCHAR AS symbol, NULL::DOUBLE AS short_volume,
             NULL::DOUBLE AS short_exempt_volume, NULL::DOUBLE AS total_volume,
             NULL::VARCHAR AS markets, NULL::DOUBLE AS short_ratio WHERE FALSE
    `);
    await connection.run(`
      CREATE OR REPLACE TABLE us_finra_short_baseline AS
      SELECT NULL::VARCHAR AS symbol, NULL::DOUBLE AS baseline_ratio,
             NULL::BIGINT AS sessions WHERE FALSE
    `);
  }

  // Biweekly short INTEREST — a stock (open positions), not the flow above.
  // The two are conflated constantly and answer different questions.
  //
  // market_class travels with every row because FINRA's own note says files
  // before June 2021 carry OTC securities only. We load current files, so the
  // break does not bite — but a backfill would produce one continuous series
  // whose universe changes mid-way, and the column is what makes that visible.
  if (has(usMeta('finra_short_interest.parquet'))) {
    await connection.run(`
      CREATE OR REPLACE TABLE us_finra_short_interest AS
      SELECT settlement_date, symbol, issue_name, market_class, exchange_code,
             short_interest, short_interest_prev, avg_daily_volume,
             -- 999.99 is a CEILING, not a measurement: 7,825 rows sit exactly
             -- on it while the largest real value is 998.82, and 7,754 of them
             -- are OTC issues with no meaningful average volume to divide by.
             -- Left as a number it sorts to the top of every "hardest to cover"
             -- view and drags any average with it, so it is nulled here.
             CASE WHEN days_to_cover < 999.99 THEN days_to_cover END AS days_to_cover,
             change_pct, change_shares
      FROM read_parquet('${finraIntP}')
    `);
  } else {
    await connection.run(`
      CREATE OR REPLACE TABLE us_finra_short_interest AS
      SELECT NULL::DATE AS settlement_date, NULL::VARCHAR AS symbol,
             NULL::VARCHAR AS issue_name, NULL::VARCHAR AS market_class,
             NULL::VARCHAR AS exchange_code, NULL::DOUBLE AS short_interest,
             NULL::DOUBLE AS short_interest_prev, NULL::DOUBLE AS avg_daily_volume,
             NULL::DOUBLE AS days_to_cover, NULL::DOUBLE AS change_pct,
             NULL::DOUBLE AS change_shares WHERE FALSE
    `);
  }

  return connection;
}

// One shared connection (in-memory views, re-globs disk on every query — cheap
// at this data volume). Reused across requests instead of reconnecting per call.
export function getConnection() {
  if (!connectionPromise) connectionPromise = createConnection();
  return connectionPromise;
}

export async function queryJson(sql, params) {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(sql, params);
  return reader.getRowObjectsJson();
}

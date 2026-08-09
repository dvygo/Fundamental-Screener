// Layer A base views — DuckDB SQL over data/extracts/*/ (bhavcopy on disk).
// Mirrors src/python/screens.py's _base_views() exactly; single source of
// truth for the screen SQL lives in the Python CLI, this just reuses it.
//
// v1 reads local disk. MinIO/WORM serving is v2 — flip the globs to
// `s3://raw/` when that lands.

import { DuckDBInstance } from '@duckdb/node-api';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
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
  const usBars = `${EXTRACTS_US}/*/sp500_bars_*.csv`;
  const usRoster = `${EXTRACTS_US}/_meta/sp500_constituents.csv`;

  await connection.run(`
    CREATE OR REPLACE VIEW us_roster AS
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

  // One row per (session, symbol), every field yfinance returned. as_of comes
  // from the folder, matching the NSE convention rather than trusting the Date
  // column, so a mis-split file can't claim another session's date.
  await connection.run(`
    CREATE OR REPLACE VIEW us_daily AS
    SELECT * FROM (
      -- b._close, not b.close: normalize_names prefixes an underscore when a
      -- column name collides with a reserved word, so Yahoo's "Close" arrives
      -- as _close. Same trap as NSE's SECURITY -> _security in gl_symbol.
      -- Columns are alias-qualified so DuckDB's lateral aliasing can't resolve
      -- a bare source name to the output alias being defined beside it.
      SELECT try_strptime(${FOLDER_DATE('b.filename')}, '%Y%m%d')::date AS as_of,
             trim(b.symbol) AS symbol,
             TRY_CAST(b.open AS DOUBLE) AS open,
             TRY_CAST(b.high AS DOUBLE) AS high,
             TRY_CAST(b.low AS DOUBLE) AS low,
             TRY_CAST(b._close AS DOUBLE) AS close,
             TRY_CAST(b.adj_close AS DOUBLE) AS adj_close,
             TRY_CAST(b.volume AS DOUBLE) AS volume,
             TRY_CAST(b.dividends AS DOUBLE) AS dividends,
             TRY_CAST(b.stock_splits AS DOUBLE) AS stock_splits
      FROM read_csv('${usBars}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true) b
    ) WHERE as_of IS NOT NULL AND close IS NOT NULL
  `);

  // Derived per-session move + trailing 52-week extremes.
  //
  // 252 rows ~= one trading year. The window is ROWS, not RANGE over dates, so
  // a symbol's own trading days are counted and holidays don't shorten it.
  // `sessions_seen` exists so a screen can refuse to call something a 52-week
  // high when we simply don't hold 52 weeks of history for it yet — without
  // that guard every symbol's earliest bars look like records.
  await connection.run(`
    CREATE OR REPLACE VIEW us_prices AS
    SELECT
      as_of, symbol, open, high, low, close, adj_close, volume,
      lag(close) OVER w AS prev_close,
      CASE WHEN lag(close) OVER w > 0
           THEN round((close - lag(close) OVER w) / lag(close) OVER w * 100, 4)
      END AS pct_change,
      max(high) OVER w52 AS hi_52w,
      min(low)  OVER w52 AS lo_52w,
      count(*)  OVER w52 AS sessions_seen
    FROM us_daily
    WINDOW
      w   AS (PARTITION BY symbol ORDER BY as_of),
      w52 AS (PARTITION BY symbol ORDER BY as_of ROWS BETWEEN 251 PRECEDING AND CURRENT ROW)
  `);

  // Gainers/losers per session, ranked. The tiebreaker on symbol is deliberate:
  // without it the rank window is nondeterministic and two identical requests
  // can return different rows (this bit the NSE recurrence screens).
  await connection.run(`
    CREATE OR REPLACE VIEW us_gainloss AS
    SELECT p.as_of, p.symbol, r.company_name, r.sector,
           p.close, p.prev_close, p.pct_change, p.volume,
           CASE WHEN p.pct_change >= 0 THEN 'G' ELSE 'L' END AS direction,
           row_number() OVER (PARTITION BY p.as_of ORDER BY p.pct_change DESC, p.symbol) AS gain_rank,
           row_number() OVER (PARTITION BY p.as_of ORDER BY p.pct_change ASC,  p.symbol) AS lose_rank
    FROM us_prices p
    LEFT JOIN us_roster r ON r.symbol = p.symbol
    WHERE p.pct_change IS NOT NULL
  `);

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

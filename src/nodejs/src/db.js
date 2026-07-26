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
// Consolidated single-file store (permanent shape for filing data — quarterly/
// event filings were never a good fit for day partitioning). Built by
// src/python/shareholding_load.py and src/python/insider_load.py.
const STORE = path.join(ROOT, 'data', 'store').split(path.sep).join('/');

// NSE month names are UPPERCASE ("23-JUL-2025"); strptime %b matches case-insensitively.
const D = (col) => `try_strptime(${col}, '%d-%b-%Y')::date`;

let connectionPromise = null;

async function createConnection() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  const bhav = `${EXTRACTS}/*/sec_bhavdata_full*.csv`;
  const wk = `${EXTRACTS}/*/CM_52_wk_High_low*.csv`;
  const sec = `${EXTRACTS}/*/NSE_CM_security_*.csv`;
  const bh = `${EXTRACTS}/*/bh*.csv`;
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

  await connection.run(`
    CREATE OR REPLACE VIEW hi52 AS
    SELECT DISTINCT trim(symbol) AS symbol, trim(series) AS series,
           ${D('_52_week_high_date')} AS event_date,
           TRY_CAST(replace(adjusted_52_week_high, ' ', '') AS DOUBLE) AS price
    FROM read_csv('${wk}', header=true, all_varchar=true, normalize_names=true,
                  skip=2, union_by_name=true)
    WHERE ${D('_52_week_high_date')} IS NOT NULL AND trim(series) = 'EQ'
  `);

  await connection.run(`
    CREATE OR REPLACE VIEW lo52 AS
    SELECT DISTINCT trim(symbol) AS symbol, trim(series) AS series,
           ${D('_52_week_low_dt')} AS event_date,
           TRY_CAST(replace(adjusted_52_week_low, ' ', '') AS DOUBLE) AS price
    FROM read_csv('${wk}', header=true, all_varchar=true, normalize_names=true,
                  skip=2, union_by_name=true)
    WHERE ${D('_52_week_low_dt')} IS NOT NULL AND trim(series) = 'EQ'
  `);

  // official company name per symbol (NSE security master), exact FinInstrmNm
  // string as-is. Not every symbol has an EQ row (SME board symbols only ever
  // list under SM/SL/SQ/ST) so this doesn't filter by series - just picks the
  // most recent date folder's row per symbol (name is the same across series).
  await connection.run(`
    CREATE OR REPLACE VIEW security AS
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
  await connection.run(`
    CREATE OR REPLACE VIEW security_master AS
    WITH raw AS (
      SELECT trim(tckrsymb) AS symbol, trim(sctysrs) AS series,
             trim(fininstrmnm) AS company_name, trim(isin) AS isin,
             regexp_extract(filename, '/([0-9]{8})/', 1) AS file_date
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
  await connection.run(`
    CREATE OR REPLACE VIEW circuit AS
    SELECT strptime(regexp_extract(filename, '/(\\d{8})/[^/]+$', 1), '%Y%m%d')::date AS as_of,
           trim(symbol) AS symbol, trim(series) AS series, trim(highlow) AS hit
    FROM read_csv('${bh}', header=true, all_varchar=true, normalize_names=true,
                  filename=true, union_by_name=true)
    WHERE trim(series) = 'EQ'
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
               ORDER BY regexp_extract(filename, '/([0-9]{8})/', 1) DESC) AS rn
      FROM read_csv('${mcapCsv}', header=true, all_varchar=true, normalize_names=true,
                    filename=true, union_by_name=true)
      WHERE trim(series) = 'EQ'
    ) WHERE rn = 1
  `);
  await connection.run(`
    CREATE OR REPLACE VIEW pe_latest AS
    SELECT symbol, symbol_pe FROM (
      SELECT trim(symbol) AS symbol, TRY_CAST(symbol_pe AS DOUBLE) AS symbol_pe,
             row_number() OVER (PARTITION BY trim(symbol)
               ORDER BY regexp_extract(filename, '/([0-9]{8})/', 1) DESC) AS rn
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

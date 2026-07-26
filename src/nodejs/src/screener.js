// Stock-centric drill-down sourced from screener.in (B4 reference layout).
// NSE EOD data can't give per-company FII/DII/promoter changes daily, so those
// come from screener.in's quarterly shareholding table + headline ratios.
//
// Node owns the screener.in integration end-to-end: fetch the company page
// directly, parse it here (cheerio), compute the metrics. (Python is only for
// the downloaded static-file ELT - bhavcopy/XBRL.) Scraped on demand: the raw
// HTML is cached to data/raw/screener/<SYMBOL>.html so re-requests never re-hit
// the site, live fetches are paced, and concurrent requests for the same
// uncached symbol share one fetch via the in-flight map.
//
// Politeness matches context/sources.md: real UA, hard delay between live
// fetches, cached HTML, degrade gracefully on block/rate-limit.

import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw', 'screener');
const htmlPath = (sym) => path.join(RAW_DIR, `${sym}.html`);

const BASE = 'https://www.screener.in';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REQUEST_DELAY = 3500; // ms between live fetches - deliberately gentle

const inFlight = new Map();
let lastFetchAt = 0;
let fetchGate = Promise.resolve();

// Serialize live fetches with a min-gap so bursts of distinct symbols stay paced.
// opts: { headers, method, body, redirect } — merged over the polite defaults.
function pacedFetch(url, opts = {}) {
  const { headers = {}, ...rest } = opts;
  const run = async () => {
    const wait = Math.max(0, REQUEST_DELAY - (Date.now() - lastFetchAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    return fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-IN,en;q=0.9', ...headers },
      redirect: 'follow',
      ...rest,
    });
  };
  const result = fetchGate.then(run, run);
  fetchGate = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function fetchHtml(symbol) {
  try {
    return await fs.readFile(htmlPath(symbol), 'utf8');
  } catch {
    /* not cached - fetch live below */
  }
  const resp = await pacedFetch(`${BASE}/company/${symbol}/`);
  if (resp.status === 404) return null; // no such company - definitive, don't retry
  if (!resp.ok) throw new Error(`screener ${resp.status} for ${symbol}`); // transient -> caller retries
  const html = await resp.text();
  if (!html.includes('top-ratios')) return null; // not a real company page
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(htmlPath(symbol), html, 'utf8');
  return html;
}

function parseDossier(symbol, html) {
  const $ = cheerio.load(html);

  const ratios = {};
  $('#top-ratios li').each((_, li) => {
    const name = $(li).find('.name').text().replace(/\s+/g, ' ').trim();
    const value = $(li).find('.value').text().replace(/\s+/g, ' ').trim();
    if (name) ratios[name] = value;
  });

  const shareholding = [];
  const table = $('#shareholding table').first();
  const periods = table
    .find('thead th')
    .map((_, th) => $(th).text().trim())
    .get();
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    // Row labels carry a trailing " +" expander (e.g. "Promoters +") - strip
    // leading/trailing '+' and spaces so the item keys are clean ("Promoters").
    const item = $(cells[0]).text().replace(/\s+/g, ' ').replace(/^[+\s]+|[+\s]+$/g, '').trim();
    if (!item) return;
    const values = {};
    for (let i = 1; i < cells.length && i < periods.length; i++) {
      values[periods[i]] = $(cells[i]).text().replace(/\s+/g, ' ').trim();
    }
    shareholding.push({ item, values });
  });

  // screener's internal numeric id — needed to hit the investors API that lists
  // the individual promoter/institution names behind the aggregate %.
  const companyId = $('[data-company-id]').first().attr('data-company-id') || null;

  const name = $('h1').first().text().trim() || symbol;
  return { code: symbol, name, ratios, shareholding, companyId };
}

async function getDossier(symbol) {
  if (!inFlight.has(symbol)) {
    inFlight.set(
      symbol,
      fetchHtml(symbol)
        .then((html) => (html ? parseDossier(symbol, html) : null))
        // NB: don't swallow errors here - a transient fetch failure must
        // propagate so the caller (and the client) can retry until it succeeds.
        .finally(() => inFlight.delete(symbol)),
    );
  }
  return inFlight.get(symbol);
}

// ---- value parsing + drill-down computation -------------------------------

// screener sprinkles ₹, commas, % and units into values - pull the first number.
function toNum(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// A shareholding row's quarterly values, oldest -> newest (object key order).
function pctSeries(shMap, item) {
  const vals = shMap[item];
  if (!vals) return [];
  return Object.values(vals).map(toNum).filter((v) => v != null);
}

function computeDrilldown(dossier) {
  const r = dossier.ratios ?? {};
  const shMap = Object.fromEntries((dossier.shareholding ?? []).map((row) => [row.item, row.values]));

  const prom = pctSeries(shMap, 'Promoters');
  const fii = pctSeries(shMap, 'FIIs');
  const dii = pctSeries(shMap, 'DIIs');
  const pub = pctSeries(shMap, 'Public');
  const last = (a) => (a.length ? a[a.length - 1] : null);
  const prev = (a) => (a.length > 1 ? a[a.length - 2] : null);
  const first = (a) => (a.length ? a[0] : null);
  const chgQ = (a) => (last(a) != null && prev(a) != null ? round2(last(a) - prev(a)) : null);
  const chg3 = (a) => (last(a) != null && first(a) != null ? round2(last(a) - first(a)) : null);

  const price = toNum(r['Current Price']);
  const pe = toNum(r['Stock P/E']);
  const hl = String(r['High / Low'] ?? '').split('/').map(toNum);
  const periods = dossier.shareholding?.[0]?.values ? Object.keys(dossier.shareholding[0].values) : [];

  return {
    symbol: dossier.code,
    company_name: dossier.name ?? null,
    // screener string e.g. "₹ 721 Cr." -> "721 Cr." (frontend adds its own ₹)
    market_cap: (r['Market Cap'] ?? '').replace(/₹/g, '').replace(/\s+/g, ' ').trim() || null,
    current_price: price,
    high: hl[0] ?? null,
    low: hl[1] ?? null,
    stock_pe: pe,
    eps: price != null && pe ? round1(price / pe) : null,
    promoter_pct: last(prom),
    promoter_change: chgQ(prom),
    promoter_change_3yr: chg3(prom),
    fii_change: chgQ(fii),
    dii_change: chgQ(dii),
    public_pct: last(pub),
    as_of: periods.length ? periods[periods.length - 1] : null,
    since: periods.length ? periods[0] : null,
    source: 'screener',
  };
}

export async function screenerDrilldown(symbol) {
  const dossier = await getDossier(symbol);
  return dossier ? computeDrilldown(dossier) : null;
}

// ---- promoter roster (screener's expanded "Promoters +") --------------------
// screener aggregates promoter holding to one % on the page, but its investors
// API returns the individual promoter entities behind it, each with a % per
// quarter. We surface exactly that list (names x quarters), paced + cached like
// the company page. The same endpoint serves FIIs/DIIs/public via classification.

const investorsPath = (sym) => path.join(RAW_DIR, `${sym}.promoters.json`);

// "Jun 2026" -> sortable rank so quarters column newest-first.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function periodRank(p) {
  const [mon, yr] = String(p).split(' ');
  return (parseInt(yr, 10) || 0) * 100 + (MONTHS[mon] || 0);
}

async function fetchInvestors(symbol, companyId) {
  try {
    return JSON.parse(await fs.readFile(investorsPath(symbol), 'utf8'));
  } catch {
    /* not cached - fetch live below */
  }
  const resp = await pacedFetch(`${BASE}/api/3/${companyId}/investors/promoters/quarterly/`, {
    headers: { Referer: `${BASE}/company/${symbol}/`, 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (resp.status === 404) return null; // definitive: no such data
  if (!resp.ok) throw new Error(`screener investors ${resp.status} for ${symbol}`); // transient -> retry
  const json = await resp.json().catch(() => null);
  if (!json || typeof json !== 'object') return null;
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(investorsPath(symbol), JSON.stringify(json), 'utf8');
  return json;
}

// { "<name>": { "Jun 2026": "11.12", …, "setAttributes": {…} } } -> one row per
// promoter, ready for the grid: { promoter, "Jun 2026": 11.12, … } newest-first.
function parsePromoters(json) {
  const periods = new Set();
  const people = [];
  for (const [name, vals] of Object.entries(json)) {
    if (!vals || typeof vals !== 'object') continue;
    const values = {};
    for (const [k, v] of Object.entries(vals)) {
      if (k === 'setAttributes') continue;
      periods.add(k);
      const n = parseFloat(v);
      values[k] = Number.isFinite(n) ? n : null;
    }
    people.push({ name, values });
  }
  const ordered = [...periods].sort((a, b) => periodRank(b) - periodRank(a));
  // screener already returns names largest-holding first — preserve that order.
  return people.map((p) => {
    const row = { promoter: p.name };
    for (const per of ordered) row[per] = p.values[per] ?? null;
    return row;
  });
}

export async function screenerPromoters(symbol) {
  const dossier = await getDossier(symbol);
  if (!dossier || !dossier.companyId) return null;
  const json = await fetchInvestors(symbol, dossier.companyId);
  return json ? parsePromoters(json) : null;
}

// ---- authenticated session (insider/bulk/block trades are login-gated) -------
// screener puts the trades page behind login, so we sign in with the account in
// src/nodejs/.env (SCREENER_EMAIL/PASSWORD, gitignored) and reuse one session.
// Django login: GET /login/ for the CSRF token+cookie, POST creds, keep the
// sessionid cookie. All still paced + cached; nothing here is a bulk backfill -
// a page is fetched only when a symbol is opened in Stock Centric.

let sessionCookies = null; // "csrftoken=..; sessionid=.." once signed in
let sessionGate = null;

function parseSetCookie(list) {
  const jar = {};
  for (const c of list ?? []) {
    const pair = c.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}
const cookieStr = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function login() {
  const email = process.env.SCREENER_EMAIL;
  const password = process.env.SCREENER_PASSWORD;
  if (!email || !password) return; // no creds -> stay logged out, caller falls back
  const lp = await pacedFetch(`${BASE}/login/`, { redirect: 'manual' });
  const jar = parseSetCookie(lp.headers.getSetCookie?.());
  const token = (await lp.text()).match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
  if (!token || !jar.csrftoken) return;
  const resp = await pacedFetch(`${BASE}/login/`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE}/login/`,
      Origin: BASE,
      Cookie: cookieStr(jar),
    },
    body: new URLSearchParams({ csrfmiddlewaretoken: token, next: '', username: email, password }).toString(),
  });
  Object.assign(jar, parseSetCookie(resp.headers.getSetCookie?.()));
  if (jar.sessionid) sessionCookies = cookieStr(jar); // logged in
}

// serialize logins so concurrent first-requests don't each sign in
function ensureSession() {
  if (sessionCookies) return Promise.resolve();
  if (!sessionGate) sessionGate = login().finally(() => { sessionGate = null; });
  return sessionGate;
}

async function authedFetch(url, headers = {}) {
  await ensureSession();
  if (!sessionCookies) return null; // no creds / login failed
  const go = () => pacedFetch(url, { headers: { ...headers, Cookie: sessionCookies }, redirect: 'manual' });
  let resp = await go();
  // session expired -> bounced to login/register: sign in again once and retry
  if (resp.status >= 300 && resp.status < 400 && /\/(login|register)\//.test(resp.headers.get('location') || '')) {
    sessionCookies = null;
    await ensureSession();
    if (!sessionCookies) return null;
    resp = await go();
  }
  return resp;
}

// ---- insider trades (screener's "Insider Trades" tab) ------------------------

const tradesPath = (sym) => path.join(RAW_DIR, `${sym}.trades.html`);

async function fetchTrades(symbol, companyId) {
  try {
    return await fs.readFile(tradesPath(symbol), 'utf8');
  } catch {
    /* not cached - fetch live below */
  }
  const resp = await authedFetch(`${BASE}/trades/company-${companyId}/`, {
    Referer: `${BASE}/company/${symbol}/`,
    'X-Requested-With': 'XMLHttpRequest',
  });
  if (resp === null) return null; // no creds / login unavailable -> caller uses own data
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`screener trades ${resp.status} for ${symbol}`); // transient -> retry
  const html = await resp.text();
  if (!html.includes('trades-insider-trades')) return null; // no insider data for this co
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(tradesPath(symbol), html, 'utf8');
  return html;
}

const MONTH = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
// screener groups insider rows under a "Mon YYYY" header (no day) - anchor each
// to the first of that month so the grid sorts chronologically (ISO).
function monthToIso(s) {
  const [mon, yr] = String(s).trim().split(/\s+/);
  return MONTH[mon] && /^\d{4}$/.test(yr || '') ? `${yr}-${MONTH[mon]}-01` : null;
}

// The "Insider Trades" tab: rows are Person(+category span) / signed Quantity /
// Avg Price / Value in Rs. Lacs, with sticky "Mon YYYY" header rows in between.
// Negative quantity = disposal (Sell), positive = acquisition (Buy).
function parseInsiderTrades(html) {
  const $ = cheerio.load(html);
  const table = $('#trades-insider-trades table').first();
  const rows = [];
  let period = null;
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length === 1) {
      period = monthToIso($(cells[0]).text());
      return;
    }
    if (cells.length < 4) return;
    const personCell = $(cells[0]);
    const category = personCell.find('span').first().text().trim() || null;
    const person = personCell.clone().find('span').remove().end().text().replace(/\s+/g, ' ').trim();
    const qty = toNum($(cells[1]).text());
    rows.push({
      date: period,
      person,
      category,
      txn_type: qty == null ? null : qty >= 0 ? 'Buy' : 'Sell',
      qty,
      avg_price: toNum($(cells[2]).text()),
      value_lacs: toNum($(cells[3]).text()),
    });
  });
  return rows;
}

export async function screenerInsider(symbol) {
  const dossier = await getDossier(symbol);
  if (!dossier || !dossier.companyId) return null;
  const html = await fetchTrades(symbol, dossier.companyId);
  return html ? parseInsiderTrades(html) : null;
}

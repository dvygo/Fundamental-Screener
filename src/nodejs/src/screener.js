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
function pacedFetch(url) {
  const run = async () => {
    const wait = Math.max(0, REQUEST_DELAY - (Date.now() - lastFetchAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    return fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-IN,en;q=0.9' },
      redirect: 'follow',
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
  if (!resp.ok) return null; // 403/429/404 -> degrade, caller falls back
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

  const name = $('h1').first().text().trim() || symbol;
  return { code: symbol, name, ratios, shareholding };
}

async function getDossier(symbol) {
  if (!inFlight.has(symbol)) {
    inFlight.set(
      symbol,
      fetchHtml(symbol)
        .then((html) => (html ? parseDossier(symbol, html) : null))
        .catch(() => null)
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

// REST API — serves data/extracts/ (bhavcopy + XBRL facts) as JSON.
// Layer A screens (requirement.md 1-5) + upper/lower circuit, stock-centric
// Layer B (B1 insider, B2 promoter shareholding), and Layer C news (the
// LiveMint companies feed, each article tagged with the NSE stock it names).

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Load src/nodejs/.env (gitignored secrets: screener.in login). Node 24 native;
// tolerate a missing file so the API still boots without credentials.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
} catch {
  /* no .env — screener auth just stays disabled */
}
import {
  screen1_high52wLastDay,
  screen2_high52wEvents,
  screen3a_low52wLastDay,
  screen3b_low52wEvents,
  screen4a_gainers,
  screen4b_losers,
  screen5_gainersRecurrence,
  screen5b_losersRecurrence,
  screen_high52wCombined,
  screen_low52wCombined,
  screen6a_upperCircuit,
  screen6b_lowerCircuit,
} from './screens.js';
import { searchCompanies, companyInsider, companyShareholding, companyDrilldown, companyPromoters, listSeries, insiderRecent } from './companies.js';
import { corporateActions } from './corporate.js';
import { getNews } from './news.js';
import { listFundManagers, listFirms, firmSearch } from './firms.js';

const PORT = process.env.PORT || 3000;
const app = express();

// Local dev only: frontend (src/nextjs) runs on a different port.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

// Strict positive-integer parse for query params interpolated into SQL
// (DuckDB INTERVAL/LIMIT don't take bound parameters here) — reject anything
// that isn't a clean integer instead of passing it through.
function intParam(req, res, name, fallback) {
  const raw = req.query[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    res.status(400).json({ error: `query param '${name}' must be a positive integer` });
    return null;
  }
  return Number(raw);
}

function route(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error', detail: err.message });
    }
  };
}

// Combined 52-week high/low (req.txt): current price + 52w-high value +
// previous 52w-high value + new-high event count/first/last, over the last n days.
app.get('/api/screens/52w-high', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  if (n === null) return null;
  return screen_high52wCombined(n);
}));

app.get('/api/screens/52w-low', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  if (n === null) return null;
  return screen_low52wCombined(n);
}));

// Kept for compatibility / the Python CLI parity (unused by the Markets UI now).
app.get('/api/screens/52w-high/last', route(() => screen1_high52wLastDay()));
app.get('/api/screens/52w-high/events', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  if (n === null) return null;
  return screen2_high52wEvents(n);
}));
app.get('/api/screens/52w-low/last', route(() => screen3a_low52wLastDay()));
app.get('/api/screens/52w-low/events', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  if (n === null) return null;
  return screen3b_low52wEvents(n);
}));

app.get('/api/screens/gainers', route((req, res) => {
  const top = intParam(req, res, 'top', 20);
  if (top === null) return null;
  return screen4a_gainers(top);
}));

app.get('/api/screens/losers', route((req, res) => {
  const top = intParam(req, res, 'top', 20);
  if (top === null) return null;
  return screen4b_losers(top);
}));

app.get('/api/screens/gainers/recurrence', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  const top = intParam(req, res, 'top', 20);
  if (n === null || top === null) return null;
  return screen5_gainersRecurrence(n, top);
}));

app.get('/api/screens/losers/recurrence', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  const top = intParam(req, res, 'top', 20);
  if (n === null || top === null) return null;
  return screen5b_losersRecurrence(n, top);
}));

app.get('/api/corporate-actions', route(() => corporateActions()));

// Layer C — LiveMint "companies" news, each article tagged with the NSE
// symbol(s) it names (see src/news.js). Default view shows every article.
app.get('/api/news', route(() => getNews()));

// Firms & Asset Managers — the rupeevest fund-manager pick-list, and a
// screener.in full-text search that returns the companies mentioning a firm /
// manager / free-text query (deduped). See src/firms.js.
app.get('/api/fund-managers', route(() => listFundManagers()));

// SEBI-registered firms (AMC/PMS/AIF/RIA) — the four dropdowns' pick-lists.
app.get('/api/firms', route(() => listFirms()));

app.get('/api/firm-search', route((req, res) => {
  // A repeated ?q= makes Express hand back an array - coerce to one string, and
  // cap length so a giant query can't be forwarded to screener.
  const raw = req.query.q;
  const q = (Array.isArray(raw) ? raw[0] : raw || '').toString().trim().slice(0, 200);
  if (!q) {
    res.status(400).json({ error: "query param 'q' is required" });
    return null;
  }
  return firmSearch(q);
}));

app.get('/api/screens/upper-circuit', route(() => screen6a_upperCircuit()));

app.get('/api/screens/lower-circuit', route(() => screen6b_lowerCircuit()));

app.get('/api/series', route(() => listSeries()));

app.get('/api/companies', route((req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    res.status(400).json({ error: "query param 'q' is required" });
    return null;
  }
  const series = (req.query.series || 'EQ').trim().toUpperCase() || 'EQ';
  return searchCompanies(q, series);
}));

app.get('/api/companies/:symbol/drilldown', route((req) => companyDrilldown(req.params.symbol.toUpperCase())));

app.get('/api/companies/:symbol/insider', route((req) => companyInsider(req.params.symbol.toUpperCase())));

app.get('/api/companies/:symbol/shareholding', route((req) => companyShareholding(req.params.symbol.toUpperCase())));

app.get('/api/companies/:symbol/promoters', route((req) => companyPromoters(req.params.symbol.toUpperCase())));

// Insider Centric — market-wide insider trades filed in the last `days` sessions.
app.get('/api/insider/recent', route((req, res) => {
  const days = intParam(req, res, 'days', 7);
  if (days === null) return null;
  return insiderRecent(days);
}));

app.listen(PORT, () => {
  console.log(`Fundamental-Screener API listening on :${PORT}`);
});

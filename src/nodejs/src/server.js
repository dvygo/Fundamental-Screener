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
import { getNews, getSitemapNews } from './news.js';
import { huntBoard } from './hunt.js';
import { listFundManagers, listFirms, firmSearch } from './firms.js';

const PORT = process.env.PORT || 3000;
const app = express();

// CORS. The frontend is deployed separately (Vercel) while this API runs on our
// own box, so every browser call is cross-origin — not just the local dev case
// of a second port.
//
// Open by design: `*` means any origin may call this. That is deliberate for
// now, but it also means the whole dataset is readable by anyone who finds the
// host. Narrow ALLOW_ORIGIN to the deployment origin when that stops being
// acceptable; `*` and credentials are mutually exclusive anyway, so this only
// stays workable while there is no auth.
//
// Answering OPTIONS matters even though today's requests are all plain GETs:
// those are "simple" requests and skip preflight, but the moment anything sends
// a custom header the browser preflights first, and an unhandled OPTIONS would
// fall through to the 404 handler and fail the real request with it.
// API_ALLOW_ORIGIN is either '*' or a comma-separated allowlist. Entries may be
// exact origins ('https://hunter-hazel-gamma.vercel.app') or carry a single
// wildcard ('https://*.vercel.app').
//
// The wildcard matters because Vercel mints a NEW origin for every deployment
// (hunter-<hash>-<team>.vercel.app), so an exact-only list breaks on the next
// deploy. Know what it costs: 'https://*.vercel.app' trusts every site hosted on
// vercel.app, not just ours. Narrow it to the stable domain once there's a
// custom one.
const ALLOW_ORIGIN = (process.env.API_ALLOW_ORIGIN || '*').trim();
const ALLOW_LIST = ALLOW_ORIGIN === '*'
  ? null
  : ALLOW_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
  if (!origin || !ALLOW_LIST) return false;
  return ALLOW_LIST.some((entry) => {
    const star = entry.indexOf('*');
    if (star === -1) return entry === origin;
    const prefix = entry.slice(0, star);
    const suffix = entry.slice(star + 1);
    // Length guard stops 'https://.vercel.app' matching 'https://*.vercel.app'.
    return origin.startsWith(prefix) && origin.endsWith(suffix) && origin.length > entry.length - 1;
  });
}

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!ALLOW_LIST) {
    res.set('Access-Control-Allow-Origin', '*');
  } else if (originAllowed(origin)) {
    // Echo the caller's own origin — this header cannot carry a list, so
    // echoing a verified origin is the only way an allowlist works.
    res.set('Access-Control-Allow-Origin', origin);
  }
  // Otherwise no ACAO header at all, and the browser blocks the read. That is
  // the intended outcome, not an error worth reporting.
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Echo what was asked for rather than guessing a fixed list.
  res.set('Access-Control-Allow-Headers', req.get('Access-Control-Request-Headers') || 'Content-Type');
  res.set('Access-Control-Max-Age', '86400'); // cache preflight for a day
  if (ALLOW_LIST) res.set('Vary', 'Origin'); // response now varies by caller; don't let a proxy pin one
  if (req.method === 'OPTIONS') return res.sendStatus(204);
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

// HUNT — the convergence scoreboard (context/requirements/.../Idea Hunting
// Framework.pdf). Ranks every stock by the flat-point signal score it accrued
// over a rolling window of the last `sessions` trading sessions (framework
// default 21 ≈ 1 month) across all the tripwires. See src/hunt.js.
app.get('/api/hunt', route((req, res) => {
  const sessions = intParam(req, res, 'sessions', 21);
  if (sessions === null) return null;
  return huntBoard(sessions);
}));

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

// LiveMint sitemaps, fetched on demand and served as their own News sections
// alongside the RSS feed above. today = the day so far, yesterday = the
// completed day before it; the two are disjoint by publication date.
app.get('/api/news/sitemap/today', route(() => getSitemapNews('today')));

app.get('/api/news/sitemap/yesterday', route(() => getSitemapNews('yesterday')));

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

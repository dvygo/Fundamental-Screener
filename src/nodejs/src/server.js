// REST API — serves data/extracts/ (bhavcopy + XBRL facts) as JSON.
// Layer A screens (requirement.md 1-5) + upper/lower circuit, stock-centric
// Layer B (B1 insider, B2 promoter shareholding), and Layer C news (the
// LiveMint companies feed, each article tagged with the NSE stock it names).

import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import https from 'node:https';
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
} from '#india/screens.js';
import { searchCompanies, companyInsider, companyShareholding, companyDrilldown, companyPromoters, listSeries, insiderRecent } from '#india/companies.js';
import { corporateActions } from '#india/corporate.js';
import { usHigh52wEvents, usLow52wEvents, usGainersRecurrence, usLosersRecurrence } from '#us/screens_us.js';
import { usInsiderRecent, usInsiderNet, usInsiderForSymbol } from '#us/insider_us.js';
import { usStockFundamentals, usStockPrices, usStockCoverage, usStockInsider } from '#us/stock_us.js';
import { getConnection } from '#db.js'; // for the startup warm-up below
import { getNews, getSitemapNews } from '#india/news.js';
import { huntBoard } from '#india/hunt.js';
import { listFundManagers, listFirms, firmSearch } from '#india/firms.js';

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
// One line per request, written when the response finishes so the status and
// duration are real rather than guessed. Exists because the API previously
// logged only errors: a request that succeeded and one that never arrived
// produced identical silence, which made "did my phone reach the API?"
// unanswerable. Now the absence of a line is itself the answer.
//
// Registered BEFORE the CORS middleware on purpose. That one answers OPTIONS
// with 204 and returns, so a logger placed after it never sees a preflight —
// and a failing preflight is exactly what you want visible when a browser is
// silently refusing to call the API.
//
// Origin and IP are logged because the interesting failures are remote: a
// blocked origin, or a caller from an address you did not expect. API_LOG=0
// silences it.
//
// Note: req.ip is the socket peer. Behind a reverse proxy (the planned TLS
// terminator on 443) every line would read as the proxy's address until
// `app.set('trust proxy', …)` is configured to match that hop.
const LOG_REQUESTS = process.env.API_LOG !== '0';
app.use((req, res, next) => {
  if (!LOG_REQUESTS) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const origin = req.get('Origin') || '-';
    const ip = req.ip || req.socket.remoteAddress || '-';
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms origin=${origin} ip=${ip}`,
    );
  });
  next();
});

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

// Markets US — S&P 500 via Yahoo (src/python/us_market_pull.py). Namespaced
// under /api/us/ so the NSE routes keep their paths and nothing existing moves.
// Four screens only: circuit has no US equivalent (see screens_us.js).
app.get('/api/us/screens/52w-high', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  if (n === null) return null;
  return usHigh52wEvents(n);
}));

app.get('/api/us/screens/52w-low', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  if (n === null) return null;
  return usLow52wEvents(n);
}));

app.get('/api/us/screens/gainers/recurrence', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  const top = intParam(req, res, 'top', 20);
  if (n === null || top === null) return null;
  return usGainersRecurrence(n, top);
}));

app.get('/api/us/screens/losers/recurrence', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  const top = intParam(req, res, 'top', 20);
  if (n === null || top === null) return null;
  return usLosersRecurrence(n, top);
}));

// Stock Centric US (Live lane) — finviz fundamentals + Yahoo bars.
app.get('/api/us/stock/:symbol/fundamentals', route((req) =>
  usStockFundamentals(req.params.symbol.toUpperCase())));

app.get('/api/us/stock/:symbol/prices', route((req, res) => {
  const days = intParam(req, res, 'days', 180);
  if (days === null) return null;
  return usStockPrices(req.params.symbol.toUpperCase(), days);
}));

// Per-source coverage, so the page can state ONE honest freshness stamp
// instead of asserting one it never checked.
app.get('/api/us/stock/:symbol/insider', route((req) =>
  usStockInsider(req.params.symbol.toUpperCase())));

app.get('/api/us/stock/:symbol/coverage', route((req) =>
  usStockCoverage(req.params.symbol.toUpperCase())));

// Insider Centric US — SEC Forms 3/4/5 (src/python/sec_insider_pull.py).
// open_market=0 widens to grants, tax withholding and option exercises; the
// default excludes them because they are payroll events, not decisions.
app.get('/api/us/insider/recent', route((req, res) => {
  const days = intParam(req, res, 'days', 90);
  if (days === null) return null;
  return usInsiderRecent(days, req.query.open_market !== '0');
}));

app.get('/api/us/insider/net', route((req, res) => {
  const days = intParam(req, res, 'days', 90);
  if (days === null) return null;
  return usInsiderNet(days);
}));

app.get('/api/us/insider/:symbol', route((req) => usInsiderForSymbol(req.params.symbol.toUpperCase())));

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
  console.log(`Fundamental-Screener API listening on :${PORT} (http)`);

  // Build the DuckDB views/tables now rather than on the first request.
  // getConnection() is lazy and memoised, so without this the whole setup —
  // including materialising the SEC tables from 8 quarters of TSVs — is paid by
  // whoever happens to arrive first. That took ~17s, and the Vercel proxy only
  // waits 25s, so the first visitor after every restart got a timeout while
  // every later one was served in milliseconds.
  //
  // Failure here is logged, not fatal: the API should still start and let the
  // per-route error handling report the problem, rather than refusing to boot
  // because one glob is empty.
  const t0 = Date.now();
  getConnection()
    .then(() => console.log(`DuckDB views ready in ${Date.now() - t0}ms`))
    .catch((err) => console.error('DuckDB warm-up failed:', err.message));
});

// Optional HTTPS listener, for the hop between the Vercel proxy and this box.
//
// That hop currently crosses the public internet in plaintext: readable by
// anyone on the path, with nothing proving this server is ours. A domain plus a
// public CA is the textbook fix, but there is no domain here — so the cert is
// self-signed with the public IP in its subjectAltName, and the Vercel proxy
// PINS it (undici Agent with `ca: [thisCert]`). Trusting exactly one certificate
// is stronger than trusting every public CA, not weaker; what it costs is that
// rotating the cert means updating the Vercel env var too.
//
// Browsers will not trust it, which does not matter: since the proxy landed, no
// browser talks to this API directly. Anything that did would still need a real
// certificate.
//
// Starts only when both files are present, so a box without certs boots plain
// HTTP exactly as before rather than failing.
const TLS_PORT = Number(process.env.API_TLS_PORT) || 4443;
const CERT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');
try {
  const [key, cert] = await Promise.all([
    fs.readFile(path.join(CERT_DIR, 'api-key.pem')),
    fs.readFile(path.join(CERT_DIR, 'api-cert.pem')),
  ]);
  https.createServer({ key, cert }, app).listen(TLS_PORT, () => {
    console.log(`Fundamental-Screener API listening on :${TLS_PORT} (https, self-signed)`);
  });
} catch {
  console.log(`No certs in ${CERT_DIR} — HTTPS listener not started (http only)`);
}

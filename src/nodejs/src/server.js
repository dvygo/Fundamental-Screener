// REST API — serves data/extracts/ (bhavcopy + XBRL facts) as JSON.
// Layer A screens (requirement.md 1-5) + upper/lower circuit, and now
// stock-centric Layer B (B1 insider, B2 promoter shareholding). Layer C
// (news) needs screener.in dossiers, not yet present in data/.

import express from 'express';
import {
  screen1_high52wLastDay,
  screen2_high52wEvents,
  screen3a_low52wLastDay,
  screen3b_low52wEvents,
  screen4a_gainers,
  screen4b_losers,
  screen5_gainersRecurrence,
  screen6a_upperCircuit,
  screen6b_lowerCircuit,
} from './screens.js';
import { searchCompanies, companyInsider, companyShareholding, companyDrilldown } from './companies.js';
import { corporateActions } from './corporate.js';

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

app.get('/api/screens/52w-high', route(() => screen1_high52wLastDay()));

app.get('/api/screens/52w-high/events', route((req, res) => {
  const n = intParam(req, res, 'n', 30);
  if (n === null) return null;
  return screen2_high52wEvents(n);
}));

app.get('/api/screens/52w-low', route(() => screen3a_low52wLastDay()));

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

app.get('/api/corporate-actions', route(() => corporateActions()));

app.get('/api/screens/upper-circuit', route(() => screen6a_upperCircuit()));

app.get('/api/screens/lower-circuit', route(() => screen6b_lowerCircuit()));

app.get('/api/companies', route((req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    res.status(400).json({ error: "query param 'q' is required" });
    return null;
  }
  return searchCompanies(q);
}));

app.get('/api/companies/:symbol/drilldown', route((req) => companyDrilldown(req.params.symbol.toUpperCase())));

app.get('/api/companies/:symbol/insider', route((req) => companyInsider(req.params.symbol.toUpperCase())));

app.get('/api/companies/:symbol/shareholding', route((req) => companyShareholding(req.params.symbol.toUpperCase())));

app.listen(PORT, () => {
  console.log(`Fundamental-Screener API listening on :${PORT}`);
});

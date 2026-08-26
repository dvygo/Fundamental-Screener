// News US — RSS headlines for the side pane's News tab.
//
// The counterpart to india/news.js, and it makes the opposite tagging bet.
// LiveMint headlines carry company NAMES, so that module matches brand phrases
// against the security master and needs a ~100-word stopword list to stop
// "ORIENT" or "APPLE" tagging the wrong listing. With 10,206 US tickers and far
// worse English collisions (A, ALL, KEY, IT, ON, GO are real symbols), that
// approach would be a false-positive machine.
//
// So this tags ONLY on an explicitly printed ticker — "(NASDAQ: AAPL)", the
// house style of the newswires — and validates every hit against us_sec_symbol.
// An article whose ticker is not printed goes untagged rather than guessed at.
// Under-tagging is recoverable; a wrong tag manufactures convergence, which is
// the one thing a scoreboard must not invent.
//
// WHY THE CLIENT SENDS IDs, NOT URLs
// The feed list lives here, and /api/us/news accepts catalogue ids. If it took
// a URL the endpoint would fetch whatever a caller named — an SSRF hole
// pointing at cloud metadata or anything else reachable from this box. Ids
// resolve against the table below and unknown ids are dropped.
//
// ROBOTS, per context/sources.md. Checked 2026-08-26 against each host's `*`
// block: CNBC, GlobeNewswire, PR Newswire and Nasdaq do not disallow the paths
// used here (GlobeNewswire disallows /SubscribeToRss/ and /newsroom/rss/, which
// are different paths). MarketWatch is ABSENT because its robots.txt itself
// answers 403 — a source whose rules cannot be read is not one to poll on a
// schedule.

import path from 'node:path';
import fs from 'node:fs/promises';
import process from 'node:process';
import * as cheerio from 'cheerio';
import { ROOT } from '#paths.js';
import { queryJson } from '#db.js';

const CACHE_DIR = path.join(ROOT, 'data', 'raw', 'us_news');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Same shape as india/news.js: a short TTL, not a calendar day, because these
// are live feeds. An explicit 0 means always refetch and is honoured — `|| 300`
// would silently turn it back into the default.
const ttlEnv = Number(process.env.US_NEWS_TTL_SECONDS);
const TTL_MS = (Number.isFinite(ttlEnv) && ttlEnv >= 0 ? ttlEnv : 300) * 1000;

/** The catalogue. Mirrored in src/nextjs/lib/settings.ts for the UI copy. */
export const FEEDS = new Map([
  ['cnbc-business', { label: 'CNBC Business', url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html' }],
  ['cnbc-top', { label: 'CNBC Top News', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' }],
  ['globenewswire', { label: 'GlobeNewswire', url: 'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies' }],
  ['prnewswire', { label: 'PR Newswire', url: 'https://www.prnewswire.com/rss/news-releases-list.rss' }],
  ['nasdaq', { label: 'Nasdaq Markets', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets' }],
]);

// Fetches are serialised with a gap, exactly as screener.js paces its scrape:
// several enabled feeds must not become a burst of simultaneous requests.
const REQUEST_DELAY = 700;
let lastFetchAt = 0;
let gate = Promise.resolve();

function pacedFetch(url) {
  const run = async () => {
    const wait = Math.max(0, REQUEST_DELAY - (Date.now() - lastFetchAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    return fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(20000),
    });
  };
  const result = gate.then(run, run);
  gate = result.then(() => undefined, () => undefined);
  return result;
}

async function feedXml(id, url) {
  const dest = path.join(CACHE_DIR, `${id}.xml`);
  try {
    const stat = await fs.stat(dest);
    if (Date.now() - stat.mtimeMs < TTL_MS) return fs.readFile(dest, 'utf8');
  } catch { /* not cached yet */ }
  try {
    const res = await pacedFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(dest, xml);
    return xml;
  } catch (err) {
    // Degrade gracefully, per the project conventions: serve stale rather than
    // failing the whole pane because one publisher had a bad minute.
    try {
      return await fs.readFile(dest, 'utf8');
    } catch {
      throw new Error(`${id}: ${err.message}`);
    }
  }
}

// Explicit exchange-prefixed tickers only: (NASDAQ: ABCD), (NYSE American:
// ABC), (TSX: ABC). 1-5 letters with an optional class suffix.
//
// The exchange prefix is what makes this safe. A bare capitalised token would
// match "CEO", "USA" and every other acronym in a headline; requiring a venue
// name in front means the publisher has explicitly declared a listing.
const TICKER_RE = /\(\s*(?:NASDAQ|NYSE(?:\s+(?:American|Arca))?|NYSEAMERICAN|AMEX|OTCQB|OTCQX|OTC|CBOE|BATS|TSX(?:V)?)\s*[:.]?\s*([A-Z]{1,5}(?:[.-][A-Z])?)\s*\)/gi;

function tickersIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(TICKER_RE)) {
    out.add(m[1].toUpperCase().replace('.', '-'));
  }
  return [...out];
}

let knownPromise = null;
/** Every ticker the SEC knows, so a printed symbol can be validated not trusted. */
function knownSymbols() {
  if (!knownPromise) {
    knownPromise = queryJson('SELECT DISTINCT symbol FROM us_sec_symbol')
      .then((rows) => new Set(rows.map((r) => r.symbol)))
      .catch(() => new Set());
  }
  return knownPromise;
}

function parseItems(xml, sourceId, sourceLabel) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];
  // RSS <item> and Atom <entry> in one pass — the catalogue holds both shapes.
  $('item, entry').each((_, el) => {
    const node = $(el);
    const title = (node.find('title').first().text() || '').trim();
    if (!title) return;
    const link =
      (node.find('link').first().text() || '').trim() ||
      node.find('link').first().attr('href') ||
      '';
    const published =
      (node.find('pubDate').first().text() ||
        node.find('published').first().text() ||
        node.find('updated').first().text() ||
        node.find('dc\\:date').first().text() ||
        '').trim();
    const description = (node.find('description').first().text() || '').trim();
    const iso = published ? new Date(published) : null;
    out.push({
      title,
      link,
      description: description.slice(0, 400),
      published: iso && !Number.isNaN(iso.getTime()) ? iso.toISOString() : null,
      source: sourceLabel,
      source_id: sourceId,
      // Title AND description: the wires print the ticker in the body as often
      // as the headline.
      _raw: `${title} ${description}`,
    });
  });
  return out;
}

/**
 * Headlines from the requested feeds, newest first.
 *
 * A feed that fails is reported in `errors` rather than taking the response
 * down — one publisher being unreachable should cost its own rows, not the
 * whole pane. Same rule extract.py applies to a bad file.
 */
export async function usNews(ids) {
  const wanted = [...FEEDS.keys()].filter((id) => ids.includes(id));
  const errors = [];

  const settled = await Promise.all(
    wanted.map(async (id) => {
      const { url, label } = FEEDS.get(id);
      try {
        return parseItems(await feedXml(id, url), id, label);
      } catch (err) {
        errors.push({ feed: id, error: err.message });
        return [];
      }
    }),
  );

  const known = await knownSymbols();
  const seen = new Set();
  const items = [];
  for (const list of settled) {
    for (const it of list) {
      // Dedup across feeds by link — a syndicated release genuinely appears in
      // more than one wire, and counting it twice would overstate it.
      const key = it.link || it.title;
      if (seen.has(key)) continue;
      seen.add(key);
      const { _raw, ...rest } = it;
      items.push({ ...rest, symbols: tickersIn(_raw).filter((s) => known.has(s)) });
    }
  }

  items.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  return { items, errors, feeds: wanted };
}

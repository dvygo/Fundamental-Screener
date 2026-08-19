// Layer C (news) — the LiveMint "companies" RSS feed, cached to data/raw as
// today.xml and re-parsed. Each article is tagged with the NSE symbol(s) it
// mentions by matching the headline against the security master (brand phrases),
// so the Stock Centric universe and the news feed share one identity.
//
// Node does the scraping (screener + now RSS); Python stays on static-file
// extraction. The feed is one small request, so no pacing gate is needed — but
// we still cache to disk and re-parse from cache while the copy is fresh.
//
// "Fresh" is a short TTL, not the calendar day: this is a live feed that gains
// stories all day, so a day-long cache would pin the tab to whatever the first
// request of the morning happened to see. Today's news is served on demand;
// completed days come from data/store/news.parquet, which Python builds from
// the yesterday.xml sitemap snapshots (see src/python/livemint_snapshot.py).
//
// Note the filename collision: this cache is the RSS feed, while Python's
// snapshots of the *sitemap* live under data/raw/livemint/sitemap/<date>/.
// Different sources, different directories.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../paths.js';
import process from 'node:process';
import * as cheerio from 'cheerio';
import { queryJson } from '../db.js';


const CACHE_DIR = path.join(ROOT, 'data', 'raw', 'livemint');
const CACHE_FILE = path.join(CACHE_DIR, 'today.xml');

// LiveMint's "companies" feed — the same page as livemint.com/companies. Real,
// documented RSS (livemint.com/rss); never a fabricated URL.
const FEED_URL = 'https://www.livemint.com/rss/companies';
// How long a cached copy stays servable. Short enough that the tab reflects the
// feed within minutes, long enough that a burst of requests is one fetch.
// Override with LIVEMINT_FEED_TTL_SECONDS (0 = always refetch; `|| 300` would
// swallow a deliberate 0, so validate instead).
const ttlRaw = process.env.LIVEMINT_FEED_TTL_SECONDS;
const ttlEnv = ttlRaw === undefined || ttlRaw.trim() === '' ? NaN : Number(ttlRaw);
const FEED_TTL_MS = (Number.isFinite(ttlEnv) && ttlEnv >= 0 ? ttlEnv : 300) * 1000;

// ---- sitemaps (today.xml / yesterday.xml) --------------------------------
//
// A second, independent source from the RSS feed above. LiveMint's two
// Google-News sitemaps are partitioned by publication day and disjoint:
// today.xml is the day so far, yesterday.xml the completed day before. The News
// tab renders them as their own sections, so the same story appearing in both
// the RSS and a sitemap is expected and not deduped across sections.
//
// Fetched on demand, unlike Python's scheduled capture. The disk copy is only
// rewritten when the bytes actually differ, so an unchanged sitemap costs no
// write and keeps its mtime; a fetch failure falls back to whatever is on disk.
//
// This cache is deliberately NOT data/raw/livemint/sitemap/<YYYYMMDD>/ — that
// tree belongs to src/python/livemint_snapshot.py, which owns the durable
// end-of-day archive. Node must never overwrite a captured snapshot: it holds
// the only copy of a day LiveMint has already dropped.
const SITEMAP_DIR = path.join(CACHE_DIR, 'sitemap-live');
const ROBOTS_URL = 'https://www.livemint.com/robots.txt';
const SITEMAP_NAMES = ['today.xml', 'yesterday.xml'];

// Short floor between refetches. "On demand" still has to respect the pacing
// rule — without it a burst of tab loads is a burst of upstream requests.
const smTtlRaw = process.env.LIVEMINT_SITEMAP_TTL_SECONDS;
const smTtl = smTtlRaw === undefined || smTtlRaw.trim() === '' ? NaN : Number(smTtlRaw);
const SITEMAP_TTL_MS = (Number.isFinite(smTtl) && smTtl >= 0 ? smTtl : 60) * 1000;

// robots.txt is both how the sitemap URLs are discovered and the permission to
// fetch them — they are never written down here. Resolved once per process.
let sitemapUrls = null;
async function discoverSitemaps() {
  if (sitemapUrls) return sitemapUrls;
  const res = await fetch(ROBOTS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`LiveMint robots.txt HTTP ${res.status}`);
  const found = {};
  for (const line of (await res.text()).split(/\r?\n/)) {
    if (!line.toLowerCase().startsWith('sitemap:')) continue;
    const url = line.slice(line.indexOf(':') + 1).trim();
    const name = url.split('/').pop();
    if (SITEMAP_NAMES.includes(name) && !found[name]) found[name] = url;
  }
  sitemapUrls = found;
  return found;
}

async function ensureSitemapXml(name) {
  const dest = path.join(SITEMAP_DIR, name);
  try {
    const stat = await fs.stat(dest);
    if (Date.now() - stat.mtimeMs < SITEMAP_TTL_MS) return fs.readFile(dest, 'utf8');
  } catch {
    /* not cached yet */
  }
  try {
    const urls = await discoverSitemaps();
    const url = urls[name];
    if (!url) throw new Error(`robots.txt does not advertise ${name}`);
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml' } });
    if (!res.ok) throw new Error(`LiveMint ${name} HTTP ${res.status}`);
    const xml = await res.text();
    await fs.mkdir(SITEMAP_DIR, { recursive: true });
    // Rewrite only on a real change; an identical body leaves the file alone.
    let unchanged = false;
    try {
      unchanged = (await fs.readFile(dest, 'utf8')) === xml;
    } catch {
      /* no prior copy */
    }
    if (!unchanged) await fs.writeFile(dest, xml);
    return xml;
  } catch (err) {
    try {
      return await fs.readFile(dest, 'utf8');
    } catch {
      throw err;
    }
  }
}

// One sitemap -> the same item shape the RSS path returns, so the UI renders
// both with one component. <news:keywords> stands in for the RSS description.
export async function getSitemapNews(which) {
  const name = `${which}.xml`;
  if (!SITEMAP_NAMES.includes(name)) throw new Error(`unknown sitemap: ${which}`);
  const [xml, brand] = await Promise.all([ensureSitemapXml(name), loadBrandIndex()]);
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('url').each((_, el) => {
    const node = $(el);
    const title = decodeText(node.find('news\\:title, title').first().text());
    if (!title) return;
    const pub = node.find('news\\:publication_date, publication_date').first().text().trim();
    const published = pub ? new Date(pub) : null;
    items.push({
      title,
      link: node.find('loc').first().text().trim(),
      description: decodeText(node.find('news\\:keywords, keywords').first().text()),
      published: published && !Number.isNaN(published.valueOf()) ? published.toISOString() : null,
      image: node.find('image\\:loc').first().text().trim() || null,
      symbols: tagStocks(title, brand),
    });
  });
  items.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  return items;
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---- stock tagging -------------------------------------------------------

// Generic business words — never a brand on their own (used to build the
// discriminating 2-token brand phrase and to reject weak solo tokens).
const GENERIC = new Set(['LIMITED','LTD','PVT','PRIVATE','CORPORATION','CORP','COMPANY','CO','INDIA','INDIAN',
  'THE','AND','OF','GROUP','HOLDINGS','HOLDING','ENTERPRISES','ENTERPRISE','INDUSTRIES','INDUSTRY','INDUSTRIAL',
  'PROJECTS','PRODUCTS','SERVICES','SERVICE','SYSTEMS','SYSTEM','TECHNOLOGIES','TECHNOLOGY','INFRASTRUCTURE',
  'INFRA','FINANCE','FINANCIAL','INVESTMENTS','INVESTMENT','INTERNATIONAL','GLOBAL','VENTURES','MILLS',
  'LABORATORIES','LABS','PHARMA','PHARMACEUTICALS','CHEMICALS','ENGINEERING','CAPITAL','SOLUTIONS','RESOURCES']);
// Tokens too generic/ambiguous to trust as a solo (single-word) brand: places,
// months, common surnames, common English/biz words, and a few global-brand
// collisions (Apple, Paramount…) that map to unrelated small Indian listings.
const PLACES = ['ANDHRA','GUJARAT','KERALA','PUNJAB','BENGAL','SOUTH','NORTH','EAST','WEST','EASTERN','WESTERN',
  'CENTRAL','BOMBAY','MADRAS','DELHI','MUMBAI','MYSORE','BANGALORE'];
const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const SURNAMES = ['SHARMA','KUMAR','SINGH','PATEL','SHAH','GUPTA','MEHTA','VERMA','RAO','REDDY','NAIR','IYER',
  'KHAN','JAIN','AGARWAL','MODI','ROY','BOSE'];
const COMMON = ['ORIENT','ORIENTAL','NATIONAL','STATE','UNITED','MODERN','STANDARD','PREMIER','UNIVERSAL','GENERAL',
  'FUTURE','APPLE','PARAMOUNT','ENGINEERS','POWER','ENERGY','STEEL','CEMENT','BANK','HEALTH','MOTORS','PAPER',
  'SUGAR','TEXTILES','METALS','METAL','MINING','AUTO','FOODS','SECURITIES','ELECTRONICS','ELECTRONIC','DIGITAL',
  'SMART','METRO','INDIGO','MANIPAL','PRIME','ROYAL','SUPER','STAR','SUPREME','NEW','INDO'];
const STOP = new Set([...GENERIC, ...PLACES, ...MONTHS, ...SURNAMES, ...COMMON]);

const clean = (s) => s.toUpperCase().replace(/[^A-Z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();

// full2 = first two tokens (a specific phrase, low false-positive: "TATA
// CONSUMER", "HINDUSTAN ZINC", "ADANI ENERGY"); solo = the first token, kept
// only when it's distinctive enough (>=4 chars, not a stopword).
function aliasesOf(name) {
  const t = clean(name).split(' ').filter(Boolean);
  if (!t.length) return { full2: null, solo: null };
  return {
    full2: t.length >= 2 ? `${t[0]} ${t[1]}` : null,
    solo: t[0].length >= 4 && !STOP.has(t[0]) ? t[0] : null,
  };
}

let brandIndexPromise = null;
// brand phrase -> Map(symbol -> {symbol, company_name}). Built once per process
// from the EQ security master (clean tradable symbols only — no suspended '$'
// or rights '-RE' tickers). Ambiguous keys are dropped so a headline only tags
// a stock when the match is confident.
function loadBrandIndex() {
  if (!brandIndexPromise) {
    brandIndexPromise = (async () => {
      const rows = await queryJson(
        `SELECT symbol, company_name FROM security_master
         WHERE series = 'EQ' AND company_name <> ''
           AND regexp_matches(symbol, '^[A-Z0-9]+$') AND NOT regexp_matches(symbol, '^[0-9]')
           AND symbol NOT ILIKE '%NSETEST%'`,
      );
      const brand = new Map();
      const add = (k, r) => {
        if (!k) return;
        if (!brand.has(k)) brand.set(k, new Map());
        brand.get(k).set(r.symbol, r);
      };
      for (const r of rows) {
        const { full2, solo } = aliasesOf(r.company_name);
        add(full2, r);
        add(solo, r);
      }
      // Drop ambiguous keys: a solo (single word) that maps to more than one
      // symbol, or any key that maps to more than three — guessing there is worse
      // than leaving the article untagged.
      for (const [k, m] of brand) {
        const oneWord = !k.includes(' ');
        if ((oneWord && m.size > 1) || m.size > 3) brand.delete(k);
      }
      return brand;
    })();
  }
  return brandIndexPromise;
}

// RSS descriptions arrive HTML-encoded (sometimes double-encoded: "&amp;nbsp;")
// and may carry stray markup. Decode entities (up to two passes), strip tags,
// and collapse whitespace so the UI shows clean text.
function decodeText(s) {
  if (!s) return '';
  let t = String(s);
  for (let i = 0; i < 2 && /&[a-z#0-9]+;/i.test(t); i++) {
    t = cheerio.load(`<div>${t}</div>`).root().text();
  }
  return t.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every word of the matched span begins with a capital — a proper noun as
// written ("Niva Bupa", "RELIANCE"), not the common-noun sense ("page", "metal").
const isProperNoun = (span) => span.split(/\s+/).every((w) => /^[A-Z0-9&]/.test(w));

// Tag a headline with the stocks it names. Match the TITLE only (the subject
// company lives there; descriptions add noise), with word boundaries.
function tagStocks(title, brand) {
  const found = new Map();
  for (const [k, m] of brand) {
    const re = new RegExp(`\\b${escapeRe(k).replace(/ /g, '\\s+')}\\b`, 'ig');
    let x;
    while ((x = re.exec(title))) {
      if (isProperNoun(x[0])) {
        for (const r of m.values()) found.set(r.symbol, r);
        break;
      }
    }
  }
  return [...found.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// ---- feed fetch + cache --------------------------------------------------

// Serve the cached copy only while it is younger than the TTL; otherwise fetch
// fresh and rewrite it. On a fetch failure fall back to any cached copy (even a
// stale one) so the tab still renders — never abort the request.
async function ensureFeedXml() {
  try {
    const stat = await fs.stat(CACHE_FILE);
    if (Date.now() - stat.mtimeMs < FEED_TTL_MS) {
      return fs.readFile(CACHE_FILE, 'utf8');
    }
  } catch {
    /* no cache yet */
  }
  try {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' } });
    if (!res.ok) throw new Error(`LiveMint feed HTTP ${res.status}`);
    const xml = await res.text();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, xml);
    return xml;
  } catch (err) {
    // network hiccup — serve the last cached copy if we have one.
    try {
      return await fs.readFile(CACHE_FILE, 'utf8');
    } catch {
      throw err;
    }
  }
}

// The full parsed feed: every article in today.xml, newest first, each tagged
// with the NSE stock(s) it mentions (empty array for general/global news). The
// "News" tab shows all of these by default and filters by a tagged stock.
export async function getNews() {
  const [xml, brand] = await Promise.all([ensureFeedXml(), loadBrandIndex()]);
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item').each((_, el) => {
    const node = $(el);
    const title = decodeText(node.find('title').first().text());
    if (!title) return;
    const pub = node.find('pubDate').first().text().trim();
    const published = pub ? new Date(pub) : null;
    items.push({
      title,
      link: node.find('link').first().text().trim() || node.find('guid').first().text().trim(),
      description: decodeText(node.find('description').first().text()),
      published: published && !Number.isNaN(published.valueOf()) ? published.toISOString() : null,
      image: node.find('media\\:content, content').first().attr('url') || null,
      symbols: tagStocks(title, brand),
    });
  });
  items.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  return items;
}

#!/usr/bin/env node
// Brief — scheduled data job. Node 24, zero dependencies (built-ins only).
//
//   node job/build-brief.mjs             real run (needs ANTHROPIC_API_KEY)
//   node job/build-brief.mjs --fixture   offline: job/fixtures/** in, docs/data out
//   node job/build-brief.mjs --dry-run   live fetch of feeds + econ, print payload, no Claude call, no writes
//   node job/build-brief.mjs --validate  validate docs/data/*.json, exit 1 on failure
//
// Env: ANTHROPIC_API_KEY, BRIEF_MODEL (default claude-opus-5),
//      BRIEF_NOW (ISO timestamp override, mostly for tests),
//      BRIEF_FIXTURE_RESPONSE (path to an alternate canned model response in --fixture mode).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JOB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(JOB_DIR, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const FIX_DIR = path.join(JOB_DIR, 'fixtures');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(JOB_DIR, 'brief.schema.json'), 'utf8'));

const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has('--validate') ? 'validate' : ARGS.has('--fixture') ? 'fixture' : ARGS.has('--dry-run') ? 'dry-run' : 'real';

const MODEL = process.env.BRIEF_MODEL || 'claude-opus-5';
const USER_AGENT = 'BriefBot/1.0 (+personal news reader)';
const FEED_TIMEOUT_MS = 10_000;
const KALSHI_TIMEOUT_MS = 5_000;
const WINDOW_HOURS = 36;
const MAX_ARTICLES = 120;
const HISTORY_DAYS = 30;
const MAX_ACTIVE_STORYLINES = 12;
const DORMANT_AFTER_DAYS = 14;
const FIXTURE_NOW = '2026-09-27T13:00:00Z';

// USD per million tokens [input, output]. Unknown models log tokens only.
const PRICES = {
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [2, 10],
};

// 2026 FOMC meetings [start, end]. Used when the Fed calendar page can't be fetched/parsed.
// CHECK YEARLY: add next year's schedule from federalreserve.gov/monetarypolicy/fomccalendars.htm
const FOMC_HARDCODED = [
  ['2026-01-27', '2026-01-28'], ['2026-03-17', '2026-03-18'], ['2026-04-28', '2026-04-29'],
  ['2026-06-16', '2026-06-17'], ['2026-07-28', '2026-07-29'], ['2026-09-15', '2026-09-16'],
  ['2026-10-27', '2026-10-28'], ['2026-12-08', '2026-12-09'],
];

const FRED_SERIES = [
  { id: 'FEDFUNDS', key: 'fedfunds_effective', label: 'Fed funds (effective)', unit: '%' },
  { id: 'DFEDTARL', key: null },            // target range lower bound (combined below)
  { id: 'DFEDTARU', key: null },            // target range upper bound
  { id: 'CPIAUCSL', key: 'cpi_yoy', label: 'CPI inflation (YoY)', unit: '%' },
  { id: 'UNRATE', key: 'unrate', label: 'Unemployment', unit: '%' },
  { id: 'DGS10', key: 'dgs10', label: '10-yr Treasury', unit: '%' },
  { id: 'DGS2', key: 'dgs2', label: '2-yr Treasury', unit: '%' },
  { id: 'MORTGAGE30US', key: 'mortgage30', label: '30-yr mortgage', unit: '%' },
];

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('WARN', ...a);

function nowDate() {
  if (process.env.BRIEF_NOW) return new Date(process.env.BRIEF_NOW);
  if (MODE === 'fixture') return new Date(FIXTURE_NOW);
  return new Date();
}
function laDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

// ───────────────────────────── fetch (routed to fixtures in --fixture) ─────────────────────────────

async function httpGet(url, { timeout = FEED_TIMEOUT_MS, accept = '*/*' } = {}) {
  if (MODE === 'fixture') throw new Error('network disabled in --fixture mode: ' + url);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ───────────────────────────── RSS / Atom parser ─────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', Eacute: 'É', Ouml: 'Ö', Uuml: 'Ü',
  Auml: 'Ä', Ntilde: 'Ñ', Ccedil: 'Ç', times: '×', divide: '÷', minus: '−', shy: '', zwnj: '', zwj: '', thinsp: ' ', ensp: ' ', emsp: ' ',
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return Object.hasOwn(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}
// XML text content: CDATA sections are literal, everything else is entity-decoded.
function xmlText(raw) {
  let out = '';
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0, m;
  while ((m = re.exec(raw))) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = re.lastIndex;
  }
  return out + decodeEntities(raw.slice(last));
}
function stripHtml(s) {
  return decodeEntities(
    s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function tagInner(block, name) {
  const n = escRe(name);
  const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
  return m ? m[1] : null;
}
function firstTag(block, names) {
  for (const n of names) {
    const v = tagInner(block, n);
    if (v != null && v.trim()) return v;
  }
  return null;
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${escRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}
function entryLink(block) {
  // Atom: <link rel="alternate" href="..."/> (rel absent == alternate)
  const links = block.match(/<link\b[^>]*>/gi) || [];
  let best = null;
  for (const l of links) {
    const href = attr(l, 'href');
    if (!href) continue;
    const rel = (attr(l, 'rel') || 'alternate').toLowerCase();
    if (rel === 'alternate') { best = href; break; }
    best ??= rel === 'self' ? null : href;
  }
  if (best) return best.trim();
  // RSS: <link>url</link>
  const t = tagInner(block, 'link');
  if (t && xmlText(t).trim()) return xmlText(t).trim();
  // guid isPermaLink
  const g = block.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/i);
  if (g && !/isPermaLink\s*=\s*["']false/i.test(g[1])) {
    const v = xmlText(g[2]).trim();
    if (/^https?:\/\//.test(v)) return v;
  }
  return null;
}
export function parseFeed(xml) {
  const text = xml.replace(/^﻿/, '');
  const root = text.match(/<(rss|feed|rdf:RDF)[\s>]/i);
  if (!root) throw new Error('not an RSS/Atom document');
  const closer = { rss: '</rss>', feed: '</feed>', 'rdf:rdf': '</rdf:RDF>' }[root[1].toLowerCase()];
  if (!new RegExp(escRe(closer), 'i').test(text)) throw new Error(`truncated XML (no ${closer})`);
  const entries = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(text))) {
    const b = m[2];
    const titleRaw = tagInner(b, 'title');
    const title = titleRaw ? stripHtml(xmlText(titleRaw)) : '';
    const url = entryLink(b);
    const dateRaw = firstTag(b, ['pubDate', 'published', 'updated', 'dc:date', 'a10:updated']);
    const ts = dateRaw ? Date.parse(xmlText(dateRaw).trim()) : NaN;
    const sumRaw = firstTag(b, ['description', 'summary', 'content:encoded', 'content']);
    const summary = sumRaw ? stripHtml(xmlText(sumRaw)) : '';
    if (!title || !url) continue;
    entries.push({ title, url, published: Number.isFinite(ts) ? new Date(ts).toISOString() : null, summary });
  }
  return entries;
}

// ───────────────────────────── feeds → article list ─────────────────────────────

function loadFeedList() {
  if (MODE === 'fixture') {
    return fs.readdirSync(path.join(FIX_DIR, 'feeds')).filter(f => f.endsWith('.xml')).sort().map(f => ({
      outlet: 'Fixture ' + f.replace(/\.xml$/, ''), url: 'fixture:' + f, kind: 'world',
    }));
  }
  return JSON.parse(fs.readFileSync(path.join(JOB_DIR, 'feeds.json'), 'utf8'));
}

async function fetchFeed(feed) {
  const get = () => httpGet(feed.url, { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' });
  const xml = MODE === 'fixture'
    ? fs.readFileSync(path.join(FIX_DIR, 'feeds', feed.url.slice('fixture:'.length)), 'utf8')
    // one retry for connection-level failures (not HTTP errors, not timeouts)
    : await get().catch(e => (e.message === 'fetch failed' ? get() : Promise.reject(e)));
  return parseFeed(xml);
}

function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|at_|cmpid|mod$|ref$|src$)/i.test(k)) x.searchParams.delete(k);
    return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + (x.search || '')).toLowerCase();
  } catch { return u.toLowerCase(); }
}
function titleTokens(t) {
  return new Set(t.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

async function gatherArticles(now) {
  const feeds = loadFeedList();
  const results = await Promise.all(feeds.map(async f => {
    const t0 = Date.now();
    try {
      const entries = await fetchFeed(f);
      return { feed: f, ok: true, entries, ms: Date.now() - t0 };
    } catch (e) {
      return { feed: f, ok: false, entries: [], error: e.name === 'TimeoutError' ? 'timeout' : (e.message || String(e)), ms: Date.now() - t0 };
    }
  }));
  const cutoff = now.getTime() - WINDOW_HOURS * 3600_000;
  const status = [];
  let all = [];
  for (const r of results) {
    const fresh = r.entries.filter(e => e.published && Date.parse(e.published) >= cutoff && Date.parse(e.published) <= now.getTime() + 3600_000);
    status.push({ outlet: r.feed.outlet, url: r.feed.url, ok: r.ok, count: r.entries.length, fresh: fresh.length, error: r.error || '', ms: r.ms });
    log(`feed ${r.ok ? 'ok  ' : 'FAIL'} ${r.feed.outlet.padEnd(16)} items=${String(r.entries.length).padStart(3)} fresh=${String(fresh.length).padStart(3)} ${r.ms}ms ${r.feed.url}${r.error ? '  ' + r.error : ''}`);
    all.push(...fresh.map(e => ({ outlet: r.feed.outlet, kind: r.feed.kind, ...e })));
  }
  const raw = all.length;
  all.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  const seenUrl = new Set();
  const kept = [];
  for (const a of all) {
    const nu = normUrl(a.url);
    if (seenUrl.has(nu)) continue;
    const tk = titleTokens(a.title);
    if (kept.some(k => jaccard(k._tk, tk) >= 0.8)) continue;
    seenUrl.add(nu);
    kept.push({ ...a, _tk: tk });
  }
  // Cap with round-robin across outlets (newest first within each) so no one outlet dominates.
  const byOutlet = new Map();
  for (const a of kept) (byOutlet.get(a.outlet) ?? byOutlet.set(a.outlet, []).get(a.outlet)).push(a);
  const capped = [];
  const queues = [...byOutlet.values()];
  while (capped.length < MAX_ARTICLES && queues.some(q => q.length)) {
    for (const q of queues) if (q.length && capped.length < MAX_ARTICLES) capped.push(q.shift());
  }
  capped.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  const articles = capped.map(a => ({
    outlet: a.outlet, kind: a.kind, title: a.title.slice(0, 300), url: a.url, published: a.published,
    summary: a.summary.length > 400 ? a.summary.slice(0, 399).trimEnd() + '…' : a.summary,
  }));
  log(`articles: ${raw} in ${WINDOW_HOURS}h window → ${kept.length} after dedupe → ${articles.length} after cap`);
  return { articles, status };
}

// ───────────────────────────── FRED ─────────────────────────────

function parseFredCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (!/^(observation_date|DATE),/i.test(lines[0] || '')) throw new Error('unexpected CSV header');
  const obs = [];
  for (const line of lines.slice(1)) {
    const [date, v] = line.split(',');
    if (!date || v == null) continue;
    const n = Number(v.trim());
    if (v.trim() === '.' || v.trim() === '' || !Number.isFinite(n)) continue;
    obs.push({ date: date.trim(), value: n });
  }
  if (!obs.length) throw new Error('no observations');
  return obs;
}
async function fetchFredSeries(id, now) {
  if (MODE === 'fixture') return parseFredCsv(fs.readFileSync(path.join(FIX_DIR, 'fred', id + '.csv'), 'utf8'));
  const start = addDays(laDate(now), -3 * 365);
  return parseFredCsv(await httpGet(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`, { accept: 'text/csv' }));
}
const fmt2 = n => n.toFixed(2);
function cpiYoY(obs, i) {
  const d = obs[i].date;
  const target = String(Number(d.slice(0, 4)) - 1) + d.slice(4);
  const prev = obs.find(o => o.date === target);
  return prev ? Math.round((obs[i].value / prev.value - 1) * 1000) / 10 : null;
}
async function gatherFred(now) {
  const out = {};
  const status = {};
  await Promise.all(FRED_SERIES.map(async s => {
    try {
      out[s.id] = await fetchFredSeries(s.id, now);
      status[s.id] = `ok (${out[s.id].length} obs, last ${out[s.id].at(-1).date})`;
    } catch (e) {
      status[s.id] = 'FAIL ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
  }));
  for (const s of FRED_SERIES) log(`fred ${s.id.padEnd(13)} ${status[s.id]}`);
  const indicators = [];
  const pair = (s, cur, prev, curVal, prevVal) => indicators.push({
    key: s.key, label: s.label, unit: s.unit, value: curVal, as_of: cur.date,
    previous: prevVal ?? null, previous_as_of: prev ? prev.date : null,
  });
  if (out.DFEDTARL && out.DFEDTARU) {
    const L = out.DFEDTARL, U = out.DFEDTARU;
    const cur = `${fmt2(L.at(-1).value)}–${fmt2(U.at(-1).value)}`;
    // previous = last range that differs, for "change since" context
    let prevIdx = L.length - 2;
    while (prevIdx >= 0 && L[prevIdx].value === L.at(-1).value) prevIdx--;
    const prev = prevIdx >= 0 ? `${fmt2(L[prevIdx].value)}–${fmt2(U[Math.min(prevIdx, U.length - 1)].value)}` : null;
    indicators.push({ key: 'fedfunds', label: 'Fed funds target', unit: '%', value: cur, as_of: L.at(-1).date, previous: prev, previous_as_of: prevIdx >= 0 ? L[prevIdx].date : null, previous_note: 'last different target range' });
  }
  for (const s of FRED_SERIES) {
    if (!s.key || !out[s.id]) continue;
    const o = out[s.id];
    if (s.id === 'CPIAUCSL') {
      const i = o.length - 1;
      const cur = cpiYoY(o, i), prev = i > 0 ? cpiYoY(o, i - 1) : null;
      if (cur == null) { warn('CPI YoY: no observation 12 months back'); continue; }
      pair(s, o[i], o[i - 1], cur.toFixed(1), prev == null ? null : prev.toFixed(1));
      continue;
    }
    pair(s, o.at(-1), o.at(-2), fmt2(o.at(-1).value), o.length > 1 ? fmt2(o.at(-2).value) : null);
  }
  return indicators;
}

// ───────────────────────────── Kalshi ─────────────────────────────

function kalshiSortKey(t) {
  const m = String(t).match(/-(d{2})([A-Z]{3})$/);
  return m ? Number(m[1]) * 100 + ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(m[2]) : Infinity;
}
const cents = v => (v == null || v === '' ? null : typeof v === 'string' ? Number(v) : v / 100);
// Kalshi event tickers look like KXFEDDECISION-26OCT (YY + month of the decision day).
function kalshiEventTicker(ymd) {
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(ymd.slice(5, 7)) - 1];
  return `KXFEDDECISION-${ymd.slice(2, 4)}${mon}`;
}
async function gatherKalshi(nextMeeting) {
  const K = 'https://api.elections.kalshi.com/trade-api/v2';
  const get = url => httpGet(url, { timeout: KALSHI_TIMEOUT_MS, accept: 'application/json' });
  try {
    let body;
    if (MODE === 'fixture') body = fs.readFileSync(path.join(FIX_DIR, 'kalshi.json'), 'utf8');
    else {
      // The series listing is newest-first and paginated, so ask for the next meeting's event directly;
      // if we don't know the date, find the earliest open event via /events.
      let ev = nextMeeting ? kalshiEventTicker(nextMeeting) : null;
      if (!ev) {
        const events = JSON.parse(await get(`${K}/events?series_ticker=KXFEDDECISION&status=open&limit=50`)).events || [];
        ev = events.map(e => e.event_ticker).sort((a, b) => kalshiSortKey(a) - kalshiSortKey(b))[0];
        if (!ev) throw new Error('no open KXFEDDECISION events');
      }
      body = await get(`${K}/markets?event_ticker=${encodeURIComponent(ev)}&limit=20`);
    }
    const markets = JSON.parse(body).markets;
    if (!Array.isArray(markets) || !markets.length) throw new Error('no open markets in response');
    // Earliest-closing event = next meeting.
    const byEvent = new Map();
    for (const m of markets) (byEvent.get(m.event_ticker) ?? byEvent.set(m.event_ticker, []).get(m.event_ticker)).push(m);
    const events = [...byEvent.values()].sort((a, b) => Date.parse(a[0].close_time) - Date.parse(b[0].close_time));
    const ev = events[0];
    const odds = ev.map(m => {
      const bid = cents(m.yes_bid_dollars ?? m.yes_bid), ask = cents(m.yes_ask_dollars ?? m.yes_ask), last = cents(m.last_price_dollars ?? m.last_price);
      const prob = bid != null && ask != null && ask > 0 && ask - bid <= 0.1 ? (bid + ask) / 2 : last;
      return { label: String(m.yes_sub_title || m.subtitle || m.title || m.ticker).slice(0, 40), prob: prob == null ? null : Math.round(prob * 100) / 100, ticker: m.ticker, close_time: m.close_time };
    }).filter(o => o.prob != null && Number.isFinite(o.prob)).sort((a, b) => b.prob - a.prob);
    log(`kalshi ok  event=${ev[0].event_ticker} markets=${odds.length} ${odds.map(o => `${o.label}=${o.prob}`).join(', ')}`);
    return odds;
  } catch (e) {
    log(`kalshi FAIL ${e.name === 'TimeoutError' ? 'timeout' : e.message} → odds []`);
    return [];
  }
}

// ───────────────────────────── FOMC calendar ─────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseFomcPage(html) {
  const meetings = [];
  const sections = html.split(/(\d{4}) FOMC Meetings/);
  for (let i = 1; i < sections.length; i += 2) {
    const year = Number(sections[i]);
    const body = sections[i + 1] || '';
    const re = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;
    let m;
    while ((m = re.exec(body))) {
      const monthStr = m[1].trim(), dateStr = m[2].trim();
      if (/notation|unscheduled/i.test(dateStr)) continue;
      const ms = monthStr.split('/').map(s => MONTHS[s.trim().slice(0, 3).toLowerCase()]);
      const ds = dateStr.replace(/\*/g, '').match(/(\d+)(?:\s*-\s*(\d+))?/);
      if (!ms[0] || !ds) continue;
      const d1 = Number(ds[1]), d2 = ds[2] ? Number(ds[2]) : d1;
      const m2 = ms[1] || ms[0];
      const iso = (mo, d) => `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      meetings.push([iso(ms[0], d1), iso(m2, d2)]);
    }
  }
  return meetings;
}
async function fomcSchedule() {
  if (MODE === 'fixture') return { list: FOMC_HARDCODED, source: 'hardcoded' };
  try {
    const parsed = parseFomcPage(await httpGet('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { accept: 'text/html' }));
    const y2026 = parsed.filter(p => p[0].startsWith('2026'));
    if (y2026.length < 6) throw new Error(`parsed only ${y2026.length} 2026 meetings`);
    const same = JSON.stringify(y2026) === JSON.stringify(FOMC_HARDCODED);
    log(`fomc ok  fed.gov calendar parsed: ${parsed.length} meetings; 2026 ${same ? 'matches' : 'DIFFERS FROM'} hardcoded list${same ? '' : ': ' + JSON.stringify(y2026)}`);
    return { list: parsed, source: 'federalreserve.gov' };
  } catch (e) {
    log(`fomc FAIL ${e.message} → using hardcoded 2026 list`);
    return { list: FOMC_HARDCODED, source: 'hardcoded' };
  }
}
function nextFomc(list, today) {
  const next = [...list].sort((a, b) => a[1].localeCompare(b[1])).find(([, end]) => end >= today);
  return next ? next[1] : null;
}

// ───────────────────────────── previous state ─────────────────────────────

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function compactBrief(b) {
  if (!b) return null;
  const it = x => ({ headline: x.headline, storyline_id: x.storyline_id ?? null, region: x.region });
  return {
    date: b.date,
    today: (b.today || []).map(it),
    economy_items: (b.economy?.items || []).map(it),
    washington: (b.washington || []).map(it),
    economy_read: b.economy?.read ?? null,
  };
}

// ───────────────────────────── prompt ─────────────────────────────

const SYSTEM_PROMPT = `You are the editor of "Brief", a two-minute morning news reader for one American reader who wants the world first, seen through a US lens. Each run you receive a dated payload (articles from the last 36 hours, yesterday's brief, the current storylines, economic data, prediction-market odds) and return one JSON object matching the provided schema.

SELECTION
- "today": 3–5 items, the most consequential stories in the world today. Lead with international events (wars, elections, diplomacy, disasters, markets abroad) and include a US domestic story only if it clearly outranks the rest. Rank by consequence, not by volume of coverage or novelty.
- Every item must have a real US angle (security, trade, prices, alliances, citizens abroad, policy). If you cannot state one honestly, pick a different story.
- "washington": 0–3 items on concrete federal action: votes, bills, executive actions, rules, court rulings, confirmations. No horse-race politics or punditry.
- "economy.items": 0–3 US-relevant economic news items. Do not repeat a story already in "today".
- Prefer stories reported by 2+ outlets. Cite 1–3 sources per item, copying outlet, title and url exactly from the article list. Never invent or alter a URL.

HARD TEXT LIMITS (the whole Today tab must read in under 60 seconds)
- headline ≤ 80 characters, plain and factual, no clickbait, no questions.
- what_happened: 1–2 short sentences. us_angle: 1–2 short sentences. whats_new: 1 sentence saying what changed since yesterday's brief, or exactly "New today."
- economy.read ≤ 60 words. indicator note ≤ 12 words. fed.note ≤ 20 words. week_ahead why_it_matters ≤ 15 words.
- storyline title ≤ 50 characters, summary ≤ 40 words, event text ≤ 25 words, storyline_updates update: 1 sentence.
- Plain prose. No markdown, no emoji, no exclamation marks.

ACCURACY
- Use only facts present in the provided articles and data. Never invent numbers, quotes, dates, names or outcomes.
- If sources conflict or a detail is unconfirmed, say so briefly (e.g. "reports conflict on casualties"); if unsure what changed, say so in whats_new.
- region is where the story happens: Europe, Middle East, Asia, Americas, Africa, US, or Global.
- item ids: use "t1".."t5", "e1".."e3", "w1".."w3" (the job rewrites them).

ECONOMY
- economy.indicators: one entry per provided indicator, in the order given. Copy value, unit and as_of verbatim. Never compute, round or restate a number differently. change: compare value with previous ("up 0.2", "down 0.1", "unch") using the two provided numbers, or "" if there is no previous. Omit nothing that was provided; add nothing that was not.
- economy.fed.next_meeting: copy the provided next FOMC decision date (or null). odds: copy the provided odds labels and probabilities verbatim (shorten a label only to fit 40 chars); [] if none were provided. Do not make up odds.
- week_ahead: 0–5 scheduled US data releases or events in the next 7 days, only if named in the articles or implied by the provided FOMC date. Otherwise [].
- economy.read: the state of the US economy this morning, grounded in the indicators and articles.

STORYLINES (continuity matters more than novelty)
- Return the FULL updated storylines list in "storylines": every previous storyline plus any new ones.
- Reuse existing ids exactly. Only create a new storyline (id "sl-" + short kebab-case slug, stable forever) for a story likely to run for weeks; tie today's items to storylines via storyline_id (or null).
- When a storyline moves today: add an event dated today (with a source url from the article list), rewrite its summary to describe where things stand now, set last_updated to today, status "active". Keep events newest-first, at most 20 (drop the oldest). Never edit or re-date past events.
- A storyline with no event in the last 14 days is "dormant". A dormant storyline becomes active again when it gets a new event.
- At most 12 active storylines; if more, mark the least recently updated dormant.
- storyline_updates: one entry per storyline that got a new event today, and only those.`;

function buildUserPayload({ today, prevBrief, prevStorylines, indicators, odds, nextMeeting, articles }) {
  const parts = [];
  parts.push(`TODAY: ${today} (America/Los_Angeles). This is the date for new storyline events and last_updated.`);
  parts.push(`\nYESTERDAY'S BRIEF (compact):\n${prevBrief ? JSON.stringify(compactBrief(prevBrief)) : 'none (first run)'}`);
  parts.push(`\nCURRENT STORYLINES:\n${JSON.stringify(prevStorylines?.storylines ?? [])}`);
  parts.push(`\nECONOMIC INDICATORS (FRED; copy values verbatim; previous = prior observation):\n${indicators.length ? JSON.stringify(indicators) : 'none fetched today — return economy.indicators as []'}`);
  parts.push(`\nNEXT FOMC DECISION DATE: ${nextMeeting ?? 'unknown — use null'}`);
  parts.push(`\nFED DECISION ODDS (Kalshi, next meeting; prob 0–1):\n${odds.length ? JSON.stringify(odds.map(o => ({ label: o.label, prob: o.prob }))) : 'none fetched today — return fed.odds as []'}`);
  parts.push(`\nARTICLES (${articles.length}, newest first; one JSON object per line):\n${articles.map(a => JSON.stringify({ outlet: a.outlet, title: a.title, url: a.url, published: a.published, summary: a.summary })).join('\n')}`);
  return parts.join('\n');
}

// ───────────────────────────── schema helpers + validator ─────────────────────────────

const API_UNSUPPORTED = new Set(['maxItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'x-maxWords', '$comment']);
function apiSchema(node) {
  if (Array.isArray(node)) return node.map(apiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (API_UNSUPPORTED.has(k)) continue;
    if (k === 'minItems' && v > 1) { out.minItems = 1; continue; }
    out[k] = k === 'properties' || k === '$defs'
      ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, apiSchema(pv)]))
      : apiSchema(v);
  }
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
// Returns { errors, warnings }. Supports: type, enum, const, required, properties, additionalProperties:false,
// items, minItems, maxItems, maxLength, minLength, minimum, maximum, anyOf, $ref (#/...), format (date, date-time, uri), x-maxWords (warning).
export function validate(value, schema, root = schema, at = '$', acc = { errors: [], warnings: [] }) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root);
    if (!target) { acc.errors.push(`${at}: unresolved $ref ${schema.$ref}`); return acc; }
    return validate(value, target, root, at, acc);
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some(s => validate(value, s, root, at, { errors: [], warnings: [] }).errors.length === 0);
    if (!ok) acc.errors.push(`${at}: matches none of anyOf`);
    else for (const s of schema.anyOf) { const r = validate(value, s, root, at, { errors: [], warnings: [] }); if (!r.errors.length) { acc.warnings.push(...r.warnings); break; } }
    return acc;
  }
  const t = typeOf(value);
  if (schema.type) {
    const types = [].concat(schema.type);
    const match = types.includes(t) || (t === 'integer' && types.includes('number'));
    if (!match) { acc.errors.push(`${at}: expected ${types.join('|')}, got ${t}`); return acc; }
  }
  if (schema.enum && !schema.enum.includes(value)) acc.errors.push(`${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  if ('const' in schema && value !== schema.const) acc.errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (t === 'string') {
    if (schema.maxLength != null && [...value].length > schema.maxLength) acc.errors.push(`${at}: length ${[...value].length} > maxLength ${schema.maxLength}`);
    if (schema.minLength != null && [...value].length < schema.minLength) acc.errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    if (schema.format === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)))) acc.errors.push(`${at}: not a date (YYYY-MM-DD): ${JSON.stringify(value)}`);
    if (schema.format === 'date-time' && isNaN(Date.parse(value))) acc.errors.push(`${at}: not a date-time`);
    if (schema.format === 'uri' && !/^https?:\/\/[^\s]+$/.test(value)) acc.errors.push(`${at}: not an http(s) URL: ${JSON.stringify(value)}`);
    if (schema['x-maxWords'] != null) {
      const words = value.trim().split(/\s+/).filter(Boolean).length;
      if (words > schema['x-maxWords']) acc.warnings.push(`${at}: ${words} words > budget ${schema['x-maxWords']}`);
    }
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum != null && value < schema.minimum) acc.errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) acc.errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.maxItems != null && value.length > schema.maxItems) acc.errors.push(`${at}: ${value.length} items > maxItems ${schema.maxItems}`);
    if (schema.minItems != null && value.length < schema.minItems) acc.errors.push(`${at}: ${value.length} items < minItems ${schema.minItems}`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, root, `${at}[${i}]`, acc));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) acc.errors.push(`${at}: missing required "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(v, props[k], root, `${at}.${k}`, acc);
      else if (schema.additionalProperties === false) acc.errors.push(`${at}: unknown key "${k}"`);
    }
  }
  return acc;
}

// Schemas for the files on disk, derived from the model-output schema.
function briefFileSchema() {
  const props = { ...SCHEMA.properties };
  delete props.storylines;
  return {
    type: 'object', additionalProperties: false,
    required: ['version', 'generated_at', 'date', 'model', ...SCHEMA.required.filter(k => k !== 'storylines')],
    properties: {
      version: { type: 'integer', const: 1 },
      generated_at: { type: 'string', format: 'date-time' },
      date: { type: 'string', format: 'date' },
      model: { type: 'string', maxLength: 80 },
      ...props,
    },
    $defs: SCHEMA.$defs,
  };
}
function storylinesFileSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['version', 'updated_at', 'storylines'],
    properties: {
      version: { type: 'integer', const: 1 },
      updated_at: { type: 'string', format: 'date-time' },
      storylines: SCHEMA.properties.storylines,
    },
  };
}
// Cross-field checks that JSON Schema can't express.
function semanticErrors(brief, storylines) {
  const errs = [];
  const ids = new Set(storylines.map(s => s.id));
  if (ids.size !== storylines.length) errs.push('storylines: duplicate ids');
  const active = storylines.filter(s => s.status === 'active').length;
  if (active > MAX_ACTIVE_STORYLINES) errs.push(`storylines: ${active} active > ${MAX_ACTIVE_STORYLINES}`);
  for (const s of storylines) {
    for (let i = 1; i < s.events.length; i++) if (s.events[i - 1].date < s.events[i].date) { errs.push(`storyline ${s.id}: events not newest-first`); break; }
  }
  const items = [...(brief.today || []), ...(brief.economy?.items || []), ...(brief.washington || [])];
  const itemIds = new Set();
  for (const it of items) {
    if (itemIds.has(it.id)) errs.push(`duplicate item id ${it.id}`);
    itemIds.add(it.id);
    if (it.storyline_id != null && !ids.has(it.storyline_id)) errs.push(`item ${it.id}: unknown storyline_id ${it.storyline_id}`);
  }
  for (const u of brief.storyline_updates || []) if (!ids.has(u.storyline_id)) errs.push(`storyline_updates: unknown storyline_id ${u.storyline_id}`);
  return errs;
}

// ───────────────────────────── normalize model output ─────────────────────────────

// Deterministic, non-creative fixes the job owns: stable item ids, carry forward storylines the
// model dropped, events newest-first ≤20, dormancy after 14 days, ≤12 active. Never invents content.
function normalize(out, today, prevStorylines) {
  const renumber = (arr, p) => (arr || []).forEach((it, i) => { it.id = `${today}-${p}${i + 1}`; });
  renumber(out.today, 't'); renumber(out.economy?.items, 'e'); renumber(out.washington, 'w');
  const list = Array.isArray(out.storylines) ? out.storylines : [];
  const ids = new Set(list.map(s => s?.id));
  for (const prev of prevStorylines?.storylines ?? []) {
    if (!ids.has(prev.id)) { warn(`model dropped storyline ${prev.id}; carrying it forward unchanged`); list.push(structuredClone(prev)); ids.add(prev.id); }
  }
  for (const s of list) {
    if (!s || !Array.isArray(s.events)) continue;
    s.events.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    s.events = s.events.slice(0, 20);
    const lastEvent = s.events[0]?.date || s.last_updated;
    if (s.status === 'active' && lastEvent && daysBetween(lastEvent, today) > DORMANT_AFTER_DAYS) s.status = 'dormant';
  }
  const active = list.filter(s => s?.status === 'active').sort((a, b) => String(b.last_updated).localeCompare(String(a.last_updated)));
  for (const s of active.slice(MAX_ACTIVE_STORYLINES)) { warn(`>${MAX_ACTIVE_STORYLINES} active storylines; marking ${s.id} dormant`); s.status = 'dormant'; }
  out.storylines = list;
  const allItems = [...(out.today || []), ...(out.economy?.items || []), ...(out.washington || [])];
  for (const it of allItems) if (it && it.storyline_id != null && !ids.has(it.storyline_id)) { warn(`item ${it.id} references unknown storyline ${it.storyline_id}; set to null`); it.storyline_id = null; }
  if (Array.isArray(out.storyline_updates)) out.storyline_updates = out.storyline_updates.filter(u => ids.has(u?.storyline_id));
  return out;
}

// ───────────────────────────── Claude call ─────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function callClaude(system, userContent) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 16000,
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: apiSchema(SCHEMA) } },
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (e) {
      if (attempt < 3) { const d = 2000 * 2 ** attempt; warn(`Claude network error (${e.message}); retry in ${d}ms`); await sleep(d); continue; }
      throw e;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const ra = Number(res.headers.get('retry-after'));
      const d = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt + Math.floor(Math.random() * 1000);
      warn(`Claude HTTP ${res.status}; retry ${attempt + 1}/3 in ${d}ms`);
      await sleep(d);
      continue;
    }
    throw new Error(`Claude HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
}
function logUsage(resp) {
  const u = resp.usage || {};
  const model = resp.model || MODEL;
  const price = PRICES[model] || PRICES[MODEL];
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const cost = price ? `$${((inTok * price[0] + outTok * price[1]) / 1e6).toFixed(4)}` : 'n/a (no price for model)';
  log(`claude model=${model} stop=${resp.stop_reason} input_tokens=${inTok} output_tokens=${outTok} est_cost=${cost}`);
  log('claude usage ' + JSON.stringify(u));
}

// ───────────────────────────── writes ─────────────────────────────

function writeAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
function pruneHistory(today) {
  if (!fs.existsSync(HISTORY_DIR)) return;
  const cutoff = addDays(today, -HISTORY_DAYS);
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && m[1] < cutoff) { fs.unlinkSync(path.join(HISTORY_DIR, f)); log(`history pruned ${f}`); }
  }
}

// ───────────────────────────── modes ─────────────────────────────

function runValidate() {
  let bad = 0;
  const report = (name, r) => {
    for (const w of r.warnings) warn(`${name}: ${w}`);
    if (r.errors.length) { bad++; console.error(`INVALID ${name}:\n  ` + r.errors.slice(0, 40).join('\n  ')); }
    else log(`valid ${name}`);
  };
  const brief = readJson(path.join(DATA_DIR, 'brief.json'));
  const sl = readJson(path.join(DATA_DIR, 'storylines.json'));
  if (!brief) { console.error('INVALID brief.json: missing or not JSON'); bad++; }
  else report('brief.json', validate(brief, briefFileSchema()));
  if (!sl) { console.error('INVALID storylines.json: missing or not JSON'); bad++; }
  else report('storylines.json', validate(sl, storylinesFileSchema()));
  if (brief && sl?.storylines) {
    const errs = semanticErrors(brief, sl.storylines);
    if (errs.length) { bad++; console.error('INVALID cross-file:\n  ' + errs.join('\n  ')); }
  }
  if (fs.existsSync(HISTORY_DIR)) {
    for (const f of fs.readdirSync(HISTORY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
      const h = readJson(path.join(HISTORY_DIR, f));
      if (!h) { console.error(`INVALID history/${f}: not JSON`); bad++; continue; }
      report(`history/${f}`, validate(h, briefFileSchema()));
    }
  }
  if (bad) { console.error(`${bad} file(s) failed validation`); process.exit(1); }
  log('all docs/data files valid');
}

async function main() {
  if (MODE === 'validate') return runValidate();
  const now = nowDate();
  const today = laDate(now);
  log(`brief job mode=${MODE} model=${MODEL} now=${now.toISOString()} date=${today}`);

  const fomcAndOdds = fomcSchedule().then(async fomc => {
    const nextMeeting = nextFomc(fomc.list, today);
    return { fomc, nextMeeting, odds: await gatherKalshi(nextMeeting) };
  });
  const [{ articles, status }, indicators, { fomc, nextMeeting, odds }] = await Promise.all([gatherArticles(now), gatherFred(now), fomcAndOdds]);
  log(`next FOMC decision: ${nextMeeting ?? 'none on schedule'} (${fomc.source})`);
  if (!articles.length) { console.error('no articles survived; aborting without writes'); process.exit(1); }

  // Fixture mode reads "yesterday" from job/fixtures/previous so it never depends on whatever is in docs/data.
  const prevDir = MODE === 'fixture' ? path.join(FIX_DIR, 'previous') : DATA_DIR;
  const prevBrief = readJson(path.join(prevDir, 'brief.json'));
  const prevStorylines = readJson(path.join(prevDir, 'storylines.json'));
  const payload = buildUserPayload({ today, prevBrief, prevStorylines, indicators, odds, nextMeeting, articles });

  if (MODE === 'dry-run') {
    const okFeeds = status.filter(s => s.ok).length;
    log(`\nfeeds ok ${okFeeds}/${status.length}; articles ${articles.length}; indicators ${indicators.length}; kalshi odds ${odds.length}`);
    log(`payload ${payload.length} chars (~${Math.round(payload.length / 4)} tokens), system prompt ${SYSTEM_PROMPT.length} chars`);
    log('\n──── payload that would be sent ────\n' + payload);
    return;
  }

  let resp;
  if (MODE === 'fixture') {
    const p = process.env.BRIEF_FIXTURE_RESPONSE ? path.resolve(process.env.BRIEF_FIXTURE_RESPONSE) : path.join(FIX_DIR, 'model-response.json');
    log(`fixture: canned model response ${path.relative(ROOT, p)} (payload ${payload.length} chars built, not sent)`);
    resp = { model: MODEL, stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: fs.readFileSync(p, 'utf8') }] };
  } else {
    resp = await callClaude(SYSTEM_PROMPT, payload);
  }
  logUsage(resp);
  if (resp.stop_reason !== 'end_turn') {
    const detail = resp.stop_details ? ' ' + JSON.stringify(resp.stop_details) : '';
    console.error(`model stop_reason=${resp.stop_reason}${detail}; not writing`);
    process.exit(1);
  }
  const textBlock = (resp.content || []).find(b => b.type === 'text');
  if (!textBlock) { console.error('no text block in model response; not writing'); process.exit(1); }
  let out;
  try { out = JSON.parse(textBlock.text); } catch (e) { console.error('model output is not JSON: ' + e.message); process.exit(1); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) { console.error('model output is not an object; not writing'); process.exit(1); }

  // Validate raw model output first (catches unknown keys / enum / missing fields), then normalize, then re-validate.
  const raw = validate(out, SCHEMA);
  for (const w of raw.warnings) warn('budget ' + w);
  if (raw.errors.length) { console.error('model output failed schema validation; not writing:\n  ' + raw.errors.slice(0, 40).join('\n  ')); process.exit(1); }
  out = normalize(out, today, prevStorylines);

  const generated_at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { storylines, ...rest } = out;
  const brief = { version: 1, generated_at, date: today, model: resp.model || MODEL, ...rest };
  const slFile = { version: 1, updated_at: generated_at, storylines };
  const errs = [
    ...validate(brief, briefFileSchema()).errors,
    ...validate(slFile, storylinesFileSchema()).errors,
    ...semanticErrors(brief, storylines),
  ];
  if (errs.length) { console.error('final output failed validation; not writing:\n  ' + errs.slice(0, 40).join('\n  ')); process.exit(1); }

  writeAtomic(path.join(DATA_DIR, 'brief.json'), brief);
  writeAtomic(path.join(DATA_DIR, 'storylines.json'), slFile);
  writeAtomic(path.join(HISTORY_DIR, `${today}.json`), brief);
  pruneHistory(today);
  log(`wrote docs/data/brief.json (${brief.today.length} today, ${brief.economy.items.length} econ, ${brief.washington.length} dc), storylines.json (${storylines.length}, ${storylines.filter(s => s.status === 'active').length} active), history/${today}.json`);
}

main().catch(e => { console.error('FATAL ' + (e.stack || e)); process.exit(1); });

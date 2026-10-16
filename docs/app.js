// Brief v2 — "Poster" design. Vanilla ES module, zero dependencies, no external requests.
// Ranking + taste updates come from rank.js (pure); persistence from taste.js (localStorage).
// Every data string goes through esc(); every URL through safeUrl().
//
// Debug URL params: ?card=N (1-based, start on the Nth card) · ?caughtup=1 · ?sheet=detail|settings
//                   ?tab=feed|economy|threads · ?theme=light|dark · ?seed=1 (demo votes/seen, not saved)
// Dev-only QA hash hooks (inert unless the hash starts with #qa=):
//   #qa=reader:<card id> · #qa=detail:<card id> · #qa=pill · #qa=hint (show the tap hint even if dismissed)

import { applyVote, applyDwell, markSeen, explain, orderFeed, nextDropAt } from './rank.js';
import { loadTaste, saveTaste, pruneTaste, emptyTaste, exportTaste, importTaste } from './taste.js';

const DATA = {
  feed: './data/feed.json',
  economy: './data/economy.json',
  storylines: './data/storylines.json',
  topics: './data/topics.json',
};
const TAP_WAIT = 280; // ms a single tap waits so a double-tap stays 👍 and never opens the reader
const POLL_MS = 5 * 60e3; // check for a new drop while the app is open
const HINT_KEY = 'brief.hint.read'; // "1" once the reader has been opened

const params = new URLSearchParams(location.search);
const QA = (/^#qa=(.+)$/.exec(location.hash) || [])[1] ? decodeURIComponent(location.hash.slice(4)) : '';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  return v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}
function safeUrl(u) {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u.trim())) return '';
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtW = (w) => (w > 0 ? '+' : w < 0 ? '−' : '') + Math.abs(w).toFixed(1);

function localDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function fmtDay(ymd, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const d = localDate(ymd);
  return d ? d.toLocaleDateString(undefined, opts) : '';
}
function ago(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}
// ------------------------------------------------------------------ icons (SF Symbols-ish)

const ICON = {
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fillable" d="M7.5 10.5v9.75H4.75a1 1 0 0 1-1-1V11.5a1 1 0 0 1 1-1zm0 0 3.6-6.4a1.9 1.9 0 0 1 3.5 1.3l-.8 4h5a2 2 0 0 1 2 2.35l-1.15 6.5a2.4 2.4 0 0 1-2.35 2H7.5"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="matrix(1 0 0 -1 0 24.5)"><path class="fillable" d="M7.5 10.5v9.75H4.75a1 1 0 0 1-1-1V11.5a1 1 0 0 1 1-1zm0 0 3.6-6.4a1.9 1.9 0 0 1 3.5 1.3l-.8 4h5a2 2 0 0 1 2 2.35l-1.15 6.5a2.4 2.4 0 0 1-2.35 2H7.5"/></g></svg>`,
  open: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`,
  star: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.7 5.8 6.3.7-4.7 4.3 1.3 6.3L12 16.7l-5.6 3.2 1.3-6.3L3 9.3l6.3-.7z"/></svg>`,
  check: `<svg viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r="38" fill="currentColor"/><path d="M23 39.5l10 10 20-22" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chevDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>`,
  chev: `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5l6.5 6.5L9 18.5"/></svg>`,
  read: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5c-1.8-1.3-4.3-2-7.5-2v13c3.2 0 5.7.7 7.5 2 1.8-1.3 4.3-2 7.5-2v-13c-3.2 0-5.7.7-7.5 2zM12 6.5v13"/></svg>`,
  arrowUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5.5M6 11l6-6 6 6"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11M8 7.5l4-4 4 4M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-6.5A1.5 1.5 0 0 0 18 11h-1"/></svg>`,
};

// ------------------------------------------------------------------ topic families → poster colors

const FAMILY = {
  blue: ['ai', 'robotics', 'chips', 'big-tech', 'startups-vc', 'cybersecurity'],
  green: ['economy', 'fed-rates', 'markets', 'jobs-labor', 'trade'],
  purple: ['us-politics', 'courts', 'elections', 'policy-regulation', 'crime-justice'],
  orange: ['geopolitics', 'europe', 'china', 'middle-east', 'asia', 'latin-america', 'africa'],
  red: ['war-conflict', 'defense'],
  teal: ['science', 'space'],
  pink: ['health', 'culture-sports'],
  yellow: ['energy', 'climate', 'autos-transport'],
};
const FAM_OF = {};
for (const [f, list] of Object.entries(FAMILY)) for (const t of list) FAM_OF[t] = f;
const DARK_INK = new Set(['yellow', 'silver']);
const famOf = (card) => FAM_OF[arr(card.topics)[0]] || 'silver';
const FAM_HEX = {
  blue: '#2352c6', green: '#1d7a4a', purple: '#5a3db5', orange: '#e2622a',
  red: '#b3262e', teal: '#11727f', pink: '#d24a80', yellow: '#d9a514', silver: '#8e8e93',
};

let topicLabels = {};
const topicLabel = (slug) => topicLabels[slug] || String(slug || '').replace(/-/g, ' ');

// ------------------------------------------------------------------ taste state (taste.js + rank.js)

let persist = !params.has('seed');
let state = loadTaste();
let saveTimer = 0;
function saveNow() {
  clearTimeout(saveTimer);
  if (persist) saveTaste(state);
}
function save() {
  if (!persist) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}
function setVote(card, v) {
  state = applyVote(state, card, v, Date.now());
  save();
}

// ------------------------------------------------------------------ data

let feed = null;
let economy = null;
let storylines = null;
let byId = new Map();
let order = []; // rendered sequence: card objects and {caught:true}
let seenIds = new Set(); // cards placed after the caught-up card (dimmed)
let exploreIds = new Set(); // cards rank.js put in an exploration slot
let caughtUp = { newCount: 0, nextDropHint: null };
let unseenCount = 0;
let prevOpen = null;
let NOW = Date.now();

// Every fetch has a 10 s timeout and fails soft (callers catch).
async function getJSON(url, { cache = 'no-cache' } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), 10e3) : 0;
  try {
    const res = await fetch(url, { cache, signal: ctl ? ctl.signal : undefined });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function seedDemo(cards) {
  // ?seed=1: a believable taste so voted / dimmed / hidden states show up in screenshots. Not saved.
  state = emptyTaste();
  const find = (pred) => cards.find(pred);
  const like1 = find((c) => arr(c.topics).includes('robotics') && arr(c.topics).includes('ai') && c.importance >= 4) || find((c) => arr(c.topics).includes('robotics'));
  const like2 = find((c) => arr(c.topics)[0] === 'robotics' && c !== like1);
  const hate = find((c) => arr(c.topics).includes('culture-sports'));
  const meh = find((c) => arr(c.topics)[0] === 'elections');
  for (const [c, v] of [[like1, 1], [like2, 1], [hate, -1], [meh, -1]]) if (c) state = applyVote(state, c, v, NOW);
  const t = NOW - 3600e3;
  cards
    .filter((c) => c.drop === arr(feed.drops)[0]?.id)
    .slice(-7)
    .forEach((c, i) => {
      state = markSeen(state, c, t - i * 60e3);
      state = applyDwell(state, c, 3 + i);
    });
  state.last_open = new Date(Date.parse(arr(feed.drops)[0]?.at || NOW) + 3 * 3600e3).toISOString();
}

const usable = (c) => c && c.id && c.headline;

function buildOrder() {
  const cards = arr(feed.cards).filter(usable);
  byId = new Map(cards.map((c) => [c.id, c]));
  if (params.get('seed') === '1') seedDemo(cards);
  state = pruneTaste(state, cards, NOW);
  const r = orderFeed(cards, state, NOW, { drops: arr(feed.drops) });
  seenIds = new Set(r.seen.map((c) => c.id));
  exploreIds = new Set(r.exploration);
  caughtUp = r.caughtUp;
  unseenCount = r.unseen.length;
  order = [...r.unseen, { caught: true }, ...r.seen];
}

function isNew(card) {
  if (seenIds.has(card.id)) return false;
  if (!prevOpen) return true;
  const drop = arr(feed.drops).find((d) => d.id === card.drop);
  const t = Date.parse((drop && drop.at) || card.published_at);
  return Number.isFinite(t) && t > Date.parse(prevOpen);
}

// ------------------------------------------------------------------ feed rendering

function cardHTML(c, i, hint) {
  const fam = famOf(c);
  const seen = seenIds.has(c.id);
  const imp = clamp(Math.round(num(c.importance, 3)), 1, 5);
  const v = num(state.votes[c.id]);
  const src = arr(c.sources);
  const first = src.map((s) => safeUrl(s && s.url)).find(Boolean);
  const outlets = [...new Set(src.map((s) => s && s.outlet).filter(Boolean))];
  const topics = arr(c.topics).slice(0, 1).map(topicLabel).filter((l) => String(l).toLowerCase() !== String(c.region || '').toLowerCase());
  const age = ago(c.published_at, NOW);
  const eyebrow =
    [c.region, ...topics].filter(Boolean).map(esc).join('<span class="sep">·</span>') +
    (age ? `<span class="sep">·</span><span class="age">${esc(age)}</span>` : '');
  return `
  <article class="card f-${fam}${imp === 5 ? ' imp5' : ''}${seen ? ' seen' : ''}" data-ink="${DARK_INK.has(fam) ? 'dark' : 'light'}" data-i="${i}" data-id="${esc(c.id)}" aria-label="${esc(c.headline)}">
    <div class="poster">
      <div class="head">
      <div class="eyebrow${imp === 5 ? ' stack' : ''}">${imp === 5 ? `<span class="top-badge">${ICON.star}Top story</span>` : ''}<div class="meta"><span>${eyebrow}</span>${
        isNew(c) ? '<span class="new">New</span>' : ''
      }${seen ? '<span class="sep">·</span><span class="seen-tag">Seen</span>' : ''}</div></div>
      <div class="hl"><h2 class="hl-t">${esc(c.headline)}</h2></div>
      </div>
      <div class="lower">
        <div class="body">
          ${c.summary ? `<p class="summary">${esc(c.summary)}</p>` : ''}
          ${c.why_it_matters ? `<div class="why"><b>Why it matters</b><span>${esc(c.why_it_matters)}</span></div>` : ''}
          ${outlets.length || hint ? `<div class="outlets-row">${outlets.length ? `<div class="outlets">${outlets.map(esc).join(' · ')}</div>` : ''}${hint ? `<span class="tap-hint">${ICON.read}Tap to read</span>` : ''}</div>` : ''}
        </div>
        <div class="rail">
          <button class="rb" type="button" data-act="up" aria-label="More like this" aria-pressed="${v === 1}">${ICON.up}</button>
          <button class="rb" type="button" data-act="down" aria-label="Less like this" aria-pressed="false">${ICON.down}</button>
          ${first ? `<a class="rb" data-act="open" href="${esc(first)}" target="_blank" rel="noopener noreferrer" aria-label="Open source">${ICON.open}</a>` : `<span class="rb" aria-hidden="true" style="opacity:.35">${ICON.open}</span>`}
          <button class="rb" type="button" data-act="more" aria-label="Details">${ICON.more}</button>
        </div>
      </div>
    </div>
  </article>`;
}

function caughtHTML(i) {
  const newCount = num(caughtUp.newCount);
  const nd = caughtUp.nextDropHint ? new Date(caughtUp.nextDropHint) : null;
  let ndText = '—';
  if (nd) {
    const parts = nd.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).split(/\s+/);
    ndText = esc(parts[0]) + (parts[1] ? `<small>${esc(parts.slice(1).join(' '))}</small>` : '');
  }
  const seenAfter = order.length - i - 1;
  return `
  <article class="card caught f-silver" data-ink="dark" data-i="${i}" data-caught="1" aria-label="You're caught up">
    <div class="poster">
      <div class="head">
      <div class="caught-check">${ICON.check}</div>
      <div class="hl"><h2 class="hl-t">You’re all caught up.</h2></div>
      </div>
      <div class="lower">
        <div class="body">
          <div class="caught-stats">
            <div class="stat"><b>${newCount}</b><span>new since your last visit</span></div>
            <div class="stat"><b>${ndText}</b><span>next drop lands</span></div>
          </div>
          ${seenAfter > 0 ? `<div class="caught-more">${ICON.chevDown}Keep scrolling for ${seenAfter} earlier ${seenAfter === 1 ? 'story' : 'stories'}</div>` : '<div class="caught-more">That’s everything for now.</div>'}
        </div>
      </div>
    </div>
  </article>`;
}

const feedEl = () => $('#feed');

function renderFeed() {
  const el = feedEl();
  if (!order.length || (order.length === 1 && order[0].caught)) {
    el.innerHTML = `<article class="card f-silver empty-card" data-ink="dark"><div class="poster"><div class="hl"><h2 class="hl-t">Nothing here yet.</h2></div><div class="lower"><div class="body"><p class="summary">The next drop lands soon. Pull down later.</p></div></div></div></article>`;
    return;
  }
  const hintAt = showHint() ? order.findIndex((c) => !c.caught) : -1;
  el.innerHTML = order.map((c, i) => (c.caught ? caughtHTML(i) : cardHTML(c, i, i === hintAt))).join('');
  fitAll();
  observe();
}

// Fit each headline to its box: as big as possible (poster scale), never clipped.
function fitHeadline(cardEl) {
  const head = $('.head', cardEl);
  const box = $('.hl', cardEl);
  const t = $('.hl-t', box);
  if (!head || !box || !t) return;
  const above = box.previousElementSibling;
  const W = box.clientWidth;
  const H = head.clientHeight - (above ? above.offsetHeight : 0) - parseFloat(getComputedStyle(box).marginTop || 0);
  if (!H || !W) return;
  const imp5 = cardEl.classList.contains('imp5');
  const caught = cardEl.classList.contains('caught');
  let hi = imp5 ? Math.min(72, W * 0.21) : caught ? Math.min(64, W * 0.19) : Math.min(56, W * 0.16);
  let lo = 22;
  const fits = (px) => {
    t.style.fontSize = px + 'px';
    return t.scrollHeight <= H + 0.5 && t.scrollWidth <= W + 0.5;
  };
  if (fits(hi)) return;
  for (let k = 0; k < 9; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  t.style.fontSize = Math.floor(lo * 2) / 2 + 'px';
}
function fitAll() {
  for (const c of $$('.card', feedEl())) {
    // measure without the entrance transform
    fitHeadline(c);
  }
}

// ------------------------------------------------------------------ feed behavior

let activeIdx = -1;
let activeSince = 0;
let seenTimer = 0;
let io = null;

function observe() {
  if (io) io.disconnect();
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const el = e.target;
        if (e.intersectionRatio >= 0.6) {
          el.classList.add('in');
          setActive(+el.dataset.i);
        } else if (e.intersectionRatio < 0.08) {
          el.classList.remove('in');
        }
      }
    },
    { root: feedEl(), threshold: [0, 0.08, 0.6, 1] }
  );
  $$('.card', feedEl()).forEach((c) => io.observe(c));
}

function setActive(i) {
  if (i === activeIdx) return;
  leaveActive();
  activeIdx = i;
  activeSince = performance.now();
  const el = cardAt(i);
  if (el) document.body.dataset.ink = el.dataset.ink || 'light';
  syncInk();
  updateProgress();
  const c = order[i];
  clearTimeout(seenTimer);
  if (c && !c.caught && !state.seen[c.id]) {
    seenTimer = setTimeout(() => {
      state = markSeen(state, c, Date.now());
      save();
    }, 1000);
  }
}
function leaveActive() {
  const c = order[activeIdx];
  if (!c || c.caught || !activeSince) return;
  // reading time in the reader counts as time on the card
  const secs = (performance.now() - activeSince) / 1000;
  state = applyDwell(state, c, secs); // implicit nudge is applied once per card inside rank.js
  save();
}
function cardAt(i) {
  return feedEl().querySelector(`.card[data-i="${i}"]`);
}
function isDarkTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
}
function inkFor(tab) {
  if (isDarkTheme()) return 'light';
  if (tab !== 'feed') return 'dark';
  const el = cardAt(activeIdx);
  return (el && el.dataset.ink) || 'light';
}
function syncInk() {
  document.body.dataset.ink = inkFor(document.body.dataset.tab);
}
function updateProgress() {
  const p = unseenCount ? clamp((activeIdx + 1) / unseenCount, 0, 1) : 1;
  $('#progress-fill').style.transform = `scaleY(${p})`;
}

// Chrome fades while scrolling, returns on pause or tap.
let scrollTimer = 0;
let quietUntil = 0;
let lastScrollAt = 0;
function onScroll() {
  lastScrollAt = performance.now();
  cancelPendingTap();
  if (performance.now() < quietUntil) return;
  document.body.classList.add('scrolling');
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => document.body.classList.remove('scrolling'), 700);
}
function showChrome() {
  clearTimeout(scrollTimer);
  document.body.classList.remove('scrolling');
}

function jumpTo(i) {
  const el = cardAt(i);
  if (!el) return;
  quietUntil = performance.now() + 400;
  feedEl().scrollTop = el.offsetTop;
}

function haptic() {
  try {
    if (navigator.vibrate) navigator.vibrate(10);
  } catch {}
}

// Vote on a card from the feed (cardEl) or the reader. Returns the new vote value.
function voteCard(c, v, opts = {}) {
  if (!c || c.caught) return 0;
  const cur = num(state.votes[c.id]);
  const next = opts.force ? v : cur === v ? 0 : v;
  if (next === cur) return cur;
  setVote(c, next);
  haptic();
  const cardEl = feedEl().querySelector(`.card[data-id="${CSS.escape(c.id)}"]`);
  const up = cardEl && $('[data-act="up"]', cardEl);
  if (up) {
    up.setAttribute('aria-pressed', String(next === 1));
    if (next === 1 && !opts.quiet) {
      up.classList.remove('pop');
      void up.offsetWidth;
      up.classList.add('pop');
    }
  }
  if (next === -1 && cardEl && !opts.deferDismiss) dismiss(cardEl);
  return next;
}
function vote(cardEl, v, opts = {}) {
  return voteCard(order[+cardEl.dataset.i], v, opts);
}

function dismiss(cardEl) {
  const i = +cardEl.dataset.i;
  cardEl.classList.add('gone');
  toast('Fewer stories like this');
  const after = () => {
    const els = $$('.card', feedEl());
    const pos = els.indexOf(cardEl);
    const target = els[pos + 1] || els[pos - 1];
    if (!target) return;
    const smooth = !reduced();
    feedEl().scrollTo({ top: target.offsetTop, behavior: smooth ? 'smooth' : 'auto' });
    const finish = () => {
      const keep = target;
      order.splice(i, 1);
      if (i < unseenCount) unseenCount--;
      cardEl.remove();
      $$('.card', feedEl()).forEach((el, k) => (el.dataset.i = k));
      activeIdx = -1;
      quietUntil = performance.now() + 300;
      feedEl().scrollTop = keep.offsetTop;
      setActive(+keep.dataset.i);
    };
    setTimeout(finish, smooth ? 520 : 30);
  };
  setTimeout(after, reduced() ? 0 : 280);
}

function burst(cardEl, x, y) {
  if (reduced()) return;
  const r = cardEl.getBoundingClientRect();
  const b = document.createElement('div');
  b.className = 'burst';
  b.style.left = x - r.left + 'px';
  b.style.top = y - r.top + 'px';
  let dots = '';
  for (let k = 0; k < 8; k++) dots += `<i style="--a:${k * 45}deg"></i>`;
  b.innerHTML = `<div class="b-icon">${ICON.up}</div>${dots}`;
  cardEl.appendChild(b);
  setTimeout(() => b.remove(), 1000);
}

// Tap vs double-tap. A tap = pointerdown→pointerup with < 10 px of travel, < 500 ms, and no scroll in
// flight. The first tap arms a TAP_WAIT timer that opens the reader; a second tap near the first within
// TAP_WAIT cancels the timer and counts as 👍 instead, so a double-tap never also opens the reader.
// Any scroll cancels the pending open. Rail buttons, links and chips never take part.
let lastTap = { t: 0, x: 0, y: 0 };
let down = null;
let tapTimer = 0;
function cancelPendingTap() {
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = 0;
}
function onFeedPointerDown(e) {
  down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), scrolling: performance.now() - lastScrollAt < 120 } : null;
}
function onFeedPointerUp(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const d = down;
  down = null;
  const cardEl = e.target.closest('.card');
  if (!cardEl || e.target.closest('.rb, a, button, .chip')) return;
  if (!d || d.scrolling || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || performance.now() - d.t > 500) return;
  const now = performance.now();
  const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
  if (now - lastTap.t < TAP_WAIT && near) {
    lastTap.t = 0;
    cancelPendingTap();
    if (cardEl.dataset.caught || !cardEl.dataset.id) return;
    burst(cardEl, e.clientX, e.clientY);
    vote(cardEl, 1, { force: true });
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  showChrome();
  cancelPendingTap();
  if (cardEl.dataset.caught || !cardEl.dataset.id) return;
  tapTimer = setTimeout(() => {
    tapTimer = 0;
    const c = order[+cardEl.dataset.i];
    if (c && !c.caught && cardEl.isConnected && !cardEl.classList.contains('gone')) openReader(c);
  }, TAP_WAIT);
}

function onFeedClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const cardEl = btn.closest('.card');
  const act = btn.dataset.act;
  if (act === 'up') vote(cardEl, 1);
  else if (act === 'down') vote(cardEl, -1);
  else if (act === 'more') openDetail(order[+cardEl.dataset.i]);
}

// ------------------------------------------------------------------ sheets

let sheetOpen = false;
function openSheet(html, label) {
  const sheet = $('#sheet');
  const scrim = $('#scrim');
  $('#sheet-body').innerHTML = html;
  sheet.setAttribute('aria-label', label || 'Details');
  sheet.hidden = false;
  scrim.hidden = false;
  $('#sheet-body').scrollTop = 0;   // after unhiding, or the reset is ignored
  sheet.style.transform = '';
  void sheet.offsetWidth;
  sheet.classList.add('open');
  scrim.classList.add('open');
  sheetOpen = true;
  showChrome();
}
function closeSheet() {
  if (!sheetOpen) return;
  const sheet = $('#sheet');
  const scrim = $('#scrim');
  sheet.style.transform = '';
  sheet.classList.remove('open', 'dragging');
  scrim.classList.remove('open');
  sheetOpen = false;
  setTimeout(() => {
    if (!sheetOpen) {
      $('#sheet-body').scrollTop = 0;
      sheet.hidden = true;
      scrim.hidden = true;
    }
  }, reduced() ? 0 : 420);
}

function initSheetDrag() {
  const sheet = $('#sheet');
  const body = $('#sheet-body');
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;
  sheet.addEventListener('pointerdown', (e) => {
    const onGrab = !!e.target.closest('#sheet-grab');
    if (!onGrab && (body.scrollTop > 0 || e.target.closest('a, button, input'))) return;
    startY = lastY = e.clientY;
    lastT = performance.now();
    dy = 0;
    vel = 0;
    dragging = 'maybe';
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const d = e.clientY - startY;
    if (dragging === 'maybe') {
      if (d > 6) {
        dragging = true;
        sheet.classList.add('dragging');
      } else if (d < -6) {
        dragging = false;
        return;
      } else return;
    }
    dy = Math.max(0, d);
    const t = performance.now();
    vel = (e.clientY - lastY) / Math.max(1, t - lastT);
    lastY = e.clientY;
    lastT = t;
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (dragging !== true) {
      dragging = false;
      return;
    }
    dragging = false;
    sheet.classList.remove('dragging');
    if (dy > 110 || vel > 0.6) closeSheet();
    else sheet.style.transform = '';
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // touch: stop the page under the sheet from rubber-banding while dragging
  sheet.addEventListener('touchmove', (e) => { if (dragging === true) e.preventDefault(); }, { passive: false });
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());
}

function storylineFor(c) {
  if (!c || !c.storyline_id || !storylines) return null;
  return arr(storylines.storylines).find((s) => s && s.id === c.storyline_id) || null;
}

function openDetail(c) {
  if (!c || c.caught) return;
  const fam = famOf(c);
  const src = sourcesHTML(c);
  const sl = storylineFor(c);
  const x = explain(c, state, NOW);
  const wRow = (w) => `<span class="row-val${w > 0 ? ' pos' : w < 0 ? ' neg' : ''}">${w ? fmtW(w) : '0.0'}</span>`;
  const tRows = x.topics
    .map(({ slug, weight }) => `<div class="row"><span class="row-ico" style="background:${FAM_HEX[FAM_OF[slug] || 'silver']}">${esc(topicLabel(slug).slice(0, 1))}</span><div class="row-main"><div class="row-title">${esc(topicLabel(slug))}</div><div class="row-sub">Topic</div></div>${wRow(weight)}</div>`)
    .join('');
  const eRows = x.entities
    .map(({ name, weight }) => `<div class="row"><span class="row-ico" style="background:#8e8e93">${esc(String(name).slice(0, 1))}</span><div class="row-main"><div class="row-title">${esc(name)}</div><div class="row-sub">Name in the story</div></div>${wRow(weight)}</div>`)
    .join('');
  const p = x.parts;
  const term = (label, v) => `${v < 0 ? '−' : '+'} ${label} <b>${Math.abs(v).toFixed(1)}</b>`;
  const terms = [`Importance <b>${p.importance.toFixed(0)}</b>`, term('your topic taste', p.topics)];
  if (x.entities.length) terms.push(term('names', p.entity));
  terms.push(term(`freshness (${x.age_hours}h old)`, p.freshness));
  if (p.follows) terms.push(term('follows a story you liked', p.follows));
  const v = num(state.votes[c.id]);
  const notes = [];
  if (exploreIds.has(c.id)) notes.push('Picked outside your usual topics so the feed doesn’t turn into a bubble.');
  if (seenIds.has(c.id)) notes.push('You’ve already seen this one, so it sits after the caught-up card.');
  if (v === 1) notes.push('You liked this.');
  const html = `
    <div class="f-${fam}" style="--field:var(--p-${fam})">
      <div class="sh-eyebrow"><span class="sh-dot"></span>${esc([c.region, ...arr(c.topics).map(topicLabel)].filter(Boolean).join(' · '))}</div>
    </div>
    <h2 class="sh-title">${esc(c.headline)}</h2>
    ${sl ? `<div class="sh-h">Storyline</div><div class="group"><button class="row" type="button" data-goto="threads" style="width:100%;text-align:left"><div class="row-main"><div class="row-title">${esc(sl.title)}</div>${sl.summary ? `<div class="row-sub">${esc(sl.summary)}</div>` : ''}</div>${ICON.chev}</button></div>` : ''}
    <div class="sh-h">Sources</div>
    <div class="group">${src || '<div class="row"><div class="row-main row-sub">No sources listed.</div></div>'}</div>
    <div class="sh-h">Why am I seeing this?</div>
    <div class="group">
      ${tRows}${eRows}
      <div class="score-line">${terms.join(' ')} = score <b>${x.score.toFixed(1)}</b>${notes.length ? `<br>${notes.map(esc).join(' ')}` : ''}</div>
    </div>
    <p class="note">Votes teach the feed on this phone only. Nothing leaves your device.</p>`;
  openSheet(html, 'Story details');
}

function tasteList(kind, sign) {
  const entries = Object.entries(state.weights[kind])
    .filter(([, w]) => (sign > 0 ? w > 0 : w < 0))
    .sort((a, b) => (sign > 0 ? b[1] - a[1] : a[1] - b[1]))
    .slice(0, 6);
  if (!entries.length) return '';
  return entries
    .map(([k, w]) => {
      const label = kind === 'topic' ? topicLabel(k) : k;
      const fam = kind === 'topic' ? FAM_OF[k] || 'silver' : null;
      return fam && sign > 0
        ? `<span class="chip" style="--field:${FAM_HEX[fam]}">${esc(label)}<small>${fmtW(w)}</small></span>`
        : `<span class="chip ghost">${esc(label)}<small>${fmtW(w)}</small></span>`;
    })
    .join('');
}

function openSettings() {
  const liked = tasteList('topic', 1) + tasteList('entity', 1);
  const disliked = tasteList('topic', -1) + tasteList('entity', -1);
  const nVotes = Object.keys(state.votes).length;
  const html = `
    <h2 class="sh-title" style="margin-top:2px">Your taste</h2>
    <p class="note" style="margin-top:6px">${nVotes ? `${nVotes} vote${nVotes === 1 ? '' : 's'} so far.` : 'Vote on a few cards and the feed starts to bend toward you.'} Double-tap any card to like it.</p>
    <div class="sh-h">More of</div>
    <div class="chips">${liked || '<span class="muted">Nothing yet.</span>'}</div>
    <div class="sh-h">Less of</div>
    <div class="chips">${disliked || '<span class="muted">Nothing yet.</span>'}</div>
    <div class="sh-h">Backup</div>
    <div class="btn-row">
      <button class="btn" type="button" data-set="export">Export</button>
      <button class="btn" type="button" data-set="import">Import</button>
    </div>
    <input type="file" id="import-file" accept="application/json,.json" hidden />
    <p class="note">Your taste lives only on this phone. Export saves it as a JSON file you can import later.</p>
    <div class="sh-h">Keep it safe</div>
    <div class="note-card">${ICON.share}<div>Add Gist to your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>. Safari can clear data for sites that are only opened in a tab.</div></div>
    <div class="sh-h"> </div>
    <button class="btn danger" type="button" data-set="reset">Reset taste</button>`;
  openSheet(html, 'Settings');
}

function onSheetClick(e) {
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    closeSheet();
    setTab(goto.dataset.goto);
    return;
  }
  const b = e.target.closest('[data-set]');
  if (!b) return;
  const act = b.dataset.set;
  if (act === 'export') {
    try {
      const blob = new Blob([exportTaste(state)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `brief-taste-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
      toast('Taste exported');
    } catch {
      toast('Export failed');
    }
  } else if (act === 'import') {
    $('#import-file').click();
  } else if (act === 'reset') {
    if (!confirm('Reset your taste? Votes, learned weights and seen history are cleared.')) return;
    const tab = state.tab;
    state = emptyTaste();
    state.tab = tab;
    state.last_open = new Date().toISOString();
    persist = true;
    saveNow();
    toast('Taste reset');
    restart();
    openSettings();
  }
}
function onImport(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      state = importTaste(String(r.result));
      persist = true;
      saveNow();
      toast('Taste imported');
      restart();
      openSettings();
    } catch (err) {
      toast(`Couldn’t import: ${err && err.message ? err.message : 'not a Gist taste export'}`);
    }
    e.target.value = '';
  };
  r.readAsText(f);
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ------------------------------------------------------------------ reader (tap to read)

function sourcesHTML(c) {
  return arr(c.sources)
    .map((s) => {
      const href = safeUrl(s && s.url);
      const inner = `<div class="row-main"><div class="row-title">${esc((s && s.outlet) || 'Source')}</div>${s && s.title ? `<div class="row-sub">${esc(s.title)}</div>` : ''}</div>${href ? ICON.chev : ''}`;
      return href
        ? `<a class="row" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<div class="row">${inner}</div>`;
    })
    .join('');
}

// Hint flag: its own small localStorage key, so the taste export stays exactly the contract shape.
let hintDone = false;
try {
  hintDone = localStorage.getItem(HINT_KEY) === '1';
} catch {}
function showHint() {
  return QA === 'hint' || !hintDone;
}
function markHintDone() {
  if (hintDone && QA !== 'hint') return;
  hintDone = true;
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {}
  for (const h of $$('.tap-hint', feedEl())) {
    h.classList.add('bye');
    setTimeout(() => h.remove(), 400);
  }
}

// Articles: one file per drop, fetched on first tap, kept in memory. Failures are not cached (retry next tap).
const DROP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const articleFiles = new Map(); // drop → parsed file
const articleLoads = new Map(); // drop → in-flight promise
function loadArticles(drop) {
  if (!DROP_RE.test(String(drop || ''))) return Promise.resolve(null);
  if (articleFiles.has(drop)) return Promise.resolve(articleFiles.get(drop));
  if (!articleLoads.has(drop)) {
    const p = getJSON(`./data/articles/${drop}.json`, { cache: 'default' })
      .then((j) => (j && typeof j === 'object' && j.articles && typeof j.articles === 'object' ? j : null))
      .catch(() => null)
      .then((j) => {
        articleLoads.delete(drop);
        if (j) articleFiles.set(drop, j);
        return j;
      });
    articleLoads.set(drop, p);
  }
  return articleLoads.get(drop);
}
function paragraphsFrom(file, c) {
  const a = file && file.articles && file.articles[c.id];
  const ps = a && arr(a.paragraphs).filter((p) => typeof p === 'string' && p.trim());
  return ps && ps.length ? ps : null;
}

const reader = { open: false, card: null, token: 0 };
let skipPop = false;

function articleHTML(c, ps) {
  if (ps) return ps.map((p) => `<p>${esc(p)}</p>`).join('');
  return `${c.summary ? `<p>${esc(c.summary)}</p>` : ''}<p class="r-fallback">Full story at the source.</p>`;
}
const SKELETON = `<div class="r-skel" aria-hidden="true"><i></i><i></i><i></i><i></i><i style="width:62%"></i></div><span class="sr-only">Loading the article…</span>`;

function readerVotesHTML(c) {
  const v = num(state.votes[c.id]);
  return `<button class="r-vote" type="button" data-rv="up" aria-pressed="${v === 1}">${ICON.up}<span>More like this</span></button>
    <button class="r-vote" type="button" data-rv="down" aria-pressed="false">${ICON.down}<span>Less like this</span></button>`;
}

function readerHTML(c, body) {
  const topic = arr(c.topics).slice(0, 1).map(topicLabel)[0];
  const age = ago(c.published_at, NOW);
  const eyebrow =
    [c.region, topic].filter(Boolean).map(esc).join('<span class="sep">·</span>') +
    (age ? `<span class="sep">·</span><span class="age">${esc(age)}</span>` : '');
  const sl = storylineFor(c);
  return `
    <header class="r-head">
      <div class="r-grab" aria-hidden="true"><span></span></div>
      <div class="r-eyebrow">${eyebrow}</div>
      <h1 class="r-title" id="r-title">${esc(c.headline)}</h1>
    </header>
    <div class="r-body">
      <div class="r-article" id="r-article" aria-live="polite">${body}</div>
      ${c.why_it_matters ? `<section class="r-why"><b>Why it matters</b><p>${esc(c.why_it_matters)}</p></section>` : ''}
      <div class="sh-h">Sources</div>
      <div class="group">${sourcesHTML(c) || '<div class="row"><div class="row-main row-sub">No sources listed.</div></div>'}</div>
      ${sl ? `<div class="sh-h">Storyline</div><div class="group"><button class="row" type="button" data-goto="threads" style="width:100%;text-align:left"><div class="row-main"><div class="row-title">${esc(sl.title)}</div>${sl.summary ? `<div class="row-sub">${esc(sl.summary)}</div>` : ''}</div>${ICON.chev}</button></div>` : ''}
      <div class="r-votes">${readerVotesHTML(c)}</div>
    </div>`;
}

function openReader(c) {
  if (!c || c.caught || reader.open) return;
  cancelPendingTap();
  if (sheetOpen) closeSheet();
  reader.open = true;
  reader.card = c;
  const token = ++reader.token;
  markHintDone();

  const fam = famOf(c);
  const el = $('#reader');
  const sc = $('#r-scroll');
  el.className = `reader f-${fam}`;
  el.dataset.ink = DARK_INK.has(fam) ? 'dark' : 'light';
  const want = !!c.has_article;
  const cached = articleFiles.get(c.drop);
  const body = !want ? articleHTML(c, null) : cached ? articleHTML(c, paragraphsFrom(cached, c)) : SKELETON;
  sc.innerHTML = readerHTML(c, body);
  $('#r-bar-title').textContent = c.headline;
  el.classList.remove('scrolled');
  el.style.transform = '';
  el.hidden = false;
  // Reset after unhiding: a scrollTop set on a hidden element is ignored, so the last article's position stuck.
  sc.scrollTop = 0;
  void el.offsetWidth;
  el.classList.add('open');
  document.body.classList.add('reading');
  feedEl().inert = true;
  $('#chrome').inert = true;
  showChrome();
  try {
    history.pushState({ briefReader: c.id }, '');
  } catch {}
  try {
    $('#r-close').focus({ preventScroll: true });
  } catch {}

  if (want && !cached) {
    loadArticles(c.drop).then((file) => {
      if (token !== reader.token) return;
      const art = $('#r-article');
      if (!art) return;
      art.innerHTML = articleHTML(c, paragraphsFrom(file, c));
      art.classList.add('in');
    });
  }
}

function closeReader(fromPop = false) {
  if (!reader.open) return;
  reader.open = false;
  reader.token++;
  const el = $('#reader');
  el.classList.remove('dragging', 'open');
  el.style.transform = '';
  document.body.classList.remove('reading');
  feedEl().inert = false;
  $('#chrome').inert = false;
  setTimeout(() => {
    if (!reader.open) {
      $('#r-scroll').scrollTop = 0;
      el.hidden = true;
      el.classList.remove('scrolled');
    }
  }, reduced() ? 0 : 460);
  if (!fromPop && history.state && history.state.briefReader) {
    skipPop = true;
    history.back();
  }
}

function onReaderClick(e) {
  if (e.target.closest('#r-close')) return closeReader();
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    closeReader();
    setTab(goto.dataset.goto);
    return;
  }
  const b = e.target.closest('[data-rv]');
  if (!b || !reader.card) return;
  const c = reader.card;
  if (b.dataset.rv === 'up') {
    const next = voteCard(c, 1);
    b.setAttribute('aria-pressed', String(next === 1));
    if (next === 1) {
      b.classList.remove('pop');
      void b.offsetWidth;
      b.classList.add('pop');
    }
  } else {
    voteCard(c, -1, { deferDismiss: true });
    closeReader();
    const cardEl = feedEl().querySelector(`.card[data-id="${CSS.escape(c.id)}"]`);
    if (cardEl) setTimeout(() => dismiss(cardEl), reduced() ? 0 : 380);
  }
}

function initReader() {
  const el = $('#reader');
  const sc = $('#r-scroll');
  el.addEventListener('click', onReaderClick);
  window.addEventListener('popstate', () => {
    if (skipPop) {
      skipPop = false;
      return;
    }
    if (reader.open) closeReader(true);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && reader.open && closeReader());

  // The top bar becomes a translucent material once the poster header has scrolled away.
  let ticking = false;
  sc.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const head = $('.r-head', sc);
        el.classList.toggle('scrolled', !!head && sc.scrollTop > head.offsetHeight - 60);
      });
    },
    { passive: true }
  );

  // Swipe down from the top closes (touch), only when the article is scrolled to the very top.
  let y0 = 0, dy = 0, lastY = 0, lastT = 0, vel = 0, active = false, decided = false;
  el.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || e.target.closest('.r-votes')) {
        active = false;
        return;
      }
      y0 = lastY = e.touches[0].clientY;
      lastT = performance.now();
      dy = vel = 0;
      decided = false;
      active = sc.scrollTop <= 0 || !!e.target.closest('.r-bar');
    },
    { passive: true }
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (!active) return;
      const y = e.touches[0].clientY;
      const d = y - y0;
      if (!decided) {
        if (Math.abs(d) < 6) return;
        decided = true;
        if (d < 0) {
          active = false;
          return;
        }
        el.classList.add('dragging');
      }
      e.preventDefault();
      dy = Math.max(0, d);
      const t = performance.now();
      vel = (y - lastY) / Math.max(1, t - lastT);
      lastY = y;
      lastT = t;
      el.style.transform = `translateY(${dy}px)`;
    },
    { passive: false }
  );
  const end = () => {
    if (!active || !decided) {
      active = false;
      return;
    }
    active = false;
    el.classList.remove('dragging');
    if (dy > 120 || vel > 0.5) closeReader();
    else el.style.transform = '';
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}

// ------------------------------------------------------------------ "N new stories ↑" pill

let pendingFeed = null;
async function checkForDrop() {
  if (!feed || document.visibilityState !== 'visible') return;
  let next;
  try {
    next = await getJSON(DATA.feed);
  } catch {
    return;
  }
  const known = new Set(arr(feed.drops).map((d) => d && d.id));
  const fresh = arr(next && next.cards).filter((c) => usable(c) && !known.has(c.drop) && !byId.has(c.id) && state.votes[c.id] !== -1);
  if (!fresh.length) return;
  pendingFeed = next;
  showPill(fresh.length);
}
function showPill(n) {
  const b = $('#new-pill');
  b.innerHTML = `<span>${n} new ${n === 1 ? 'story' : 'stories'}</span>${ICON.arrowUp}`;
  b.hidden = false;
  void b.offsetWidth;
  b.classList.add('show');
}
function hidePill() {
  const b = $('#new-pill');
  b.classList.remove('show');
  setTimeout(() => {
    if (!b.classList.contains('show')) b.hidden = true;
  }, reduced() ? 0 : 400);
}
async function applyPending() {
  hidePill();
  if (reader.open) closeReader();
  if (pendingFeed) {
    feed = pendingFeed;
    pendingFeed = null;
  }
  leaveActive();
  NOW = Math.max(Date.now(), Date.parse(feed.updated_at) + 75 * 60e3 || 0);
  prevOpen = state.last_open;
  restart();
  state.last_open = new Date(NOW).toISOString();
  save();
  // Economy + Threads are refreshed with each drop too.
  const [ec, sl] = await Promise.allSettled([getJSON(DATA.economy), getJSON(DATA.storylines)]);
  if (ec.status === 'fulfilled') economy = ec.value;
  if (sl.status === 'fulfilled') storylines = sl.value;
  renderEconomy();
  renderThreads();
}

// ------------------------------------------------------------------ Economy + Threads

function renderEconomy() {
  const el = $('#economy');
  const e = economy;
  if (!e) {
    el.innerHTML = `<div class="page-inner"><h1 class="page-title">Economy</h1><div class="empty-box">Economy data could not load. Try again later.</div></div>`;
    return;
  }
  const out = [`<div class="page-inner"><h1 class="page-title">Economy</h1>`];
  if (e.updated_at) {
    const d = new Date(e.updated_at);
    if (!isNaN(d)) out.push(`<p class="page-sub">Updated ${esc(d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</p>`);
  }
  if (e.read) out.push(`<div class="slab f-green" style="--field:var(--p-green);--tone:var(--d-green)"><div class="slab-eyebrow">The read</div><p class="read-text">${esc(e.read)}</p></div>`);
  const inds = arr(e.indicators);
  if (inds.length) {
    out.push(`<h2 class="sec">Indicators</h2><div class="tiles">${inds.map(tile).join('')}</div>`);
  }
  if (e.fed) out.push(`<h2 class="sec">The Fed</h2>${fedCard(e.fed)}`);
  const week = arr(e.week_ahead);
  if (week.length) {
    out.push(
      `<h2 class="sec">Week ahead</h2><div class="week">${week
        .map(
          (w) => `<div class="week-row"><div class="week-date">${esc(fmtDay(w.date, { weekday: 'short' }))}<b>${esc(fmtDay(w.date, { day: 'numeric' }))}</b></div><div><div class="week-event">${esc(w.event)}</div>${w.why_it_matters ? `<div class="week-why">${esc(w.why_it_matters)}</div>` : ''}</div></div>`
        )
        .join('')}</div>`
    );
  }
  out.push('</div>');
  el.innerHTML = out.join('');
}

function tile(t) {
  const value = String(t.value ?? '—');
  const ch = String(t.change || '');
  const dir = /^down/i.test(ch) ? 'down' : /^up/i.test(ch) ? 'up' : '';
  const chTxt = ch.replace(/^down\s*/i, '↓ ').replace(/^up\s*/i, '↑ ').replace(/^unch$/i, 'No change');
  const wide = value.length > 6;
  return `<div class="tile${wide ? ' wide' : ''}">
    <div class="tile-label">${esc(t.label)}</div>
    <div class="tile-value${value.length > 5 && !wide ? ' long' : ''}">${esc(value)}${t.unit ? `<span class="tile-unit">${esc(t.unit)}</span>` : ''}</div>
    <div class="tile-foot"><span>${t.as_of ? esc(fmtDay(t.as_of, { month: 'short', day: 'numeric' })) : ''}</span>${ch ? `<span class="chg ${dir}">${esc(chTxt)}</span>` : ''}</div>
  </div>`;
}

function fedCard(f) {
  const odds = arr(f.odds)
    .map((o) => ({ label: o.label, p: clamp(num(o.prob), 0, 1) }))
    .sort((a, b) => b.p - a.p);
  const bars = odds.length
    ? `<ul class="odds">${odds
        .map((o) => {
          const pct = Math.round(o.p * 100);
          return `<li><div class="odd-top"><span>${esc(o.label)}</span><b>${pct}%</b></div><div class="bar" role="img" aria-label="${esc(o.label)} ${pct} percent"><div class="bar-fill" data-p="${o.p}"></div></div></li>`;
        })
        .join('')}</ul>`
    : `<p class="fed-note">Market odds unavailable.</p>`;
  return `<div class="fed"><div class="fed-when">Next meeting</div><div class="fed-date">${f.next_meeting ? esc(fmtDay(f.next_meeting, { month: 'short', day: 'numeric' })) : 'TBD'}</div>${bars}${f.note ? `<p class="fed-note">${esc(f.note)}</p>` : ''}</div>`;
}

const THREAD_FAMS = ['red', 'blue', 'purple', 'orange', 'teal', 'pink', 'green', 'yellow'];
function renderThreads() {
  const el = $('#threads');
  const list = storylines ? arr(storylines.storylines).slice() : [];
  if (!list.length) {
    el.innerHTML = `<div class="page-inner"><h1 class="page-title">Threads</h1><div class="empty-box">${storylines ? 'No threads yet.' : 'Threads could not load. Try again later.'}</div></div>`;
    return;
  }
  list.sort((a, b) => (a.status === 'dormant') - (b.status === 'dormant') || String(b.last_updated || '').localeCompare(String(a.last_updated || '')));
  const linked = new Map();
  for (const c of arr(feed && feed.cards)) if (c.storyline_id) linked.set(c.storyline_id, (linked.get(c.storyline_id) || 0) + 1);
  const html = list
    .map((sl, k) => {
      const fam = THREAD_FAMS[k % THREAD_FAMS.length];
      const n = linked.get(sl.id) || 0;
      const events = arr(sl.events)
        .slice(0, 6)
        .map((ev) => {
          const href = safeUrl(ev.url);
          const text = href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(ev.text)}</a>` : esc(ev.text);
          return `<li><div class="tl-date">${esc(fmtDay(ev.date, { month: 'short', day: 'numeric' }))}</div><div class="tl-text">${text}</div></li>`;
        })
        .join('');
      return `<section class="slab thread${sl.status === 'dormant' ? ' dormant' : ''}" data-ink="${DARK_INK.has(fam) ? 'dark' : 'light'}" style="--field:var(--p-${fam});--tone:var(--d-${fam});--ink:${DARK_INK.has(fam) ? '#111114' : '#fff'}">
        <div class="thread-meta"><span class="pill">${sl.status === 'dormant' ? 'Dormant' : 'Active'}</span><span>Moved ${esc(fmtDay(sl.last_updated, { month: 'short', day: 'numeric' }))}</span>${n ? `<span>· ${n} in feed</span>` : ''}</div>
        <h2 class="thread-title">${esc(sl.title)}</h2>
        ${sl.summary ? `<p class="thread-summary">${esc(sl.summary)}</p>` : ''}
        ${events ? `<ol class="tl">${events}</ol>` : ''}
      </section>`;
    })
    .join('');
  el.innerHTML = `<div class="page-inner"><h1 class="page-title">Threads</h1><p class="page-sub">Stories that keep moving.</p><div class="threads">${html}</div></div>`;
}

// ------------------------------------------------------------------ tabs

const TABS = ['feed', 'economy', 'threads'];
const TAB_LABEL = { feed: 'Feed', economy: 'Economy', threads: 'Threads' };
const stripEl = () => $('#strip');

function setPagerPos(p) {
  $('#tabs').style.setProperty('--pos', String(p));
}

// Sections live side by side in #strip, a native horizontal scroll-snap container: the phone's own
// scrolling does the swipe (direction lock, momentum, rubber-band). setTab commits the section state and,
// unless the strip already got there by itself, scrolls it into place.
function setTab(tab, { initial = false, scroll = true } = {}) {
  if (!TABS.includes(tab)) tab = 'feed';
  const changed = document.body.dataset.tab !== tab;
  document.body.dataset.tab = tab;
  $$('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const label = $('#pager-label');
  if (label.textContent !== TAB_LABEL[tab]) {
    label.textContent = TAB_LABEL[tab];
    if (changed && !initial && !reduced()) {
      label.classList.remove('swap');
      void label.offsetWidth;
      label.classList.add('swap');
    }
  }
  if (scroll) {
    const st = stripEl();
    const left = TABS.indexOf(tab) * st.clientWidth;
    if (Math.abs(st.scrollLeft - left) > 1) st.scrollTo({ left, behavior: initial || reduced() ? 'auto' : 'smooth' });
    setPagerPos(TABS.indexOf(tab));
  }
  showChrome();
  syncInk();
  if (tab === 'economy' && changed) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => $$('#economy .bar-fill').forEach((b) => (b.style.transform = `scaleX(${b.dataset.p})`)))
    );
  }
  if (tab === 'feed' && !initial) requestAnimationFrame(fitAll);
  if (state.tab !== tab) {
    state.tab = tab;
    save();
  }
}

// While the strip moves: the dot thumb tracks it exactly and the header colors follow whichever section
// covers more of the screen. When it settles on a section, that section becomes the current tab.
function initStrip() {
  const st = stripEl();
  let settle = 0;
  const settled = () => {
    clearTimeout(settle);
    const p = st.scrollLeft / Math.max(1, st.clientWidth);
    // Only settle once the strip rests on a section; a finger held still mid-swipe is not "settled".
    if (Math.abs(p - Math.round(p)) > 0.02) return;
    document.body.classList.remove('swiping');
    const tab = TABS[clamp(Math.round(p), 0, TABS.length - 1)];
    if (tab !== document.body.dataset.tab) setTab(tab, { scroll: false });
    setPagerPos(TABS.indexOf(tab));
  };
  st.addEventListener('scroll', () => {
    const p = clamp(st.scrollLeft / Math.max(1, st.clientWidth), 0, TABS.length - 1);
    document.body.classList.add('swiping');
    setPagerPos(p);
    document.body.dataset.ink = inkFor(TABS[Math.round(p)]);
    cancelPendingTap();
    clearTimeout(settle);
    settle = setTimeout(settled, 140); // fallback where 'scrollend' isn't supported
  }, { passive: true });
  st.addEventListener('scrollend', settled);
  // Keep the current section aligned when the viewport changes size (rotation, toolbar).
  window.addEventListener('resize', () => {
    st.scrollLeft = TABS.indexOf(document.body.dataset.tab) * st.clientWidth;
  });
  // Desktop: arrow keys switch sections.
  document.addEventListener('keydown', (e) => {
    if (reader.open || sheetOpen || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const i = TABS.indexOf(document.body.dataset.tab);
    if (e.key === 'ArrowRight' && i < TABS.length - 1) setTab(TABS[i + 1]);
    else if (e.key === 'ArrowLeft' && i > 0) setTab(TABS[i - 1]);
  });
}

// ------------------------------------------------------------------ boot

function restart() {
  activeIdx = -1;
  buildOrder();
  renderFeed();
  renderThreads();
  requestAnimationFrame(() => {
    jumpTo(0);
    setActive(0);
  });
}

async function boot() {
  initSheetDrag();
  initReader();
  initStrip();
  $('#new-pill').addEventListener('click', applyPending);
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('#gear').addEventListener('click', openSettings);
  $('#sheet-body').addEventListener('click', onSheetClick);
  $('#sheet-body').addEventListener('change', (e) => e.target.id === 'import-file' && onImport(e));
  const f = feedEl();
  f.addEventListener('scroll', onScroll, { passive: true });
  f.addEventListener('pointerdown', onFeedPointerDown);
  f.addEventListener('pointerup', onFeedPointerUp);
  f.addEventListener('pointercancel', () => (down = null));
  f.addEventListener('click', onFeedClick);
  $('#chrome').addEventListener('pointerdown', showChrome);
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      fitAll();
      if (activeIdx >= 0) jumpTo(activeIdx);
    }, 120);
  });
  const mq = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
  if (mq && mq.addEventListener) mq.addEventListener('change', syncInk);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      leaveActive();
      activeSince = performance.now();
      saveNow();
    } else {
      checkForDrop();
    }
  });

  const [fd, ec, sl, tp] = await Promise.allSettled([getJSON(DATA.feed), getJSON(DATA.economy), getJSON(DATA.storylines), getJSON(DATA.topics)]);
  if (tp.status === 'fulfilled') for (const t of arr(tp.value)) if (t && t.slug) topicLabels[t.slug] = t.label;
  economy = ec.status === 'fulfilled' ? ec.value : null;
  storylines = sl.status === 'fulfilled' ? sl.value : null;
  if (fd.status !== 'fulfilled') {
    feedEl().innerHTML = `<article class="card f-silver empty-card" data-ink="dark"><div class="poster"><div class="hl"><h2 class="hl-t">Can’t reach the feed.</h2></div><div class="lower"><div class="body"><p class="summary">Check your connection and reopen Gist.</p></div></div></div></article>`;
    renderEconomy();
    renderThreads();
    setTab(params.get('tab') || state.tab, { initial: true });
    return;
  }
  feed = fd.value;
  // Sample data is dated in the future relative to today; keep ages sensible.
  NOW = Math.max(Date.now(), Date.parse(feed.updated_at) + 75 * 60e3 || 0);
  prevOpen = state.last_open;
  buildOrder();
  state.last_open = new Date(NOW).toISOString();
  save();

  setTab(params.get('tab') || state.tab, { initial: true });
  renderFeed();
  renderEconomy();
  renderThreads();

  // initial position
  let start = 0;
  if (params.get('caughtup') === '1') start = order.findIndex((c) => c.caught);
  else if (params.has('card')) start = clamp(parseInt(params.get('card'), 10) - 1 || 0, 0, order.length - 1);
  if (params.has('card') || params.has('caughtup')) document.documentElement.classList.remove('motion');
  jumpTo(start);
  setActive(start);
  const startEl = cardAt(start);
  if (startEl) startEl.classList.add('in');

  const sheet = params.get('sheet');
  if (sheet === 'detail') openDetail(order[start].caught ? order[0] : order[start]);
  else if (sheet === 'settings') openSettings();

  setInterval(checkForDrop, POLL_MS);
  if (QA) runQA(QA);
}

// Dev-only QA hooks for screenshots; only reachable through a #qa=… hash.
function runQA(qa) {
  document.documentElement.classList.add('qa');
  const what = qa.split(':')[0];
  const id = qa.includes(':') ? qa.slice(qa.indexOf(':') + 1) : '';
  const card = byId.get(id) || order.find((c) => !c.caught);
  const i = order.indexOf(card);
  if ((what === 'reader' || what === 'detail') && i >= 0) {
    jumpTo(i);
    setActive(i);
    const el = cardAt(i);
    if (el) el.classList.add('in');
  }
  if (what === 'reader') openReader(card);
  else if (what === 'detail') openDetail(card);
  else if (what === 'pill') showPill(12);
}

boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !params.has('nosw')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

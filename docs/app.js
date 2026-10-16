// Brief v2 — "Poster" variant. Vanilla ES module, zero dependencies, no external requests.
// Every data string goes through esc(); every URL through safeUrl().
//
// Debug URL params: ?card=N (1-based, start on the Nth card) · ?caughtup=1 · ?sheet=detail|settings
//                   ?tab=feed|economy|threads · ?theme=light|dark · ?seed=1 (demo votes/seen, not saved)

const KEY = 'brief.taste.v2';
const DATA = {
  feed: './data/feed.json',
  economy: './data/economy.json',
  storylines: './data/storylines.json',
  topics: './data/topics.json',
};
const DROP_HOURS_UTC = [1, 13, 19];

const params = new URLSearchParams(location.search);
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
function nextDrop(now) {
  const d = new Date(now);
  for (let add = 0; add < 2; add++) {
    for (const h of DROP_HOURS_UTC) {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, h, 4);
      if (t > now) return new Date(t);
    }
  }
  return null;
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

// ------------------------------------------------------------------ taste state

function blankState() {
  return { votes: {}, weights: { topic: {}, entity: {} }, seen: {}, dwell: {}, last_open: null, tab: 'feed' };
}
function normalize(s) {
  const b = blankState();
  if (!s || typeof s !== 'object') return b;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  b.votes = obj(s.votes);
  b.weights.topic = obj(s.weights && s.weights.topic);
  b.weights.entity = obj(s.weights && s.weights.entity);
  b.seen = obj(s.seen);
  b.dwell = obj(s.dwell);
  b.last_open = typeof s.last_open === 'string' ? s.last_open : null;
  b.tab = ['feed', 'economy', 'threads'].includes(s.tab) ? s.tab : 'feed';
  return b;
}
function loadState() {
  try {
    localStorage.removeItem('brief.state.v1');
  } catch {}
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return blankState();
  }
}
let persist = !params.has('seed');
let saveTimer = 0;
function save() {
  if (!persist) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  }, 150);
}

let state = loadState();

function bump(kind, key, delta) {
  const w = state.weights[kind];
  w[key] = clamp(num(w[key]) + delta, -6, 6);
  if (Math.abs(w[key]) < 1e-9) delete w[key];
}
function applyVote(card, sign) {
  for (const t of arr(card.topics)) bump('topic', t, 1.0 * sign);
  for (const e of arr(card.entities)) bump('entity', e, 0.6 * sign);
}
function setVote(card, v) {
  const prev = num(state.votes[card.id]);
  if (prev) applyVote(card, -prev);
  if (v) {
    state.votes[card.id] = v;
    applyVote(card, v);
  } else delete state.votes[card.id];
  save();
}

// ------------------------------------------------------------------ data

let feed = null;
let economy = null;
let storylines = null;
let byId = new Map();
let order = []; // rendered sequence: card objects and {caught:true}
let unseenCount = 0;
let prevOpen = null;
let NOW = Date.now();

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// Simple stand-in ranker (the real one lives in rank.js): importance + summed topic weights.
function score(card) {
  let s = num(card.importance, 3);
  for (const t of arr(card.topics)) s += num(state.weights.topic[t]);
  return s;
}

function seedDemo(cards) {
  // ?seed=1: a believable taste so voted / dimmed / hidden states show up in screenshots.
  state = blankState();
  const find = (pred) => cards.find(pred);
  const like1 = find((c) => arr(c.topics).includes('robotics') && arr(c.topics).includes('ai') && c.importance >= 4) || find((c) => arr(c.topics).includes('robotics'));
  const like2 = find((c) => arr(c.topics)[0] === 'robotics' && c !== like1);
  const hate = find((c) => arr(c.topics).includes('culture-sports'));
  const meh = find((c) => arr(c.topics)[0] === 'elections');
  if (like1) setVote(like1, 1);
  if (like2) setVote(like2, 1);
  if (hate) setVote(hate, -1);
  if (meh) setVote(meh, -1);
  const t = Math.floor(NOW / 1000) - 3600;
  cards
    .filter((c) => c.drop === arr(feed.drops)[0]?.id)
    .slice(-7)
    .forEach((c, i) => {
      state.seen[c.id] = t - i * 60;
      state.dwell[c.id] = 3 + i;
    });
  state.last_open = new Date(Date.parse(arr(feed.drops)[0]?.at || NOW) + 3 * 3600e3).toISOString();
}

function buildOrder() {
  const cards = arr(feed.cards).filter((c) => c && c.id && c.headline);
  byId = new Map(cards.map((c) => [c.id, c]));
  if (params.get('seed') === '1') seedDemo(cards);

  // prune seen/dwell for cards that left the pool; votes older than 30 days
  for (const k of ['seen', 'dwell']) for (const id of Object.keys(state[k])) if (!byId.has(id)) delete state[k][id];
  const cutoff = NOW - 30 * 864e5;
  for (const id of Object.keys(state.votes)) {
    if (byId.has(id)) continue;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(id);
    if (m && Date.parse(`${m[1]}T${m[2]}:00:00Z`) < cutoff) delete state.votes[id];
  }

  const visible = cards.filter((c) => state.votes[c.id] !== -1);
  const unseen = visible.filter((c) => !state.seen[c.id]);
  const seen = visible.filter((c) => state.seen[c.id]);
  unseen.sort((a, b) => score(b) - score(a) || Date.parse(b.published_at) - Date.parse(a.published_at));
  seen.sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0));
  unseenCount = unseen.length;
  order = [...unseen, { caught: true }, ...seen.map((c) => Object.assign(c, { _seen: true }))];
}

function isNew(card) {
  if (card._seen) return false;
  if (!prevOpen) return true;
  const drop = arr(feed.drops).find((d) => d.id === card.drop);
  const t = Date.parse((drop && drop.at) || card.published_at);
  return Number.isFinite(t) && t > Date.parse(prevOpen);
}

// ------------------------------------------------------------------ feed rendering

function cardHTML(c, i) {
  const fam = famOf(c);
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
  <article class="card f-${fam}${imp === 5 ? ' imp5' : ''}${c._seen ? ' seen' : ''}" data-ink="${DARK_INK.has(fam) ? 'dark' : 'light'}" data-i="${i}" data-id="${esc(c.id)}" aria-label="${esc(c.headline)}">
    <div class="poster">
      <div class="head">
      <div class="eyebrow${imp === 5 ? ' stack' : ''}">${imp === 5 ? `<span class="top-badge">${ICON.star}Top story</span>` : ''}<div class="meta"><span>${eyebrow}</span>${
        isNew(c) ? '<span class="new">New</span>' : ''
      }${c._seen ? '<span class="sep">·</span><span class="seen-tag">Seen</span>' : ''}</div></div>
      <div class="hl"><h2 class="hl-t">${esc(c.headline)}</h2></div>
      </div>
      <div class="lower">
        <div class="body">
          ${c.summary ? `<p class="summary">${esc(c.summary)}</p>` : ''}
          ${c.why_it_matters ? `<div class="why"><b>Why it matters</b><span>${esc(c.why_it_matters)}</span></div>` : ''}
          ${outlets.length ? `<div class="outlets">${outlets.map(esc).join(' · ')}</div>` : ''}
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
  const newCount = arr(feed.cards).filter((c) => byId.has(c.id) && state.votes[c.id] !== -1 && !state.seen[c.id] && isNew(c)).length;
  const nd = nextDrop(NOW);
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
  el.innerHTML = order.map((c, i) => (c.caught ? caughtHTML(i) : cardHTML(c, i))).join('');
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
      state.seen[c.id] = Math.floor(Date.now() / 1000);
      save();
    }, 1000);
  }
}
function leaveActive() {
  const c = order[activeIdx];
  if (!c || c.caught || !activeSince) return;
  const secs = Math.round(((performance.now() - activeSince) / 1000) * 10) / 10;
  const first = state.dwell[c.id] == null;
  state.dwell[c.id] = secs;
  if (first && persist) {
    // implicit signal, once per card
    if (secs >= 8) for (const t of arr(c.topics)) bump('topic', t, 0.25);
    else if (secs < 1.2) for (const t of arr(c.topics)) bump('topic', t, -0.1);
  }
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
function syncInk() {
  if (isDarkTheme()) document.body.dataset.ink = 'light';
  else if (document.body.dataset.tab !== 'feed') document.body.dataset.ink = 'dark';
  else {
    const el = cardAt(activeIdx);
    document.body.dataset.ink = (el && el.dataset.ink) || 'light';
  }
}
function updateProgress() {
  const p = unseenCount ? clamp((activeIdx + 1) / unseenCount, 0, 1) : 1;
  $('#progress-fill').style.transform = `scaleY(${p})`;
}

// Chrome fades while scrolling, returns on pause or tap.
let scrollTimer = 0;
let quietUntil = 0;
function onScroll() {
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

function vote(cardEl, v, opts = {}) {
  const c = order[+cardEl.dataset.i];
  if (!c || c.caught) return;
  const cur = num(state.votes[c.id]);
  const next = opts.force ? v : cur === v ? 0 : v;
  if (next === cur) return;
  setVote(c, next);
  haptic();
  const up = $('[data-act="up"]', cardEl);
  up.setAttribute('aria-pressed', String(next === 1));
  if (next === 1) {
    up.classList.remove('pop');
    void up.offsetWidth;
    up.classList.add('pop');
  }
  if (next === -1) dismiss(cardEl);
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

let lastTap = { t: 0, x: 0, y: 0 };
function onFeedPointerUp(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const cardEl = e.target.closest('.card');
  if (!cardEl || e.target.closest('.rb, a, button')) return;
  const now = performance.now();
  const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
  if (now - lastTap.t < 320 && near) {
    lastTap.t = 0;
    if (cardEl.dataset.caught) return;
    burst(cardEl, e.clientX, e.clientY);
    vote(cardEl, 1, { force: true });
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  showChrome();
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
  $('#sheet-body').scrollTop = 0;
  sheet.setAttribute('aria-label', label || 'Details');
  sheet.hidden = false;
  scrim.hidden = false;
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
  const src = arr(c.sources)
    .map((s) => {
      const href = safeUrl(s && s.url);
      const inner = `<div class="row-main"><div class="row-title">${esc(s.outlet || 'Source')}</div>${s.title ? `<div class="row-sub">${esc(s.title)}</div>` : ''}</div>${href ? ICON.chev : ''}`;
      return href
        ? `<a class="row" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<div class="row">${inner}</div>`;
    })
    .join('');
  const sl = storylineFor(c);
  const tw = state.weights.topic;
  const ew = state.weights.entity;
  const tRows = arr(c.topics)
    .map((t) => {
      const w = num(tw[t]);
      return `<div class="row"><span class="row-ico" style="background:${FAM_HEX[FAM_OF[t] || 'silver']}">${esc(topicLabel(t).slice(0, 1))}</span><div class="row-main"><div class="row-title">${esc(topicLabel(t))}</div><div class="row-sub">Topic</div></div><span class="row-val${w > 0 ? ' pos' : w < 0 ? ' neg' : ''}">${w ? fmtW(w) : '0.0'}</span></div>`;
    })
    .join('');
  const eRows = arr(c.entities)
    .map((n) => {
      const w = num(ew[n]);
      return `<div class="row"><span class="row-ico" style="background:#8e8e93">${esc(String(n).slice(0, 1))}</span><div class="row-main"><div class="row-title">${esc(n)}</div><div class="row-sub">Name in the story</div></div><span class="row-val${w > 0 ? ' pos' : w < 0 ? ' neg' : ''}">${w ? fmtW(w) : '0.0'}</span></div>`;
    })
    .join('');
  const imp = num(c.importance, 3);
  const tsum = arr(c.topics).reduce((a, t) => a + num(tw[t]), 0);
  const v = num(state.votes[c.id]);
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
      <div class="score-line">Ranked by importance <b>${imp}</b> ${tsum >= 0 ? '+' : '−'} your topic taste <b>${Math.abs(tsum).toFixed(1)}</b> = <b>${(imp + tsum).toFixed(1)}</b>${v === 1 ? ' · you liked this' : ''}</div>
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
    <div class="note-card">${ICON.share}<div>Add Brief to your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>. Safari can clear data for sites that are only opened in a tab.</div></div>
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
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
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
    state = blankState();
    state.tab = tab;
    state.last_open = new Date().toISOString();
    persist = true;
    save();
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
      const parsed = JSON.parse(String(r.result));
      if (!parsed || typeof parsed !== 'object' || !parsed.weights) throw new Error('shape');
      state = normalize(parsed);
      persist = true;
      save();
      toast('Taste imported');
      restart();
      openSettings();
    } catch {
      toast('That file is not a Brief taste export');
    }
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

function setTab(tab, { initial = false } = {}) {
  if (!['feed', 'economy', 'threads'].includes(tab)) tab = 'feed';
  document.body.dataset.tab = tab;
  for (const id of ['feed', 'economy', 'threads']) {
    const el = document.getElementById(id);
    el.hidden = id !== tab;
  }
  $$('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  showChrome();
  syncInk();
  if (tab === 'economy') {
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
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('#gear').addEventListener('click', openSettings);
  $('#sheet-body').addEventListener('click', onSheetClick);
  $('#sheet-body').addEventListener('change', (e) => e.target.id === 'import-file' && onImport(e));
  const f = feedEl();
  f.addEventListener('scroll', onScroll, { passive: true });
  f.addEventListener('pointerup', onFeedPointerUp);
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
      try {
        if (persist) localStorage.setItem(KEY, JSON.stringify(state));
      } catch {}
    }
  });

  const [fd, ec, sl, tp] = await Promise.allSettled([getJSON(DATA.feed), getJSON(DATA.economy), getJSON(DATA.storylines), getJSON(DATA.topics)]);
  if (tp.status === 'fulfilled') for (const t of arr(tp.value)) if (t && t.slug) topicLabels[t.slug] = t.label;
  economy = ec.status === 'fulfilled' ? ec.value : null;
  storylines = sl.status === 'fulfilled' ? sl.value : null;
  if (fd.status !== 'fulfilled') {
    feedEl().innerHTML = `<article class="card f-silver empty-card" data-ink="dark"><div class="poster"><div class="hl"><h2 class="hl-t">Can’t reach the feed.</h2></div><div class="lower"><div class="body"><p class="summary">Check your connection and reopen Brief.</p></div></div></div></article>`;
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
}

boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !params.has('nosw')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

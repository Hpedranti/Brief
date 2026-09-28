// Brief — a two-minute phone reader. Vanilla ES module, no dependencies.
// All data strings come from an LLM + feeds: every one goes through esc() / safeUrl().

const STATE_KEY = 'brief.state.v1';
const DATA = { brief: './data/brief.json', storylines: './data/storylines.json' };
const TABS = [
  { id: 'today', label: 'Today' },
  { id: 'economy', label: 'Economy' },
  { id: 'threads', label: 'Threads' },
  { id: 'dc', label: 'DC' },
];

const params = new URLSearchParams(location.search);
const $ = (sel) => document.querySelector(sel);

// ---------- helpers ----------

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

// "2026-09-27" -> local Date at midnight (no UTC shift)
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDay(s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const d = parseDay(s);
  return d ? d.toLocaleDateString(undefined, opts) : esc(s);
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?([AP])\.?M\.?/i, (_, a) => a.toLowerCase() + 'm');
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

// ---------- read state (localStorage, fail-soft) ----------

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    return {
      last_visit: typeof s.last_visit === 'string' ? s.last_visit : null,
      seen: s.seen && typeof s.seen === 'object' ? s.seen : {},
      tab: typeof s.tab === 'string' ? s.tab : 'today',
      date: typeof s.date === 'string' ? s.date : null, // which brief the seen map belongs to
    };
  } catch {
    return { last_visit: null, seen: {}, tab: 'today', date: null };
  }
}

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / blocked storage: the app still works, it just forgets */
  }
}

const state = loadState();
// Baseline for "new" dots is the visit BEFORE this one, frozen for the session.
const prevVisit = state.last_visit;

function markVisit() {
  state.last_visit = new Date().toISOString();
  saveState();
}

// ---------- app state ----------

let brief = null;
let storylines = null;
let storylineError = false;
let active = 'today';
const openThreads = new Set();
const openCards = new Set();

function availableTabs() {
  return TABS.filter((t) => t.id !== 'dc' || (brief && arr(brief.washington).length > 0));
}

// ---------- rendering: shared ----------

function itemCard(item, n) {
  const id = String(item.id ?? `${n}`);
  const seen = !!state.seen[id];
  const open = openCards.has(id);
  const srcId = `src-${id.replace(/[^\w-]/g, '_')}`;
  const sources = arr(item.sources)
    .map((s) => {
      const href = safeUrl(s.url);
      const inner = `<span class="outlet">${esc(s.outlet || 'Source')}</span>${
        s.title ? `<span class="src-title">${esc(s.title)}</span>` : ''
      }`;
      return href
        ? `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a></li>`
        : `<li>${inner}</li>`;
    })
    .join('');
  return `
    <article class="card glass${seen ? ' seen' : ''}${open ? ' open' : ''}" data-card="${esc(id)}">
      <div class="card-meta">
        <span class="num" aria-hidden="true">${n}</span>
        ${item.region ? `<span class="chip">${esc(item.region)}</span>` : ''}
      </div>
      <button class="card-toggle" type="button" aria-expanded="${open}" aria-controls="${srcId}">
        <span class="headline">${esc(item.headline)}</span>
      </button>
      ${item.what_happened ? `<p class="what">${esc(item.what_happened)}</p>` : ''}
      ${item.us_angle ? `<p class="angle"><span class="label label-lime">US angle</span>${esc(item.us_angle)}</p>` : ''}
      ${item.whats_new ? `<p class="new"><span class="label label-quiet">New</span>${esc(item.whats_new)}</p>` : ''}
      ${sources ? `<span class="more-hint">Tap for sources</span>` : ''}
      ${sources ? `<ul class="sources" id="${srcId}">${sources}</ul>` : ''}
    </article>`;
}

function cardList(items, emptyText) {
  const list = arr(items);
  if (!list.length) return `<div class="glass empty">${esc(emptyText)}</div>`;
  return `<div class="stack">${list.map((it, i) => itemCard(it, i + 1)).join('')}</div>`;
}

// ---------- rendering: tabs ----------

function renderToday() {
  return cardList(brief.today, 'Nothing in today’s brief.');
}

function renderDC() {
  return cardList(brief.washington, 'Nothing from Washington today.');
}

function renderEconomy() {
  const e = brief.economy || {};
  const out = [];

  if (e.read) out.push(`<div class="glass read-card"><p>${esc(e.read)}</p></div>`);

  const inds = arr(e.indicators);
  if (inds.length) {
    out.push(`<h2 class="section-title">Indicators</h2><div class="grid">${inds.map(tile).join('')}</div>`);
  }

  if (e.fed) out.push(`<h2 class="section-title">The Fed</h2>${fedCard(e.fed)}`);

  const week = arr(e.week_ahead);
  if (week.length) {
    const rows = week
      .map(
        (w) => `
        <div class="week-row">
          <div class="week-date">${esc(fmtDay(w.date, { weekday: 'short' }))}<span>${esc(
            fmtDay(w.date, { month: 'short', day: 'numeric' })
          )}</span></div>
          <div>
            <div class="week-event">${esc(w.event)}</div>
            ${w.why_it_matters ? `<div class="week-why">${esc(w.why_it_matters)}</div>` : ''}
          </div>
        </div>`
      )
      .join('');
    out.push(`<h2 class="section-title">This week</h2><div class="glass week">${rows}</div>`);
  }

  const items = arr(e.items);
  if (items.length) out.push(`<h2 class="section-title">Economy news</h2>${cardList(items, '')}`);

  if (!out.length) return `<div class="glass empty">No economy data this morning.</div>`;
  return out.join('');
}

function tile(t) {
  const value = String(t.value ?? '—');
  return `
    <div class="glass tile">
      <div class="tile-label">${esc(t.label)}</div>
      <div class="tile-value${value.length > 5 ? ' long' : ''}">${esc(value)}${
        t.unit ? `<span class="tile-unit">${esc(t.unit)}</span>` : ''
      }</div>
      <div class="tile-row">
        <span>${t.as_of ? esc(fmtDay(t.as_of, { month: 'short', day: 'numeric' })) : ''}</span>
        ${t.change ? `<span class="tile-change">${esc(t.change)}</span>` : ''}
      </div>
      ${t.note ? `<div class="tile-note">${esc(t.note)}</div>` : ''}
    </div>`;
}

function fedCard(f) {
  const odds = arr(f.odds)
    .map((o) => ({ label: o.label, p: Math.max(0, Math.min(1, Number(o.prob) || 0)) }))
    .sort((a, b) => b.p - a.p);
  const bars = odds.length
    ? `<ul class="odds">${odds
        .map((o) => {
          const pct = Math.round(o.p * 100);
          return `<li>
            <div class="odd-top"><span>${esc(o.label)}</span><b>${pct}%</b></div>
            <div class="bar" role="img" aria-label="${esc(o.label)} ${pct} percent"><div class="bar-fill" style="width:${pct}%"></div></div>
          </li>`;
        })
        .join('')}</ul>`
    : `<p class="fed-empty">Market odds unavailable this morning.</p>`;
  return `
    <div class="glass fed">
      <div class="fed-head">
        <span class="fed-title">Next meeting</span>
        <span class="fed-date">${f.next_meeting ? esc(fmtDay(f.next_meeting)) : 'TBD'}</span>
      </div>
      ${bars}
      ${f.note ? `<p class="fed-note">${esc(f.note)}</p>` : ''}
    </div>`;
}

function isNew(sl) {
  const last = String(sl.last_updated || '');
  if (!last) return false;
  if (!prevVisit) return brief ? last >= String(brief.date) : false;
  const v = new Date(prevVisit);
  return isNaN(v) ? false : last > localDay(v);
}

function renderThreads() {
  if (!storylines) {
    return `<div class="glass empty">${
      storylineError ? 'Threads could not load. Pull to refresh or try again later.' : 'No threads yet.'
    }</div>`;
  }
  const list = arr(storylines.storylines)
    .slice()
    .sort((a, b) => String(b.last_updated || '').localeCompare(String(a.last_updated || '')));
  const activeList = list.filter((s) => s.status !== 'dormant');
  const dormant = list.filter((s) => s.status === 'dormant');
  if (!list.length) return `<div class="glass empty">No threads yet.</div>`;

  let html = `<div class="stack">${activeList.map(threadRow).join('')}</div>`;
  if (dormant.length) {
    html += `<h2 class="section-title">Dormant</h2><div class="stack">${dormant.map(threadRow).join('')}</div>`;
  }
  return html;
}

function threadRow(sl) {
  const id = String(sl.id || '');
  const open = openThreads.has(id);
  const tlId = `tl-${id.replace(/[^\w-]/g, '_')}`;
  const fresh = isNew(sl);
  const events = arr(sl.events)
    .map((ev) => {
      const href = safeUrl(ev.url);
      const text = href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(ev.text)}</a>`
        : esc(ev.text);
      return `<li><div class="tl-date">${esc(fmtDay(ev.date, { month: 'short', day: 'numeric' }))}</div><div class="tl-text">${text}</div></li>`;
    })
    .join('');
  return `
    <section class="glass thread${sl.status === 'dormant' ? ' dormant' : ''}${open ? ' open' : ''}" data-thread="${esc(id)}">
      <button class="thread-toggle" type="button" aria-expanded="${open}" aria-controls="${tlId}">
        <span class="thread-title">${fresh ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(sl.title)}${
          fresh ? '<span class="sr-only"> (new)</span>' : ''
        }</span>
        ${sl.summary ? `<span class="thread-summary">${esc(sl.summary)}</span>` : ''}
        <span class="thread-moved">Last moved ${esc(fmtDay(sl.last_updated, { month: 'short', day: 'numeric' }))}</span>
      </button>
      ${events ? `<ol class="timeline" id="${tlId}">${events}</ol>` : ''}
    </section>`;
}

// ---------- chrome: header, banner, tabs ----------

function renderHeader() {
  $('#stamp-date').textContent = brief ? fmtDay(brief.date) : '';
  const t = brief && fmtTime(brief.generated_at);
  $('#stamp-updated').textContent = t ? `updated ${t}` : '';
}

function renderBanner() {
  const el = $('#banner');
  el.innerHTML = '';
  if (!brief) return;
  const d = parseDay(brief.date);
  const today = parseDay(params.get('today')) || new Date();
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (d && daysBetween(d, now) > 2) {
    el.innerHTML = `<div class="banner" role="status">Brief is from ${esc(
      fmtDay(brief.date, { weekday: 'long', month: 'short', day: 'numeric' })
    )}</div>`;
  }
}

function renderTabbar() {
  const tabs = availableTabs();
  $('#tablist').innerHTML = tabs
    .map(
      (t) =>
        `<button class="tab" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="view" aria-selected="${
          t.id === active
        }" tabindex="${t.id === active ? 0 : -1}">${t.label}</button>`
    )
    .join('');
  $('#view').setAttribute('aria-labelledby', `tab-${active}`);
}

function renderView() {
  const view = $('#view');
  if (!brief) return;
  const fn = { today: renderToday, economy: renderEconomy, threads: renderThreads, dc: renderDC }[active];
  view.innerHTML = fn();
}

function renderAll() {
  renderHeader();
  renderBanner();
  renderTabbar();
  renderView();
}

function setTab(id, { focus = false, scroll = true } = {}) {
  if (!availableTabs().some((t) => t.id === id)) id = 'today';
  active = id;
  state.tab = id;
  saveState();
  renderTabbar();
  renderView();
  if (scroll) window.scrollTo(0, 0);
  if (focus) $(`#tab-${id}`)?.focus();
}

function renderError(msg) {
  $('#view').innerHTML = `
    <div class="glass notice">
      <h2>Couldn’t load the brief</h2>
      <p>${esc(msg)}</p>
      <button class="btn" type="button" data-action="retry">Try again</button>
    </div>`;
}

// ---------- events ----------

$('#tablist').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

$('#tablist').addEventListener('keydown', (e) => {
  const ids = availableTabs().map((t) => t.id);
  const i = ids.indexOf(active);
  let next = null;
  if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
  else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
  else if (e.key === 'Home') next = ids[0];
  else if (e.key === 'End') next = ids[ids.length - 1];
  if (next) {
    e.preventDefault();
    setTab(next, { focus: true });
  }
});

$('#view').addEventListener('click', (e) => {
  if (e.target.closest('a')) return; // let links open
  if (e.target.closest('[data-action="retry"]')) {
    load();
    return;
  }
  const card = e.target.closest('[data-card]');
  if (card) {
    const id = card.dataset.card;
    const open = !openCards.has(id);
    open ? openCards.add(id) : openCards.delete(id);
    card.classList.toggle('open', open);
    card.querySelector('.card-toggle')?.setAttribute('aria-expanded', String(open));
    if (!state.seen[id]) {
      state.seen[id] = true;
      saveState();
    }
    card.classList.add('seen');
    return;
  }
  const thread = e.target.closest('[data-thread]');
  if (thread && e.target.closest('.thread-toggle')) {
    const id = thread.dataset.thread;
    const open = !openThreads.has(id);
    open ? openThreads.add(id) : openThreads.delete(id);
    thread.classList.toggle('open', open);
    thread.querySelector('.thread-toggle')?.setAttribute('aria-expanded', String(open));
  }
});

// last_visit moves on hide/unload only, so today's "new" dots survive the first open.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    markVisit();
  } else if (hiddenAt && Date.now() - hiddenAt > 60 * 60 * 1000) {
    load({ quiet: true }); // back after an hour: pick up a newer brief
  }
});
window.addEventListener('pagehide', markVisit);

// ---------- data ----------

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function load({ quiet = false } = {}) {
  if (!quiet && !brief) {
    $('#view').innerHTML =
      '<div class="skeleton" aria-label="Loading"><div class="sk-card"></div><div class="sk-card"></div><div class="sk-card"></div></div>';
  }
  const [b, s] = await Promise.allSettled([getJSON(DATA.brief), getJSON(DATA.storylines)]);

  if (b.status === 'rejected' || !b.value || typeof b.value !== 'object') {
    if (!brief) renderError('Check your connection and try again. If this keeps happening, the morning job may not have run yet.');
    return;
  }
  brief = b.value;
  if (s.status === 'fulfilled' && s.value && typeof s.value === 'object') {
    storylines = s.value;
    storylineError = false;
  } else if (!storylines) {
    storylineError = true;
  }

  // Seen map belongs to one brief date; a new brief starts fresh.
  if (state.date !== brief.date) {
    state.seen = {};
    state.date = String(brief.date || '');
    saveState();
  }

  const wanted = params.get('tab') || state.tab;
  active = availableTabs().some((t) => t.id === wanted) ? wanted : 'today';
  state.tab = active;
  saveState();
  renderAll();
}

load();

// ---------- service worker (https or localhost only) ----------

if (
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)) &&
  !params.has('nosw')
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}

// Brief v2 — client taste state in localStorage (key `brief.taste.v2`). Spec: CONTRACT.md "Client state".
// Every storage access is wrapped in try/catch; when storage is unavailable (private mode, blocked site
// data, Node) the module keeps the state in memory so the app still works for the session.
//
// Exported API
//   STORAGE_KEY, LEGACY_KEY            'brief.taste.v2', 'brief.state.v1'
//   emptyTaste()                       → a fresh default state (also what "Reset taste" should save).
//   loadTaste(storage?)                → state. Reads the key, repairs/drops malformed entries (never throws),
//                                        and deletes the legacy v1 key. Falls back to memory, then to empty.
//   saveTaste(state, storage?)         → true if written to real storage, false if only kept in memory.
//   pruneTaste(state, feed, now?)      → new state. Drops seen/dwell/implicit for cards no longer in the feed
//                                        (feed = feed.json object or its cards array); drops votes older than
//                                        30 days (cards still in the feed keep their votes). Weights untouched.
//   exportTaste(state)                 → pretty JSON string ({format:'brief.taste', version:2, exported_at, ...}).
//   importTaste(json)                  → validated state; throws Error with a readable message on garbage.
//
// Shape (contract) + documented extensions (all optional; contract-only objects are accepted as-is):
//   { votes:{id:1|-1}, weights:{topic:{slug:n}, entity:{name:n}}, seen:{id:unixSec}, dwell:{id:sec},
//     last_open: ISO|null, tab: string,
//     vote_meta:{id:{at:unixSec, t:{slug:delta}, e:{name:delta}}}   // when voted + exact deltas (exact undo, 30-day prune)
//     implicit:{id:delta} }                                         // dwell nudge already applied (once per card)
// `now` = Date | ms number | ISO string; defaults to the current time.

export const STORAGE_KEY = 'brief.taste.v2';
export const LEGACY_KEY = 'brief.state.v1';
const VOTE_TTL_S = 30 * 86400;
const W_MIN = -6, W_MAX = 6;

let memory = null; // in-memory fallback copy (JSON string)

export function emptyTaste() {
  return { votes: {}, weights: { topic: {}, entity: {} }, seen: {}, dwell: {}, last_open: null, tab: 'feed', vote_meta: {}, implicit: {} };
}

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const t = Date.parse(now);
  return Number.isFinite(t) ? t : Date.now();
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const clampW = n => Math.min(W_MAX, Math.max(W_MIN, n));

// Normalizes a raw object into a state. strict=true → throw on the first problem; false → drop bad entries.
function normalize(raw, strict) {
  const out = emptyTaste();
  const fail = msg => { if (strict) throw new Error(msg); };
  if (!isObj(raw)) { fail('taste must be a JSON object'); return out; }
  const map = (name, check, into = out[name]) => {
    const v = raw[name];
    if (v == null) return;
    if (!isObj(v)) { fail(`"${name}" must be an object`); return; }
    for (const [k, x] of Object.entries(v)) {
      if (!k || k.length > 200) { fail(`"${name}" has a bad key`); continue; }
      const c = check(x);
      if (c === undefined) { fail(`"${name}.${k}" has an invalid value`); continue; }
      into[k] = c;
    }
  };
  map('votes', x => (x === 1 || x === -1 ? x : undefined));
  map('seen', x => (finite(x) && x >= 0 ? x : undefined));
  map('dwell', x => (finite(x) && x >= 0 ? x : undefined));
  map('implicit', x => (finite(x) ? x : undefined));
  map('vote_meta', x => {
    if (!isObj(x) || !finite(x.at)) return undefined;
    const d = m => (isObj(m) ? Object.fromEntries(Object.entries(m).filter(([, n]) => finite(n))) : {});
    return { at: x.at, t: d(x.t), e: d(x.e) };
  });
  if (raw.weights != null) {
    if (!isObj(raw.weights)) fail('"weights" must be an object');
    else for (const kind of ['topic', 'entity']) {
      const v = raw.weights[kind];
      if (v == null) continue;
      if (!isObj(v)) { fail(`"weights.${kind}" must be an object`); continue; }
      for (const [k, n] of Object.entries(v)) {
        if (!finite(n) || !k) { fail(`"weights.${kind}.${k}" must be a number`); continue; }
        if (n !== 0) out.weights[kind][k] = clampW(n);
      }
    }
  }
  if (raw.last_open != null) {
    if (typeof raw.last_open === 'string' && Number.isFinite(Date.parse(raw.last_open))) out.last_open = raw.last_open;
    else fail('"last_open" must be an ISO date string');
  }
  if (raw.tab != null) {
    if (typeof raw.tab === 'string' && raw.tab.length <= 40) out.tab = raw.tab;
    else fail('"tab" must be a short string');
  }
  for (const id of Object.keys(out.vote_meta)) if (!(id in out.votes)) delete out.vote_meta[id];
  return out;
}

export function loadTaste(storage) {
  const st = getStorage(storage);
  let text = null;
  if (st) {
    try { text = st.getItem(STORAGE_KEY); } catch { text = null; }
    try { st.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  }
  if (text == null) text = memory;
  if (text == null) return emptyTaste();
  try { return normalize(JSON.parse(text), false); } catch { return emptyTaste(); }
}

export function saveTaste(state, storage) {
  let text;
  try { text = JSON.stringify(normalize(state, false)); } catch { return false; }
  memory = text;
  const st = getStorage(storage);
  if (!st) return false;
  try { st.setItem(STORAGE_KEY, text); return true; } catch { return false; }
}

export function pruneTaste(state, feed, now) {
  const s = normalize(state, false);
  const cards = Array.isArray(feed) ? feed : Array.isArray(feed?.cards) ? feed.cards : null;
  if (cards) {
    const ids = new Set(cards.map(c => c?.id).filter(Boolean));
    for (const k of ['seen', 'dwell', 'implicit']) for (const id of Object.keys(s[k])) if (!ids.has(id)) delete s[k][id];
    const nowS = Math.floor(toMs(now) / 1000);
    for (const id of Object.keys(s.votes)) {
      if (ids.has(id)) continue;
      let at = s.vote_meta[id]?.at;
      if (!finite(at)) {
        // no timestamp recorded: use the card's drop time from its id ("YYYY-MM-DDTHH-cNN")
        const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
        const t = m ? Date.parse(`${m[1]}T${m[2]}:00:00Z`) : NaN;
        at = Number.isFinite(t) ? t / 1000 : null;
      }
      if (at != null && nowS - at > VOTE_TTL_S) { delete s.votes[id]; delete s.vote_meta[id]; }
    }
  }
  return s;
}

export function exportTaste(state) {
  const s = normalize(state, false);
  return JSON.stringify({ format: 'brief.taste', version: 2, exported_at: new Date().toISOString(), ...s }, null, 2);
}

export function importTaste(json) {
  let raw;
  if (typeof json === 'string') {
    try { raw = JSON.parse(json); } catch { throw new Error('not valid JSON'); }
  } else raw = json;
  if (!isObj(raw)) throw new Error('taste must be a JSON object');
  if (raw.format != null && raw.format !== 'brief.taste') throw new Error('not a Brief taste export');
  if (raw.version != null && raw.version !== 2) throw new Error(`unsupported taste version ${raw.version}`);
  if (!('votes' in raw) && !('weights' in raw)) throw new Error('no "votes" or "weights" found');
  const { format, version, exported_at, ...rest } = raw;
  return normalize(rest, true);
}

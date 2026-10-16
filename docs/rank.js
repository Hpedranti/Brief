// Brief v2 — ranking + taste updates. PURE: no DOM, no storage, no Math.random, no clock reads
// unless you omit `now`. Importable from the browser (ES module) and from Node tests.
// Spec: CONTRACT.md "Ranking".
//
// Exported API (state = the `brief.taste.v2` object, see taste.js; `now` = Date | ms number | ISO string)
//   applyVote(state, card, value, now?)  → new state. value 1 (👍), -1 (👎) or 0 (clear). Switching or
//                                          clearing first reverses exactly what the previous vote added
//                                          (including any clamping), then applies the new vote.
//   applyDwell(state, card, seconds)     → new state. Records dwell[id] (latest visit). The implicit weight
//                                          nudge (≥ 8 s: topics +0.25, < 1.2 s: topics −0.1) is applied
//                                          once per card: the first leave decides.
//   markSeen(state, cardOrId, now?)      → new state with seen[id] = unix seconds (first time only).
//   scoreCard(card, state, now?)         → number (the contract's score formula).
//   explain(card, state, now?)           → { score, parts:{importance,topics,entity,freshness,follows},
//                                            topics:[{slug,weight}], entities:[{name,weight}],
//                                            age_hours, follows_liked, exploration }
//   orderFeed(cards, state, now?, opts?) → { unseen, caughtUp:{newCount, nextDropHint}, seen, exploration }
//                                          unseen: ranked, every 6th slot an exploration pick, adjacency
//                                          rule applied; seen: newest first; 👎 cards nowhere.
//                                          opts.drops = feed.json `drops` (for exact drop times in newCount).
//                                          exploration = ids placed in exploration slots.
//   isExplorationCandidate(card, state)  → true when every topic of the card has weight ≤ 0.
//   nextDropAt(now?)                     → ISO string of the next scheduled drop (13:00/19:00/01:00 UTC).
//   dropTime(dropId)                     → ms timestamp of a drop id "YYYY-MM-DDTHH" (or of a card id).
//   WEIGHTS                              → the constants below (frozen).
//
// State extensions (backward compatible; documented in taste.js): vote_meta[id] = {at, t, e} records when
// a vote was cast and the exact deltas it applied; implicit[id] = the dwell delta applied (0 if neutral).

export const WEIGHTS = Object.freeze({
  VOTE_TOPIC: 1.0,
  VOTE_ENTITY: 0.6,
  DWELL_LONG_S: 8,
  DWELL_LONG_TOPIC: 0.25,
  DWELL_SHORT_S: 1.2,
  DWELL_SHORT_TOPIC: -0.1,
  MIN: -6,
  MAX: 6,
  IMPORTANCE: 1.0,
  ENTITY_FACTOR: 0.5,
  AGE_PER_HOUR: 0.08,
  FOLLOWS_LIKED: 1.5,
  EXPLORE_EVERY: 6,
  ADJACENT_WITHIN: 1.0,
  DROP_HOURS_UTC: [1, 13, 19],
});

const round6 = x => Math.round(x * 1e6) / 1e6;
const clamp = x => Math.min(WEIGHTS.MAX, Math.max(WEIGHTS.MIN, x));

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const t = Date.parse(now);
  return Number.isFinite(t) ? t : Date.now();
}

const uniq = arr => [...new Set((Array.isArray(arr) ? arr : []).filter(x => typeof x === 'string' && x))];
const topicsOf = card => uniq(card?.topics);
const entitiesOf = card => uniq(card?.entities);
const primaryTopic = card => topicsOf(card)[0] ?? null;

function baseState(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    ...s,
    votes: { ...(s.votes || {}) },
    weights: { topic: { ...(s.weights?.topic || {}) }, entity: { ...(s.weights?.entity || {}) } },
    seen: { ...(s.seen || {}) },
    dwell: { ...(s.dwell || {}) },
    vote_meta: { ...(s.vote_meta || {}) },
    implicit: { ...(s.implicit || {}) },
  };
}

// Adds `delta` to map[key] with clamping; returns the delta actually applied.
function bump(map, key, delta) {
  const before = map[key] ?? 0;
  const after = round6(clamp(before + delta));
  if (after === 0) delete map[key]; else map[key] = after;
  return round6(after - before);
}

/** Drop time (ms) for a drop id "YYYY-MM-DDTHH" or a card id "YYYY-MM-DDTHH-cNN". NaN if unparsable. */
export function dropTime(id) {
  const m = typeof id === 'string' && id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
  return m ? Date.parse(`${m[1]}T${m[2]}:00:00Z`) : NaN;
}

/** ISO time of the next scheduled drop strictly after `now`. */
export function nextDropAt(now) {
  const t = toMs(now);
  const d = new Date(t);
  for (let day = 0; day < 2; day++) {
    for (const h of WEIGHTS.DROP_HOURS_UTC) {
      const c = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + day, h);
      if (c > t) return new Date(c).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }
  return null;
}

export function applyVote(state, card, value, now) {
  const id = card?.id;
  const s = baseState(state);
  if (!id) return s;
  const v = value === 1 ? 1 : value === -1 ? -1 : 0;
  const prev = s.votes[id];
  if (prev === v || (prev == null && v === 0)) return s;

  // 1) reverse the previous vote exactly
  if (prev === 1 || prev === -1) {
    const meta = s.vote_meta[id];
    if (meta && (meta.t || meta.e)) {
      for (const [k, d] of Object.entries(meta.t || {})) bump(s.weights.topic, k, -d);
      for (const [k, d] of Object.entries(meta.e || {})) bump(s.weights.entity, k, -d);
    } else {
      // vote without recorded deltas (e.g. imported contract-shaped state): reverse nominal amounts
      for (const t of topicsOf(card)) bump(s.weights.topic, t, -prev * WEIGHTS.VOTE_TOPIC);
      for (const e of entitiesOf(card)) bump(s.weights.entity, e, -prev * WEIGHTS.VOTE_ENTITY);
    }
    delete s.votes[id];
    delete s.vote_meta[id];
  }
  // 2) apply the new vote
  if (v !== 0) {
    const t = {}, e = {};
    for (const k of topicsOf(card)) t[k] = bump(s.weights.topic, k, v * WEIGHTS.VOTE_TOPIC);
    for (const k of entitiesOf(card)) e[k] = bump(s.weights.entity, k, v * WEIGHTS.VOTE_ENTITY);
    s.votes[id] = v;
    s.vote_meta[id] = { at: Math.floor(toMs(now) / 1000), t, e };
  }
  return s;
}

export function applyDwell(state, card, seconds) {
  const id = card?.id;
  const s = baseState(state);
  const sec = Number(seconds);
  if (!id || !Number.isFinite(sec) || sec < 0) return s;
  s.dwell[id] = Math.round(sec * 10) / 10;
  if (Object.hasOwn(s.implicit, id)) return s; // once per card
  const delta = sec >= WEIGHTS.DWELL_LONG_S ? WEIGHTS.DWELL_LONG_TOPIC : sec < WEIGHTS.DWELL_SHORT_S ? WEIGHTS.DWELL_SHORT_TOPIC : 0;
  for (const t of topicsOf(card)) if (delta) bump(s.weights.topic, t, delta);
  s.implicit[id] = delta;
  return s;
}

export function markSeen(state, cardOrId, now) {
  const id = typeof cardOrId === 'string' ? cardOrId : cardOrId?.id;
  const s = baseState(state);
  if (id && !s.seen[id]) s.seen[id] = Math.floor(toMs(now) / 1000);
  return s;
}

function cardTimeMs(card) {
  const p = Date.parse(card?.published_at);
  if (Number.isFinite(p)) return p;
  const d = dropTime(card?.drop ?? card?.id);
  return Number.isFinite(d) ? d : 0;
}

export function explain(card, state, now) {
  const w = state?.weights || {};
  const tw = w.topic || {}, ew = w.entity || {};
  const topics = topicsOf(card).map(slug => ({ slug, weight: tw[slug] ?? 0 }));
  const entities = entitiesOf(card).map(name => ({ name, weight: ew[name] ?? 0 }));
  const importance = WEIGHTS.IMPORTANCE * (Number(card?.importance) || 0);
  const topicPart = topics.length ? topics.reduce((a, t) => a + t.weight, 0) / topics.length : 0;
  const entityPart = entities.length ? WEIGHTS.ENTITY_FACTOR * Math.max(...entities.map(e => e.weight)) : 0;
  const ageHours = Math.max(0, (toMs(now) - cardTimeMs(card)) / 3600_000);
  const freshness = -WEIGHTS.AGE_PER_HOUR * ageHours;
  const followsLiked = !!(card?.follows && state?.votes?.[card.follows] === 1);
  const follows = followsLiked ? WEIGHTS.FOLLOWS_LIKED : 0;
  const score = round6(importance + topicPart + entityPart + freshness + follows);
  return {
    score,
    parts: { importance, topics: round6(topicPart), entity: round6(entityPart), freshness: round6(freshness), follows },
    topics, entities,
    age_hours: Math.round(ageHours * 10) / 10,
    follows_liked: followsLiked,
    exploration: isExplorationCandidate(card, state),
  };
}

export function scoreCard(card, state, now) {
  return explain(card, state, now).score;
}

export function isExplorationCandidate(card, state) {
  const tw = state?.weights?.topic || {};
  return topicsOf(card).every(t => (tw[t] ?? 0) <= 0);
}

// Deterministic comparators.
const byScore = (a, b) => b.score - a.score || (b.card.importance || 0) - (a.card.importance || 0) || b.t - a.t || cmpId(a.card.id, b.card.id);
const byImportance = (a, b) => (b.card.importance || 0) - (a.card.importance || 0) || b.score - a.score || cmpId(a.card.id, b.card.id);
const cmpId = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

export function orderFeed(cards, state, now, opts = {}) {
  const nowMs = toMs(now);
  const votes = state?.votes || {};
  const seenMap = state?.seen || {};
  const visible = (Array.isArray(cards) ? cards : []).filter(c => c && c.id && votes[c.id] !== -1);

  const unseenPool = [];
  const seen = [];
  for (const c of visible) {
    if (seenMap[c.id]) seen.push(c);
    else unseenPool.push({ card: c, score: scoreCard(c, state, nowMs), t: cardTimeMs(c), primary: primaryTopic(c) });
  }
  unseenPool.sort(byScore);

  const unseen = [];
  const exploration = [];
  let prevPrimary = null;
  const take = idx => {
    const [e] = unseenPool.splice(idx, 1);
    unseen.push(e.card);
    prevPrimary = e.primary;
    return e;
  };
  while (unseenPool.length) {
    const slot = unseen.length + 1;
    if (slot % WEIGHTS.EXPLORE_EVERY === 0) {
      const cands = unseenPool.filter(e => isExplorationCandidate(e.card, state)).sort(byImportance);
      if (cands.length) {
        const topImp = cands[0].card.importance || 0;
        const pick = cands.find(e => (e.card.importance || 0) === topImp && (e.primary == null || e.primary !== prevPrimary)) || cands[0];
        const e = take(unseenPool.indexOf(pick));
        exploration.push(e.card.id);
        continue;
      }
    }
    let idx = 0;
    const top = unseenPool[0];
    if (prevPrimary != null && top.primary === prevPrimary) {
      const alt = unseenPool.findIndex(e => e.primary !== prevPrimary && e.score >= top.score - WEIGHTS.ADJACENT_WITHIN);
      if (alt > 0) idx = alt;
    }
    take(idx);
  }

  seen.sort((a, b) => cardTimeMs(b) - cardTimeMs(a) || cmpId(b.id, a.id));

  // "You're caught up": cards (not 👎) from drops that landed after last_open.
  const dropAt = new Map();
  for (const d of Array.isArray(opts.drops) ? opts.drops : []) {
    const t = Date.parse(d?.at);
    if (d?.id && Number.isFinite(t)) dropAt.set(d.id, t);
  }
  const lastOpen = Date.parse(state?.last_open);
  const newCount = Number.isFinite(lastOpen)
    ? visible.filter(c => {
        const t = dropAt.get(c.drop) ?? dropTime(c.drop ?? c.id);
        return Number.isFinite(t) && t > lastOpen;
      }).length
    : unseen.length;

  return { unseen, caughtUp: { newCount, nextDropHint: nextDropAt(nowMs) }, seen, exploration };
}

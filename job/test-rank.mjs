// node --test job/test-rank.mjs — checks docs/rank.js, docs/taste.js and the job's pool merge.
// Built-ins only. Uses the committed sample docs/data/feed.json as a realistic fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyVote, applyDwell, markSeen, scoreCard, explain, orderFeed, isExplorationCandidate, nextDropAt, WEIGHTS } from '../docs/rank.js';
import { emptyTaste, loadTaste, saveTaste, pruneTaste, exportTaste, importTaste, STORAGE_KEY, LEGACY_KEY } from '../docs/taste.js';
import { mergePool, checkCards } from './build-brief.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'feed.json'), 'utf8'));
const CARDS = FEED.cards;
const NOW = '2026-10-16T14:00:00Z';
const byId = id => CARDS.find(c => c.id === id);
const robotCard = byId('2026-10-16T01-c02'); // robotics, startups-vc; Kestrel Robotics

function card(id, topics, extra = {}) {
  const [, drop] = id.match(/^(.*)-c\d+$/);
  return { id, drop, headline: id, topics, entities: [], importance: 3, follows: null, published_at: NOW, ...extra };
}

// ───────────── votes ─────────────

test('vote 👍 adds topic +1.0 and entity +0.6; clearing restores the exact previous weights', () => {
  const s0 = emptyTaste();
  const s1 = applyVote(s0, robotCard, 1, NOW);
  assert.equal(s1.weights.topic.robotics, 1);
  assert.equal(s1.weights.topic['startups-vc'], 1);
  assert.equal(s1.weights.entity['Kestrel Robotics'], 0.6);
  assert.equal(s1.votes[robotCard.id], 1);
  const s2 = applyVote(s1, robotCard, 0, NOW);
  assert.deepEqual(s2.weights, s0.weights);
  assert.equal(s2.votes[robotCard.id], undefined);
  assert.deepEqual(s0, emptyTaste(), 'input state is not mutated');
});

test('clearing restores non-zero prior weights exactly (no float drift)', () => {
  let s = emptyTaste();
  s.weights.topic.robotics = 0.3;
  s.weights.entity['Kestrel Robotics'] = -0.2;
  const before = structuredClone(s.weights);
  for (let i = 0; i < 25; i++) { s = applyVote(s, robotCard, 1, NOW); s = applyVote(s, robotCard, 0, NOW); }
  assert.deepEqual(s.weights, before);
});

test('flip 👍 → 👎 nets to −1.0 topic / −0.6 entity, and back to clear is exact', () => {
  let s = applyVote(emptyTaste(), robotCard, 1, NOW);
  s = applyVote(s, robotCard, -1, NOW);
  assert.equal(s.weights.topic.robotics, -1);
  assert.equal(s.weights.entity['Kestrel Robotics'], -0.6);
  assert.equal(s.votes[robotCard.id], -1);
  s = applyVote(s, robotCard, 0, NOW);
  assert.deepEqual(s.weights, { topic: {}, entity: {} });
});

test('weights clamp to [−6, +6] and clearing reverses only what was actually added', () => {
  let s = emptyTaste();
  s.weights.topic.robotics = 5.5;
  s = applyVote(s, robotCard, 1, NOW);
  assert.equal(s.weights.topic.robotics, 6);
  assert.equal(s.vote_meta[robotCard.id].t.robotics, 0.5);
  s = applyVote(s, robotCard, 0, NOW);
  assert.equal(s.weights.topic.robotics, 5.5);
  // many likes on different cards never pass +6
  let t = emptyTaste();
  for (let i = 1; i <= 20; i++) t = applyVote(t, card(`2026-10-16T13-c${i}`, ['ai']), 1, NOW);
  assert.equal(t.weights.topic.ai, WEIGHTS.MAX);
  for (let i = 1; i <= 20; i++) t = applyVote(t, card(`2026-10-16T13-c${i}`, ['ai']), -1, NOW);
  assert.equal(t.weights.topic.ai, WEIGHTS.MIN);
});

test('a vote imported without vote_meta is reversed by nominal amounts', () => {
  const s = { ...emptyTaste(), votes: { [robotCard.id]: 1 }, weights: { topic: { robotics: 2, 'startups-vc': 1 }, entity: { 'Kestrel Robotics': 0.6 } } };
  const c = applyVote(s, robotCard, 0, NOW);
  assert.deepEqual(c.weights, { topic: { robotics: 1 }, entity: {} });
});

// ───────────── dwell ─────────────

test('dwell nudges topics once per card: ≥ 8 s → +0.25, < 1.2 s → −0.1, else 0', () => {
  let s = applyDwell(emptyTaste(), robotCard, 9.3);
  assert.equal(s.weights.topic.robotics, 0.25);
  assert.equal(s.dwell[robotCard.id], 9.3);
  s = applyDwell(s, robotCard, 12);
  assert.equal(s.weights.topic.robotics, 0.25, 'second long dwell does not add again');
  assert.equal(s.dwell[robotCard.id], 12, 'dwell records the latest visit');
  const fast = applyDwell(emptyTaste(), robotCard, 0.5);
  assert.equal(fast.weights.topic.robotics, -0.1);
  const mid = applyDwell(emptyTaste(), robotCard, 4);
  assert.deepEqual(mid.weights.topic, {});
  assert.equal(applyDwell(mid, robotCard, 20).weights.topic.robotics, undefined, 'first leave decides');
  assert.equal(Object.keys(applyDwell(emptyTaste(), robotCard, 0.5).weights.entity).length, 0, 'dwell never touches entities');
});

// ───────────── scoring ─────────────

test('score = importance + mean(topic) + 0.5·max(entity) − 0.08·age + follows bonus', () => {
  const c = card('2026-10-16T13-c50', ['robotics', 'ai'], { importance: 4, entities: ['Nvidia', 'Kestrel'], published_at: '2026-10-16T09:00:00Z' });
  const s = { ...emptyTaste(), weights: { topic: { robotics: 3, ai: 1 }, entity: { Nvidia: 2, Kestrel: -1 } } };
  // 4 + (3+1)/2 + 0.5*2 − 0.08*5 = 6.6
  assert.ok(Math.abs(scoreCard(c, s, NOW) - 6.6) < 1e-9);
  const e = explain(c, s, NOW);
  assert.equal(e.age_hours, 5);
  assert.deepEqual(e.topics, [{ slug: 'robotics', weight: 3 }, { slug: 'ai', weight: 1 }]);
  assert.equal(e.parts.entity, 1);
  assert.equal(e.follows_liked, false);
});

test('unknown topics count 0; no entities → entity part 0; all-negative entities use the max', () => {
  const c = card('2026-10-16T13-c51', ['space'], { importance: 2 });
  assert.equal(scoreCard(c, emptyTaste(), NOW), 2);
  const neg = card('2026-10-16T13-c52', ['space'], { importance: 2, entities: ['A', 'B'] });
  const s = { ...emptyTaste(), weights: { topic: {}, entity: { A: -2, B: -1 } } };
  assert.equal(scoreCard(neg, s, NOW), 2 - 0.5);
});

test('freshness: an older card scores lower by 0.08 per hour', () => {
  const a = card('2026-10-16T13-c53', ['ai'], { published_at: '2026-10-16T13:00:00Z' });
  const b = { ...a, id: '2026-10-16T13-c54', published_at: '2026-10-16T03:00:00Z' };
  assert.ok(Math.abs(scoreCard(a, emptyTaste(), NOW) - scoreCard(b, emptyTaste(), NOW) - 0.8) < 1e-9);
});

test('follows bonus +1.5 only when the followed card was 👍', () => {
  const follower = byId('2026-10-16T13-c02'); // follows 2026-10-16T01-c03
  const base = scoreCard(follower, emptyTaste(), NOW);
  const liked = applyVote(emptyTaste(), { id: '2026-10-16T01-c03', topics: [], entities: [] }, 1, NOW);
  assert.ok(Math.abs(scoreCard(follower, liked, NOW) - base - 1.5) < 1e-9);
  const disliked = applyVote(emptyTaste(), { id: '2026-10-16T01-c03', topics: [], entities: [] }, -1, NOW);
  assert.equal(scoreCard(follower, disliked, NOW), base);
});

// ───────────── ordering ─────────────

test('👎 cards never appear (not in unseen, not in seen)', () => {
  let s = applyVote(emptyTaste(), robotCard, -1, NOW);
  s = markSeen(s, robotCard, NOW);
  const r = orderFeed(CARDS, s, NOW);
  const all = [...r.unseen, ...r.seen].map(c => c.id);
  assert.ok(!all.includes(robotCard.id));
  assert.equal(all.length, CARDS.length - 1);
});

test('every card appears exactly once and the order is deterministic', () => {
  const s = applyVote(emptyTaste(), robotCard, 1, NOW);
  const a = orderFeed(CARDS, s, NOW);
  const b = orderFeed(structuredClone(CARDS).reverse(), s, NOW);
  assert.deepEqual(a.unseen.map(c => c.id), b.unseen.map(c => c.id));
  assert.equal(new Set(a.unseen.map(c => c.id)).size, CARDS.length);
});

test('liking robotics moves robotics cards up', () => {
  const before = orderFeed(CARDS, emptyTaste(), NOW).unseen.map(c => c.id);
  let s = emptyTaste();
  for (const c of CARDS.filter(c => c.topics.includes('robotics')).slice(0, 2)) s = applyVote(s, c, 1, NOW);
  const after = orderFeed(CARDS, s, NOW).unseen.map(c => c.id);
  const rank = (list, id) => list.indexOf(id);
  const robotIds = CARDS.filter(c => c.topics[0] === 'robotics').map(c => c.id);
  const sum = list => robotIds.reduce((a, id) => a + rank(list, id), 0);
  assert.ok(sum(after) < sum(before), `robotics should rank higher (${sum(after)} < ${sum(before)})`);
});

test('exploration: every 6th slot is the highest-importance card whose topics are all ≤ 0', () => {
  let s = emptyTaste();
  // Strongly like everything except culture-sports and africa, so few cards qualify for exploration.
  for (const t of ['fed-rates', 'economy', 'robotics', 'ai', 'war-conflict', 'chips', 'trade', 'markets', 'space', 'china', 'big-tech', 'policy-regulation', 'us-politics', 'energy', 'jobs-labor']) s.weights.topic[t] = 2;
  const r = orderFeed(CARDS, s, NOW);
  for (let slot = 6; slot <= r.unseen.length; slot += 6) {
    const placed = r.unseen[slot - 1];
    const remaining = r.unseen.slice(slot - 1);
    const cands = remaining.filter(c => isExplorationCandidate(c, s));
    if (!cands.length) continue;
    const maxImp = Math.max(...cands.map(c => c.importance));
    assert.ok(isExplorationCandidate(placed, s), `slot ${slot} must be an exploration pick`);
    assert.equal(placed.importance, maxImp, `slot ${slot} must be the highest-importance candidate`);
    assert.ok(r.exploration.includes(placed.id));
  }
  assert.ok(r.exploration.length >= 1);
  // the exploration pick would not have been in slot 6 by score alone
  const pureTop = [...CARDS].sort((a, b) => scoreCard(b, s, NOW) - scoreCard(a, s, NOW)).slice(0, 6).map(c => c.id);
  assert.ok(!pureTop.includes(r.unseen[5].id));
});

test('adjacency: no two adjacent cards share a primary topic when an alternative is within 1.0', () => {
  const cs = [
    card('2026-10-16T13-c01', ['ai'], { importance: 5 }),
    card('2026-10-16T13-c02', ['ai'], { importance: 5 }),
    card('2026-10-16T13-c03', ['space'], { importance: 4 }), // within 1.0 → swaps in
    card('2026-10-16T13-c04', ['ai'], { importance: 4 }),
    card('2026-10-16T13-c05', ['health'], { importance: 1 }), // too far below → no swap
  ];
  const r = orderFeed(cs, emptyTaste(), NOW).unseen.map(c => c.id.slice(-3));
  assert.deepEqual(r, ['c01', 'c03', 'c02', 'c04', 'c05']);
  // on the real sample, any adjacent same-primary pair must have had no alternative within 1.0
  const s = emptyTaste();
  const ord = orderFeed(CARDS, s, NOW).unseen;
  for (let i = 1; i < ord.length; i++) {
    if (ord[i].topics[0] !== ord[i - 1].topics[0] || (i + 1) % 6 === 0) continue;
    const rest = ord.slice(i);
    const best = Math.max(...rest.map(c => scoreCard(c, s, NOW)));
    assert.ok(!rest.some(c => c.topics[0] !== ord[i - 1].topics[0] && scoreCard(c, s, NOW) >= best - 1.0), `pair at ${i}`);
  }
});

test('seen cards go after the caught-up marker, newest first; unseen excludes them', () => {
  let s = emptyTaste();
  const seenIds = ['2026-10-16T01-c01', '2026-10-16T13-c05', '2026-10-16T01-c20'];
  for (const id of seenIds) s = markSeen(s, id, NOW);
  const r = orderFeed(CARDS, s, NOW);
  assert.deepEqual(r.seen.map(c => c.id).sort(), [...seenIds].sort());
  for (let i = 1; i < r.seen.length; i++) assert.ok(Date.parse(r.seen[i - 1].published_at) >= Date.parse(r.seen[i].published_at));
  assert.ok(!r.unseen.some(c => seenIds.includes(c.id)));
});

test('caught-up counts cards from drops newer than last_open and hints the next drop', () => {
  const s = { ...emptyTaste(), last_open: '2026-10-16T05:00:00Z' };
  const r = orderFeed(CARDS, s, NOW, { drops: FEED.drops });
  assert.equal(r.caughtUp.newCount, CARDS.filter(c => c.drop === '2026-10-16T13').length);
  assert.equal(r.caughtUp.nextDropHint, '2026-10-16T19:00:00Z');
  assert.equal(nextDropAt('2026-10-16T19:30:00Z'), '2026-10-17T01:00:00Z');
  assert.equal(nextDropAt('2026-10-16T00:59:00Z'), '2026-10-16T01:00:00Z');
});

test('no reshuffle: votes change weights but a computed order is a plain array the caller keeps', () => {
  const r = orderFeed(CARDS, emptyTaste(), NOW);
  const snapshot = r.unseen.map(c => c.id);
  applyVote(emptyTaste(), r.unseen[3], -1, NOW); // pure: does not touch r
  assert.deepEqual(r.unseen.map(c => c.id), snapshot);
});

// ───────────── taste storage ─────────────

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

test('save/load round-trips, deletes the v1 key, and survives broken storage', () => {
  const st = fakeStorage({ [LEGACY_KEY]: '{"old":true}' });
  const s = applyVote(emptyTaste(), robotCard, 1, NOW);
  assert.equal(saveTaste(s, st), true);
  const back = loadTaste(st);
  assert.deepEqual(back.weights, s.weights);
  assert.equal(st._m.has(LEGACY_KEY), false);
  assert.ok(st._m.has(STORAGE_KEY));
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(saveTaste(s, broken), false);
  assert.deepEqual(loadTaste(broken).weights, s.weights, 'falls back to the in-memory copy');
  assert.deepEqual(loadTaste(fakeStorage({ [STORAGE_KEY]: '{not json' })).votes, emptyTaste().votes);
});

test('prune drops seen/dwell for cards gone from the feed and votes older than 30 days', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  let s = emptyTaste();
  s = markSeen(s, '2026-10-16T01-c01', NOW);
  s = markSeen(s, '2026-10-01T13-c04', NOW);
  s = applyDwell(s, { id: '2026-10-01T13-c04', topics: ['ai'] }, 9);
  s = applyVote(s, { id: '2026-10-01T13-c05', topics: ['ai'], entities: [] }, 1, '2026-10-01T14:00:00Z'); // 50 days old
  s = applyVote(s, { id: '2026-11-15T13-c01', topics: ['ai'], entities: [] }, 1, '2026-11-15T14:00:00Z'); // 5 days old
  s.votes['2026-09-01T01-c02'] = -1; // no vote_meta: age taken from the id
  const p = pruneTaste(s, FEED, now);
  assert.ok(p.seen['2026-10-16T01-c01']);
  assert.equal(p.seen['2026-10-01T13-c04'], undefined);
  assert.equal(p.dwell['2026-10-01T13-c04'], undefined);
  assert.equal(p.votes['2026-10-01T13-c05'], undefined);
  assert.equal(p.votes['2026-11-15T13-c01'], 1);
  assert.equal(p.votes['2026-09-01T01-c02'], undefined);
  assert.equal(p.weights.topic.ai, s.weights.topic.ai, 'weights live forever');
});

test('export → import round-trips; import rejects garbage', () => {
  const s = applyDwell(applyVote(emptyTaste(), robotCard, 1, NOW), robotCard, 10);
  const back = importTaste(exportTaste(s));
  assert.deepEqual(back.weights, s.weights);
  assert.deepEqual(back.votes, s.votes);
  // a contract-shaped object without extensions is accepted
  assert.equal(importTaste({ votes: { a: 1 }, weights: { topic: { ai: 2 } } }).weights.topic.ai, 2);
  // out-of-range weights are clamped, not rejected
  assert.equal(importTaste({ weights: { topic: { ai: 99 } } }).weights.topic.ai, 6);
  for (const bad of ['not json', '[]', '42', 'null', '{}', '{"votes":{"x":2}}', '{"votes":[]}', '{"weights":{"topic":{"ai":"high"}}}',
    '{"format":"other","votes":{}}', '{"version":3,"votes":{}}', '{"votes":{},"seen":{"x":"yesterday"}}', '{"votes":{},"last_open":"soon"}']) {
    assert.throws(() => importTaste(bad), Error, bad);
  }
});

// ───────────── job: card checks + pool merge ─────────────

test('job: pool keeps 72 h, caps at 250 by dropping whole oldest drops', () => {
  const mk = (id, at, n) => ({ drop: { id, at, model: 'm', count: n }, cards: Array.from({ length: n }, (_, i) => ({ id: `${id}-c${String(i + 1).padStart(2, '0')}`, drop: id })) });
  const ds = [mk('2026-10-12T13', '2026-10-12T13:03:00Z', 10), ...['2026-10-13T19', '2026-10-14T01', '2026-10-14T13', '2026-10-14T19', '2026-10-15T01', '2026-10-15T13'].map(id => mk(id, id + ':03:00Z', 45))];
  const prev = { drops: ds.map(d => d.drop), cards: ds.flatMap(d => d.cards) };
  const nd = mk('2026-10-15T19', '2026-10-15T19:03:00Z', 40);
  const r = mergePool(prev, nd.drop, nd.cards, Date.parse('2026-10-15T19:03:00Z'));
  assert.ok(r.rolled.includes('2026-10-12T13'), '> 72 h old');
  // 6 live drops × 45 + 40 = 310 > 250 → the two oldest live drops go (310 → 265 → 220)
  assert.deepEqual(r.rolled, ['2026-10-12T13', '2026-10-13T19', '2026-10-14T01']);
  assert.equal(r.cards.length, 220);
  assert.equal(r.drops[0].id, '2026-10-14T13');
  assert.equal(r.drops.at(-1).id, '2026-10-15T19');
  for (const d of r.drops) assert.equal(r.cards.filter(c => c.drop === d.id).length, d.count);
});

test('job: bad cards are dropped (topic, url, follows, repeat); good ones get ids', () => {
  const articles = [{ outlet: 'X', title: 'A thing happened', url: 'https://x.test/a', published: '2026-10-15T18:00:00Z', summary: '' }];
  const base = { headline: 'A thing happened today', summary: 's', why_it_matters: 'w', region: 'US', topics: ['ai'], entities: [], importance: 3, follows: null, storyline_id: null, sources: [{ outlet: 'X', title: 't', url: 'https://x.test/a?utm_source=rss' }] };
  const pool = { cards: [{ id: '2026-10-15T13-c01', headline: 'Qaldar raises oil output sharply' }] };
  const raw = [
    base,
    { ...base, topics: ['crypto'] },
    { ...base, sources: [{ outlet: 'X', title: 't', url: 'https://x.test/zzz' }] },
    { ...base, follows: '2026-10-01T01-c01' },
    { ...base, headline: 'Qaldar raises oil output sharply' },
    { ...base, headline: 'Follow-up on an earlier story', follows: '2026-10-15T13-c01', storyline_id: 'sl-unknown' },
  ];
  const { cards, dropped } = checkCards(raw, { dropId: '2026-10-15T19', articles, pool, storylineIds: new Set() });
  assert.deepEqual(cards.map(c => c.id), ['2026-10-15T19-c01', '2026-10-15T19-c02']);
  assert.equal(dropped.length, 4);
  assert.equal(cards[0].sources[0].url, 'https://x.test/a', 'canonical input URL');
  assert.equal(cards[0].published_at, '2026-10-15T18:00:00Z');
  assert.equal(cards[1].storyline_id, null);
});

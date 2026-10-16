// node --test job/test-articles.mjs — pass 2 (tap-to-read articles): readable-text extractor, article
// validation, articles-file cross-checks and rollover deletion. Built-ins only, no network, no docs/ writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractReadableText, checkParagraphs, checkArticles, articlesFileChecks, pruneArticles, mergePool,
  PAGE_TEXT_CAP, PAGE_TEXT_MIN, ARTICLE_LIMITS, countWords, isContested, pagesFor, balanceReport, readMessageStream,
} from './build-brief.mjs';

const para = (n, word = 'news') => `<p>${Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')}.</p>`;
const page = body => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
// n paragraphs whose word counts add up to `total`
const paras = (n, total) => Array.from({ length: n }, (_, i) => words(Math.floor(total / n) + (i < total % n ? 1 : 0)) + '.');

// ───────────── extractor ─────────────

test('prefers <article> over the rest of the page', () => {
  const html = page(`<div>${para(40, 'outside')}</div><article><h1>Title</h1>${para(60, 'body')}${para(60, 'more')}</article><div>${para(40, 'after')}</div>`);
  const r = extractReadableText(html);
  assert.equal(r.region, 'article');
  assert.ok(r.usable);
  assert.match(r.text, /body0/);
  assert.match(r.text, /more59/);
  assert.doesNotMatch(r.text, /outside|after/);
  assert.doesNotMatch(r.text, /Title/, 'h1 (the headline) is not kept');
});

test('picks the <article> with the most text when there are several (teaser cards)', () => {
  const html = page(`<article>${para(10, 'teaser')}</article><article>${para(80, 'story')}${para(80, 'story2')}</article><article>${para(10, 'card')}</article>`);
  const r = extractReadableText(html);
  assert.equal(r.region, 'article');
  assert.match(r.text, /story0/);
  assert.doesNotMatch(r.text, /teaser|card0/);
});

test('falls back to <main> when there is no usable <article>', () => {
  const html = page(`<div class="top">${para(30, 'chrome')}</div><main>${para(70, 'mainbody')}<h2>Sub head</h2>${para(70, 'mainmore')}</main>`);
  const r = extractReadableText(html);
  assert.equal(r.region, 'main');
  assert.match(r.text, /mainbody0[\s\S]*\nSub head\n[\s\S]*mainmore0/);
  assert.doesNotMatch(r.text, /chrome/);
});

test('falls back to body <p>/<h2>/<h3> blocks (not <li>) when there is no article or main', () => {
  const html = page(`<div>${para(80, 'p')}${para(80, 'q')}</div><ul><li>a list item that is long enough to count</li></ul>`);
  const r = extractReadableText(html);
  assert.equal(r.region, 'body');
  assert.ok(r.usable);
  assert.doesNotMatch(r.text, /list item/);
});

test('keeps <li> and <h3> inside the article', () => {
  const html = page(`<article>${para(70)}<h3>Key points here</h3><ul><li>First key point of the story</li><li>Second <b>key</b> point of it</li></ul>${para(50, 'end')}</article>`);
  const r = extractReadableText(html);
  assert.match(r.text, /\nKey points here\nFirst key point of the story\nSecond key point of it\n/);
});

test('strips script/style/nav/header/footer/aside/form/noscript/svg, comments, hidden and share/related blocks', () => {
  const html = `<!doctype html><html><head><style>p{color:red}</style>
<script>var s = "<p>SCRIPTTEXT inside a string</p>"; if (a < b) document.write('<p>WRITTEN</p>');</script></head>
<body><header><p>HEADERTEXT site header words</p></header><nav><ul><li>NAVTEXT menu item words here</li></ul></nav>
<!-- <p>COMMENTTEXT hidden in a comment</p> -->
<main><article>${para(70)}
<aside><p>ASIDETEXT pull quote words here</p></aside>
<form><p>FORMTEXT sign up for the newsletter</p></form>
<noscript><p>NOSCRIPTTEXT enable javascript please</p></noscript>
<svg><text>SVGTEXT</text></svg>
<div hidden><p>HIDDENTEXT not visible at all</p></div>
<div aria-hidden="true"><p>ARIAHIDDEN not visible either</p></div>
<div class="c-share-tools"><p>SHARETEXT share on social media</p></div>
<div class="related-links"><p>RELATEDTEXT more stories you may like</p></div>
<div role="complementary"><p>ROLETEXT complementary region words</p></div>
${para(70, 'tail')}</article></main>
<footer><p>FOOTERTEXT copyright and terms words</p></footer><script src="x.js"></script></body></html>`;
  const r = extractReadableText(html);
  assert.ok(r.usable);
  for (const junk of ['SCRIPTTEXT', 'WRITTEN', 'HEADERTEXT', 'NAVTEXT', 'COMMENTTEXT', 'ASIDETEXT', 'FORMTEXT', 'NOSCRIPTTEXT', 'SVGTEXT', 'HIDDENTEXT', 'ARIAHIDDEN', 'SHARETEXT', 'RELATEDTEXT', 'ROLETEXT', 'color:red']) {
    assert.ok(!r.text.includes(junk), `${junk} leaked into the text`);
  }
  assert.match(r.text, /tail69/);
});

test('nested same-name tags inside a skipped subtree do not end the skip early', () => {
  const html = page(`<article><aside><aside><p>INNER aside words here</p></aside><p>OUTER aside words here</p></aside>${para(130)}</article>`);
  const r = extractReadableText(html);
  assert.doesNotMatch(r.text, /INNER|OUTER/);
  assert.match(r.text, /news129/);
});

test('decodes named, decimal and hex entities and collapses whitespace', () => {
  const html = page(`<article><p>Caf&eacute; &amp; bar &mdash; &ldquo;quote&rdquo; it&#8217;s &#x2014; &lt;tag&gt; 5&nbsp;%   and\n\n   spaced\t text &unknownentity; here.</p>${para(120)}</article>`);
  const r = extractReadableText(html);
  assert.match(r.text, /^Café & bar — “quote” it’s — <tag> 5 % and spaced text &unknownentity; here\.\n/);
});

test('caps text at 6,000 chars on a block boundary', () => {
  const html = page(`<article>${Array.from({ length: 80 }, (_, i) => para(15, `b${i}x`)).join('')}</article>`);
  const r = extractReadableText(html);
  assert.ok(r.chars <= PAGE_TEXT_CAP, `chars ${r.chars}`);
  assert.ok(r.chars > PAGE_TEXT_CAP * 0.66);
  assert.ok(r.text.endsWith('.'), 'cut at the end of a block, not mid-word');
  assert.equal(r.chars, r.text.length);
});

test('one huge block is capped at a word boundary', () => {
  const html = page(`<article>${para(2000, 'longword')}</article>`);
  const r = extractReadableText(html);
  assert.ok(r.chars <= PAGE_TEXT_CAP);
  assert.match(r.text, /longword\d+$/);
});

test(`under ${PAGE_TEXT_MIN} chars is unusable (paywall teaser / JS-only page)`, () => {
  const teaser = extractReadableText(page(`<article><p>Two short teaser sentences about the story.</p><p>Subscribe to continue reading this article.</p></article>`));
  assert.equal(teaser.usable, false);
  assert.ok(teaser.chars < PAGE_TEXT_MIN);
  const jsOnly = extractReadableText(page(`<div id="root"></div><script>render("<p>${'x '.repeat(500)}</p>")</script>`));
  assert.equal(jsOnly.usable, false);
  assert.equal(jsOnly.chars, 0);
  // boundary: exactly at the threshold is usable
  const at = extractReadableText(page(`<article><p>${'a'.repeat(PAGE_TEXT_MIN - 4)} b c</p></article>`));
  assert.equal(at.chars, PAGE_TEXT_MIN);
  assert.equal(at.usable, true);
});

test('a page wrapped in one <form> (old ASP.NET) is retried with forms kept', () => {
  const r = extractReadableText(page(`<form id="aspnetForm" action="/x"><div>${para(80)}${para(80, 'two')}</div></form>`));
  assert.ok(r.usable);
  assert.match(r.text, /two79/);
});

test('survives a page truncated at the 2 MB cap (unclosed tags / unclosed script)', () => {
  const r = extractReadableText(page(`<article>${para(130)}<p>cut off mid para`).replace(/<\/body><\/html>$/, '') + '<script>var x = "<p>nope');
  assert.ok(r.usable);
  assert.match(r.text, /cut off mid para$/);
  assert.doesNotMatch(r.text, /nope/);
});

test('handles garbage input without throwing', () => {
  for (const v of ['', null, undefined, '<<<>>>', '<p', 'plain text with no tags at all']) {
    const r = extractReadableText(v);
    assert.equal(r.usable, false);
  }
});

test('the noisy fixture page yields the article body only', () => {
  const html = fs.readFileSync(new URL('./fixtures/pages/article-noise.html', import.meta.url), 'utf8');
  const r = extractReadableText(html);
  assert.equal(r.region, 'main');
  assert.ok(r.usable);
  assert.match(r.text, /^Federal Reserve Governor Ana Hale said/);
  for (const junk of ['cookies', 'Subscribe', 'Search the whole', 'Home page', 'Most popular', 'JSON-LD', 'script string', 'Commented-out', 'svg text', 'Fixture Markets Staff']) {
    assert.ok(!r.text.includes(junk), `${junk} leaked`);
  }
});

// ───────────── article validation ─────────────

test('checkParagraphs accepts 3–6 paragraphs and 180–360 words, inclusive', () => {
  const L = ARTICLE_LIMITS;
  assert.ok(checkParagraphs(paras(3, L.minWords)).ok);
  assert.ok(checkParagraphs(paras(6, L.maxWords)).ok);
  assert.ok(checkParagraphs(paras(4, 250)).ok);
  const r = checkParagraphs(['  spaced   out  ' + words(100), words(60), words(60)]);
  assert.ok(r.ok);
  assert.equal(r.paragraphs[0], 'spaced out ' + words(100), 'whitespace normalized');
});

test('checkParagraphs rejects wrong paragraph counts and word totals', () => {
  assert.match(checkParagraphs(paras(2, 250)).why, /2 paragraphs/);
  assert.match(checkParagraphs(paras(7, 250)).why, /7 paragraphs/);
  assert.match(checkParagraphs(paras(4, ARTICLE_LIMITS.minWords - 1)).why, /179 words/);
  assert.match(checkParagraphs(paras(4, ARTICLE_LIMITS.maxWords + 1)).why, /361 words/);
  assert.match(checkParagraphs([words(100), '   ', words(100)]).why, /empty paragraph/);
  assert.match(checkParagraphs('not an array').why, /not an array/);
  assert.match(checkParagraphs([words(100), 5, words(100)]).why, /not an array of strings/);
});

test('checkParagraphs rejects URLs and markdown', () => {
  const base = paras(4, 240);
  const withText = (i, s) => base.map((p, j) => (j === i ? s + ' ' + p : p));
  for (const u of ['see https://example.com/a', 'visit www.example.org today', 'at reuters.com/world/x']) {
    assert.match(checkParagraphs(withText(1, u)).why, /URL/, u);
  }
  for (const md of ['## Heading', '- bullet', '* bullet', '1. item', '> quote', 'some **bold** text', 'a [link](x) here', 'use `code`']) {
    assert.match(checkParagraphs(withText(2, md)).why, /markdown/, md);
  }
  assert.ok(checkParagraphs(withText(1, 'The 2.5 percent rate - and a hyphen - is fine, as is U.S. policy.')).ok);
});

test('checkArticles keeps valid articles with based_on from the supplied pages and rejects the rest', () => {
  const drop = '2026-10-16T13';
  const cards = [{ id: `${drop}-c01` }, { id: `${drop}-c02` }, { id: `${drop}-c03` }];
  const pagesByCard = new Map([[`${drop}-c01`, ['https://a.example/1']], [`${drop}-c02`, ['https://a.example/2', 'https://b.example/2']], [`${drop}-c03`, ['https://a.example/3']]]);
  const good = paras(4, 220);
  const raw = [
    { card_id: `${drop}-c01`, paragraphs: good },
    { card_id: `${drop}-c01`, paragraphs: good },                    // duplicate
    { card_id: `${drop}-c02`, paragraphs: good.slice(0, 2) },        // too few paragraphs
    { card_id: '2026-10-15T19-c01', paragraphs: good },              // other drop
    { card_id: `${drop}-c09`, paragraphs: good },                    // not a card of the drop
    { card_id: `${drop}-c04`, paragraphs: good },                    // card of the drop, other batch
    { paragraphs: good },                                            // no id
  ];
  const { articles, rejected } = checkArticles(raw, { cards, dropId: drop, pagesByCard, dropCardIds: new Set([...cards.map(c => c.id), `${drop}-c04`]) });
  assert.deepEqual(Object.keys(articles), [`${drop}-c01`]);
  assert.deepEqual(articles[`${drop}-c01`].based_on, ['https://a.example/1']);
  assert.deepEqual(rejected.map(r => r.why), [
    'duplicate article for card', '2 paragraphs (want 3–6)', `card_id is not in drop ${drop}`,
    `card_id is not a card of drop ${drop}`, 'card_id was not in this batch', 'missing card_id',
  ]);
  assert.deepEqual(checkArticles(null, { cards, dropId: drop, pagesByCard }), { articles: {}, rejected: [] });
});

// ───────────── articles file ↔ feed ─────────────

function sampleFeed() {
  const src = (d, n) => [{ outlet: 'X', title: 't', url: `https://x.example/${d}/${n}` }, { outlet: 'Y', title: 't', url: `https://y.example/${d}/${n}` }];
  const card = (d, n, has) => ({ id: `${d}-c0${n}`, drop: d, sources: src(d, n), has_article: has });
  return {
    drops: [{ id: '2026-10-16T01' }, { id: '2026-10-16T13' }],
    cards: [card('2026-10-16T01', 1, true), card('2026-10-16T13', 1, true), card('2026-10-16T13', 2, false), card('2026-10-16T13', 3, true)],
  };
}
const goodFile = () => ({
  version: 1, drop: '2026-10-16T13',
  articles: {
    '2026-10-16T13-c01': { paragraphs: paras(4, 220), based_on: ['https://x.example/2026-10-16T13/1'] },
    '2026-10-16T13-c03': { paragraphs: paras(3, 200), based_on: ['https://x.example/2026-10-16T13/3', 'https://y.example/2026-10-16T13/3'] },
  },
});

test('articlesFileChecks: a consistent file passes', () => {
  const r = articlesFileChecks(goodFile(), sampleFeed(), '2026-10-16T13.json');
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test('articlesFileChecks: has_article true without an entry is an error', () => {
  const f = goodFile();
  delete f.articles['2026-10-16T13-c03'];
  assert.deepEqual(articlesFileChecks(f, sampleFeed(), '2026-10-16T13.json').errors, ['2026-10-16T13-c03: has_article true but no article']);
});

test('articlesFileChecks: entries only for pool cards, based_on ⊆ sources, limits enforced', () => {
  const f = goodFile();
  f.articles['2026-10-16T13-c09'] = { paragraphs: paras(4, 220), based_on: ['https://x.example/z'] };
  f.articles['2026-10-16T13-c01'].based_on = ['https://evil.example/not-a-source'];
  f.articles['2026-10-16T13-c03'].paragraphs = paras(4, 400);
  f.articles['2026-10-16T13-c03'].extra = 1;
  const { errors } = articlesFileChecks(f, sampleFeed(), '2026-10-16T13.json');
  assert.deepEqual(errors.sort(), [
    '2026-10-16T13-c01: based_on https://evil.example/not-a-source is not one of the card\'s sources',
    '2026-10-16T13-c03: 400 words (want 180–360)',
    '2026-10-16T13-c03: unknown key "extra"',
    '2026-10-16T13-c09: not a card of drop 2026-10-16T13 in the pool',
  ]);
  const empty = goodFile();
  empty.articles['2026-10-16T13-c01'].based_on = [];
  assert.match(articlesFileChecks(empty, sampleFeed()).errors[0], /based_on must list/);
});

test('articlesFileChecks: an entry for a has_article:false card is a warning; wrong name/version/drop are errors', () => {
  const f = goodFile();
  f.articles['2026-10-16T13-c02'] = { paragraphs: paras(4, 220), based_on: ['https://x.example/2026-10-16T13/2'] };
  const r = articlesFileChecks(f, sampleFeed(), '2026-10-16T13.json');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, ['2026-10-16T13-c02: has an article but has_article is not true']);
  const g = { ...goodFile(), version: 2 };
  assert.ok(articlesFileChecks(g, sampleFeed(), 'other.json').errors.includes('version must be 1'));
  assert.ok(articlesFileChecks(g, sampleFeed(), 'other.json').errors.some(e => /does not match file name/.test(e)));
  const old = { version: 1, drop: '2026-10-12T01', articles: {} };
  assert.deepEqual(articlesFileChecks(old, sampleFeed(), '2026-10-12T01.json').errors, ['drop 2026-10-12T01 is not in the pool (should have been deleted)']);
});

// ───────────── rollover deletion ─────────────

test('pool rollover deletes articles files for drops that left the pool and keeps the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-articles-'));
  try {
    const nowMs = Date.parse('2026-10-16T13:04:00Z');
    const prev = {
      drops: [{ id: '2026-10-13T01', at: '2026-10-13T01:03:00Z' }, { id: '2026-10-15T19', at: '2026-10-15T19:03:00Z' }],
      cards: [{ id: '2026-10-13T01-c01', drop: '2026-10-13T01' }, { id: '2026-10-15T19-c01', drop: '2026-10-15T19' }],
    };
    const drop = { id: '2026-10-16T13', at: '2026-10-16T13:04:00Z' };
    const merged = mergePool(prev, drop, [{ id: '2026-10-16T13-c01', drop: '2026-10-16T13' }], nowMs);
    assert.deepEqual(merged.rolled, ['2026-10-13T01']);
    for (const f of ['2026-10-13T01.json', '2026-10-15T19.json', '2026-10-16T13.json', '2026-10-01T01.json', 'README.txt', '2026-10-15T19.json.tmp']) {
      fs.writeFileSync(path.join(dir, f), '{}');
    }
    const deleted = pruneArticles(new Set(merged.drops.map(d => d.id)), dir);
    assert.deepEqual(deleted.sort(), ['2026-10-01T01', '2026-10-13T01']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10-15T19.json', '2026-10-15T19.json.tmp', '2026-10-16T13.json', 'README.txt']);
    assert.deepEqual(pruneArticles(new Set(), path.join(dir, 'missing')), [], 'missing dir is fine');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countWords counts whitespace-separated tokens', () => {
  assert.equal(countWords('  a b\n c\t d  '), 4);
  assert.equal(countWords(''), 0);
});

// ---------- balance: contested stories read more pages and are reported by outlet count ----------

test('contested topics read 3 pages, others 2', () => {
  assert.equal(isContested({ topics: ['elections', 'us-politics'] }), true);
  assert.equal(isContested({ topics: ['ai', 'policy-regulation'] }), true);
  assert.equal(isContested({ topics: ['robotics'] }), false);
  assert.equal(pagesFor({ topics: ['courts'] }), 3);
  assert.equal(pagesFor({ topics: ['space'] }), 2);
});

test('balanceReport counts distinct outlets on contested cards only', () => {
  const src = (...o) => o.map((outlet, i) => ({ outlet, url: `https://x/${outlet}/${i}` }));
  const r = balanceReport([
    { id: 'a', topics: ['us-politics'], sources: src('Fox News', 'NPR') },
    { id: 'b', topics: ['courts'], sources: src('The Hill', 'The Hill') },
    { id: 'c', topics: ['space'], sources: src('NASA') },
  ]);
  assert.deepEqual(r, { contested: 2, multiOutlet: 1, single: ['b'] });
});

// ---------- streaming: SSE → message object (the job streams because a drop takes > 5 min) ----------

const sse = (...events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
async function* chunks(str, size) { const b = new TextEncoder().encode(str); for (let i = 0; i < b.length; i += size) yield b.slice(i, i + size); }
const START = { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 1 } } };
const text = (index, t) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t.slice(0, 5) } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t.slice(5) } },
  { type: 'content_block_stop', index },
];
const END = (stop = 'end_turn') => [{ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 42 } }, { type: 'message_stop' }];

test('stream: rebuilds text, model, stop_reason and usage even when split mid-event (any chunk size)', async () => {
  const body = sse(START,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'ping' },
    ...text(1, '{"cards":[{"headline":"Ünïcode ✓"}]}'), ...END());
  for (const size of [1, 7, 64, 100000]) {
    const m = await readMessageStream(chunks(body, size));
    assert.equal(m.model, 'claude-opus-5-5');
    assert.equal(m.stop_reason, 'end_turn');
    assert.deepEqual(m.usage, { input_tokens: 100, output_tokens: 42 });
    assert.deepEqual(JSON.parse(m.content.find(b => b.type === 'text').text), { cards: [{ headline: 'Ünïcode ✓' }] });
  }
});

test('stream: CRLF line endings parse the same', async () => {
  const m = await readMessageStream(chunks(sse(START, ...text(0, '{"a":1}'), ...END()).replace(/\n/g, '\r\n'), 13));
  assert.equal(m.content[0].text, '{"a":1}');
});

test('stream: after a mid-stream fallback only blocks after the last fallback block are kept', async () => {
  const m = await readMessageStream(chunks(sse(START, ...text(0, '{"partial'),
    { type: 'content_block_start', index: 1, content_block: { type: 'fallback', model: 'claude-opus-5' } },
    { type: 'content_block_stop', index: 1 },
    ...text(2, '{"done":true}'), ...END()), 32));
  assert.deepEqual(m.content.map(b => b.type), ['text']);
  assert.equal(m.content[0].text, '{"done":true}');
});

test('stream: max_tokens and refusal stop reasons pass through for the caller to check', async () => {
  const m = await readMessageStream(chunks(sse(START, ...text(0, '{"cut'), ...END('max_tokens')), 50));
  assert.equal(m.stop_reason, 'max_tokens');
});

test('stream: error event throws, retryable only for transient types', async () => {
  await assert.rejects(readMessageStream(chunks(sse(START, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 20)),
    e => e.retryable === true && /overloaded_error/.test(e.message));
  await assert.rejects(readMessageStream(chunks(sse(START, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), 20)),
    e => e.retryable === false);
});

test('stream: a stream that ends with no stop_reason is a retryable error', async () => {
  await assert.rejects(readMessageStream(chunks(sse(START, ...text(0, '{"half')), 9)), e => e.retryable === true && /without a stop_reason/.test(e.message));
});

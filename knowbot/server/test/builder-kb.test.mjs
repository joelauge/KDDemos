// Builder knowledge base (server/builder/kb.mjs + studio/kb/*.md). Fakes only: server/test/fake-knowdrive.mjs on 127.0.0.1.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { createBuilderKb, loadKbDocs, kbTail, docHash, KB_PREFIX, KB_DIR, isKbTagged } from '../builder/kb.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = 'vs_fake_builder';
const kdOf = (fake) => ({ baseUrl: fake.url, apiKey: 'fake-key' });
const ingests = (fake) => fake.calls.filter((c) => c.url === '/api/v1/ingest');
const deletes = (fake) => fake.calls.filter((c) => c.method === 'DELETE');
const rowsAt = (fake, p) => [...fake.files.values()].filter((f) => f.store === STORE && f.filename === p);

describe('studio/kb docs', () => {
  const docs = loadKbDocs();
  test('8-12 docs, each one H1, short H2 sections, each with a Source line', () => {
    assert.equal(path.resolve(KB_DIR), path.resolve(__dirname, '..', '..', 'studio', 'kb'));
    assert.ok(docs.length >= 8 && docs.length <= 12, `got ${docs.length} docs`);
    for (const d of docs) {
      assert.ok(!d.text.startsWith('---'), `${d.name} has front matter`);
      assert.match(d.text, /^# \S/, `${d.name} must start with an H1`);
      assert.equal((d.text.match(/^# /gm) || []).length, 1, `${d.name} has one H1`);
      assert.ok(d.sections.length >= 2, `${d.name} has sections`);
      for (const s of d.sections) assert.ok(s.source && /^\/(?:studio\/|docs\/|v1)/.test(s.source), `${d.name} › ${s.heading} needs a Source: line`);
    }
  });
  test('pricing is exactly the owner pricing truth, and no other price appears anywhere', () => {
    const pricing = docs.find((d) => d.name === 'pricing-and-trial.md');
    assert.ok(pricing);
    assert.match(pricing.text, /free and needs no account/);
    assert.match(pricing.text, /\$249 per month/);
    assert.match(pricing.text, /first 30 days are free/);
    assert.match(pricing.text, /credit card is required at signup/);
    assert.match(pricing.text, /cancel anytime/);
    for (const d of docs) for (const m of d.text.match(/[$€£]\s?\d[\d,.]*/g) || []) assert.equal(m, '$249', `${d.name} quotes another price: ${m}`);
    assert.ok(!docs.some((d) => /\bdiscount(?:s|ed)? (?:of|available)|coupon code|% off\b/i.test(d.text)), 'no discounts');
  });
  test('the refusal sentence is quoted byte-exact', () => {
    const proof = docs.find((d) => d.name === 'proof-and-citations.md');
    assert.ok(proof.text.includes("I can't seem to find an answer to that in any of my current data sources."));
  });
  test('no training claim is made (the code does not support one)', () => {
    for (const d of docs) assert.ok(!/\b(?:never|not|no)\b[^.]{0,40}\btrain/i.test(d.text), `${d.name} claims something about training`);
  });
});

describe('createBuilderKb.ensure', () => {
  let fake;
  before(async () => { fake = await startFakeKnowDrive({ speed: 50 }); });
  after(async () => { await fake.close(); });

  test('ingests every doc once with the kb tags, path and a per-version invisible tail; a second process ingests nothing', async () => {
    // rows that are not ours: another bot's file, a kb-looking path without the kb tag, a kb tag outside the prefix
    fake.add({ store: STORE, path: 'knowbot/ugm/policies/shipping.md', text: '# Shipping\n\nWe ship worldwide.', tags: ['knowbot', 'knowbot:ugm'] });
    fake.add({ store: STORE, path: `${KB_PREFIX}pricing-and-trial.md`, text: '# Fake\n\nNot ours.', tags: ['knowbot'] });
    fake.add({ store: STORE, path: 'elsewhere/pricing.md', text: '# Elsewhere\n\nNot under the prefix.', tags: ['knowbot', 'kind:builder-kb', 'bucket:knowbot-builder'] });
    const before0 = fake.files.size;
    const kb = createBuilderKb({ kd: kdOf(fake), store: STORE });
    const docs = loadKbDocs();
    const r = await kb.ensure();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.ingested.length, docs.length);
    assert.equal(ingests(fake).length, docs.length);
    for (const d of docs) {
      const call = ingests(fake).find((c) => c.ingest?.path === d.path);
      assert.ok(call, `ingested ${d.path}`);
      assert.equal(call.store, STORE);
      assert.deepEqual([...call.ingest.tags].sort(), ['bucket:knowbot-builder', 'kind:builder-kb', 'knowbot', `kbv:${d.hash}`].sort());
      assert.equal(call.ingest.mime, 'text/markdown');
      assert.equal(call.ingest.bytes, Buffer.byteLength(d.text + kbTail(d.name, d.hash)));
    }
    // the tail is invisible (whitespace only) and differs per version
    assert.match(kbTail('a.md', 'x'), /^[ \t\n]+$/);
    assert.notEqual(kbTail('a.md', docHash('one')), kbTail('a.md', docHash('two')));
    // other rows untouched (the kb-looking row without the kb tag is replaced in the fake only because it has the same
    // path: the fake treats a same-path ingest as an overwrite. We never deleted it ourselves.)
    assert.equal(deletes(fake).length, 0);
    assert.equal(rowsAt(fake, 'knowbot/ugm/policies/shipping.md').length, 1);
    assert.equal(rowsAt(fake, 'elsewhere/pricing.md').length, 1);
    assert.ok(fake.files.size >= before0);
    await fake.settle();

    // same process: cached
    const again = await kb.ensure();
    assert.equal(again.cached, true);
    // a new process (restart): lists, keeps everything, ingests nothing
    const n0 = ingests(fake).length;
    const kb2 = createBuilderKb({ kd: kdOf(fake), store: STORE });
    const r2 = await kb2.ensure();
    assert.equal(r2.ok, true);
    assert.equal(r2.ingested.length, 0);
    assert.equal(r2.kept.length, docs.length);
    assert.equal(ingests(fake).length, n0);
    // listing was tags-scoped and prefix-scoped
    const list = fake.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/files')).at(-1);
    const qs = new URLSearchParams(list.search);
    assert.equal(qs.get('tags_all'), 'kind:builder-kb');
    assert.equal(qs.get('prefix'), KB_PREFIX);
  });

  test('concurrent ensure() calls share one run', async () => {
    const f2 = await startFakeKnowDrive({ speed: 50 });
    try {
      const kb = createBuilderKb({ kd: kdOf(f2), store: STORE });
      const [a, b] = await Promise.all([kb.ensure(), kb.ensure()]);
      assert.equal(a.ok && b.ok, true);
      assert.equal(ingests(f2).length, loadKbDocs().length);
    } finally { await f2.close(); }
  });
});

describe('createBuilderKb: versions, removal and fail-closed', () => {
  let fake;
  before(async () => { fake = await startFakeKnowDrive({ speed: 50 }); });
  after(async () => { await fake.close(); });
  const A1 = { name: 'alpha.md', text: '# Alpha\n\n## Price\nSource: /studio/\n\nAlpha costs nothing to test.\n' };
  const A2 = { name: 'alpha.md', text: '# Alpha\n\n## Price\nSource: /studio/\n\nAlpha is free to build and test.\n' };
  const B = { name: 'beta.md', text: '# Beta\n\n## Storage\nSource: /studio/\n\nBeta keeps trial files for 7 days.\n' };

  test('only a changed doc is re-ingested; its old version is deleted afterwards; a removed doc is deleted', async () => {
    const r1 = await createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [A1, B] }).ensure();
    assert.deepEqual(r1.ingested.sort(), ['alpha.md', 'beta.md']);
    await fake.settle();
    const foreign = fake.add({ store: STORE, path: 'knowbot/trials/tr_x/alpha.md', text: '# Alpha\n\nA trial file.', tags: ['knowbot', 'kind:trial'] });
    const n0 = ingests(fake).length;
    const r2 = await createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [A2, B] }).ensure();
    assert.deepEqual(r2.ingested, ['alpha.md']);
    assert.deepEqual(r2.kept, ['beta.md']);
    assert.equal(ingests(fake).length, n0 + 1);
    const alpha = rowsAt(fake, `${KB_PREFIX}alpha.md`);
    assert.equal(alpha.length, 1);
    assert.ok(alpha[0].tags.includes(`kbv:${docHash(A2.text)}`));
    await fake.settle();
    // beta removed from the folder: its row is deleted; the trial file with the same base name is untouched
    const r3 = await createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [A2] }).ensure();
    assert.equal(r3.ok, true);
    assert.equal(rowsAt(fake, `${KB_PREFIX}beta.md`).length, 0);
    assert.ok(fake.files.has(foreign.id));
    for (const c of deletes(fake)) assert.notEqual(c.url, `/api/v1/files/${foreign.id}`);
  });

  test('a stale duplicate of an old version (left by another server) is deleted, never one outside the prefix', async () => {
    const stale = fake.add({ store: STORE, path: `${KB_PREFIX}alpha.md.old`, text: 'x', tags: ['knowbot', 'kind:builder-kb', 'bucket:knowbot-builder', 'kbv:000000000000'] });
    const r = await createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [A2] }).ensure();
    assert.equal(r.ok, true);
    assert.ok(!fake.files.has(stale.id), 'an orphan under the prefix with kb tags is removed');
  });

  test('listing failure: nothing is written, the error is reported, and the retry waits', async () => {
    let t = 1_000_000;
    const kb = createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [A2, B], now: () => t, retryMs: 5000 });
    const n0 = ingests(fake).length, d0 = deletes(fake).length;
    fake.failNext.list = 1;
    const r = await kb.ensure();
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.equal(ingests(fake).length, n0);
    assert.equal(deletes(fake).length, d0);
    const soon = await kb.ensure();
    assert.equal(soon.ok, false);
    assert.ok(soon.retryAfterMs > 0);
    t += 6000;
    const later = await kb.ensure();
    assert.equal(later.ok, true);
    assert.deepEqual(later.ingested, ['beta.md']);
  });

  test('no store configured: ensure and search are inert', async () => {
    const kb = createBuilderKb({ store: '' , docs: [A1] });
    assert.deepEqual(await kb.ensure(), { ok: false, error: 'no_store' });
    const s = await kb.search('anything');
    assert.deepEqual(s.sources, []);
    assert.equal(s.error, 'no_store');
  });
});

describe('createBuilderKb.search', () => {
  let fake, kb;
  before(async () => {
    fake = await startFakeKnowDrive({ speed: 50 });
    kb = createBuilderKb({ kd: kdOf(fake), store: STORE });
    assert.equal((await kb.ensure()).ok, true);
    await fake.settle();
    // a logged question that repeats pricing words, and a config row: both must never be cited
    fake.add({ store: STORE, path: 'knowbot/builder-kb/questions/2026-11/q.md', text: 'How much does it cost to launch KnowBot per month?', tags: ['questions', 'knowbot', 'kind:builder-kb', 'bucket:knowbot-builder', `kbv:${docHash(readFileSync(path.join(KB_DIR, 'pricing-and-trial.md'), 'utf8'))}`] });
    fake.add({ store: STORE, path: 'knowbot/_config/x.json', text: 'launch price per month cost', tags: ['kind:config', 'kind:builder-kb'] });
  });
  after(async () => { await fake.close(); });

  test('returns cited sources from the kb only, with similarity = 1 - distance/2 and the page path', async () => {
    const r = await kb.search('How much does it cost to launch my bot?');
    assert.ok(r.sources.length > 0, 'found something');
    assert.equal(r.sources[0].name, 'pricing-and-trial.md');
    const price = r.sources.slice(0, 3).find((s) => /\$249/.test(s.text));
    assert.ok(price, 'the price section is in the top 3');
    assert.equal(price.page, '/studio/');
    assert.equal(price.title, 'Pricing and trial');
    assert.ok(['The price to launch', 'No other prices'].includes(price.section), price.section);
    assert.deepEqual(r.sources.map((s) => s.n), r.sources.map((_, i) => i + 1));
    for (const s of r.sources) {
      assert.ok(s.path.startsWith(KB_PREFIX), s.path);
      assert.ok(!/questions\//.test(s.path));
      assert.ok(!/Production fixture/.test(s.text), 'the production fixture is dropped');
      assert.ok(!/^Source:/m.test(s.text));
      if (s.similarity != null) { assert.ok(s.similarity > 0 && s.similarity <= 1); assert.equal(s.match, Math.round(s.similarity * 100)); }
    }
    assert.equal(r.top, r.sources[0].similarity);
    // the request carried the kb filter on both searches
    const searches = fake.calls.filter((c) => c.url.endsWith('/search')).slice(-2);
    assert.deepEqual(searches.map((c) => c.body.mode).sort(), ['hybrid', 'vector']);
    for (const c of searches) assert.deepEqual(c.body.filter, { all_of: ['kind:builder-kb'], none_of: ['questions', 'kind:config'] });
  });

  test('a plain question lands on its doc in vector mode', async () => {
    const r = await kb.search('What file types can I upload?');
    assert.equal(r.mode, 'vector');
    assert.equal(r.sources[0].name, 'files-and-limits.md');
  });

  test('minSimilarity drops weak hits; an off-topic question finds nothing above the floor', async () => {
    const r = await kb.search("What's the capital of Australia?", { minSimilarity: 0.7 });
    assert.equal(r.sources.length, 0);
    assert.equal(r.top, null);
  });

  test('search errors never throw', async () => {
    fake.failNext.search = 2;
    const r = await kb.search('How much does it cost?');
    assert.deepEqual(r.sources, []);
    assert.ok(r.error);
  });

  test('isKbTagged fails closed', () => {
    assert.equal(isKbTagged(null), false);
    assert.equal(isKbTagged(['knowbot', 'kind:builder-kb']), false);
    assert.equal(isKbTagged(['knowbot', 'kind:builder-kb', 'bucket:knowbot-builder', 'questions']), false);
    assert.equal(isKbTagged(['knowbot', 'kind:builder-kb', 'bucket:knowbot-builder']), true);
  });
});

describe('createBuilderKb.search: narrow-filter fallback and stale versions', () => {
  let fake;
  before(async () => { fake = await startFakeKnowDrive({ speed: 50, narrowRows: 1000 }); }); // vector under the kb filter: always empty
  after(async () => { await fake.close(); });

  test('an empty vector search falls back to hybrid hits scored by their distance', async () => {
    const kb = createBuilderKb({ kd: kdOf(fake), store: STORE });
    assert.equal((await kb.ensure()).ok, true);
    await fake.settle();
    const r = await kb.search('How long are trial files kept?');
    assert.equal(r.mode, 'hybrid');
    assert.ok(r.sources.length > 0);
    const top = r.sources[0];
    assert.ok(top.similarity != null, 'hybrid hit scored by distance, not RRF');
    assert.ok(top.similarity > 0.5, `similarity ${top.similarity} is not an RRF score`);
    assert.match(top.text, /7 days/);
  });

  test('hits from a stale version (tag kbv differs from the local doc) are dropped', async () => {
    const old = { name: 'gamma.md', text: '# Gamma\n\n## Old\nSource: /studio/\n\nGamma zeppelins cost a fortune.\n' };
    const cur = { name: 'gamma.md', text: '# Gamma\n\n## New\nSource: /studio/\n\nGamma zeppelins are free.\n' };
    await createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [old] }).ensure();
    await fake.settle();
    const kbCur = createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [cur] }); // not ensured yet: the store holds the old one
    const r = await kbCur.search('gamma zeppelins');
    assert.equal(r.sources.length, 0);
    const kbOld = createBuilderKb({ kd: kdOf(fake), store: STORE, docs: [old] });
    const r2 = await kbOld.search('gamma zeppelins');
    assert.ok(r2.sources.some((s) => s.name === 'gamma.md'));
  });
});

test('studio/kb holds only .md docs', () => {
  for (const n of readdirSync(KB_DIR)) assert.match(n, /^[a-z0-9-]+\.md$/);
});

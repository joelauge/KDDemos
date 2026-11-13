// KnowBot Studio server: Enter a Store URL (import over SSE; an import that survives a restart).
// Split from trials.test.mjs along its describe boundaries; shared helpers live in trials-helpers.mjs.
// Fakes only: never touches knowDrive or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer, internalSecret } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { etaOf, parseIntent, validatePatch, defaultSpec, normHit, sniffOk, deriveStage, findOffset, hitAllowed, keepRelevantLines, LINE_MARGIN, topicCase, GENERIC_HEADING_RE,
  splitSentences, citeQuotedLines, quotedLineParts, storeIntentOf, sourceSegments, stripSourceLines, lastSourceUrl, answerCheck, cleanTopic, topicsOf, sectionLine, starterGrammarOk, genericNumbered, titleWords, insightKey, refusalReasonOf } from '../trials.mjs';
import { requireCitations, isCourtesy } from '../../lib/knowbot.js';
import { atomize, extractText, startFakeKnowDrive as startKD } from './fake-knowdrive.mjs';
import { NOT_IN_DATA } from '../../lib/knowbot.js';
import { ROOT, DAY, yyyymmdd, sleep, nextIp, parseSSE, openSSE, boot, client, headersOnlyUpload, fakeShop, useFakeSpeed, FAST_SPEED } from './trials-helpers.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1: nothing here may reach a real store
useFakeSpeed(FAST_SPEED);              // nothing here asserts the order of ingest stages (trials-helpers.mjs)

// ------------------------------------------------------------------------------------------------ Enter a Store URL
describe('Enter a Store URL: POST /trials/:id/store (SSE)', () => {
  let S, P, c, shop, slowShop;
  before(async () => {
    shop = await fakeShop();
    slowShop = await fakeShop({ slow: 24, slowMs: 250 });
    // the importer's injectable net option lets this test reach 127.0.0.1; production (P below) never sets it.
    // knowDrive cuts Markdown like production here (heading-path prefixed atoms), so citations are tested on real atoms.
    S = await boot({ studio: { storeNet: { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0 }, storeRetryMs: 20, productImageMissMs: 0 }, kdOpts: { chunker: 'production' } });
    P = await boot();
    c = client(S);
  });
  after(async () => { await S.close(); await P.close(); await shop.close(); await slowShop.close(); });

  test('imports a store: plan, progress, batched src:store uploads (one file per page), cited answers that link the exact page', async () => {
    const t = await c.trial();
    const ev = await c.stream(t, '/store', { url: shop.base, owner: true });
    const names = ev.map((e) => e.event);
    for (const n of ['detect', 'plan', 'found', 'fetching', 'building', 'uploaded', 'built', 'done']) assert.ok(names.includes(n), `${n} in ${names.join(',')}`);
    const at = (n) => names.indexOf(n);
    assert.ok(at('detect') < at('plan') && at('plan') < at('found') && at('found') < at('building') && at('building') <= at('uploaded') && names.lastIndexOf('uploaded') < at('built') && at('built') < at('done'), names.join(','));
    assert.ok(ev.every((e, i) => i === 0 || e.id > ev[i - 1].id), 'ids are the job sequence');
    assert.equal(ev.find((e) => e.event === 'detect').data.platform, 'shopify');
    const plan = ev.find((e) => e.event === 'plan').data;
    assert.equal(plan.counts.product, 2); assert.equal(plan.counts.faq, 1);
    const found = ev.find((e) => e.event === 'found').data;
    assert.equal(found.products, 2); assert.equal(found.faqs, 1);
    const done = ev.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.fileCount, 4, JSON.stringify(done.data.report));
    assert.ok(done.data.files.every((f) => f.origin === 'store' && f.page), JSON.stringify(done.data.files));
    assert.deepEqual(done.data.report.written, { policy: 1, faq: 1, product: 2 });
    const rows = [...S.kd.files.values()].filter((f) => f.tags.includes(`trial:${t.trialId}`) && !f.tags.includes('kind:trial-spec')); // page files (the spec doc records the job)
    assert.equal(rows.length, 4);
    assert.ok(rows.every((f) => f.tags.includes('src:store') && f.tags.includes('site:127.0.0.1') && f.filename.startsWith(`knowbot/trials/${t.trialId}/site/127.0.0.1/`) && f.filename.endsWith('.md')), rows.map((r) => r.filename).join(' '));
    const prods = rows.filter((f) => f.tags.includes('page:product'));
    assert.deepEqual(prods.map((f) => f.filename.split('/').slice(-2).join('/')).sort(), ['product/commuter-lite.md', 'product/trail-pro.md']);
    assert.equal(new Set(prods.map((f) => f.tags.find((x) => x.startsWith('tfile:')))).size, 1, 'product pages went up in one /ingest batch');
    assert.ok(rows.some((f) => f.tags.includes('page:policy') && f.filename.endsWith('/policy/refund-policy.md')));
    assert.ok(!S.kd.calls.some((x) => x.stray?.length), 'no stray text parts were sent to /ingest');
    // every atom knowDrive cut from a product page carries that page's URL
    for (const f of prods) { const url = `${shop.base}/products/${f.filename.split('/').pop().replace(/\.md$/, '')}`; assert.ok(f.atoms.length && f.atoms.every((a) => a.text.includes(url)), f.atoms.map((a) => a.text).join('\n---\n')); }
    await c.waitReady(t, 4);
    // the librarian answer points to the page it came from, with its link
    const fin = (await c.stream(t, '/ask', { question: 'Can I return a bike?' })).find((e) => e.event === 'final').data;
    assert.equal(fin.status, 'grounded', JSON.stringify(fin.why));
    assert.match(fin.text, /30 days/);
    const cit = fin.citations.find((x) => /refund/i.test(x.file));
    assert.ok(cit, JSON.stringify(fin.citations));
    assert.equal(cit.url, `${shop.base}/policies/refund-policy`);
    assert.equal(cit.title, 'Refund policy');
    assert.ok(fin.text.includes(`(${shop.base}/policies/refund-policy)`), `the answer links the policy page: ${fin.text}`);
    assert.doesNotMatch(fin.text, /Source:|· http/, 'Source lines and page heads are provenance, never quoted');
    const prod = (await c.stream(t, '/ask', { question: 'How much is the Commuter Lite?' })).find((e) => e.event === 'final').data;
    assert.equal(prod.status, 'grounded', JSON.stringify(prod.why));
    assert.match(prod.text, /799/);
    assert.ok(prod.citations.length && prod.citations.every((x) => x.url === `${shop.base}/products/commuter-lite`), JSON.stringify(prod.citations));
    assert.equal(prod.proof.unsupported, 0);
    assert.ok(prod.proof.claims.length >= 1 && prod.proof.claims.every((x) => x.verified), JSON.stringify(prod.proof.claims));
  });

  test('product cards: an answer citing a product carries its card from the index (photo included); none for a policy; the web chat API too', async () => {
    const t = await c.trial();
    const done = (await c.stream(t, '/store', { url: shop.base, owner: true })).at(-1).data;
    await c.waitReady(t, done.fileCount);
    const idxRow = [...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_products.json`);
    assert.ok(idxRow, 'the product index is stored beside the spec doc');
    assert.ok(idxRow.tags.includes('kind:trial-spec') && idxRow.tags.includes(`trial:${t.trialId}`), idxRow.tags.join(','));
    const fin = (await c.stream(t, '/ask', { question: 'How much is the Trail Pro?' })).find((e) => e.event === 'final').data;
    assert.equal(fin.status, 'grounded', JSON.stringify(fin.why));
    assert.deepEqual(fin.products, [{ url: `${shop.base}/products/trail-pro`, title: 'Trail Pro', price: 1299, compareAt: null, currency: 'USD', availability: 'in stock', image: `${shop.base}/cdn/trail-pro.jpg` }]);
    assert.doesNotMatch(fin.text, /image:|\/cdn\//, 'the photo line is never quoted');
    const pol = (await c.stream(t, '/ask', { question: 'Can I return a bike?' })).find((e) => e.event === 'final').data;
    assert.equal(pol.status, 'grounded');
    assert.equal(pol.products, undefined, 'no cards under a policy answer');
    // the web chat / Homepage search API carries the same cards; channel replies (SMS) never do
    const dk = await (await c.json(t, '/devkey')).json();
    const k = dk.key || dk.apiKey || dk.token;
    const v1 = await (await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How much is the Trail Pro?' }) })).json();
    assert.equal(v1.refused, false, JSON.stringify(v1));
    assert.deepEqual(v1.products?.map((p) => [p.title, p.price, p.image]), [['Trail Pro', 1299, `${shop.base}/cdn/trail-pro.jpg`]], JSON.stringify(v1.products));
    const sms = await (await S.api(`/v1/bots/${t.trialId}/preview`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms', question: 'How much is the Trail Pro?' }) })).json();
    assert.equal(sms.products, undefined);
    assert.doesNotMatch(sms.text || '', /cdn\/trail-pro/);
  });

  test('product cards without an index (an older import): read from the cited product file; a missing photo comes from the page og:image, then is kept', async () => {
    const t = await c.trial();
    const done = (await c.stream(t, '/store', { url: shop.base, owner: true })).at(-1).data;
    await c.waitReady(t, done.fileCount);
    // forget the index, as for a bot imported before product cards existed
    const T = S.kb.studio.trials.get(t.trialId);
    T.storeProducts = null; delete T.flags.storeProducts;
    shop.setOgPage(true);
    try {
      const fin = (await c.stream(t, '/ask', { question: 'How much is the Commuter Lite?' })).find((e) => e.event === 'final').data;
      assert.equal(fin.status, 'grounded', JSON.stringify(fin.why));
      assert.deepEqual(fin.products, [{ url: `${shop.base}/products/commuter-lite`, title: 'Commuter Lite', price: 799, compareAt: null, currency: 'USD', availability: 'in stock', image: `${shop.base}/cdn/commuter-lite.jpg` }]);
      const pageReads = shop.hits.get('/products/commuter-lite');
      const again = (await c.stream(t, '/ask', { question: 'How much is the Commuter Lite?' })).find((e) => e.event === 'final').data;
      assert.equal(again.products?.[0]?.image, `${shop.base}/cdn/commuter-lite.jpg`);
      assert.equal(shop.hits.get('/products/commuter-lite'), pageReads, 'the photo is looked up once');
      // the photo found later is kept in the bot's index
      assert.equal(T.storeProducts.get(`127.0.0.1/products/commuter-lite`)?.image, `${shop.base}/cdn/commuter-lite.jpg`);
      const tp = (await c.stream(t, '/ask', { question: 'How much is the Trail Pro?' })).find((e) => e.event === 'final').data;
      assert.equal(tp.products?.[0]?.image, `${shop.base}/cdn/trail-pro.jpg`, 'the photo line of the file is read too');
    } finally { shop.setOgPage(false); }
  });

  test('store files are named for people, the store names the bot (ConfigDiff), starters come from page titles', async () => {
    const t = await c.trial();
    const done = (await c.stream(t, '/store', { url: shop.base })).at(-1).data;
    const names = done.files.map((f) => f.name).sort();
    assert.deepEqual(names, ['Lumen Test Shop · Commuter Lite.md', 'Lumen Test Shop · FAQ.md', 'Lumen Test Shop · Refund policy.md', 'Lumen Test Shop · Trail Pro.md'], names.join(', '));
    assert.equal(done.spec.name, 'Lumen Test Shop Help');
    assert.equal(done.spec.greeting, 'Hi! Ask me anything about Lumen Test Shop.');
    const turn = await c.stream(t, '/setup', { event: { type: 'store_imported', data: { name: done.name } } });
    const card = turn.find((e) => e.event === 'card' && e.data.type === 'config-diff');
    assert.ok(card, JSON.stringify(turn.map((e) => e.event)));
    assert.deepEqual(card.data.data.rows.find((r) => r.field === 'Name'), { field: 'Name', from: 'SampleBot', to: 'Lumen Test Shop Help' });
    await c.waitReady(t, done.files.length);
    const q = await (await c.json(t, '/questions')).json();
    const all = [...q.starters, ...q.proof].map((x) => x.q);
    assert.ok(all.length >= 1, 'store pages get starters');
    assert.ok(all.every((x) => !/127|say about|the file|http/i.test(x)), all.join(' | '));
    assert.ok(all.some((x) => /^(?:Do you ship to Canada\?|How much is the (?:Trail Pro|Commuter Lite)\?|What is your refund policy\?|Can I return an item\?)$/.test(x)), all.join(' | '));
    // citations carry the page titles, never the host
    const final = (await c.stream(t, '/ask', { question: 'How much is the Trail Pro?' })).find((e) => e.event === 'final').data;
    assert.ok(final.citations.length && final.citations.every((x) => !/127/.test(x.file || '') && !/127|http/.test(x.title || '')), JSON.stringify(final.citations));
    assert.ok(final.citations.some((x) => x.title === 'Trail Pro' && x.url === `${shop.base}/products/trail-pro`), JSON.stringify(final.citations));
  });

  test('a re-import replaces the earlier src:store files; bad input and unconfirmed ownership are 400; GET replays the last job', async () => {
    const t = await c.trial();
    const first = (await c.stream(t, '/store', { url: shop.base })).at(-1).data.files.map((f) => f.id);
    shop.setPrice('1199.00');
    const second = (await c.stream(t, '/store', { url: shop.base })).at(-1).data.files.map((f) => f.id);
    assert.equal(second.length, first.length);
    const now = (await (await c.json(t, '/files')).json()).files.map((f) => f.id).sort();
    assert.deepEqual(now, [...second].sort(), 'only the new import is left');
    assert.ok(first.every((id) => !S.kd.files.has(id)), 'the earlier import was deleted from knowDrive');
    assert.ok([...S.kd.files.values()].some((f) => f.tags.includes(`trial:${t.trialId}`) && /1,199\.00 USD/.test(f.text)), 'the new price is in');
    assert.equal((await c.json(t, '/store', 'POST', { url: '' })).status, 400);
    assert.equal((await c.json(t, '/store', 'POST', { url: shop.base, owner: false })).status, 400);
    const bad = await c.stream(t, '/store', { url: 'javascript:alert(1)' });
    assert.deepEqual(bad.map((e) => e.event), ['error', 'done']);
    assert.equal(bad[0].data.code, 'bad_url');
    assert.match(bad[0].data.message, /web address/);
    // GET re-attaches to the last job (here: the finished bad_url one) and replays it
    const replay = parseSSE(await (await c.json(t, '/store', 'GET')).text());
    assert.deepEqual(replay.map((e) => e.event), ['error', 'done']);
    assert.equal((await c.json(t, '/store', 'DELETE')).status, 409, 'nothing to cancel');
    assert.equal((await c.json(t, '/store', 'PUT')).status, 405);
  });

  test('background job: survives the request closing, one job per trial (409), resumes from ?since=, reaches the events stream', async () => {
    const t = await c.trial();
    const post = await openSSE(`${S.base}/api/studio/trials/${t.trialId}/store`, c.h(t, null, { 'content-type': 'application/json' }), { method: 'POST', body: JSON.stringify({ url: slowShop.base, owner: true }) });
    const plan = await post.waitFor((e) => e.event === 'plan');
    assert.equal(plan.data.counts.product, 24, JSON.stringify(plan.data.counts)); // the sitemap's product pages (the feed adds 2 more)
    post.close(); // the browser went away: the import keeps going
    await sleep(100);
    const busy = await c.json(t, '/store', 'POST', { url: slowShop.base });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error.code, 'busy');
    const since = plan.id;
    const res = await c.json(t, `/store?since=${since}`, 'GET');
    assert.equal(res.status, 200);
    const rest = parseSSE(await res.text());
    assert.ok(rest.length && rest.every((e) => e.id > since), 'only events after since');
    assert.equal(rest.at(-1).event, 'done');
    const done = rest.at(-1).data;
    assert.equal(done.error, undefined, JSON.stringify(done));
    assert.equal(done.report.products.read, 26);
    assert.equal(done.fileCount, 28, 'every product page (2 from the feed, 24 from the sitemap), the FAQ and the refund policy');
    const rows = [...S.kd.files.values()].filter((f) => f.tags.includes(`trial:${t.trialId}`) && f.tags.includes('page:product'));
    assert.equal(rows.length, 26);
    const calls = S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path?.includes(`/trials/${t.trialId}/site/`));
    assert.ok(calls.length < 26, `product pages were batched (${calls.length} /ingest calls for 28 files)`);
    // the trial's events stream carried the job (store events, replayable)
    const evs = await openSSE(`${S.base}/api/studio/trials/${t.trialId}/events?since=0`, c.h(t));
    const storeDone = await evs.waitFor((e) => e.event === 'store' && e.data.type === 'done');
    evs.close();
    assert.equal(storeDone.data.data.fileCount, 28);
    assert.ok(evs.events.some((e) => e.event === 'store' && e.data.type === 'plan'));
  });

  test('DELETE cancels a running import: files already uploaded stay, the stream ends with aborted', async () => {
    const t = await c.trial();
    const post = await openSSE(`${S.base}/api/studio/trials/${t.trialId}/store`, c.h(t, null, { 'content-type': 'application/json' }), { method: 'POST', body: JSON.stringify({ url: slowShop.base, owner: true }) });
    await post.waitFor((e) => e.event === 'uploaded');
    const del = await c.json(t, '/store', 'DELETE');
    assert.equal(del.status, 202);
    const done = await post.waitFor((e) => e.event === 'done', 20000);
    post.close();
    const err = post.events.find((e) => e.event === 'error');
    assert.equal(err?.data.code, 'aborted');
    assert.equal(done.data.cancelled, true);
    assert.ok(done.data.fileCount >= 1 && done.data.fileCount < 28, `kept what was uploaded before the cancel (${done.data.fileCount})`);
    const own = (await (await c.json(t, '/files')).json()).files;
    assert.equal(own.length, done.data.fileCount);
    // a new import can start right away
    const again = await c.stream(t, '/store', { url: shop.base });
    assert.equal(again.at(-1).data.error, undefined);
  });

  test('planOnly: the finder reports its plan and uploads nothing (no import slot); kinds: only the ticked kinds are imported', async () => {
    const t = await c.trial();
    for (let i = 0; i < 7; i++) {
      const ev = await c.stream(t, '/store', { url: shop.base, owner: true, planOnly: true });
      const names = ev.map((e) => e.event);
      assert.ok(names.includes('detect') && names.includes('plan') && names.at(-1) === 'done', names.join(','));
      assert.ok(!names.includes('uploaded') && !names.includes('building') && !names.includes('error'), names.join(','));
      const done = ev.at(-1).data;
      assert.equal(done.planOnly, true);
      assert.equal(done.fileCount, 0);
      assert.equal(done.plan.counts.product, 2);
      assert.equal(done.plan.counts.faq, 1);
    }
    assert.equal([...S.kd.files.values()].filter((f) => f.tags.includes(`trial:${t.trialId}`)).length, 0, 'a plan uploads nothing');
    assert.equal((await c.json(t, '/store', 'GET')).status, 404, 'a plan is not an import job');
    // seven plans later the hourly import slots (6) are all still there: the import runs, with only the ticked kinds
    assert.equal((await c.json(t, '/store', 'POST', { url: shop.base, kinds: ['policy', 'nope'] })).status, 400);
    const ev = await c.stream(t, '/store', { url: shop.base, kinds: ['policy', 'faq'] });
    const done = ev.at(-1).data;
    assert.equal(done.error, undefined, JSON.stringify(done));
    assert.equal(done.fileCount, 2);
    assert.deepEqual(done.report.written, { policy: 1, faq: 1 });
    assert.equal(done.report.leftOut.excluded.product, 2);
    const rows = [...S.kd.files.values()].filter((f) => f.tags.includes(`trial:${t.trialId}`) && !f.tags.includes('kind:trial-spec')); // page files (the spec doc records the job)
    assert.equal(rows.length, 2);
    assert.ok(!rows.some((f) => f.tags.includes('page:product')), 'no product file was uploaded');
  });

  test('one job per trial under concurrency: two POSTs at once give one 200 and one 409, and the running job stays cancellable', async () => {
    const t = await c.trial();
    const post = () => S.api(`/api/studio/trials/${t.trialId}/store`, { method: 'POST', headers: c.h(t, null, { 'content-type': 'application/json' }), body: JSON.stringify({ url: slowShop.base, owner: true }) });
    const [a, b] = await Promise.all([post(), post()]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const loser = a.status === 409 ? a : b, winner = a.status === 200 ? a : b;
    assert.equal((await loser.json()).error.code, 'busy');
    winner.body.cancel().catch(() => {});
    const watch = await openSSE(`${S.base}/api/studio/trials/${t.trialId}/store?since=0`, c.h(t));
    await watch.waitFor((e) => e.event === 'plan');
    watch.close();
    assert.equal((await c.json(t, '/store', 'DELETE')).status, 202, 'the one running job is the one DELETE cancels');
    const replay = parseSSE(await (await c.json(t, '/store', 'GET')).text());
    assert.equal(replay.at(-1).event, 'done');
    assert.equal(replay.at(-1).data.cancelled, true);
    assert.ok(replay.some((e) => e.event === 'detect') && replay.some((e) => e.event === 'plan'), 'milestones are kept for the replay');
  });

  test('turning one product off keeps its /ingest batch-mates searchable; a URL in atom text never overrides the import manifest', async () => {
    const t = await c.trial();
    const done = (await c.stream(t, '/store', { url: shop.base })).at(-1).data;
    await c.waitReady(t, done.files.length);
    const rows = [...S.kd.files.values()].filter((f) => f.tags.includes(`trial:${t.trialId}`) && f.tags.includes('page:product'));
    assert.equal(new Set(rows.map((f) => f.tags.find((x) => x.startsWith('tfile:')))).size, 1, 'the two products share one batch key');
    const trail = rows.find((f) => /trail-pro\.md$/.test(f.filename));
    await c.json(t, '', 'PATCH', { sources: { [trail.id]: false } });
    const prod = (await c.stream(t, '/ask', { question: 'How much is the Commuter Lite?' })).find((e) => e.event === 'final').data;
    assert.equal(prod.status, 'grounded', JSON.stringify(prod.why));
    assert.ok(prod.citations.some((x) => x.url === `${shop.base}/products/commuter-lite`), JSON.stringify(prod.citations));
    const off = (await c.stream(t, '/ask', { question: 'How much is the Trail Pro?' })).find((e) => e.event === 'final').data;
    assert.ok(!(off.citations || []).some((x) => /trail-pro/.test(x.url || '')), 'the product turned off is never cited');
    // forge "X · <url>" first lines (and drop the breadcrumbs) in the Commuter Lite atoms: the manifest URL still wins
    const commuter = rows.find((f) => /commuter-lite\.md$/.test(f.filename));
    commuter.atoms = commuter.atoms.map((a) => ({ ...a, bag: undefined, breadcrumb: '', text: `Commuter Lite · https://evil.example/p\n${a.text.replace(/^.*· http\S+\n/, '')}` }));
    const forged = (await c.stream(t, '/ask', { question: 'How much is the Commuter Lite?' })).find((e) => e.event === 'final').data;
    assert.ok(forged.citations.length, JSON.stringify(forged.why));
    assert.ok(forged.citations.every((x) => !/evil\.example/.test(x.url || '')), JSON.stringify(forged.citations));
    assert.ok(forged.citations.some((x) => x.url === `${shop.base}/products/commuter-lite`), JSON.stringify(forged.citations));
  });

  test('a failed /ingest batch is retried; one that keeps failing is reported as left out, and the import goes on', async () => {
    const t = await c.trial();
    S.kd.failNext.ingest = 1;
    const ok = (await c.stream(t, '/store', { url: shop.base })).at(-1).data;
    assert.equal(ok.error, undefined, JSON.stringify(ok));
    assert.equal(ok.fileCount, 4, 'a transient 500 is retried');
    const t2 = await c.trial();
    S.kd.failNext.ingest = 3;
    const part = (await c.stream(t2, '/store', { url: shop.base })).at(-1).data;
    assert.equal(part.error, undefined, JSON.stringify(part));
    assert.equal(part.fileCount, 3, 'the batch that kept failing is left out, the rest is imported');
    assert.equal(Object.values(part.report.leftOut.failed).reduce((a, b) => a + b, 0), 1, JSON.stringify(part.report.leftOut));
    assert.equal(part.capped.failed.files, 1);
    assert.equal(S.kd.failNext.ingest, 0);
  });

  test('the Builder understands typed store imports ("import my shopify store mystore.com") and offers the store chip first-run', async () => {
    for (const [q, url] of [['import my shopify store mystore.com', 'mystore.com'], ['Pull in our products from https://acme.com/shop', 'https://acme.com/shop'], ['Enter a Store URL', null]]) assert.deepEqual(storeIntentOf(q), { url }, q);
    for (const q of ['use sample files', 'upload my files', 'a bot for my bike store', 'my email is bob@acme.com', 'read warranty.pdf']) assert.equal(storeIntentOf(q), null, q);
    assert.deepEqual(parseIntent('import my shopify store mystore.com', { spec: defaultSpec() }).actions, [{ type: 'import_store', url: 'mystore.com' }]);
    const t = await c.trial();
    const ev = await c.stream(t, '/setup', { message: 'import my shopify store mystore.com' });
    assert.deepEqual(ev.filter((e) => e.event === 'action').map((e) => e.data), [{ type: 'import_store', url: 'mystore.com' }]);
    assert.match(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /mystore\.com[\s\S]*own or manage/);
    const chips = ev.find((e) => e.event === 'chips').data.chips;
    assert.ok(chips.some((x) => x.action?.type === 'request_upload'), JSON.stringify(chips));
  });

  test('6 imports per hour per trial, then 429 with retry-after; mistyped or refused addresses never use a slot', async () => {
    const t = await c.trial();
    // fixer r8 (D10): invalid URLs are rejected before any slot is charged, and an import that fails before it found
    // anything (blocked or unknown host) gives its slot back, so typos never lock the person out for an hour
    for (let i = 0; i < 8; i++) assert.equal((await c.stream(t, '/store', { url: 'not a url' }))[0].data.code, 'bad_url');
    for (let i = 0; i < 4; i++) assert.equal((await c.stream(t, '/store', { url: 'http://10.0.0.5/' })).find((e) => e.event === 'error').data.code, 'blocked_host');
    for (let i = 0; i < 6; i++) assert.equal((await c.stream(t, '/store', { url: shop.base })).at(-1).data.error, undefined, `import ${i + 1} succeeds`);
    const r = await c.json(t, '/store', 'POST', { url: shop.base });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 60);
    assert.equal((await r.json()).error.code, 'rate_limited');
  });

  test('production default: loopback and private addresses are refused (blocked_host), nothing is uploaded', async () => {
    const pc = client(P);
    const t = await pc.trial();
    const ev = (await pc.stream(t, '/store', { url: shop.base })).filter((e) => e.event !== 'fetching');
    assert.deepEqual(ev.map((e) => e.event), ['error', 'done']);
    assert.equal(ev[0].data.code, 'blocked_host');
    assert.equal((await (await pc.json(t, '/files')).json()).files.length, 0);
    assert.equal((await pc.stream(t, '/store', { url: 'http://169.254.169.254/latest/meta-data/' })).find((e) => e.event === 'error').data.code, 'blocked_host');
  });
});

// ------------------------------------------------------------------------------------------------ restarts
describe('Enter a Store URL: an import survives a server restart (persisted job, resume, busy endpoint)', () => {
  let kd, llm, shop;
  const dataDirs = [], servers = [];
  const env = (extra = {}) => ({ KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', ...extra });
  /** One server instance on the shared fake knowDrive (a "container"): close() is the restart. */
  async function instance({ studio = {}, envExtra = {} } = {}) {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-restart-'));
    dataDirs.push(dataDir);
    const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: env(envExtra),
      studio: { sweep: false, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400, storeNet: { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0 }, storeRetryMs: 20,
        storeSaveMs: 30, storeBatchFiles: 4, resumeDelayMs: 0, ...studio } });
    await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${kb.server.address().port}`;
    const S = { kb, kd, base, api: (p, init = {}) => fetch(base + p, init), close: () => new Promise((r) => (kb.server.listening ? kb.server.close(() => r()) : r())) };
    servers.push(S);
    return { S, c: client(S) };
  }
  const rowsOf = (t) => [...kd.files.values()].filter((f) => f.store === 'vs_fake_trials' && f.tags.includes(`trial:${t.trialId}`) && f.tags.includes('src:store'));
  const specOf = async (t) => JSON.parse(await (await fetch(`${kd.url}/api/v1/vector_stores/vs_fake_trials/path/content/knowbot/trials/${t.trialId}/_spec.json`, { headers: { authorization: 'Bearer x' } })).text());
  const until = async (pred, ms = 15000, what = 'condition') => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(30); } };
  /** Start an import on `inst`, let it write some product pages, then stop that server mid-way (a deploy). */
  async function interrupted(inst, t, minFiles = 8) {
    const post = await openSSE(`${inst.S.base}/api/studio/trials/${t.trialId}/store`, inst.c.h(t, null, { 'content-type': 'application/json' }), { method: 'POST', body: JSON.stringify({ url: shop.base, owner: true }) });
    await post.waitFor((e) => e.event === 'uploaded' && e.data.uploaded >= minFiles, 20000);
    const job = post.events.find((e) => e.event === 'uploaded');
    await until(async () => { try { return (await specOf(t)).flags.storeJob?.uploaded >= minFiles; } catch { return false; } }, 5000, 'the job to be saved');
    post.close();
    await inst.S.close();
    assert.ok(!post.events.some((e) => e.event === 'done'), 'the import was cut before it finished');
    return { before: rowsOf(t), hitsBefore: new Map(shop.hits), job };
  }

  before(async () => {
    kd = await startFakeKnowDrive({ speed: 3, narrowScope: 'all' });
    llm = await startFakeLLM({ slowMs: 9000 });
    shop = await fakeShop({ slow: 24, slowMs: 150 });
  });
  after(async () => { for (const x of servers) await x.close(); await shop.close(); await kd.close(); await llm.close(); for (const d of dataDirs) await fsp.rm(d, { recursive: true, force: true }); });

  test('an import cut by a restart resumes (on GET /store) and finishes: no page read or uploaded twice, the right final counts', async () => {
    const a = await instance();
    const t = await a.c.trial();
    const { before, hitsBefore } = await interrupted(a, t);
    assert.ok(before.length >= 8 && before.length < 28, `interrupted mid-way (${before.length} files)`);
    const spec0 = await specOf(t);
    assert.equal(spec0.flags.storeJob.state, 'running');
    assert.equal(spec0.flags.storeJob.url, shop.base);
    assert.ok(spec0.flags.storeJob.plan?.product === 24 && spec0.flags.storeJob.total >= 25, JSON.stringify(spec0.flags.storeJob.plan)); // the sitemap's pages (the feed adds 2)
    assert.ok(Object.keys(spec0.flags.storeJob.written).length >= 8, 'the written page URLs are saved');
    const jobId = spec0.flags.storeJob.id;
    assert.ok(before.every((f) => f.tags.includes(`sjob:${jobId}`)), 'every page file carries its job');

    // a new server on the same store and data, no start-up resume: touching the bot resumes the import
    const b = await instance({ studio: { resumeStoreJobs: false } });
    await sleep(100);
    assert.equal(rowsOf(t).length, before.length, 'nothing resumes before the bot is touched');
    const res = await b.c.json(t, '/store', 'GET');
    assert.equal(res.status, 200, 'GET /store knows the interrupted import');
    const ev = parseSSE(await res.text());
    const names = ev.map((e) => e.event);
    assert.equal(names[0], 'resumed', names.join(','));
    assert.equal(ev[0].data.done, before.length);
    assert.equal(ev[0].data.total, spec0.flags.storeJob.total);
    assert.ok(ev[0].id > spec0.flags.storeJob.seq, 'event ids continue above the saved ones');
    const done = ev.at(-1);
    assert.equal(done.event, 'done', names.join(','));
    assert.equal(done.data.error, undefined, JSON.stringify(done.data));
    assert.equal(done.data.resumed, true);
    assert.equal(done.data.fileCount, 28, 'every page once: 26 products, the FAQ and the refund policy');
    assert.deepEqual(done.data.report.written, { policy: 1, faq: 1, product: 26 });
    assert.equal(done.data.counts.products, 26);
    assert.equal(done.data.report.resumed.before, before.length);
    // no duplicates in the store, and the files from before the restart are untouched
    const after = rowsOf(t);
    assert.equal(after.length, 28);
    assert.equal(new Set(after.map((f) => f.filename)).size, 28, after.map((f) => f.filename).sort().join('\n'));
    assert.equal(after.filter((f) => f.tags.includes('page:product')).length, 26);
    for (const f of before) assert.ok(kd.files.has(f.id), `${f.filename} kept`);
    assert.ok(after.every((f) => f.tags.includes(`sjob:${jobId}`)));
    // only the remaining product pages were read: none written before the restart was fetched again
    for (const f of before.filter((x) => /\/product\/slow-\d+\.md$/.test(x.filename))) {
      const p = `/products/${f.filename.split('/').pop().replace(/\.md$/, '')}`;
      assert.equal(shop.hits.get(p), hitsBefore.get(p), `${p} was not read again`);
    }
    const spec1 = await specOf(t);
    assert.equal(spec1.flags.storeJob.state, 'done');
    assert.equal(spec1.flags.storeJob.uploaded, 28);
    assert.equal(spec1.flags.storeJob.resumes, 1);
    assert.equal(spec1.flags.storeLast.files, 28);
    const files = (await (await b.c.json(t, '/files')).json()).files;
    assert.equal(files.length, 28);
    assert.ok(files.filter((f) => f.page === 'product').every((f) => f.url && f.url.startsWith(`${shop.base}/products/`)), 'page URLs are known after the restart');
    await b.S.close();

    // another restart: the finished import is reported from the doc, nothing resumes
    const c = await instance();
    await sleep(150);
    const again = parseSSE(await (await c.c.json(t, '/store', 'GET')).text());
    assert.deepEqual(again.map((e) => e.event), ['done']);
    assert.equal(again[0].data.restored, true);
    assert.equal(again[0].data.fileCount, 28);
    assert.equal(again[0].data.error, undefined);
    assert.equal(rowsOf(t).length, 28);
    await c.S.close();
  });

  test('a slow site that outruns the time budget goes on in further rounds until every product page is written once', async () => {
    const shop = await fakeShop({ slow: 24, slowMs: 700 });   // its own: slow enough to outrun a 1 s budget, its own hit counts
    try {
    const a = await instance({ studio: { storeBudgetMs: 1000, storeMaxRounds: 40 } });
    const t = await a.c.trial();
    const res = await a.c.json(t, '/store', 'POST', { url: shop.base, owner: true });
    assert.equal(res.status, 200);
    const ev = parseSSE(await res.text());
    const names = ev.map((e) => e.event);
    const done = ev.at(-1);
    assert.equal(done.event, 'done', names.join(','));
    assert.equal(done.data.error, undefined, JSON.stringify(done.data));
    const rounds = ev.filter((e) => e.event === 'continuing');
    assert.ok(rounds.length >= 1, `the budget forced more rounds (${names.filter((n) => n !== 'fetching').join(',')})`);
    assert.equal(done.data.report.rounds, rounds.length + 1);
    assert.equal(done.data.fileCount, 28, 'every page once: 26 products, the FAQ and the refund policy');
    assert.deepEqual(done.data.report.written, { policy: 1, faq: 1, product: 26 });
    assert.equal(done.data.counts.products, 26);
    assert.ok(!Object.keys(done.data.report.leftOut.time || {}).length || Object.values(done.data.report.leftOut.time).every((n) => !n), JSON.stringify(done.data.report.leftOut));
    const after = rowsOf(t);
    assert.equal(after.length, 28);
    assert.equal(new Set(after.map((f) => f.filename)).size, 28, 'no page written twice');
    // every product page's own copy was read (enrich defaults to all); a read cut by a round's deadline is read again in
    // the next round, so at most once per round (plus the one that finished)
    for (const f of after.filter((x) => /\/product\/slow-\d+\.md$/.test(x.filename))) {
      const p = `/products/${f.filename.split('/').pop().replace(/\.md$/, '')}`;
      assert.ok((shop.hits.get(p) || 0) >= 1 && (shop.hits.get(p) || 0) <= rounds.length + 1, `${p} read ${shop.hits.get(p)} times in ${rounds.length + 1} rounds`);
    }
    const spec = await specOf(t);
    assert.equal(spec.flags.storeJob.state, 'done');
    assert.equal(spec.flags.storeJob.rounds, rounds.length);
    await a.S.close();
    } finally { await shop.close(); }
  });

  test('start-up resumes on its own (busy meanwhile); cancel is persisted and a cancelled import never resumes', async () => {
    const a = await instance();
    const t = await a.c.trial();
    const { before } = await interrupted(a, t, 6);
    // the next server resumes the import at start-up, with nobody touching the bot
    const b = await instance();
    await until(() => rowsOf(t).length > before.length, 15000, 'the start-up resume to upload');
    const busy = await b.S.api('/api/internal/busy', { headers: { 'x-knowbot-internal': internalSecret('dev-admin') } });
    assert.equal(busy.status, 200);
    const bj = await busy.json();
    assert.equal(bj.busy, true, JSON.stringify(bj));
    assert.equal(bj.storeJobs, 1);
    // GET /store reports the resumed job (live), the events stream's hello names it
    const watch = await openSSE(`${b.S.base}/api/studio/trials/${t.trialId}/store?since=0`, b.c.h(t));
    const resumed = await watch.waitFor((e) => e.event === 'resumed');
    assert.equal(resumed.data.done, before.length);
    const evs = await openSSE(`${b.S.base}/api/studio/trials/${t.trialId}/events`, b.c.h(t));
    const hello = await evs.waitFor((e) => e.event === 'hello');
    evs.close();
    assert.equal(hello.data.storeJob?.state, 'running');
    const del = await b.c.json(t, '/store', 'DELETE');
    assert.equal(del.status, 202);
    const done = await watch.waitFor((e) => e.event === 'done', 20000);
    watch.close();
    assert.equal(done.data.cancelled, true);
    const kept = rowsOf(t).length;
    assert.ok(kept >= before.length && kept < 28, `cancelled mid-way (${kept})`);
    assert.equal((await specOf(t)).flags.storeJob.state, 'cancelled', 'the cancel is in the doc');
    assert.equal((await (await b.S.api('/api/internal/busy', { headers: { 'x-knowbot-internal': internalSecret('dev-admin') } })).json()).busy, false);
    await b.S.close();
    // restart again: nothing resumes, GET /store shows the cancelled import
    const c = await instance();
    await sleep(300);
    const replay = parseSSE(await (await c.c.json(t, '/store', 'GET')).text());
    assert.deepEqual(replay.map((e) => e.event), ['done']);
    assert.equal(replay[0].data.cancelled, true);
    assert.equal(rowsOf(t).length, kept, 'a cancelled import never resumes');
    await c.S.close();
  });

  test('cancel of an interrupted import before it resumed is persisted too', async () => {
    const a = await instance();
    const t = await a.c.trial();
    const { before } = await interrupted(a, t, 6);
    const b = await instance({ studio: { resumeStoreJobs: false } });
    const del = await b.c.json(t, '/store', 'DELETE');
    assert.equal(del.status, 202);
    assert.equal((await specOf(t)).flags.storeJob.state, 'cancelled');
    const replay = parseSSE(await (await b.c.json(t, '/store', 'GET')).text());
    assert.deepEqual(replay.map((e) => e.event), ['done']);
    assert.equal(replay[0].data.cancelled, true);
    await b.S.close();
    const c = await instance();
    await sleep(300);
    assert.equal((await (await c.c.json(t, '')).json()).trialId, t.trialId);
    await sleep(200);
    assert.equal(rowsOf(t).length, before.length, 'never resumed');
    await c.S.close();
  });

  test('GET /api/internal/busy: only with the header secret derived from the admin token; idle is busy:false', async () => {
    const a = await instance();
    // (busy while the start-up resume looks for interrupted imports, then idle: nothing to resume here)
    let j = null;
    await until(async () => { const ok = await a.S.api('/api/internal/busy', { headers: { 'x-knowbot-internal': internalSecret('dev-admin') } }); assert.equal(ok.status, 200); j = await ok.json(); return !j.busy; }, 5000, 'idle');
    assert.deepEqual(j, { busy: false, storeJobs: 0, phone: 0, webVoice: 0 });
    for (const headers of [{}, { 'x-knowbot-internal': internalSecret('other') }, { 'x-knowbot-internal': 'dev-admin' }, { authorization: 'Bearer dev-admin' }]) {
      assert.equal((await a.S.api('/api/internal/busy', { headers })).status, 404, JSON.stringify(headers));
    }
    assert.equal((await a.S.api('/api/internal/busy', { method: 'POST', headers: { 'x-knowbot-internal': internalSecret('dev-admin') } })).status, 405);
    await a.S.close();
    // no admin token on the server: the endpoint does not exist
    const n = await instance({ envExtra: { KNOWBOT_ADMIN_TOKEN: '' } });
    assert.equal((await n.S.api('/api/internal/busy', { headers: { 'x-knowbot-internal': internalSecret('') } })).status, 404);
    await n.S.close();
  });
});

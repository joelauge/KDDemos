// KnowBot Studio server: checkout, convert (launch), launched bots outliving the trial, the sweeper.
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

describe('KnowBot Studio server (trials.mjs): checkout, convert, launch', () => {
  let S, c, registryWritesBefore, spies;

  before(async () => {
    S = await boot();
    c = client(S);
    await S.kb.registry.ready;
    // the registry's own start-up housekeeping may save once or twice: let it settle before the studio runs
    const regWrites = () => S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path === 'knowbot/_config/instances.json').length;
    for (let last = -1, i = 0; i < 40 && regWrites() !== last; i++) { last = regWrites(); await sleep(150); }
    registryWritesBefore = regWrites();
    spies = { createBucket: 0, create: 0, commit: 0 };
    for (const k of Object.keys(spies)) { const orig = S.kb.registry[k]?.bind(S.kb.registry); S.kb.registry[k] = (...a) => { spies[k]++; return orig?.(...a); }; }
  });
  after(async () => { await S.close(); });

  // ---------------------------------------------------------------------------------------------- 16
  test('16. checkout keeps the base params and appends trial, bot, email, price, return', async () => {
    const t = await c.trial();
    await c.json(t, '', 'PATCH', { name: 'Lumen Help' });
    const r = await S.api(`/api/studio/trials/${t.trialId}/checkout`, { method: 'POST', headers: c.h(t, null, { 'content-type': 'application/json', origin: 'http://127.0.0.1:9999' }), body: JSON.stringify({ email: 'ana@example.com' }) });
    assert.equal(r.status, 200);
    const u = new URL((await r.json()).url);
    assert.equal(`${u.origin}${u.pathname}`, 'https://knowdrive.ai/signup');
    assert.equal(u.searchParams.get('plan'), 'knowbot', 'existing params are kept');
    assert.equal(u.searchParams.get('trial'), t.trialId);
    assert.equal(u.searchParams.get('bot'), 'Lumen Help');
    assert.equal(u.searchParams.get('email'), 'ana@example.com');
    assert.equal(u.searchParams.get('price'), '549', 'the one plan price');
    assert.equal(u.searchParams.get('total'), '549', 'one plan line: total = price');
    assert.equal(u.searchParams.get('return'), `http://127.0.0.1:9999/studio/?t=${t.trialId}&launched=1`);
    assert.match(u.search, /bot=Lumen\+Help/);
    assert.ok(S.kd.calls.some((x) => x.ingest?.path === `knowbot/trials/${t.trialId}/_spec.json`), 'the spec doc is flushed on checkout');
    const em = await (await c.json(t, '/email', 'POST', { email: 'ana@example.com' })).json();
    assert.equal(em.sent, false, 'no mail webhook configured: never claim it was sent');
    assert.match(em.link, new RegExp(`/studio/\\?t=${t.trialId}`));
  });

  // ---------------------------------------------------------------------------------------------- 17
  test('17. convert: admin only, idempotent, retags through batch_tags, deletes samples', async () => {
    const t = await c.trial();
    await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' });
    const own = await (await c.upload(t, 'own.md', Buffer.from('# Own\n\nOur own document about returns.\n'))).json();
    const conv = (auth) => S.api(`/api/studio/trials/${t.trialId}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'x-forwarded-for': nextIp() }, body: JSON.stringify({ account: 'acct42', bucketId: 'lumen' }) });
    assert.equal((await conv(null)).status, 401);
    assert.equal((await conv(t.token)).status, 401, 'a trial token is not an admin token');
    const r = await conv('dev-admin');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { converted: true, files: 1 });
    const bt = S.kd.calls.filter((x) => x.url === '/api/v1/files/batch_tags').pop();
    assert.equal(bt.store, 'vs_fake_trials');
    assert.ok(bt.body.file_ids.includes(own.file.id));
    assert.deepEqual(bt.body.tags_add, ['account:acct42', 'bucket:lumen']);
    for (const tag of ['kind:trial', `trial:${t.trialId}`]) assert.ok(bt.body.tags_remove.includes(tag));
    assert.ok(bt.body.tags_remove.some((x) => x.startsWith('expires:')));
    const row = S.kd.files.get(own.file.id);
    assert.ok(row.tags.includes('bucket:lumen') && !row.tags.includes('kind:trial') && !row.tags.some((x) => x.startsWith('expires:')));
    assert.ok(![...S.kd.files.values()].some((f) => f.filename.startsWith(`knowbot/trials/${t.trialId}/lumen-`)), 'sample rows are deleted');
    const batchCalls = S.kd.calls.filter((x) => x.url === '/api/v1/files/batch_tags').length;
    const again = await conv('dev-admin');
    assert.deepEqual(await again.json(), { converted: true, files: 1 }, 'idempotent');
    assert.equal(S.kd.calls.filter((x) => x.url === '/api/v1/files/batch_tags').length, batchCalls, 'no second retag');
    const g = await (await c.json(t, '')).json();
    assert.equal(g.converted, true);
    // r2: the live bot lists only its own files (samples gone), with convertedFiles, and still answers from them
    assert.equal(g.convertedFiles, 1);
    assert.deepEqual(g.files.map((f) => f.id), [own.file.id], JSON.stringify(g.files.map((f) => f.name)));
    assert.ok(!g.files.some((f) => f.sample));
    const ev = await openSSE(`${S.base}/api/studio/trials/${t.trialId}/events`, c.h(t));
    const hello = await ev.waitFor((e) => e.event === 'hello');
    ev.close();
    assert.equal(hello.data.converted, true);
    assert.deepEqual(hello.data.files.map((f) => f.id), [own.file.id]);
  });

  test('onboarding: a launched bot outlives the 7-day trial (old token, restore link and same-browser reuse keep working)', async () => {
    const t = await c.trial();
    await c.upload(t, 'own.md', Buffer.from('# Own\n\nOur own document about returns.\n'));
    const live = await c.trial();
    await c.upload(live, 'own.md', Buffer.from('# Own\n\nOur own document about returns.\n'));
    const r = await S.api(`/api/studio/trials/${live.trialId}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ account: 'acct9', bucketId: 'live9' }) });
    assert.equal(r.status, 200);
    S.clock.skew = 8 * DAY;
    try {
      assert.equal((await c.json(t, '')).status, 401, 'an unlaunched trial still expires');
      const g = await c.json(live, '');
      assert.equal(g.status, 200, 'the launched bot opens with its old token');
      const j = await g.json();
      assert.equal(j.converted, true);
      assert.ok(j.token && Date.parse(j.expiresAt) > Date.now() + 365 * DAY, 'a long-lived token comes back');
      const rs = await S.api(`/api/studio/trials/${live.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ k: live.restoreKey }) });
      assert.equal(rs.status, 200, 'the restore link still opens it on another device');
      const rt = await S.api(`/api/studio/trials/${t.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ k: t.restoreKey }) });
      assert.equal(rt.status, 410, 'an expired trial link says it expired');
    } finally { S.clock.skew = 0; }
  });

  test('r2: convert pushes a reset snapshot so an open Studio drops the sample rows at once', async () => {
    const t = await c.trial();
    await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' });
    const own = await (await c.upload(t, 'own.md', Buffer.from('# Own returns\n\nOur own returns are accepted within 45 days with the receipt.\n'))).json();
    await c.waitReady(t, 5);
    const ev = await openSSE(`${S.base}/api/studio/trials/${t.trialId}/events`, c.h(t));
    await ev.waitFor((e) => e.event === 'hello');
    const r = await S.api(`/api/studio/trials/${t.trialId}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ account: 'acct7', bucketId: 'own7' }) });
    assert.equal(r.status, 200);
    const reset = await ev.waitFor((e) => e.event === 'hello' && e.data.reset === true);
    ev.close();
    assert.equal(reset.data.converted, true);
    assert.equal(reset.data.convertedFiles, 1);
    assert.deepEqual(reset.data.files.map((f) => f.id), [own.file.id]);
    const final = (await c.stream(t, '/ask', { question: 'How many days do I have to return something?' })).find((e) => e.event === 'final').data;
    assert.equal(final.status, 'grounded', JSON.stringify(final.why));
    assert.ok(final.citations.every((x) => x.fileId === own.file.id), 'the converted bot answers from its own (re-tagged) file only');
  });

  // ---------------------------------------------------------------------------------------------- 18
  test('18. sweeper deletes only kind:trial rows with a past expires:', async () => {
    const old = S.kd.add({ store: 'vs_fake_trials', path: 'knowbot/trials/tr_old/a.md', text: 'old', tags: ['knowbot', 'kind:trial', 'trial:tr_old', 'expires:20200101'] });
    const fresh = S.kd.add({ store: 'vs_fake_trials', path: 'knowbot/trials/tr_new/a.md', text: 'new', tags: ['knowbot', 'kind:trial', 'trial:tr_new', `expires:${yyyymmdd(Date.now() + 3 * DAY)}`] });
    const other = S.kd.add({ store: 'vs_fake_trials', path: 'knowbot/acme/a.md', text: 'not a trial', tags: ['knowbot', 'bucket:acme', 'expires:20200101'] });
    const r = await S.kb.studio.sweep();
    assert.ok(r.deleted >= 1);
    assert.ok(!S.kd.files.has(old.id), 'expired trial row deleted');
    assert.ok(S.kd.files.has(fresh.id), 'unexpired trial row kept');
    assert.ok(S.kd.files.has(other.id), 'rows without kind:trial are never touched');
  });


  test('4.11: no studio route ever creates buckets, bots or commits the registry', () => {
    assert.deepEqual(spies, { createBucket: 0, create: 0, commit: 0 });
    const writes = S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path === 'knowbot/_config/instances.json').length;
    assert.equal(writes, registryWritesBefore, 'instances.json untouched');
    assert.ok(S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path?.startsWith('knowbot/trials/')).every((x) => x.store === 'vs_fake_trials'));
  });
});

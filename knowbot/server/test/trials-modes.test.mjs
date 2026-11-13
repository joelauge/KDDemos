// KnowBot Studio server in its other modes: the LLM Builder engine, rate limits, local mode, shared samples; the fake knowDrive itself.
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

// ------------------------------------------------------------------------------------------------ 14 (own server)
describe('Builder LLM engine (KNOWBOT_STUDIO_PROVIDER=local, fake model)', () => {
  let S, c;
  before(async () => { S = await boot({ env: { KNOWBOT_STUDIO_PROVIDER: 'local' } }); c = client(S); });
  after(async () => { await S.close(); });

  test('14. a valid JSON reply is applied; SLOW falls back to scripted within 7 s', async () => {
    const cfg = await (await S.api('/api/studio/config')).json();
    assert.equal(cfg.builder.engine, 'llm');
    const t = await c.trial();
    const ev = await c.stream(t, '/setup', { message: 'call it Spokes' });
    const done = ev[ev.length - 1];
    assert.equal(done.event, 'done');
    assert.equal(done.data.engine, 'llm');
    assert.equal(ev.find((e) => e.event === 'patch').data.spec.name, 'Spokes');
    const chips = ev.find((e) => e.event === 'chips').data.chips;
    assert.ok(chips.length >= 2 && chips.length <= 4);
    assert.ok(S.llm.calls.some((x) => x.kind === 'setup'));
    const t0 = Date.now();
    const slow = await c.stream(t, '/setup', { message: 'SLOW make it more formal' });
    const ms = Date.now() - t0;
    assert.ok(ms < 7900, `fell back in ${ms} ms`);
    assert.equal(slow[slow.length - 1].data.engine, 'scripted');
    assert.equal(slow.find((e) => e.event === 'patch').data.spec.tone, 'formal');
  });
});

// ------------------------------------------------------------------------------------------------ fixer r1 limits + channels (own server)
describe('rate limits per trial, system turns exempt, launch never limited; channel test webhooks', () => {
  let S, c;
  before(async () => {
    S = await boot({ env: { TWILIO_AUTH_TOKEN: 'test-twilio', EMAIL_WEBHOOK_SECRET: 'test-mail', KNOWBOT_STUDIO_CHANNEL_TEST: '1' },
      studio: { limits: { setupMin: 3, setupIpMin: 5, setupEventsMin: 50, askMin: 2, askIpMin: 3 } } });
    c = client(S);
  });
  after(async () => { await S.close(); });

  test('r1: setup counts typed turns per trial; events and launch intent never hit the limit', async () => {
    const ip = nextIp();
    const mk = async () => { const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } }); return { ...(await r.json()), ip }; };
    const a = await mk(), b = await mk();
    const post = (t, body) => S.api(`/api/studio/trials/${t.trialId}/setup`, { method: 'POST', headers: c.h(t, ip, { 'content-type': 'application/json' }), body: JSON.stringify(body) }).then(async (r) => { await r.text(); return r.status; });
    for (let i = 0; i < 10; i++) assert.equal(await post(a, { event: { type: 'file_ready', data: {} } }), 200, 'system events are not counted');
    for (let i = 0; i < 3; i++) assert.equal(await post(a, { message: 'Make answers shorter' }), 200);
    assert.equal(await post(a, { message: 'Make it more formal' }), 429, 'the 4th typed turn in a minute for this trial');
    assert.equal(await post(a, { message: 'launch' }), 200, 'launch intent is never limited');
    assert.equal(await post(a, { chip: 'launch' }), 200);
    assert.equal(await post(a, { event: { type: 'proof_done', data: { passed: 3, total: 3 } } }), 200);
    assert.equal(await post(b, { message: 'Make answers shorter' }), 200, 'another visitor behind the same IP is not blocked by the first');
    assert.equal(await post(b, { message: 'Make answers shorter' }), 200);
    assert.equal(await post(b, { message: 'Make answers shorter' }), 429, 'the per-IP ceiling (5) still exists');
  });

  test('r1: ask is limited per trial with a looser per-IP ceiling', async () => {
    const ip = nextIp();
    const mk = async () => { const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } }); return { ...(await r.json()), ip }; };
    const a = await mk(), b = await mk();
    const ask = (t) => S.api(`/api/studio/trials/${t.trialId}/ask`, { method: 'POST', headers: c.h(t, ip, { 'content-type': 'application/json' }), body: JSON.stringify({ question: 'What is the weather?' }) }).then(async (r) => { await r.text(); return r.status; });
    assert.equal(await ask(a), 200); assert.equal(await ask(a), 200);
    assert.equal(await ask(a), 429);
    assert.equal(await ask(b), 200, 'a second visitor on the same NAT still asks');
  });

  test('r1: channel test webhooks post signed provider payloads to the real adapters and return their replies', async () => {
    const t = await c.trial();
    for (const ch of ['sms', 'voice', 'whatsapp', 'email']) {
      const r = await S.api(`/api/studio/trials/${t.trialId}/channels/${ch}/test`, { method: 'POST', headers: c.h(t, null, { 'content-type': 'application/json' }), body: JSON.stringify({ question: 'What are your opening hours?' }) });
      assert.equal(r.status, 200, ch);
      const j = await r.json();
      assert.equal(j.channel, ch);
      assert.equal(j.configured, true, `${ch}: ${JSON.stringify(j.response)}`);
      assert.equal(j.signed, true, ch);
      assert.notEqual(j.response.status, 403, `${ch} signature verified: ${j.response.body}`);
      assert.notEqual(j.response.status, 503, ch);
      if (ch === 'email') assert.match(j.response.contentType, /json/);
      else assert.match(j.response.body, /<Response>/, `${ch} returns TwiML`);
      assert.ok(!JSON.stringify(j).includes('test-twilio') && !JSON.stringify(j).includes('test-mail'), 'secrets are never echoed');
    }
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}/channels/fax/test`, { method: 'POST', headers: c.h(t, null, { 'content-type': 'application/json' }), body: '{}' })).status, 404);
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}/channels/sms/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'needs the trial bearer');
  });
});

// ------------------------------------------------------------------------------------------------ 19 (own server)
describe('local mode (no knowDrive key)', () => {
  let S;
  before(async () => { S = await boot({ kdKey: false }); });
  after(async () => { await S.close(); });

  test('19. every studio route → 503 no_store', async () => {
    const routes = [['GET', '/api/studio/config'], ['POST', '/api/studio/trials'], ['GET', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa'], ['PATCH', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa'],
      ['POST', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/files'], ['GET', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/events'], ['POST', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/ask'],
      ['POST', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/setup'], ['GET', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/questions'], ['POST', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/checkout'],
      ['POST', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/convert'], ['GET', '/api/studio/trials/tr_aaaaaaaaaaaaaaaa/insights'], ['GET', '/api/studio/anything']];
    for (const [method, p] of routes) {
      const r = await S.api(p, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(r.status, 503, `${method} ${p}`);
      const j = await r.json();
      assert.equal(j.error.code, 'no_store');
      assert.equal(j.error.message, 'Studio needs a knowDrive store (set KNOWDRIVE_API_KEY and KNOWDRIVE_BASE_URL).');
    }
  });
});

// ------------------------------------------------------------------------------------------------ 5.3 shared samples
describe('shared sample mode (KNOWBOT_STUDIO_SAMPLE_MODE=shared): one copy, replayed per trial', () => {
  let S, c;
  const REPLAY_MS = 4000;   // the configured replay duration (production: ~25 s)
  before(async () => { S = await boot({ env: { KNOWBOT_STUDIO_SAMPLE_MODE: 'shared' }, speed: 6, studio: { replayTargetMs: REPLAY_MS } }); c = client(S); });
  after(async () => { await S.close(); });

  test('samples are ingested once, replayed per trial, answer when replayed to ready, and are only disabled on remove', async () => {
    assert.equal((await (await S.api('/api/studio/config')).json()).sampleMode, 'shared');
    const a = await c.trial();
    const tA = Date.now();
    const r = await (await c.json(a, '/samples', 'POST', { set: 'lumen-bikes' })).json();
    assert.equal(r.files.length, 4);
    assert.ok(r.files.every((f) => f.replay && f.sample));
    assert.match(r.replay.label, /^Replay of a real ingest\b/);
    assert.equal(r.replay.durationMs, REPLAY_MS);
    const ingests = () => S.kd.calls.filter((x) => x.ingest?.path?.startsWith('knowbot/trials/_samples/lumen-bikes/') && !x.ingest.path.endsWith('timeline.json')).length;
    assert.equal(ingests(), 4);
    for (const call of S.kd.calls.filter((x) => x.ingest?.path?.startsWith('knowbot/trials/_samples/'))) {
      assert.ok(call.ingest.tags.includes('kind:trial-sample') && !call.ingest.tags.includes('kind:trial') && !call.ingest.tags.some((t) => t.startsWith('expires:')));
    }
    const files = await c.waitReady(a, 4, 30000);
    const tookA = Date.now() - tA;
    assert.ok(files.every((f) => f.stage === 'ready' && f.atoms > 0 && f.stageAt.ready));
    const final = (await c.stream(a, '/ask', { question: 'How long is the frame warranty?' })).find((e) => e.event === 'final').data;
    assert.equal(final.status, 'grounded');
    assert.ok(files.some((f) => f.id === final.citations[0].fileId));
    const b = await c.trial();
    const tB = Date.now();
    const rb = await (await c.json(b, '/samples', 'POST', {})).json();
    assert.deepEqual(rb.files.map((f) => f.id).sort(), r.files.map((f) => f.id).sort(), 'the second trial reuses the same copies');
    assert.equal(ingests(), 4, 'no second ingest');
    // fixer r8 (D4): the second trial replays the same scaled timeline even though the shared copy is already ready:
    // not all ready at once, and both trials take about the configured duration
    assert.ok(rb.files.some((f) => f.stage !== 'ready'), 'trial 2 starts its own replay, not an instant all-ready');
    await c.waitReady(b, 4, 30000);
    const tookB = Date.now() - tB;
    for (const [t, label] of [[tookA, 'trial 1'], [tookB, 'trial 2']]) assert.ok(t >= REPLAY_MS * 0.75 && t <= REPLAY_MS * 2.5, `${label} replay took ${t} ms (configured ${REPLAY_MS})`);
    assert.ok(Math.abs(tookA - tookB) <= REPLAY_MS * 0.6, `trial 1 ${tookA} ms vs trial 2 ${tookB} ms`);
    const outsider = await c.trial();
    assert.equal((await c.json(outsider, `/files/${files[0].id}/atoms`)).status, 404, 'a trial without samples cannot read them');
    assert.equal((await c.json(a, '/samples', 'DELETE')).status, 204);
    assert.equal((await (await c.json(a, '/files')).json()).files.length, 0);
    assert.ok(S.kd.files.has(files[0].id), 'shared copies are never deleted per trial');
    await S.kb.studio.sweep();
    assert.ok(S.kd.files.has(files[0].id), 'the sweeper never touches kind:trial-sample');
  });
});

// ------------------------------------------------------------------------------------------------ fake knowDrive = production
describe('fake knowDrive enforces the production facts', () => {
  let kd;
  before(async () => { kd = await startKD({ speed: 50, narrowScope: 'all' }); });
  after(async () => { await kd.close(); });
  const ingest = async (parts) => {
    const fd = new FormData();
    for (const [k, v, name] of parts) if (name) fd.append(k, new Blob([v], { type: 'text/markdown' }), name); else fd.append(k, v);
    const r = await fetch(`${kd.url}/api/v1/ingest`, { method: 'POST', headers: { authorization: 'Bearer x', 'x-vector-store-id': 'vs_p' }, body: fd });
    return { status: r.status, body: await r.json() };
  };
  const search = async (mode, filter, query = 'refund window days') => (await (await fetch(`${kd.url}/api/v1/vector_stores/vs_p/search`, { method: 'POST',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: JSON.stringify({ query, mode, max_num_results: 10, filter }) })).json()).data;

  test('ingest part order, stray text parts, unix-second timestamps, dedup, narrow vector search vs hybrid', async () => {
    const text = '# Refunds\n\nThe refund window is 30 days from delivery for every order.\n';
    assert.equal((await ingest([['tags', 'trial:a'], ['file', text, 'a/r.md'], ['mime_type', 'text/markdown']])).status, 400, 'mime_type after a file part');
    const stray = await ingest([['tags', 'trial:a'], ['mime_type', 'text/markdown'], ['path', 'a/r.md'], ['file', text, 'a/r.md']]);
    assert.equal(stray.status, 200);
    assert.deepEqual(stray.body.files.map((f) => f.filename), ['path', 'a/r.md'], 'a stray text part is stored as its own file');
    const row = stray.body.files[1];
    assert.equal(typeof row.created_at, 'number');
    assert.ok(row.created_at < 1e11, 'created_at is unix seconds');
    await kd.settle();
    // narrow filter (1 file): vector finds nothing, hybrid finds it and carries distance next to its RRF score
    assert.deepEqual(await search('vector', { all_of: ['trial:a'] }), []);
    const hyb = (await search('hybrid', { all_of: ['trial:a'] })).filter((h) => h.tags.includes('trial:a'));
    assert.ok(hyb.length >= 1 && hyb.every((h) => typeof h.distance === 'number' && h.score < 0.05));
    // a byte-identical copy under new tags is never returned
    const dup = (await ingest([['tags', 'trial:b'], ['mime_type', 'text/markdown'], ['file', text, 'b/r.md']])).body.files[0];
    await kd.settle();
    const hits = await search('hybrid', { all_of: ['trial:b'] });
    assert.ok(!hits.some((h) => h.file_id === dup.id), 'the duplicate is not searchable');
  });
});

// Lead delivery through the real server (server/crm/routes.mjs mounted by server/trials.mjs): the Studio endpoints (no
// secret ever in a response), the sign-in popup's callback, the Zapier endpoints (key auth, subscribe / unsubscribe /
// poll shapes), and durability: the outbox, the connection and the leads themselves survive a restart with an empty
// local data dir. Fakes only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { boot, client, sleep, ROOT } from './trials-helpers.mjs';
import { createKnowBotServer } from '../server.mjs';
import { startFakeCrm, HUBSPOT_PAT } from './fake-crm.mjs';
import { verifySignature } from '../crm/connectors/webhook.mjs';

const ENV = { KNOWBOT_HUBSPOT_CLIENT_ID: 'hs-client', KNOWBOT_HUBSPOT_CLIENT_SECRET: 'hs-client-secret-VALUE' };
let fake, S, C;
before(async () => {
  fake = await startFakeCrm();
  S = await boot({ env: ENV, studio: { crmNet: fake.net, crmBases: fake.bases, crmOptions: { saveMs: 0, backoffMs: () => 150 } } });
  C = client(S);
});
after(async () => { await S.close(); await fake.close(); });
const hooks = (name) => fake.state.hooks.filter((h) => h.path === `/hook/${name}`);
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(25); } };
const call = async (t, p, method, body) => { const r = await C.json(t, p, method, body); return { status: r.status, body: await r.json() }; };

describe('Studio endpoints', () => {
  test('the list of connectors; connect a webhook (secret shown once); a lead is delivered; test lead; log; mapping; disconnect', async () => {
    const t = await C.trial();
    const first = await call(t, '/crm');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.connectors.map((c) => c.id), ['webhook', 'hubspot', 'salesforce', 'pipedrive', 'zoho', 'mailchimp', 'constantcontact']);
    assert.ok(first.body.connectors.every((c) => c.connection === null && c.name && c.blurb));
    assert.equal(first.body.zapier.key, null);
    assert.equal(first.body.connectors.find((c) => c.id === 'hubspot').auth.oauth.available, true);
    assert.equal(first.body.connectors.find((c) => c.id === 'salesforce').auth.oauth.available, false);
    assert.equal(first.body.retentionDays, 90);
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}/crm`)).status, 401, 'the trial token is required');

    const url = `${fake.url}/hook/http-a?token=URLTOKEN12345`;
    const made = await call(t, '/crm/webhook/connect', 'POST', { url });
    assert.equal(made.status, 200);
    const secret = made.body.reveal.secret;
    assert.match(secret, /^whsec_/);
    const view = await call(t, '/crm');
    assert.ok(!JSON.stringify(view.body).includes(secret) && !JSON.stringify(view.body).includes('URLTOKEN12345') && !('reveal' in view.body), 'never again');
    assert.equal(view.body.connectors[0].connection.status, 'connected');

    S.kb.leads.lead({ botId: t.trialId, channel: 'web', value: 'http.lead@example.com', question: 'Is there parking?' });
    const [h] = await until(() => (hooks('http-a').length ? hooks('http-a') : null));
    assert.equal(h.body.contact.email, 'http.lead@example.com');
    assert.equal(h.body.bot.id, t.trialId);
    assert.ok(verifySignature(secret, h.raw, h.headers['x-knowbot-signature']));

    const tested = await call(t, '/crm/webhook/test', 'POST');
    assert.deepEqual([tested.status, tested.body.ok, tested.body.entry.result, tested.body.entry.test], [200, true, 'delivered', true]);
    const log = await call(t, '/crm/webhook/log');
    assert.equal(log.body.log.length, 2);
    assert.deepEqual(Object.keys(log.body.log[0]).sort(), ['action', 'at', 'attempts', 'leadId', 'result', 'test', 'who']);
    const sync = await call(t, '/crm/webhook/sync', 'POST');
    assert.deepEqual([sync.body.queued, sync.body.already], [0, 1]);

    // errors: plain words, our own codes, and never a 401 that is not ours
    const ssrf = await call(t, '/crm/webhook/connect', 'POST', { url: 'https://localhost/hook' });
    assert.deepEqual([ssrf.status, ssrf.body.error.code], [400, 'crm_blocked']);
    const badToken = await call(t, '/crm/hubspot/connect', 'POST', { token: 'pat-na1-not-a-real-token-000000' });
    assert.deepEqual([badToken.status, badToken.body.error.code], [400, 'crm_auth']);
    assert.match(badToken.body.error.message, /did not accept that/);
    assert.equal((await call(t, '/crm/nope/test', 'POST')).status, 404);
    assert.equal((await call(t, '/crm/salesforce/oauth', 'POST', {})).status, 409);
    const hs = await call(t, '/crm/hubspot/connect', 'POST', { token: HUBSPOT_PAT });
    assert.equal(hs.status, 200);
    const cfg = await call(t, '/crm/hubspot', 'PATCH', { config: { lifecycle: 'subscriber', sourceValue: 'Chatbot' } });
    assert.equal(cfg.body.connectors.find((c) => c.id === 'hubspot').connection.config.lifecycle, 'subscriber');
    assert.equal((await call(t, '/crm/hubspot', 'PATCH', { config: { ownerId: 'x' } })).status, 400);
    assert.ok(!JSON.stringify(cfg.body).includes(HUBSPOT_PAT));
    // the spec document in the store carries the connection only sealed
    await S.kb.studio.flush();
    const spec = [...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_spec.json`);
    for (const s of [secret, 'URLTOKEN12345', HUBSPOT_PAT]) assert.ok(!String(spec.text ?? spec.raw).includes(s), 'sealed at rest');
    assert.match(String(spec.text ?? spec.raw), /"sealed":/);

    const gone = await call(t, '/crm/webhook', 'DELETE');
    assert.equal(gone.body.connectors[0].connection, null);
    assert.equal((await call(t, '/crm/webhook/test', 'POST')).status, 404);
  });

  test('one-click sign-in: the popup URL, the callback page (tells the Studio, carries no token), errors', async () => {
    const t = await C.trial();
    const r = await S.api(`/api/studio/trials/${t.trialId}/crm/hubspot/oauth`, { method: 'POST', headers: { ...C.h(t), 'content-type': 'application/json', origin: 'http://studio.test' }, body: '{}' });
    const { url } = await r.json();
    const u = new URL(url);
    assert.equal(u.searchParams.get('redirect_uri'), `${S.base}/api/studio/crm/callback/hubspot`);
    const state = u.searchParams.get('state');
    const cb = await S.api(`/api/studio/crm/callback/hubspot?code=code-ok&state=${encodeURIComponent(state)}`);
    const html = await cb.text();
    assert.equal(cb.status, 200);
    assert.match(html, /"type":"knowbot:crm","ok":true,"crm":"hubspot"/);
    assert.match(html, /postMessage\(.*,o\)/);
    assert.ok(html.includes('"http://studio.test"'), 'the message goes to the Studio origin only');
    assert.ok(!/ATOK_|RTOK_|hs-client-secret/.test(html));
    assert.match(cb.headers.get('content-security-policy'), /default-src 'none'/);
    const v = await call(t, '/crm');
    assert.equal(v.body.connectors.find((c) => c.id === 'hubspot').connection.kind, 'oauth');
    const replay = await S.api(`/api/studio/crm/callback/hubspot?code=code-ok&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /already used/);
    const junk = await S.api('/api/studio/crm/callback/hubspot?code=x&state=junk');
    assert.equal(junk.status, 400);
    const denied = await S.api('/api/studio/crm/callback/zoho?error=access_denied&state=junk');
    assert.match(await denied.text(), /cancelled/);
  });
});

describe('Zapier endpoints', () => {
  test('auth test, subscribe (201 {id}), a new lead is POSTed to the hook, polling shape, unsubscribe; bad keys are 401', async () => {
    const t = await C.trial();
    const { body: { key } } = await call(t, '/crm/zapier/key', 'POST');
    assert.match(key, /^kb_zap_/);
    const z = (p, init = {}) => S.api(`/api/studio/zapier/v1${p}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers || {}) } });
    const me = await z('/me');
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { id: t.trialId, name: 'Your bot' });
    assert.equal((await S.api('/api/studio/zapier/v1/me', { headers: { 'x-api-key': key } })).status, 200, 'also as X-API-Key');
    for (const bad of ['', 'Bearer nope', `Bearer ${key}x`, `Bearer ${t.token}`]) {
      const r = await S.api('/api/studio/zapier/v1/me', { headers: bad ? { authorization: bad } : {} });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error.code, 'auth');
    }
    const sub = await z('/hooks', { method: 'POST', body: JSON.stringify({ hookUrl: `${fake.url}/hook/zap-http` }) });
    assert.equal(sub.status, 201);
    const { id } = await sub.json();
    assert.match(id, /^hk_/);
    assert.equal((await z('/hooks', { method: 'POST', body: JSON.stringify({ hookUrl: 'https://10.0.0.1/x' }) })).status, 400);
    const ev = S.kb.leads.lead({ botId: t.trialId, channel: 'sms', value: '+14155550123', question: 'Open Sunday?', consent: 'inbound_message' });
    const [h] = await until(() => (hooks('zap-http').length ? hooks('zap-http') : null));
    assert.equal(h.body.contact.phone, '+14155550123');
    const poll = await z('/leads?limit=5');
    const list = await poll.json();
    assert.ok(Array.isArray(list) && list.length === 1);
    assert.equal(list[0].id, h.body.id);
    assert.deepEqual(Object.keys(list[0]), ['event', 'id', 'createdAt', 'bot', 'channel', 'channelLabel', 'contact', 'question', 'links', 'consent', 'source', 'studioUrl']);
    assert.equal(list[0].consent.label, 'Messaged the bot from this number');
    assert.ok(ev);
    const view = await call(t, '/crm');
    assert.deepEqual([view.body.zapier.hooks.length, view.body.zapier.key.last4], [1, key.slice(-4)]);
    assert.ok(!JSON.stringify(view.body).includes(key) && !JSON.stringify(view.body).includes('/hook/zap-http'));
    const del = await z(`/hooks/${id}`, { method: 'DELETE' });
    assert.deepEqual([del.status, await del.json()], [200, { ok: true }]);
    assert.equal((await z(`/hooks/${id}`, { method: 'DELETE' })).status, 200, 'unsubscribing twice is fine');
    assert.equal((await z('/nope')).status, 404);
    await call(t, '/crm/zapier', 'DELETE');
    assert.equal((await z('/me')).status, 401, 'disconnecting revokes the key');
  });
});

describe('durability: a restart with an empty local data dir', () => {
  test('the connection, the waiting deliveries and the leads themselves come back from the store', async () => {
    const t = await C.trial();
    await call(t, '/crm/webhook/connect', 'POST', { url: `${fake.url}/hook/durable` });
    fake.failNext(/POST \/hook\/durable/, { status: 503, times: 50 });
    const short = S.kb.leads.link({ botId: t.trialId, url: 'https://shop.test/returns', channel: 'sms', kind: 'proof', cid: 'abcdefghjk', base: 'https://k.test' });
    S.kb.leads.lead({ botId: t.trialId, channel: 'web', value: 'durable@example.com', question: 'Will this survive?' });
    await until(async () => (await call(t, '/crm/webhook/log')).body.log[0]?.result === 'retrying');
    await S.kb.studio.flush();
    const names = [...S.kd.files.values()].map((f) => f.filename);
    assert.ok(names.includes(`knowbot/trials/${t.trialId}/_crm.json`) && names.includes(`knowbot/trials/${t.trialId}/_leads.jsonl`), 'beside _spec.json');
    const crmDoc = [...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_crm.json`);
    assert.ok(crmDoc.tags.includes('kind:trial-spec') && crmDoc.tags.includes('crm:pending') && crmDoc.tags.includes(`trial:${t.trialId}`), 'never searched; marked as waiting; deleted with the bot');
    const leadsDoc = [...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_leads.jsonl`);
    assert.ok(leadsDoc.tags.includes('kind:trial-spec') && leadsDoc.tags.includes('kind:trial'));

    // the old process stops delivering; a new one starts on the same store with nothing on its disk
    S.kb.studio.close();
    fake.clearFails();
    const before = hooks('durable').length;
    assert.equal(before, 0);
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-crm-restart-'));
    const kb2 = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true,
      env: { ...ENV, KNOWDRIVE_BASE_URL: S.kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret',
        LLM_BASE_URL: `${S.llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_KD_ACCOUNTS: 'off' },
      studio: { sweep: false, crmNet: fake.net, crmBases: fake.bases, resumeDelayMs: 10, crmOptions: { saveMs: 0, backoffMs: () => 150 } } });
    await new Promise((r) => kb2.server.listen(0, '127.0.0.1', r));
    try {
      const [h] = await until(() => (hooks('durable').length ? hooks('durable') : null), 10000);
      assert.equal(h.body.contact.email, 'durable@example.com', 'delivered by the new process without anyone opening the bot');
      const base2 = `http://127.0.0.1:${kb2.server.address().port}`;
      const get = async (p) => (await fetch(`${base2}/api/studio/trials/${t.trialId}${p}`, { headers: C.h(t) })).json();
      const report = await get('/leads?days=30');
      assert.deepEqual(report.leads.map((l) => l.value), ['durable@example.com'], 'the lead itself was restored');
      // short links sent before the restart still redirect (the bot's events were loaded again at start-up)
      const hop = await until(async () => { const r = await fetch(`${base2}/r/${short.split('/r/')[1]}`, { redirect: 'manual' }); return r.status === 302 ? r : null; });
      assert.match(hop.headers.get('location'), /^https:\/\/shop\.test\/returns\?utm_source=knowbot/);
      const view = await get('/crm');
      assert.equal(view.connectors[0].connection.status, 'connected');
      assert.equal((await get('/crm/webhook/log')).log[0].result, 'delivered');
      await kb2.studio.flush();
      const after = [...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_crm.json`);
      assert.ok(!after.tags.includes('crm:pending'));
      // "Start over" removes the side files with the bot
      const del = await fetch(`${base2}/api/studio/trials/${t.trialId}`, { method: 'DELETE', headers: C.h(t) });
      assert.equal(del.status, 200);
      await until(() => ![...S.kd.files.values()].some((f) => String(f.filename).startsWith(`knowbot/trials/${t.trialId}/_`)));
    } finally {
      await new Promise((r) => kb2.server.close(() => r()));
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });
});

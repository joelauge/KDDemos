// Lead delivery core (server/crm/index.mjs): the outbox (retry, backoff, idempotency, dead letters, ordering, durability
// across a restart), the webhook connector (signature, SSRF refusals), test leads, backfill, Zapier keys and REST hooks,
// and that no secret is ever in a view, a log line or a stored document. Fakes only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeCrm } from './fake-crm.mjs';
import { harness, BOT, DAY, leaks } from './crm-helpers.mjs';
import { backoffMs, MAX_ATTEMPTS, LOG_MAX } from '../crm/index.mjs';
import { verifySignature, sign } from '../crm/connectors/webhook.mjs';
import { checkHookUrl, safeRequest } from '../crm/safefetch.mjs';
import { leadIdOf, leadPayload, noteText } from '../crm/payload.mjs';
import { scrub, retryAfterMs } from '../crm/http.mjs';

let fake;
before(async () => { fake = await startFakeCrm(); });
after(async () => { await fake.close(); });
const hookUrl = (name) => `${fake.url}/hook/${name}`;
async function connected(name = 'a', opts) {
  const H = harness(fake, opts);
  const r = await H.crm.connect(H.T, 'webhook', { url: hookUrl(name) }, { origin: 'https://knowbot.app' });
  return { ...H, secret: r.reveal.secret, hooks: () => fake.state.hooks.filter((h) => h.path === `/hook/${name}`) };
}

describe('the standard lead payload', () => {
  test('a stable id, the consent label, links and UTM; only its own fields', () => {
    const ev = { kind: 'lead', bot: BOT, at: 1731240000000, type: 'email', value: 'ada@example.com', consent: 'asked_to_send', channel: 'sms', cid: 'abcdefghjk', question: 'Do you ship to Canada?' };
    const p = leadPayload(ev, { botName: 'Lumen', links: [{ url: 'https://shop.test/p?utm_source=knowbot&utm_medium=sms&utm_campaign=tr_x&kb_cid=abcdefghjk', kind: 'proof' }], answer: 'Yes, in 5 days.', studioUrl: 'https://knowbot.app/?t=x#stats' });
    assert.equal(p.id, leadIdOf(ev));
    assert.match(p.id, /^ld_[0-9a-f]{24}$/);
    assert.equal(leadIdOf({ ...ev }), p.id, 'the same lead is the same id');
    assert.notEqual(leadIdOf({ ...ev, at: ev.at + 1 }), p.id);
    assert.deepEqual(p.contact, { email: 'ada@example.com' });
    assert.deepEqual(p.consent, { code: 'asked_to_send', label: 'Asked the bot to send them the answer' });
    assert.deepEqual(p.source, { utm_source: 'knowbot', utm_medium: 'sms', utm_campaign: 'tr_x', clickId: 'abcdefghjk', page: null });
    assert.equal(p.answer.summary, 'Yes, in 5 days.');
    assert.equal(p.channelLabel, 'SMS');
    const note = noteText(p);
    assert.match(note, /Asked: Do you ship to Canada\?/);
    assert.match(note, /Consent: Asked the bot to send them the answer/);
    assert.match(note, new RegExp(`Lead id: ${p.id}`));
    assert.ok(!noteText({ ...p, question: '<b>x</b>' }, { html: true }).includes('<b>'), 'HTML notes are escaped');
  });
});

describe('webhook connector', () => {
  test('connect shows the signing secret once; the view and the bot state never carry it or the address', async () => {
    const H = harness(fake);
    const r = await H.crm.connect(H.T, 'webhook', { url: `${hookUrl('secret-path-token-9f8e7d')}?key=query-token-55aa` }, { origin: 'https://knowbot.app' });
    assert.match(r.reveal.secret, /^whsec_[\w-]{30,}$/);
    const view = JSON.stringify(await H.crm.view(H.T));
    const state = JSON.stringify(H.T.flags);
    for (const text of [view, state]) assert.deepEqual(leaks(text, [r.reveal.secret, 'secret-path-token-9f8e7d', 'query-token-55aa']), []);
    const w = (await H.crm.view(H.T)).connectors.find((c) => c.id === 'webhook');
    assert.equal(w.connection.status, 'connected');
    assert.match(w.connection.account, /^127\.0\.0\.1:\d+$/);
    assert.equal(H.T.flags.crm.connections.webhook.kind, 'url');
    assert.match(H.T.flags.crm.connections.webhook.sealed, /^[\w.-]{40,}$/);
  });

  test('a lead is POSTed as JSON with a verifiable HMAC-SHA256 signature and a stable delivery id', async () => {
    const H = await connected('sig');
    const ev = await H.lead({ value: 'grace@example.com' });
    const [h] = H.hooks();
    assert.equal(h.method, 'POST');
    assert.match(h.headers['content-type'], /application\/json/);
    assert.equal(h.headers['x-knowbot-event'], 'lead.created');
    assert.equal(h.headers['x-knowbot-delivery'], leadIdOf(ev));
    assert.ok(verifySignature(H.secret, h.raw, h.headers['x-knowbot-signature'], { now: H.clock.now() }), 'the receiver can verify it');
    assert.ok(!verifySignature(H.secret, `${h.raw} `, h.headers['x-knowbot-signature'], { now: H.clock.now() }), 'a changed body fails');
    assert.ok(!verifySignature('whsec_other', h.raw, h.headers['x-knowbot-signature'], { now: H.clock.now() }));
    assert.ok(!verifySignature(H.secret, h.raw, h.headers['x-knowbot-signature'], { now: H.clock.now() + 3600000 }), 'an old signature fails');
    assert.equal(sign('k', 'body', 1), sign('k', 'body', 1));
    assert.equal(h.body.event, 'lead.created');
    assert.equal(h.body.contact.email, 'grace@example.com');
    assert.equal(h.body.consent.label, 'Asked the bot to send them the answer');
    assert.equal(h.body.bot.name, 'Lumen Helper');
    assert.equal(h.body.studioUrl, `https://knowbot.app/?t=${BOT}#stats`);
  });

  test('SSRF: only public https addresses, checked again after DNS and on every redirect', async () => {
    for (const bad of ['http://example.com/hook', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.8/x', 'https://192.168.1.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x',
      'https://[fd00:ec2::254]/x', 'https://user:pw@example.com/x', 'https://example.com:8443/x', 'https://intranet/x', 'https://db.internal/x', 'ftp://example.com/x', 'not a url', '']) {
      assert.throws(() => checkHookUrl(bad), (e) => e.code === 'blocked', bad);
    }
    assert.equal(checkHookUrl('https://hooks.zapier.com/hooks/catch/1/abc/').host, 'hooks.zapier.com');
    // a public-looking name that resolves to a private address is refused before any socket opens
    await assert.rejects(safeRequest('https://rebind.example.com/x', { net: { resolve: async () => [{ address: '10.1.2.3', family: 4 }] } }), (e) => e.code === 'blocked');
    await assert.rejects(safeRequest('https://mixed.example.com/x', { net: { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] } }), (e) => e.code === 'blocked', 'every address is checked');
    // a redirect to the metadata address is refused; 307 to an allowed address is followed with the body; a 302 is not followed
    await assert.rejects(safeRequest(`${fake.url}/redirect-private`, { net: fake.net, body: '{}' }), (e) => e.code === 'blocked');
    const n = fake.state.hooks.length;
    const ok = await safeRequest(`${fake.url}/redirect-hook`, { net: fake.net, body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    assert.equal(ok.status, 200);
    assert.equal(fake.state.hooks[n].raw, '{"a":1}');
    await assert.rejects(safeRequest(`${fake.url}/redirect-302`, { net: fake.net, body: '{}' }), (e) => e.code === 'invalid');
    // the connector refuses a private address at connect time, in plain words
    const H = harness(fake, { crm: { net: {} } });
    await assert.rejects(H.crm.connect(H.T, 'webhook', { url: 'https://192.168.0.10/hook' }), (e) => e.code === 'blocked' && /public internet/.test(e.message));
    await assert.rejects(H.crm.connect(H.T, 'webhook', { url: 'http://example.com/hook' }), (e) => e.code === 'blocked' && /https/.test(e.message));
  });

  test('helpers: secrets are scrubbed from text; Retry-After is read as seconds or a date', () => {
    assert.equal(scrub('failed with Bearer abcdef0123456789 and tok_SECRETVALUE', ['tok_SECRETVALUE']), 'failed with Bearer [hidden] and [hidden]');
    assert.equal(scrub('https://x.test/?api_token=abc123&x=1'), 'https://x.test/?api_token=[hidden]&x=1');
    assert.equal(retryAfterMs('7'), 7000);
    assert.equal(retryAfterMs('99999'), 3600000);
    assert.equal(retryAfterMs(new Date(5000).toUTCString(), 0), 5000);
    assert.equal(retryAfterMs(''), null);
  });
});

describe('the outbox', () => {
  test('only leads are delivered; a bot with no connection queues nothing', async () => {
    const H = harness(fake);
    await H.lead();
    assert.equal(H.docs.size, 0, 'nothing connected: nothing stored');
    const C = await connected('only-leads');
    C.leads.agent({ botId: BOT, question: 'a plain question' });
    C.leads.checkout({ botId: BOT, phone: '+14155550101', items: [{ title: 'Bike' }] });
    C.leads.link({ botId: BOT, url: 'https://shop.test/a', base: 'https://k.test' });
    await C.crm.onLead({ kind: 'agent', bot: BOT, at: C.clock.now() });
    await C.crm.idle();
    assert.equal(C.hooks().length, 0);
    await C.lead();
    assert.equal(C.hooks().length, 1);
  });

  test('retry with exponential backoff, the vendor’s Retry-After, then delivered; the log shows one row per lead', async () => {
    const H = await connected('retry');
    fake.failNext(/POST \/hook\/retry/, { status: 500, times: 2 });
    await H.lead();
    assert.equal(H.hooks().length, 0);
    let q = H.doc().queue;
    assert.equal(q.length, 1);
    assert.equal(q[0].attempts, 1);
    assert.equal(q[0].nextAt - H.clock.now(), backoffMs(1));
    assert.equal(H.pending.has(BOT), true, 'the stored document is marked as waiting');
    let log = (await H.crm.logOf(H.T, 'webhook')).log;
    assert.equal(log.length, 1);
    assert.equal(log[0].result, 'retrying');
    assert.match(log[0].error, /problem on its side \(500\)/);
    await H.crm.tick(); await H.crm.idle();
    assert.equal(H.doc().queue[0].attempts, 1, 'not due yet: not tried');
    H.clock.advance(backoffMs(1));
    await H.crm.tick(); await H.crm.idle();
    q = H.doc().queue;
    assert.equal(q[0].attempts, 2);
    assert.equal(q[0].nextAt - H.clock.now(), backoffMs(2));
    assert.equal(backoffMs(2), 2 * backoffMs(1));
    assert.equal(backoffMs(40), 6 * 3600000, 'capped');
    // a 429 with Retry-After waits at least that long
    fake.failNext(/POST \/hook\/retry/, { status: 429, headers: { 'retry-after': '1800' } });
    H.clock.advance(backoffMs(2));
    await H.crm.tick(); await H.crm.idle();
    assert.equal(H.doc().queue[0].nextAt - H.clock.now(), 1800000);
    H.clock.advance(1800000);
    await H.crm.tick(); await H.crm.idle();
    assert.equal(H.hooks().length, 1);
    assert.equal(H.doc().queue.length, 0);
    assert.equal(H.pending.has(BOT), false);
    log = (await H.crm.logOf(H.T, 'webhook')).log;
    assert.equal(log.length, 1, 'one row per lead, updated');
    assert.equal(log[0].result, 'delivered');
    assert.equal(log[0].attempts, 4);
    assert.match(log[0].who, /^ad…@example\.com$/);
  });

  test('ordered per bot: a lead waiting for its retry holds back the ones behind it', async () => {
    const H = await connected('order');
    fake.failNext(/POST \/hook\/order/, { status: 503 });
    const a = await H.lead({ value: 'first@example.com' });
    H.clock.advance(1000);
    const b = await H.lead({ value: 'second@example.com' });
    H.clock.advance(1000);
    const c = await H.lead({ value: 'third@example.com' });
    assert.equal(H.hooks().length, 0, 'nothing overtakes the waiting lead');
    assert.deepEqual(H.doc().queue.map((i) => i.lead.id), [a, b, c].map(leadIdOf));
    H.clock.advance(backoffMs(1));
    await H.crm.tick(); await H.crm.idle();
    assert.deepEqual(H.hooks().map((h) => h.body.contact.email), ['first@example.com', 'second@example.com', 'third@example.com']);
  });

  test('idempotent: the same lead is never queued or delivered twice, not by a duplicate event, a re-sync or a restart', async () => {
    const H = await connected('idem');
    const ev = await H.lead();
    await H.crm.onLead(ev); await H.crm.onLead(ev);
    await H.crm.idle();
    assert.equal(H.hooks().length, 1);
    const s = await H.crm.sync(H.T, 'webhook');
    await H.crm.idle();
    assert.deepEqual({ queued: s.queued, already: s.already }, { queued: 0, already: 1 });
    // a new server process with the same stored documents
    H.crm.detach(); H.crm.close();
    const again = H.make();
    await again.onLead(ev);
    await again.idle();
    assert.equal(H.hooks().length, 1);
    assert.equal(H.hooks()[0].headers['x-knowbot-delivery'], leadIdOf(ev));
  });

  test('dead letters: after the last attempt (or at once for an answer retrying cannot fix), with the last error; Retry failed puts them back in order', async () => {
    const H = await connected('dead', { crm: { maxAttempts: 3 } });
    fake.failNext(/POST \/hook\/dead/, { status: 500, times: 3 });
    const ev = await H.lead({ value: 'stuck@example.com' });
    for (let i = 1; i < 3; i++) { H.clock.advance(backoffMs(i)); await H.crm.tick(); await H.crm.idle(); }
    let d = H.doc();
    assert.equal(d.queue.length, 0);
    assert.equal(d.dead.length, 1);
    assert.equal(d.dead[0].attempts, 3);
    assert.equal(d.dead[0].lastError.code, 'upstream');
    assert.match(d.dead[0].lastError.message, /problem on its side/);
    let v = (await H.crm.view(H.T)).connectors.find((c) => c.id === 'webhook').connection;
    assert.equal(v.status, 'attention');
    assert.equal(v.failed, 1);
    assert.match(v.problem.message, /1 lead could not be delivered/);
    assert.equal((await H.crm.logOf(H.T, 'webhook')).log[0].result, 'failed');
    // a dead-lettered lead is not queued again by a duplicate event
    await H.crm.onLead(ev); await H.crm.idle();
    assert.equal(H.doc().queue.length, 0);
    // a 400 is final at once and does not block the next lead
    fake.failNext(/POST \/hook\/dead/, { status: 400 });
    H.clock.advance(1000);
    await H.lead({ value: 'rejected@example.com' });
    H.clock.advance(1000);
    await H.lead({ value: 'fine@example.com' });
    d = H.doc();
    assert.equal(d.dead.length, 2);
    assert.equal(d.dead[1].attempts, 1);
    assert.equal(d.dead[1].lastError.code, 'invalid');
    assert.deepEqual(H.hooks().map((h) => h.body.contact.email), ['fine@example.com']);
    const r = await H.crm.retryFailed(H.T, 'webhook');
    await H.crm.idle();
    assert.equal(r.retried, 2);
    assert.deepEqual(H.hooks().map((h) => h.body.contact.email), ['fine@example.com', 'stuck@example.com', 'rejected@example.com'], 'oldest first');
    v = (await H.crm.view(H.T)).connectors.find((c) => c.id === 'webhook').connection;
    assert.equal(v.status, 'connected');
    assert.equal(MAX_ATTEMPTS, 10);
  });

  test('durable across a restart: queued leads are in the stored document and a new process delivers them', async () => {
    const H = await connected('restart');
    fake.failNext(/POST \/hook\/restart/, { status: 502, times: 1 });
    await H.lead({ value: 'one@example.com' });
    H.clock.advance(500);
    await H.lead({ value: 'two@example.com' });
    assert.equal(JSON.parse(H.docs.get(BOT)).queue.length, 2, 'both are on disk');
    assert.ok(H.pending.has(BOT));
    H.crm.detach(); H.crm.close(); // the process dies
    const next = H.make();
    assert.deepEqual(await next.resume(), { resumed: 1 });
    await next.idle();
    assert.equal(H.hooks().length, 0, 'the retry time survives the restart too');
    H.clock.advance(backoffMs(1));
    await next.tick(); await next.idle();
    assert.deepEqual(H.hooks().map((h) => h.body.contact.email), ['one@example.com', 'two@example.com']);
    assert.equal(JSON.parse(H.docs.get(BOT)).queue.length, 0);
    assert.equal(H.pending.has(BOT), false);
  });

  test('the delivery log keeps the last 50, newest first, and never a full address or a secret', async () => {
    const H = await connected('log');
    for (let i = 0; i < LOG_MAX + 5; i++) { H.clock.advance(1000); H.leads.lead({ botId: BOT, value: `person${i}@example.com`, question: `q${i}`, at: H.clock.now() }); }
    await H.crm.idle();
    const { log } = await H.crm.logOf(H.T, 'webhook');
    assert.equal(log.length, LOG_MAX);
    assert.ok(log[0].at >= log[1].at);
    assert.ok(log.every((r) => r.result === 'delivered' && /^pe…@example\.com$/.test(r.who) && !('key' in r)));
    assert.deepEqual(leaks(JSON.stringify(log) + H.logs.join('\n'), [H.secret, 'person3@example.com', '/hook/log']), []);
    assert.deepEqual(leaks(H.docs.get(BOT), [H.secret, '/hook/log']), [], 'the stored outbox holds leads, never connection secrets');
  });

  test('Send a test lead: delivered now, marked as a test, logged; a failure says what to do', async () => {
    const H = await connected('test');
    const r = await H.crm.test(H.T, 'webhook');
    assert.equal(r.ok, true);
    assert.equal(r.entry.result, 'delivered');
    assert.equal(r.entry.test, true);
    const [h] = H.hooks();
    assert.equal(h.headers['x-knowbot-event'], 'lead.test');
    assert.equal(h.body.test, true);
    assert.equal(h.body.contact.email, 'test.lead@knowbot.app');
    fake.failNext(/POST \/hook\/test/, { status: 404 });
    const bad = await H.crm.test(H.T, 'webhook');
    assert.equal(bad.ok, false);
    assert.match(bad.entry.error, /answered 404/);
    assert.match(bad.entry.action, /Check that the address is right/);
    assert.equal(H.doc().queue.length, 0, 'a test is never queued or retried');
    await assert.rejects(H.crm.test(H.T, 'hubspot'), (e) => e.code === 'not_found');
  });

  test('Sync past leads: the last 90 days, oldest first, with the links that were sent; nothing older', async () => {
    const H = harness(fake);
    const t0 = H.clock.now();
    const cid = 'abcdefghjk';
    H.leads.link({ botId: BOT, url: 'https://shop.test/returns', channel: 'sms', kind: 'proof', cid, base: 'https://k.test/api' });
    H.leads.lead({ botId: BOT, value: '+14155550111', channel: 'sms', cid, question: 'Returns?', at: t0 - 3 * DAY });
    H.leads.lead({ botId: BOT, value: 'old@example.com', at: t0 - 80 * DAY, question: 'older' });
    H.leads.lead({ botId: BOT, value: 'ancient@example.com', at: t0 - 120 * DAY });
    H.leads.lead({ botId: BOT, value: '+14155550122', channel: 'phone', consent: 'callback_request', name: 'Sam Doe', note: 'after 5pm', at: t0 - DAY });
    await H.crm.idle(); // those leads arrived while nothing was connected
    await H.crm.connect(H.T, 'webhook', { url: hookUrl('sync') });
    await H.crm.idle();
    const before = fake.state.hooks.filter((h) => h.path === '/hook/sync').length;
    assert.equal(before, 0, 'connecting sends nothing by itself');
    const r = await H.crm.sync(H.T, 'webhook');
    await H.crm.idle();
    assert.equal(r.queued, 3);
    assert.equal(r.days, 90);
    const got = fake.state.hooks.filter((h) => h.path === '/hook/sync').map((h) => h.body);
    assert.deepEqual(got.map((b) => b.contact.email || b.contact.phone), ['old@example.com', '+14155550111', '+14155550122']);
    assert.equal(got[1].links.length, 1);
    assert.match(got[1].links[0].url, /^https:\/\/shop\.test\/returns\?utm_source=knowbot&utm_medium=sms/);
    assert.equal(got[1].source.clickId, cid);
    assert.deepEqual(got[2].contact, { phone: '+14155550122', name: 'Sam Doe' });
    assert.equal(got[2].consent.label, 'Asked for a callback (voice)');
    assert.equal(got[2].note, 'after 5pm');
    assert.equal((await H.crm.sync(H.T, 'webhook')).queued, 0, 'a second sync sends nothing new');
  });

  test('disconnect: the connection, its queue and its log go; later leads are not sent', async () => {
    const H = await connected('bye');
    fake.failNext(/POST \/hook\/bye/, { status: 500 });
    await H.lead();
    await H.crm.disconnect(H.T, 'webhook');
    assert.equal(H.T.flags.crm.connections.webhook, undefined);
    assert.equal(H.doc().queue.length, 0);
    assert.deepEqual((await H.crm.logOf(H.T, 'webhook')).log, []);
    H.clock.advance(backoffMs(1));
    await H.lead({ value: 'later@example.com' });
    await H.crm.tick(); await H.crm.idle();
    assert.equal(H.hooks().length, 0);
    assert.equal((await H.crm.view(H.T)).connectors.find((c) => c.id === 'webhook').connection, null);
  });
});

describe('Zapier: a per-bot key and REST hooks', () => {
  test('the key is shown once, authenticates only this bot, and a new key (or disconnect) revokes the old one', async () => {
    const H = harness(fake);
    const { key } = await H.crm.zapier.newKey(H.T);
    assert.match(key, /^kb_zap_[\w-]+\.[\w-]+$/);
    assert.equal((await H.crm.zapier.auth(key)).id, BOT);
    assert.deepEqual(H.crm.zapier.me(H.T), { id: BOT, name: 'Lumen Helper' });
    const v = await H.crm.view(H.T);
    assert.equal(v.zapier.key.last4, key.slice(-4));
    assert.deepEqual(leaks(JSON.stringify(v) + JSON.stringify(H.T.flags), [key]), [], 'only the last four characters are kept');
    for (const bad of ['', 'kb_zap_x.y', `${key}x`, key.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'kb_live_abcdefghijklmnopqrstuvwxyz']) await assert.rejects(H.crm.zapier.auth(bad), (e) => e.code === 'auth' && e.status === 401, bad);
    const second = await H.crm.zapier.newKey(H.T);
    await assert.rejects(H.crm.zapier.auth(key), (e) => e.code === 'auth');
    assert.equal((await H.crm.zapier.auth(second.key)).id, BOT);
    await H.crm.disconnect(H.T, 'zapier');
    await assert.rejects(H.crm.zapier.auth(second.key), (e) => e.code === 'auth');
  });

  test('subscribe → new leads are POSTed to the hook; unsubscribe stops them; a 410 removes the hook; polling is newest first with stable ids', async () => {
    const H = harness(fake);
    await H.crm.zapier.newKey(H.T);
    const sub = await H.crm.zapier.subscribe(H.T, hookUrl('zap1'));
    assert.match(sub.id, /^hk_[\w-]+$/);
    assert.deepEqual(await H.crm.zapier.subscribe(H.T, hookUrl('zap1')), sub, 'subscribing the same address twice is one hook');
    const sub2 = await H.crm.zapier.subscribe(H.T, hookUrl('zap2'));
    await assert.rejects(H.crm.zapier.subscribe(H.T, 'https://10.0.0.1/hooks'), (e) => e.code === 'blocked');
    assert.deepEqual(leaks(JSON.stringify(await H.crm.view(H.T)) + JSON.stringify(H.T.flags), ['/hook/zap1']), [], 'hook addresses are sealed');
    const ev = await H.lead({ value: 'zed@example.com' });
    const at = (n) => fake.state.hooks.filter((h) => h.path === `/hook/${n}`);
    assert.equal(at('zap1').length, 1);
    assert.equal(at('zap2').length, 1);
    assert.equal(at('zap1')[0].body.id, leadIdOf(ev));
    assert.equal(at('zap1')[0].headers['x-knowbot-signature'], undefined, 'REST hooks are not signed: the address is the secret');
    // the polling fallback / sample: an array, newest first, the same ids as the hook
    H.clock.advance(1000);
    const ev2 = await H.lead({ value: 'newer@example.com' });
    const recent = await H.crm.zapier.recent(H.T, { limit: 10 });
    assert.ok(Array.isArray(recent));
    assert.deepEqual(recent.map((r) => r.id), [leadIdOf(ev2), leadIdOf(ev)]);
    assert.deepEqual(Object.keys(recent[0]).slice(0, 4), ['event', 'id', 'createdAt', 'bot']);
    assert.deepEqual(await H.crm.zapier.recent(H.T), recent, 'stable between polls');
    // unsubscribe one; the other answers 410 Gone and is removed
    assert.deepEqual(await H.crm.zapier.unsubscribe(H.T, sub.id), { ok: true });
    fake.failNext(/POST \/hook\/zap2/, { status: 410 });
    H.clock.advance(1000);
    await H.lead({ value: 'third@example.com' });
    assert.equal(at('zap1').length, 2);
    assert.equal(H.T.flags.crm.zapier.hooks.length, 0);
    assert.equal(H.doc().queue.length, 0);
    void sub2;
    // no leads yet: one clearly marked sample so the Zap editor has fields to map
    const E = harness(fake);
    await E.crm.zapier.newKey(E.T);
    const sample = await E.crm.zapier.recent(E.T);
    assert.equal(sample.length, 1);
    assert.equal(sample[0].test, true);
  });
});

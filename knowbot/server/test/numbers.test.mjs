// KnowBot numbers (server/numbers.mjs): search, quote, pay in place, buy after payment only and exactly once, credit
// drawn down per text and per call minute, out-of-credit behaviour, persistence across a restart. Fakes only: a fake
// number provider (fake-twilio.mjs), fake payments (fake-stripe.mjs), fake knowDrive and model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { startFakeTwilio } from './fake-twilio.mjs';
import { startFakeStripe } from './fake-stripe.mjs';
import { twilioSignature } from '../channels/util.mjs';
import { twilioRest } from '../channels/voice-live.mjs';
import { ratesOf, quoteOf, packOf, signStripe, stripeSignatureValid, stripeForm, PACKS, SERVICE_CENTS, MARKUP } from '../numbers.mjs';
import { PHONE_NO_CREDIT } from '../channels/voice.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 20;
const nextIp = () => `203.0.113.${ipSeq++ % 250}`;
const WHSEC = 'whsec_test_numbers';

describe('numbers: pricing math', () => {
  test('price = $10/mo service + number cost x 1.2; credit rates are cost x 1.2; packs say what they buy', () => {
    const r = ratesOf({ monthly: 1.15, minute: 0.0085, text: 0.0083 });
    assert.equal(SERVICE_CENTS, 1000);
    assert.equal(MARKUP, 1.2);
    assert.equal(r.numberCents, 138, '$1.15 x 1.2 = $1.38');
    assert.equal(r.minuteMicros, 10200, '$0.0085 x 1.2 = $0.0102 a minute');
    assert.equal(r.textMicros, 9960, '$0.0083 x 1.2 = $0.00996 a text');
    const q = quoteOf(r, 2500);
    assert.deepEqual(q.lines.map((l) => [l.id, l.cents, l.interval]), [['service', 1000, 'month'], ['number', 138, 'month'], ['credit', 2500, null]]);
    assert.equal(q.monthlyCents, 1138);
    assert.equal(q.todayCents, 3638);
    assert.deepEqual(PACKS, [1000, 2500, 5000]);
    assert.deepEqual(packOf(1000, r), { cents: 1000, minutes: 980, texts: 1004 });
    assert.equal(q.packs.length, 3);
  });
  test('Stripe signatures: valid, tampered, wrong secret, stale timestamp; nested form encoding', () => {
    const raw = '{"a":1}';
    const now = Date.now();
    const h = signStripe(raw, WHSEC, Math.floor(now / 1000));
    assert.ok(stripeSignatureValid(raw, h, WHSEC, { nowMs: now }));
    assert.ok(!stripeSignatureValid('{"a":2}', h, WHSEC, { nowMs: now }), 'tampered body');
    assert.ok(!stripeSignatureValid(raw, h, 'whsec_other', { nowMs: now }), 'wrong secret');
    assert.ok(!stripeSignatureValid(raw, h, WHSEC, { nowMs: now + 301000 }), 'older than 5 minutes');
    assert.ok(!stripeSignatureValid(raw, '', WHSEC, { nowMs: now }));
    assert.ok(stripeSignatureValid(raw, `${h},v1=deadbeef`, WHSEC, { nowMs: now }), 'any one v1 may match (secret rotation)');
    assert.equal(stripeForm({ a: [{ b: { c: 1 } }], m: { k: 'v' } }).toString(), 'a%5B0%5D%5Bb%5D%5Bc%5D=1&m%5Bk%5D=v');
  });
});

describe('numbers: in-Studio provisioning (fake provider, fake payments)', () => {
  let kd, llm, tw, st;
  const dataDirs = [], servers = [];
  const env = (extra = {}) => ({ KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen',
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tw-secret', TWILIO_API_BASE_URL: tw.url, TWILIO_PRICING_BASE_URL: tw.url, GEMINI_API_KEY: 'fake-gemini',
    STRIPE_SECRET_KEY: 'sk_fake_numbers', STRIPE_PUBLISHABLE_KEY: 'pk_fake_numbers', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE_URL: st.url, ...extra });
  async function instance(envExtra = {}) {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-numbers-'));
    dataDirs.push(dataDir);
    const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: env(envExtra), studio: { sweep: false, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 } });
    await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${kb.server.address().port}`;
    const S = { kb, base, api: (p, init = {}) => fetch(base + p, init), close: () => new Promise((r) => (kb.server.listening ? kb.server.close(() => r()) : r())) };
    servers.push(S);
    return S;
  }
  async function trial(S) {
    const ip = nextIp();
    const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } });
    assert.equal(r.status, 201);
    return { ...(await r.json()), ip };
  }
  const call = (S, t, p, method = 'GET', body) => S.api(`/api/studio/trials/${t.trialId}/number${p}`, { method,
    headers: { authorization: `Bearer ${t.token}`, 'x-forwarded-for': t.ip, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = async (r, status = 200) => { const x = await r.json(); assert.equal(r.status, status, JSON.stringify(x)); return x; };
  const hook = (S, raw, header) => S.api('/api/studio/numbers/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: raw });
  const specOf = async (t) => JSON.parse(await (await fetch(`${kd.url}/api/v1/vector_stores/vs_fake_trials/path/content/knowbot/trials/${t.trialId}/_spec.json`, { headers: { authorization: 'Bearer x' } })).text());
  /** A signed incoming SMS to the bot's webhook, as the provider sends it. */
  async function sms(S, t, body, from = '+14155550199') {
    const p = `/api/v1/channels/${t.trialId}/sms`;
    const params = { MessageSid: `SM${Math.random().toString(36).slice(2)}`, From: from, To: '+14155550100', Body: body };
    return S.api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('tw-secret', `${S.base}${p}`, params) }, body: new URLSearchParams(params).toString() });
  }
  async function voice(S, t, from = '+14155550199') {
    const p = `/api/v1/channels/${t.trialId}/voice`;
    const params = { CallSid: `CA${Math.random().toString(36).slice(2)}`, From: from, To: '+14155550100' };
    return S.api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('tw-secret', `${S.base}${p}`, params) }, body: new URLSearchParams(params).toString() });
  }
  /** Search → checkout → pay at the fake → return. */
  async function provision(S, t, { area = '415', pack = 1000, via = 'return' } = {}) {
    const found = await j(await call(S, t, `/search?areaCode=${area}`));
    const pick = found.numbers[0];
    const co = await j(await call(S, t, '/checkout', 'POST', { phoneNumber: pick.phoneNumber, pack, locality: pick.locality, region: pick.region }));
    st.complete(co.sessionId);
    if (via === 'return') return { pick, co, conf: await j(await call(S, t, '/confirm', 'POST', { sessionId: co.sessionId })) };
    const { raw, header } = st.event('checkout.session.completed', st.sessions.get(co.sessionId), WHSEC);
    await j(await hook(S, raw, header));
    return { pick, co };
  }

  before(async () => {
    kd = await startFakeKnowDrive({ speed: 3, narrowScope: 'all' });
    llm = await startFakeLLM({ slowMs: 9000 });
    tw = await startFakeTwilio();
    st = await startFakeStripe();
  });
  after(async () => { for (const x of servers) await x.close(); await kd.close(); await llm.close(); await tw.close(); await st.close(); for (const d of dataDirs) await fsp.rm(d, { recursive: true, force: true }); });

  test('off unless the payment and number keys are all set: the Studio shows coming soon, nothing reaches a provider', async () => {
    const S = await instance({ STRIPE_SECRET_KEY: '' });
    const t = await trial(S);
    assert.deepEqual(await j(await call(S, t, '')), { enabled: false });
    const n = tw.requests.length, m = st.requests.length;
    const r = await call(S, t, '/checkout', 'POST', { phoneNumber: '+14155550100', pack: 1000 });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'numbers_off');
    assert.equal(tw.requests.length, n); assert.equal(st.requests.length, m);
    await S.close();
  });

  test('search lists numbers with their town; the quote is $10 + number cost x 1.2, with packs', async () => {
    const S = await instance();
    const t = await trial(S);
    const s = await j(await call(S, t, ''));
    assert.equal(s.enabled, true);
    assert.equal(s.publishableKey, 'pk_fake_numbers');
    assert.equal(s.number, null);
    const r = await j(await call(S, t, '/search?areaCode=415'));
    assert.ok(r.numbers.length >= 3);
    assert.match(r.numbers[0].phoneNumber, /^\+1415/);
    assert.equal(r.numbers[0].locality, 'San Francisco');
    assert.match(r.numbers[0].display, /^\(415\) 555-\d{4}$/);
    const q = tw.requests.find((x) => /AvailablePhoneNumbers\/US\/Local\.json/.test(x.path));
    assert.equal(q.query.AreaCode, '415'); assert.equal(q.query.SmsEnabled, 'true'); assert.equal(q.query.VoiceEnabled, 'true');
    // pricing came from the provider's pricing API: 1.15 → 1.38; texts at the dearest carrier (0.0083 in) x 1.2
    assert.equal(r.quote.lines.find((l) => l.id === 'service').cents, 1000);
    assert.equal(r.quote.lines.find((l) => l.id === 'number').cents, 138);
    assert.equal(r.quote.monthlyCents, 1138);
    assert.equal(r.quote.rates.minuteCents, 1.02);
    assert.equal(r.quote.rates.textCents, 0.996);
    assert.equal((await call(S, t, '/search?areaCode=41')).status, 400, 'an area code has 3 digits');
    const city = await j(await call(S, t, '/search?city=Chicago'));
    assert.ok(city.numbers.every((n) => n.phoneNumber.startsWith('+1312')));
    await S.close();
  });

  test('checkout: embedded, subscription with $10 service + number x 1.2 monthly + the one-time pack; nothing is bought before payment', async () => {
    const S = await instance();
    const t = await trial(S);
    tw.reset();
    const pick = (await j(await call(S, t, '/search?areaCode=212'))).numbers[1];
    assert.equal((await call(S, t, '/checkout', 'POST', { phoneNumber: pick.phoneNumber, pack: 1500 })).status, 400, 'only the fixed packs');
    const co = await j(await call(S, t, '/checkout', 'POST', { phoneNumber: pick.phoneNumber, pack: 2500 }));
    assert.match(co.clientSecret, /_secret_/);
    const s = st.sessions.get(co.sessionId);
    assert.equal(s.ui_mode, 'embedded'); assert.equal(s.mode, 'subscription'); assert.equal(s.redirect_on_completion, 'never');
    const li = s.line_items.map((x) => ({ amount: Number(x.price_data.unit_amount), interval: x.price_data.recurring?.interval || null, name: x.price_data.product_data.name }));
    assert.deepEqual(li.map((x) => [x.amount, x.interval]), [[1000, 'month'], [138, 'month'], [2500, null]]);
    assert.ok(li.every((x) => !/twilio|stripe/i.test(x.name)), 'the vendor is never named on the receipt');
    assert.equal(s.amount_total, 3638);
    assert.equal(s.metadata.app, 'knowbot'); assert.equal(s.metadata.trial, t.trialId); assert.equal(s.metadata.phone, pick.phoneNumber);
    assert.equal(st.requests.at(-1).version, '2024-06-20');
    assert.equal(tw.purchases().length, 0, 'no number bought at checkout');
    // confirming an unpaid session buys nothing
    const c0 = await j(await call(S, t, '/confirm', 'POST', { sessionId: co.sessionId }));
    assert.equal(c0.paid, false);
    assert.equal(tw.purchases().length, 0, 'no number bought before payment');
    // a session for another bot is never applied here
    const t2 = await trial(S);
    assert.equal((await call(S, t2, '/confirm', 'POST', { sessionId: co.sessionId })).status, 404);
    await S.close();
  });

  test('after payment the number is bought exactly once (return + webhook + replays), pointed at the bot, with its credit', async () => {
    const S = await instance();
    const t = await trial(S);
    tw.reset();
    const { pick, co, conf } = await provision(S, t, { area: '415', pack: 2500 });
    assert.equal(conf.paid, true);
    assert.equal(conf.state.state, 'active');
    assert.equal(conf.state.phoneNumber, pick.phoneNumber);
    assert.equal(conf.state.balanceCents, 2500);
    assert.equal(conf.state.monthlyCents, 1138);
    // the webhook for the same session, twice, and another return: nothing more is bought or credited
    const { raw, header } = st.event('checkout.session.completed', st.sessions.get(co.sessionId), WHSEC);
    await j(await hook(S, raw, header));
    await j(await hook(S, raw, header));
    const again = await j(await call(S, t, '/confirm', 'POST', { sessionId: co.sessionId }));
    assert.equal(again.already, true);
    assert.equal(tw.purchases().length, 1, 'bought once');
    assert.equal(again.state.balanceCents, 2500, 'credited once');
    // the number answers this bot: SMS and voice webhooks, POST
    const buy = tw.purchases()[0].form;
    assert.equal(buy.PhoneNumber, pick.phoneNumber);
    assert.equal(buy.SmsUrl, `${S.base}/api/v1/channels/${t.trialId}/sms`);
    assert.equal(buy.VoiceUrl, `${S.base}/api/v1/channels/${t.trialId}/voice`);
    assert.equal(buy.SmsMethod, 'POST'); assert.equal(buy.VoiceMethod, 'POST');
    // a second number for the same bot is refused
    assert.equal((await call(S, t, '/checkout', 'POST', { phoneNumber: '+14155550111', pack: 1000 })).status, 409);
    await S.close();
  });

  test('webhook only (the tab was closed): the paid session is applied; bad signatures and other apps are refused or ignored', async () => {
    const S = await instance();
    const t = await trial(S);
    tw.reset();
    const pick = (await j(await call(S, t, '/search?areaCode=312'))).numbers[0];
    const co = await j(await call(S, t, '/checkout', 'POST', { phoneNumber: pick.phoneNumber, pack: 1000 }));
    st.complete(co.sessionId);
    const sess = st.sessions.get(co.sessionId);
    // forged / wrong secret / stale: 400, nothing bought
    const bad = st.event('checkout.session.completed', sess, 'whsec_wrong');
    assert.equal((await hook(S, bad.raw, bad.header)).status, 400);
    const stale = st.event('checkout.session.completed', sess, WHSEC, Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await hook(S, stale.raw, stale.header)).status, 400);
    const good = st.event('checkout.session.completed', sess, WHSEC);
    assert.equal((await hook(S, good.raw.replace(pick.phoneNumber, '+14155550000'), good.header)).status, 400, 'a tampered body');
    assert.equal(tw.purchases().length, 0);
    // a KnowDrive.ai checkout in the same payments account: acknowledged and ignored
    const other = st.event('checkout.session.completed', { id: 'cs_test_other', status: 'complete', payment_status: 'paid', metadata: { plan: 'knowdrive' } }, WHSEC);
    assert.equal((await j(await hook(S, other.raw, other.header))).ignored, true);
    await j(await hook(S, good.raw, good.header));
    assert.equal(tw.purchases().length, 1);
    const s = await j(await call(S, t, ''));
    assert.equal(s.number.state, 'active'); assert.equal(s.number.phoneNumber, pick.phoneNumber); assert.equal(s.number.balanceCents, 1000);
    await S.close();
  });

  test('taken while paying: the closest free number in the same area code; none free: refunded and the plan cancelled', async () => {
    const S = await instance();
    const t = await trial(S);
    tw.reset();
    const list = (await j(await call(S, t, '/search?areaCode=512'))).numbers;
    const co = await j(await call(S, t, '/checkout', 'POST', { phoneNumber: list[0].phoneNumber, pack: 1000 }));
    tw.take(list[0].phoneNumber);
    st.complete(co.sessionId);
    const c = await j(await call(S, t, '/confirm', 'POST', { sessionId: co.sessionId }));
    assert.equal(c.state.state, 'active');
    assert.notEqual(c.state.phoneNumber, list[0].phoneNumber);
    assert.match(c.state.phoneNumber, /^\+1512/);
    assert.match(c.state.note, /was taken while you paid/);
    assert.ok(c.state.requested);

    const t2 = await trial(S);
    const l2 = (await j(await call(S, t2, '/search?areaCode=604'))).numbers;
    const co2 = await j(await call(S, t2, '/checkout', 'POST', { phoneNumber: l2[0].phoneNumber, pack: 1000, country: 'CA' }));
    tw.takeArea('604');
    st.complete(co2.sessionId);
    const before = st.refunds.length;
    const c2 = await j(await call(S, t2, '/confirm', 'POST', { sessionId: co2.sessionId }));
    assert.equal(c2.state.state, 'refunded');
    assert.match(c2.state.note, /refunded/);
    assert.equal(st.refunds.length, before + 1);
    assert.equal(st.cancelled.at(-1), st.sessions.get(co2.sessionId).subscription);
    await S.close();
  });

  test('credit: texts are charged per segment in and out, calls per minute (rounded up); out of credit: no text reply, calls declined', async () => {
    const S = await instance();
    const t = await trial(S);
    tw.reset();
    await provision(S, t, { area: '415', pack: 1000 });
    const r = await sms(S, t, 'What are your opening hours?');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<Message>/);
    await sleep(50);
    let s = (await j(await call(S, t, ''))).number;
    // 1 segment in + 1-3 out at $0.00996 each
    const textCost = 1000 * 10000 - s.balanceCents * 10000;
    assert.ok(s.balanceCents < 1000 && s.balanceCents >= 996, `balance after one text exchange: ${s.balanceCents}`);
    assert.ok(s.usage.some((u) => u.kind === 'text' && u.units >= 2), 'the texts are in the usage list');
    assert.ok(textCost > 0);
    // a 61-second call is 2 minutes; the voice webhook connects while there is credit
    assert.match(await (await voice(S, t)).text(), /<Connect><Stream/);
    const meter = await S.kb.studio.numbers.meterFor({ kind: 'trial', id: t.trialId, flags: { number: true } });
    assert.equal(meter.phoneNumber, s.phoneNumber);
    const before = (await j(await call(S, t, ''))).number;
    const after1 = await meter.charge('call', Math.ceil(61 / 60), 'CAtest');
    assert.equal(after1.usage[0].kind, 'call'); assert.equal(after1.usage[0].units, 2);
    assert.ok(Math.abs((before.balanceCents - after1.balanceCents) - 2.04) <= 1, '2 minutes at 1.02¢');
    // drain it: the balance goes to zero or below, low + out are flagged
    const out = await meter.charge('call', 2000, 'CAlong');
    assert.equal(out.out, true); assert.equal(out.low, true);
    assert.equal(meter.ok(), false);
    // out of credit: an incoming text gets no reply (nothing is sent), a call hears a short line and is hung up
    const r2 = await sms(S, t, 'Are you open on Sunday?');
    const body2 = await r2.text();
    assert.equal(r2.status, 200);
    assert.doesNotMatch(body2, /<Message>/);
    const v2 = await (await voice(S, t)).text();
    assert.ok(v2.includes(PHONE_NO_CREDIT.replace(/'/g, '&apos;')) || v2.includes(PHONE_NO_CREDIT), v2);
    assert.match(v2, /<Hangup\/>/);
    // the Studio warns
    s = (await j(await call(S, t, ''))).number;
    assert.equal(s.out, true);
    await S.close();
  });

  test('top-up: a one-time embedded payment adds credit once, for this bot only', async () => {
    const S = await instance();
    const t = await trial(S);
    tw.reset();
    await provision(S, t, { area: '212', pack: 1000 });
    const up = await j(await call(S, t, '/topup', 'POST', { pack: 5000 }));
    const sess = st.sessions.get(up.sessionId);
    assert.equal(sess.mode, 'payment'); assert.equal(sess.ui_mode, 'embedded');
    assert.deepEqual(sess.line_items.map((x) => [Number(x.price_data.unit_amount), x.price_data.recurring || null]), [[5000, null]]);
    assert.ok(sess.customer, 'the same customer pays again');
    st.complete(up.sessionId);
    const ev = st.event('checkout.session.completed', st.sessions.get(up.sessionId), WHSEC);
    await j(await hook(S, ev.raw, ev.header));
    const c = await j(await call(S, t, '/confirm', 'POST', { sessionId: up.sessionId }));
    assert.equal(c.state.balanceCents, 6000);
    const t2 = await trial(S);
    assert.equal((await call(S, t2, '/topup', 'POST', { pack: 1000 })).status, 409, 'no number yet');
    assert.equal(tw.purchases().length, 1);
    await S.close();
  });

  test('persistence: the number, its credit and usage survive a restart; texts from a call go out from the bot\'s own number', async () => {
    const A = await instance();
    const t = await trial(A);
    tw.reset();
    const { co } = await provision(A, t, { area: '312', pack: 2500 });
    await sms(A, t, 'Do you deliver?');
    await sleep(50);
    const before = (await j(await call(A, t, ''))).number;
    await A.kb.studio.flush();
    await A.close();
    A.kb.studio.close?.();
    const doc = await specOf(t);
    assert.equal(doc.flags.number.state, 'active');
    assert.ok(doc.flags.number.applied.includes(co.sessionId));
    const B = await instance();
    const after = (await j(await call(B, t, ''))).number;
    assert.equal(after.phoneNumber, before.phoneNumber);
    assert.equal(after.balanceCents, before.balanceCents);
    assert.ok(after.usage.some((u) => u.kind === 'text'));
    // a replayed webhook after the restart buys nothing
    const ev = st.event('checkout.session.completed', st.sessions.get(co.sessionId), WHSEC);
    await j(await hook(B, ev.raw, ev.header));
    assert.equal(tw.purchases().length, 1);
    // outbound texts during a call use the bot's own number (the shared line otherwise)
    await twilioRest({ TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tw-secret', TWILIO_API_BASE_URL: tw.url, TWILIO_FROM_NUMBER: '+15550000000' }, { from: after.phoneNumber }).sendSms('+14155550199', 'Your link');
    assert.equal(tw.sent.at(-1).form.From, after.phoneNumber);
    await B.close();
  });

  test('convert: the number moves to the launched bot (webhooks re-pointed, bot keeps a link to its credit)', async () => {
    const S = await instance();
    const t = await trial(S);
    tw.reset();
    await provision(S, t, { area: '416', pack: 1000 });
    const mk = await S.api('/api/instances', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Front desk numbers' }) });
    const bot = await mk.json();
    assert.ok(mk.ok, JSON.stringify(bot));
    const botId = bot.id || bot.instance?.id;
    const cv = await S.api(`/api/studio/trials/${t.trialId}/convert`, { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'application/json' }, body: JSON.stringify({ account: 'acme', bucketId: 'acme-help', bot: botId }) });
    assert.equal(cv.status, 200, await cv.text());
    const n = [...tw.owned.values()][0];
    assert.equal(n.sms_url, `${S.base}/api/v1/channels/${botId}/sms`);
    assert.equal(n.voice_url, `${S.base}/api/v1/channels/${botId}/voice`);
    const inst = S.kb.registry.get(botId);
    assert.equal(inst.numberTrial, t.trialId);
    const meter = await S.kb.studio.numbers.meterFor({ kind: 'live', id: botId, inst });
    assert.equal(meter.phoneNumber, n.phone_number);
    await S.close();
  });
});

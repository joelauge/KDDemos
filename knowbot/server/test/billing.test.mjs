// The KnowBot plan (server/billing.mjs + the trials.mjs routes): our own hosted checkout for one subscription, the
// webhook that launches the bot once it is paid for, the bot's billing status and what it does to the bot, the return
// from checkout before the webhook, "Manage billing", and the switches (no payments key, KNOWBOT_CHECKOUT=knowdrive).
// Fakes only (fake payments, fake knowDrive incl. its authorization server, fake model): never a real provider.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { checkoutModeOf, billingPaused, billingPublic, graceMsOf, PLAN_LOOKUP, PLAN_PRODUCT_ID, TRIAL_DAYS } from '../billing.mjs';
import { STRIPE_VERSION } from '../numbers.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { startFakeStripe } from './fake-stripe.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 60;
const nextIp = () => `198.51.100.${ipSeq++ % 250}`;
const WHSEC = 'whsec_billing_test';
const PAY_ENV = (pay) => ({ STRIPE_SECRET_KEY: 'sk_fake_billing', STRIPE_API_BASE_URL: pay.url, KNOWBOT_BILLING_WEBHOOK_SECRET: WHSEC });

async function boot({ env = {}, payments = true, wire = true } = {}) {
  const kd = await startFakeKnowDrive({ speed: 6, narrowScope: 'all' });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const pay = await startFakeStripe();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-billing-'));
  const logs = [];
  const fullEnv = {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_KD_AUTH_URL: kd.url,
    ...(payments ? PAY_ENV(pay) : {}), ...env,
  };
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: fullEnv,
    studio: { sweep: false, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400, kdPollMs: 30, logger: (x) => logs.push(String(x)) } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const hook = `${base}/api/studio/billing/webhook`;
  if (wire) pay.state.webhooks.push({ url: hook, secret: WHSEC });
  const api = (p, init = {}) => fetch(base + p, init);
  return { kd, llm, pay, kb, base, hook, api, logs, async close() { kb.studio?.close?.(); await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await pay.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}

const DOCS = {
  'returns.md': '# Returns\n\nUnworn shoes can be returned within 60 days of delivery for a full refund.\n\nSale items can be exchanged within 14 days.\n',
  'care.md': '# Shoe care\n\nLeather uppers should be cleaned with a damp cloth and conditioned every three months.\n',
};
const Q = 'How many days do I have to return unworn shoes?';

function client(S) {
  const h = (t, extra = {}) => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': t.ip, ...extra });
  const c = {
    async trial() {
      const ip = nextIp();
      const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } });
      assert.equal(r.status, 201);
      return { ...(await r.json()), ip };
    },
    call: (t, p, method = 'GET', body) => S.api(`/api/studio/trials/${t.trialId}${p}`, { method, headers: h(t, body ? { 'content-type': 'application/json', origin: 'http://studio.test' } : { origin: 'http://studio.test' }), body: body ? JSON.stringify(body) : undefined }),
    json: async (t, p, method, body) => (await c.call(t, p, method, body)).json(),
    upload: (t, name, text) => S.api(`/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: h(t, { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' }), body: Buffer.from(text) }),
    async waitReady(t, n, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const j = await c.json(t, '/files');
        if (j.files.length >= n && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) return j.files;
        await sleep(60);
      }
      throw new Error('files never became ready');
    },
    async signIn(t, email) {
      const { url } = await c.json(t, '/kd/start', 'POST', { mode: 'signup' });
      await fetch(url);
      const u = new URL(url);
      const form = new URLSearchParams({ client_id: u.searchParams.get('client_id'), redirect_uri: u.searchParams.get('redirect_uri'), state: u.searchParams.get('state'),
        code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256', screen_hint: u.searchParams.get('screen_hint') || '', email, action: 'create' });
      const r = await fetch(`${S.kd.url}/-/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
      assert.equal(r.status, 302);
      assert.equal((await fetch(r.headers.get('location'), { redirect: 'manual' })).status, 200);
    },
    async waitMove(t, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const s = await c.json(t, '/kd'); if (s.move && ['done', 'partial', 'error', 'paused'].includes(s.move.state)) return s; await sleep(40); }
      throw new Error('move never finished');
    },
    /** A bot with its own files, a KnowDrive account and the files moved into it: ready for checkout. */
    async ready(email) {
      const t = await c.trial();
      await c.json(t, '', 'PATCH', { name: 'Shoe Helper' });
      for (const [n, text] of Object.entries(DOCS)) assert.equal((await c.upload(t, n, text)).status, 201);
      await c.waitReady(t, 2);
      await c.signIn(t, email);
      assert.equal((await c.call(t, '/kd/move', 'POST', {})).status, 202);
      const st = await c.waitMove(t);
      assert.equal(st.move.state, 'done', JSON.stringify(st.move));
      return { ...t, acct: S.kd.auth.accounts.get(email) };
    },
    async web(botId, question = Q) {
      const r = await S.api(`/v1/bots/${botId}/web`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ question }) });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, j, lines: (j.proof?.lines || []).map((l) => String(l.text)) };
    },
    hook: (raw, header) => S.api('/api/studio/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: raw }),
    /** Waits until the fake has delivered every webhook it sent. */
    async delivered(ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (S.pay.sent.length && S.pay.sent.every((x) => x.status != null)) return S.pay.sent; await sleep(30); }
      throw new Error(`webhooks not delivered: ${JSON.stringify(S.pay.sent)}`);
    },
    doc: (t) => JSON.parse([...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_spec.json`).raw),
    sessionOf: (url) => S.pay.sessions.get(new URL(url).pathname.split('/').pop()),
  };
  return c;
}

// ------------------------------------------------------------------------------------------------- pure
describe('billing.mjs: modes and what a status does', () => {
  test('checkout mode: hosted with a payments key, off without one, the old link only behind KNOWBOT_CHECKOUT=knowdrive', () => {
    assert.equal(checkoutModeOf({}), 'off');
    assert.equal(checkoutModeOf({ STRIPE_SECRET_KEY: 'sk_x' }), 'hosted');
    assert.equal(checkoutModeOf({ STRIPE_RESTRICTED_KEY: 'rk_x' }), 'hosted');
    assert.equal(checkoutModeOf({ STRIPE_SECRET_KEY: 'sk_x', KNOWBOT_CHECKOUT: 'knowdrive' }), 'knowdrive');
    assert.equal(checkoutModeOf({ KNOWBOT_CHECKOUT: 'KnowDrive' }), 'knowdrive');
    assert.equal(checkoutModeOf({ STRIPE_SECRET_KEY: 'sk_x', KNOWBOT_CHECKOUT: 'off' }), 'off');
    assert.equal(checkoutModeOf({ KNOWBOT_CHECKOUT: 'stripe' }), 'off', 'asking for it without a key is still off');
  });
  test('paused only once an ended subscription is past its grace period', () => {
    const t = 1_800_000_000_000;
    assert.equal(billingPaused(null, t), false, 'a bot with no billing record (the admin convert) is never paused');
    for (const status of ['trialing', 'active', 'past_due', 'incomplete']) assert.equal(billingPaused({ status, graceUntil: t - 1 }, t), false, status);
    for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'paused']) {
      assert.equal(billingPaused({ status, graceUntil: t + 1000 }, t), false, `${status}: still in grace`);
      assert.equal(billingPaused({ status, graceUntil: t }, t), true, `${status}: grace over`);
    }
    assert.equal(graceMsOf({}), 3 * 86400000);
    assert.equal(graceMsOf({ KNOWBOT_BILLING_GRACE_DAYS: '0' }), 0);
    assert.equal(graceMsOf({ KNOWBOT_BILLING_GRACE_DAYS: '14' }), 14 * 86400000);
    assert.equal(graceMsOf({ KNOWBOT_BILLING_GRACE_DAYS: 'x' }), 3 * 86400000);
  });
  test('what the Studio is told: one notice, never a payment id', () => {
    const t = 1_800_000_000_000;
    assert.equal(billingPublic(null, t), null);
    assert.equal(billingPublic({ pending: [{ id: 'cs_x' }] }, t), null, 'an open checkout is not a status');
    const ids = { customerId: 'cus_secret', subscriptionId: 'sub_secret', sessionId: 'cs_secret' };
    const trialing = billingPublic({ ...ids, status: 'trialing', interval: 'month', trialEnd: t + 86400000 }, t);
    assert.deepEqual([trialing.status, trialing.notice, trialing.paused, trialing.answering, trialing.canManage], ['trialing', null, false, true, true]);
    assert.deepEqual(billingPublic({ ...ids, status: 'past_due' }, t).notice, { kind: 'past_due', action: 'manage' });
    assert.equal(billingPublic({ ...ids, status: 'active', cancelAt: t + 5000 }, t).notice.kind, 'ending');
    const grace = billingPublic({ ...ids, status: 'canceled', graceUntil: t + 5000 }, t);
    assert.deepEqual([grace.notice.kind, grace.notice.action, grace.paused], ['grace', 'reactivate', false]);
    const ended = billingPublic({ ...ids, status: 'unpaid', graceUntil: t - 1 }, t);
    assert.deepEqual([ended.notice.kind, ended.notice.action, ended.paused, ended.answering], ['paused', 'reactivate', true, false]);
    for (const p of [trialing, grace, ended]) assert.doesNotMatch(JSON.stringify(p), /cus_|sub_|cs_/);
  });
});

// ------------------------------------------------------------------------------------------------- the flow
describe('the KnowBot plan: checkout → webhook → launched, then the subscription changes', () => {
  let S, c, t, session, subId;
  before(async () => { S = await boot(); c = client(S); await S.kb.registry.ready; });
  after(async () => { await S.close(); });

  test('config says checkout is our own hosted page; it still needs the KnowDrive account first', async () => {
    const cfg = await (await S.api('/api/studio/config')).json();
    assert.deepEqual(cfg.checkout, { mode: 'hosted', available: true });
    assert.deepEqual(cfg.kd, { available: true, required: true });
    const t0 = await c.trial();
    const r = await c.call(t0, '/checkout', 'POST', { email: 'x@example.com' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, 'kd_required');
    assert.equal(S.pay.sessions.size, 0, 'nothing was started on the payments account');
  });

  test('the checkout session: a subscription for the plan price, 30 days free, tied to the bot and its KnowDrive account', async () => {
    t = await c.ready('owner@example.com');
    const r = await c.call(t, '/checkout', 'POST', { interval: 'month' });
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    assert.equal(j.mode, 'hosted');
    assert.ok(j.url.startsWith(`${S.pay.url}/pay/cs_`), j.url);
    assert.doesNotMatch(j.url, /knowdrive\.ai/);
    session = c.sessionOf(j.url);
    const req = S.pay.requests.find((x) => x.method === 'POST' && x.path === '/v1/checkout/sessions');
    assert.equal(req.version, STRIPE_VERSION, 'the pinned API version');
    assert.equal(req.auth, 'Bearer sk_fake_billing');
    const b = req.body;
    assert.equal(b.mode, 'subscription');
    assert.equal(b.ui_mode, undefined, 'hosted checkout (a redirect), not embedded');
    assert.equal(b.subscription_data.trial_period_days, String(TRIAL_DAYS));
    assert.equal(b.payment_method_collection, 'always', 'card required');
    assert.equal(b.customer_email, 'owner@example.com', 'the KnowDrive account email');
    assert.equal(b.client_reference_id, t.trialId);
    assert.deepEqual(b.metadata, { app: 'knowbot', kind: 'plan', trial: t.trialId, bot: 'Shoe Helper', interval: 'month', kd_account: t.acct.id });
    assert.deepEqual(b.subscription_data.metadata, b.metadata, 'the subscription names the bot too (its later events)');
    assert.equal(b.subscription_data.description, 'KnowBot · Shoe Helper');
    assert.match(b.custom_text.submit.message, /Shoe Helper: today \$0\. First 30 days free, then \$549 per month\. Cancel anytime\./);
    // the price: found by lookup key, created on first use under the one product
    assert.equal(b.line_items.length, 1);
    const price = S.pay.prices.get(b.line_items[0].price);
    assert.deepEqual([price.lookup_key, price.unit_amount, price.currency, price.recurring.interval, price.product], [PLAN_LOOKUP.month, 54900, 'usd', 'month', PLAN_PRODUCT_ID]);
    assert.equal(S.pay.products.get(PLAN_PRODUCT_ID).name, 'KnowBot');
    // back to the Studio: the existing return contract (t, launched=1, the restore key) and the Launch sheet on cancel
    const ok = new URL(b.success_url), no = new URL(b.cancel_url);
    assert.equal(`${ok.origin}${ok.pathname}`, 'http://studio.test/studio/');
    assert.deepEqual([ok.searchParams.get('t'), ok.searchParams.get('launched'), ok.hash], [t.trialId, '1', '#launched']);
    assert.deepEqual([no.searchParams.get('t'), no.searchParams.get('launched'), no.searchParams.get('launch'), no.hash], [t.trialId, null, '1', '#launch']);
    const rs = await S.api(`/api/studio/trials/${t.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ k: ok.searchParams.get('k') }) });
    assert.equal(rs.status, 200, 'the restore key in the return link opens the bot on another device');
    // what the page shows matches the Launch sheet
    const page = await (await fetch(j.url)).text();
    assert.match(page, /<h1 id=product>KnowBot<\/h1>/);
    assert.match(page, /\$549 per month/);
    assert.match(page, /30 days free/);
    assert.match(page, /<b id=today>\$0<\/b>/);
    assert.match(page, /owner@example\.com/);
    // nothing is launched or billed yet
    const st = await c.json(t, '');
    assert.deepEqual([st.converted, st.billing], [false, null]);
  });

  test('yearly from the toggle: the yearly price, the same product, a typed receipt email', async () => {
    const r = await c.json(t, '/checkout', 'POST', { interval: 'year', email: 'billing@example.com' });
    const s2 = c.sessionOf(r.url);
    const price = S.pay.prices.get(s2.line_items[0].price);
    assert.deepEqual([price.lookup_key, price.unit_amount, price.recurring.interval, price.product], [PLAN_LOOKUP.year, 549000, 'year', PLAN_PRODUCT_ID]);
    assert.equal(s2.customer_email, 'billing@example.com');
    assert.match(s2.custom_text.submit.message, /then \$5,490 per year/);
    assert.equal(S.pay.requests.filter((x) => x.method === 'POST' && x.path === '/v1/products').length, 1, 'one product');
    // a third checkout reuses the prices (no new ones)
    await c.json(t, '/checkout', 'POST', { interval: 'month' });
    assert.equal(S.pay.prices.size, 2);
    assert.equal((await c.call(t, '/checkout', 'POST', { interval: 'week' })).status, 400);
  });

  test('the webhook: a bad signature is refused, the wrong secret too, and nothing launches', async () => {
    const done = { ...session, status: 'complete', payment_status: 'paid', customer: 'cus_x', subscription: 'sub_x' };
    const { raw } = S.pay.event('checkout.session.completed', done, WHSEC);
    assert.equal((await c.hook(raw, 't=1,v1=00')).status, 400);
    assert.equal((await c.hook(raw, S.pay.event('checkout.session.completed', done, 'whsec_other').header)).status, 400);
    const old = S.pay.event('checkout.session.completed', done, WHSEC, Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await c.hook(old.raw, old.header)).status, 400, 'an old timestamp is refused');
    assert.equal((await c.json(t, '')).converted, false);
    assert.equal((await S.api('/api/studio/billing/webhook')).status, 405);
  });

  test('checkout.session.completed → the bot is launched into the customer store and billing is recorded; a replay does nothing', async () => {
    assert.equal((await c.web(t.trialId)).status, 200, 'the trial bot answers before launch');
    const page = await fetch(`${S.pay.url}/pay/${session.id}/complete`, { method: 'POST', redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.match(page.headers.get('location'), /launched=1/);
    const sent = await c.delivered();
    assert.deepEqual(sent.map((x) => [x.type, x.status]), [['checkout.session.completed', 200]]);
    const st = await c.json(t, '');
    assert.equal(st.converted, true);
    assert.equal(st.kd.live, true, 'the customer-store model is finalised');
    assert.equal(st.convertedFiles, 2);
    assert.deepEqual([st.billing.status, st.billing.interval, st.billing.notice, st.billing.paused, st.billing.canManage], ['trialing', 'month', null, false, true]);
    assert.ok(Date.parse(st.billing.trialEnd) > Date.now() + 29 * 86400000);
    assert.doesNotMatch(JSON.stringify(st), /cus_test|sub_test|cs_test/, 'no payment id reaches the browser');
    const b = c.doc(t).flags.billing;
    subId = session.subscription;
    assert.deepEqual([b.customerId, b.subscriptionId, b.sessionId, b.status, b.trialUsed], [session.customer, subId, session.id, 'trialing', true]);
    assert.ok(b.applied.includes(session.id));
    assert.deepEqual(b.pending.map((x) => x.id).includes(session.id), false, 'the finished checkout is no longer pending');
    // the files live only in the customer's own (free) KnowDrive store, and the bot answers from there
    assert.equal(S.kd.auth.storeFiles(t.acct.store).length, 2);
    const a = await c.web(t.trialId);
    assert.equal(a.status, 200);
    assert.ok(a.lines.some((l) => /60 days/.test(l)), JSON.stringify(a.j).slice(0, 300));
    // the same event again (a retry): acknowledged, applied once
    const convertLogs = S.logs.filter((l) => /\[studio\] converted/.test(l)).length;
    const { raw, header } = S.pay.event('checkout.session.completed', session, WHSEC);
    const r1 = await c.hook(raw, header), r2 = await c.hook(raw, header);
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    assert.equal((await r2.json()).duplicate, true);
    assert.equal(S.logs.filter((l) => /\[studio\] converted/.test(l)).length, convertLogs, 'not converted twice');
    assert.equal(c.doc(t).flags.billing.applied.filter((x) => x === session.id).length, 1);
  });

  test('a second checkout is refused while subscribed; Manage billing opens the customer portal', async () => {
    const r = await c.call(t, '/checkout', 'POST', { interval: 'month' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, 'already_subscribed');
    const p = await c.call(t, '/billing/portal', 'POST', {});
    assert.equal(p.status, 200);
    const { url } = await p.json();
    assert.ok(url.startsWith(`${S.pay.url}/portal/bps_`), url);
    const req = S.pay.requests.find((x) => x.path === '/v1/billing_portal/sessions');
    assert.equal(req.body.customer, session.customer);
    assert.equal(req.body.return_url, `http://studio.test/studio/?t=${t.trialId}#billing`);
    // a bot that never subscribed has nothing to manage
    const t0 = await c.trial();
    const np = await c.call(t0, '/billing/portal', 'POST', {});
    assert.equal(np.status, 409);
    assert.equal((await np.json()).error.code, 'no_billing');
  });

  test('invoice.payment_failed → past_due: the bot keeps answering and the owner is warned', async () => {
    S.pay.sent.length = 0;
    S.pay.failInvoice(subId);
    assert.equal((await c.delivered())[0].status, 200);
    const st = await c.json(t, '/billing');
    assert.deepEqual([st.billing.status, st.billing.notice, st.billing.paused], ['past_due', { kind: 'past_due', action: 'manage' }, false]);
    assert.equal((await c.web(t.trialId)).status, 200, 'still answers');
    // the card was fixed: the subscription is active again and the warning goes
    S.pay.sent.length = 0;
    S.pay.setSubscription(subId, { status: 'active', trial_end: null });
    await c.delivered();
    const st2 = await c.json(t, '/billing');
    assert.deepEqual([st2.billing.status, st2.billing.notice], ['active', null]);
  });

  test('cancel at period end is shown; an out-of-order older event never overwrites a newer state', async () => {
    S.pay.sent.length = 0;
    const end = Math.floor(Date.now() / 1000) + 20 * 86400;
    S.pay.setSubscription(subId, { cancel_at_period_end: true, cancel_at: end });
    await c.delivered();
    let st = await c.json(t, '/billing');
    assert.deepEqual([st.billing.status, st.billing.notice.kind, st.billing.notice.action], ['active', 'ending', 'manage']);
    assert.equal(Date.parse(st.billing.cancelAt), end * 1000);
    S.pay.sent.length = 0;
    S.pay.setSubscription(subId, { cancel_at_period_end: false, cancel_at: null });
    await c.delivered();
    // a late delivery of an older "past_due" (created an hour ago) is ignored
    const stale = JSON.stringify({ id: 'evt_stale_1', object: 'event', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000) - 3600, data: { object: { ...S.pay.subscriptions.get(subId), status: 'past_due' } } });
    const { signStripe } = await import('../numbers.mjs');
    assert.equal((await c.hook(stale, signStripe(stale, WHSEC))).status, 200);
    st = await c.json(t, '/billing');
    assert.deepEqual([st.billing.status, st.billing.notice], ['active', null]);
  });

  test('subscription deleted → canceled: a grace period first (still answering, the owner is told when it stops)', async () => {
    S.pay.sent.length = 0;
    S.pay.setSubscription(subId, { status: 'canceled' });
    assert.deepEqual((await c.delivered()).map((x) => [x.type, x.status]), [['customer.subscription.deleted', 200]]);
    const st = await c.json(t, '');
    assert.deepEqual([st.billing.status, st.billing.notice.kind, st.billing.notice.action, st.billing.paused], ['canceled', 'grace', 'reactivate', false]);
    const until = Date.parse(st.billing.graceUntil);
    assert.ok(until > Date.now() + 2.9 * 86400000 && until < Date.now() + 3.1 * 86400000, 'three days by default');
    assert.equal((await c.web(t.trialId)).status, 200);
    assert.equal(st.converted, true);
  });

  test('events for other things on the same account are ignored (a KnowBot number, someone else’s subscription)', async () => {
    const number = S.pay.event('checkout.session.completed', { id: 'cs_test_number1', status: 'complete', payment_status: 'paid', metadata: { app: 'knowbot', kind: 'number', trial: t.trialId } }, WHSEC);
    const r = await c.hook(number.raw, number.header);
    assert.deepEqual([r.status, (await r.json()).ignored], [200, true]);
    const other = S.pay.event('customer.subscription.deleted', { id: 'sub_other', status: 'canceled', metadata: { plan: 'launch' } }, WHSEC);
    assert.equal((await (await c.hook(other.raw, other.header)).json()).ignored, true);
    const unknown = S.pay.event('charge.succeeded', { id: 'ch_1' }, WHSEC);
    assert.equal((await (await c.hook(unknown.raw, unknown.header)).json()).ignored, true);
  });

  test('the admin convert route still works, and a bot launched that way has no billing and is never paused', async () => {
    const t2 = await c.ready('admin-launched@example.com');
    const r = await S.api(`/api/studio/trials/${t2.trialId}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ account: t2.acct.id, bucketId: 'adminbot' }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).converted, true);
    const st = await c.json(t2, '');
    assert.deepEqual([st.converted, st.billing], [true, null]);
    assert.equal((await c.web(t2.trialId)).status, 200);
  });
});

// ------------------------------------------------------------------------------------------------- ended → paused → reactivated
describe('a cancelled plan past its grace period: the bot stops answering publicly, files stay, the owner can reactivate', () => {
  let S, c, t, first;
  before(async () => { S = await boot({ env: { KNOWBOT_BILLING_GRACE_DAYS: '0' } }); c = client(S); await S.kb.registry.ready; });
  after(async () => { await S.close(); });

  test('cancel → paused: visitors get a polite "paused", nothing is deleted, the Studio shows "Subscription ended"', async () => {
    t = await c.ready('pause@example.com');
    const j = await c.json(t, '/checkout', 'POST', { interval: 'year' });
    first = c.sessionOf(j.url);
    S.pay.complete(first.id);
    await c.delivered();
    assert.equal((await c.json(t, '')).billing.interval, 'year');
    assert.equal((await c.web(t.trialId)).status, 200);
    S.pay.sent.length = 0;
    // cancelled from the portal page (the customer's own click)
    const { url } = await c.json(t, '/billing/portal', 'POST', {});
    const pid = new URL(url).pathname.split('/').pop();
    assert.equal((await fetch(`${S.pay.url}/portal/${pid}/cancel`, { method: 'POST', redirect: 'manual' })).status, 303);
    await c.delivered();
    const st = await c.json(t, '');
    assert.deepEqual([st.billing.status, st.billing.paused, st.billing.answering, st.billing.notice], ['canceled', true, false, { kind: 'paused', action: 'reactivate' }]);
    assert.equal(st.converted, true, 'still the same launched bot');
    const a = await c.web(t.trialId);
    assert.equal(a.status, 402);
    assert.equal(a.j.error.code, 'bot_paused');
    assert.match(a.j.error.message, /paused right now/);
    assert.doesNotMatch(a.j.error.message, /pay|subscri|bill/i, 'visitors are not told about the owner’s billing');
    // files are never deleted: the customer's store still has them, and the owner still sees and can test the bot
    assert.equal(S.kd.auth.storeFiles(t.acct.store).length, 2);
    assert.equal(st.files.length, 2);
    const ask = await c.call(t, '/ask', 'POST', { question: Q });
    assert.equal(ask.status, 200, 'the owner can still test in the Studio');
  });

  test('reactivate: a new checkout with no second free month, on the same customer; paid → answering again', async () => {
    const r = await c.call(t, '/checkout', 'POST', { interval: 'month' });
    assert.equal(r.status, 200, await r.clone().text());
    const s2 = c.sessionOf((await r.json()).url);
    assert.equal(s2.subscription_data.trial_period_days, undefined, 'the free month was used');
    assert.equal(s2.customer, first.customer);
    assert.equal(s2.customer_email, null);
    assert.match(s2.custom_text.submit.message, /^Shoe Helper: \$549 per month\. Cancel anytime\.$/);
    S.pay.sent.length = 0;
    S.pay.complete(s2.id);
    await c.delivered();
    const st = await c.json(t, '');
    assert.deepEqual([st.billing.status, st.billing.paused, st.billing.notice, st.billing.interval], ['active', false, null, 'month']);
    assert.equal((await c.web(t.trialId)).status, 200);
    // a late event of the old, cancelled subscription changes nothing
    const old = S.pay.event('customer.subscription.deleted', { ...S.pay.subscriptions.get(first.subscription) }, WHSEC);
    assert.equal((await c.hook(old.raw, old.header)).status, 200);
    assert.equal((await c.json(t, '/billing')).billing.status, 'active');
  });

  test('unpaid is treated like cancelled', async () => {
    const sub = c.doc(t).flags.billing.subscriptionId;
    S.pay.sent.length = 0;
    S.pay.setSubscription(sub, { status: 'unpaid' });
    await c.delivered();
    assert.equal((await c.json(t, '/billing')).billing.paused, true);
    assert.equal((await c.web(t.trialId)).status, 402);
  });
});

// ------------------------------------------------------------------------------------------------- return before the webhook
describe('back from checkout before the webhook lands (or with no webhook at all)', () => {
  let S, c;
  before(async () => { S = await boot({ wire: false }); c = client(S); await S.kb.registry.ready; });
  after(async () => { await S.close(); });

  test('the Studio’s "Activating…" poll looks the payment up itself and launches the bot', async () => {
    const t = await c.ready('early@example.com');
    const s = c.sessionOf((await c.json(t, '/checkout', 'POST', {})).url);
    // not paid yet: polling changes nothing
    let st = await c.json(t, '');
    assert.deepEqual([st.converted, st.billing], [false, null]);
    S.pay.complete(s.id); // paid; no webhook is delivered
    assert.equal(S.pay.sent.length, 0);
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) { st = await c.json(t, ''); if (st.converted) break; await sleep(200); }
    assert.equal(st.converted, true, S.logs.filter((l) => /billing/.test(l)).join('\n'));
    assert.equal(st.billing.status, 'trialing');
    assert.equal(st.kd.live, true);
    assert.equal((await c.web(t.trialId)).status, 200);
    // the webhook finally arrives: acknowledged, nothing happens twice
    const n = S.logs.filter((l) => /\[studio\] converted/.test(l)).length;
    const late = S.pay.event('checkout.session.completed', s, 'whsec_billing_test');
    const r = await c.hook(late.raw, late.header);
    assert.equal(r.status, 200);
    assert.equal(S.logs.filter((l) => /\[studio\] converted/.test(l)).length, n);
  });

  test('POST billing/confirm: explicit check; an unpaid or foreign checkout launches nothing', async () => {
    const t = await c.ready('confirm@example.com');
    const s = c.sessionOf((await c.json(t, '/checkout', 'POST', {})).url);
    let r = await c.json(t, '/billing/confirm', 'POST', {});
    assert.deepEqual([r.converted, r.paid], [false, false]);
    const other = await c.ready('other@example.com');
    const so = c.sessionOf((await c.json(other, '/checkout', 'POST', {})).url);
    S.pay.complete(so.id);
    const x = await c.call(t, '/billing/confirm', 'POST', { sessionId: so.id });
    assert.equal(x.status, 404, 'another bot’s paid checkout is not this bot’s');
    assert.equal((await c.json(t, '')).converted, false);
    S.pay.complete(s.id);
    r = await c.json(t, '/billing/confirm', 'POST', {});
    assert.deepEqual([r.converted, r.paid, r.billing.status], [true, true, 'trialing']);
  });

  test('payments down on the return: a clear "safe to wait" answer, then it works', async () => {
    const t = await c.ready('down@example.com');
    const s = c.sessionOf((await c.json(t, '/checkout', 'POST', {})).url);
    S.pay.complete(s.id);
    S.pay.state.down = true;
    const r = await c.call(t, '/billing/confirm', 'POST', {});
    assert.equal(r.status, 502);
    assert.match((await r.json()).error.message, /safe to wait/);
    S.pay.state.down = false;
    assert.equal((await c.json(t, '/billing/confirm', 'POST', {})).converted, true);
  });
});

// ------------------------------------------------------------------------------------------------- switches
describe('checkout switches', () => {
  test('no payments key: config says checkout is not available and the route says so clearly (no dead end)', async () => {
    const S = await boot({ payments: false });
    try {
      const c = client(S);
      const cfg = await (await S.api('/api/studio/config')).json();
      assert.deepEqual(cfg.checkout, { mode: 'off', available: false });
      const t = await c.ready('nokey@example.com');
      const r = await c.call(t, '/checkout', 'POST', {});
      assert.equal(r.status, 503);
      const e = (await r.json()).error;
      assert.equal(e.code, 'checkout_unavailable');
      assert.match(e.message, /Checkout isn't available yet/);
      assert.doesNotMatch(JSON.stringify(e), /knowdrive\.ai|stripe/i);
      assert.equal((await c.call(t, '/billing/portal', 'POST', {})).status, 503);
      assert.equal((await S.api('/api/studio/billing/webhook', { method: 'POST', body: '{}' })).status, 503, 'no webhook secret: not configured');
    } finally { await S.close(); }
  });

  test('KNOWBOT_CHECKOUT=knowdrive: the old signed link, even with a payments key', async () => {
    const S = await boot({ env: { KNOWBOT_CHECKOUT: 'knowdrive' } });
    try {
      const c = client(S);
      assert.deepEqual((await (await S.api('/api/studio/config')).json()).checkout, { mode: 'knowdrive', available: true });
      const t = await c.ready('fallback@example.com');
      const j = await c.json(t, '/checkout', 'POST', {});
      const u = new URL(j.url);
      assert.equal(`${u.origin}${u.pathname}`, 'https://knowdrive.ai/signup');
      assert.deepEqual([u.searchParams.get('plan'), u.searchParams.get('price'), u.searchParams.get('kd_account'), j.mode], ['knowbot', '549', t.acct.id, 'knowdrive']);
      assert.ok(u.searchParams.get('sig'));
      assert.equal(S.pay.sessions.size, 0);
    } finally { await S.close(); }
  });

  test('without KnowDrive accounts (KNOWBOT_KD_ACCOUNTS=off): the plan still sells and launches the bot in the shared store', async () => {
    const S = await boot({ env: { KNOWBOT_KD_ACCOUNTS: 'off', KNOWBOT_STRIPE_PRICE_MONTH: 'price_pinned_month' } });
    try {
      const c = client(S);
      // a pinned price id is used as is (no lookup, nothing created)
      S.pay.products.set('prod_x', { id: 'prod_x', name: 'KnowBot', active: true });
      S.pay.prices.set('price_pinned_month', { id: 'price_pinned_month', product: 'prod_x', unit_amount: 54900, currency: 'usd', recurring: { interval: 'month' }, active: true, lookup_key: null });
      const t = await c.trial();
      for (const [n, text] of Object.entries(DOCS)) await c.upload(t, n, text);
      await c.waitReady(t, 2);
      const j = await c.json(t, '/checkout', 'POST', { email: 'solo@example.com' });
      const s = c.sessionOf(j.url);
      assert.equal(s.line_items[0].price, 'price_pinned_month');
      assert.equal(S.pay.requests.filter((x) => x.path === '/v1/prices' || x.path === '/v1/products').length, 0);
      assert.equal(s.metadata.kd_account, undefined);
      S.pay.complete(s.id);
      await c.delivered();
      const st = await c.json(t, '');
      assert.deepEqual([st.converted, st.convertedFiles, st.billing.status], [true, 2, 'trialing']);
      const row = [...S.kd.files.values()].find((f) => f.filename.endsWith('/returns.md'));
      assert.ok(row.tags.includes(`account:${s.customer.toLowerCase()}`) && row.tags.some((x) => x.startsWith('bucket:bot-')), row.tags.join(','));
      assert.equal((await c.web(t.trialId)).status, 200);
    } finally { await S.close(); }
  });
});

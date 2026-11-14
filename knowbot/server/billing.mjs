// The KnowBot plan: KnowBot bills for itself, as its own product, on our payments account.
//
// The customer's KnowDrive account stays a FREE KnowDrive account (created or linked by the Launch step, server/
// kdaccount.mjs); nothing is bought on knowdrive.ai. After that step the Launch sheet's "Continue to secure checkout"
// opens a hosted checkout page for one subscription:
//
//   Product  "KnowBot" (one product, id knowbot_plan), two recurring prices found by lookup_key and created on first
//            use, so no price ids need configuring:  knowbot_monthly ($549/month)  ·  knowbot_yearly ($5,490/year)
//            (the amounts are the Studio's PRICE / PRICE_YEAR; KNOWBOT_STRIPE_PRICE_MONTH / _YEAR pin price ids instead)
//   Trial    the first 30 days are free (subscription_data.trial_period_days), a card is required, cancel anytime.
//            A bot that already had its free month (a reactivation) is charged at once.
//
// Payments REST (the client and signature check are server/numbers.mjs's, shared):
//   GET  /v1/prices?lookup_keys[0]=…&active=true      find a plan price            POST /v1/prices   create one
//   GET  /v1/products/knowbot_plan                     the product                  POST /v1/products create it
//   POST /v1/checkout/sessions                         mode=subscription, hosted (the reply's `url` is the page)
//   GET  /v1/checkout/sessions/{id}                    the return check (a late webhook never strands the customer)
//   GET  /v1/subscriptions/{id}                        the subscription's own status after checkout
//   POST /v1/billing_portal/sessions                   "Manage billing": cancel, update the card, invoices
//   Webhook POST /api/studio/billing/webhook           Stripe-Signature (HMAC-SHA256, 5 min) with
//        KNOWBOT_BILLING_WEBHOOK_SECRET (else STRIPE_WEBHOOK_SECRET); each event id is applied once:
//        checkout.session.completed / .async_payment_succeeded  → the bot is launched (convert) and billing recorded
//        customer.subscription.updated / .deleted, invoice.payment_failed  → the bot's billing status
//
// State: T.flags.billing on the Studio bot (saved in its spec doc like every other flag):
//   { status, customerId, subscriptionId, sessionId, interval, trialEnd, periodEnd, cancelAt, pastDueSince, endedAt,
//     graceUntil, trialUsed, pending: [{id, interval, at}], applied: [session ids], events: [event ids], eventAt }
//   status   trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired | paused
//
// What the status does (billingPaused):
//   trialing, active   the bot answers everywhere
//   past_due           the bot keeps answering; the owner is warned in the Studio ("Update card")
//   canceled, unpaid   the bot keeps answering for a grace period (KNOWBOT_BILLING_GRACE_DAYS, default 3 days), then it
//                      stops answering publicly; the owner sees "Subscription ended" with Reactivate. Files are never
//                      deleted: they stay in the customer's own KnowDrive account.
import { createStripe, stripeKeyOf, stripeSignatureValid } from './numbers.mjs';

export const PLAN_PRODUCT_ID = 'knowbot_plan';
export const PLAN_LOOKUP = { month: 'knowbot_monthly', year: 'knowbot_yearly' };
export const TRIAL_DAYS = 30;
const DAY = 86400000;
const TRIAL_ID_RE = /^tr_[a-z2-7]{16}$/;
const SESSION_RE = /^cs_[A-Za-z0-9_]{6,200}$/;
const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
const KNOWN = new Set(['trialing', 'active', 'past_due', 'incomplete', ...ENDED]);

/** Where "Continue to secure checkout" goes: 'hosted' (our own checkout), 'knowdrive' (the old signed link, only with
 *  KNOWBOT_CHECKOUT=knowdrive) or 'off' (no payments key: the sheet says checkout isn't available yet). */
export function checkoutModeOf(env = {}) {
  const want = String(env.KNOWBOT_CHECKOUT || '').trim().toLowerCase();
  if (want === 'knowdrive') return 'knowdrive';
  if (want === 'off') return 'off';
  return stripeKeyOf(env) ? 'hosted' : 'off';
}
export const graceMsOf = (env = {}) => { const d = Number(env.KNOWBOT_BILLING_GRACE_DAYS); return (Number.isFinite(d) && d >= 0 ? d : 3) * DAY; };

/** True once a bot's subscription ended and its grace period ran out: it no longer answers publicly. */
export function billingPaused(b, nowMs = Date.now()) {
  if (!b || !ENDED.has(b.status)) return false;
  return nowMs >= Number(b.graceUntil || 0);
}
const iso = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);
/** What the Studio shows: the status and, when something needs the owner, one notice. No payment ids. */
export function billingPublic(b, nowMs = Date.now()) {
  if (!b || !b.status) return null;
  const paused = billingPaused(b, nowMs);
  let notice = null;
  if (paused) notice = { kind: 'paused', action: 'reactivate' };
  else if (ENDED.has(b.status)) notice = { kind: 'grace', until: iso(b.graceUntil), action: 'reactivate' };
  else if (b.status === 'past_due') notice = { kind: 'past_due', action: 'manage' };
  else if (b.cancelAt) notice = { kind: 'ending', until: iso(b.cancelAt), action: 'manage' };
  return { status: b.status === 'incomplete_expired' || b.status === 'paused' ? 'canceled' : b.status, interval: b.interval || null, trialEnd: iso(b.trialEnd), periodEnd: iso(b.periodEnd),
    cancelAt: iso(b.cancelAt), graceUntil: ENDED.has(b.status) ? iso(b.graceUntil) : null, paused, answering: !paused, canManage: !!b.customerId, notice };
}

const idOf = (x) => (typeof x === 'string' ? x : x?.id || null);
const ms = (sec) => (Number(sec) > 0 ? Number(sec) * 1000 : null);
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/**
 * @param {object} o
 * @param {object} o.env
 * @param {{month: number, year: number}} o.prices            the plan's prices in dollars (the Studio's PRICE / PRICE_YEAR)
 * @param {(id: string) => Promise<object|null>} o.loadTrial   the bot's live Studio state (T), loaded from its doc
 * @param {(T: object) => Promise<void>} o.saveTrial
 * @param {(T: object, ids: {customerId: string|null}) => Promise<object>} o.launch  converts the bot (the admin convert's logic)
 * @param {(T: object) => string} o.botName
 * @param {(T: object, state: object|null) => void} [o.onChange]  pushes the billing state to the open Studio
 * @param {(status, code, message, extra?) => never} o.fail
 */
export function createBilling({ env = {}, log = () => {}, now = () => Date.now(), prices, loadTrial, saveTrial, launch, botName = () => 'Your bot', onChange = () => {}, fail } = {}) {
  const stripe = createStripe(env);
  const mode = () => checkoutModeOf(env);
  const graceMs = graceMsOf(env);
  const webhookSecret = () => env.KNOWBOT_BILLING_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET || '';
  const amountOf = (interval) => Math.round(Number(interval === 'year' ? prices.year : prices.month) * 100);
  const pub = (T) => billingPublic(T?.flags?.billing, now());
  const paused = (flags) => billingPaused(flags?.billing, now());
  const changed = (T) => { try { onChange(T, pub(T)); } catch { /* no open Studio */ } };

  const locks = new Map();
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    locks.set(key, settled);
    settled.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
    return next;
  }

  // ---------------------------------------------------------------- the product and its two prices
  const priceCache = new Map(); // interval → { id, at }
  async function ensureProduct() {
    try { const p = await stripe('GET', `/v1/products/${PLAN_PRODUCT_ID}`); if (p?.id && p.active !== false) return p.id; if (p?.id) { await stripe('POST', `/v1/products/${PLAN_PRODUCT_ID}`, { active: true }); return p.id; } }
    catch (e) { if (e.status !== 404) throw e; }
    try {
      const p = await stripe('POST', '/v1/products', { id: PLAN_PRODUCT_ID, name: 'KnowBot',
        description: 'Your KnowBot, live: Website, KnowBot number and Email, answering only from your files. First 30 days free, cancel anytime.', metadata: { app: 'knowbot', kind: 'plan' } });
      log(`[billing] created the product ${p.id}`);
      return p.id;
    } catch (e) { if (e.code === 'resource_already_exists') return PLAN_PRODUCT_ID; throw e; } // two first checkouts at once
  }
  /** The plan's price id for month | year: an env override, else the active price with our lookup_key (created when
   *  missing, replaced when the Studio's amount changed; old subscriptions keep the price they were sold). */
  async function priceFor(interval) {
    const pinned = env[interval === 'year' ? 'KNOWBOT_STRIPE_PRICE_YEAR' : 'KNOWBOT_STRIPE_PRICE_MONTH'];
    if (pinned) return String(pinned);
    const hit = priceCache.get(interval);
    if (hit && now() - hit.at < 3600000) return hit.id;
    const lookup = PLAN_LOOKUP[interval], amount = amountOf(interval);
    const found = (await stripe('GET', '/v1/prices', { lookup_keys: [lookup], active: true, limit: 1 })).data?.[0];
    let id = found && Number(found.unit_amount) === amount && found.recurring?.interval === interval && String(found.currency).toLowerCase() === 'usd' ? found.id : null;
    if (!id) {
      const product = await ensureProduct();
      const p = await stripe('POST', '/v1/prices', { product, currency: 'usd', unit_amount: amount, recurring: { interval }, lookup_key: lookup, transfer_lookup_key: true,
        nickname: interval === 'year' ? 'KnowBot yearly' : 'KnowBot monthly', metadata: { app: 'knowbot', kind: 'plan' } });
      id = p.id;
      log(`[billing] created the ${interval}ly price ${id} (${money(amount / 100)})${found ? `, replacing ${found.id}` : ''}`);
    }
    priceCache.set(interval, { id, at: now() });
    return id;
  }

  // ---------------------------------------------------------------- checkout
  /**
   * Starts the hosted checkout for this bot's plan. → { url, sessionId }
   * @param {object} a  { interval: 'month'|'year', email, kdAccount, successUrl, cancelUrl }
   */
  async function startCheckout(T, { interval = 'month', email = '', kdAccount = null, successUrl, cancelUrl } = {}) {
    if (mode() !== 'hosted') fail(503, 'checkout_unavailable', "Checkout isn't available yet. Your bot is saved; please try again soon.");
    const b = T.flags.billing;
    if (b?.subscriptionId && b.status && !ENDED.has(b.status)) fail(409, 'already_subscribed', 'This bot already has a subscription. Open Manage billing to change it.');
    const name = botName(T);
    const firstTime = !b?.trialUsed;
    const per = interval === 'year' ? 'year' : 'month';
    const each = money(amountOf(interval) / 100);
    const meta = { app: 'knowbot', kind: 'plan', trial: T.id, bot: String(name).slice(0, 120), interval, ...(kdAccount ? { kd_account: String(kdAccount).slice(0, 120) } : {}) };
    let session;
    try {
      const price = await priceFor(interval);
      session = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        client_reference_id: T.id,
        ...(b?.customerId ? { customer: b.customerId } : email ? { customer_email: email } : {}),
        payment_method_collection: 'always', // the card is asked for now; nothing is charged during the free month
        subscription_data: { ...(firstTime ? { trial_period_days: TRIAL_DAYS } : {}), description: `KnowBot · ${name}`.slice(0, 200), metadata: meta },
        metadata: meta,
        custom_text: { submit: { message: (firstTime ? `${name}: today $0. First ${TRIAL_DAYS} days free, then ${each} per ${per}. Cancel anytime.` : `${name}: ${each} per ${per}. Cancel anytime.`).slice(0, 1000) } },
        success_url: successUrl, cancel_url: cancelUrl,
      });
    } catch (e) {
      if (e?.constructor?.name === 'StudioError') throw e;
      log(`[billing] checkout for ${T.id} failed: ${e.message}`);
      fail(502, 'upstream', "Checkout couldn't start. Your bot is safe; try again in a minute.");
    }
    if (!session?.url || !SESSION_RE.test(String(session.id || ''))) { log(`[billing] checkout for ${T.id}: no page url in the reply`); fail(502, 'upstream', "Checkout couldn't start. Your bot is safe; try again in a minute."); }
    const rec = T.flags.billing || (T.flags.billing = {});
    rec.pending = [...(rec.pending || []).filter((x) => x.id !== session.id), { id: session.id, interval, at: new Date(now()).toISOString() }].slice(-5);
    await saveTrial(T);
    log(`[billing] checkout ${session.id} started for ${T.id} (${interval}${firstTime ? `, ${TRIAL_DAYS} days free` : ', no free month'})`);
    return { url: session.url, sessionId: session.id };
  }

  // ---------------------------------------------------------------- applying what the payments account says
  /** A subscription object's status and dates onto the bot's record. → true when something changed. */
  function setFromSubscription(b, sub) {
    const before = JSON.stringify([b.status, b.trialEnd, b.periodEnd, b.cancelAt, b.graceUntil, b.pastDueSince]);
    const status = KNOWN.has(sub.status) ? sub.status : b.status || 'active';
    b.status = status;
    b.trialEnd = ms(sub.trial_end) ?? b.trialEnd ?? null;
    b.periodEnd = ms(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end) ?? b.periodEnd ?? null;
    b.cancelAt = sub.cancel_at_period_end || sub.cancel_at ? (ms(sub.cancel_at) ?? b.periodEnd ?? null) : null;
    const itv = sub.items?.data?.[0]?.price?.recurring?.interval || sub.plan?.interval || sub.metadata?.interval;
    if (itv === 'month' || itv === 'year') b.interval = itv;
    if (ENDED.has(status)) {
      if (!b.endedAt) { b.endedAt = ms(sub.ended_at) ?? now(); b.graceUntil = b.endedAt + graceMs; }
      b.cancelAt = null; b.pastDueSince = null;
    } else {
      b.endedAt = null; b.graceUntil = null;
      b.pastDueSince = status === 'past_due' ? b.pastDueSince || now() : null;
    }
    b.updatedAt = new Date(now()).toISOString();
    return before !== JSON.stringify([b.status, b.trialEnd, b.periodEnd, b.cancelAt, b.graceUntil, b.pastDueSince]);
  }
  const planMeta = (m) => !!m && m.app === 'knowbot' && m.kind === 'plan' && TRIAL_ID_RE.test(String(m.trial || ''));
  const sessionDone = (s) => !!s && s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
  async function cancelDuplicate(session, subId) {
    try {
      const inv = idOf(session.invoice);
      const pi = inv ? idOf((await stripe('GET', `/v1/invoices/${encodeURIComponent(inv)}`)).payment_intent) : null;
      if (pi) await stripe('POST', '/v1/refunds', { payment_intent: pi, metadata: { app: 'knowbot', reason: 'duplicate_plan' } });
      await stripe('DELETE', `/v1/subscriptions/${encodeURIComponent(subId)}`);
      return true;
    } catch (e) { log(`[billing] DUPLICATE subscription ${subId} could not be cancelled: ${e.message}`); return false; }
  }
  /**
   * One finished checkout session onto its bot (idempotent): billing recorded, the bot launched. Throws when the launch
   * could not finish (the webhook answers non-2xx and is retried; the Studio's return check retries too).
   */
  async function applySession(session, { via = 'return', eventId = null } = {}) {
    const m = session?.metadata || {};
    if (!planMeta(m)) return { ignored: true };
    return withLock(m.trial, async () => {
      const T = await loadTrial(m.trial);
      if (!T) { log(`[billing] ${session.id}: no bot ${m.trial}`); return { ignored: true }; }
      const b = T.flags.billing || (T.flags.billing = {});
      b.applied ||= [];
      if (eventId && (b.events || []).includes(eventId)) return { billing: pub(T), duplicate: true };
      if (b.applied.includes(session.id) && T.converted) return { billing: pub(T), already: true, converted: true };
      if (!sessionDone(session)) return { billing: pub(T), pending: true, converted: !!T.converted };
      const subId = idOf(session.subscription), customerId = idOf(session.customer);
      if (b.subscriptionId && subId && b.subscriptionId !== subId && b.status && !ENDED.has(b.status)) {
        // a second checkout finished for a bot that is already subscribed (two tabs): the newer one is undone
        await cancelDuplicate(session, subId);
        b.applied.push(session.id); b.pending = (b.pending || []).filter((x) => x.id !== session.id);
        await saveTrial(T);
        log(`[billing] ${T.id}: duplicate checkout ${session.id} cancelled (already on ${b.subscriptionId})`);
        return { billing: pub(T), duplicate: true, converted: !!T.converted };
      }
      const fresh = b.subscriptionId !== subId;
      Object.assign(b, { customerId: customerId || b.customerId || null, subscriptionId: subId || b.subscriptionId || null, sessionId: session.id,
        interval: m.interval === 'year' ? 'year' : 'month', since: b.since || new Date(now()).toISOString(), trialUsed: true });
      if (fresh) { b.endedAt = null; b.graceUntil = null; b.pastDueSince = null; b.cancelAt = null; b.status = null; }
      // the subscription's own state (trialing or active, its dates); when it can't be read, what the checkout implies
      let sub = typeof session.subscription === 'object' ? session.subscription : null;
      if (!sub && subId) { try { sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`); } catch (e) { log(`[billing] ${T.id}: subscription ${subId} unreadable: ${e.message}`); } }
      if (sub) setFromSubscription(b, sub);
      else if (!b.status) { b.status = session.subscription_data?.trial_period_days || Number(session.amount_total) === 0 ? 'trialing' : 'active'; b.updatedAt = new Date(now()).toISOString(); }
      await saveTrial(T); // the payment is on record before the launch, whatever happens next
      if (!T.converted) {
        try { await launch(T, { customerId: b.customerId }); }
        catch (e) { b.launchError = String(e.code || e.message || e).slice(0, 80); await saveTrial(T).catch(() => {}); log(`[billing] ${T.id}: paid (${session.id}, ${via}) but the launch did not finish: ${e.message}`); changed(T); throw e; }
      }
      delete b.launchError;
      if (!b.applied.includes(session.id)) b.applied.push(session.id);
      if (b.applied.length > 20) b.applied.splice(0, b.applied.length - 20);
      b.pending = (b.pending || []).filter((x) => x.id !== session.id);
      if (eventId) noteEvent(b, eventId);
      await saveTrial(T);
      changed(T);
      log(`[billing] ${T.id}: ${b.status} (${b.interval}) on ${b.subscriptionId || 'no subscription'} via ${via}`);
      return { billing: pub(T), converted: !!T.converted };
    });
  }
  function noteEvent(b, id, createdSec = null) {
    b.events = [...(b.events || []).filter((x) => x !== id), id].slice(-40);
    if (createdSec) b.eventAt = Math.max(Number(b.eventAt || 0), Number(createdSec));
  }
  /** A subscription changed (updated, deleted) or one of its invoices failed. */
  async function applySubscription(trialId, sub, { eventId = null, created = null, failedInvoice = false } = {}) {
    if (!TRIAL_ID_RE.test(String(trialId || ''))) return { ignored: true };
    return withLock(trialId, async () => {
      const T = await loadTrial(trialId);
      if (!T) return { ignored: true };
      const b = T.flags.billing || (T.flags.billing = {});
      if (eventId && (b.events || []).includes(eventId)) return { duplicate: true };
      const subId = idOf(sub);
      if (b.subscriptionId && subId && b.subscriptionId !== subId) return { ignored: true }; // an older subscription of this bot
      // events can arrive out of order: an older one never overwrites a newer state
      if (created && Number(b.eventAt || 0) > Number(created)) { if (eventId) { noteEvent(b, eventId); await saveTrial(T); } return { ignored: true, stale: true }; }
      let did = false;
      if (failedInvoice) {
        if (!b.status || b.status === 'active' || b.status === 'trialing') { b.status = 'past_due'; b.pastDueSince = b.pastDueSince || now(); b.updatedAt = new Date(now()).toISOString(); did = true; }
        b.lastPaymentFailedAt = new Date(now()).toISOString();
      } else {
        if (!b.subscriptionId && subId) b.subscriptionId = subId;
        if (!b.customerId && idOf(sub.customer)) b.customerId = idOf(sub.customer);
        did = setFromSubscription(b, sub);
      }
      if (eventId) noteEvent(b, eventId, created);
      await saveTrial(T);
      if (did) { changed(T); log(`[billing] ${T.id}: ${b.status}${billingPaused(b, now()) ? ' (paused)' : b.graceUntil ? ` (answers until ${iso(b.graceUntil)})` : ''}`); }
      return { billing: pub(T) };
    });
  }

  // ---------------------------------------------------------------- webhook
  const seen = new Map(); // event id → at (this process); the bot's own list survives restarts
  async function webhook(raw, header) {
    const secret = webhookSecret();
    if (!secret) fail(503, 'billing_off', 'The billing webhook is not configured (KNOWBOT_BILLING_WEBHOOK_SECRET).');
    if (!stripeSignatureValid(raw, header, secret, { nowMs: now() })) fail(400, 'bad_signature', 'Stripe-Signature did not verify.');
    let ev;
    try { ev = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { fail(400, 'bad_request', 'invalid JSON'); }
    const id = String(ev?.id || '');
    if (id && seen.has(id)) return { received: true, duplicate: true };
    const obj = ev?.data?.object || {};
    let r = { ignored: true };
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') r = await applySession(obj, { via: 'webhook', eventId: id || null });
    else if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted' || ev.type === 'customer.subscription.paused' || ev.type === 'customer.subscription.resumed') {
      if (planMeta(obj.metadata)) r = await applySubscription(obj.metadata.trial, ev.type === 'customer.subscription.deleted' ? { ...obj, status: 'canceled' } : obj, { eventId: id || null, created: ev.created });
    } else if (ev.type === 'invoice.payment_failed') {
      const subId = idOf(obj.subscription) || idOf(obj.parent?.subscription_details?.subscription);
      let meta = obj.subscription_details?.metadata || obj.parent?.subscription_details?.metadata || null;
      if (!planMeta(meta) && subId) { try { meta = (await stripe('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`)).metadata; } catch (e) { log(`[billing] invoice ${obj.id}: subscription ${subId} unreadable: ${e.message}`); fail(502, 'upstream', 'subscription unreadable'); } }
      if (planMeta(meta)) r = await applySubscription(meta.trial, { id: subId }, { eventId: id || null, created: ev.created, failedInvoice: true });
    }
    if (id) { seen.set(id, now()); if (seen.size > 2000) for (const k of [...seen.keys()].slice(0, 500)) seen.delete(k); }
    return { received: true, ...(r.ignored ? { ignored: true } : {}), ...(r.duplicate ? { duplicate: true } : {}) };
  }

  // ---------------------------------------------------------------- the return from checkout, and Manage billing
  /**
   * Looks at this bot's open checkouts on the payments account and applies a finished one (the return lands before the
   * webhook), then re-reads the subscription (a return from Manage billing). → { converted, billing, paid }
   */
  async function confirm(T, sessionId = null) {
    if (mode() !== 'hosted') return { converted: !!T.converted, billing: pub(T), paid: false };
    const b = T.flags.billing || {};
    const ids = [...new Set([...(sessionId && SESSION_RE.test(String(sessionId)) ? [String(sessionId)] : []), ...(b.pending || []).map((x) => x.id).reverse()])];
    let paid = false;
    for (const id of ids) {
      let s;
      try { s = await stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`); }
      catch (e) {
        if (e.status === 404) { if (T.flags.billing?.pending) { T.flags.billing.pending = T.flags.billing.pending.filter((x) => x.id !== id); } continue; }
        log(`[billing] confirm ${id}: ${e.message}`); fail(502, 'upstream', "We couldn't check your payment yet. It's safe to wait: your bot goes live as soon as it's confirmed.");
      }
      if (!planMeta(s.metadata) || s.metadata.trial !== T.id) { if (id === sessionId) fail(404, 'not_found', 'No such checkout for this bot.'); continue; }
      if (s.status === 'expired' && T.flags.billing?.pending) { T.flags.billing.pending = T.flags.billing.pending.filter((x) => x.id !== id); await saveTrial(T); continue; }
      if (!sessionDone(s)) continue;
      paid = true;
      await applySession(s, { via: 'return' });
      break;
    }
    if (!paid && T.flags.billing?.subscriptionId) await refresh(T);
    return { converted: !!T.converted, billing: pub(T), paid };
  }
  const lastCheck = new Map();
  /** The Studio's "Activating…" poll (GET the bot): at most one look every few seconds while a checkout is open. */
  async function confirmSoon(T, everyMs = 2500) {
    if (T.converted || mode() !== 'hosted' || !(T.flags.billing?.pending || []).length) return;
    if (now() - (lastCheck.get(T.id) || 0) < everyMs) return;
    lastCheck.set(T.id, now());
    if (lastCheck.size > 5000) lastCheck.clear();
    try { await confirm(T); } catch (e) { log(`[billing] return check for ${T.id}: ${e.message}`); }
  }
  async function refresh(T) {
    const subId = T.flags.billing?.subscriptionId;
    if (!subId) return pub(T);
    let sub;
    try { sub = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`); } catch (e) { log(`[billing] refresh ${T.id}: ${e.message}`); return pub(T); }
    return withLock(T.id, async () => {
      if (setFromSubscription(T.flags.billing, sub)) { await saveTrial(T); changed(T); }
      return pub(T);
    });
  }
  /** "Manage billing": the customer portal for this bot's customer (cancel, update the card, invoices). → { url } */
  async function portal(T, returnUrl) {
    if (mode() !== 'hosted') fail(503, 'checkout_unavailable', "Billing isn't available yet.");
    const customer = T.flags.billing?.customerId;
    if (!customer) fail(409, 'no_billing', 'This bot has no subscription yet.');
    let s;
    try { s = await stripe('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl }); }
    catch (e) { log(`[billing] portal for ${T.id}: ${e.message}`); fail(502, 'upstream', "We couldn't open billing right now. Try again in a minute."); }
    if (!s?.url) fail(502, 'upstream', "We couldn't open billing right now. Try again in a minute.");
    return { url: s.url };
  }

  return { mode, available: () => mode() === 'hosted', startCheckout, applySession, applySubscription, webhook, confirm, confirmSoon, refresh, portal, pub, paused, priceFor };
}

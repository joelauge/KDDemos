// KnowBot numbers: a phone number for a bot's texts and calls, bought and paid for right in the Studio.
//
// We are the number provider for our customers: they pick a number in their area, pay at once (an embedded checkout
// inside the Studio), and the number is bought and pointed at their bot's SMS and voice webhooks. One number serves both.
//
//   Price   $10.00/mo service + the number's monthly cost x 1.2, billed monthly (a subscription), plus a one-time
//           prepaid credit pack ($10 / $25 / $50) for calls and texts.
//   Credit  drawn down per call minute (rounded up) and per text segment (in and out) at our provider's cost x 1.2.
//           At zero, calls hear a short "out of credit" line and texts get no reply; the Studio warns when it runs low.
//
// Provider (internal only; never named in the UI): Twilio REST with Basic auth (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)
//   GET  {TWILIO_API_BASE_URL}/2010-04-01/Accounts/{sid}/AvailablePhoneNumbers/{CC}/Local.json  search (US, CA)
//   POST …/IncomingPhoneNumbers.json            buy, with SmsUrl / VoiceUrl = the bot's webhooks (POST)
//   POST …/IncomingPhoneNumbers/{PN}.json       re-point (a trial converted to a launched bot)
//   GET  …/IncomingPhoneNumbers.json?FriendlyName=  adopt a number a crash left unrecorded (never buy twice)
//   DELETE …/IncomingPhoneNumbers/{PN}.json     release (the subscription ended)
//   GET  {TWILIO_PRICING_BASE_URL}/v1/PhoneNumbers|Voice|Messaging/Countries/{CC}   costs (cached; env fallbacks)
// Payments (Recourse Software Inc's account, REST, form-encoded, Bearer STRIPE_SECRET_KEY, Stripe-Version pinned):
//   POST {STRIPE_API_BASE_URL}/v1/checkout/sessions   ui_mode=embedded, redirect_on_completion=never
//        mode=subscription (number) or mode=payment (top-up); metadata.app=knowbot marks our sessions in a shared account
//   GET  /v1/checkout/sessions/{id}                    the return / onComplete check
//   POST /v1/refunds, DELETE /v1/subscriptions/{id}    the number was gone and no close alternative was free
//   Webhook POST /api/studio/numbers/webhook           Stripe-Signature (HMAC-SHA256, STRIPE_WEBHOOK_SECRET, 5 min)
//        checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.deleted
//
// The number is bought ONLY after the payment is confirmed (webhook or the session retrieved on return), and exactly
// once per checkout session: a per-bot lock, the applied-session list in the bot's saved state, and a FriendlyName that
// names the session (a retry after a crash adopts the number it already bought).
//
// State: T.flags.number on the Studio bot (saved in its spec doc like every other trial flag, so it survives restarts
// and is kept when the trial converts to a launched bot; the launched bot points back with `numberTrial`).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { publicBase, smsInfo } from './channels/util.mjs';

/** Billed segments of one text (at least 1 for a non-empty body). */
export const smsSegments = (s) => Math.max(String(s ?? '').length ? 1 : 0, smsInfo(s).segments);
export const SERVICE_CENTS = 1000;           // $10.00 a month for the service
export const MARKUP = 1.2;                   // 20% on what the provider charges us
export const PACKS = [1000, 2500, 5000];     // prepaid credit packs, in cents
export const COUNTRIES = ['US', 'CA'];
export const LOW_MICROS = 2_000_000;         // under $2 of credit: "running low"
const MICROS = 1_000_000;                    // credit is kept in millionths of a dollar (no rounding drift per text)
const STRIPE_VERSION = '2024-06-20';
// The provider's list prices (USD) when its pricing API can't be read; KNOWBOT_NUMBER_COST_* override.
export const FALLBACK_COSTS = { US: { monthly: 1.15, minute: 0.0085, text: 0.0083 }, CA: { monthly: 1.15, minute: 0.0085, text: 0.0083 } };

export const numbersEnabled = (env = {}) => !!(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);

// ------------------------------------------------------------------ pricing math (pure)
const cents2 = (x) => Math.round(Number(x) * 100);
/** What we charge, from the provider's costs (dollars): number $/mo in cents, per minute and per text in micro-dollars. */
export function ratesOf(costs) {
  return {
    serviceCents: SERVICE_CENTS,
    numberCents: Math.max(1, Math.round(Number(costs.monthly) * MARKUP * 100)),
    minuteMicros: Math.max(1, Math.ceil(Number(costs.minute) * MARKUP * MICROS - 1e-6)),
    textMicros: Math.max(1, Math.ceil(Number(costs.text) * MARKUP * MICROS - 1e-6)),
  };
}
/** About how many minutes or texts a pack buys (each alone). */
export function packOf(cents, rates) {
  const m = Number(cents) * 10_000;
  return { cents: Number(cents), minutes: Math.floor(m / rates.minuteMicros), texts: Math.floor(m / rates.textMicros) };
}
/** The price summary the Studio shows and the checkout charges. */
export function quoteOf(rates, packCents) {
  const monthlyCents = rates.serviceCents + rates.numberCents;
  const pack = packCents ? packOf(packCents, rates) : null;
  return {
    currency: 'usd',
    lines: [
      { id: 'service', label: 'KnowBot number service', cents: rates.serviceCents, interval: 'month' },
      { id: 'number', label: 'Your number', cents: rates.numberCents, interval: 'month' },
      ...(pack ? [{ id: 'credit', label: 'Call and text credit', cents: pack.cents, interval: null }] : []),
    ],
    monthlyCents, todayCents: monthlyCents + (pack ? pack.cents : 0),
    rates: { minuteCents: rates.minuteMicros / 10_000, textCents: rates.textMicros / 10_000 },
    pack, packs: PACKS.map((c) => packOf(c, rates)),
  };
}

// ------------------------------------------------------------------ Stripe webhook signatures
/** `t=<unix>,v1=<hex>` over `${t}.${raw}` with HMAC-SHA256(secret). */
export function signStripe(raw, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', String(secret)).update(`${t}.${Buffer.from(raw).toString('utf8')}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
export function stripeSignatureValid(raw, header, secret, { toleranceSec = 300, nowMs = Date.now() } = {}) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v || '');
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - t) > toleranceSec) return false;
  const want = createHmac('sha256', String(secret)).update(`${t}.${Buffer.from(raw).toString('utf8')}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/** Stripe's form encoding: nested objects and arrays as key[a][0][b]=v. */
export function stripeForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object' ? stripeForm(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') stripeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;
const AREA_RE = /^[2-9]\d{2}$/;
const pretty = (e) => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e || '')); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e || ''); };
export const prettyNumber = pretty;

/**
 * @param {object} o
 * @param {object} o.env
 * @param {(id: string) => Promise<object|null>} o.loadTrial   the bot's live Studio state (T), loaded from its doc
 * @param {(T: object, opts?: {soon?: boolean}) => Promise<void>} o.saveTrial  persists T (flags included)
 * @param {(T: object, data: object) => void} [o.onChange]    pushes the new number state to the open Studio
 * @param {(status, code, message, extra?) => never} o.fail
 */
export function createNumbers({ env = {}, log = () => {}, now = () => Date.now(), loadTrial, saveTrial, onChange = () => {}, fail } = {}) {
  const twBase = String(env.TWILIO_API_BASE_URL || 'https://api.twilio.com').replace(/\/+$/, '');
  const prBase = String(env.TWILIO_PRICING_BASE_URL || 'https://pricing.twilio.com').replace(/\/+$/, '');
  const stBase = String(env.STRIPE_API_BASE_URL || 'https://api.stripe.com').replace(/\/+$/, '');
  const apiPrefix = env.KNOWBOT_API_PREFIX != null ? String(env.KNOWBOT_API_PREFIX).replace(/\/+$/, '') : '/api';
  const enabled = () => numbersEnabled(env);
  const sid = env.TWILIO_ACCOUNT_SID;
  const twAuth = () => `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;

  // ---------------------------------------------------------------- provider REST
  async function tw(method, p, form = null, base = `${twBase}/2010-04-01/Accounts/${encodeURIComponent(sid)}`) {
    const init = { method, headers: { authorization: twAuth() }, signal: AbortSignal.timeout(15000) };
    if (form) { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(form).toString(); }
    const res = await fetch(`${base}${p}`, init);
    const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`number provider HTTP ${res.status}${j.code ? ` (${j.code})` : ''}: ${String(j.message || '').slice(0, 160)}`); e.status = res.status; e.code = j.code; throw e; }
    return j;
  }
  async function stripe(method, p, body = null) {
    const init = { method, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'stripe-version': STRIPE_VERSION }, signal: AbortSignal.timeout(20000) };
    if (body) { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = stripeForm(body).toString(); }
    const res = await fetch(`${stBase}${p}`, init);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`payments HTTP ${res.status}: ${String(j.error?.message || '').slice(0, 160)}`); e.status = res.status; throw e; }
    return j;
  }

  // ---------------------------------------------------------------- costs (cached an hour per country)
  const costCache = new Map();
  const envCost = (k, d) => (Number(env[k]) > 0 ? Number(env[k]) : d);
  async function costsOf(cc) {
    const hit = costCache.get(cc);
    if (hit && now() - hit.at < 3600000) return hit.costs;
    const fb = FALLBACK_COSTS[cc] || FALLBACK_COSTS.US;
    const costs = { monthly: fb.monthly, minute: fb.minute, text: fb.text, source: 'fallback' };
    const get = (p) => tw('GET', p, null, prBase);
    const price = (x) => Number(x?.current_price ?? x?.base_price);
    try {
      const [pn, vo, ms] = await Promise.allSettled([get(`/v1/PhoneNumbers/Countries/${cc}`), get(`/v1/Voice/Countries/${cc}`), get(`/v1/Messaging/Countries/${cc}`)]);
      const local = pn.value?.phone_number_prices?.find((x) => x.number_type === 'local');
      if (price(local) > 0) { costs.monthly = price(local); costs.source = 'provider'; }
      const inbound = vo.value?.inbound_call_prices?.find((x) => x.number_type === 'local');
      if (price(inbound) > 0) costs.minute = price(inbound);
      // the dearest carrier, in or out (a question in, an answer out): never under-charge a text
      const smsPrices = [...(ms.value?.outbound_sms_prices || []), ...(ms.value?.inbound_sms_prices || [])]
        .flatMap((c) => (c.prices || [c]).filter((x) => !x.number_type || x.number_type === 'local').map(price)).filter((x) => x > 0);
      if (smsPrices.length) costs.text = Math.max(...smsPrices);
    } catch (e) { log(`[numbers] pricing for ${cc} unavailable: ${e.message}`); }
    costs.monthly = envCost('KNOWBOT_NUMBER_COST_MONTHLY', costs.monthly);
    costs.minute = envCost('KNOWBOT_NUMBER_COST_MINUTE', costs.minute);
    costs.text = envCost('KNOWBOT_NUMBER_COST_TEXT', costs.text);
    costCache.set(cc, { at: now(), costs });
    return costs;
  }
  async function quote(cc, packCents = null) { return quoteOf(ratesOf(await costsOf(cc)), packCents); }

  // ---------------------------------------------------------------- search
  const countryOf = (x) => { const c = String(x || 'US').toUpperCase(); return COUNTRIES.includes(c) ? c : fail(400, 'bad_request', 'Numbers are available in the US and Canada.', { field: 'country' }); };
  async function search({ areaCode = '', country = 'US', city = '', region = '', limit = 12 } = {}) {
    const cc = countryOf(country);
    const q = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: String(Math.max(1, Math.min(20, Number(limit) || 12))) });
    const ac = String(areaCode || '').replace(/\D+/g, '');
    if (ac) { if (!AREA_RE.test(ac)) fail(400, 'bad_request', 'Area codes have 3 digits, like 415.', { field: 'areaCode' }); q.set('AreaCode', ac); }
    const c = String(city || '').trim().slice(0, 60), r = String(region || '').trim().slice(0, 40);
    if (c) q.set('InLocality', c);
    if (r) q.set('InRegion', r);
    if (!ac && !c && !r) fail(400, 'bad_request', 'Type an area code or a city.', { field: 'areaCode' });
    let j;
    try { j = await tw('GET', `/AvailablePhoneNumbers/${cc}/Local.json?${q}`); }
    catch (e) { log(`[numbers] search failed: ${e.message}`); fail(502, 'upstream', "We couldn't look up numbers right now. Try again in a minute."); }
    const numbers = (j.available_phone_numbers || []).filter((n) => E164_RE.test(n.phone_number || '')).map((n) => ({
      phoneNumber: n.phone_number, display: pretty(n.phone_number), locality: n.locality || null, region: n.region || null, postalCode: n.postal_code || null, country: n.iso_country || cc,
    }));
    return { country: cc, areaCode: ac || null, numbers, quote: await quote(cc) };
  }

  // ---------------------------------------------------------------- state
  const pub = (rec) => {
    if (!rec || !rec.state) return null;
    const balanceMicros = Number(rec.balanceMicros || 0);
    return {
      state: rec.state, phoneNumber: rec.phoneNumber || null, display: pretty(rec.phoneNumber), locality: rec.locality || null, region: rec.region || null, country: rec.country || 'US',
      requested: rec.requested && rec.requested !== rec.phoneNumber ? pretty(rec.requested) : null,
      balanceCents: Math.floor(balanceMicros / 10_000), balance: (Math.max(0, balanceMicros) / MICROS).toFixed(2),
      low: rec.state === 'active' && balanceMicros < LOW_MICROS, out: rec.state === 'active' && balanceMicros <= 0,
      minutesLeft: rec.rates ? Math.max(0, Math.floor(balanceMicros / rec.rates.minuteMicros)) : 0,
      textsLeft: rec.rates ? Math.max(0, Math.floor(balanceMicros / rec.rates.textMicros)) : 0,
      monthlyCents: rec.rates ? rec.rates.serviceCents + rec.rates.numberCents : null, rates: rec.rates ? { minuteCents: rec.rates.minuteMicros / 10_000, textCents: rec.rates.textMicros / 10_000 } : null,
      note: rec.note || null, boughtAt: rec.boughtAt || null,
      usage: (rec.ledger || []).slice(-8).reverse().map((x) => ({ at: x.at, kind: x.kind, units: x.units, cents: Math.round(x.micros / 100) / 100 })),
    };
  };
  const locks = new Map();
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    locks.set(key, settled);
    settled.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
    return next;
  }
  const ledger = (rec, kind, units, micros, ref = null) => {
    rec.balanceMicros = Number(rec.balanceMicros || 0) + micros;
    (rec.ledger ||= []).push({ at: new Date(now()).toISOString(), kind, units, micros, balanceMicros: rec.balanceMicros, ...(ref ? { ref } : {}) });
    if (rec.ledger.length > 200) rec.ledger.splice(0, rec.ledger.length - 200);
  };
  const hookBaseOf = (req) => publicBase(req, env) + apiPrefix;
  const hooks = (base, botId) => ({ SmsUrl: `${base}/v1/channels/${encodeURIComponent(botId)}/sms`, SmsMethod: 'POST', VoiceUrl: `${base}/v1/channels/${encodeURIComponent(botId)}/voice`, VoiceMethod: 'POST' });
  const friendly = (trialId, sessionId) => `KnowBot ${trialId} ${String(sessionId).slice(-16)}`;

  // ---------------------------------------------------------------- checkout
  function needOn() { if (!enabled()) fail(503, 'numbers_off', 'KnowBot numbers are coming soon.'); }
  function packOrFail(p) { const c = Number(p); if (!PACKS.includes(c)) fail(400, 'bad_request', 'Pick a credit pack: $10, $25 or $50.', { field: 'pack' }); return c; }
  async function startCheckout(req, T, body = {}) {
    needOn();
    const rec = T.flags.number;
    if (rec && (rec.state === 'active' || rec.state === 'buying')) fail(409, 'has_number', 'This bot already has a KnowBot number.');
    const phone = String(body.phoneNumber || '').trim();
    if (!E164_RE.test(phone)) fail(400, 'bad_request', 'Pick a number from the list.', { field: 'phoneNumber' });
    const cc = countryOf(body.country || (phone.startsWith('+1') ? 'US' : ''));
    const pack = packOrFail(body.pack);
    const rates = ratesOf(await costsOf(cc));
    const q = quoteOf(rates, pack);
    const label = pretty(phone);
    const meta = { app: 'knowbot', kind: 'number', trial: T.id, phone, country: cc, pack: String(pack), hook_base: hookBaseOf(req),
      number_cents: String(rates.numberCents), minute_micros: String(rates.minuteMicros), text_micros: String(rates.textMicros),
      locality: String(body.locality || '').slice(0, 60), region: String(body.region || '').slice(0, 20) };
    const session = await stripe('POST', '/v1/checkout/sessions', {
      ui_mode: 'embedded', redirect_on_completion: 'never', mode: 'subscription',
      line_items: [
        { quantity: 1, price_data: { currency: 'usd', unit_amount: rates.serviceCents, recurring: { interval: 'month' }, product_data: { name: 'KnowBot number service', description: 'Texts and calls answered by your bot' } } },
        { quantity: 1, price_data: { currency: 'usd', unit_amount: rates.numberCents, recurring: { interval: 'month' }, product_data: { name: `Your KnowBot number ${label}` } } },
        { quantity: 1, price_data: { currency: 'usd', unit_amount: pack, product_data: { name: 'Call and text credit', description: `About ${q.pack.minutes} call minutes or ${q.pack.texts} texts` } } },
      ],
      ...(T.email ? { customer_email: T.email } : {}),
      metadata: meta, subscription_data: { metadata: meta },
    }).catch((e) => { log(`[numbers] checkout for ${T.id} failed: ${e.message}`); fail(502, 'upstream', "Checkout couldn't start. Try again in a minute."); });
    T.flags.numberCheckout = { id: session.id, phone, pack, at: new Date(now()).toISOString() };
    await saveTrial(T, { soon: true });
    log(`[numbers] checkout ${session.id} started for ${T.id} (${phone}, pack ${pack})`);
    return { sessionId: session.id, clientSecret: session.client_secret, quote: q };
  }
  async function startTopUp(req, T, body = {}) {
    needOn();
    const rec = T.flags.number;
    if (!rec || rec.state !== 'active') fail(409, 'no_number', 'Get a KnowBot number first.');
    const pack = packOrFail(body.pack);
    const p = packOf(pack, rec.rates);
    const meta = { app: 'knowbot', kind: 'topup', trial: T.id, pack: String(pack) };
    const session = await stripe('POST', '/v1/checkout/sessions', {
      ui_mode: 'embedded', redirect_on_completion: 'never', mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: pack, product_data: { name: 'Call and text credit', description: `About ${p.minutes} call minutes or ${p.texts} texts for ${pretty(rec.phoneNumber)}` } } }],
      ...(rec.customerId ? { customer: rec.customerId } : T.email ? { customer_email: T.email } : {}),
      metadata: meta, payment_intent_data: { metadata: meta },
    }).catch((e) => { log(`[numbers] top-up for ${T.id} failed: ${e.message}`); fail(502, 'upstream', "Checkout couldn't start. Try again in a minute."); });
    return { sessionId: session.id, clientSecret: session.client_secret, pack: p };
  }

  // ---------------------------------------------------------------- fulfilment (after payment only, once per session)
  const paid = (s) => s && s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
  async function refund(session, why) {
    try {
      let pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (!pi && session.invoice) {
        const inv = typeof session.invoice === 'object' ? session.invoice : await stripe('GET', `/v1/invoices/${encodeURIComponent(session.invoice)}`);
        pi = typeof inv.payment_intent === 'string' ? inv.payment_intent : inv.payment_intent?.id;
      }
      if (pi) await stripe('POST', '/v1/refunds', { payment_intent: pi, metadata: { app: 'knowbot', reason: why } });
      const sub = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (sub) await stripe('DELETE', `/v1/subscriptions/${encodeURIComponent(sub)}`);
      return true;
    } catch (e) { log(`[numbers] refund for ${session.id} failed: ${e.message}`); return false; }
  }
  async function buyNumber(T, session, rec) {
    const m = session.metadata || {};
    const want = String(m.phone || '');
    const base = m.hook_base || rec.hookBase;
    const fn = friendly(T.id, session.id);
    // a crash after buying but before saving: the number we already own for this session is adopted, never bought again
    if (rec.buying === session.id) {
      try {
        const own = await tw('GET', `/IncomingPhoneNumbers.json?${new URLSearchParams({ FriendlyName: fn })}`);
        const n = own.incoming_phone_numbers?.[0];
        if (n?.sid) return { sid: n.sid, phoneNumber: n.phone_number, adopted: true };
      } catch (e) { log(`[numbers] adopt check for ${session.id}: ${e.message}`); }
    }
    rec.buying = session.id;
    await saveTrial(T);
    const tryBuy = (phone) => tw('POST', '/IncomingPhoneNumbers.json', { PhoneNumber: phone, FriendlyName: fn, ...hooks(base, T.id) });
    try { const n = await tryBuy(want); return { sid: n.sid, phoneNumber: n.phone_number || want }; }
    catch (e) { if (e.status && e.status < 500 && e.status !== 429) log(`[numbers] ${want} could not be bought (${e.message}); trying the same area code`); else throw e; }
    // taken meanwhile: the closest free number in the same area code
    const area = /^\+1(\d{3})/.exec(want)?.[1];
    if (area) {
      let list = [];
      try { list = (await tw('GET', `/AvailablePhoneNumbers/${m.country || 'US'}/Local.json?${new URLSearchParams({ AreaCode: area, SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '5' })}`)).available_phone_numbers || []; }
      catch (e) { log(`[numbers] alternative search failed: ${e.message}`); }
      for (const alt of list.slice(0, 3)) {
        if (!alt?.phone_number || alt.phone_number === want) continue;
        try { const n = await tryBuy(alt.phone_number); return { sid: n.sid, phoneNumber: n.phone_number || alt.phone_number, swapped: true, locality: alt.locality, region: alt.region }; }
        catch (e) { log(`[numbers] alternative ${alt.phone_number} failed: ${e.message}`); }
      }
    }
    return null;
  }
  /** Applies one paid checkout session to its bot (idempotent). → the public number state. */
  async function fulfill(session, { via = 'return' } = {}) {
    const m = session?.metadata || {};
    if (m.app !== 'knowbot' || !/^tr_[a-z2-7]{16}$/.test(String(m.trial || ''))) return { ignored: true };
    return withLock(m.trial, async () => {
      const T = await loadTrial(m.trial);
      if (!T) { log(`[numbers] ${session.id}: no bot ${m.trial}`); return { ignored: true }; }
      const rec = T.flags.number || (T.flags.number = { state: null, balanceMicros: 0, ledger: [], applied: [] });
      rec.applied ||= [];
      if (rec.applied.includes(session.id)) return { state: pub(rec), already: true };
      if (!paid(session)) return { state: pub(rec), pending: true };
      const pack = Number(m.pack) || 0;
      if (m.kind === 'topup') {
        if (!rec.rates) return { ignored: true };
        ledger(rec, 'credit', pack, pack * 10_000, session.id);
        rec.applied.push(session.id);
        log(`[numbers] ${T.id}: +$${(pack / 100).toFixed(2)} credit (${via})`);
      } else if (m.kind === 'number') {
        if (rec.state === 'active' && rec.sid) {
          // a second number checkout for a bot that has one (two tabs): give the money back
          rec.applied.push(session.id);
          await refund(session, 'duplicate');
          log(`[numbers] ${T.id}: duplicate number checkout ${session.id} refunded`);
        } else {
          rec.state = 'buying';
          rec.requested = m.phone; rec.country = m.country || 'US';
          rec.customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || rec.customerId || null;
          rec.subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
          rec.checkoutId = session.id; rec.hookBase = m.hook_base || rec.hookBase || null;
          rec.rates = { serviceCents: SERVICE_CENTS, numberCents: Number(m.number_cents), minuteMicros: Number(m.minute_micros), textMicros: Number(m.text_micros) };
          let got = null;
          try { got = await buyNumber(T, session, rec); }
          catch (e) { rec.state = null; await saveTrial(T); throw e; } // provider down: the webhook / return retries later
          if (got) {
            Object.assign(rec, { state: 'active', sid: got.sid, phoneNumber: got.phoneNumber, locality: got.swapped ? got.locality || null : m.locality || null,
              region: got.swapped ? got.region || null : m.region || null, boughtAt: new Date(now()).toISOString(),
              note: got.swapped ? `${pretty(m.phone)} was taken while you paid, so you got ${pretty(got.phoneNumber)}, in the same area code.` : null });
            delete rec.buying;
            ledger(rec, 'credit', pack, pack * 10_000, session.id);
            log(`[numbers] ${T.id}: bought ${got.phoneNumber}${got.swapped ? ` (instead of ${m.phone})` : ''}${got.adopted ? ' (adopted)' : ''} via ${via}`);
          } else {
            const ok = await refund(session, 'number_unavailable');
            Object.assign(rec, { state: 'refunded', note: ok ? `${pretty(m.phone)} was taken while you paid, and no other number in that area code was free. Your payment was refunded.`
              : `${pretty(m.phone)} was taken while you paid. We'll refund your payment.` });
            delete rec.buying;
            log(`[numbers] ${T.id}: ${m.phone} unavailable, ${ok ? 'refunded' : 'REFUND FAILED'}`);
          }
          rec.applied.push(session.id);
          if (T.flags.numberCheckout?.id === session.id) delete T.flags.numberCheckout;
        }
      } else return { ignored: true };
      await saveTrial(T);
      const state = pub(rec);
      try { onChange(T, state); } catch { /* no open Studio */ }
      return { state };
    });
  }
  async function confirm(T, sessionId) {
    needOn();
    if (!/^cs_[A-Za-z0-9_]{6,200}$/.test(String(sessionId || ''))) fail(400, 'bad_request', 'sessionId is required.', { field: 'sessionId' });
    let s;
    try { s = await stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`); }
    catch (e) { log(`[numbers] confirm ${sessionId}: ${e.message}`); fail(502, 'upstream', "We couldn't check your payment yet. It's safe to wait: your number appears here once it's paid."); }
    if (s.metadata?.app !== 'knowbot' || s.metadata?.trial !== T.id) fail(404, 'not_found', 'No such checkout for this bot.');
    const r = await fulfill(s, { via: 'return' });
    return { ...r, paid: paid(s) };
  }
  async function webhook(raw, header) {
    if (!env.STRIPE_WEBHOOK_SECRET) fail(503, 'numbers_off', 'Payments webhook is not configured (STRIPE_WEBHOOK_SECRET).');
    if (!stripeSignatureValid(raw, header, env.STRIPE_WEBHOOK_SECRET, { nowMs: now() })) fail(400, 'bad_signature', 'Stripe-Signature did not verify.');
    let ev;
    try { ev = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { fail(400, 'bad_request', 'invalid JSON'); }
    const obj = ev?.data?.object || {};
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      const r = await fulfill(obj, { via: 'webhook' });
      return { received: true, ...(r.ignored ? { ignored: true } : {}) };
    }
    if (ev.type === 'customer.subscription.deleted' && obj.metadata?.app === 'knowbot' && obj.metadata?.kind === 'number') {
      await release(obj.metadata.trial, obj.id);
      return { received: true };
    }
    return { received: true, ignored: true };
  }
  /** The subscription ended: the number is let go and stops answering. */
  function release(trialId, subscriptionId) {
    if (!/^tr_[a-z2-7]{16}$/.test(String(trialId || ''))) return null;
    return withLock(trialId, async () => {
      const T = await loadTrial(trialId);
      const rec = T?.flags?.number;
      if (!rec || rec.state !== 'active' || (rec.subscriptionId && rec.subscriptionId !== subscriptionId)) return null;
      try { if (rec.sid) await tw('DELETE', `/IncomingPhoneNumbers/${encodeURIComponent(rec.sid)}.json`); }
      catch (e) { log(`[numbers] release ${rec.sid} failed: ${e.message}`); }
      rec.state = 'cancelled'; rec.note = 'Your KnowBot number plan ended, so the number was released.';
      await saveTrial(T);
      try { onChange(T, pub(rec)); } catch { /* none */ }
      log(`[numbers] ${trialId}: subscription ${subscriptionId} ended; released ${rec.phoneNumber}`);
      return pub(rec);
    });
  }
  /** A trial became a launched bot: its number now answers for that bot. */
  async function repoint(T, botId) {
    const rec = T.flags.number;
    if (!rec || rec.state !== 'active' || !rec.sid || !rec.hookBase || !enabled()) return false;
    await tw('POST', `/IncomingPhoneNumbers/${encodeURIComponent(rec.sid)}.json`, hooks(rec.hookBase, botId));
    rec.botId = String(botId).toLowerCase();
    await saveTrial(T);
    log(`[numbers] ${T.id}: ${rec.phoneNumber} now points at bot ${rec.botId}`);
    return true;
  }

  // ---------------------------------------------------------------- metering (devapi channels)
  /**
   * The bot's own number and its credit, or null (no KnowBot number: the channel runs as before, unmetered).
   * → { phoneNumber, ok(), secondsLeft(), charge(kind: 'call'|'text', units, ref) }
   */
  async function meterFor(target) {
    if (!enabled() || !target) return null;
    const trialId = target.kind === 'trial' ? target.id : target.inst?.numberTrial || null;
    if (!trialId) return null;
    if (target.kind === 'trial' && !(target.flags || target.T?.flags)?.number) return null;
    const T = await loadTrial(trialId).catch(() => null);
    const rec = T?.flags?.number;
    if (!rec || rec.state !== 'active' || !rec.rates) return null;
    return {
      phoneNumber: rec.phoneNumber,
      ok: () => Number(rec.balanceMicros || 0) > 0,
      secondsLeft: () => Math.max(0, Math.floor(Number(rec.balanceMicros || 0) / rec.rates.minuteMicros) * 60),
      charge: async (kind, units = 1, ref = null) => {
        const n = Math.max(0, Math.ceil(Number(units) || 0));
        if (!n) return pub(rec);
        const per = kind === 'call' ? rec.rates.minuteMicros : rec.rates.textMicros;
        const wasLow = Number(rec.balanceMicros || 0) < LOW_MICROS;
        ledger(rec, kind, n, -n * per, ref);
        await saveTrial(T, { soon: true });
        const st = pub(rec);
        if (st.low && !wasLow) log(`[numbers] ${T.id}: credit is low ($${st.balance})`);
        try { onChange(T, st); } catch { /* none */ }
        return st;
      },
    };
  }

  /** Studio GET: whether numbers are on, the prices and packs, and this bot's number. */
  async function status(T) {
    if (!enabled()) return { enabled: false };
    const rec = T.flags.number;
    const cc = rec?.country || 'US';
    return { enabled: true, publishableKey: env.STRIPE_PUBLISHABLE_KEY, checkoutJs: env.STRIPE_JS_URL || 'https://js.stripe.com/v3/', countries: COUNTRIES,
      quote: await quote(cc), number: pub(rec) };
  }

  return { enabled, status, search, quote, startCheckout, startTopUp, confirm, webhook, fulfill, release, repoint, meterFor, pub, costsOf };
}

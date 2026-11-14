// A stand-in for the payments API (Stripe REST, form-encoded) for tests and the local dev server. Loopback only.
//
//   POST   /v1/checkout/sessions          embedded checkout → { id, client_secret, status:'open', … }
//   GET    /v1/checkout/sessions/:id      the session (status / payment_status / customer / subscription / invoice)
//   GET    /v1/invoices/:id               { payment_intent }
//   POST   /v1/refunds                    recorded in `refunds`
//   DELETE /v1/subscriptions/:id          recorded in `cancelled`
//   GET    /stripe.js                     a tiny Stripe.js stand-in for the browser: Stripe(pk).initEmbeddedCheckout(
//                                        { fetchClientSecret, onComplete }) mounts a "Pay" button that marks the session
//                                        paid here (POST /test/pay, CORS) and calls onComplete (the dev server's smoke)
//   POST   /test/pay {client_secret}      completes a session (also complete(id) in tests); posts the signed
//                                        checkout.session.completed event to `webhook.url` when one is set
//
// The KnowBot plan (server/billing.mjs), a hosted subscription checkout:
//   GET/POST /v1/products[/:id], GET /v1/prices?lookup_keys[0]=…, POST /v1/prices (lookup_key, transfer_lookup_key)
//   POST   /v1/checkout/sessions          without ui_mode: hosted → { url: <this fake>/pay/:id } (success_url, cancel_url)
//   GET    /pay/:id                       the checkout page (product, price, trial, bot line, email); the button completes
//                                         the session and goes to success_url, "Back" goes to cancel_url
//   GET    /v1/subscriptions/:id          the subscription (trialing | active | …); DELETE cancels it
//   POST   /v1/billing_portal/sessions    → { url: <this fake>/portal/:id }: "Cancel subscription", "Return"
//   Webhooks: every entry of state.webhooks ({url, secret}, besides state.webhook) gets the signed events, after
//   state.webhookDelayMs. setSubscription(id, patch, type?) changes a subscription and sends customer.subscription.updated
//   (or .deleted); failInvoice(subId) sends invoice.payment_failed; send(type, object) sends any event.
// Helpers: event(type, object, secret) → { raw, header } (a signed webhook delivery).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { signStripe } from '../numbers.mjs';

/** key[a][0][b]=v → nested objects / arrays. */
export function parseStripeForm(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const path = k.replace(/\]/g, '').split('[');
    let o = out;
    path.forEach((p, i) => {
      const last = i === path.length - 1;
      const nextIsIdx = !last && /^\d+$/.test(path[i + 1]);
      if (last) o[p] = v;
      else o = (o[p] ??= nextIsIdx ? [] : {});
    });
  }
  return out;
}

export async function startFakeStripe({ host = '127.0.0.1', webhook = null } = {}) {
  const sessions = new Map();
  const refunds = [], cancelled = [], requests = [];
  const products = new Map(), prices = new Map(), subscriptions = new Map(), portals = new Map(), sent = [];
  const state = { webhook, webhooks: [], webhookDelayMs: 0, down: false };
  let base = '';
  const hooks = () => [...(state.webhook?.url ? [state.webhook] : []), ...state.webhooks.filter((w) => w?.url)];
  /** Posts one signed event to every configured webhook (after state.webhookDelayMs). → the event id */
  function sendEvent(type, object) {
    const id = rid('evt');
    const raw = JSON.stringify({ id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } });
    const go = () => Promise.all(hooks().map(async (w) => {
      const rec = { type, id, url: w.url, status: null };
      sent.push(rec);
      try { rec.status = (await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(raw, w.secret) }, body: raw })).status; } catch (e) { rec.status = e.message; }
    }));
    if (state.webhookDelayMs > 0) setTimeout(go, state.webhookDelayMs); else go();
    return id;
  }
  function setSubscription(id, patch = {}, type = null) {
    const sub = subscriptions.get(id);
    if (!sub) return null;
    Object.assign(sub, patch);
    if (sub.status === 'canceled' && !sub.ended_at) sub.ended_at = Math.floor(Date.now() / 1000);
    sendEvent(type || (sub.status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated'), { ...sub });
    return sub;
  }
  function failInvoice(subId) {
    const sub = subscriptions.get(subId);
    if (!sub) return null;
    return sendEvent('invoice.payment_failed', { id: rid('in'), object: 'invoice', customer: sub.customer, subscription: sub.id, subscription_details: { metadata: sub.metadata } });
  }
  const rid = (p) => `${p}_test_${randomBytes(9).toString('hex')}`;
  function complete(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (s.status === 'complete') return s;
    Object.assign(s, { status: 'complete', payment_status: 'paid', customer: s.customer || rid('cus') });
    if (s.mode === 'subscription') {
      Object.assign(s, { subscription: rid('sub'), invoice: rid('in') });
      const days = Number(s.subscription_data?.trial_period_days) || 0;
      const nowSec = Math.floor(Date.now() / 1000);
      const price = prices.get(s.line_items?.[0]?.price) || null;
      if (days) s.payment_status = 'no_payment_required'; // nothing is charged while the trial runs
      subscriptions.set(s.subscription, { id: s.subscription, object: 'subscription', status: days ? 'trialing' : 'active', customer: s.customer, metadata: s.subscription_data?.metadata || {},
        description: s.subscription_data?.description || null, trial_end: days ? nowSec + days * 86400 : null, current_period_end: nowSec + (days || 30) * 86400, cancel_at_period_end: false, cancel_at: null, ended_at: null,
        items: { data: [{ price: price ? { id: price.id, unit_amount: price.unit_amount, recurring: price.recurring } : null }] } });
    } else s.payment_intent = rid('pi');
    sendEvent('checkout.session.completed', s);
    return s;
  }
  function event(type, object, secret, t) {
    const raw = JSON.stringify({ id: rid('evt'), object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } });
    return { raw, header: signStripe(raw, secret, t) };
  }
  const browserJs = (base) => `// fake Stripe.js (dev server only)
window.Stripe = function (pk) {
  return { initEmbeddedCheckout: async function (o) {
    const secret = await o.fetchClientSecret();
    let root = null;
    return {
      mount(el) {
        root = typeof el === 'string' ? document.querySelector(el) : el;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary'; b.textContent = 'Pay (test card)'; b.dataset.fakePay = '1';
        const p = document.createElement('p'); p.textContent = 'Test checkout (no card is charged).';
        b.onclick = async () => { b.disabled = true; await fetch(${JSON.stringify(base)} + '/test/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_secret: secret }) }); o.onComplete && o.onComplete(); };
        root.append(p, b);
      },
      unmount() { if (root) root.innerHTML = ''; },
      destroy() { if (root) root.innerHTML = ''; },
    };
  } };
};`;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const text = Buffer.concat(chunks).toString('utf8');
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST, GET' }); return res.end(); }
      if (u.pathname === '/stripe.js') { res.writeHead(200, { 'content-type': 'text/javascript', ...cors }); return res.end(browserJs(`http://${req.headers.host}`)); }
      if (u.pathname === '/test/pay' && req.method === 'POST') {
        let j = {}; try { j = JSON.parse(text); } catch { /* none */ }
        const s = [...sessions.values()].find((x) => x.client_secret === j.client_secret);
        return s ? send(200, complete(s.id)) : send(404, { error: { message: 'no such session' } });
      }
      const html = (status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:0 auto;padding:24px;max-width:480px;color:#222}h1{font-size:22px}.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #eee}button{width:100%;padding:14px;font-size:16px;margin-top:20px;border-radius:10px;border:0;background:#222;color:#fff}a{display:block;margin-top:16px;color:#444}</style>${body}`); };
      const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      let pm;
      // the hosted checkout page (a browser, no API key)
      if ((pm = /^\/pay\/(\w+)(\/complete)?$/.exec(u.pathname))) {
        const s = sessions.get(pm[1]);
        if (!s) return html(404, '<title>Checkout</title><h1>No such checkout</h1>');
        if (pm[2]) {
          complete(s.id);
          res.writeHead(303, { location: String(s.success_url || '/').replace('{CHECKOUT_SESSION_ID}', s.id) });
          return res.end();
        }
        const price = prices.get(s.line_items?.[0]?.price) || null, product = price ? products.get(price.product) : null;
        const days = Number(s.subscription_data?.trial_period_days) || 0;
        const amt = price ? `$${(price.unit_amount / 100).toLocaleString('en-US')}` : '';
        return html(200, `<title>Checkout (test)</title><h1 id=product>${esc(product?.name || 'Subscription')}</h1><p>Test checkout page. Nothing is charged.</p>
<div class=row><span>Plan</span><b id=plan>${amt} per ${esc(price?.recurring?.interval || '')}</b></div>
<div class=row><span>Free trial</span><b id=trial>${days ? `${days} days free` : 'none'}</b></div>
<div class=row><span>Due today</span><b id=today>${days ? '$0' : amt}</b></div>
<div class=row><span>Email</span><b id=email>${esc(s.customer_email || s.customer || '')}</b></div>
<p id=note>${esc(s.custom_text?.submit?.message || '')}</p>
<form method=post action="/pay/${s.id}/complete"><button id=pay type=submit>${days ? 'Start trial' : 'Subscribe'}</button></form>
<a id=back href="${esc(s.cancel_url || '/')}">Back</a>`);
      }
      // the customer portal page
      if ((pm = /^\/portal\/(\w+)(\/cancel)?$/.exec(u.pathname))) {
        const ps = portals.get(pm[1]);
        if (!ps) return html(404, '<title>Billing</title><h1>No such page</h1>');
        const subs = [...subscriptions.values()].filter((x) => x.customer === ps.customer && x.status !== 'canceled');
        if (pm[2]) { for (const x of subs) setSubscription(x.id, { status: 'canceled' }); res.writeHead(303, { location: ps.return_url || '/' }); return res.end(); }
        return html(200, `<title>Billing (test)</title><h1>Billing</h1><p>Test billing page.</p><div class=row><span>Subscriptions</span><b id=subs>${subs.length}</b></div>
<form method=post action="/portal/${ps.id}/cancel"><button id=cancel type=submit>Cancel subscription</button></form><a id=return href="${esc(ps.return_url || '/')}">Return</a>`);
      }
      const body = parseStripeForm(req.method === 'GET' ? u.search.slice(1) : text);
      requests.push({ method: req.method, path: u.pathname, body, version: req.headers['stripe-version'] || null, auth: req.headers.authorization || null });
      if (!/^Bearer \S+/.test(String(req.headers.authorization || ''))) return send(401, { error: { type: 'invalid_request_error', message: 'No API key' } });
      if (state.down) return send(500, { error: { type: 'api_error', message: 'down' } });
      let m;
      if (u.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
        const hosted = !body.ui_mode || body.ui_mode === 'hosted';
        if (hosted && (!body.success_url || !/^https?:\/\//.test(body.success_url))) return send(400, { error: { message: 'success_url is required for a hosted checkout' } });
        if (!hosted && body.ui_mode !== 'embedded') return send(400, { error: { message: `unknown ui_mode ${body.ui_mode}` } });
        for (const li of body.line_items || []) if (li.price && !prices.has(li.price)) return send(400, { error: { code: 'resource_missing', message: `No such price: '${li.price}'` } });
        const id = rid('cs');
        const s = { id, object: 'checkout.session', client_secret: `${id}_secret_${randomBytes(6).toString('hex')}`, status: 'open', payment_status: 'unpaid', mode: body.mode, ui_mode: body.ui_mode,
          redirect_on_completion: body.redirect_on_completion || null, metadata: body.metadata || {}, line_items: body.line_items || [], customer: body.customer || null, customer_email: body.customer_email || null,
          subscription_data: body.subscription_data || null, payment_intent_data: body.payment_intent_data || null,
          ...(hosted ? { ui_mode: 'hosted', url: `${base}/pay/${id}`, success_url: body.success_url, cancel_url: body.cancel_url || null, client_reference_id: body.client_reference_id || null,
            custom_text: body.custom_text || null, payment_method_collection: body.payment_method_collection || null } : {}),
          amount_total: body.subscription_data?.trial_period_days ? 0 : (body.line_items || []).reduce((n, li) => n + Number(li.price_data?.unit_amount ?? prices.get(li.price)?.unit_amount ?? 0) * Number(li.quantity || 1), 0), currency: 'usd' };
        sessions.set(id, s);
        return send(200, s);
      }
      if ((m = /^\/v1\/checkout\/sessions\/([\w]+)$/.exec(u.pathname)) && req.method === 'GET') {
        const s = sessions.get(m[1]);
        return s ? send(200, s) : send(404, { error: { type: 'invalid_request_error', message: 'No such checkout.session' } });
      }
      if ((m = /^\/v1\/invoices\/([\w]+)$/.exec(u.pathname))) return send(200, { id: m[1], object: 'invoice', payment_intent: `pi_for_${m[1]}` });
      if (u.pathname === '/v1/refunds' && req.method === 'POST') { const r = { id: rid('re'), ...body }; refunds.push(r); return send(200, r); }
      if ((m = /^\/v1\/subscriptions\/([\w]+)$/.exec(u.pathname)) && req.method === 'DELETE') {
        cancelled.push(m[1]);
        const sub = subscriptions.get(m[1]);
        if (sub) { sub.status = 'canceled'; sub.ended_at = Math.floor(Date.now() / 1000); }
        return send(200, sub || { id: m[1], status: 'canceled' });
      }
      if ((m = /^\/v1\/subscriptions\/([\w]+)$/.exec(u.pathname)) && req.method === 'GET') {
        const sub = subscriptions.get(m[1]);
        return sub ? send(200, sub) : send(404, { error: { code: 'resource_missing', message: 'No such subscription' } });
      }
      // products and prices (the KnowBot plan)
      if (u.pathname === '/v1/products' && req.method === 'POST') {
        const id = body.id || rid('prod');
        if (products.has(id)) return send(400, { error: { code: 'resource_already_exists', message: 'Product already exists.' } });
        const p = { id, object: 'product', active: true, name: body.name, description: body.description || null, metadata: body.metadata || {} };
        products.set(id, p);
        return send(200, p);
      }
      if ((m = /^\/v1\/products\/([\w]+)$/.exec(u.pathname))) {
        const p = products.get(m[1]);
        if (!p) return send(404, { error: { code: 'resource_missing', message: `No such product: '${m[1]}'` } });
        if (req.method === 'POST' && body.active != null) p.active = String(body.active) === 'true';
        return send(200, p);
      }
      if (u.pathname === '/v1/prices' && req.method === 'GET') {
        const keys = Array.isArray(body.lookup_keys) ? body.lookup_keys : [];
        const data = [...prices.values()].filter((p) => (!keys.length || keys.includes(p.lookup_key)) && (body.active == null || String(p.active) === String(body.active)));
        return send(200, { object: 'list', data: data.slice(0, Number(body.limit) || 10), has_more: false });
      }
      if (u.pathname === '/v1/prices' && req.method === 'POST') {
        if (!products.has(body.product)) return send(400, { error: { code: 'resource_missing', message: `No such product: '${body.product}'` } });
        if (body.lookup_key) {
          const cur = [...prices.values()].find((p) => p.lookup_key === body.lookup_key);
          if (cur && body.transfer_lookup_key !== 'true') return send(400, { error: { message: 'A price already uses this lookup key.' } });
          if (cur) cur.lookup_key = null;
        }
        const p = { id: rid('price'), object: 'price', active: true, product: body.product, currency: body.currency, unit_amount: Number(body.unit_amount), recurring: body.recurring || null,
          lookup_key: body.lookup_key || null, nickname: body.nickname || null, metadata: body.metadata || {} };
        prices.set(p.id, p);
        return send(200, p);
      }
      if (u.pathname === '/v1/billing_portal/sessions' && req.method === 'POST') {
        if (!body.customer) return send(400, { error: { message: 'customer is required' } });
        const id = rid('bps');
        const ps = { id, object: 'billing_portal.session', customer: body.customer, return_url: body.return_url || null, url: `${base}/portal/${id}` };
        portals.set(id, ps);
        return send(200, ps);
      }
      return send(404, { error: { message: `no route ${req.method} ${u.pathname}` } });
    });
  });
  await new Promise((r) => srv.listen(0, host, r));
  const url = `http://${host}:${srv.address().port}`;
  base = url;
  return { url, sessions, refunds, cancelled, requests, state, complete, event, products, prices, subscriptions, portals, sent, send: sendEvent, setSubscription, failInvoice, close: () => new Promise((r) => srv.close(() => r())) };
}

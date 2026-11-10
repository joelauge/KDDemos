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
  const state = { webhook, down: false };
  const rid = (p) => `${p}_test_${randomBytes(9).toString('hex')}`;
  function complete(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (s.status === 'complete') return s;
    Object.assign(s, { status: 'complete', payment_status: 'paid', customer: s.customer || rid('cus') });
    if (s.mode === 'subscription') Object.assign(s, { subscription: rid('sub'), invoice: rid('in') });
    else s.payment_intent = rid('pi');
    if (state.webhook?.url) {
      const { raw, header } = event('checkout.session.completed', s, state.webhook.secret);
      fetch(state.webhook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: raw }).catch(() => {});
    }
    return s;
  }
  function event(type, object, secret, t) {
    const raw = JSON.stringify({ id: rid('evt'), object: 'event', type, data: { object } });
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
      const body = parseStripeForm(text);
      requests.push({ method: req.method, path: u.pathname, body, version: req.headers['stripe-version'] || null, auth: req.headers.authorization || null });
      if (!/^Bearer \S+/.test(String(req.headers.authorization || ''))) return send(401, { error: { type: 'invalid_request_error', message: 'No API key' } });
      if (state.down) return send(500, { error: { type: 'api_error', message: 'down' } });
      let m;
      if (u.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
        if (body.ui_mode !== 'embedded') return send(400, { error: { message: 'ui_mode must be embedded in this fake' } });
        const id = rid('cs');
        const s = { id, object: 'checkout.session', client_secret: `${id}_secret_${randomBytes(6).toString('hex')}`, status: 'open', payment_status: 'unpaid', mode: body.mode, ui_mode: body.ui_mode,
          redirect_on_completion: body.redirect_on_completion || null, metadata: body.metadata || {}, line_items: body.line_items || [], customer: body.customer || null, customer_email: body.customer_email || null,
          subscription_data: body.subscription_data || null, payment_intent_data: body.payment_intent_data || null,
          amount_total: (body.line_items || []).reduce((n, li) => n + Number(li.price_data?.unit_amount || 0) * Number(li.quantity || 1), 0), currency: 'usd' };
        sessions.set(id, s);
        return send(200, s);
      }
      if ((m = /^\/v1\/checkout\/sessions\/([\w]+)$/.exec(u.pathname)) && req.method === 'GET') {
        const s = sessions.get(m[1]);
        return s ? send(200, s) : send(404, { error: { type: 'invalid_request_error', message: 'No such checkout.session' } });
      }
      if ((m = /^\/v1\/invoices\/([\w]+)$/.exec(u.pathname))) return send(200, { id: m[1], object: 'invoice', payment_intent: `pi_for_${m[1]}` });
      if (u.pathname === '/v1/refunds' && req.method === 'POST') { const r = { id: rid('re'), ...body }; refunds.push(r); return send(200, r); }
      if ((m = /^\/v1\/subscriptions\/([\w]+)$/.exec(u.pathname)) && req.method === 'DELETE') { cancelled.push(m[1]); return send(200, { id: m[1], status: 'canceled' }); }
      return send(404, { error: { message: `no route ${req.method} ${u.pathname}` } });
    });
  });
  await new Promise((r) => srv.listen(0, host, r));
  const url = `http://${host}:${srv.address().port}`;
  return { url, sessions, refunds, cancelled, requests, state, complete, event, close: () => new Promise((r) => srv.close(() => r())) };
}

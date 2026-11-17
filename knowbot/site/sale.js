/* KnowBot sale tracking: tells KnowBot that an order followed a click in the chat, so the owner sees which answers sell.
 *
 *   on the order-confirmation ("thank you") page:
 *     <script async src="https://knowbot.knowdrive.ai/site/sale.js" data-bot="<botId>"
 *             data-order="<order id>" data-total="<order total, e.g. 129.90>" data-currency="<USD>"></script>
 *   or, from the page's own script:   window.knowbotSale({ order, total, currency, items: [{ title, quantity, price }] })
 *   optional data-api="<KnowBot API origin>" (else found from this script's own address)
 *
 * How it works. A link clicked in the chat opens the site with ?kb_cid=<click id>. The page it lands on keeps that id
 * in the site's own localStorage (the KnowBot website line, the Homepage search and this script all do it; this script
 * can be put on every page for sites without them). On the thank-you page this script sends
 * { click id, order id, order total, currency, items } to KnowBot. Nothing else: no name, no email, no address.
 *
 *   - No cookie is set. The click id lives in localStorage on the owner's site and is only read here.
 *   - An order with no click id (it did not come from the chat) is never reported; the script only says "I ran" (at most
 *     once a day per browser) so the owner's Stats can show that sale tracking is installed.
 *   - Global Privacy Control / Do Not Track: no click id is kept, so nothing is reported.
 *   - The newest click replaces the older one (last click wins); a click older than 30 days is forgotten. The owner's
 *     attribution window (7 days unless changed) is applied by the server.
 * Keep the click-id rules in step with lib/track.js (rememberClickId) and HOSTED_APIS with lib/site-config.js. */
(() => {
  'use strict';
  const me = document.currentScript;
  const d = (me && me.dataset) || {};
  const KEY = 'kb_cid', AT = 'kb_cid_at', ID = /^[a-z0-9]{6,20}$/, MAX_AGE = 30 * 86400000;
  const HOSTED_APIS = { 'knowbot.knowdrive.ai': 'https://agent.knowbot.app' };
  const get = (k) => { try { return window.localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } };
  const del = (k) => { try { window.localStorage.removeItem(k); } catch { /* private mode */ } };
  const privacy = (() => {
    try {
      const n = navigator;
      if (n.globalPrivacyControl === true || n.globalPrivacyControl === '1') return true;
      const dnt = n.doNotTrack ?? window.doNotTrack ?? n.msDoNotTrack;
      return dnt === '1' || dnt === 'yes' || dnt === 1;
    } catch { return false; }
  })();

  // 1. a landing page: remember the click id the chat link carried
  try {
    const c = new URLSearchParams(location.search).get(KEY) || '';
    if (ID.test(c) && !privacy) { set(KEY, c); set(AT, String(Date.now())); }
  } catch { /* nothing to remember */ }

  // 2. the thank-you page: report the order for that click id
  const API = (() => {
    const ok = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };
    if (d.api && ok(d.api)) return ok(d.api);
    let src = null; try { src = new URL(me.src, location.href); } catch { /* inline */ }
    return (src && HOSTED_APIS[src.hostname]) || (src && src.origin) || location.origin;
  })();
  const BOT = String(d.bot || '').trim().toLowerCase();
  /** "1,234.50" / "1234,5" / 1234.5 → "1234.5" (a plain number); '' when it is not an amount. */
  const amount = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    let s = String(v ?? '').replace(/[^\d.,]/g, '');
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    return /^\d+(?:\.\d+)?$/.test(s) ? s : '';
  };
  const post = (body) => {
    try {
      const url = `${API}/api/v1/bots/${encodeURIComponent(BOT)}/sale`, text = JSON.stringify(body);
      // a plain string is sent as text/plain: no preflight, and it survives the visitor leaving the page
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, text))) fetch(url, { method: 'POST', body: text, keepalive: true, credentials: 'omit' }).catch(() => {});
      return true;
    } catch { return false; }
  };
  /** Report one order. → true when something was sent. Safe to call twice: an order is only sent once per browser, and the server keeps one per order id. */
  function report(o) {
    const order = String((o && (o.order ?? o.orderId ?? o.id)) ?? '').trim().slice(0, 64);
    if (!/^[a-z0-9_-]{1,64}$/.test(BOT) || !order) return false;
    const cid = get(KEY) || '', at = Number(get(AT)) || 0;
    if (cid && at && Date.now() - at > MAX_AGE) { del(KEY); del(AT); }
    const fresh = ID.test(cid) && !(at && Date.now() - at > MAX_AGE) && !privacy;
    if (!fresh) {
      // not an order from the chat: nothing about it is sent, only "the snippet is installed" (once a day)
      const day = new Date().toISOString().slice(0, 10);
      if (privacy || get('kb_sale_seen') === day) return false;
      set('kb_sale_seen', day);
      return post({ ping: true });
    }
    const sentKey = `kb_sale:${order}`;
    if (get(sentKey)) return false;
    const total = amount(o.total ?? o.value ?? o.amount), currency = String(o.currency || '').trim().toUpperCase();
    if (!total || !/^[A-Z]{3}$/.test(currency)) return false;
    const items = (Array.isArray(o.items) ? o.items : []).slice(0, 20).map((i) => ({ title: String((i && (i.title ?? i.name)) ?? '').slice(0, 120), quantity: Number(i && i.quantity) || 1,
      ...(amount(i && i.price) ? { price: amount(i.price) } : {}) })).filter((i) => i.title);
    set(sentKey, '1');
    return post({ cid, order, total, currency, ...(items.length ? { items } : {}) });
  }
  window.knowbotSale = report;
  if (d.order) report({ order: d.order, total: d.total, currency: d.currency });
  else if (window.knowbotOrder && typeof window.knowbotOrder === 'object') report(window.knowbotOrder);
})();

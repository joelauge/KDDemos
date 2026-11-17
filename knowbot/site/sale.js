/* KnowBot sale tracking: tells KnowBot that an order followed a click in the chat, so the owner sees which answers sell.
 *
 * Nothing to install: the KnowBot website line (lib/embed.js) and the Homepage search (site/overlay.js) load this file
 * by themselves, after the page has loaded and the browser is idle, on every page they run on. It then
 *   1. keeps an incoming click id (…?kb_cid=<id>) in the site's own localStorage (the line does this too);
 *   2. looks for a completed order on the page it is on, and reports it once for the stored click id:
 *        a. explicit   window.knowbotSale({ order, total, currency, items }) or data-order / data-total / data-currency
 *                      on this script's own tag (the snippet for pages the website line is not on; see below)
 *        b. event      a GA4 / Google Tag Manager `purchase` event in window.dataLayer, pushed before or after this
 *                      file loads: { event:'purchase', ecommerce:{ transaction_id, value, currency, items } }, the
 *                      gtag('event','purchase',{…}) form, and the older ecommerce.purchase.actionField form
 *        c. page       WooCommerce's order-received page (body.woocommerce-order-received: the order number and total
 *                      it prints), and Shopify's legacy order status page (window.Shopify.checkout)
 *      A detector reports only what it can read for certain. An order page whose total or currency is not clear is
 *      never guessed: KnowBot is only told "an order page was seen, and this could not be read" (once a day).
 *   3. on a Shopify storefront, writes the click id into the cart as the cart attribute kb_cid (POST /cart/update.js,
 *      once per click id, nothing else in the cart is touched), so the order carries it into Shopify's checkout, where
 *      no theme script runs (the owner's custom pixel reads it there; see studio/salesnippets.js).
 *
 * As a snippet, for an order page that does not load the website line:
 *     <script async src="https://knowbot.knowdrive.ai/site/sale.js" data-bot="<botId>"
 *             data-order="<order id>" data-total="<order total, e.g. 129.90>" data-currency="<USD>"></script>
 *   optional data-api="<KnowBot API origin>" (else found from this script's own address)
 *
 * What is sent: { click id, order id, order total, currency, item names and quantities, which detector }. Nothing else:
 * no name, no email, no address.
 *   - No cookie is set. The click id lives in localStorage on the owner's site and is only read here.
 *   - An order with no click id (it did not come from the chat) is never reported; the script only says "an order page
 *     was seen" (at most once a day per browser) so the owner's Studio can show that sale tracking works. A visitor who
 *     did come from the chat also says "the line is running on this site" once a day, from pages that are not orders.
 *   - Global Privacy Control / Do Not Track: no click id is kept, and nothing at all is sent.
 *   - The newest click replaces the older one (last click wins); a click older than 30 days is forgotten. The owner's
 *     attribution window (7 days unless changed) and the "Track links" switch are applied by the server.
 *   - Every step is wrapped: this file never throws on the host page and never blocks it.
 * Keep the click-id rules in step with lib/track.js (rememberClickId) and HOSTED_APIS with lib/site-config.js. */
(() => {
  'use strict';
  const W = window, D = document, me = D.currentScript;
  const d = (me && me.dataset) || {};
  const KEY = 'kb_cid', AT = 'kb_cid_at', ID = /^[a-z0-9]{6,20}$/, MAX_AGE = 30 * 86400000;
  const HOSTED_APIS = { 'knowbot.knowdrive.ai': 'https://agent.knowbot.app' };
  const get = (k) => { try { return W.localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { W.localStorage.setItem(k, v); } catch { /* private mode */ } };
  const del = (k) => { try { W.localStorage.removeItem(k); } catch { /* private mode */ } };
  const privacy = (() => {
    try {
      const n = navigator;
      if (n.globalPrivacyControl === true || n.globalPrivacyControl === '1') return true;
      const dnt = n.doNotTrack ?? W.doNotTrack ?? n.msDoNotTrack;
      return dnt === '1' || dnt === 'yes' || dnt === 1;
    } catch { return false; }
  })();

  // 1. a landing page: remember the click id the chat link carried
  try {
    const c = new URLSearchParams(location.search).get(KEY) || '';
    if (ID.test(c) && !privacy) { set(KEY, c); set(AT, String(Date.now())); }
  } catch { /* nothing to remember */ }

  const explicit = d.order ? { order: d.order, total: d.total, currency: d.currency } : null;
  // already running on this page (the website line loaded it, and the page also has the snippet): pass the order on
  try { if (typeof W.knowbotSale === 'function' && W.knowbotSale.kb) { if (explicit) W.knowbotSale(explicit); return; } } catch { return; }

  // 2. the order page: report the order for that click id
  const API = (() => {
    const ok = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };
    if (d.api && ok(d.api)) return ok(d.api);
    let src = null; try { src = new URL(me.src, location.href); } catch { /* inline */ }
    return (src && HOSTED_APIS[src.hostname]) || (src && src.origin) || location.origin;
  })();
  const BOT = String(d.bot || '').trim().toLowerCase();
  const BOT_OK = /^[a-z0-9_-]{1,64}$/.test(BOT);
  /** "1,234.50" / "1234,5" / 1234.5 → "1234.5" (a plain number); '' when it is not an amount. */
  const amount = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? String(v) : '';
    let s = String(v ?? '').replace(/[^\d.,]/g, '');
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    return /^\d+(?:\.\d+)?$/.test(s) ? s : '';
  };
  /** A number a machine wrote (an event's value, a platform object's total): 129.9 or "129.90". Anything else → ''. */
  const plain = (v) => (typeof v === 'number' ? (Number.isFinite(v) && v >= 0 ? String(v) : '') : /^\d+(?:\.\d+)?$/.test(String(v ?? '').trim()) ? String(v).trim() : '');
  const ZERO_DEC = /^(?:JPY|KRW|VND|CLP|ISK|HUF|IDR|PYG|UGX|XAF|XOF)$/;
  /**
   * A price as a page prints it ("$1,299.50", "1.299,50 €", "1 299,50", "1'299.50") → "1299.50". `dec` is the decimal
   * mark when the page says which it is. '' whenever the separators leave a doubt ("1,234": 1234 or 1.234?), unless the
   * currency has no decimals.
   */
  const printed = (text, dec, currency) => {
    const s = String(text ?? '').replace(/[\s  '’]/g, '').replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
    if (/^\d+$/.test(s)) return s;
    const grouped = (x, t) => new RegExp(`^\\d{1,3}(?:\\${t}\\d{3})+$`).test(x);
    const split = (D2, T) => {                                  // D2 the decimal mark, T the thousands mark
      const at = s.lastIndexOf(D2), whole = at < 0 ? s : s.slice(0, at), frac = at < 0 ? '' : s.slice(at + 1);
      if (at >= 0 && (!/^\d{1,4}$/.test(frac) || whole.includes(D2))) return '';
      if (!/^\d+$/.test(whole) && !grouped(whole, T)) return '';
      return whole.split(T).join('') + (frac ? `.${frac}` : '');
    };
    if (dec === '.' || dec === ',') return split(dec, dec === '.' ? ',' : '.');
    const dots = s.split('.').length - 1, commas = s.split(',').length - 1;
    if (dots && commas) return s.lastIndexOf('.') > s.lastIndexOf(',') ? split('.', ',') : split(',', '.');
    const m = dots ? '.' : ',', o = dots ? ',' : '.';
    if (dots + commas > 1) return grouped(s, m) ? s.split(m).join('') : '';
    if (/^\d+[.,]\d{3}$/.test(s)) return ZERO_DEC.test(currency || '') && grouped(s, m) ? s.split(m).join('') : '';
    return split(m, o);
  };
  const post = (body) => {
    try {
      // a beacon is at most 4 KB on the server: a long basket loses item names, never the order
      while (body.items && body.items.length && JSON.stringify(body).length > 3600) body.items.pop();
      const url = `${API}/api/v1/bots/${encodeURIComponent(BOT)}/sale`, text = JSON.stringify(body);
      // a plain string is sent as text/plain: no preflight, and it survives the visitor leaving the page
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, text))) fetch(url, { method: 'POST', body: text, keepalive: true, credentials: 'omit' }).catch(() => {});
      return true;
    } catch { return false; }
  };
  /** The stored click id when it is still usable, else ''. An aged one is forgotten. */
  const freshCid = () => {
    const cid = get(KEY) || '', at = Number(get(AT)) || 0;
    const old = !!(at && Date.now() - at > MAX_AGE);
    if (cid && old) { del(KEY); del(AT); }
    return ID.test(cid) && !old && !privacy ? cid : '';
  };
  /** True the first time it is asked on a day, in this browser. */
  const onceToday = (key) => { const day = new Date().toISOString().slice(0, 10); if (get(key) === day) return false; set(key, day); return true; };
  const sent = {};
  let reported = false;
  /**
   * Report one order. `via` names the detector ('event' | 'page'; none for the owner's own snippet or call).
   * → true when something was sent. Safe to call twice: an order is only sent once per browser, and the server keeps
   * one per order id.
   */
  function report(o, via) {
    try {
      const order = String((o && (o.order ?? o.orderId ?? o.id)) ?? '').trim().slice(0, 64);
      if (!BOT_OK || !order || privacy) return false;
      const by = via === 'event' || via === 'page' ? { via } : {};
      const cid = freshCid();
      // not an order from the chat: nothing about it is sent, only "an order page was seen" (once a day)
      if (!cid) return onceToday('kb_sale_seen') ? post({ ping: true, ...by }) : false;
      const sentKey = `kb_sale:${order}`;
      if (sent[order] || get(sentKey)) return false;
      const total = amount(o.total ?? o.value ?? o.amount), currency = String(o.currency || '').trim().toUpperCase();
      if (!total || !/^[A-Z]{3}$/.test(currency)) return false;
      const items = (Array.isArray(o.items) ? o.items : []).slice(0, 20).map((i) => ({ title: String((i && (i.title ?? i.name ?? i.item_name)) ?? '').slice(0, 120), quantity: Number(i && i.quantity) || 1,
        ...(amount(i && i.price) ? { price: amount(i.price) } : {}) })).filter((i) => i.title);
      sent[order] = 1; set(sentKey, '1'); reported = true;
      return post({ cid, order, total, currency, ...(items.length ? { items } : {}), ...by });
    } catch { return false; }
  }
  report.kb = 1;
  // the page's own script may call it; kept out of the page's enumerable globals (the website line adds none)
  try { Object.defineProperty(W, 'knowbotSale', { value: report, writable: true, configurable: true, enumerable: false }); } catch { W.knowbotSale = report; }
  if (explicit) report(explicit);
  else if (W.knowbotOrder && typeof W.knowbotOrder === 'object') report(W.knowbotOrder);

  // ------------------------------------------------------------------ detectors: each → null (not an order),
  // { order, total, currency, items, via } (read for certain) or { via, unread:'total'|'currency' } (an order page it cannot read)
  const idOf = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const checked = (order, total, currency, items, via) => {
    const cur = String(currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return { via, unread: 'currency' };
    if (!total) return { via, unread: 'total' };
    return { order, total, currency: cur, items: Array.isArray(items) ? items : [], via };
  };
  /** One dataLayer entry: a GA4 purchase (Tag Manager's object, gtag's arguments), or the older enhanced-ecommerce form. */
  const fromEvent = (e) => {
    if (!e || typeof e !== 'object') return null;
    const gtag = e[0] === 'event' && typeof e[1] === 'string';
    const name = gtag ? e[1] : e.event;
    const p = gtag ? e[2] : (e.ecommerce && typeof e.ecommerce === 'object' ? e.ecommerce : e);
    if (!p || typeof p !== 'object') return null;
    const old = p.purchase && typeof p.purchase === 'object' && p.purchase.actionField;
    if (old && typeof old === 'object' && idOf(old.id)) return checked(idOf(old.id), plain(old.revenue), p.currencyCode, p.purchase.products, 'event');
    if (name !== 'purchase' || !idOf(p.transaction_id)) return null;
    return checked(idOf(p.transaction_id), plain(p.value), p.currency, p.items, 'event');
  };
  const SYMBOLS = { '€': 'EUR', '£': 'GBP', '₹': 'INR', '₽': 'RUB', '₪': 'ILS', '₩': 'KRW', '₫': 'VND', '₺': 'TRY', '₴': 'UAH', '฿': 'THB', '₦': 'NGN', '₱': 'PHP', 'zł': 'PLN', 'Kč': 'CZK',
    'R$': 'BRL', 'US$': 'USD', 'A$': 'AUD', 'AU$': 'AUD', 'C$': 'CAD', 'CA$': 'CAD', 'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD' };
  const CODES = /^(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|JPY|CNY|HKD|SGD|KRW|INR|IDR|MYR|THB|PHP|VND|AED|SAR|ILS|TRY|ZAR|NGN|KES|EGP|BRL|MXN|ARS|CLP|COP|PEN|UAH|RUB|ISK)$/;
  /** WooCommerce's order-received page: the order number and the total it prints; the currency from the store's settings object or an unmistakable symbol. */
  const fromWoo = () => {
    const body = D.body;
    if (!body || !body.classList || !body.classList.contains('woocommerce-order-received')) return null;
    const text = (el) => String((el && el.textContent) || '').trim();
    const cs = W.wcSettings && W.wcSettings.currency;
    const classic = D.querySelector('.woocommerce-order-overview');
    let order = '', price = null;
    if (classic) {
      order = text(classic.querySelector('.woocommerce-order-overview__order strong'));
      price = classic.querySelector('.woocommerce-order-overview__total .woocommerce-Price-amount');
    } else {
      // the block-based confirmation page: its summary prints one price, the total; the order id is in the address
      const all = D.querySelectorAll('.wc-block-order-confirmation-summary .woocommerce-Price-amount');
      if (all && all.length === 1) price = all[0];
    }
    if (!order) order = (/\/order-received\/(\d+)(?:[/?#]|$)/.exec(String(location.pathname || '')) || [])[1] || '';
    if (!order || /\s/.test(order)) return { via: 'page', unread: 'order' };
    if (!price) return { via: 'page', unread: 'total' };
    const symbol = text(price.querySelector('.woocommerce-Price-currencySymbol'));
    const code = cs && /^[A-Za-z]{3}$/.test(String(cs.code || '')) ? String(cs.code).toUpperCase() : SYMBOLS[symbol] || (CODES.test(symbol) ? symbol : '');
    const dec = cs && (cs.decimalSeparator === '.' || cs.decimalSeparator === ',') && cs.thousandSeparator !== cs.decimalSeparator ? cs.decimalSeparator : '';
    return checked(order, printed(symbol ? text(price).replace(symbol, '') : text(price), dec, code), code, [], 'page');
  };
  /** Shopify's legacy order status page (only stores that still had one): the checkout object it exposed. */
  const fromShopify = () => {
    const c = W.Shopify && W.Shopify.checkout;
    if (!c || typeof c !== 'object' || !idOf(c.order_id)) return null;
    // a total shown in another currency than the shop's is not read: which of the two it is in is not certain
    if (c.presentment_currency && c.currency && c.presentment_currency !== c.currency) return { via: 'page', unread: 'currency' };
    return checked(idOf(c.order_id), plain(c.total_price), c.currency || c.presentment_currency, (Array.isArray(c.line_items) ? c.line_items : []).map((i) => ({ title: i && i.title, quantity: i && i.quantity })), 'page');
  };

  let unread = null;
  /** Take what a detector found. → true when it settled the page (an order was read). */
  const take = (f) => {
    if (!f || reported) return reported;
    if (f.unread) { unread = unread || f; return false; }
    report(f, f.via);
    reported = true;                                            // one order per page view, whoever saw it first
    return true;
  };
  const scan = () => {
    const dl = W.dataLayer;
    if (Array.isArray(dl)) for (let i = 0; i < dl.length && i < 500; i++) { try { if (take(fromEvent(dl[i]))) return true; } catch { /* next entry */ } }
    return false;
  };
  /** Purchases pushed from now on. The page's own push still runs first and its result is returned untouched. */
  const hook = () => {
    const dl = W.dataLayer;
    if (!Array.isArray(dl) || (dl.push && dl.push.kb)) return;
    const push = dl.push;
    const wrapped = function () {
      const r = push.apply(this, arguments);
      try { for (let i = 0; i < arguments.length; i++) take(fromEvent(arguments[i])); } catch { /* never the page's problem */ }
      return r;
    };
    wrapped.kb = 1;
    dl.push = wrapped;
  };
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  /** A Shopify storefront: the click id goes into the cart as an attribute, once, so the order carries it through checkout. */
  const CART = 'cart/update.' + 'js';                          // Shopify's own address, not a file of this site (kept out of the site's asset stamping)
  const cart = () => {
    const S = W.Shopify, cid = freshCid();
    if (!cid || !S || typeof S !== 'object' || typeof S.shop !== 'string' || S.checkout || get('kb_cart') === cid) return;
    const root = S.routes && typeof S.routes.root === 'string' && /^\/[\w\-/]*$/.test(S.routes.root) ? S.routes.root.replace(/\/?$/, '/') : '/';
    set('kb_cart', cid);
    Promise.resolve(fetch(root + CART, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ attributes: { [KEY]: cid } }) }))
      .catch(() => { del('kb_cart'); });                        // the network failed: the next page tries again
  };
  const look = () => {
    if (privacy || !BOT_OK) return;
    safe(cart);
    if (!reported) { safe(scan) || take(safe(fromWoo)) || take(safe(fromShopify)); }
    safe(hook);
    if (reported) return;
    if (unread) { if (onceToday('kb_sale_unread')) post({ ping: true, via: unread.via, unread: unread.unread }); return; }
    // not an order page: a visitor who came from the chat says "the line runs on this site" (once a day)
    if (freshCid() && onceToday('kb_site_seen')) post({ ping: true, page: 'site' });
  };
  const again = () => { if (!reported && !privacy && BOT_OK) { safe(scan); safe(hook); } };
  const start = () => {
    const idle = W.requestIdleCallback ? (f) => W.requestIdleCallback(f, { timeout: 3000 }) : (f) => setTimeout(f, 1);
    idle(() => { safe(look); for (const ms of [1500, 5000, 15000]) setTimeout(again, ms); });
  };
  safe(() => (D.readyState === 'complete' ? start() : W.addEventListener('load', start, { once: true })));
})();

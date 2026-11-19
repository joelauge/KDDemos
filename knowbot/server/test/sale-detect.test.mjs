// Sale tracking with nothing extra to install: site/sale.js, loaded by the KnowBot website line (lib/embed.js) and the
// Homepage search (site/overlay.js), notices a completed order on the page it runs on.
//   - the detectors, each against a realistic fixture page: a GA4 / Tag Manager purchase in dataLayer (before and after
//     the script loads, the gtag form, the older enhanced-ecommerce form), a WooCommerce order-received page in several
//     currency formats, Shopify's legacy order status object; "not sure" is never a guess (a check-in only)
//   - the rules that stay: once per order, last click, nothing personal, no report under GPC / Do Not Track
//   - a Shopify storefront: the click id goes into the cart as an attribute, once, silently
//   - the Shopify custom pixel an owner pastes (studio/salesnippets.js): the order's own attribute first
//   - lib/embed.js and site/overlay.js load the same file the same way (parity)
// Fakes only: a small page (window, document, storage, timers) in a vm; never a browser, a store or the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shopifyPixel, wooHook, anySiteLine, SALE_VIA_LABEL } from '../../studio/salesnippets.js';
import { SALE_VIA_TEXT } from '../leads.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE = readFileSync(path.join(ROOT, 'site', 'sale.js'), 'utf8');
const DAY = 86400000;
const CID = 'abcdefghijkm';
const BOT = 'tr_aaaaaaaaaaaaaaaa';

// ------------------------------------------------------------------ a small DOM for fixture pages
const ENT = { '&amp;': '&', '&nbsp;': ' ', '&euro;': '€', '&pound;': '£', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&[a-z]+;/g, (m) => ENT[m] ?? m);
function el(tag, attrs = {}) {
  const node = { tag, attrs, children: [], parent: null };
  const classes = () => String(attrs.class || '').split(/\s+/).filter(Boolean);
  node.classList = { contains: (c) => classes().includes(c) };
  Object.defineProperty(node, 'textContent', { get: () => node.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('') });
  const matches = (n, simple) => {
    const m = /^([a-z0-9]*)((?:[.#][\w-]+)*)$/i.exec(simple);
    if (!m) throw new Error(`selector not supported by the test DOM: ${simple}`);
    if (m[1] && n.tag !== m[1].toLowerCase()) return false;
    return (m[2].match(/[.#][\w-]+/g) || []).every((p) => (p[0] === '.' ? n.classList.contains(p.slice(1)) : n.attrs.id === p.slice(1)));
  };
  const walk = (n, out) => { for (const c of n.children) if (typeof c !== 'string') { out.push(c); walk(c, out); } return out; };
  node.querySelectorAll = (selector) => {
    const parts = selector.trim().split(/\s+/);
    return walk(node, []).filter((n) => {
      if (!matches(n, parts[parts.length - 1])) return false;
      let i = parts.length - 2;
      for (let p = n.parent; p && i >= 0; p = p.parent) if (p.tag && matches(p, parts[i])) i--;
      return i < 0;
    });
  };
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  return node;
}
/** HTML → { documentElement, body }. Enough of a parser for well-formed fixture pages. */
function parse(html) {
  const root = el('#root');
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (let m; (m = re.exec(html));) {
    if (m[1]) { for (let p = cur; p; p = p.parent) if (p.tag === m[1].toLowerCase()) { cur = p.parent || root; break; } }
    else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const n = el(m[2].toLowerCase(), attrs);
      n.parent = cur; cur.children.push(n);
      if (!m[4] && !/^(?:br|img|meta|link|input|hr)$/i.test(m[2])) cur = n;
    } else if (m[5]) cur.children.push(decode(m[5]));
  }
  return { root, body: root.querySelector('body') };
}

// ------------------------------------------------------------------ a fake page running site/sale.js
/**
 * Runs site/sale.js as the website line loads it (data-bot, no order on the tag). `ready:false` = still loading (call
 * load()). run() lets the idle look happen. → { beacons, bodies, fetches, mem, window, run, later, load, timers }
 */
function page({ html = '<body></body>', search = '', pathname = '/', dataset = { bot: BOT }, stored = { kb_cid: CID, kb_cid_at: String(Date.now() - DAY) }, nav = {}, win = {}, ready = true, fetchOk = true, at = Date.now() } = {}) {
  const mem = new Map(Object.entries(stored));
  const beacons = [], fetches = [], timers = [], listeners = {};
  const dom = parse(html);
  const localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const window = { localStorage, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, ...win };
  const document = { currentScript: { dataset, src: 'https://knowbot.knowdrive.ai/site/sale.js' }, readyState: ready ? 'complete' : 'loading', body: dom.body,
    querySelector: (s) => dom.root.querySelector(s), querySelectorAll: (s) => dom.root.querySelectorAll(s) };
  const fetch = (url, init) => { fetches.push({ url, init }); return fetchOk === 'reject' ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: !!fetchOk, status: fetchOk ? 200 : 422 }); };
  const ctx = { window, document, location: { search, pathname, href: `https://shop.example${pathname}${search}`, origin: 'https://shop.example' },
    navigator: { sendBeacon: (u, b) => { beacons.push({ url: u, body: JSON.parse(b), raw: b }); return true; }, ...nav }, URL, URLSearchParams, Date: class extends Date { static now() { return at; } },
    JSON, Number, String, Array, Object, RegExp, Promise, encodeURIComponent, fetch, setTimeout: (f) => { timers.push(f); return timers.length; } };
  vm.runInNewContext(CODE, ctx);
  const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  // run(): the idle look. later(): the later looks it queued (1.5 s, 5 s, 15 s after)
  const run = async () => { for (const f of timers.splice(0)) f(); await tick(); };
  const later = run;
  const load = () => { document.readyState = 'complete'; for (const f of (listeners.load || []).splice(0)) f(); };
  return { beacons, get bodies() { return beacons.map((b) => b.body); }, fetches, mem, window, run, later, load, timers };
}
const SALE_URL = `https://agent.knowbot.app/api/v1/bots/${BOT}/sale`;
const GA4 = { event: 'purchase', ecommerce: { transaction_id: 'T-1001', value: 129.9, currency: 'USD', tax: 9.9, shipping: 5,
  items: [{ item_id: 'SKU1', item_name: 'Trail Pro', price: 100, quantity: 1 }, { item_id: 'SKU2', item_name: 'Bottle cage', price: 15, quantity: 2 }] } };
const gtag = function () { return arguments; };

// ------------------------------------------------------------------ GA4 / Tag Manager
describe('sale detection: a GA4 / Tag Manager purchase in dataLayer', () => {
  test('pushed before the script loads: reported once, with the click id, the order and item names, as "event"', async () => {
    const p = page({ win: { dataLayer: [{ 'gtm.start': 1, event: 'gtm.js' }, { event: 'view_item', ecommerce: { currency: 'USD', value: 100 } }, { ecommerce: null }, GA4] } });
    assert.equal(p.beacons.length, 0, 'nothing happens while the script loads');
    await p.run();
    assert.equal(p.beacons.length, 1);
    assert.equal(p.beacons[0].url, SALE_URL);
    assert.deepEqual(p.bodies[0], { cid: CID, order: 'T-1001', total: '129.9', currency: 'USD', via: 'event',
      items: [{ title: 'Trail Pro', quantity: 1, price: '100' }, { title: 'Bottle cage', quantity: 2, price: '15' }] });
    // a reload of the order page: the same order is not sent again
    const again = page({ win: { dataLayer: [GA4] }, stored: Object.fromEntries(p.mem) });
    await again.run();
    assert.equal(again.beacons.length, 0);
  });
  test('pushed after the script loads: the page\'s own push still works and the order is reported', async () => {
    const seen = [];
    const dataLayer = [];
    const own = dataLayer.push;
    dataLayer.push = function (...a) { seen.push(...a); return own.apply(this, a); };      // a tag manager's own push
    const p = page({ win: { dataLayer } });
    await p.run();
    assert.deepEqual(p.bodies, [{ ping: true, page: 'site' }], 'not an order page yet: only "the line runs here", for a visitor from the chat');
    assert.equal(dataLayer.push({ event: 'page_view' }), 1, 'push returns what it returned before');
    dataLayer.push(GA4);
    assert.deepEqual(seen, [{ event: 'page_view' }, GA4], 'the page\'s own push ran first, untouched');
    assert.equal(dataLayer.length, 2);
    assert.equal(p.bodies.length, 2);
    assert.equal(p.bodies[1].order, 'T-1001');
    assert.equal(p.bodies[1].via, 'event');
    dataLayer.push(GA4);
    dataLayer.push({ event: 'purchase', ecommerce: { transaction_id: 'T-1002', value: 5, currency: 'USD' } });
    assert.equal(p.bodies.length, 2, 'one order per page view');
  });
  test('a dataLayer created after the script ran is found by the later looks', async () => {
    const p = page({});
    await p.run();
    assert.equal(p.timers.length, 3, 'three later looks are queued');
    p.window.dataLayer = [GA4];
    await p.later();
    assert.equal(p.bodies.at(-1).order, 'T-1001');
  });
  test('gtag(\'event\', \'purchase\', {…}) lands as an arguments object', async () => {
    const p = page({ win: { dataLayer: [gtag('js', new Date()), gtag('config', 'G-XXXX'), gtag('event', 'purchase', { transaction_id: 1001, value: '129.90', currency: 'eur', items: [{ item_name: 'Lamp', quantity: 2 }] })] } });
    await p.run();
    assert.deepEqual(p.bodies, [{ cid: CID, order: '1001', total: '129.90', currency: 'EUR', items: [{ title: 'Lamp', quantity: 2 }], via: 'event' }]);
    const late = page({});
    await late.run();
    late.window.dataLayer = [];
    await late.later();
    late.window.dataLayer.push(gtag('event', 'purchase', { transaction_id: 'A-7', value: 20, currency: 'GBP' }));
    assert.deepEqual(late.bodies.at(-1), { cid: CID, order: 'A-7', total: '20', currency: 'GBP', via: 'event' });
  });
  test('the older enhanced-ecommerce purchase is read too', async () => {
    const p = page({ win: { dataLayer: [{ event: 'transaction', ecommerce: { currencyCode: 'CAD', purchase: { actionField: { id: 'UA-55', revenue: '45.00', tax: '5.00' }, products: [{ name: 'Helmet', price: '40.00', quantity: 1 }] } } }] } });
    await p.run();
    assert.deepEqual(p.bodies, [{ cid: CID, order: 'UA-55', total: '45.00', currency: 'CAD', items: [{ title: 'Helmet', quantity: 1, price: '40.00' }], via: 'event' }]);
  });
  test('nothing personal leaves the page, whatever the event carries', async () => {
    const p = page({ win: { dataLayer: [{ event: 'purchase', user_data: { email: 'ada@example.com', phone: '+15550100' }, ecommerce: { transaction_id: 'T-9', value: 10, currency: 'USD', customer_email: 'ada@example.com',
      shipping_address: '1 Main St', items: [{ item_name: 'Cap', quantity: 1, email: 'ada@example.com' }] } }] } });
    await p.run();
    assert.equal(p.beacons.length, 1);
    assert.deepEqual(Object.keys(p.bodies[0]).sort(), ['cid', 'currency', 'items', 'order', 'total', 'via']);
    assert.deepEqual(p.bodies[0].items, [{ title: 'Cap', quantity: 1 }]);
    assert.doesNotMatch(p.beacons[0].raw, /ada@|Main St|5550100/);
  });
  test('not sure, not sent: a purchase without a clear total or currency is only a check-in that says what was unclear', async () => {
    for (const [ecommerce, what] of [
      [{ transaction_id: 'T-1', value: 'about 20', currency: 'USD' }, 'total'],
      [{ transaction_id: 'T-1', value: '1,299.50', currency: 'USD' }, 'total'],
      [{ transaction_id: 'T-1', currency: 'USD' }, 'total'],
      [{ transaction_id: 'T-1', value: -5, currency: 'USD' }, 'total'],
      [{ transaction_id: 'T-1', value: 20 }, 'currency'],
      [{ transaction_id: 'T-1', value: 20, currency: '$' }, 'currency'],
    ]) {
      const p = page({ win: { dataLayer: [{ event: 'purchase', ecommerce }] } });
      await p.run();
      assert.deepEqual(p.bodies, [{ ping: true, via: 'event', unread: what }], JSON.stringify(ecommerce));
      assert.equal(p.mem.has('kb_sale:T-1'), false);
    }
    // not a purchase at all: other events, a purchase with no order id, junk entries
    const q = page({ stored: {}, win: { dataLayer: [null, 'x', 7, { event: 'add_to_cart', ecommerce: { value: 5, currency: 'USD' } }, { event: 'purchase', ecommerce: { value: 5, currency: 'USD' } }, { event: 'refund', ecommerce: { transaction_id: 'T-1' } }] } });
    await q.run();
    assert.equal(q.beacons.length, 0);
  });
  test('an order that did not come from the chat is never reported: only "an order page was seen", once a day', async () => {
    const p = page({ stored: {}, win: { dataLayer: [GA4] } });
    await p.run();
    assert.deepEqual(p.bodies, [{ ping: true, via: 'event' }]);
    const again = page({ stored: Object.fromEntries(p.mem), win: { dataLayer: [{ event: 'purchase', ecommerce: { transaction_id: 'T-2', value: 5, currency: 'USD' } }] } });
    await again.run();
    assert.equal(again.beacons.length, 0);
    // a click older than 30 days is forgotten
    const old = page({ stored: { kb_cid: CID, kb_cid_at: String(Date.now() - 31 * DAY) }, win: { dataLayer: [GA4] } });
    await old.run();
    assert.deepEqual(old.bodies, [{ ping: true, via: 'event' }]);
    assert.equal(old.mem.has('kb_cid'), false);
  });
  test('Global Privacy Control / Do Not Track: nothing is sent, not even a check-in, and the cart is left alone', async () => {
    for (const nav of [{ globalPrivacyControl: true }, { doNotTrack: '1' }]) {
      const p = page({ nav, win: { dataLayer: [GA4], Shopify: { shop: 'lumen.myshopify.com', routes: { root: '/' } } } });
      await p.run();
      p.window.dataLayer.push(GA4);
      assert.equal(p.beacons.length, 0);
      assert.equal(p.fetches.length, 0);
    }
  });
  test('it waits for the page to load, and no error on the host page whatever it finds', async () => {
    const p = page({ ready: false, win: { dataLayer: [GA4] } });
    await p.run();
    assert.equal(p.beacons.length, 0, 'still loading: nothing yet');
    p.load();
    await p.run();
    assert.equal(p.beacons.length, 1);
    // hostile shapes: getters that throw, a frozen dataLayer, a dataLayer that is not an array, no bot
    const bad = {}; Object.defineProperty(bad, 'event', { get() { throw new Error('boom'); } });
    for (const win of [{ dataLayer: [bad, GA4] }, { dataLayer: Object.freeze([GA4]) }, { dataLayer: 'nope' }, { dataLayer: { push() {} } }, { Shopify: 5, wcSettings: 'x' }]) {
      const q = page({ win });
      await assert.doesNotReject(q.run());
    }
    const hostile = page({ win: { dataLayer: [bad, GA4] } });
    await hostile.run();
    assert.equal(hostile.bodies[0].order, 'T-1001', 'a bad entry does not hide the purchase after it');
    const nobot = page({ dataset: {}, win: { dataLayer: [GA4] } });
    await nobot.run();
    assert.equal(nobot.beacons.length, 0);
  });
  test('a long basket still fits one beacon: item names are dropped before the order is', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ item_name: `A very long product name number ${i} `.repeat(6), quantity: 1, price: 9.5 }));
    const p = page({ win: { dataLayer: [{ event: 'purchase', ecommerce: { transaction_id: 'BIG-1', value: 570, currency: 'USD', items } }] } });
    await p.run();
    assert.ok(p.beacons[0].raw.length <= 4096, `${p.beacons[0].raw.length} bytes`);
    assert.equal(p.bodies[0].order, 'BIG-1');
    assert.ok(p.bodies[0].items.length > 5 && p.bodies[0].items.length <= 20);
  });
});

// ------------------------------------------------------------------ WooCommerce
const wooPage = ({ order = '1042', total, extra = '', bodyClass = 'wp-singular page woocommerce-checkout woocommerce-page woocommerce-order-received', overview = true }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Order received</title></head>
<body class="${bodyClass}">
<main><div class="woocommerce"><div class="woocommerce-order">
  <p class="woocommerce-notice woocommerce-notice--success woocommerce-thankyou-order-received">Thank you. Your order has been received.</p>
  ${overview ? `<ul class="woocommerce-order-overview woocommerce-thankyou-order-details order_details">
    <li class="woocommerce-order-overview__order order">Order number: <strong>${order}</strong></li>
    <li class="woocommerce-order-overview__date date">Date: <strong>November 17, 2026</strong></li>
    <li class="woocommerce-order-overview__email email">Email: <strong>ada@example.com</strong></li>
    <li class="woocommerce-order-overview__total total">Total: <strong>${total}</strong></li>
    <li class="woocommerce-order-overview__payment-method method">Payment method: <strong>Credit card</strong></li>
  </ul>` : ''}
  <section class="woocommerce-order-details"><h2 class="woocommerce-order-details__title">Order details</h2>
    <table class="woocommerce-table woocommerce-table--order-details shop_table order_details"><tbody>
      <tr class="woocommerce-table__line-item order_item"><td class="woocommerce-table__product-name product-name"><a href="/product/trail-pro/">Trail Pro</a> <strong class="product-quantity">&times;&nbsp;1</strong></td>
        <td class="woocommerce-table__product-total product-total"><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">&#36;</span>7.00</bdi></span></td></tr>
    </tbody></table></section>
  <section class="woocommerce-customer-details"><address>Ada Lovelace<br>1 Main St<p class="woocommerce-customer-details--email">ada@example.com</p></address></section>
  ${extra}
</div></div></main></body></html>`;
const price = (inner) => `<span class="woocommerce-Price-amount amount"><bdi>${inner}</bdi></span>`;
const sym = (s) => `<span class="woocommerce-Price-currencySymbol">${s}</span>`;
const WOO_PATH = '/checkout/order-received/1042/';

describe('sale detection: a WooCommerce order-received page', () => {
  test('the order number and total it prints, in many currency formats', async () => {
    for (const [total, win, want] of [
      [price(`${sym('&euro;')}1.299,50`), {}, ['1299.50', 'EUR']],
      [price(`1.299,50&nbsp;${sym('&euro;')}`), {}, ['1299.50', 'EUR']],
      [price(`1&nbsp;299,50&nbsp;${sym('&euro;')}`), {}, ['1299.50', 'EUR']],
      [price(`${sym('&pound;')}1,299.50`), {}, ['1299.50', 'GBP']],
      [price(`${sym('&pound;')}49.00`), {}, ['49.00', 'GBP']],
      [price(`${sym('&#8377;')}1,29,950.00`), { wcSettings: { currency: { code: 'INR', decimalSeparator: '.', thousandSeparator: ',' } } }, null],   // lakh grouping: not read, not guessed
      [price(`${sym('CHF')}&nbsp;1’299.50`), {}, ['1299.50', 'CHF']],
      [price(`129,90&nbsp;${sym('z&#322;')}`), {}, ['129.90', 'PLN']],
      [price(`${sym('R&#36;')}1.299,50`), {}, ['1299.50', 'BRL']],
      [price(`${sym('US&#36;')}1,299.50`), {}, ['1299.50', 'USD']],
      [price(`${sym('&#36;')}1,299.50`), { wcSettings: { currency: { code: 'USD', symbol: '$', decimalSeparator: '.', thousandSeparator: ',', precision: 2 } } }, ['1299.50', 'USD']],
      [price(`${sym('&#36;')}1,299.50`), { wcSettings: { currency: { code: 'CAD', decimalSeparator: '.', thousandSeparator: ',' } } }, ['1299.50', 'CAD']],
      [price(`1.299,50&nbsp;${sym('kr')}`), { wcSettings: { currency: { code: 'SEK', decimalSeparator: ',', thousandSeparator: '.' } } }, ['1299.50', 'SEK']],
      [price(`1.234&nbsp;${sym('kr')}`), { wcSettings: { currency: { code: 'DKK', decimalSeparator: ',', thousandSeparator: '.' } } }, ['1234', 'DKK']],
      [price(`${sym('&#165;')}12,800`), { wcSettings: { currency: { code: 'JPY', decimalSeparator: '.', thousandSeparator: ',' } } }, ['12800', 'JPY']],
      [price(`${sym('&#8361;')}129,000`), {}, ['129000', 'KRW']],
      [`${price(`${sym('&euro;')}119,00`)} <small class="includes_tax">(includes ${price(`${sym('&euro;')}19,00`)} VAT)</small>`, {}, ['119.00', 'EUR']],
      [price(`${sym('&euro;')}0,00`), {}, ['0.00', 'EUR']],
    ]) {
      const p = page({ html: wooPage({ total }), pathname: WOO_PATH, win });
      await p.run();
      if (!want) { assert.deepEqual(p.bodies, [{ ping: true, via: 'page', unread: 'total' }], total); continue; }
      assert.deepEqual(p.bodies, [{ cid: CID, order: '1042', total: want[0], currency: want[1], via: 'page' }], total);
    }
  });
  test('a custom order number is used as printed; the buyer\'s name, email and address on the page are never sent', async () => {
    const p = page({ html: wooPage({ order: 'WC-2026-0042', total: price(`${sym('&euro;')}20,00`) }), pathname: WOO_PATH });
    await p.run();
    assert.deepEqual(p.bodies, [{ cid: CID, order: 'WC-2026-0042', total: '20.00', currency: 'EUR', via: 'page' }]);
    assert.doesNotMatch(p.beacons[0].raw, /ada|Lovelace|Main St/i);
  });
  test('not sure, not sent: a bare "$", an unknown symbol, a doubtful number or a missing total is only a check-in', async () => {
    for (const [total, win, what] of [
      [price(`${sym('&#36;')}129.90`), {}, 'currency'],                       // $ alone: USD, CAD, AUD…? not guessed
      [price(`${sym('kr')}129,90`), {}, 'currency'],
      [price(`${sym('&#165;')}12,800`), {}, 'currency'],
      [price(`${sym('&euro;')}1,234`), {}, 'total'],                          // 1234 or 1.234? not guessed
      [price(`${sym('&euro;')}1.234`), {}, 'total'],
      [price(`${sym('&euro;')}12,34,5`), {}, 'total'],
      [price(`${sym('&euro;')}`), {}, 'total'],
      ['<em>See your email</em>', {}, 'total'],
    ]) {
      const p = page({ html: wooPage({ total }), pathname: WOO_PATH, win });
      await p.run();
      assert.deepEqual(p.bodies, [{ ping: true, via: 'page', unread: what }], total);
      assert.equal([...p.mem.keys()].some((k) => k.startsWith('kb_sale:')), false);
      // the same day, the same browser: not said twice
      const again = page({ html: wooPage({ total }), pathname: WOO_PATH, win, stored: Object.fromEntries(p.mem) });
      await again.run();
      assert.equal(again.beacons.length, 0);
    }
  });
  test('the store\'s purchase event wins over reading the page; an unreadable event falls back to the page', async () => {
    const html = wooPage({ total: price(`${sym('&euro;')}20,00`) });
    const p = page({ html, pathname: WOO_PATH, win: { dataLayer: [{ event: 'purchase', ecommerce: { transaction_id: '1042', value: 20, currency: 'EUR', items: [{ item_name: 'Trail Pro', quantity: 1 }] } }] } });
    await p.run();
    assert.deepEqual(p.bodies, [{ cid: CID, order: '1042', total: '20', currency: 'EUR', items: [{ title: 'Trail Pro', quantity: 1 }], via: 'event' }]);
    const q = page({ html, pathname: WOO_PATH, win: { dataLayer: [{ event: 'purchase', ecommerce: { transaction_id: '1042', value: 'n/a', currency: 'EUR' } }] } });
    await q.run();
    assert.deepEqual(q.bodies, [{ cid: CID, order: '1042', total: '20.00', currency: 'EUR', via: 'page' }]);
  });
  test('only on the order-received page; the block-based confirmation page is read when it prints exactly one price', async () => {
    const cart = page({ html: wooPage({ total: price(`${sym('&euro;')}20,00`), bodyClass: 'woocommerce-cart woocommerce-page' }), pathname: '/cart/', stored: {} });
    await cart.run();
    assert.equal(cart.beacons.length, 0);
    const block = (prices) => wooPage({ overview: false, total: '', extra: `<div class="wc-block-order-confirmation-summary"><ul class="wc-block-order-confirmation-summary-list">
      <li class="wc-block-order-confirmation-summary-list-item"><span class="wc-block-order-confirmation-summary-list-item__key">Order #:</span> <span class="wc-block-order-confirmation-summary-list-item__value">1042</span></li>
      ${prices.map((x) => `<li class="wc-block-order-confirmation-summary-list-item"><span class="wc-block-order-confirmation-summary-list-item__value">${x}</span></li>`).join('')}</ul></div>` });
    const one = page({ html: block([price(`${sym('&pound;')}49.00`)]), pathname: WOO_PATH });
    await one.run();
    assert.deepEqual(one.bodies, [{ cid: CID, order: '1042', total: '49.00', currency: 'GBP', via: 'page' }], 'the order id comes from the address');
    const two = page({ html: block([price(`${sym('&pound;')}49.00`), price(`${sym('&pound;')}9.00`)]), pathname: WOO_PATH });
    await two.run();
    assert.deepEqual(two.bodies, [{ ping: true, via: 'page', unread: 'total' }]);
    const noId = page({ html: block([price(`${sym('&pound;')}49.00`)]), pathname: '/thanks/' });
    await noId.run();
    assert.deepEqual(noId.bodies, [{ ping: true, via: 'page', unread: 'order' }]);
  });
});

// ------------------------------------------------------------------ Shopify
describe('sale detection: Shopify', () => {
  const checkout = { order_id: 5551001, total_price: '129.90', currency: 'USD', presentment_currency: 'USD', email: 'ada@example.com', shipping_address: { name: 'Ada Lovelace', address1: '1 Main St' },
    line_items: [{ title: 'Trail Pro', quantity: 1, price: '120.00', variant_id: 1 }, { title: 'Bottle cage', quantity: 2 }] };
  test('the legacy order status page: the checkout object\'s order id, total and currency; nothing personal', async () => {
    const p = page({ win: { Shopify: { shop: 'lumen.myshopify.com', Checkout: { page: 'thank_you' }, checkout } } });
    await p.run();
    assert.deepEqual(p.bodies, [{ cid: CID, order: '5551001', total: '129.90', currency: 'USD', items: [{ title: 'Trail Pro', quantity: 1 }, { title: 'Bottle cage', quantity: 2 }], via: 'page' }]);
    assert.doesNotMatch(p.beacons[0].raw, /ada|Main St/i);
    assert.equal(p.fetches.length, 0, 'the cart is not touched on an order page');
  });
  test('not sure, not sent: a total shown in another currency, or no plain total', async () => {
    const other = page({ win: { Shopify: { shop: 'lumen.myshopify.com', checkout: { ...checkout, presentment_currency: 'EUR' } } } });
    await other.run();
    assert.deepEqual(other.bodies, [{ ping: true, via: 'page', unread: 'currency' }]);
    const odd = page({ win: { Shopify: { shop: 'lumen.myshopify.com', checkout: { ...checkout, total_price: '$129.90' } } } });
    await odd.run();
    assert.deepEqual(odd.bodies, [{ ping: true, via: 'page', unread: 'total' }]);
    const none = page({ win: { Shopify: { shop: 'lumen.myshopify.com', checkout: { token: 'abc' } } } });
    await none.run();
    assert.deepEqual(none.bodies, [{ ping: true, page: 'site' }], 'a checkout step without an order is not an order page');
  });
  test('a storefront: the click id goes into the cart as the attribute kb_cid, once per click id, and only that', async () => {
    const Shopify = { shop: 'lumen.myshopify.com', routes: { root: '/' }, theme: { name: 'Dawn' } };
    const p = page({ win: { Shopify } });
    await p.run();
    assert.equal(p.fetches.length, 1);
    assert.equal(p.fetches[0].url, '/cart/update.js', 'same origin');
    assert.equal(p.fetches[0].init.method, 'POST');
    assert.equal(p.fetches[0].init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(p.fetches[0].init.body), { attributes: { kb_cid: CID } }, 'no note, no items, no other attribute');
    assert.deepEqual(p.bodies, [{ ping: true, page: 'site' }], 'nothing about the cart is sent to KnowBot');
    // the next page: already written for this click id
    const next = page({ win: { Shopify }, stored: Object.fromEntries(p.mem) });
    await next.run();
    assert.equal(next.fetches.length, 0);
    // a newer click replaces it: written again, once
    const newer = page({ win: { Shopify }, search: '?kb_cid=zzzzzzzzzzzz', stored: Object.fromEntries(p.mem) });
    await newer.run();
    assert.deepEqual(JSON.parse(newer.fetches[0].init.body), { attributes: { kb_cid: 'zzzzzzzzzzzz' } });
    assert.equal(newer.fetches.length, 1);
    // a shop with a language folder
    const fr = page({ win: { Shopify: { shop: 'lumen.myshopify.com', routes: { root: '/fr/' } } } });
    await fr.run();
    assert.equal(fr.fetches[0].url, '/fr/cart/update.js');
    const odd = page({ win: { Shopify: { shop: 'lumen.myshopify.com', routes: { root: 'https://evil.example/' } } } });
    await odd.run();
    assert.equal(odd.fetches[0].url, '/cart/update.js', 'never another origin');
  });
  test('only on a Shopify storefront, only with a click id; a failure is silent and tried again on the next page', async () => {
    for (const o of [{ win: {} }, { win: { Shopify: {} } }, { win: { Shopify: { shop: 'lumen.myshopify.com' } }, stored: {} },
      { win: { Shopify: { shop: 'lumen.myshopify.com' } }, stored: { kb_cid: CID, kb_cid_at: String(Date.now() - 31 * DAY) } }]) {
      const p = page(o);
      await p.run();
      assert.equal(p.fetches.length, 0, JSON.stringify(o));
    }
    const Shopify = { shop: 'lumen.myshopify.com' };
    const refused = page({ win: { Shopify }, fetchOk: false });
    await assert.doesNotReject(refused.run());
    assert.equal(refused.fetches.length, 1);
    const afterRefusal = page({ win: { Shopify }, stored: Object.fromEntries(refused.mem), fetchOk: false });
    await afterRefusal.run();
    assert.equal(afterRefusal.fetches.length, 0, 'a shop that says no is not asked on every page');
    const offline = page({ win: { Shopify }, fetchOk: 'reject' });
    await assert.doesNotReject(offline.run());
    const back = page({ win: { Shopify }, stored: Object.fromEntries(offline.mem) });
    await back.run();
    assert.equal(back.fetches.length, 1, 'the network failed: the next page tries again');
  });
});

// ------------------------------------------------------------------ explicit reports keep working beside detection
describe('sale detection: the owner\'s own snippet and call', () => {
  test('data-order on the tag is reported at once, as before, and detection does not report the order a second time', async () => {
    const p = page({ dataset: { bot: BOT, order: '#1001', total: '129.90', currency: 'USD' }, win: { dataLayer: [{ event: 'purchase', ecommerce: { transaction_id: '1001', value: 129.9, currency: 'USD' } }] } });
    assert.deepEqual(p.bodies, [{ cid: CID, order: '#1001', total: '129.90', currency: 'USD' }], 'sent while the script loads, without "via"');
    await p.run();
    assert.equal(p.beacons.length, 1, 'the purchase event for the same order is not a second sale');
  });
  test('the website line already loaded the script and the page also has the snippet: the snippet\'s order goes through the first copy', async () => {
    const p = page({});
    const calls = [];
    const first = p.window.knowbotSale;
    assert.equal(typeof first, 'function');
    p.window.knowbotSale = Object.assign((o) => { calls.push(o); return first(o); }, { kb: 1 });
    // a second copy of the file in the same page
    const ctx = { window: p.window, document: { currentScript: { dataset: { bot: BOT, order: '77', total: '20', currency: 'EUR' }, src: 'https://knowbot.knowdrive.ai/site/sale.js' }, readyState: 'complete' },
      location: { search: '', pathname: '/thanks', href: 'https://shop.example/thanks', origin: 'https://shop.example' }, navigator: {}, URL, URLSearchParams, Date, JSON, Number, String, Array, Object, RegExp, Promise, encodeURIComponent, setTimeout: () => { throw new Error('the second copy must not start its own detection'); } };
    vm.runInNewContext(CODE, ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ order: '77', total: '20', currency: 'EUR' }]);
    assert.deepEqual(p.bodies, [{ cid: CID, order: '77', total: '20', currency: 'EUR' }]);
  });
  test('window.knowbotSale({…}) from the page\'s own script still reports, and still only once per order', async () => {
    const p = page({});
    assert.equal(p.window.knowbotSale({ order: 'X-1', total: '1,299.50', currency: 'usd', items: [{ name: 'Lamp', quantity: 2, price: '10,00', email: 'a@b.co' }] }), true);
    assert.deepEqual(p.bodies, [{ cid: CID, order: 'X-1', total: '1299.50', currency: 'USD', items: [{ title: 'Lamp', quantity: 2, price: '10.00' }] }]);
    assert.equal(p.window.knowbotSale({ order: 'X-1', total: 5, currency: 'USD' }), false);
  });
});

// ------------------------------------------------------------------ the Shopify custom pixel an owner pastes
describe('sale detection: the Shopify custom pixel (studio/salesnippets.js)', () => {
  const URL_ = 'https://agent.knowbot.app/api/v1/bots/acme/sale';
  /** Runs the pixel as Shopify's sandbox does: `analytics`, `browser`, `fetch` and nothing of the page. */
  async function pixel({ checkout, stored = {}, storageFails = false }) {
    const subs = {}, posts = [], reads = [];
    const mem = new Map(Object.entries(stored));
    const analytics = { subscribe: (name, fn) => { subs[name] = fn; } };
    const browser = { localStorage: {
      getItem: async (k) => { reads.push(k); if (storageFails) throw new Error('blocked'); return mem.get(k) ?? null; },
      setItem: async (k, v) => { if (storageFails) throw new Error('blocked'); mem.set(k, String(v)); } } };
    const fetch = (url, init) => { posts.push({ url, init, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true }); };
    new Function('analytics', 'browser', 'fetch', 'window', 'document', shopifyPixel(URL_))(analytics, browser, fetch, undefined, undefined);
    assert.deepEqual(Object.keys(subs), ['checkout_completed']);
    await subs.checkout_completed({ name: 'checkout_completed', data: { checkout } });
    return { posts, reads, mem };
  }
  const checkout = { token: 'tok_abc', currencyCode: 'USD', totalPrice: { amount: 129.9, currencyCode: 'USD' }, order: { id: '5551001', customer: { id: '99', isFirstOrder: true } },
    email: 'ada@example.com', phone: '+15550100', shippingAddress: { firstName: 'Ada', address1: '1 Main St' }, billingAddress: { lastName: 'Lovelace' },
    attributes: [{ key: 'gift', value: 'yes' }, { key: 'kb_cid', value: CID }],
    lineItems: [{ title: 'Trail Pro', quantity: 1, variant: { price: { amount: 120 } } }, { title: 'Bottle cage', quantity: 2 }] };
  test('the click id comes from the order\'s own attribute first; the browser\'s storage is not even asked', async () => {
    const r = await pixel({ checkout, stored: { kb_cid: 'zzzzzzzzzzzz' } });
    assert.equal(r.posts.length, 1);
    assert.equal(r.posts[0].url, URL_);
    assert.deepEqual(r.posts[0].body, { cid: CID, order: '5551001', total: 129.9, currency: 'USD', via: 'pixel', items: [{ title: 'Trail Pro', quantity: 1 }, { title: 'Bottle cage', quantity: 2 }] });
    assert.deepEqual(r.reads, [], 'attributes first');
    assert.deepEqual([r.posts[0].init.method, r.posts[0].init.keepalive, r.posts[0].init.headers], ['POST', true, undefined], 'a plain text body: no preflight from the sandbox');
    assert.doesNotMatch(r.posts[0].init.body, /ada|Lovelace|Main St|5550100|isFirstOrder/i, 'nothing personal');
  });
  test('no attribute on the order (a "Buy it now" checkout): the click id from the shop\'s localStorage', async () => {
    const r = await pixel({ checkout: { ...checkout, attributes: [] }, stored: { kb_cid: CID } });
    assert.equal(r.posts[0].body.cid, CID);
    assert.deepEqual(r.reads, ['kb_cid']);
    // a global id and no order object: the last part of the id, else the checkout token
    const gid = await pixel({ checkout: { ...checkout, order: { id: 'gid://shopify/Order/5551002' } } });
    assert.equal(gid.posts[0].body.order, '5551002');
    const tok = await pixel({ checkout: { ...checkout, order: null } });
    assert.equal(tok.posts[0].body.order, 'tok_abc');
  });
  test('an order that did not come from the bot: only "the pixel works", once a day; a malformed id is not a click id', async () => {
    const r = await pixel({ checkout: { ...checkout, attributes: [{ key: 'kb_cid', value: '<script>' }] } });
    assert.deepEqual(r.posts.map((p) => p.body), [{ ping: true, via: 'pixel' }]);
    const again = await pixel({ checkout: { ...checkout, attributes: null }, stored: Object.fromEntries(r.mem) });
    assert.equal(again.posts.length, 0);
    // storage blocked in the sandbox: still no error, and the order's own attribute still works
    const blocked = await pixel({ checkout, storageFails: true });
    assert.equal(blocked.posts[0].body.cid, CID);
    const blockedNoAttr = await pixel({ checkout: { ...checkout, attributes: [] }, storageFails: true });
    assert.deepEqual(blockedNoAttr.posts.map((p) => p.body), [{ ping: true, via: 'pixel' }]);
    // a broken event never throws into Shopify's sandbox
    await assert.doesNotReject(pixel({ checkout: null }));
  });
  test('the other snippets name the bot and the script; the labels match the CSV words', () => {
    const o = { bot: 'acme', siteBase: 'https://knowbot.knowdrive.ai/', apiAttr: '' };
    assert.match(anySiteLine(o), /<script async src="https:\/\/knowbot\.knowdrive\.ai\/site\/sale\.js" data-bot="acme"\s+data-order="ORDER_ID" data-total="ORDER_TOTAL" data-currency="USD"><\/script>/);
    assert.match(wooHook({ ...o, apiAttr: ' data-api="https://api.example"' }), /woocommerce_thankyou[\s\S]*data-api="https:\/\/api\.example" data-bot="%s"[\s\S]*get_order_number\(\)[\s\S]*get_total\(\)[\s\S]*get_currency\(\)/);
    assert.deepEqual(Object.keys(SALE_VIA_LABEL), Object.keys(SALE_VIA_TEXT));
    for (const k of Object.keys(SALE_VIA_TEXT)) assert.equal(SALE_VIA_LABEL[k].toLowerCase().replaceAll('’', "'"), SALE_VIA_TEXT[k].toLowerCase());
    assert.doesNotMatch(Object.values(SALE_VIA_TEXT).join(' '), /payment|verified|paid/i, 'never called a payment');
  });
});

// ------------------------------------------------------------------ the website line and the Homepage search load it the same way
describe('sale detection: lib/embed.js and site/overlay.js load site/sale.js themselves (parity)', () => {
  const embed = readFileSync(path.join(ROOT, 'lib', 'embed.js'), 'utf8'), overlay = readFileSync(path.join(ROOT, 'site', 'overlay.js'), 'utf8');
  const block = (src) => /\/\* sales:begin[^*]*\*\/([\s\S]*?)\/\* sales:end \*\//.exec(src)?.[1];
  const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  test('the loader is the same lines in both', () => {
    assert.ok(block(embed) && block(overlay), 'sales:begin … sales:end in both files');
    assert.equal(norm(block(overlay)), norm(block(embed)));
  });
  test('both call it for their bot, from their own address, never under a privacy signal; the hosted link does not', () => {
    assert.match(embed, /if \(botId && d\.sales !== 'off' && !privacySignal\(\)\) loadSales\(new URL\('\.\.\/site\/sale\.js(?:\?v=\w+)?', me\)\.href, botId, new URL\(apiRoot\)\.origin\)/);
    assert.match(overlay, /if \(!HOSTED && SRC && !PRIVACY\) loadSales\(new URL\('\.\/sale\.js(?:\?v=\w+)?', SRC\)\.href, BOT, API\)/);
  });
  /** Runs the loader in a fake page. → the script tags it added. */
  function loader({ readyState = 'complete', present = false, running = false } = {}) {
    const added = [], timers = [], listeners = {};
    const document = { readyState, head: { append: (s) => added.push(s) }, querySelector: () => (present ? {} : null), createElement: () => ({ dataset: {} }) };
    const window = { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, ...(running ? { knowbotSale: () => {} } : {}) };
    const fn = new Function('window', 'document', 'setTimeout', `${block(embed)}; return loadSales;`)(window, document, (f) => timers.push(f));
    return { fn, added, flush: () => { for (const f of timers.splice(0)) f(); }, load: () => { for (const f of listeners.load || []) f(); } };
  }
  test('after the page has loaded and is idle: one async script tag with the bot and the API, never twice', () => {
    const a = loader();
    a.fn('https://knowbot.knowdrive.ai/site/sale.js', 'acme', 'https://agent.knowbot.app');
    assert.equal(a.added.length, 0, 'not while the caller runs');
    a.flush();
    assert.equal(a.added.length, 1);
    assert.deepEqual([a.added[0].src, a.added[0].async, { ...a.added[0].dataset }], ['https://knowbot.knowdrive.ai/site/sale.js', true, { bot: 'acme', knowbotSale: '1', api: 'https://agent.knowbot.app' }]);
    const loading = loader({ readyState: 'loading' });
    loading.fn('https://x.test/site/sale.js', 'acme', '');
    loading.flush();
    assert.equal(loading.added.length, 0, 'not before the page has loaded');
    loading.load(); loading.flush();
    assert.equal(loading.added.length, 1);
    for (const o of [{ present: true }, { running: true }]) { const b = loader(o); b.fn('https://x.test/site/sale.js', 'acme', ''); b.flush(); assert.equal(b.added.length, 0, JSON.stringify(o)); }
    const nobot = loader(); nobot.fn('https://x.test/site/sale.js', '', ''); nobot.flush();
    assert.equal(nobot.added.length, 0);
  });
  test('the sale script, the overlay and lib/site-config.js know the same API hosts', async () => {
    const { HOSTED_APIS } = await import('../../lib/site-config.js');
    for (const [host, api] of Object.entries(HOSTED_APIS)) for (const src of [CODE, overlay]) assert.ok(src.includes(`'${host}': '${api}'`));
  });
});

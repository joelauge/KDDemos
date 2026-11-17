// Clicks & sales: links clicked inside the chat surfaces and the orders the owner's site reports for them.
//   lib/track.js (tags, click ids, privacy signals), its copy in site/overlay.js (parity), site/sale.js (the sale
//   snippet), server/leads.mjs (shown / chatClick / sale / attribution / CSV), and the public endpoints
//   POST /v1/bots/:id/click and /sale through the real server. Fakes only: never a real store, model or shop.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, readFileSync } from 'node:fs';
import { appendTracking, linkSuffix, linkClickId, chatLink, privacySignal, rememberClickId, sendClick, CHAT_CONTENT, CLICK_ID_RE } from '../../lib/track.js';
import * as leadsMod from '../leads.mjs';
import { createLeads, CLICK_COLUMNS, SALE_COLUMNS } from '../leads.mjs';
import { ROOT, sleep, nextIp, boot, client, fakeShop, useFakeSpeed, FAST_SPEED } from './trials-helpers.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation: nothing here may reach a real store
useFakeSpeed(FAST_SPEED);
const DAY = 86400000;
const TRACK = { source: 'knowbot', medium: 'webchat', campaign: 'tr_bot', cid: 'abcdefghij' };
const URLS = ['https://shop.example/products/trail-pro', 'https://shop.example/p?variant=1&utm_source=newsletter', 'https://shop.example/cart/1:1?attributes%5Bcall%5D=x#frag',
  'https://shop.example/a?', 'https://shop.example/a?x=1&', 'https://shop.example/#top', 'http://shop.example/é?q=a b', 'https://shop.example/p?kb_cid=zzzzzzzz', 'mailto:a@b.co', 'not a url', ''];

// ------------------------------------------------------------------ lib/track.js
describe('attribution: link tags and click ids (lib/track.js)', () => {
  test('leads.mjs uses the same helper (one implementation, not a copy)', () => {
    assert.equal(leadsMod.appendTracking, appendTracking);
    assert.equal(leadsMod.linkClickId, linkClickId);
  });
  test('a chat link gets the campaign tags and a click id; query, hash and existing tags are never broken', () => {
    const p = chatLink('https://shop.example/products/trail-pro', 'product', TRACK, { privacy: false });
    const u = new URL(p.href);
    assert.equal(u.searchParams.get('utm_source'), 'knowbot');
    assert.equal(u.searchParams.get('utm_medium'), 'webchat');
    assert.equal(u.searchParams.get('utm_campaign'), 'tr_bot');
    assert.equal(u.searchParams.get('utm_content'), 'product_chat');
    assert.equal(u.searchParams.get('kb_cid'), p.cid);
    assert.match(p.cid, /^abcdefghij[a-z2-9]{2}$/);
    assert.equal(chatLink('https://shop.example/x', 'source', { ...TRACK, medium: 'homepage' }, { privacy: false }).href.includes('utm_medium=homepage&utm_campaign=tr_bot&utm_content=source_chat'), true);
    assert.equal(new URL(chatLink('https://shop.example/x', 'link', { ...TRACK, medium: 'voice' }, { privacy: false }).href).searchParams.get('utm_content'), 'link_chat');
    assert.deepEqual(CHAT_CONTENT, { product: 'product_chat', source: 'source_chat', link: 'link_chat' });
    // an owner's own utm_* win; the click id is still added; the hash stays last and byte for byte
    const own = chatLink('https://shop.example/p?variant=1&utm_source=newsletter#reviews', 'product', TRACK, { privacy: false });
    assert.equal(own.href, `https://shop.example/p?variant=1&utm_source=newsletter&kb_cid=${own.cid}#reviews`);
    const cart = chatLink('https://shop.example/cart/1:1?attributes%5Bcall%5D=x#frag', 'link', TRACK, { privacy: false });
    assert.ok(cart.href.startsWith('https://shop.example/cart/1:1?attributes%5Bcall%5D=x&utm_source=knowbot'), cart.href);
    assert.ok(cart.href.endsWith('#frag'));
    // never twice
    assert.equal(chatLink(p.href, 'product', TRACK, { privacy: false }).href, p.href);
    // not a web link: untouched
    for (const x of ['mailto:a@b.co', 'javascript:alert(1)', 'not a url']) assert.equal(chatLink(x, 'link', TRACK, { privacy: false }).href, x);
  });
  test('tracking off (no track): the link is left alone; a privacy signal keeps the tags but drops the click id', () => {
    assert.deepEqual(chatLink('https://shop.example/x', 'product', null), { href: 'https://shop.example/x', cid: '' });
    const p = chatLink('https://shop.example/x', 'product', TRACK, { privacy: true });
    assert.equal(p.cid, '');
    assert.equal(p.href, 'https://shop.example/x?utm_source=knowbot&utm_medium=webchat&utm_campaign=tr_bot&utm_content=product_chat');
    // the server left the click id out (it saw the privacy header): tags only
    assert.equal(chatLink('https://shop.example/x', 'product', { medium: 'webchat', campaign: 'b' }, { privacy: false }).cid, '');
  });
  test('privacySignal: Global Privacy Control or Do Not Track', () => {
    assert.equal(privacySignal({ globalPrivacyControl: true }, {}), true);
    assert.equal(privacySignal({ doNotTrack: '1' }, {}), true);
    assert.equal(privacySignal({ doNotTrack: 'yes' }, {}), true);
    assert.equal(privacySignal({}, { doNotTrack: '1' }), true);
    assert.equal(privacySignal({ doNotTrack: '0' }, {}), false);
    assert.equal(privacySignal({ doNotTrack: 'unspecified', globalPrivacyControl: false }, {}), false);
    assert.equal(privacySignal({}, {}), false);
  });
  test('a link\'s click id is stable, 12 characters, and differs between links', () => {
    const a = linkClickId('abcdefghij', URLS[0]);
    assert.equal(a, linkClickId('abcdefghij', URLS[0]));
    assert.match(a, CLICK_ID_RE);
    assert.equal(a.length, 12);
    assert.notEqual(a, linkClickId('abcdefghij', URLS[1]));
    assert.equal(linkClickId('', URLS[0]), '');
    assert.equal(linkClickId('NOT VALID', URLS[0]), '');
  });
  test('rememberClickId: the landing page keeps the newest click id first-party; never with a privacy signal', () => {
    const mem = new Map();
    const storage = { setItem: (k, v) => mem.set(k, String(v)), getItem: (k) => mem.get(k) ?? null };
    assert.equal(rememberClickId({ search: '?x=1&kb_cid=abcdefghijkm' }, storage, { privacy: false, now: 1000 }), 'abcdefghijkm');
    assert.equal(mem.get('kb_cid'), 'abcdefghijkm');
    assert.equal(mem.get('kb_cid_at'), '1000');
    assert.equal(rememberClickId({ search: '?kb_cid=zzzzzzzzzz22' }, storage, { privacy: false, now: 2000 }), 'zzzzzzzzzz22', 'last click wins');
    assert.equal(mem.get('kb_cid'), 'zzzzzzzzzz22');
    assert.equal(rememberClickId({ search: '?kb_cid=<script>' }, storage, { privacy: false }), null);
    assert.equal(rememberClickId({ search: '' }, storage, { privacy: false }), null);
    assert.equal(rememberClickId({ search: '?kb_cid=aaaaaaaaaaaa' }, storage, { privacy: true }), null);
    assert.equal(mem.get('kb_cid'), 'zzzzzzzzzz22');
    // storage that throws (private mode) never breaks the page
    assert.equal(rememberClickId({ search: '?kb_cid=aaaaaaaaaaaa' }, { setItem() { throw new Error('denied'); } }, { privacy: false }), null);
  });
  test('sendClick prefers navigator.sendBeacon with a plain-text body and never throws', () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const sent = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon: (u, b) => { sent.push([u, b]); return true; } } });
    try {
      assert.equal(sendClick('https://api.example/click', { cid: 'abcdefghijkm', url: 'https://shop.example/x', kind: 'product' }), true);
      assert.equal(typeof sent[0][1], 'string', 'a string body: text/plain, no preflight');
      assert.deepEqual(JSON.parse(sent[0][1]), { cid: 'abcdefghijkm', url: 'https://shop.example/x', kind: 'product' });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon() { throw new Error('blocked'); } } });
      assert.equal(sendClick('https://api.example/click', {}), false);
    } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
  });
});

// ------------------------------------------------------------------ site/overlay.js keeps its own copy: parity
describe('attribution: the Homepage search\'s copy (site/overlay.js) stays in step with lib/track.js', () => {
  const src = readFileSync(path.join(ROOT, 'site', 'overlay.js'), 'utf8');
  const block = /\/\* track:begin[^*]*\*\/([\s\S]*?)\/\* track:end \*\//.exec(src)?.[1];
  test('the copy is there, between its markers', () => { assert.ok(block && block.includes('const KBT'), 'track:begin … track:end block'); });
  const KBT = block ? new Function(`${block}; return KBT;`)() : null;
  test('appendTracking gives the same link for every case', () => {
    for (const url of URLS) {
      for (const o of [{ medium: 'homepage', campaign: 'tr_bot', content: 'product_chat', cid: 'abcdefghijkm' }, { medium: 'voice', campaign: 'b' }, { cid: 'abcdefghijkm' }, {}]) {
        assert.equal(KBT.appendTracking(url, o), appendTracking(url, o), `${url} ${JSON.stringify(o)}`);
      }
    }
  });
  test('click ids, chat links and privacy signals match', () => {
    for (const url of URLS) {
      assert.equal(KBT.linkSuffix(url), linkSuffix(url), url);
      assert.equal(KBT.linkClickId('abcdefghij', url), linkClickId('abcdefghij', url));
      for (const kind of ['product', 'source', 'link', 'other']) for (const privacy of [false, true]) {
        assert.deepEqual(KBT.chatLink(url, kind, { ...TRACK, medium: 'homepage' }, privacy), chatLink(url, kind, { ...TRACK, medium: 'homepage' }, { privacy }), `${url} ${kind} ${privacy}`);
      }
      assert.deepEqual(KBT.chatLink(url, 'product', null, false), chatLink(url, 'product', null, { privacy: false }));
    }
    for (const [nav, win] of [[{ globalPrivacyControl: true }, {}], [{ doNotTrack: '1' }, {}], [{}, { doNotTrack: '1' }], [{ doNotTrack: '0' }, {}], [{}, {}], [{ msDoNotTrack: '1' }, {}]]) {
      assert.equal(KBT.privacySignal(nav, win), privacySignal(nav, win), JSON.stringify([nav, win]));
    }
    assert.equal(String(KBT.ID), String(CLICK_ID_RE));
  });
  test('the overlay and the sale snippet know the same API hosts as lib/site-config.js', async () => {
    const { HOSTED_APIS } = await import('../../lib/site-config.js');
    const sale = readFileSync(path.join(ROOT, 'site', 'sale.js'), 'utf8');
    for (const [host, api] of Object.entries(HOSTED_APIS)) { assert.ok(src.includes(`'${host}': '${api}'`)); assert.ok(sale.includes(`'${host}': '${api}'`)); }
  });
});

// ------------------------------------------------------------------ site/sale.js (the snippet), run in a fake page
describe('attribution: the sale snippet (site/sale.js)', () => {
  const code = readFileSync(path.join(ROOT, 'site', 'sale.js'), 'utf8');
  function page({ search = '', dataset = {}, stored = {}, nav = {}, order = null, at = Date.now() } = {}) {
    const mem = new Map(Object.entries(stored));
    const beacons = [];
    const localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const window = { localStorage, ...(order ? { knowbotOrder: order } : {}) };
    const ctx = { window, document: { currentScript: { dataset, src: 'https://knowbot.knowdrive.ai/site/sale.js' } }, location: { search, href: `https://shop.example/thanks${search}`, origin: 'https://shop.example' },
      navigator: { sendBeacon: (u, b) => { beacons.push({ url: u, body: JSON.parse(b), raw: b }); return true; }, ...nav }, URL, URLSearchParams, Date: class extends Date { static now() { return at; } }, JSON, Number, String, Array, Object, encodeURIComponent, fetch: () => Promise.resolve() };
    vm.runInNewContext(code, ctx);
    return { mem, beacons, window };
  }
  test('a landing page keeps the click id; nothing is sent', () => {
    const p = page({ search: '?utm_source=knowbot&kb_cid=abcdefghijkm', dataset: { bot: 'tr_aaaaaaaaaaaaaaaa' } });
    assert.equal(p.mem.get('kb_cid'), 'abcdefghijkm');
    assert.ok(Number(p.mem.get('kb_cid_at')) > 0);
    assert.equal(p.beacons.length, 0);
    assert.equal(page({ search: '?kb_cid=%3Cb%3E', dataset: { bot: 'x' } }).mem.has('kb_cid'), false, 'only a well-formed id is kept');
  });
  test('the thank-you page reports click id, order id, total, currency (and items), once, to the bot\'s API', () => {
    const p = page({ dataset: { bot: 'tr_aaaaaaaaaaaaaaaa', order: '#1001', total: '1,299.50', currency: 'usd' }, stored: { kb_cid: 'abcdefghijkm', kb_cid_at: String(Date.now() - DAY) } });
    assert.equal(p.beacons.length, 1);
    assert.equal(p.beacons[0].url, 'https://agent.knowbot.app/api/v1/bots/tr_aaaaaaaaaaaaaaaa/sale');
    assert.deepEqual(p.beacons[0].body, { cid: 'abcdefghijkm', order: '#1001', total: '1299.50', currency: 'USD' });
    assert.deepEqual(Object.keys(p.beacons[0].body).sort(), ['cid', 'currency', 'order', 'total'], 'nothing about the customer');
    assert.equal(p.window.knowbotSale({ order: '#1001', total: 5, currency: 'USD' }), false, 'the same order is not sent twice');
    // from the page's own script, with items
    const q = page({ dataset: { bot: 'acme', api: 'https://api.example.test/x' }, stored: { kb_cid: 'abcdefghijkm' }, order: { order: 77, total: 20, currency: 'EUR', items: [{ name: 'Lamp', quantity: 2, price: '10,00', email: 'a@b.co' }] } });
    assert.equal(q.beacons[0].url, 'https://api.example.test/api/v1/bots/acme/sale');
    assert.deepEqual(q.beacons[0].body, { cid: 'abcdefghijkm', order: '77', total: '20', currency: 'EUR', items: [{ title: 'Lamp', quantity: 2, price: '10.00' }] });
  });
  test('an order that did not come from the chat is never reported: only "installed", once a day', () => {
    const p = page({ dataset: { bot: 'acme', order: '1002', total: '10', currency: 'USD' } });
    assert.deepEqual(p.beacons.map((b) => b.body), [{ ping: true }]);
    assert.equal(p.window.knowbotSale({ order: '1003', total: 1, currency: 'USD' }), false);
    assert.equal(p.beacons.length, 1);
    // a click older than 30 days is forgotten
    const old = page({ dataset: { bot: 'acme', order: '1004', total: '10', currency: 'USD' }, stored: { kb_cid: 'abcdefghijkm', kb_cid_at: String(Date.now() - 31 * DAY) } });
    assert.deepEqual(old.beacons.map((b) => b.body), [{ ping: true }]);
    assert.equal(old.mem.has('kb_cid'), false);
  });
  test('Global Privacy Control / Do Not Track: nothing is kept and nothing is sent', () => {
    for (const nav of [{ globalPrivacyControl: true }, { doNotTrack: '1' }]) {
      const land = page({ search: '?kb_cid=abcdefghijkm', dataset: { bot: 'acme' }, nav });
      assert.equal(land.mem.has('kb_cid'), false);
      const thanks = page({ dataset: { bot: 'acme', order: '1', total: '5', currency: 'USD' }, stored: { kb_cid: 'abcdefghijkm' }, nav });
      assert.equal(thanks.beacons.length, 0);
    }
  });
  test('a bad total or currency is not sent; no bot, nothing happens', () => {
    assert.equal(page({ dataset: { bot: 'acme', order: '1', total: 'free', currency: 'USD' }, stored: { kb_cid: 'abcdefghijkm' } }).beacons.length, 0);
    assert.equal(page({ dataset: { bot: 'acme', order: '1', total: '5', currency: 'dollars' }, stored: { kb_cid: 'abcdefghijkm' } }).beacons.length, 0);
    assert.equal(page({ dataset: { order: '1', total: '5', currency: 'USD' }, stored: { kb_cid: 'abcdefghijkm' } }).beacons.length, 0);
  });
});

// ------------------------------------------------------------------ the store
describe('attribution: the store (server/leads.mjs)', () => {
  const P1 = 'https://shop.example/products/trail-pro', P2 = 'https://shop.example/products/commuter-lite', SRC = 'https://shop.example/policies/refund-policy';
  const links = [{ url: P1, kind: 'product', title: 'Trail Pro', price: 1299, currency: 'USD' }, { url: P2, kind: 'product', title: 'Commuter Lite', price: 799, currency: 'USD' }, { url: SRC, kind: 'source', title: 'Refund policy' }];
  const fresh = (o = {}) => { const clock = { t: Date.UTC(2026, 5, 15, 12) }; return { clock, L: createLeads({ now: () => clock.t, ...o }) }; };
  const show = (L, q = 'Which bike for trails?', channel = 'web') => L.shown({ botId: 'tr_bot', channel, answerId: 'ans_1', question: q, links });

  test('shown: an answer with links gets a click id; an answer without links gets none', async () => {
    const { L } = fresh();
    assert.match(show(L), /^[a-z0-9]{10}$/);
    assert.equal(L.shown({ botId: 'tr_bot', links: [] }), null);
    assert.equal(L.shown({ botId: 'tr_bot', links: [{ url: 'javascript:alert(1)', kind: 'link' }] }), null);
    assert.equal(L.shown({ botId: '', links }), null);
  });
  test('a click is recorded only for a click id this bot issued, for a link of that answer', async () => {
    const { L, clock } = fresh();
    const cid = show(L);
    const id = linkClickId(cid, P1);
    assert.deepEqual(await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 }), { ok: true });
    // click + auxclick, a double click: one click
    assert.deepEqual(await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 }), { ok: true, duplicate: true });
    clock.t += 5000;
    assert.deepEqual(await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 }), { ok: true });
    // not a spam sink: unknown id, another bot, a link the answer never had, a mismatched id, junk
    assert.equal((await L.chatClick({ botId: 'tr_bot', cid: linkClickId('zzzzzzzzzz', P1), url: P1 })).reason, 'unknown_click');
    assert.equal((await L.chatClick({ botId: 'tr_other', cid: id, url: P1 })).reason, 'unknown_click');
    const evil = 'https://evil.example/phish';
    assert.equal((await L.chatClick({ botId: 'tr_bot', cid: linkClickId(cid, evil), url: evil })).reason, 'not_this_answer');
    assert.equal((await L.chatClick({ botId: 'tr_bot', cid: id, url: P2 })).reason, 'mismatch');
    for (const bad of [{ cid: 'short', url: P1 }, { cid: id, url: 'javascript:alert(1)' }, { cid: id, url: '' }, { cid: null, url: P1 }, { cid: `${id}x`, url: P1 }]) {
      assert.equal((await L.chatClick({ botId: 'tr_bot', ...bad })).ok, false, JSON.stringify(bad));
    }
    // a page on the bot's own site (a source page the surface linked) is accepted as a plain link; other hosts never
    const page = 'https://www.shop.example/pages/sizing';
    assert.deepEqual(await L.chatClick({ botId: 'tr_bot', cid: linkClickId(cid, page), url: page, hosts: ['https://shop.example/'] }), { ok: true });
    assert.equal((await L.chatClick({ botId: 'tr_bot', cid: linkClickId(cid, evil), url: evil, hosts: ['https://shop.example/'] })).reason, 'not_this_answer');
    // the link as a renderer normalised it still matches
    const { L: L2 } = fresh();
    const c2 = L2.shown({ botId: 'tr_bot', links: [{ url: 'https://shop.example', kind: 'source' }] });
    assert.deepEqual(await L2.chatClick({ botId: 'tr_bot', cid: linkClickId(c2, 'https://shop.example/'), url: 'https://shop.example/' }), { ok: true });
    const r = await L.attribution('tr_bot', { days: 7 });
    assert.equal(r.totals.clicks, 3);
    assert.deepEqual(r.clicks.map((c) => c.kind).sort(), ['link', 'product', 'product']);
    assert.equal(r.clicks.find((c) => c.kind === 'product').title, 'Trail Pro');
    assert.equal(r.clicks.find((c) => c.kind === 'product').question, 'Which bike for trails?');
  });
  test('at most 30 clicks are kept per answer', async () => {
    const { L, clock } = fresh();
    const cid = show(L), id = linkClickId(cid, P1);
    for (let i = 0; i < 30; i++) { clock.t += 4000; assert.equal((await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 })).ok, true); }
    clock.t += 4000;
    assert.equal((await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 })).reason, 'limit');
  });
  test('a sale needs a known click id, a plain amount and a currency; it is recorded once per order id', async () => {
    const { L, clock } = fresh();
    const cid = show(L), id = linkClickId(cid, P1);
    await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 });
    clock.t += 3600000;
    const ok = { botId: 'tr_bot', cid: id, order: '#1001', total: '1299.50', currency: 'usd', items: [{ title: 'Trail Pro', quantity: 1, price: 1299.5, email: 'x@y.z' }] };
    for (const [patch, reason] of [[{ order: '' }, 'bad_order'], [{ order: 'lee@example.com' }, 'bad_order'], [{ order: 'x'.repeat(70) }, 'bad_order'], [{ total: '-5' }, 'bad_total'], [{ total: '1,299.50' }, 'bad_total'],
      [{ total: 'free' }, 'bad_total'], [{ total: 1e9 }, 'bad_total'], [{ total: NaN }, 'bad_total'], [{ currency: 'dollars' }, 'bad_currency'], [{ currency: '' }, 'bad_currency'], [{ cid: 'nope' }, 'invalid']]) {
      const r = await L.sale({ ...ok, ...patch });
      assert.deepEqual([r.ok, r.attributed, r.reason], [false, false, reason], JSON.stringify(patch));
    }
    // a random post with a made-up click id creates nothing
    assert.deepEqual(await L.sale({ ...ok, cid: 'zzzzzzzzzzzz' }), { ok: true, attributed: false, reason: 'unknown_click' });
    assert.deepEqual(await L.sale({ ...ok, botId: 'tr_other' }), { ok: true, attributed: false, reason: 'unknown_click' });
    assert.deepEqual(await L.sale(ok), { ok: true, attributed: true });
    assert.deepEqual(await L.sale({ ...ok, total: 5 }), { ok: true, attributed: true, duplicate: true }, 'idempotent per order id');
    const r = await L.attribution('tr_bot', { days: 7 });
    assert.equal(r.totals.orders, 1);
    assert.deepEqual(r.totals.revenue, [{ currency: 'USD', amount: 1299.5, orders: 1 }]);
    const s = r.sales[0];
    assert.deepEqual([s.order, s.total, s.currency, s.title, s.url, s.channel, s.question, s.clickSeen, s.source], ['#1001', 1299.5, 'USD', 'Trail Pro', P1, 'web', 'Which bike for trails?', true, 'site']);
    assert.deepEqual(s.items, [{ title: 'Trail Pro', quantity: 1, price: 1299.5 }], 'only title, quantity and price are kept from an item');
    assert.doesNotMatch(JSON.stringify(r), /x@y\.z/);
  });
  test('the attribution window runs from the last click (7 days unless set); a click id is good for at most 5 orders', async () => {
    const { L, clock } = fresh();
    const cid = show(L), id = linkClickId(cid, P1);
    await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 });
    const sale = (order, o = {}) => L.sale({ botId: 'tr_bot', cid: id, order, total: 10, currency: 'USD', ...o });
    clock.t += 8 * DAY;
    assert.deepEqual(await sale('A1'), { ok: true, attributed: false, reason: 'outside_window' });
    assert.deepEqual(await sale('A1', { windowDays: 14 }), { ok: true, attributed: true }, 'the owner\'s longer window');
    // a newer click on the same link restarts the window (last click wins)
    await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 });
    clock.t += 6 * DAY;
    assert.deepEqual(await sale('A2'), { ok: true, attributed: true });
    for (const o of ['A3', 'A4', 'A5']) assert.equal((await sale(o)).attributed, true);
    assert.deepEqual(await sale('A6'), { ok: true, attributed: false, reason: 'limit' });
    // a link opened without a reported click (open in a new tab from the menu): the window runs from the answer
    const { L: L2, clock: c2 } = fresh();
    const b = show(L2);
    c2.t += 2 * DAY;
    assert.deepEqual(await L2.sale({ botId: 'tr_bot', cid: linkClickId(b, P2), order: 'B1', total: 799, currency: 'USD' }), { ok: true, attributed: true });
    const s = (await L2.attribution('tr_bot')).sales[0];
    assert.deepEqual([s.title, s.url, s.clickSeen], ['Commuter Lite', P2, false]);
  });
  test('the report: totals, click-through rate, per-day series, top products and questions, both CSVs', async () => {
    const { L, clock } = fresh();
    const a = show(L, 'Which bike for trails?'), b = show(L, 'Which bike for the city?', 'site'), c = show(L, 'Do you ship to Canada?', 'voice');
    clock.t += DAY;
    await L.chatClick({ botId: 'tr_bot', cid: linkClickId(a, P1), url: P1 });
    await L.chatClick({ botId: 'tr_bot', cid: linkClickId(a, SRC), url: SRC });
    await L.chatClick({ botId: 'tr_bot', cid: linkClickId(b, P2), url: P2 });
    clock.t += DAY;
    await L.sale({ botId: 'tr_bot', cid: linkClickId(a, P1), order: '1001', total: 1299, currency: 'USD', items: [{ title: 'Trail Pro', quantity: 1 }] });
    await L.sale({ botId: 'tr_bot', cid: linkClickId(b, P2), order: '1002', total: 799, currency: 'USD' });
    await L.sale({ botId: 'tr_bot', cid: linkClickId(b, P2), order: 'EU-1003', total: 20, currency: 'EUR' });
    assert.equal((await L.sale({ botId: 'tr_bot', cid: linkClickId(b, P2), order: '=1+1', total: 20, currency: 'EUR' })).reason, 'bad_order', 'an order id never starts like a formula');
    assert.ok(c);
    const r = await L.attribution('tr_bot', { days: 7, tz: 0 });
    assert.deepEqual(r.totals, { shown: 3, clicks: 3, clickedAnswers: 2, rate: 2 / 3, orders: 3, revenue: [{ currency: 'USD', amount: 2098, orders: 2 }, { currency: 'EUR', amount: 20, orders: 1 }] });
    assert.equal(r.currency, 'USD');
    assert.equal(r.byDay.length, 7);
    assert.deepEqual(r.byDay.slice(-3), [{ day: '2026-06-15', shown: 3, clicks: 0, orders: 0, revenue: 0 }, { day: '2026-06-16', shown: 0, clicks: 3, orders: 0, revenue: 0 }, { day: '2026-06-17', shown: 0, clicks: 0, orders: 3, revenue: 2098 }]);
    assert.deepEqual(r.channels, { web: { shown: 1, clicks: 2, orders: 1 }, site: { shown: 1, clicks: 1, orders: 2 }, voice: { shown: 1, clicks: 0, orders: 0 } });
    assert.deepEqual(r.products.map((p) => [p.title, p.clicks, p.orders, p.revenue]), [['Trail Pro', 1, 1, 1299], ['Commuter Lite', 1, 2, 799]]);
    assert.deepEqual(r.questions.map((q) => [q.question, q.shown, q.clicks, q.orders, q.revenue]), [['Which bike for trails?', 1, 2, 1, 1299], ['Which bike for the city?', 1, 1, 2, 799]]);
    assert.equal(r.saleTracking.installed, true);
    // the viewer's days: 12:00 UTC + 13 h is the next day in UTC+13
    assert.equal((await L.attribution('tr_bot', { days: 7, tz: 13 * 60 })).byDay.at(-3).day, '2026-06-16');
    // a shorter range leaves the older events out
    clock.t += 5 * DAY + 3600000;
    assert.deepEqual((await L.attribution('tr_bot', { days: 1 })).totals, { shown: 0, clicks: 0, clickedAnswers: 0, rate: null, orders: 0, revenue: [] });
    clock.t -= 5 * DAY + 3600000;
    const clicks = (await L.clicksCsv('tr_bot', { days: 7 })).trim().split('\r\n');
    assert.equal(clicks[0], CLICK_COLUMNS.join(','));
    assert.equal(clicks.length, 4);
    assert.match(clicks.at(-1), /,web,product,Trail Pro,1299,USD,https:\/\/shop\.example\/products\/trail-pro,Which bike for trails\?,ans_1,[a-z0-9]{12},1001,1299,USD$/);
    const sales = (await L.salesCsv('tr_bot', { days: 7 })).trim().split('\r\n');
    assert.equal(sales[0], SALE_COLUMNS.join(','));
    assert.equal(sales.length, 4);
    assert.match(sales.at(-1), /,tr_bot,1001,1299,USD,Trail Pro,web,2026-06-16T12:00:00\.000Z,Trail Pro,https:\/\/shop\.example\/products\/trail-pro,Which bike for trails\?,[a-z0-9]{12},reported by your site$/);
    // per-question rows for the question history
    const rows = await L.attributionRows('tr_bot');
    assert.deepEqual(rows.map((x) => [x.question, x.channel, x.clicks, x.orders, x.total, x.currency]).sort(), [['Which bike for the city?', 'site', 1, 1, 799, 'USD'], ['Which bike for trails?', 'web', 2, 1, 1299, 'USD']]);
  });
  test('sale tracking not installed: the report says so; a ping (once a day) marks it installed', async () => {
    const { L, clock } = fresh();
    show(L);
    assert.deepEqual((await L.attribution('tr_bot')).saleTracking, { installed: false, lastSeenAt: null, lastSaleAt: null });
    assert.equal(await L.salePing('tr_bot'), true);
    assert.equal(await L.salePing('tr_bot'), false, 'once a day');
    clock.t += DAY;
    assert.equal(await L.salePing('tr_bot'), true);
    const st = (await L.attribution('tr_bot')).saleTracking;
    assert.equal(st.installed, true);
    assert.equal(st.lastSaleAt, null);
    assert.equal(st.lastSeenAt, new Date(clock.t).toISOString());
  });
  test('durable with the leads data: events survive a restart, the durable copy holds them, and they age out after the retention window', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-attr-'));
    const saved = new Map();
    const durable = { read: async (bot) => saved.get(bot) || null, write: async (bot, text) => { saved.set(bot, text); } };
    try {
      const clock = { t: Date.UTC(2026, 5, 15, 12) };
      const L = createLeads({ dataDir, now: () => clock.t, durable, durableMs: 0 });
      const cid = show(L), id = linkClickId(cid, P1);
      await L.chatClick({ botId: 'tr_bot', cid: id, url: P1 });
      await L.sale({ botId: 'tr_bot', cid: id, order: '1001', total: 10, currency: 'USD' });
      await L.flush(); await L.idle();
      const lines = (await fsp.readFile(path.join(dataDir, 'leads', 'tr_bot.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((e) => e.kind), ['shown', 'chatclick', 'sale']);
      // what is stored: time, bot, channel, answer id, question, link, click id. No address, no visitor id.
      assert.deepEqual(Object.keys(lines[1]).sort(), ['answer', 'at', 'bot', 'channel', 'cid', 'currency', 'kind', 'linkKind', 'price', 'title', 'url', 'v']);
      assert.deepEqual(Object.keys(lines[2]).sort(), ['answer', 'at', 'bot', 'channel', 'cid', 'clickAt', 'clickSeen', 'currency', 'kind', 'linkKind', 'order', 'source', 'title', 'total', 'url', 'v']);
      assert.ok(saved.get('tr_bot').includes('"kind":"sale"'), 'the durable copy holds the sale');
      // a restart (the local file): the click id is still known, and the order is still recorded once
      const L2 = createLeads({ dataDir, now: () => clock.t + DAY });
      assert.deepEqual(await L2.sale({ botId: 'tr_bot', cid: id, order: '1001', total: 10, currency: 'USD' }), { ok: true, attributed: true, duplicate: true });
      assert.deepEqual(await L2.sale({ botId: 'tr_bot', cid: id, order: '1002', total: 12, currency: 'USD' }), { ok: true, attributed: true });
      assert.equal((await L2.attribution('tr_bot')).totals.orders, 2);
      await L2.idle();
      // a fresh container (no local file): restored from the durable copy
      const L3 = createLeads({ dataDir: null, now: () => clock.t + DAY, durable });
      assert.equal((await L3.attribution('tr_bot')).totals.clicks, 1);
      assert.deepEqual(await L3.chatClick({ botId: 'tr_bot', cid: id, url: P1 }), { ok: true });
      // past the retention window (90 days): the events are gone and the click id is no longer known
      const L4 = createLeads({ dataDir, now: () => clock.t + 92 * DAY });
      assert.deepEqual((await L4.attribution('tr_bot', { days: 90 })).totals, { shown: 0, clicks: 0, clickedAnswers: 0, rate: null, orders: 0, revenue: [] });
      assert.equal((await L4.chatClick({ botId: 'tr_bot', cid: id, url: P1 })).reason, 'unknown_click');
      assert.equal((await L4.sale({ botId: 'tr_bot', cid: id, order: '2001', total: 10, currency: 'USD' })).reason, 'unknown_click');
      await L4.idle();
      assert.equal(L.retentionDays, 90);
    } finally { await fsp.rm(dataDir, { recursive: true, force: true }); }
  });
});

// ------------------------------------------------------------------ through the server
describe('attribution: the click and sale endpoints through the server', () => {
  let S, c, shop, t, key, other;
  const post = (p, body, headers = {}) => S.api(p, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-forwarded-for': headers.ip || '203.0.113.9', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const web = async (question, headers = {}) => (await S.api(`/v1/bots/${t.trialId}/web`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers }, body: JSON.stringify({ question }) })).json();
  const report = async (days = 7) => (await c.json(t, `/attribution?days=${days}`)).json();
  const Q = 'How much is the Trail Pro?';
  before(async () => {
    shop = await fakeShop();
    S = await boot({ studio: { storeNet: { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0 }, storeRetryMs: 20, productImageMissMs: 0 }, kdOpts: { chunker: 'production' } });
    c = client(S);
    t = await c.trial();
    other = await c.trial();
    const done = (await c.stream(t, '/store', { url: shop.base, owner: true })).at(-1).data;
    await c.waitReady(t, done.fileCount);
    const dk = await (await c.json(t, '/devkey')).json();
    key = dk.key;
  });
  after(async () => { await S.close(); await shop.close(); });

  test('a web chat answer carries the tags and a click id for its links; the click beacon is recorded and shows in the report', async () => {
    const a = await web(Q);
    assert.equal(a.refused, false, JSON.stringify(a));
    assert.equal(a.products?.[0]?.url, `${shop.base}/products/trail-pro`);
    assert.deepEqual(Object.keys(a.track).sort(), ['campaign', 'cid', 'medium', 'source']);
    assert.deepEqual([a.track.source, a.track.medium, a.track.campaign], ['knowbot', 'webchat', t.trialId]);
    assert.match(a.track.cid, /^[a-z0-9]{10}$/);
    assert.equal(a.products[0].url.includes('utm_'), false, 'the answer keeps the plain link; the surface adds the tags');
    const url = a.products[0].url, link = chatLink(url, 'product', a.track, { privacy: false });
    // exactly what navigator.sendBeacon sends: a text/plain body, no key
    const r = await post(`/v1/bots/${t.trialId}/click`, { cid: link.cid, url, kind: 'product' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal((await post(`/api/v1/bots/${t.trialId}/click`, { cid: link.cid, url })).status, 204, 'the /api alias; a double report is one click');
    const j = await report();
    assert.equal(j.available, true);
    assert.equal(j.tracking, true);
    assert.equal(j.saleWindowDays, 7);
    assert.deepEqual([j.totals.shown >= 1, j.totals.clicks, j.totals.clickedAnswers], [true, 1, 1]);
    const k = j.clicks[0];
    assert.deepEqual([k.channel, k.kind, k.url, k.title, k.price, k.currency, k.question, k.answer, k.cid], ['web', 'product', url, 'Trail Pro', 1299, 'USD', Q, a.id, link.cid]);
    assert.deepEqual(j.products.map((p) => [p.title, p.clicks]), [['Trail Pro', 1]]);
    assert.equal(j.saleTracking.installed, false);
  });
  test('the click endpoint is not an open redirect or a spam sink', async () => {
    const a = await web(Q);
    const url = a.products[0].url, cid = linkClickId(a.track.cid, url);
    const click = (body, h) => post(`/v1/bots/${t.trialId}/click`, body, h);
    const before = (await report()).totals.clicks;
    const evil = 'https://evil.example/phish';
    for (const [body, status] of [[{ cid: linkClickId(a.track.cid, evil), url: evil }, 400], [{ cid: linkClickId('zzzzzzzzzz', url), url }, 400], [{ cid, url: `${shop.base}/products/commuter-lite` }, 400],
      [{ cid: 'x', url }, 400], [{ url }, 400], ['not json', 400], ['[]', 400], [{ cid, url: 'javascript:alert(1)' }, 400]]) {
      const r = await click(body, { ip: nextIp() });
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(r.headers.get('location'), null);
    }
    assert.equal((await click('x'.repeat(5000), { ip: nextIp() })).status, 413, 'a beacon is small');
    assert.equal((await S.api(`/v1/bots/${t.trialId}/click`)).status, 405);
    assert.equal((await post('/v1/bots/no-such-bot/click', { cid, url })).status, 404);
    assert.equal((await post(`/v1/bots/${other.trialId}/click`, { cid, url }, { ip: nextIp() })).status, 400, "another bot's click id");
    // a page on the bot's own site (the store it was imported from) is accepted; nothing else is
    const page = `${shop.base}/pages/sizing`;
    assert.equal((await click({ cid: linkClickId(a.track.cid, page), url: page }, { ip: nextIp() })).status, 204);
    assert.equal((await report()).totals.clicks, before + 1);
  });
  test('the click endpoint is limited per visitor address', async () => {
    const ip = nextIp();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(`/v1/bots/${t.trialId}/click`, { cid: 'x' }, { ip })).status;
    assert.equal(last, 429);
    assert.equal((await post(`/v1/bots/${t.trialId}/click`, { cid: 'x' }, { ip: nextIp() })).status, 400, 'another address is not limited');
  });
  test('Global Privacy Control / Do Not Track: the tags stay, there is no click id, and a click is not recorded', async () => {
    const before = await report();
    for (const h of [{ 'sec-gpc': '1' }, { dnt: '1' }]) {
      const a = await web(Q, h);
      assert.deepEqual(a.track, { source: 'knowbot', medium: 'webchat', campaign: t.trialId }, JSON.stringify(h));
    }
    const a = await web(Q);
    const url = a.products[0].url;
    assert.equal((await post(`/v1/bots/${t.trialId}/click`, { cid: linkClickId(a.track.cid, url), url }, { 'sec-gpc': '1', ip: nextIp() })).status, 204);
    const now = await report();
    assert.equal(now.totals.clicks, before.totals.clicks, 'nothing recorded');
    assert.equal(now.totals.shown, before.totals.shown + 1, 'the two private answers were not recorded either');
  });
  test('other surfaces: the Studio and the API are not tracked; Homepage search is "homepage"', async () => {
    const studio = (await c.stream(t, '/ask', { question: Q })).find((e) => e.event === 'final').data;
    assert.equal(studio.track, undefined);
    const apiAns = await (await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: Q }) })).json();
    assert.equal(apiAns.track, undefined);
    assert.equal((await c.json(t, '/site', 'POST', { published: true })).status, 200);
    const site = await (await S.api(`/api/site/${t.trialId}`)).json();
    assert.match(site.key || '', /^kb_trial_/, JSON.stringify(site).slice(0, 200));
    const home = await (await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${site.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: Q, format: 'bullets' }) })).json();
    assert.equal(home.refused, false);
    assert.equal(home.track.medium, 'homepage');
    assert.match(home.track.cid, /^[a-z0-9]{10}$/);
    const url = home.products[0].url;
    assert.equal((await post(`/v1/bots/${t.trialId}/click`, { cid: linkClickId(home.track.cid, url), url }, { ip: nextIp() })).status, 204);
    assert.equal((await report()).channels.site.clicks, 1);
  });
  test('web voice mode: the answer on screen carries "voice" tags and a click id; its card click is recorded', async () => {
    const ws = new WebSocket(`${S.base.replace(/^http/, 'ws')}/api/v1/bots/${t.trialId}/voice/live`);
    const got = [];
    ws.addEventListener('message', (ev) => { if (typeof ev.data === 'string') got.push(JSON.parse(ev.data)); });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('socket failed'))); });
    const wait = async (type) => { for (let i = 0; i < 300; i++) { const m = got.find((x) => x.type === type); if (m) return m; await sleep(50); } throw new Error(`no ${type}: ${JSON.stringify(got).slice(0, 300)}`); };
    ws.send(JSON.stringify({ type: 'start', key, engine: 'text' }));
    await wait('ready');
    ws.send(JSON.stringify({ type: 'text', text: Q }));
    const a = await wait('answer');
    ws.close();
    assert.equal(a.refused, false, JSON.stringify(a).slice(0, 300));
    assert.equal(a.products?.[0]?.title, 'Trail Pro');
    assert.deepEqual([a.track?.medium, a.track?.campaign], ['voice', t.trialId]);
    const url = a.products[0].url, link = chatLink(url, 'product', a.track, { privacy: false });
    assert.equal(new URL(link.href).searchParams.get('utm_medium'), 'voice');
    assert.equal((await post(`/v1/bots/${t.trialId}/click`, { cid: link.cid, url }, { ip: nextIp() })).status, 204);
    assert.equal((await report()).channels.voice.clicks, 1);
  });
  test('the sale endpoint: any origin, text/plain, validated, idempotent; the sale shows as attributed', async () => {
    const a = await web(Q);
    const url = a.products[0].url, cid = linkClickId(a.track.cid, url);
    await post(`/v1/bots/${t.trialId}/click`, { cid, url }, { ip: nextIp() });
    const sale = (body, h = {}) => post(`/v1/bots/${t.trialId}/sale`, body, { origin: 'https://shop.example', ip: nextIp(), ...h });
    // a preflight from the owner's site is answered (the snippet itself sends none)
    const pre = await S.api(`/v1/bots/${t.trialId}/sale`, { method: 'OPTIONS', headers: { origin: 'https://shop.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    // the snippet is installed but this order is not from the chat
    assert.deepEqual(await (await sale({ ping: true })).json(), { ok: true, attributed: false, reason: 'no_click' });
    assert.equal((await report()).saleTracking.installed, true);
    assert.equal((await report()).totals.orders, 0);
    for (const bad of [{ cid, order: '', total: 10, currency: 'USD' }, { cid, order: '1001', total: 'lots', currency: 'USD' }, { cid, order: '1001', total: 10, currency: '$' }, { cid, order: 'lee@example.com', total: 10, currency: 'USD' }]) {
      assert.equal((await sale(bad)).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(await (await sale({ cid: 'zzzzzzzzzzzz', order: '1001', total: 10, currency: 'USD' })).json(), { ok: true, attributed: false, reason: 'unknown_click' });
    const good = { cid, order: '1001', total: '1299.00', currency: 'USD', items: [{ title: 'Trail Pro', quantity: 1, price: 1299 }], email: 'lee@example.com', name: 'Lee', address: '1 Main St' };
    const r = await sale(good);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await r.json(), { ok: true, attributed: true });
    assert.deepEqual(await (await sale(good)).json(), { ok: true, attributed: true, duplicate: true });
    const j = await report();
    assert.equal(j.totals.orders, 1);
    assert.deepEqual(j.totals.revenue, [{ currency: 'USD', amount: 1299, orders: 1 }]);
    assert.deepEqual([j.sales[0].order, j.sales[0].total, j.sales[0].title, j.sales[0].question, j.sales[0].channel, j.sales[0].source], ['1001', 1299, 'Trail Pro', Q, 'web', 'site']);
    assert.doesNotMatch(JSON.stringify(j), /lee@example\.com|1 Main St|"Lee"/, 'customer details are never kept');
    assert.equal((await S.api(`/v1/bots/${t.trialId}/sale`)).status, 405);
    // limited per address
    const ip = nextIp();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await sale({ ping: true }, { ip })).status;
    assert.equal(last, 429);
  });
  test('Studio: the report and both CSVs need the bot\'s own token; the window is 1 to 30 days', async () => {
    for (const p of ['/attribution', '/clicks.csv', '/sales.csv']) {
      assert.equal((await S.api(`/api/studio/trials/${t.trialId}${p}`)).status, 401, p);
      assert.equal((await S.api(`/api/studio/trials/${t.trialId}${p}`, { headers: c.h(other) })).status, 401, p);
    }
    const sales = await c.json(t, '/sales.csv?days=7');
    assert.match(sales.headers.get('content-type'), /text\/csv/);
    assert.match(sales.headers.get('content-disposition'), /attachment; filename="knowbot-sales-/);
    const text = (await sales.text()).replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(text[0], SALE_COLUMNS.join(','));
    assert.match(text[1], /,1001,1299,USD,Trail Pro,web,/);
    const clicks = (await (await c.json(t, '/clicks.csv?days=7')).text()).replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(clicks[0], CLICK_COLUMNS.join(','));
    assert.ok(clicks.length >= 3);
    for (const bad of [0, 31, 'soon', 2.5 === 2 ? 1 : -1]) assert.equal((await c.json(t, '/leads', 'PATCH', { saleWindowDays: bad })).status, 400, String(bad));
    assert.deepEqual(await (await c.json(t, '/leads', 'PATCH', { saleWindowDays: 14 })).json(), { tracking: true, saleWindowDays: 14 });
    assert.equal((await report()).saleWindowDays, 14);
    assert.equal((await (await c.json(t, '/leads?days=7')).json()).saleWindowDays, 14);
    assert.deepEqual(await (await c.json(t, '/leads', 'PATCH', { saleWindowDays: 7 })).json(), { tracking: true, saleWindowDays: 7 });
  });
  test('the question history shows each answered question\'s clicks and attributed sale', async () => {
    let row = null;
    for (let i = 0; i < 60 && !row; i++) {
      const h = await (await c.json(t, '/history?days=7&channel=web')).json();
      row = (h.items || []).find((x) => x.sale) || null;
      if (!row) await sleep(100);
    }
    assert.ok(row, 'a web question with a sale');
    assert.equal(row.q, Q);
    assert.ok(row.clicks >= 1);
    assert.deepEqual(row.sale, { orders: 1, total: 1299, currency: 'USD' });
  });
  test('"Track links" off: no tags, no click id, no click or sale recorded; on again brings them back', async () => {
    const a = await web(Q);
    const url = a.products[0].url, cid = linkClickId(a.track.cid, url);
    assert.deepEqual(await (await c.json(t, '/leads', 'PATCH', { tracking: false })).json(), { tracking: false, saleWindowDays: 7 });
    const before = await report();
    assert.equal(before.tracking, false);
    const off = await web(Q);
    assert.equal(off.track, undefined);
    assert.equal(off.products[0].url, url);
    assert.equal((await post(`/v1/bots/${t.trialId}/click`, { cid, url }, { ip: nextIp() })).status, 204);
    assert.deepEqual(await (await post(`/v1/bots/${t.trialId}/sale`, { cid, order: '2001', total: 5, currency: 'USD' }, { ip: nextIp() })).json(), { ok: true, attributed: false, reason: 'tracking_off' });
    const now = await report();
    assert.deepEqual([now.totals.shown, now.totals.clicks, now.totals.orders], [before.totals.shown, before.totals.clicks, before.totals.orders]);
    await c.json(t, '/leads', 'PATCH', { tracking: true });
    assert.match((await web(Q)).track.cid, /^[a-z0-9]{10}$/);
  });
});

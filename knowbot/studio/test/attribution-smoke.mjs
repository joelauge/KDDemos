#!/usr/bin/env node
// Clicks & sales, end to end in a real browser (Playwright) against studio/test/dev-server.mjs (fake knowDrive, fake
// model, a fake store on 127.0.0.1; never a real service).
//
//   1. a bot that imported the fake store, on a "customer's site" (a local page with the one website line):
//      - the chat bubble: a product answer's card, source link and links carry the campaign tags and a click id; a click
//        opens the product page in a new tab with them and is reported (a beacon) without holding the navigation
//      - Homepage search (site/overlay.js) and voice mode (lib/voice-mode.js): the same, as "homepage" and "voice"
//      - Global Privacy Control: the tags stay, there is no click id and nothing is reported
//   2. Stats & Leads → Clicks & sales before any order page was seen: the clicks, and that sale tracking needs nothing
//      installed (never zeros that look like "no sales"); "Check sale tracking" opens the card in Set up: "Already
//      tracking", the live status ("Not seen yet"), "Shopify: one extra paste" (the custom pixel), the snippet for an
//      order page without the website line, Copy, the attribution window
//   3. a fixture store that loads ONLY the normal KnowBot website line on every page (no sale snippet anywhere):
//      - the landing page keeps the click id (first-party localStorage, no cookie) and checks in → "Waiting for the
//        first order page"
//      - a WooCommerce order page with a bare "$" (the currency is not certain): nothing is counted or guessed, the
//        Studio says so
//      - a thank-you page that pushes a GA4 purchase to dataLayer → the sale is attributed ("from your store's purchase
//        event"); a reload does not report it twice
//      - a WooCommerce order-received page in euros ("1.299,50 €") → attributed ("seen on your order page")
//      then Stats: totals, the chart, top products, the orders table with how each order was noticed, the question
//      history row, both CSVs; the Set up card says "Detected on your site" 
//   Desktop and phone, axe, no console errors, screenshots.
//
//   npm run attribution:smoke            # SHOTS=<dir> to keep the screenshots somewhere else
import path from 'node:path';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';
import { outDir, injectAxe, watchErrors, settled } from './smoke-util.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = outDir('attribution', process.env.SHOTS);
const Q = 'How much is the Trail Pro?';
const CLICK_COLS = 'timestamp,bot,channel,link_type,product,price,currency,url,question,answer_id,click_id,order_id,order_total,order_currency';
const SALE_COLS = 'timestamp,bot,order_id,total,currency,items,channel,clicked_at,product,url,question,click_id,source,detected_by';

let failures = 0;
const check = (cell, name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${cell}: ${name}${detail && !ok ? ` · ${String(detail).slice(0, 300)}` : ''}`); if (!ok) failures++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dev = await startDevServer({ speed: 8 });
const api = (p, init = {}) => fetch(dev.url + p, init);
let browser, home;
try {
  console.log('1. a store bot on a customer\'s site');
  const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
  const H = { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
  const T = (p) => `/api/studio/trials/${t.trialId}${p}`;
  await (await api(T('/store'), { method: 'POST', headers: H, body: JSON.stringify({ url: dev.shopUrl, owner: true }) })).text();
  for (let i = 0; i < 480; i++) {
    const f = await (await api(T('/files'), { headers: H })).json();
    if (f.files?.length >= 5 && f.files.every((x) => x.stage === 'ready')) break;
    await sleep(250);
  }
  const key = (await (await api(T('/devkey'), { headers: H })).json()).key;
  check('setup', 'a store bot with a trial key', /^kb_trial_/.test(key || ''));
  const pub = await (await api(T('/site'), { method: 'POST', headers: H, body: JSON.stringify({ published: true, regenerate: true }) })).json();
  check('setup', 'its Homepage search is published', pub.published === true, JSON.stringify(pub).slice(0, 200));
  const report = async () => (await api(T('/attribution?days=7'), { headers: H })).json();

  // the customer's site: a homepage with the chat bubble (and its mic), a page with Homepage search, a landing page
  // that carries the website line (as every page of the owner's site does), and its order pages. Every page has the
  // one website line and nothing else from KnowBot: no sale snippet.
  const line = (attrs) => `<script type="module" src="${dev.url}/lib/embed.js" data-api="${dev.url}" data-bot="${t.trialId}" data-key="${key}" ${attrs}></script>`;
  const doc = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  home = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!/^\/checkout\/order-received\//.test(u.pathname)) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (u.pathname === '/search') return res.end(doc('Lumen Bikes', `<p>Ride further.</p>${line('data-chat="off" data-voice="off" data-homepage="on"')}`));
    if (u.pathname === '/landing') return res.end(doc('Trail Pro', `<p>A product page on the owner's site.</p>${line('data-chat="on" data-voice="off" data-homepage="off"')}`));
    const theLine = line('data-chat="on" data-voice="off" data-homepage="off"');
    if (u.pathname === '/thanks') {
      // a thank-you page as a store with Google Analytics 4 / Tag Manager renders it: the purchase is pushed to
      // dataLayer a moment after the page has loaded (the customer's name is on the page and in the event)
      const order = u.searchParams.get('order'), total = Number(u.searchParams.get('total'));
      return res.end(doc('Thank you', `<p>Thank you, Ada Lovelace. Order ${order} is confirmed.</p>
<script>window.dataLayer = window.dataLayer || []; dataLayer.push({ event: 'page_view' });
addEventListener('load', () => setTimeout(() => dataLayer.push({ event: 'purchase', user_data: { email: 'ada@example.com' }, ecommerce: { transaction_id: ${JSON.stringify(order)}, value: ${total}, currency: 'USD',
  items: [{ item_id: 'trail-pro', item_name: 'Trail Pro', price: ${total}, quantity: 1 }] } }), 900));</script>${theLine}`));
    }
    const woo = /^\/checkout\/order-received\/(\d+)\/$/.exec(u.pathname);
    if (woo) {
      // WooCommerce's order-received page (templates/checkout/thankyou.php), in euros or with a bare "$"
      const price = u.searchParams.get('cur') === 'usd' ? '<span class="woocommerce-Price-currencySymbol">&#36;</span>129.90' : '1.299,50&nbsp;<span class="woocommerce-Price-currencySymbol">&euro;</span>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order received</title></head>
<body class="page woocommerce-checkout woocommerce-page woocommerce-order-received"><main><h1>Order received</h1><div class="woocommerce"><div class="woocommerce-order">
<p class="woocommerce-notice woocommerce-notice--success woocommerce-thankyou-order-received">Thank you. Your order has been received.</p>
<ul class="woocommerce-order-overview woocommerce-thankyou-order-details order_details">
  <li class="woocommerce-order-overview__order order">Order number: <strong>${woo[1]}</strong></li>
  <li class="woocommerce-order-overview__date date">Date: <strong>November 17, 2026</strong></li>
  <li class="woocommerce-order-overview__email email">Email: <strong>ada@example.com</strong></li>
  <li class="woocommerce-order-overview__total total">Total: <strong><span class="woocommerce-Price-amount amount"><bdi>${price}</bdi></span></strong></li>
  <li class="woocommerce-order-overview__payment-method method">Payment method: <strong>Credit card</strong></li>
</ul>
<section class="woocommerce-customer-details"><address>Ada Lovelace<br>1 Main St</address></section></div></div></main>${theLine}</body></html>`);
    }
    return res.end(doc('Lumen Bikes', `<p>Ride further.</p>${line('data-chat="on" data-voice="on" data-homepage="off"')}`));
  });
  await new Promise((r) => home.listen(0, '127.0.0.1', r));
  const homeUrl = `http://127.0.0.1:${home.address().port}`;

  browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  await fsp.mkdir(SHOTS, { recursive: true });
  const tagsOf = (href) => { const u = new URL(href); return { base: `${u.origin}${u.pathname}`, source: u.searchParams.get('utm_source'), medium: u.searchParams.get('utm_medium'), campaign: u.searchParams.get('utm_campaign'), content: u.searchParams.get('utm_content'), cid: u.searchParams.get('kb_cid') }; };
  const tagged = (g, medium, content) => !!g && g.source === 'knowbot' && g.medium === medium && g.campaign === t.trialId && g.content === content && /^[a-z0-9]{12}$/.test(g.cid || '');
  /** Click a link that opens a new tab; → { popupUrl, beacon: {status, body} | null }. The new tab is closed again. */
  async function clickOut(page, locator) {
    const beacon = page.waitForResponse((r) => /\/api\/v1\/bots\/[^/]+\/click$/.test(r.url()), { timeout: 8000 }).then(async (r) => ({ status: r.status(), body: JSON.parse(r.request().postData() || '{}'), type: r.request().headers()['content-type'] || '' })).catch(() => null);
    const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 10000 }), locator.click()]);
    const popupUrl = popup.url() === 'about:blank' ? await popup.waitForURL(/^http/, { timeout: 8000 }).then(() => popup.url()).catch(() => popup.url()) : popup.url();
    const b = await beacon;
    await popup.close().catch(() => {});
    return { popupUrl, beacon: b };
  }
  const clicksOn = async (channel) => (await report()).channels?.[channel]?.clicks || 0;
  let trailCid = '';

  for (const v of [{ name: 'desktop', viewport: { width: 1280, height: 860 } }, { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true }]) {
    // ---------------------------------------------------------------- the chat bubble
    const ctx = await browser.newContext({ viewport: v.viewport, colorScheme: 'light', deviceScaleFactor: 2, ...(v.mobile ? { isMobile: true, hasTouch: true } : {}) });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    let cell = `bubble-${v.name}`;
    await page.goto(`${homeUrl}/`, { waitUntil: 'load' });
    await page.waitForSelector('.kb-launcher', { timeout: 20000 });
    await page.click('.kb-launcher');
    await page.fill('.kb-input', Q);
    await page.press('.kb-input', 'Enter');
    const card = page.locator('.kb-msg .kb-products a.kb-prod').first();
    await card.waitFor({ state: 'visible', timeout: 30000 });
    const href = await card.getAttribute('href');
    const g = tagsOf(href);
    check(cell, 'the product card links the product page with the campaign tags and a click id', g.base === `${dev.shopUrl}/products/trail-pro` && tagged(g, 'webchat', 'product_chat'), href);
    check(cell, 'it is still a normal new-tab link (so middle-click and "open in a new tab" carry the tags too)', (await card.getAttribute('target')) === '_blank' && /noopener/.test(await card.getAttribute('rel') || ''));
    const src = await page.locator('.kb-msg .kb-sources a.kb-src-title').first().getAttribute('href').catch(() => null);
    check(cell, 'the source link carries the tags as a source', !!src && tagged(tagsOf(src), 'webchat', 'source_chat'), src);
    const inText = await page.locator('.kb-msg .kb-md a[href^="http"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    check(cell, 'links inside the answer carry the tags as links', inText.every((x) => tagged(tagsOf(x), 'webchat', 'link_chat')), inText.join(' '));
    const before = await clicksOn('web');
    const out = await clickOut(page, card);
    check(cell, 'a click opens the product page in a new tab with the tags', out.popupUrl === href, out.popupUrl);
    check(cell, 'the click is reported by a beacon (text/plain, 204): click id, the plain link, its kind', out.beacon?.status === 204 && /^text\/plain/.test(out.beacon.type) && out.beacon.body.cid === g.cid && out.beacon.body.url === `${dev.shopUrl}/products/trail-pro` && out.beacon.body.kind === 'product', JSON.stringify(out.beacon));
    check(cell, 'the click is in the report', (await clicksOn('web')) === before + 1);
    check(cell, 'no cookie is set on the customer\'s site', (await ctx.cookies()).length === 0, JSON.stringify(await ctx.cookies()));
    check(cell, 'no page overflow', await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1));
    if (v.name === 'desktop') trailCid = g.cid;
    await page.screenshot({ path: path.join(SHOTS, `chat-bubble-card-${v.name}.png`) });

    // ---------------------------------------------------------------- voice mode (in the bubble)
    cell = `voice-${v.name}`;
    await page.click('.kb-mic');
    await page.waitForSelector('.kb-voice .kbvm[data-engine]', { state: 'attached', timeout: 20000 });
    const input = page.locator('.kb-voice .kbvm-type input');
    await input.fill('How much is the Commuter Lite?');
    await input.press('Enter');
    const vcard = page.locator('.kb-voice .kbvm-prods a.kb-prod[data-kb-tracked]').first();
    await vcard.waitFor({ state: 'visible', timeout: 30000 });
    const vhref = await vcard.getAttribute('href');
    check(cell, 'the voice card carries the tags as "voice"', tagsOf(vhref).base === `${dev.shopUrl}/products/commuter-lite` && tagged(tagsOf(vhref), 'voice', 'product_chat'), vhref);
    const vb = await clicksOn('voice');
    const vout = await clickOut(page, vcard);
    check(cell, 'a click opens the page with the tags and is reported', vout.popupUrl === vhref && vout.beacon?.status === 204 && vout.beacon.body.kind === 'product', JSON.stringify(vout));
    check(cell, 'the click is in the report', (await clicksOn('voice')) === vb + 1);
    check(cell, 'no console errors', !errors.length, errors.join(' | '));
    await ctx.close();

    // ---------------------------------------------------------------- Homepage search
    cell = `homepage-${v.name}`;
    const ctx2 = await browser.newContext({ viewport: v.viewport, colorScheme: 'light', deviceScaleFactor: 2, ...(v.mobile ? { isMobile: true, hasTouch: true } : {}) });
    const p2 = await ctx2.newPage();
    const e2 = watchErrors(p2);
    await p2.goto(`${homeUrl}/search`, { waitUntil: 'load' });
    await p2.locator('knowbot-overlay #kb-q').waitFor({ state: 'visible', timeout: 20000 });
    await p2.locator('knowbot-overlay #kb-q').fill(Q);
    await p2.keyboard.press('Enter');
    const hcard = p2.locator('knowbot-overlay a.prod').first();
    await hcard.waitFor({ state: 'visible', timeout: 30000 });
    const hhref = await hcard.getAttribute('href');
    check(cell, 'the product card carries the tags as "homepage"', tagsOf(hhref).base === `${dev.shopUrl}/products/trail-pro` && tagged(tagsOf(hhref), 'homepage', 'product_chat'), hhref);
    const hsrc = await p2.locator('knowbot-overlay a.src-link[data-kb-tracked]').first().getAttribute('href').catch(() => null);
    check(cell, 'a source page link carries the tags as a source', !!hsrc && tagged(tagsOf(hsrc), 'homepage', 'source_chat'), hsrc);
    const hb = await clicksOn('site');
    const hout = await clickOut(p2, hcard);
    check(cell, 'a click opens the page with the tags and is reported', hout.popupUrl === hhref && hout.beacon?.status === 204 && hout.beacon.body.kind === 'product', JSON.stringify(hout));
    check(cell, 'the click is in the report', (await clicksOn('site')) === hb + 1);
    check(cell, 'no page overflow, no console errors', await p2.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1) && !e2.length, e2.join(' | '));
    await ctx2.close();
  }

  // ------------------------------------------------------------------ Global Privacy Control
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }); });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    let beacons = 0;
    page.on('request', (r) => { if (/\/click$/.test(r.url())) beacons++; });
    await page.goto(`${homeUrl}/`, { waitUntil: 'load' });
    await page.click('.kb-launcher');
    await page.fill('.kb-input', Q);
    await page.press('.kb-input', 'Enter');
    const card = page.locator('.kb-msg .kb-products a.kb-prod').first();
    await card.waitFor({ state: 'visible', timeout: 30000 });
    const g = tagsOf(await card.getAttribute('href'));
    check('privacy', 'with Global Privacy Control the link keeps its campaign tags but has no click id', g.source === 'knowbot' && g.medium === 'webchat' && g.content === 'product_chat' && g.cid === null, JSON.stringify(g));
    const before = (await report()).totals.clicks;
    const [popup] = await Promise.all([page.waitForEvent('popup'), card.click()]);
    await page.waitForTimeout(600);
    await popup.close().catch(() => {});
    check('privacy', 'no click is reported or recorded', beacons === 0 && (await report()).totals.clicks === before, `beacons ${beacons}`);
    // a landing page never keeps a click id for such a visitor
    await page.goto(`${homeUrl}/landing?kb_cid=${trailCid}`, { waitUntil: 'load' });
    await page.waitForSelector('.kb-launcher', { timeout: 20000 });
    check('privacy', 'the landing page keeps nothing', await page.evaluate(() => localStorage.getItem('kb_cid')) === null && !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------------ the Studio: Stats & Leads and Set up
  const studioCtx = async (v) => {
    const context = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: 2, colorScheme: 'light', acceptDownloads: true, locale: 'en-US', ...(v.mobile ? { isMobile: true, hasTouch: true } : {}) });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await context.addInitScript(({ trial }) => {
      try {
        localStorage.setItem('kb-landing', 'skip');
        localStorage.setItem('knowbot-theme', 'light');
        localStorage.setItem('kb-studio:v1', JSON.stringify({ trial: { id: trial.trialId, token: trial.token, expiresAt: trial.expiresAt }, ui: { view: 'bot' }, milestones: { firstFile: 1, firstReady: 1, firstCited: 1 } }));
      } catch { /* ignore */ }
    }, { trial: t });
    return context;
  };
  const axe = async (page, sel) => injectAxe(page).then(() => page.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map((x) => `${x.id}: ${x.nodes.length} (${x.nodes[0]?.target?.join(' ')})`), sel))
    .catch((e) => [`axe did not run: ${e.message}`]);
  const openStats = async (page) => {
    await page.goto(`${dev.studioUrl}#stats?range=7`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#kb-sales', { timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('.kb-stats-body[aria-busy]'), null, { timeout: 15000 });
  };
  /** A screenshot of one section, whole: the view is made tall for the shot so nothing is cut by a scroll box. */
  const shot = async (page, sel, file, v) => {
    await page.setViewportSize({ width: v.viewport.width, height: 3400 });
    await settled(page);
    await page.locator(sel).scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.locator(sel).screenshot({ path: path.join(SHOTS, file) });
    await page.setViewportSize(v.viewport);
  };
  const VIEWS = [{ name: 'desktop', viewport: { width: 1440, height: 1000 } }, { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true }];

  console.log('2. Stats & Leads before any order page was seen; the Set up card');
  for (const v of VIEWS) {
    const cell = `not-installed-${v.name}`;
    const context = await studioCtx(v);
    const page = await context.newPage();
    const errors = watchErrors(page);
    await openStats(page);
    const s = await page.evaluate(() => {
      const sec = document.querySelector('#kb-sales');
      return { tiles: [...sec.querySelectorAll('.kb-sales-tiles .kb-sales-tile')].map((x) => x.textContent), cta: !!sec.querySelector('.kb-sales-setup'), text: sec.textContent,
        chart: !!sec.querySelector('.kb-sales-chart'), prods: [...sec.querySelectorAll('.kb-sales-table tbody tr')].map((r) => r.textContent), overflow: document.scrollingElement.scrollWidth > innerWidth + 1,
        secOverflow: sec.scrollWidth > sec.clientWidth + 1 };
    });
    check(cell, 'the section shows the clicks and the click rate', /^Clicks\d/.test(s.tiles[0] || '') && Number(/\d+/.exec(s.tiles[0])[0]) >= 6 && /Answers that got a click\d+%/.test(s.tiles[1] || ''), JSON.stringify(s.tiles));
    check(cell, 'no zero orders or $0: it says no order page was seen yet, and that most sites need nothing installed', s.cta && /No order page has been seen yet/.test(s.text) && /notices orders by itself, with nothing to install/.test(s.text) && !/Orders after a click0|\$0/.test(s.text) && !/Sales CSV/.test(s.text), s.text.slice(0, 300));
    check(cell, 'the chart, the top products (Trail Pro, Commuter Lite) and the questions are there', s.chart && s.prods.some((x) => /Trail Pro/.test(x)) && s.prods.some((x) => /Commuter Lite/.test(x)) && /How much is the Trail Pro\?/.test(s.text));
    check(cell, 'nothing unfilled on screen', !/\bnull\b|undefined|NaN/.test(s.text));
    check(cell, 'plain words: campaign tags are explained where they are named', /UTM tags: short labels added to the end of a link/.test(s.text));
    check(cell, 'no horizontal overflow', !s.overflow && !s.secOverflow);
    check(cell, 'axe: no violations in Stats & Leads', (await axe(page, '#kb-stats')).length === 0, (await axe(page, '#kb-stats')).join(' | '));
    await shot(page, '#kb-sales', `clicks-sales-not-installed-${v.name}.png`, v);
    // "Check sale tracking" leaves Stats and opens the card in Set up
    await page.locator('.kb-sales-setup').click();
    await page.waitForSelector('#gl-sale', { state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => !/Checking/.test(document.querySelector('#gl-sale .gl-sale-state')?.textContent || 'Checking'), null, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => document.activeElement?.id === 'gl-sale-t', null, { timeout: 5000 }).catch(() => {});
    const c = await page.evaluate(() => {
      const card = document.querySelector('#gl-sale');
      const r = card.getBoundingClientRect();
      return { stats: !!document.querySelector('#kb-stats'), tabs: [...card.querySelectorAll('[role="tab"]')].map((x) => x.textContent), state: card.querySelector('.gl-sale-state')?.textContent, text: card.textContent,
        help: card.querySelector('.gl-si-help')?.textContent, live: card.querySelector('#gl-sale-live')?.textContent, more: [...card.querySelectorAll('details > summary')].map((x) => x.textContent), open: [...card.querySelectorAll('details')].map((x) => x.open),
        win: card.querySelector('.gl-sale-win')?.value, inView: r.top < innerHeight && r.bottom > 0, overflow: document.scrollingElement.scrollWidth > innerWidth + 1, focus: document.activeElement?.id };
    });
    check(cell, 'Set up shows the Sale tracking card (Stats closed), in view and focused', !c.stats && c.inView && c.focus === 'gl-sale-t', JSON.stringify({ stats: c.stats, inView: c.inView, focus: c.focus }));
    check(cell, 'it leads with "Already tracking": the website line reports orders on its own, nothing else to install', /^Already tracking: your KnowBot website line reports orders on its own on most sites\./.test(c.help || '') && /nothing else to install/.test(c.help || ''), c.help);
    check(cell, 'the live status: "Not seen yet", and when it starts', c.state === 'Not seen yet' && /^Not seen yet\. This starts by itself/.test(c.live || '') && c.win === '7', JSON.stringify([c.state, c.live, c.win]));
    check(cell, 'then "Shopify: one extra paste" and "If your order page doesn’t load the KnowBot line", both closed', c.more.join('|') === 'Shopify: one extra paste|If your order page doesn’t load the KnowBot line' && c.open.every((x) => !x), JSON.stringify([c.more, c.open]));
    check(cell, 'Shopify: one plain sentence says why the paste is needed, and that no app is', /Shopify does not let any website script run on its checkout and thank-you pages, so on Shopify the order is reported by a small “custom pixel” that you paste once in Shopify’s own settings\. There is no app to install\./.test(c.text) && /Customer events/.test(c.text) && /Additional details/.test(c.text));
    check(cell, 'it says how an order is noticed, that nothing is guessed, and what is (not) sent', /purchase event/.test(c.text) && /Order received/.test(c.text) && /Never a guess/.test(c.text) && /functions\.php/.test(c.text) && /Never a customer’s name, email or address/.test(c.text) && /sets no cookie/.test(c.text));
    check(cell, 'plain words: no "idempotent", "beacon", "dataLayer" or "localStorage" in the card\'s own text', !/idempotent|beacon|dataLayer|localStorage|sandbox/i.test(await page.evaluate(() => [...document.querySelectorAll('#gl-sale p, #gl-sale li, #gl-sale summary, #gl-sale h3, #gl-sale h4')].map((x) => x.textContent).join(' '))));
    const codes = {};
    await page.locator('#gl-sale-shopify > summary').click();
    codes.shopify = await page.locator('#gl-sale-shopify pre').textContent();
    await page.locator('#gl-sale-snippet > summary').click();
    for (const [i, name] of ['any', 'woo'].entries()) {
      await page.locator('#gl-sale-snippet [role="tab"]').nth(i).click();
      codes[name] = await page.locator('#gl-sale-snippet pre').textContent();
    }
    check(cell, 'the tabs of the snippet: Any site, WooCommerce', c.tabs.join('|') === 'Any site|WooCommerce', c.tabs.join('|'));
    check(cell, 'each snippet names this bot and nothing personal; the pixel reads the order\'s own note first', codes.shopify.includes(`/v1/bots/${t.trialId}/sale`) && /checkout_completed/.test(codes.shopify) && codes.shopify.indexOf('c.attributes') > 0 && codes.shopify.indexOf('c.attributes') < codes.shopify.indexOf('browser.localStorage')
      && /woocommerce_thankyou/.test(codes.woo) && codes.woo.includes(t.trialId) && codes.any.includes(`${dev.url}/site/sale.js`) && codes.any.includes(`data-bot="${t.trialId}"`) && !/c\.email|shippingAddress|billingAddress|order\.customer/i.test(codes.shopify) && !/email|name\b|address/i.test(codes.any), JSON.stringify(codes).slice(0, 400));
    // the pixel, exactly as copied, runs in a bare sandbox (analytics, browser, fetch) and reports the order's own click id
    const ran = await page.evaluate(async (code) => {
      const subs = {}, posts = [];
      new Function('analytics', 'browser', 'fetch', code)({ subscribe: (n, f) => { subs[n] = f; } }, { localStorage: { getItem: async () => 'zzzzzzzzzzzz', setItem: async () => {} } }, (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return Promise.resolve(); });
      await subs.checkout_completed({ data: { checkout: { currencyCode: 'USD', totalPrice: { amount: 20 }, order: { id: '9001' }, email: 'ada@example.com', attributes: [{ key: 'kb_cid', value: 'abcdefghijkm' }], lineItems: [{ title: 'Cap', quantity: 1 }] } } });
      return posts;
    }, codes.shopify);
    check(cell, 'the copied pixel posts { click id from the order, order, total, currency, items } and nothing personal', ran.length === 1 && ran[0].url.endsWith(`/v1/bots/${t.trialId}/sale`) && JSON.stringify(ran[0].body) === '{"cid":"abcdefghijkm","order":"9001","total":20,"currency":"USD","via":"pixel","items":[{"title":"Cap","quantity":1}]}', JSON.stringify(ran));
    await page.locator('#gl-sale-snippet [role="tab"]').nth(0).click();
    await page.locator('#gl-sale-snippet .gl-code-tools button[aria-label^="Cop"]').last().click();
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    check(cell, 'Copy copies the snippet', copied === null || copied === codes.any, String(copied).slice(0, 120));
    await page.locator('#gl-sale .gl-sale-win').selectOption('14');
    await page.waitForFunction(async () => true);
    let win = 0;
    for (let i = 0; i < 30 && win !== 14; i++) { win = (await report()).saleWindowDays; if (win !== 14) await sleep(100); }
    check(cell, 'the attribution window saves (14 days)', win === 14, String(win));
    await page.locator('#gl-sale .gl-sale-win').selectOption('7');
    for (let i = 0; i < 30 && win !== 7; i++) { win = (await report()).saleWindowDays; if (win !== 7) await sleep(100); }
    check(cell, 'and back to 7', win === 7);
    check(cell, 'no page overflow; axe: no violations in the card', !c.overflow && (await axe(page, '#gl-sale')).length === 0, (await axe(page, '#gl-sale')).join(' | '));
    await shot(page, '#gl-sale', `setup-sale-tracking-open-${v.name}.png`, v);
    await page.locator('#gl-sale-shopify > summary').click();
    await page.locator('#gl-sale-snippet > summary').click();
    await shot(page, '#gl-sale', `setup-sale-tracking-${v.name}.png`, v);
    await page.locator('#gl-sale-shopify > summary').click();
    await shot(page, '#gl-sale', `setup-sale-tracking-shopify-${v.name}.png`, v);
    check(cell, 'no console errors', !errors.length, errors.join(' | '));
    await context.close();
  }

  console.log('3. a store with only the website line: the landing page, an order page it cannot read, a GA4 purchase, a WooCommerce order page');
  /** Opens the Sale tracking card in Set up and reads its status. */
  const cardStatus = async (page) => {
    await page.goto('about:blank');
    await page.goto(dev.studioUrl, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('knowbot:open-sale-setup')));
    await page.waitForSelector('#gl-sale', { state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => !/Checking/.test(document.querySelector('#gl-sale .gl-sale-state')?.textContent || 'Checking'), null, { timeout: 10000 }).catch(() => {});
    return page.evaluate(() => { const card = document.querySelector('#gl-sale'); return { state: card.querySelector('.gl-sale-state')?.textContent, tone: card.querySelector('.gl-sale-state')?.className, live: card.querySelector('#gl-sale-live')?.textContent, open: [...card.querySelectorAll('details')].map((x) => x.open), status: card.dataset.status }; });
  };
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    const saleScripts = [];
    page.on('request', (r) => { if (/\/site\/sale\.js/.test(r.url())) saleScripts.push(r.url()); });
    /** The next POST to …/sale from this page: { status, body }, or null when none comes in `ms`. */
    const nextSale = (ms = 10000) => page.waitForResponse((r) => /\/api\/v1\/bots\/[^/]+\/sale$/.test(r.url()), { timeout: ms }).then((r) => ({ status: r.status(), body: JSON.parse(r.request().postData() || '{}'), type: r.request().headers()['content-type'] || '' })).catch(() => null);
    let sent = nextSale();
    await page.goto(`${homeUrl}/landing?utm_source=knowbot&utm_medium=webchat&kb_cid=${trailCid}`, { waitUntil: 'load' });
    await page.waitForSelector('.kb-launcher', { timeout: 20000 });
    const kept = await page.evaluate(() => ({ cid: localStorage.getItem('kb_cid'), at: Number(localStorage.getItem('kb_cid_at')), cookie: document.cookie }));
    check('sale', 'the landing page keeps the click id in the site\'s own localStorage, and sets no cookie', kept.cid === trailCid && kept.at > 0 && kept.cookie === '' && (await ctx.cookies()).length === 0, JSON.stringify(kept));
    let res = await sent;
    const tag = await page.evaluate(() => { const x = document.querySelector('script[data-knowbot-sale]'); return x ? { src: x.src, async: x.async, bot: x.dataset.bot, n: document.querySelectorAll('script[src*="site/sale.js"]').length, html: document.documentElement.innerHTML.split('site/sale.js').length - 1 } : null; });
    check('sale', 'the website line loaded the sale script by itself (one async tag, after the page loaded); the page has no sale snippet', !!tag && tag.async === true && tag.bot === t.trialId && tag.n === 1 && saleScripts.length === 1 && new URL(tag.src).origin === dev.url, JSON.stringify([tag, saleScripts]));
    check('sale', 'not an order page: the visitor from the chat only says "the line runs here" (a plain-text check-in)', !!res && res.status === 200 && JSON.stringify(res.body) === '{"ping":true,"page":"site"}' && /^text\/plain/.test(res.type), JSON.stringify(res));
    let st = (await report()).saleTracking;
    check('sale', 'the report: waiting for the first order page', st.status === 'waiting' && st.installed === false && !!st.siteSeenAt, JSON.stringify(st));

    // a WooCommerce order page that prints a bare "$": the currency is not certain, so nothing is counted or guessed
    sent = nextSale();
    await page.goto(`${homeUrl}/checkout/order-received/2001/?cur=usd`, { waitUntil: 'load' });
    res = await sent;
    check('sale', 'an order page whose currency is not certain ("$"): no order is sent, only what could not be read', !!res && JSON.stringify(res.body) === '{"ping":true,"via":"page","unread":"currency"}', JSON.stringify(res));
    st = (await report()).saleTracking;
    check('sale', 'the report: still waiting, no order counted, and it says the currency could not be read', st.status === 'waiting' && st.unread?.what === 'currency' && st.unread?.via === 'page' && (await report()).totals.orders === 0, JSON.stringify(st));
    {
      const context = await studioCtx(VIEWS[0]);
      const sp = await context.newPage();
      const c = await cardStatus(sp);
      check('sale', 'the Studio card: "Waiting for the first order page", the unread order page in plain words, the snippet section opened', c.state === 'Waiting for the first order page' && /^Waiting for the first order page\. Your KnowBot line was seen on your site/.test(c.live || '') && /its currency could not be read for certain, so nothing was counted or guessed/.test(c.live || '') && c.open[1] === true, JSON.stringify(c));
      await shot(sp, '#gl-sale', 'setup-sale-tracking-waiting-desktop.png', VIEWS[0]);
      await context.close();
    }

    // the thank-you page of a store that tells Google Analytics about purchases: only the website line is on it
    sent = nextSale(15000);
    await page.goto(`${homeUrl}/thanks?order=1001&total=1899.00`, { waitUntil: 'load' });
    res = await sent;
    const body = res?.body || null;
    check('sale', 'a GA4 purchase pushed to dataLayer after the page loaded is reported with no extra snippet: click id, order, total, currency, item names, "event"', !!res && res.status === 200 && JSON.stringify(Object.keys(body).sort()) === '["cid","currency","items","order","total","via"]' && body.cid === trailCid && body.order === '1001' && body.total === '1899' && body.currency === 'USD' && body.via === 'event' && JSON.stringify(body.items) === '[{"title":"Trail Pro","quantity":1,"price":"1899"}]', JSON.stringify(body));
    check('sale', 'nothing personal left the page (the name and email on it and in the event stay there)', !!body && !/ada|lovelace|example\.com/i.test(JSON.stringify(body)));
    check('sale', 'the page\'s own dataLayer still works: its entries are all there', await page.evaluate(() => Array.isArray(window.dataLayer) && window.dataLayer.length === 2 && window.dataLayer[1].event === 'purchase'));
    // a reload of the thank-you page does not report it again
    let again = 0;
    const count = (r) => { if (/\/sale$/.test(r.url())) again++; };
    page.on('request', count);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(2500);
    let r = await report();
    check('sale', 'one order, once: $1,899 after the Trail Pro click, noticed from the store\'s purchase event', again === 0 && r.totals.orders === 1 && r.totals.revenue?.[0]?.amount === 1899 && r.sales[0].title === 'Trail Pro' && r.sales[0].question === Q && r.sales[0].via === 'event' && r.saleTracking.installed === true && r.saleTracking.status === 'detected' && r.saleTracking.via === 'event' && r.saleTracking.unread === null, JSON.stringify([r.totals, r.saleTracking]));
    page.off('request', count);

    // a WooCommerce order-received page in euros, read from the page itself
    sent = nextSale();
    await page.goto(`${homeUrl}/checkout/order-received/2002/`, { waitUntil: 'load' });
    res = await sent;
    check('sale', 'a WooCommerce order page ("1.299,50 €") is read: order 2002, 1299.50 EUR, "page"; no name, email or address', !!res && res.status === 200 && JSON.stringify(res.body) === JSON.stringify({ cid: trailCid, order: '2002', total: '1299.50', currency: 'EUR', via: 'page' }), JSON.stringify(res));
    r = await report();
    check('sale', 'two orders now; the newest was seen on the order page', r.totals.orders === 2 && r.sales[0].order === '2002' && r.sales[0].total === 1299.5 && r.sales[0].currency === 'EUR' && r.sales[0].via === 'page' && r.saleTracking.via === 'page', JSON.stringify(r.sales.map((x) => [x.order, x.total, x.currency, x.via])));
    check('sale', 'still no cookie on the customer\'s site, and one sale script per page', (await ctx.cookies()).length === 0 && saleScripts.length === 5, JSON.stringify([await ctx.cookies(), saleScripts.length]));
    check('sale', 'no console errors on the customer\'s pages', !errors.length, errors.join(' | '));
    await ctx.close();

    // Global Privacy Control: the line does not even load the sale script; nothing is kept or sent
    const gpc = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await gpc.addInitScript(() => { Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true }); });
    const gp = await gpc.newPage();
    let gpcSale = 0;
    gp.on('request', (q) => { if (/\/sale$|\/site\/sale\.js/.test(q.url())) gpcSale++; });
    await gp.goto(`${homeUrl}/thanks?order=1005&total=10.00&kb_cid=${trailCid}`, { waitUntil: 'load' });
    await gp.waitForSelector('.kb-launcher', { timeout: 20000 });
    await gp.waitForTimeout(2500);
    check('sale', 'Global Privacy Control: no click id kept, the sale script is not loaded, nothing is sent', gpcSale === 0 && (await gp.evaluate(() => localStorage.getItem('kb_cid'))) === null && (await report()).totals.orders === 2, String(gpcSale));
    await gpc.close();
  }
  for (const v of VIEWS) {
    const cell = `installed-${v.name}`;
    const context = await studioCtx(v);
    const page = await context.newPage();
    const errors = watchErrors(page);
    await openStats(page);
    const s = await page.evaluate(() => {
      const sec = document.querySelector('#kb-sales');
      return { tiles: [...sec.querySelectorAll('.kb-sales-tiles .kb-sales-tile')].map((x) => x.textContent), cta: !!sec.querySelector('.kb-sales-setup'), label: sec.querySelector('.kb-sales-src')?.textContent,
        orders: [...sec.querySelectorAll('#kb-sales-oh ~ .kb-leads-scroll tbody tr')].map((r) => [...r.cells].map((c) => c.textContent)), head: [...sec.querySelectorAll('#kb-sales-oh ~ .kb-leads-scroll thead th')].map((c) => c.textContent), legend: [...sec.querySelectorAll('.kb-chart-key li')].map((x) => x.textContent),
        csv: [...sec.querySelectorAll('[data-csv]')].map((b) => b.dataset.csv), table: [...sec.querySelectorAll('figcaption table tbody tr')].map((r) => r.textContent),
        overflow: document.scrollingElement.scrollWidth > innerWidth + 1, secOverflow: sec.scrollWidth > sec.clientWidth + 1 };
    });
    check(cell, 'totals: orders and sales after a click, per currency', /Orders after a click2reported by your site, within 7 days of a click/.test(s.tiles[2] || '') && /Sales after a click\$1,899\.00 \+ €1,299\.50/.test(s.tiles[3] || '') && !s.cta, JSON.stringify(s.tiles));
    const o1 = s.orders.find((x) => x[1] === '1001') || [];
    check(cell, 'the orders are listed, labelled "Reported by your site"', s.label === 'Reported by your site' && s.orders.length === 2 && /\$1,899\.00/.test(o1[2]) && /Trail Pro/.test(o1[3]) && o1[4] === Q && o1[5] === 'Website chat', JSON.stringify(s.orders));
    check(cell, 'each order says how it was noticed: the store\'s purchase event, the order page', s.head.at(-1) === 'How it was noticed' && o1[6] === 'From your store’s purchase event' && s.orders[0][1] === '2002' && /€1,299\.50/.test(s.orders[0][2]) && s.orders[0][6] === 'Seen on your order page', JSON.stringify([s.head, s.orders.map((x) => x[6])]));
    check(cell, 'the chart has a legend and a table for screen readers with the day\'s clicks, orders and sales', s.legend.join('|') === 'Clicks|Orders after a click' && s.table.some((x) => /\$1,899\.00/.test(x)), JSON.stringify([s.legend, s.table]));
    // top products by sales
    await page.locator('#kb-sales [data-sort="revenue"]').click();
    const first = await page.locator('#kb-sales .kb-sales-table').first().locator('tbody tr').first().textContent();
    check(cell, 'top products can be ordered by sales (Trail Pro first, $1,899.00)', /Trail Pro/.test(first) && /\$1,899\.00/.test(first), first);
    // the question history: the answered row shows its click and its sale
    await page.locator('#kb-hist-q').fill('Trail Pro');
    await page.waitForFunction(() => [...document.querySelectorAll('.kb-hist-row')].length > 0 && [...document.querySelectorAll('.kb-hist-row')].every((r) => /Trail Pro/.test(r.textContent)), null, { timeout: 10000 }).catch(() => {});
    const rows = await page.evaluate(() => [...document.querySelectorAll('.kb-hist-row')].map((r) => ({ ch: r.dataset.channel, click: r.querySelector('.kb-out-click')?.textContent || '', sale: r.querySelector('.kb-out-sale')?.textContent || '' })));
    check(cell, 'the question history shows the clicks on each answer, and the sale on the one that led to it', rows.filter((x) => x.click).length >= 3 && rows.filter((x) => /Sale \$1,899\.00/.test(x.sale)).length === 1 && rows.find((x) => x.sale)?.ch === 'web', JSON.stringify(rows));
    check(cell, 'no horizontal overflow', !s.overflow && !s.secOverflow);
    check(cell, 'axe: no violations', (await axe(page, '#kb-stats')).length === 0, (await axe(page, '#kb-stats')).join(' | '));
    if (v.name === 'desktop') {
      for (const [kind, head, want] of [['clicks', CLICK_COLS, /,web,product,Trail Pro,1899,USD,/], ['sales', SALE_COLS, /,1001,1899,USD,Trail Pro,web,[^\r\n]*,reported by your site,from your store's purchase event\r\n/]]) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator(`#kb-sales [data-csv="${kind}"]`).click()]);
        const file = path.join(SHOTS, `sample-${kind}.csv`);
        await dl.saveAs(file);
        const text = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
        check(cell, `the ${kind} CSV downloads with its header and the row`, new RegExp(`^knowbot-${kind}-.*\\.csv$`).test(dl.suggestedFilename()) && text.split('\r\n')[0] === head && want.test(text), text.slice(0, 300));
        if (kind === 'sales') check(cell, 'the sales CSV says how each order was noticed', /,2002,1299\.5,EUR,[^\r\n]*,reported by your site,seen on your order page\r\n/.test(text), text.slice(0, 400));
      }
    }
    await page.locator('#kb-hist-q').fill('');
    await shot(page, '#kb-sales', `clicks-sales-${v.name}.png`, v);
    // the Set up card now says what it saw
    const c = await cardStatus(page);
    check(cell, 'the Studio card: "Detected on your site", which detector fired last, and the latest order', c.state === 'Detected on your site' && /chip green/.test(c.tone || '') && /^Detected on your site: your order page was read\. Last seen .+\. The latest order after a click came in on /.test(c.live || '') && !/could not be read/.test(c.live || '') && c.status === 'detected', JSON.stringify(c));
    check(cell, 'axe: no violations in the card; no page overflow', (await axe(page, '#gl-sale')).length === 0 && await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), (await axe(page, '#gl-sale')).join(' | '));
    await shot(page, '#gl-sale', `setup-sale-tracking-detected-${v.name}.png`, v);
    check(cell, 'no console errors', !errors.length, errors.join(' | '));
    await context.close();
  }
} catch (e) {
  failures++;
  console.error(`  [FAIL] the smoke stopped: ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  await new Promise((r) => (home ? home.close(() => r()) : r()));
  home?.closeAllConnections?.();
  await dev.close().catch(() => {});
}
console.log(failures ? `\n${failures} check(s) failed. Screenshots: ${SHOTS}` : `\nAll checks passed. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);

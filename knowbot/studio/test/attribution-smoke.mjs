#!/usr/bin/env node
// Clicks & sales, end to end in a real browser (Playwright) against studio/test/dev-server.mjs (fake knowDrive, fake
// model, a fake store on 127.0.0.1; never a real service).
//
//   1. a bot that imported the fake store, on a "customer's site" (a local page with the one website line):
//      - the chat bubble: a product answer's card, source link and links carry the campaign tags and a click id; a click
//        opens the product page in a new tab with them and is reported (a beacon) without holding the navigation
//      - Homepage search (site/overlay.js) and voice mode (lib/voice-mode.js): the same, as "homepage" and "voice"
//      - Global Privacy Control: the tags stay, there is no click id and nothing is reported
//   2. Stats & Leads → Clicks & sales before sale tracking is installed: the clicks, and how to turn sale tracking on
//      (never zeros that look like "no sales"); "Set up sale tracking" opens the card in Set up: the snippet per
//      platform, Copy, the attribution window
//   3. the landing page keeps the click id (first-party localStorage, no cookie); the thank-you page's snippet
//      (site/sale.js) reports an order → it shows as attributed: totals, the chart, top products, the orders table,
//      the question history row, both CSVs
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
const SALE_COLS = 'timestamp,bot,order_id,total,currency,items,channel,clicked_at,product,url,question,click_id,source';

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
  // that carries the website line (as every page of the owner's site does), and the order-confirmation page
  const line = (attrs) => `<script type="module" src="${dev.url}/lib/embed.js" data-api="${dev.url}" data-bot="${t.trialId}" data-key="${key}" ${attrs}></script>`;
  const doc = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  home = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (u.pathname === '/search') return res.end(doc('Lumen Bikes', `<p>Ride further.</p>${line('data-chat="off" data-voice="off" data-homepage="on"')}`));
    if (u.pathname === '/landing') return res.end(doc('Trail Pro', `<p>A product page on the owner's site.</p>${line('data-chat="on" data-voice="off" data-homepage="off"')}`));
    if (u.pathname === '/thanks') {
      return res.end(doc('Thank you', `<p>Order ${u.searchParams.get('order')} is confirmed.</p>
<script async src="${dev.url}/site/sale.js" data-api="${dev.url}" data-bot="${t.trialId}" data-order="${u.searchParams.get('order')}" data-total="${u.searchParams.get('total')}" data-currency="USD"></script>`));
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

  console.log('2. Stats & Leads before sale tracking is installed; the Set up card');
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
    check(cell, 'no zero orders or $0: it says sale tracking is not installed and how to turn it on', s.cta && /Sale tracking is not installed yet/.test(s.text) && !/Orders after a click0|\$0/.test(s.text) && !/Sales CSV/.test(s.text), s.text.slice(0, 300));
    check(cell, 'the chart, the top products (Trail Pro, Commuter Lite) and the questions are there', s.chart && s.prods.some((x) => /Trail Pro/.test(x)) && s.prods.some((x) => /Commuter Lite/.test(x)) && /How much is the Trail Pro\?/.test(s.text));
    check(cell, 'nothing unfilled on screen', !/\bnull\b|undefined|NaN/.test(s.text));
    check(cell, 'plain words: campaign tags are explained where they are named', /UTM tags: short labels added to the end of a link/.test(s.text));
    check(cell, 'no horizontal overflow', !s.overflow && !s.secOverflow);
    check(cell, 'axe: no violations in Stats & Leads', (await axe(page, '#kb-stats')).length === 0, (await axe(page, '#kb-stats')).join(' | '));
    await shot(page, '#kb-sales', `clicks-sales-not-installed-${v.name}.png`, v);
    // "Set up sale tracking" leaves Stats and opens the card in Set up
    await page.locator('.kb-sales-setup').click();
    await page.waitForSelector('#gl-sale', { state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => /installed|off/i.test(document.querySelector('#gl-sale .gl-sale-state')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => document.activeElement?.id === 'gl-sale-t', null, { timeout: 5000 }).catch(() => {});
    const c = await page.evaluate(() => {
      const card = document.querySelector('#gl-sale');
      const r = card.getBoundingClientRect();
      return { stats: !!document.querySelector('#kb-stats'), tabs: [...card.querySelectorAll('[role="tab"]')].map((x) => x.textContent), state: card.querySelector('.gl-sale-state')?.textContent, text: card.textContent,
        win: card.querySelector('.gl-sale-win')?.value, inView: r.top < innerHeight && r.bottom > 0, overflow: document.scrollingElement.scrollWidth > innerWidth + 1, focus: document.activeElement?.id };
    });
    check(cell, 'Set up shows the Sale tracking card (Stats closed), in view and focused', !c.stats && c.inView && c.focus === 'gl-sale-t', JSON.stringify({ stats: c.stats, inView: c.inView, focus: c.focus }));
    check(cell, 'three platforms, "Not installed yet", a 7-day window', c.tabs.join('|') === 'Shopify|WooCommerce|Any site' && c.state === 'Not installed yet' && c.win === '7', JSON.stringify([c.tabs, c.state, c.win]));
    check(cell, 'it says where the snippet goes per platform and what is (not) sent', /Customer events/.test(c.text) && /functions\.php/.test(c.text) && /order confirmation/.test(c.text) && /never sends a customer’s name, email or address/.test(c.text) && /sets no cookie/.test(c.text));
    const codes = {};
    for (const [i, name] of ['shopify', 'woo', 'any'].entries()) {
      await page.locator('#gl-sale [role="tab"]').nth(i).click();
      codes[name] = await page.locator('#gl-sale pre').textContent();
    }
    check(cell, 'each snippet names this bot and nothing personal', codes.shopify.includes(`/v1/bots/${t.trialId}/sale`) && /checkout_completed/.test(codes.shopify) && /woocommerce_thankyou/.test(codes.woo) && codes.woo.includes(t.trialId)
      && codes.any.includes(`${dev.url}/site/sale.js`) && codes.any.includes(`data-bot="${t.trialId}"`) && !/email|name\b|address/i.test(codes.shopify + codes.any), JSON.stringify(codes).slice(0, 400));
    await page.locator('#gl-sale .gl-code-tools button[aria-label^="Cop"]').last().click();
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
    await page.locator('#gl-sale [role="tab"]').nth(0).click();
    await shot(page, '#gl-sale', `setup-sale-tracking-${v.name}.png`, v);
    check(cell, 'no console errors', !errors.length, errors.join(' | '));
    await context.close();
  }

  console.log('3. the landing page keeps the click id; the thank-you page reports the order; the sale is attributed');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${homeUrl}/landing?utm_source=knowbot&utm_medium=webchat&kb_cid=${trailCid}`, { waitUntil: 'load' });
    await page.waitForSelector('.kb-launcher', { timeout: 20000 });
    const kept = await page.evaluate(() => ({ cid: localStorage.getItem('kb_cid'), at: Number(localStorage.getItem('kb_cid_at')), cookie: document.cookie }));
    check('sale', 'the landing page keeps the click id in the site\'s own localStorage, and sets no cookie', kept.cid === trailCid && kept.at > 0 && kept.cookie === '' && (await ctx.cookies()).length === 0, JSON.stringify(kept));
    const sent = page.waitForResponse((r) => /\/sale$/.test(r.url()), { timeout: 10000 });
    await page.goto(`${homeUrl}/thanks?order=1001&total=1899.00`, { waitUntil: 'load' });
    const res = await sent.catch(() => null);
    const body = res ? JSON.parse(res.request().postData() || '{}') : null;
    check('sale', 'the thank-you page reports click id, order id, total and currency, nothing else', !!res && res.status() === 200 && JSON.stringify(Object.keys(body).sort()) === '["cid","currency","order","total"]' && body.cid === trailCid && body.order === '1001', JSON.stringify(body));
    // a reload of the thank-you page does not report it again
    let again = 0;
    page.on('request', (r) => { if (/\/sale$/.test(r.url())) again++; });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    const r = await report();
    check('sale', 'one order, once: $1,899 after the Trail Pro click', again === 0 && r.totals.orders === 1 && r.totals.revenue?.[0]?.amount === 1899 && r.sales[0].title === 'Trail Pro' && r.sales[0].question === Q && r.saleTracking.installed === true, JSON.stringify(r.totals));
    check('sale', 'no console errors on the customer\'s pages', !errors.length, errors.join(' | '));
    await ctx.close();
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
        orders: [...sec.querySelectorAll('#kb-sales-oh ~ .kb-leads-scroll tbody tr')].map((r) => [...r.cells].map((c) => c.textContent)), legend: [...sec.querySelectorAll('.kb-chart-key li')].map((x) => x.textContent),
        csv: [...sec.querySelectorAll('[data-csv]')].map((b) => b.dataset.csv), table: [...sec.querySelectorAll('figcaption table tbody tr')].map((r) => r.textContent),
        overflow: document.scrollingElement.scrollWidth > innerWidth + 1, secOverflow: sec.scrollWidth > sec.clientWidth + 1 };
    });
    check(cell, 'totals: orders and sales after a click, with the currency', /Orders after a click1reported by your site, within 7 days of a click/.test(s.tiles[2] || '') && /Sales after a click\$1,899\.00/.test(s.tiles[3] || '') && !s.cta, JSON.stringify(s.tiles));
    check(cell, 'the order is listed, labelled "Reported by your site"', s.label === 'Reported by your site' && s.orders.length === 1 && s.orders[0][1] === '1001' && /\$1,899\.00/.test(s.orders[0][2]) && /Trail Pro/.test(s.orders[0][3]) && s.orders[0][4] === Q && s.orders[0][5] === 'Website chat', JSON.stringify(s.orders));
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
      for (const [kind, head, want] of [['clicks', CLICK_COLS, /,web,product,Trail Pro,1899,USD,/], ['sales', SALE_COLS, /,1001,1899,USD,,web,/]]) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator(`#kb-sales [data-csv="${kind}"]`).click()]);
        const file = path.join(SHOTS, `sample-${kind}.csv`);
        await dl.saveAs(file);
        const text = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
        check(cell, `the ${kind} CSV downloads with its header and the row`, new RegExp(`^knowbot-${kind}-.*\\.csv$`).test(dl.suggestedFilename()) && text.split('\r\n')[0] === head && want.test(text), text.slice(0, 300));
      }
    }
    await page.locator('#kb-hist-q').fill('');
    await shot(page, '#kb-sales', `clicks-sales-${v.name}.png`, v);
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

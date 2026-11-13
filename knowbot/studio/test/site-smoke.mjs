#!/usr/bin/env node
// Homepage overlay smoke (site/overlay.js + server/site.mjs) against studio/test/dev-server.mjs (fake knowDrive + fake
// model on 127.0.0.1). Builds a trial bot from the sample files plus a contact page and publishes its site. Then:
//   - the one-line snippet on a fake "existing homepage" (another origin, with hostile CSS), in four cells (desktop /
//     phone × light / dark): it overlays the page, focus is trapped, Esc and × close it and reveal the page, the
//     "Ask <name>" button opens it again and focus comes back, a question gets quote blocks and Sources, a question not in
//     the files gets the refusal sentence, the page's CSS can't touch it (Shadow DOM) and it leaks no globals; no console
//     errors, no horizontal scroll, 44px targets, axe (serious/critical; skipped when axe-core is unreachable, or
//     AXE_PATH=/path/to/axe.min.js); closed stays closed on reload (first visit), every-visit and topic chips options;
//   - the hosted link (neutral backdrop; a ?q= link asks at once; an unknown bot is "not available");
//   - a website import: the hosted link shows the overlay over the store's own homepage in a frame;
//   - the Studio: See it as → Site (the overlay over the homepage, × works) and the Set up card (line, options, publish).
//
//   node studio/test/site-smoke.mjs                 # screenshots to a temp folder (--update-screens: studio/test/screens/site/)
//   SITE_SHOTS=/some/dir node studio/test/site-smoke.mjs
import http from 'node:http';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';
import { outDir } from './smoke-util.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The overlay heading's name: its text, or its logo's alt text (the logo replaces the name under the wave). */
const headName = (loc) => loc.evaluate((el) => el.querySelector('.brandlogo')?.alt || el.textContent.trim());
const SHOTS = outDir('site', process.env.SITE_SHOTS);
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';
const NOT_IN_DATA = "Looks like we don't have that in our files.";
const CONTACT = '# Contact us\n\nCall us on (555) 123-4567 for help with an order.\n\nEmail help@lumen.example and we reply within one business day.\n\nThe shop is open Monday to Friday, 9am to 5pm.\n';
const CELLS = [
  { name: 'desktop-light', viewport: { width: 1280, height: 900 }, theme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1280, height: 900 }, theme: 'dark' },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, theme: 'light', mobile: true },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, theme: 'dark', mobile: true },
];
let failed = 0;
const check = (cell, name, ok, detail = '') => { if (!ok) failed++; console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${cell} ${name}${detail ? ` · ${String(detail).slice(0, 240)}` : ''}`); return ok; };

let axeSource = null;
async function runAxe(page) {
  try {
    if (axeSource === null) {
      if (process.env.AXE_PATH) axeSource = await fsp.readFile(process.env.AXE_PATH, 'utf8').catch(() => '');
      else { try { const r = await fetch(AXE_URL, { signal: AbortSignal.timeout(8000) }); axeSource = r.ok ? await r.text() : ''; } catch { axeSource = ''; } }
    }
    if (!axeSource) return { skipped: true };
    await page.addScriptTag({ content: axeSource });
    return { violations: await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))) };
  } catch (e) { return { skipped: true, error: e.message }; }
}

/** A business's existing homepage on its own origin, with CSS that would wreck anything it could reach. */
function homepageHtml(snippet) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen Bikes · Bikes for trails and towns</title>
<style>
  * { font-family: "Comic Sans MS", cursive !important; letter-spacing: 3px !important; box-sizing: content-box !important; }
  body { margin: 0; color: #222; background: #fffaf0; }
  button { background: lime !important; padding: 40px !important; border: 6px dotted red !important; }
  input { border: 5px dashed red !important; font-size: 9px !important; }
  h1 { font-size: 40px; color: #b91c1c; }
  a { color: #0f766e; }
  knowbot-overlay, knowbot-overlay * { opacity: .1 !important; transform: scale(.5) !important; display: none !important; }
  .site-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; background: #0f766e; color: #fff; }
  .site-head a { color: #fff; margin-left: 16px; }
  .hero { padding: 64px 24px; background: linear-gradient(120deg, #0f766e, #14b8a6); color: #fff; }
  .hero h1 { color: #fff; margin: 0 0 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; padding: 24px; }
  .card { background: #fff; border-radius: 12px; padding: 16px; min-height: 120px; box-shadow: 0 2px 8px rgb(0 0 0 / .08); }
</style>
<script>window.__kbBefore = Object.keys(window);</script>
</head><body>
<header class="site-head"><strong>Lumen Bikes</strong><nav><a href="#shop">Shop</a><a href="#help">Help</a><a href="#cart">Cart</a></nav></header>
<main><section class="hero"><h1 id="page-h1">Ride further.</h1><p>Bikes for trails and towns, built to last.</p><button id="page-btn" type="button">Shop bikes</button></section>
<section class="cards"><div class="card">Trail Pro</div><div class="card">Commuter Lite</div><div class="card">E-City 500</div><div class="card">Kids 20</div></section></main>
<footer style="padding:24px">© Lumen Bikes</footer>
${snippet}
</body></html>`;
}

const dev = await startDevServer({ speed: 4 });
const api = (p, init = {}) => fetch(`${dev.url}${p}`, init);
let homeSrv = null;
try {
  // ------------------------------------------------------------------ a bot with a published site
  const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
  const H = (x = {}) => ({ authorization: `Bearer ${t.token}`, ...x });
  await api(`/api/studio/trials/${t.trialId}/samples`, { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ set: 'lumen-bikes' }) });
  await api(`/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: H({ 'x-filename': 'contact.md', 'content-type': 'application/octet-stream' }), body: CONTACT });
  await api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ name: 'Lumen Bikes Help', purpose: 'Answers about Lumen bikes, warranty, service plans and returns.' }) });
  for (let i = 0; i < 240; i++) {
    const j = await (await api(`/api/studio/trials/${t.trialId}`, { headers: H() })).json();
    if (j.files.length >= 5 && j.files.every((f) => f.stage === 'ready')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const siteApi = (method = 'GET', body) => api(`/api/studio/trials/${t.trialId}/site`, { method, headers: H(body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const built = await siteApi();
  check('setup', 'site built', built.site && built.site.name === 'Lumen Bikes', JSON.stringify({ name: built.site?.name, chips: built.site?.chips?.length }));
  check('setup', 'defaults: until dismissed, no topic chips', built.site.showOn === 'until-dismissed' && built.site.showChips === false);
  check('setup', 'the homepage line', new RegExp(`^<script src="${dev.url}/site/overlay\\.js" data-bot="${t.trialId}" data-api="${dev.url}" async></script>$`).test(built.snippet), built.snippet);
  const pub = await siteApi('POST', { published: true });
  check('setup', 'published', pub.published === true);
  const q = built.site.questions[0];

  // the business's existing homepage, on its own origin, with the line pasted in
  const snippet = built.snippet;
  homeSrv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(homepageHtml(snippet)); });
  await new Promise((r) => homeSrv.listen(0, '127.0.0.1', r));
  const homeUrl = `http://127.0.0.1:${homeSrv.address().port}/`;

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  const inShadow = (page, fn, arg) => page.evaluate(([src, a]) => { const sr = document.querySelector('knowbot-overlay')?.shadowRoot; return sr ? (0, eval)(`(${src})`)(sr, a) : null; }, [fn.toString(), arg]);
  const activeInDialog = (page) => inShadow(page, (sr) => document.activeElement === sr.host && !!sr.activeElement && !!sr.activeElement.closest('.dialog'));
  const activeId = (page) => inShadow(page, (sr) => (document.activeElement === sr.host ? (sr.activeElement?.id || sr.activeElement?.className || '') : `page:${document.activeElement?.tagName}`));

  // ------------------------------------------------------------------ the snippet on an existing homepage
  for (const cell of CELLS) {
    const ctx = await browser.newContext({ viewport: cell.viewport, isMobile: !!cell.mobile, hasTouch: !!cell.mobile, colorScheme: cell.theme, deviceScaleFactor: cell.mobile ? 2 : 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(homeUrl, { waitUntil: 'load' });
    await page.locator('knowbot-overlay .dialog').waitFor({ state: 'visible', timeout: 15000 });
    const dlg = page.locator('knowbot-overlay .dialog');
    check(cell.name, 'overlay opens over the page: dialog, aria-modal, labelled', (await dlg.getAttribute('role')) === 'dialog' && (await dlg.getAttribute('aria-modal')) === 'true' && (await dlg.getAttribute('aria-labelledby')) === 'kb-h');
    check(cell.name, 'the existing homepage is still there, under a see-through scrim', await page.isVisible('#page-h1') && /blur/.test(await inShadow(page, (sr) => getComputedStyle(sr.querySelector('.scrim')).backdropFilter || getComputedStyle(sr.querySelector('.scrim')).webkitBackdropFilter)));
    check(cell.name, 'simple start: hand, the sample shop’s logo (named Lumen Bikes), one search box, one button, one quiet line', (await page.locator('knowbot-overlay .hand').textContent()) === '👋'
      && (await headName(page.locator('knowbot-overlay #kb-h'))) === 'Lumen Bikes' && (await page.locator('knowbot-overlay input').count()) === 1
      && (await page.locator('knowbot-overlay .go').textContent()) === 'Ask' && /Answers come only from Lumen Bikes's own pages/.test(await page.locator('knowbot-overlay .quiet').textContent()));
    check(cell.name, 'no chips, popular questions or facts on the start screen', (await page.locator('knowbot-overlay .chip').count()) === 0 && !(await page.locator('knowbot-overlay .dialog').textContent()).includes('(555) 123-4567'));
    check(cell.name, 'the hand waves on arrival', await inShadow(page, (sr) => sr.querySelector('.hand').classList.contains('waving') && getComputedStyle(sr.querySelector('.hand')).animationName === 'kb-wave'));
    check(cell.name, 'focus starts in the search box', (await activeId(page)) === 'kb-q');
    check(cell.name, 'dark theme follows the system', (await inShadow(page, (sr) => sr.querySelector('.kb').classList.contains('dark'))) === (cell.theme === 'dark'));
    check(cell.name, 'page behind does not scroll while open', await page.evaluate(() => document.documentElement.style.overflow === 'hidden'));
    // the page's CSS can't reach it (Shadow DOM + a host that resets everything)
    const st = await inShadow(page, (sr) => { const go = getComputedStyle(sr.querySelector('.go')); const qi = getComputedStyle(sr.querySelector('.q')); const nm = getComputedStyle(sr.querySelector('.name'));
      return { goBg: go.backgroundColor, goPad: go.paddingTop, qBorder: qi.borderTopStyle, qSize: qi.fontSize, font: nm.fontFamily, ls: nm.letterSpacing, hostOpacity: getComputedStyle(sr.host).opacity, hostDisplay: getComputedStyle(sr.host).display, hostTransform: getComputedStyle(sr.host).transform }; });
    check(cell.name, 'the page’s CSS can’t restyle it', st.goBg !== 'rgb(0, 255, 0)' && st.goPad !== '40px' && st.qBorder !== 'dashed' && st.qSize === '18px' && !/comic/i.test(st.font) && st.ls !== '3px'
      && st.hostOpacity === '1' && st.hostDisplay === 'block' && st.hostTransform === 'none', JSON.stringify(st));
    const leak = await page.evaluate(() => ({ h1: getComputedStyle(document.getElementById('page-h1')).fontSize, btn: getComputedStyle(document.getElementById('page-btn')).backgroundColor, globals: Object.keys(window).filter((k) => !window.__kbBefore.includes(k) && k !== '__kbBefore') }));
    check(cell.name, 'and it can’t restyle the page; no globals', leak.h1 === '40px' && leak.btn === 'rgb(0, 255, 0)' && !leak.globals.length, JSON.stringify(leak));
    // focus trap
    let trapped = true;
    for (let i = 0; i < 8; i++) { await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab'); if (!(await activeInDialog(page))) trapped = false; }
    check(cell.name, 'focus stays inside while open (Tab, Shift+Tab)', trapped);
    if (cell.name === 'desktop-light' || cell.name === 'phone-dark') await page.screenshot({ path: path.join(SHOTS, `overlay-${cell.name}.png`) });
    // ask a question (typed, like a visitor)
    await page.locator('knowbot-overlay #kb-q').fill(q);
    await page.locator('knowbot-overlay .go').click();
    await page.locator('knowbot-overlay .turn:not([aria-busy]) .sources li, knowbot-overlay .turn:not([aria-busy]) .refusal').first().waitFor({ timeout: 30000 });
    const quotes = await page.locator('knowbot-overlay .turn .quote').count();
    const links = await page.locator('knowbot-overlay .src-link').evaluateAll((as) => as.map((a) => a.href));
    check(cell.name, 'answer quotes in blocks with [n] marks', quotes >= 1 && (await page.locator('knowbot-overlay .turn .n').count()) >= 1, `${quotes} quotes`);
    check(cell.name, 'Sources list links (page or proof page), new tab', links.length >= 1 && links.every((x) => /^https?:\/\//.test(x)) && (await page.locator('knowbot-overlay .src-link').first().getAttribute('target')) === '_blank', links.join(' '));
    check(cell.name, 'status announced (aria-live)', /Answer ready/.test(await page.locator('knowbot-overlay [role="status"]').textContent()));
    const before = page.url();
    await page.locator('knowbot-overlay .turn .n').first().click();
    check(cell.name, 'a [n] mark jumps to its source, the page URL untouched', page.url() === before && (await inShadow(page, (sr) => !!sr.querySelector('.src.hit'))));
    check(cell.name, 'a quiet “Ask another”', await page.locator('knowbot-overlay .again').isVisible());
    if (cell.name !== 'phone-light') await page.screenshot({ path: path.join(SHOTS, `answer-${cell.name}.png`) });
    // not in the files: the refusal sentence
    await page.locator('knowbot-overlay .again').click();
    check(cell.name, '“Ask another” clears the answer and focuses the box', (await page.locator('knowbot-overlay .turn').count()) === 0 && (await activeId(page)) === 'kb-q');
    await page.locator('knowbot-overlay #kb-q').fill('What is the capital of Australia?');
    await page.keyboard.press('Enter');
    await page.locator('knowbot-overlay .turn:not([aria-busy])').waitFor({ timeout: 30000 });
    check(cell.name, 'refusal sentence when not in the files', (await page.locator('knowbot-overlay .turn .ab').textContent()).includes(NOT_IN_DATA));
    // layout and accessibility
    check(cell.name, 'no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const wide = await inShadow(page, (sr) => [...sr.querySelectorAll('.panel, .box, .answer, .quote, .sources')].map((e) => Math.round(e.getBoundingClientRect().right)).filter((r) => r > window.innerWidth));
    check(cell.name, 'nothing wider than the screen', !wide.length, JSON.stringify(wide));
    const small = await inShadow(page, (sr) => [...sr.querySelectorAll('button, input, .built')].filter((e) => e.getClientRects().length).map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim().slice(0, 30) || e.className, h: Math.round(r.height), w: Math.round(r.width) }; }).filter((x) => x.h < 44 || x.w < 44));
    check(cell.name, '44px targets', !small.length, JSON.stringify(small));
    const axe = await runAxe(page);
    if (axe.skipped) console.log(`  [warn] ${cell.name} axe skipped (axe-core unreachable)`);
    else check(cell.name, 'axe (open): no serious or critical violations', !axe.violations.length, JSON.stringify(axe.violations));
    // Esc closes and shows the page; the button in the corner opens it again; × closes it; focus comes back
    await page.keyboard.press('Escape');
    check(cell.name, 'Esc closes it: the page shows, the “Ask Lumen Bikes” button waits in the corner', await page.locator('knowbot-overlay .dialog').isHidden() && await page.locator('knowbot-overlay .pill').isVisible()
      && /Ask Lumen Bikes/.test(await page.locator('knowbot-overlay .pill').textContent()) && await page.evaluate(() => document.documentElement.style.overflow === ''));
    check(cell.name, 'focus goes to the button that opens it again', (await activeId(page)) === 'pill');
    const pb = await page.locator('knowbot-overlay .pill').boundingBox();
    check(cell.name, 'the button sits bottom-right, 44px tall', pb && pb.x + pb.width > cell.viewport.width - 40 && pb.y + pb.height > cell.viewport.height - 40 && pb.height >= 44, JSON.stringify(pb));
    await page.keyboard.press('Enter');
    check(cell.name, 'the button opens it again, focus in the box', await page.locator('knowbot-overlay .dialog').isVisible() && (await activeId(page)) === 'kb-q');
    await page.locator('knowbot-overlay .x').click();
    check(cell.name, '× (labelled Close) closes it and returns focus', (await page.locator('knowbot-overlay .x').getAttribute('aria-label')) === 'Close' && await page.locator('knowbot-overlay .dialog').isHidden() && (await activeId(page)) === 'pill');
    check(cell.name, 'the page works again once closed', await page.evaluate(() => { const r = document.getElementById('page-btn').getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el?.id === 'page-btn'; }));
    if (cell.name === 'desktop-light' || cell.name === 'phone-dark') await page.screenshot({ path: path.join(SHOTS, `closed-${cell.name}.png`) });
    const axe2 = await runAxe(page);
    if (!axe2.skipped) check(cell.name, 'axe (closed): no serious or critical violations', !axe2.violations.length, JSON.stringify(axe2.violations));
    await page.reload({ waitUntil: 'load' });
    await page.locator('knowbot-overlay .pill').waitFor({ state: 'visible', timeout: 15000 });
    check(cell.name, 'until dismissed: once closed, it stays closed on the next visit', await page.locator('knowbot-overlay .dialog').isHidden());
    check(cell.name, 'no console errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------------ owner options: every visit, topic chips
  {
    await siteApi('POST', { showOn: 'every-visit', showChips: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(homeUrl, { waitUntil: 'load' });
    await page.locator('knowbot-overlay .dialog').waitFor({ state: 'visible', timeout: 15000 });
    check('options', 'topic chips when the owner turns them on', (await page.locator('knowbot-overlay .chip').count()) >= 1);
    await page.locator('knowbot-overlay .x').click();
    await page.reload({ waitUntil: 'load' });
    await page.locator('knowbot-overlay .dialog').waitFor({ state: 'visible', timeout: 15000 });
    check('options', 'every visit: it opens again on the next page view', await page.locator('knowbot-overlay .dialog').isVisible());
    await ctx.close();
    await siteApi('POST', { showOn: 'until-dismissed', showChips: false });
  }

  // ------------------------------------------------------------------ the hosted link
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.url}/site/?bot=${t.trialId}`, { waitUntil: 'load' });
    await page.locator('knowbot-overlay .dialog').waitFor({ state: 'visible', timeout: 15000 });
    check('hosted', 'the overlay over a neutral stand-in page', await page.locator('.kh-page').count() === 1 && /Lumen Bikes/.test(await page.title()));
    check('hosted', 'noindex while a trial', (await page.getAttribute('meta[name="robots"]', 'content')) === 'noindex');
    check('hosted', 'the page behind is inert while open', await page.evaluate(() => document.querySelector('.kh-page').inert === true));
    await page.locator('knowbot-overlay .x').click();
    check('hosted', '× shows the page and the button', await page.locator('knowbot-overlay .pill').isVisible() && await page.evaluate(() => document.querySelector('.kh-page').inert === false));
    check('hosted', 'no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const axe = await runAxe(page);
    if (!axe.skipped) check('hosted', 'axe: no serious or critical violations', !axe.violations.length, JSON.stringify(axe.violations));
    check('hosted', 'no console errors', !errors.length, errors.join(' | '));
    await page.goto(`${dev.url}/site/?bot=${t.trialId}&q=${encodeURIComponent(q)}`, { waitUntil: 'load' });
    await page.locator('knowbot-overlay .turn:not([aria-busy])').waitFor({ timeout: 30000 });
    check('hosted', 'a ?q= link asks at once', (await page.locator('knowbot-overlay .aq').textContent()) === q);
    await page.goto(`${dev.url}/site/?bot=tr_aaaaaaaaaaaaaaaa`, { waitUntil: 'load' });
    await page.locator('knowbot-overlay #kb-h').waitFor({ timeout: 15000 });
    check('hosted', 'an unknown bot: not available', /not available/i.test(await page.locator('knowbot-overlay #kb-h').textContent()));
    await ctx.close();
  }

  // ------------------------------------------------------------------ a website import: over the store's own homepage
  {
    const s = await (await api('/api/studio/trials', { method: 'POST' })).json();
    const SH = (x = {}) => ({ authorization: `Bearer ${s.token}`, ...x });
    await (await api(`/api/studio/trials/${s.trialId}/store`, { method: 'POST', headers: SH({ 'content-type': 'application/json' }), body: JSON.stringify({ url: dev.shopUrl, owner: true }) })).text();
    for (let i = 0; i < 240; i++) {
      const j = await (await api(`/api/studio/trials/${s.trialId}`, { headers: SH() })).json();
      if (j.files.length && j.files.every((f) => f.stage === 'ready')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const v = await (await api(`/api/studio/trials/${s.trialId}/site`, { method: 'POST', headers: SH({ 'content-type': 'application/json' }), body: JSON.stringify({ published: true, regenerate: true }) })).json();
    check('store', 'site named after the store, in its colour; its homepage can be framed', v.site.name === 'Lumen Bikes' && v.site.brand.color === '#0f766e' && v.site.homeFrame === dev.shopUrl, JSON.stringify({ name: v.site.name, brand: v.site.brand, homeFrame: v.site.homeFrame }));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    const errors = [];
    // the fake store's own homepage script (in the frame behind) throws on its own; only the overlay's errors count
    page.on('pageerror', (e) => { if (!/Shopify is not defined/.test(e.message)) errors.push(e.message); });
    await page.goto(`${dev.url}/site/?bot=${s.trialId}&q=${encodeURIComponent('Can I return a bike I rode?')}`, { waitUntil: 'load' });
    check('store', 'the hosted link shows the store’s own homepage behind', (await page.locator('iframe.kh-home').getAttribute('src')) === dev.shopUrl);
    await page.locator('knowbot-overlay .turn:not([aria-busy]) .sources li, knowbot-overlay .turn:not([aria-busy]) .refusal').first().waitFor({ timeout: 30000 });
    const links = await page.locator('knowbot-overlay .src-link').evaluateAll((as) => as.map((a) => a.href));
    check('store', 'Sources open the store’s own page', links.length >= 1 && links.some((x) => x.startsWith(dev.shopUrl)), links.join(' '));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'store-over-homepage-answer.png') });
    check('store', 'no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------------ the Studio
  {
    await api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ surfaces: ['webchat', 'site'] }) });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.studioUrl}?t=${t.trialId}&k=${encodeURIComponent(t.restoreKey)}`, { waitUntil: 'load' });
    await page.waitForSelector('.sh-tool[data-tool="website"]', { timeout: 30000 });
    check('studio', 'See it as offers Site, marked as one of the bot’s surfaces', await page.$eval('.sh-view[data-shape="site"]', (b) => b.classList.contains('is-mine')));
    await page.click('.sh-tool[data-tool="website"]'); await page.click('.sh-view[data-shape="site"]');
    await page.waitForSelector('.sh-site-frame', { timeout: 20000 });
    const frame = page.frameLocator('.sh-site-frame');
    await frame.locator('knowbot-overlay #kb-h').waitFor({ timeout: 20000 });
    check('studio', 'the bot pane shows the overlay over a homepage', (await headName(frame.locator('knowbot-overlay #kb-h'))) === 'Lumen Bikes' && await frame.locator('.kh-page').count() === 1);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'studio-see-it-as-site.png') });
    await frame.locator('knowbot-overlay .x').click();
    check('studio', '× in the preview shows the homepage and the reopen button', await frame.locator('knowbot-overlay .pill').isVisible());
    await page.screenshot({ path: path.join(SHOTS, 'studio-see-it-as-site-closed.png') });
    // Set up → the card
    await page.click('.sh-tool[data-tool="website"]'); await page.click('.sh-view[data-shape="webchat"]');
    await page.evaluate(() => { const b = document.querySelector('.st-seg-setup'); if (b) { b.hidden = false; b.click(); } });
    await page.waitForSelector('.gl-feat-open[data-ch="site"]', { timeout: 20000 });
    check('studio', 'Set up: the Website tool card has Homepage search switched on (one of the bot’s features)', await page.$eval('.gl-tool[data-tool="website"] .gl-feat[data-surface="site"] input[role="switch"]', (i) => i.checked));
    await page.click('.gl-feat-open[data-ch="site"]');
    await page.waitForSelector('.gl-sp-pub', { timeout: 20000 });
    // the Website tool: ONE embed line that follows the switches; switching Voice on saves spec.surfaces, never a price
    const webLine = () => page.textContent('#gl-webline pre');
    check('studio', 'Website: one embed line with chat and homepage search on, voice off', /lib\/embed\.js/.test(await webLine()) && /data-chat="on"/.test(await webLine())
      && /data-homepage="on"/.test(await webLine()) && /data-voice="off"/.test(await webLine()));
    await page.click('.gl-tool[data-tool="website"] .gl-feat[data-surface="webvoice"] .gl-switch');
    await page.waitForFunction(() => /data-voice="on"/.test(document.querySelector('#gl-webline pre')?.textContent || ''), null, { timeout: 10000 });
    let saved0 = null;
    for (let i = 0; i < 30; i++) { saved0 = (await (await api(`/api/studio/trials/${t.trialId}`, { headers: H() })).json()).spec?.surfaces; if (saved0?.includes('webvoice')) break; await page.waitForTimeout(200); }
    check('studio', 'Website: switching Voice on saves it and the line follows', JSON.stringify(saved0) === JSON.stringify(['webchat', 'webvoice', 'site']), JSON.stringify(saved0));
    await page.screenshot({ path: path.join(SHOTS, 'studio-setup-tools.png') });
    await page.click('.gl-tool[data-tool="website"] .gl-feat[data-surface="webvoice"] .gl-switch');
    await page.waitForFunction(() => /data-voice="off"/.test(document.querySelector('#gl-webline pre')?.textContent || ''), null, { timeout: 10000 });
    await page.click('.gl-ftab[data-ch="site"]');
    await page.waitForSelector('.gl-sp-pub', { timeout: 20000 });
    const card = await page.textContent('.gl-sp');
    check('studio', 'card: Add to your homepage, the one line with Copy, options, publish, hosted link, how-to', /Add to your homepage/.test(card) && /overlay\.js" data-bot="/.test(await page.textContent('.gl-sp-snip pre'))
      && await page.isVisible('.gl-sp-snip button') && await page.isVisible('.gl-sp .ss input[value="until-dismissed"]') && await page.isVisible('#gl-sp-chipson') && /Unpublish/.test(await page.textContent('.gl-sp-pub'))
      && await page.isVisible('.gl-sp-dl') && /knowbot\.knowdrive\.ai\/site\/\?bot=/.test(await page.textContent('.gl-sp-url')) && await page.isHidden('.gl-sp-chipbox'));
    const ssSaid = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.gl-sp .ss-status')?.textContent || ''), re.source, { timeout: 15000 });
    await page.fill('.gl-sp .ss input[name="kb-site-name"]', 'Lumen Bikes Co');
    await page.press('.gl-sp .ss input[name="kb-site-name"]', 'Enter');
    await ssSaid(/Name saved/);
    await page.fill('.gl-sp .ss input[name="kb-site-subline"]', 'Ask about bikes, repairs and rentals.');
    await page.press('.gl-sp .ss input[name="kb-site-subline"]', 'Enter');
    await ssSaid(/Line saved/);
    await page.check('.gl-sp .ss input[value="every-visit"]');
    await ssSaid(/every visit/);
    const saved = await siteApi();
    check('studio', 'name and “every visit” save at once', saved.site.name === 'Lumen Bikes Co' && saved.site.showOn === 'every-visit', JSON.stringify({ n: saved.site.name, s: saved.site.showOn }));
    // a logo: the sample shop's own (studio/samples/lumen-bikes/logo.png, 502x158), kept at its size
    // a square logo (200x200) stays inside the preview tile, then the real one replaces it
    const squarePng = Buffer.from((await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 200; const g = c.getContext('2d');
      g.fillStyle = '#8b1e2b'; g.beginPath(); g.moveTo(100, 4); g.lineTo(196, 196); g.lineTo(4, 196); g.fill(); return c.toDataURL('image/png'); })).split(',')[1], 'base64');
    await page.setInputFiles('.gl-sp .ss-file', { name: 'square.png', mimeType: 'image/png', buffer: squarePng });
    await ssSaid(/Logo saved \(200 × 200 px\)/);
    await page.waitForFunction(() => { const i = document.querySelector('.gl-sp .ss-logo-tile img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
    const fit = await page.$eval('.gl-sp .ss-logo-tile', (t) => { const a = t.getBoundingClientRect(), i = t.querySelector('img').getBoundingClientRect(); return { inside: i.top >= a.top - 0.5 && i.bottom <= a.bottom + 0.5 && i.left >= a.left - 0.5 && i.right <= a.right + 0.5, h: Math.round(i.height) }; });
    check('studio', 'a square logo stays inside its preview tile', fit.inside && fit.h >= 40, JSON.stringify(fit));
    const logoPng = await fsp.readFile(path.join(__dirname, '..', 'samples', 'lumen-bikes', 'logo.png'));
    await page.setInputFiles('.gl-sp .ss-file', { name: 'lumen-logo.png', mimeType: 'image/png', buffer: logoPng });
    await ssSaid(/Logo saved \(502 × 158 px\)/);
    const withLogo = await siteApi();
    check('studio', 'logo upload: saved at its size, served', !!withLogo.site.logo?.path && (await api(withLogo.site.logo.path)).status === 200 && await page.isVisible('.gl-sp .ss-logo-tile img') && /Replace logo/.test(await page.textContent('.gl-sp .ss-logo-act')));
    await page.locator('.gl-sp-frame').scrollIntoViewIfNeeded();   // the preview frame loads lazily
    const pf = page.frameLocator('.gl-sp-frame iframe');
    await pf.locator('knowbot-overlay .brandlogo').waitFor({ timeout: 20000 });
    check('studio', 'the preview shows the owner’s line under the search box', /Ask about bikes, repairs and rentals\./.test(await pf.locator('knowbot-overlay .quiet').textContent()));
    check('studio', 'the preview shows the logo under the wave, named for screen readers', (await pf.locator('knowbot-overlay #kb-h .brandlogo').getAttribute('alt')) === 'Lumen Bikes Co' && (await pf.locator('knowbot-overlay #kb-h').textContent()).trim() === '');
    await page.waitForTimeout(400);
    await page.locator('.gl-sp-frame').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 'studio-site-logo-preview.png') });
    await page.locator('.gl-sp .ss').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 'studio-site-settings.png') });
    await page.locator('.gl-sp').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 'studio-setup-site.png') });
    // the bot spec drawer: the same name, logo and timing, while the Homepage search is one of the bot's surfaces
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#st-botchip')?.click());
    await page.waitForSelector('#st-spec-site .ss', { timeout: 20000 });
    await page.locator('#st-spec-site').scrollIntoViewIfNeeded();
    check('spec', 'bot spec: Homepage search block with the saved name, logo and timing', await page.isVisible('#st-spec-site .ss-logo-tile img')
      && (await page.inputValue('#st-spec-site input[name="kb-site-name"]')) === 'Lumen Bikes Co' && await page.isChecked('#st-spec-site input[value="every-visit"]'));
    await page.screenshot({ path: path.join(SHOTS, 'spec-site.png') });
    await page.check('#st-spec-site input[value="until-dismissed"]');
    await page.waitForFunction(() => /until the visitor closes it/.test(document.querySelector('#st-spec-site .ss-status')?.textContent || ''), null, { timeout: 15000 });
    await page.click('#st-spec-site .ss-rm');
    await page.waitForFunction(() => /Logo removed/.test(document.querySelector('#st-spec-site .ss-status')?.textContent || ''), null, { timeout: 15000 });
    const fromSpec = await siteApi();
    check('spec', 'changes in the bot spec save to the same settings', fromSpec.site.showOn === 'until-dismissed' && fromSpec.site.logo === null, JSON.stringify({ s: fromSpec.site.showOn, l: fromSpec.site.logo }));
    await page.click('label[for="st-surf-site"]');
    await page.waitForTimeout(300);
    // without the Homepage search (web chat still on), only voice mode's orb colour stays: it applies to web chat too
    await page.waitForSelector('#st-spec-site .ss-orbs', { timeout: 15000 });
    check('spec', 'without the Homepage search, the block is only “Voice mode” (the orb colour for web chat)', await page.isHidden('#st-spec-site input[name="kb-site-name"]').catch(() => true)
      && (await page.locator('#st-spec-site input[name="kb-site-name"]').count()) === 0 && /Voice mode/.test(await page.textContent('#st-spec-site .st-label')) && (await page.locator('#st-spec-site .ss-orb-in').count()) === 7);
    await page.click('label[for="st-surf-site"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await siteApi('POST', { published: false });
    check('studio', 'unpublish takes it down', (await api(`/api/site/${t.trialId}`)).status === 404);
    check('studio', 'no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }
  // unpublished: the snippet on a homepage shows nothing and breaks nothing
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(homeUrl, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    check('unpublished', 'nothing shows on the homepage, no script errors', (await page.locator('knowbot-overlay').count()) === 0 && !errors.length && await page.isVisible('#page-h1'), errors.join(' | '));
    await ctx.close();
  }
  await browser.close();
} finally {
  if (homeSrv) await new Promise((r) => homeSrv.close(() => r()));
  await dev.close();
}
console.log(failed ? `\nsite smoke: ${failed} failed` : '\nsite smoke: all checks passed');
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Single-page site smoke (site/ + server/site.mjs) against studio/test/dev-server.mjs (fake knowDrive + fake model on
// 127.0.0.1). Builds a trial bot from the sample files plus a contact page, publishes its site, then opens the real page
// in four cells (desktop / phone × light / dark): asks a popular question, sees the quote blocks and the Sources links,
// asks something that is not in the files (the refusal sentence), and checks no console errors, no horizontal scroll,
// 44px targets and axe (serious/critical; skipped when axe-core is unreachable, or AXE_PATH=/path/to/axe.min.js).
//
//   node studio/test/site-smoke.mjs                 # screenshots to studio/test/screens/site/ (not committed)
//   SITE_SHOTS=/some/dir node studio/test/site-smoke.mjs
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SITE_SHOTS || path.join(__dirname, 'screens', 'site');
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';
const NOT_IN_DATA = "I can't seem to find an answer to that in any of my current data sources.";
const CONTACT = '# Contact us\n\nCall us on (555) 123-4567 for help with an order.\n\nEmail help@lumen.example and we reply within one business day.\n\nThe shop is open Monday to Friday, 9am to 5pm.\n';
const CELLS = [
  { name: 'desktop-light', viewport: { width: 1280, height: 900 }, theme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1280, height: 900 }, theme: 'dark' },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, theme: 'light', mobile: true },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, theme: 'dark', mobile: true },
];
let failed = 0;
const check = (cell, name, ok, detail = '') => { if (!ok) failed++; console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${cell} ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`); return ok; };

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

const dev = await startDevServer({ speed: 4 });
const api = (p, init = {}) => fetch(`${dev.url}${p}`, init);
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
  const built = await (await api(`/api/studio/trials/${t.trialId}/site`, { headers: H() })).json();
  check('setup', 'site built', built.site && built.site.name === 'Lumen Bikes', JSON.stringify({ name: built.site?.name, chips: built.site?.chips?.length, q: built.site?.questions?.length, facts: built.site?.facts?.length }));
  check('setup', 'chips and popular questions', built.site.chips.length >= 1 && built.site.questions.length >= 1);
  const pub = await (await api(`/api/studio/trials/${t.trialId}/site`, { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ published: true }) })).json();
  check('setup', 'published', pub.published === true);
  const q = built.site.questions[0];

  // ------------------------------------------------------------------ the page
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  for (const cell of CELLS) {
    const ctx = await browser.newContext({ viewport: cell.viewport, isMobile: !!cell.mobile, hasTouch: !!cell.mobile, colorScheme: cell.theme, deviceScaleFactor: cell.mobile ? 2 : 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.url}/site/?bot=${t.trialId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#ks-h1', { timeout: 15000 });
    check(cell.name, 'hero: the business name and the search box', (await page.textContent('#ks-h1')) === 'Lumen Bikes' && await page.isVisible('label[for="ks-q"]'));
    check(cell.name, 'title + description from the site', /Lumen Bikes/.test(await page.title()) && /Lumen bikes/i.test(await page.getAttribute('meta[name="description"]', 'content')));
    check(cell.name, 'noindex while a trial', (await page.getAttribute('meta[name="robots"]', 'content')) === 'noindex');
    check(cell.name, 'dark theme follows the system', (await page.evaluate(() => document.documentElement.classList.contains('dark'))) === (cell.theme === 'dark'));
    check(cell.name, 'topic chips', (await page.locator('.ks-chip').count()) >= 1);
    check(cell.name, 'key facts quoted with their source', (await page.locator('.ks-fact').count()) >= 1 && /\(555\) 123-4567/.test(await page.textContent('.ks-facts')));
    if (cell.name === 'desktop-light' || cell.name === 'phone-dark') await page.screenshot({ path: path.join(SHOTS, `${cell.name}-home.png`), fullPage: false });
    // ask a popular question (typed, like a visitor)
    await page.fill('#ks-q', q);
    await page.click('.ks-go');
    await page.waitForSelector('.ks-turn:not([aria-busy]) .ks-sources li, .ks-turn:not([aria-busy]) .ks-refusal', { timeout: 30000 });
    const quotes = await page.locator('.ks-turn .ks-quote').count();
    const links = await page.$$eval('.ks-src-link', (as) => as.map((a) => a.href));
    check(cell.name, 'answer quotes in blocks with [n] marks', quotes >= 1 && (await page.locator('.ks-turn .ks-n').count()) >= 1, `${quotes} quotes`);
    check(cell.name, 'Sources list links (page or proof page)', links.length >= 1 && links.every((h) => /^https?:\/\//.test(h)), links.join(' '));
    check(cell.name, 'shareable ?q=', new URL(page.url()).searchParams.get('q') === q);
    check(cell.name, 'status announced (aria-live)', /Answer ready/.test(await page.textContent('#ks-status')));
    check(cell.name, 'follow-up box', await page.isVisible('.ks-follow input'));
    if (cell.name !== 'phone-light') await page.screenshot({ path: path.join(SHOTS, `${cell.name}-answer.png`), fullPage: false });
    // not in the files: the refusal sentence
    await page.fill('.ks-follow input', 'What is the capital of Australia?');
    await page.click('.ks-follow .ks-go');
    await page.waitForFunction(() => document.querySelectorAll('.ks-turn').length === 2 && !document.querySelector('.ks-turn[aria-busy]'), null, { timeout: 30000 });
    check(cell.name, 'refusal sentence when not in the files', (await page.textContent('.ks-turn:last-of-type .ks-a')).includes(NOT_IN_DATA));
    // layout and accessibility
    check(cell.name, 'no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const wide = await page.$$eval('.ks-turn, .ks-card, .ks-search, .ks-follow, .ks-chips', (els) => els.map((e) => Math.round(e.getBoundingClientRect().right)).filter((r) => r > window.innerWidth));
    check(cell.name, 'nothing wider than the screen', !wide.length, JSON.stringify(wide));
    const small = await page.$$eval('button, .ks-qlink, .ks-home, .ks-built a, input', (els) => els.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim().slice(0, 30) || e.id, h: Math.round(r.height) }; }).filter((x) => x.h < 44));
    check(cell.name, '44px targets', !small.length, JSON.stringify(small));
    const axe = await runAxe(page);
    if (axe.skipped) console.log(`  [warn] ${cell.name} axe skipped (axe-core unreachable)`);
    else check(cell.name, 'axe: no serious or critical violations', !axe.violations.length, JSON.stringify(axe.violations));
    check(cell.name, 'no console errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }
  // a site that is not published (or no bot): a calm "not available" page, no errors
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${dev.url}/site/?bot=tr_aaaaaaaaaaaaaaaa`, { waitUntil: 'load' });
    await page.waitForSelector('.ks-empty h1', { timeout: 15000 });
    check('missing', 'not available page', /not available/i.test(await page.textContent('h1')));
    await ctx.close();
  }
  // a website import: the site takes the store's name and colour, and a Sources link opens the store's own page
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
    const pageLinks = Object.values(v.site.links.byId || {});
    check('store', 'site named after the store, in its colour', v.site.name === 'Lumen Bikes' && v.site.brand.color === '#0f766e' && v.site.brand.fromSite === true, JSON.stringify({ name: v.site.name, brand: v.site.brand }));
    check('store', 'every imported page has its own link', pageLinks.length >= 2 && pageLinks.every((u) => u.startsWith(dev.shopUrl)), pageLinks.join(' '));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.url}/site/?bot=${s.trialId}&q=${encodeURIComponent('Can I return a bike I rode?')}`, { waitUntil: 'load' });
    await page.waitForSelector('.ks-turn:not([aria-busy]) .ks-sources li, .ks-turn:not([aria-busy]) .ks-refusal', { timeout: 30000 });
    const links = await page.$$eval('.ks-src-link', (as) => as.map((a) => a.href));
    check('store', 'a ?q= link asks at once; Sources open the store’s own page', links.length >= 1 && links.some((h) => h.startsWith(dev.shopUrl)), links.join(' '));
    check('store', 'no page errors', !errors.length, errors.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, 'store-desktop-light-answer.png') });
    await ctx.close();
  }
  // the Studio: "See it as → Site" previews the page in the bot pane; Set up → Single-page site edits and unpublishes
  {
    await api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ surfaces: ['webchat', 'site'] }) });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.studioUrl}?t=${t.trialId}&k=${encodeURIComponent(t.restoreKey)}`, { waitUntil: 'load' });
    await page.waitForSelector('.sh-opt[data-shape="site"]', { timeout: 30000 });
    check('studio', 'See it as offers Site, marked as one of the bot’s surfaces', await page.$eval('.sh-opt[data-shape="site"]', (b) => b.classList.contains('is-mine')));
    await page.click('.sh-opt[data-shape="site"]');
    await page.waitForSelector('.sh-site-frame', { timeout: 20000 });
    const frame = page.frameLocator('.sh-site-frame');
    await frame.locator('#ks-h1').waitFor({ timeout: 20000 });
    check('studio', 'the bot pane shows the real page', (await frame.locator('#ks-h1').textContent()) === 'Lumen Bikes');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, 'studio-see-it-as-site.png') });
    // Set up → the Single-page site card
    await page.click('.sh-opt[data-shape="webchat"]');
    await page.evaluate(() => { const b = document.querySelector('.st-seg-setup'); if (b) { b.hidden = false; b.click(); } });
    await page.waitForSelector('.gl-chcard[data-ch="site"]', { timeout: 20000 });
    check('studio', 'Set up lists the site first among the bot’s own surfaces', await page.$eval('.gl-chcard[data-ch="site"]', (b) => !!b.querySelector('.gl-mine')));
    await page.click('.gl-chcard[data-ch="site"]');
    await page.waitForSelector('.gl-sp-pub', { timeout: 20000 });
    check('studio', 'card: published, link, download, edits, homepage steps', /Unpublish/.test(await page.textContent('.gl-sp-pub')) && await page.isVisible('.gl-sp-dl') && await page.isVisible('#gl-sp-name')
      && /homepage/i.test(await page.textContent('.gl-steps')) && /knowbot\.knowdrive\.ai\/site\/\?bot=/.test(await page.textContent('.gl-sp-url')));
    await page.fill('#gl-sp-name', 'Lumen Bikes Co');
    await page.click('.gl-sp-actions .btn');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.gl-sp-status')?.textContent || ''), null, { timeout: 15000 });
    const saved = await (await api(`/api/studio/trials/${t.trialId}/site`, { headers: H() })).json();
    check('studio', 'a name edit is saved', saved.site.name === 'Lumen Bikes Co');
    await page.screenshot({ path: path.join(SHOTS, 'studio-setup-site.png') });
    await page.click('.gl-sp-pub');
    await page.waitForFunction(() => /Unpublished/.test(document.querySelector('.gl-sp-status')?.textContent || ''), null, { timeout: 15000 });
    check('studio', 'unpublish takes the page down', (await api(`/api/site/${t.trialId}`)).status === 404);
    check('studio', 'no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }
  await browser.close();
} finally {
  await dev.close();
}
console.log(failed ? `\nsite smoke: ${failed} failed` : '\nsite smoke: all checks passed');
process.exit(failed ? 1 : 0);

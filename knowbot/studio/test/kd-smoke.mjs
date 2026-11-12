#!/usr/bin/env node
// Launch with a KnowDrive account, end to end in a real browser (Playwright) against studio/test/dev-server.mjs (the
// fake knowDrive is also the fake authorization server; never a real service):
//
//   1. Launch opens the KnowDrive step (labelled dialog, the one-sentence promise, one primary button); Escape closes it
//      and focus returns to Launch
//   2. "Create your KnowDrive account" opens the sign-in popup; the account is created there; the popup closes; the
//      files move into the new account's own store (samples never); "Continue to checkout" opens the checkout with the
//      KnowDrive email, and the checkout link carries the account (kd_account)
//   3. popup blocked: the fallback link opens the same sign-in; cancelling in it shows the error; signing in to an
//      existing account then works
//   4. phone width: the step is a bottom sheet with no horizontal page scroll; light + dark screenshots
//
//   npm run kd:smoke                     # SHOTS=<dir> keeps the screenshots somewhere else (default: a temp dir)
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'kb-kd-shots');
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${String(detail).slice(0, 240)}` : ''}`); if (!ok) failures++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dev = await startDevServer({ speed: 8 });
const api = (p, init = {}) => fetch(dev.url + p, init);
const DOCS = { 'returns.md': '# Returns\n\nUnworn shoes can be returned within 60 days of delivery.\n', 'care.md': '# Shoe care\n\nCondition leather uppers every three months.\n' };

async function newTrial({ samples = false } = {}) {
  const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
  const H = { authorization: `Bearer ${t.token}` };
  const T = (p) => `/api/studio/trials/${t.trialId}${p}`;
  if (samples) await api(T('/samples'), { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ set: 'lumen-bikes' }) });
  for (const [n, text] of Object.entries(DOCS)) await api(T('/files'), { method: 'POST', headers: { ...H, 'x-filename': n, 'content-type': 'application/octet-stream' }, body: Buffer.from(text) });
  for (let i = 0; i < 600; i++) {
    const j = await (await api(T('/files'), { headers: H })).json();
    if (j.files.length >= 2 + (samples ? 4 : 0) && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
    await sleep(100);
  }
  return t;
}
async function studioPage(browser, t, { theme = 'light', viewport = { width: 1440, height: 1000 }, blockPopups = false } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  await context.addInitScript(({ trial, theme: th, block }) => {
    try {
      localStorage.setItem('kb-landing', 'skip');
      localStorage.setItem('knowbot-theme', th);
      localStorage.setItem('kb-studio:v1', JSON.stringify({ trial: { id: trial.trialId, token: trial.token, expiresAt: trial.expiresAt }, ui: { view: 'bot' }, milestones: { firstFile: 1, firstReady: 1, firstCited: 1 } }));
    } catch { /* ignore */ }
    if (block) window.open = () => null; // a popup blocker
  }, { trial: t, theme, block: blockPopups });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let checkoutUrl = null;
  await page.route('https://knowdrive.ai/**', (r) => { checkoutUrl = r.request().url(); return r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>checkout</h1>' }); });
  await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__studio?.mods?.checkout && !!window.__studio.store.getState().config?.kd, null, { timeout: 30000 });
  return { context, page, errors, get checkoutUrl() { return checkoutUrl; } };
}
async function openLaunch(page) {
  await page.evaluate(() => { const b = document.getElementById('st-price'); if (b && b.offsetParent) b.focus(); window.__studio.mods.checkout.open('header'); });
  await page.locator('.kda-dialog').waitFor({ timeout: 10000 });
}
async function finishInPopup(popup, { email, action = 'create', cancel = false }) {
  await popup.waitForURL(/\/-\/oauth\/authorize/, { timeout: 15000 });
  await popup.locator('#email').fill(email);
  await popup.locator(cancel ? '#kd-cancel' : action === 'create' ? '#kd-create' : '#kd-signin').click();
}

let browser;
try {
  browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  let axeSource = null;
  try { const r = await fetch(AXE_URL, { signal: AbortSignal.timeout(8000) }); if (r.ok) axeSource = await r.text(); } catch { axeSource = null; }

  console.log('1. Launch opens the KnowDrive step; Escape closes it');
  const t1 = await newTrial({ samples: true });
  const A = await studioPage(browser, t1);
  const page = A.page;
  await openLaunch(page);
  const dlg = page.locator('.kda-dialog');
  check('a labelled modal dialog', (await dlg.getAttribute('role')) === 'dialog' && (await dlg.getAttribute('aria-modal')) === 'true' && (await page.locator('#kda-title').count()) === 1);
  check('says what KnowDrive is in one sentence', /Your bot's files are stored in your own KnowDrive account, where only you control them\./.test(await page.locator('#kda-desc').textContent()));
  await page.locator('#kda-create').waitFor({ timeout: 10000 });
  check('one primary button: Create your KnowDrive account', (await page.locator('.kda-dialog .co-cta').count()) === 1 && /Create your KnowDrive account/.test(await page.locator('#kda-create').textContent()));
  check('a quiet "I already have an account" link', await page.locator('#kda-signin').isVisible());
  check('the background is inert', await page.evaluate(() => !!document.getElementById('st-app')?.inert || !!document.querySelector('[inert]')));
  const text = await dlg.textContent();
  check('no third-party names in the copy', !/google|oauth|stripe|twilio|anthropic|claude|cloudflare/i.test(text), text);
  if (axeSource) {
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => (await window.axe.run(document.querySelector('.kda-dialog'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`));
    check('axe: no WCAG A/AA violations in the step', !res.length, res.join(', '));
  } else console.log('  (axe skipped: CDN unreachable)');
  await page.screenshot({ path: path.join(SHOTS, 'kd-start-light.png') });
  // Tab stays inside
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  check('Tab stays inside the dialog', await page.evaluate(() => !!document.activeElement?.closest('.kda-dialog')));
  await page.keyboard.press('Escape');
  await page.locator('.kda-dialog').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(200);
  check('Escape closes it and focus returns to Launch', await page.evaluate(() => document.activeElement?.id === 'st-price' || !!document.activeElement?.closest?.('#st-pricewrap')), await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));

  console.log('2. create an account in the popup → files move → checkout');
  await openLaunch(page);
  await page.locator('#kda-create').waitFor();
  const [popup] = await Promise.all([A.context.waitForEvent('page'), page.locator('#kda-create').click()]);
  await page.locator('.kda-body', { hasText: /Finish signing in/ }).waitFor({ timeout: 10000 });
  check('waits for the popup', true);
  await finishInPopup(popup, { email: 'casey@example.com' });
  await popup.waitForEvent('close', { timeout: 10000 }).catch(() => {});
  check('the popup closes itself', popup.isClosed());
  await page.locator('.kda-who', { hasText: 'casey@example.com' }).first().waitFor({ timeout: 15000 });
  check('Signed in as <email>', true);
  const sawMoving = await page.locator('.kda-body', { hasText: /Moving 2 files/ }).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check('Moving N files (progress)', sawMoving || (await page.locator('#kda-continue').count()) > 0);
  if (sawMoving) await page.screenshot({ path: path.join(SHOTS, 'kd-moving-light.png') });
  await page.locator('#kda-continue').waitFor({ timeout: 30000 });
  const acct = dev.kd.auth.accounts.get('casey@example.com');
  const copies = dev.kd.auth.storeFiles(acct.store);
  check('the files are in the new account’s own store (samples never)', copies.length === 2 && copies.every((f) => Object.keys(DOCS).some((n) => f.filename.endsWith(n))), copies.map((f) => f.filename).join(', '));
  await page.screenshot({ path: path.join(SHOTS, 'kd-ready-light.png') });
  await page.locator('#kda-continue').click();
  await page.locator('#co-email').waitFor({ timeout: 10000 });
  check('Continue opens the checkout with the KnowDrive email', (await page.locator('#co-email').inputValue()) === 'casey@example.com');
  await page.locator('#co-modal-slot button', { hasText: /Continue to secure checkout/i }).first().click();
  for (let i = 0; i < 60 && !A.checkoutUrl; i++) await sleep(150);
  const cu = A.checkoutUrl ? new URL(A.checkoutUrl) : null;
  check('the checkout link carries the KnowDrive account', !!cu && cu.searchParams.get('kd_account') === acct.id && cu.searchParams.get('trial') === t1.trialId, A.checkoutUrl || 'no navigation');
  check('no page errors', !A.errors.length, A.errors.join(' | '));
  await A.context.close();

  console.log('3. popup blocked → fallback link; cancel; sign in to an existing account');
  dev.kd.auth.createAccount('dana@example.com');
  const t2 = await newTrial();
  const B = await studioPage(browser, t2, { blockPopups: true });
  await openLaunch(B.page);
  await B.page.locator('#kda-signin').click();
  await B.page.locator('#kda-fallback').waitFor({ timeout: 10000 });
  check('popup blocked: a fallback link to the same sign-in', /\/-\/oauth\/authorize\?/.test(await B.page.locator('#kda-fallback').getAttribute('href')));
  await B.page.screenshot({ path: path.join(SHOTS, 'kd-blocked-light.png') });
  let [tab] = await Promise.all([B.context.waitForEvent('page'), B.page.locator('#kda-fallback').click()]);
  await finishInPopup(tab, { email: 'dana@example.com', cancel: true });
  await B.page.locator('.kda-err').waitFor({ state: 'visible', timeout: 10000 });
  check('cancel: the step says so, with a reference', /didn.t finish/.test(await B.page.locator('.kda-err').textContent()) && /ref [0-9a-f]{8}/.test(await B.page.locator('.kda-err').textContent()));
  await tab.close().catch(() => {});
  await B.page.locator('#kda-signin').click();
  await B.page.locator('#kda-fallback').waitFor({ timeout: 10000 });
  [tab] = await Promise.all([B.context.waitForEvent('page'), B.page.locator('#kda-fallback').click()]);
  await finishInPopup(tab, { email: 'dana@example.com', action: 'signin' });
  await B.page.locator('#kda-continue').waitFor({ timeout: 30000 });
  check('an existing account signs in (no duplicate) and the files move', dev.kd.auth.storeFiles(dev.kd.auth.accounts.get('dana@example.com').store).length === 2 && [...dev.kd.auth.accounts.keys()].filter((e) => e === 'dana@example.com').length === 1);
  check('no page errors', !B.errors.length, B.errors.join(' | '));
  await B.context.close();

  console.log('4. phone width, light and dark');
  for (const theme of ['light', 'dark']) {
    const t3 = await newTrial();
    const C = await studioPage(browser, t3, { theme, viewport: { width: 390, height: 844 } });
    await openLaunch(C.page);
    await C.page.locator('#kda-create').waitFor({ timeout: 10000 });
    await C.page.waitForTimeout(700); // the sheet's entrance has settled
    const fit = await C.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth <= window.innerWidth + 1, dlg: document.querySelector('.kda-dialog').getBoundingClientRect().width <= window.innerWidth + 0.5,
      bottom: Math.abs(document.querySelector('.kda-dialog').getBoundingClientRect().bottom - window.innerHeight) < 2, tap: document.getElementById('kda-create').getBoundingClientRect().height >= 44 }));
    check(`${theme} phone: a bottom sheet, no horizontal page scroll, 44 px button`, fit.scroll && fit.dlg && fit.bottom && fit.tap, JSON.stringify(fit));
    await C.page.screenshot({ path: path.join(SHOTS, `kd-phone-${theme}.png`) });
    if (theme === 'dark') {
      const D = await studioPage(browser, t3, { theme, viewport: { width: 1440, height: 1000 } });
      await openLaunch(D.page);
      await D.page.locator('#kda-create').waitFor({ timeout: 10000 });
      await D.page.screenshot({ path: path.join(SHOTS, 'kd-start-dark.png') });
      await D.context.close();
    }
    check(`${theme} phone: no page errors`, !C.errors.length, C.errors.join(' | '));
    await C.context.close();
  }
} catch (e) {
  check('kd smoke ran to the end', false, e.stack || e.message);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed · screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);

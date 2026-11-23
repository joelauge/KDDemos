#!/usr/bin/env node
// Launch with a KnowDrive account, end to end in a real browser (Playwright) against studio/test/dev-server.mjs (the
// fake knowDrive is also the fake authorization server; never a real service):
//
//   1. Launch opens the KnowDrive step (labelled dialog, the one-sentence promise, one primary button); Escape closes it
//      and focus returns to Launch
//   2. "Create your KnowDrive account" opens the sign-in popup; the account is created there; the popup closes; the
//      owner is shown the account's one store by name and confirms it (nothing preselected, nothing written before);
//      the files move into that store (samples never); "Continue to checkout" opens the Launch sheet with
//      the KnowDrive email; "Continue to secure checkout" opens our own checkout page (the fake payments' hosted page,
//      never knowdrive.ai) for the KnowBot plan, tied to the bot and the account
//   3. popup blocked: the fallback link opens the same sign-in; cancelling in it shows the error; signing in to an
//      existing account then works
//   4. phone width: the step is a bottom sheet with no horizontal page scroll; light + dark screenshots
//   5. the plan after launch: "Manage billing" in the ⋯ menu; a failed payment warns the owner ("Update card") while the
//      bot keeps answering; a cancelled plan shows "Subscription ended" with Reactivate, the bot stops answering
//      visitors, and Reactivate opens the sheet without a second free month
//   6. a server with no payments key: Launch says checkout isn't available yet, before any account step
//   7. "Choose your store" with several stores: a store another account shared is greyed and cannot be picked (the
//      server refuses it too), a store with other files needs the tick, one KnowDrive does not confirm also needs its
//      name; by keyboard alone; axe clean; phone width, light and dark; changing the store removes the bot's own copies
//
//   npm run kd:smoke                     # SHOTS=<dir> keeps the screenshots somewhere else (default: a temp dir)
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';
import { outDir, injectAxe, settled } from './smoke-util.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = outDir('kd', process.env.SHOTS);

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${String(detail).slice(0, 240)}` : ''}`); if (!ok) failures++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dev = await startDevServer({ speed: 8, env: { KNOWBOT_BILLING_GRACE_DAYS: '0' } }); // a cancelled plan pauses the bot at once (section 5)
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

/** The store step with one store: it is shown by name, nothing is picked for the owner, and they confirm it. */
async function chooseOnlyStore(page) {
  await page.locator('#kda-use').waitFor({ timeout: 15000 });
  await page.locator('.kda-store input[type="radio"]').first().check();
  await page.locator('#kda-use:not([disabled])').click();
}

let browser;
try {
  browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });

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
  {
    // the dialog fades in: measured halfway, its text fails colour contrast, so axe runs once it has stopped moving
    await settled(page, 3000);
    const res = await injectAxe(page).then(() => page.evaluate(async () => (await window.axe.run(document.querySelector('.kda-dialog'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`)))
      .catch((e) => [`axe did not run: ${e.message}`]);
    check('axe: no WCAG A/AA violations in the step', !res.length, res.join(', '));
  }
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
  check('waits for the popup', await page.locator('.kda-body', { hasText: /Finish signing in|Finish in the KnowDrive window/ }).waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
  await finishInPopup(popup, { email: 'casey@example.com' });
  await popup.waitForEvent('close', { timeout: 10000 }).catch(() => {});
  check('the popup closes itself', popup.isClosed());
  check('Signed in as <email>', await page.locator('.kda-who', { hasText: 'casey@example.com' }).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
  // the store step: one store, still shown by name and confirmed by the owner
  await page.locator('#kda-use').waitFor({ timeout: 15000 });
  const acct = dev.kd.auth.accounts.get('casey@example.com');
  const one = await page.evaluate(() => ({ steps: [...document.querySelectorAll('.kda-steps li')].map((li) => li.textContent.trim()), current: document.querySelector('.kda-steps li[aria-current="step"]')?.textContent.trim(),
    radios: document.querySelectorAll('.kda-store input[type="radio"]').length, checked: document.querySelectorAll('.kda-store input:checked').length, name: document.querySelector('.kda-store-name')?.textContent,
    meta: document.querySelector('.kda-store-meta')?.textContent, btn: document.getElementById('kda-use').textContent.trim(), off: document.getElementById('kda-use').disabled, lead: document.getElementById('kda-store-lead')?.textContent }));
  check('the steps read: KnowDrive account, Choose your store, Move your files, Checkout', one.steps.join(' > ') === 'KnowDrive account > Choose your store > Move your files > Checkout' && one.current === 'Choose your store', JSON.stringify(one.steps));
  check('one store: shown by name, not preselected, the button waits for the pick', one.radios === 1 && one.checked === 0 && one.name === "casey@example.com's store" && one.off && one.btn === 'Choose a store', JSON.stringify(one));
  check('says where the files will live and that KnowBot only adds and removes its own', /Choose where .* files will live\. KnowBot only ever adds and removes its own files there\. It never touches yours\./.test(one.lead || '') && /Empty · Your store/.test(one.meta || ''), `${one.lead} | ${one.meta}`);
  check('nothing is written to the store before the owner chooses', dev.kd.auth.storeFiles(acct.store).length === 0 && !dev.kd.calls.some((x) => x.store === acct.store && x.method !== 'GET'));
  await page.screenshot({ path: path.join(SHOTS, 'store-one.png') });
  await page.locator('.kda-store input[type="radio"]').check();
  check('the button names the store: "Use <store name>"', (await page.locator('#kda-use').textContent()).trim() === "Use casey@example.com's store" && !(await page.locator('#kda-use').isDisabled()));
  await page.screenshot({ path: path.join(SHOTS, 'store-one-picked.png') });
  await page.locator('#kda-use').click();
  const sawMoving = await page.locator('.kda-body', { hasText: /Moving 2 files/ }).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check('Moving N files (progress)', sawMoving || (await page.locator('#kda-continue').count()) > 0);
  if (sawMoving) await page.screenshot({ path: path.join(SHOTS, 'kd-moving-light.png') });
  await page.locator('#kda-continue').waitFor({ timeout: 30000 });
  check('the chosen store is named, with a way to change it', /Store: casey@example\.com's store/.test(await page.locator('.kda-where').textContent()) && await page.locator('#kda-change').isVisible());
  const copies = dev.kd.auth.storeFiles(acct.store);
  check('the files are in the new account’s own store (samples never)', copies.length === 2 && copies.every((f) => Object.keys(DOCS).some((n) => f.filename.endsWith(n))), copies.map((f) => f.filename).join(', '));
  await page.screenshot({ path: path.join(SHOTS, 'kd-ready-light.png') });
  await page.locator('#kda-continue').click();
  await page.locator('#co-email').waitFor({ timeout: 10000 });
  check('Continue opens the checkout with the KnowDrive email', (await page.locator('#co-email').inputValue()) === 'casey@example.com');
  const sheetText = (await page.locator('#co-modal-slot').innerText()).replace(/\s+/g, ' ');
  check('the sheet: $0 today, 30 days free, then $549/month, cancel anytime, files stay in the KnowDrive account', /Today: \$0 · first 30 days free, then \$549\/month · cancel anytime\. Your files stay yours, in your KnowDrive account\./.test(sheetText), sheetText.slice(0, 300));
  check('the sheet says "secure checkout" and never names a payment processor', /You finish on our secure checkout page/.test(sheetText) && !/stripe/i.test(sheetText), sheetText.slice(0, 200));
  await page.screenshot({ path: path.join(SHOTS, 'kd-sheet-light.png') });
  await page.locator('#co-modal-slot button', { hasText: /Continue to secure checkout/i }).first().click();
  const atPay = await page.waitForURL(/\/pay\/cs_/, { timeout: 15000 }).then(() => true).catch(() => false);
  const session = atPay ? dev.payments.sessions.get(new URL(page.url()).pathname.split('/').pop()) : null;
  check('Continue opens our own checkout page, not knowdrive.ai', atPay && !A.checkoutUrl, A.checkoutUrl || page.url());
  check('the checkout is tied to the bot and its KnowDrive account', !!session && session.metadata.kd_account === acct.id && session.metadata.trial === t1.trialId && session.client_reference_id === t1.trialId, JSON.stringify(session?.metadata));
  const payText = atPay ? (await page.locator('body').innerText()).replace(/\s+/g, ' ') : '';
  check('the checkout page matches the sheet: KnowBot, $549 per month, 30 days free, $0 today, the KnowDrive email', /KnowBot/.test(payText) && /\$549 per month/.test(payText) && /30 days free/.test(payText) && /Due today \$0/.test(payText) && /casey@example\.com/.test(payText), payText.slice(0, 300));
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
  await chooseOnlyStore(B.page);
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

  console.log('5. the plan after launch: Manage billing, a failed payment, a cancelled plan, Reactivate');
  {
    const pay = dev.payments;
    const delivered = async () => { for (let i = 0; i < 100; i++) { if (pay.sent.length && pay.sent.every((x) => x.status != null)) return true; await sleep(50); } return false; };
    const s1 = [...pay.sessions.values()].find((x) => x.metadata?.trial === t1.trialId && x.metadata.kind === 'plan');
    pay.complete(s1.id);
    await delivered();
    const web = async () => (await api(`/v1/bots/${t1.trialId}/web`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How long do I have to return unworn shoes?' }) })).status;
    check('paid: the bot is live and answers visitors', (await web()) === 200);
    const E = await studioPage(browser, t1);
    await E.page.waitForFunction(() => window.__studio.store.getState().trial?.converted === true && !!window.__studio.mods.checkout.billing, null, { timeout: 20000 });
    check('a healthy plan shows no billing notice', (await E.page.locator('#co-bill-notice').count()) === 0);
    await E.page.locator('#st-more').click();
    const item = E.page.locator('[role="menuitem"]', { hasText: 'Manage billing' });
    check('the ⋯ menu has Manage billing', (await item.count()) === 1);
    await E.page.keyboard.press('Escape');
    // a failed payment: the owner is warned at once (no reload), the bot keeps answering
    pay.sent.length = 0;
    pay.failInvoice(s1.subscription);
    await E.page.locator('#co-bill-notice[data-kind="past_due"]').waitFor({ timeout: 15000 });
    const warn = (await E.page.locator('#co-bill-notice').innerText()).replace(/\s+/g, ' ');
    check('payment failed: a warning with "Update card"; the bot keeps answering', /Payment failed\./.test(warn) && /keeps answering/.test(warn) && /Update card/.test(warn) && (await web()) === 200, warn);
    await E.page.screenshot({ path: path.join(SHOTS, 'kd-billing-pastdue-light.png') });
    // the plan is cancelled: the bot is paused for visitors, the owner sees why and how to bring it back
    pay.sent.length = 0;
    pay.setSubscription(s1.subscription, { status: 'canceled' });
    await E.page.locator('#co-bill-notice[data-kind="paused"]').waitFor({ timeout: 15000 });
    const ended = (await E.page.locator('#co-bill-notice').innerText()).replace(/\s+/g, ' ');
    check('cancelled: "Subscription ended" with Reactivate; files are safe', /Subscription ended\./.test(ended) && /no longer answers visitors/.test(ended) && /files are safe in your KnowDrive account/.test(ended) && /Reactivate/.test(ended), ended);
    check('the paused bot no longer answers visitors', (await web()) === 402);
    check('the files are still in the customer’s store', dev.kd.auth.storeFiles(acct.store).length === 2);
    await E.page.screenshot({ path: path.join(SHOTS, 'kd-billing-ended-light.png') });
    {
      await settled(E.page, 3000);
      const v = await injectAxe(E.page).then(() => E.page.evaluate(async () => (await window.axe.run('#co-bill-notice', { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => x.id)))
        .catch((e) => [`axe did not run: ${e.message}`]);
      check('axe on the billing notice: 0 serious/critical', v.length === 0, v.join(', '));
    }
    await E.page.locator('#co-bill-action').click();
    await E.page.locator('#co-email').waitFor({ timeout: 10000 });
    const re = (await E.page.locator('#co-modal-slot').innerText()).replace(/\s+/g, ' ');
    check('Reactivate opens the sheet: no second free month', /Reactivate/.test(re) && /Today: \$549\/month · cancel anytime\./.test(re) && !/30 days free, then/.test(re), re.slice(0, 260));
    await E.page.locator('#co-modal-slot button', { hasText: /Continue to secure checkout/i }).first().click();
    const again = await E.page.waitForURL(/\/pay\/cs_/, { timeout: 15000 }).then(() => true).catch(() => false);
    const s2 = again ? pay.sessions.get(new URL(E.page.url()).pathname.split('/').pop()) : null;
    check('the new checkout charges at once, on the same customer', !!s2 && !s2.subscription_data?.trial_period_days && s2.customer === s1.customer, JSON.stringify(s2?.subscription_data));
    if (s2) {
      await E.page.locator('#pay').click();
      await E.page.waitForURL((u) => u.toString().startsWith(dev.url), { timeout: 15000 });
      await E.page.waitForFunction(() => window.__studio?.mods?.checkout?.billing?.status === 'active', null, { timeout: 20000 }).catch(() => {});
      check('reactivated: active again, no notice, answering visitors', (await E.page.evaluate(() => window.__studio?.mods?.checkout?.billing?.status)) === 'active' && (await E.page.locator('#co-bill-notice').count()) === 0 && (await web()) === 200);
    }
    // phone width: the notice fits
    const t5 = { ...t1 };
    // the payment fails before the phone opens the Studio: the page reads the billing state once when it loads, so
    // failing it afterwards raced that read and the notice sometimes never showed
    pay.sent.length = 0;
    await pay.failInvoice(s2 ? s2.subscription : s1.subscription);
    const P = await studioPage(browser, t5, { viewport: { width: 390, height: 844 } });
    const shown = await P.page.locator('#co-bill-notice').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    const fit = shown ? await P.page.evaluate(() => { const r = document.getElementById('co-bill-notice').getBoundingClientRect(); const b = document.getElementById('co-bill-action').getBoundingClientRect(); return { scroll: document.documentElement.scrollWidth <= innerWidth + 1, inside: r.left >= 0 && r.right <= innerWidth + 0.5, btn: b.right <= innerWidth && b.bottom <= innerHeight }; }) : null;
    check('phone: the billing notice fits, no horizontal page scroll', !!fit && fit.scroll && fit.inside && fit.btn, JSON.stringify(fit));
    if (shown) await P.page.screenshot({ path: path.join(SHOTS, 'kd-billing-phone.png') });
    check('no page errors', !E.errors.length && !P.errors.length, [...E.errors, ...P.errors].join(' | '));
    await P.context.close();
    await E.context.close();
  }

  console.log('6. no payments key on the server: Launch says checkout is not available yet');
  {
    const off = await startDevServer({ speed: 8, env: { STRIPE_SECRET_KEY: '' } });
    try {
      const r = await (await fetch(`${off.url}/api/studio/trials`, { method: 'POST' })).json();
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
      await context.addInitScript((trial) => { try { localStorage.setItem('kb-landing', 'skip'); localStorage.setItem('kb-studio:v1', JSON.stringify({ trial: { id: trial.trialId, token: trial.token, expiresAt: trial.expiresAt }, ui: { view: 'bot' }, milestones: { firstFile: 1, firstReady: 1, firstCited: 1 } })); } catch { /* ignore */ } }, r);
      const page = await context.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      let left = null;
      await page.route('https://knowdrive.ai/**', (x) => { left = x.request().url(); return x.fulfill({ status: 200, contentType: 'text/html', body: '<h1>knowdrive</h1>' }); });
      await page.goto(off.studioUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__studio?.mods?.checkout && window.__studio.store.getState().config?.checkout?.available === false, null, { timeout: 30000 });
      await page.evaluate(() => window.__studio.mods.checkout.open('header'));
      await page.locator('#co-unavail').waitFor({ timeout: 10000 });
      const txt = (await page.locator('#co-unavail').innerText()).replace(/\s+/g, ' ');
      check('the sheet says checkout is not available yet, and that the bot is saved', /Checkout isn't available yet\./.test(txt) && /is saved, and you can keep testing it/.test(txt), txt);
      check('no account step first, the button is off, nobody is sent anywhere', (await page.locator('.kda-dialog').count()) === 0 && (await page.locator('#co-modal-slot button.co-cta').first().isDisabled()) && !left, left || '');
      await page.screenshot({ path: path.join(SHOTS, 'kd-checkout-unavailable.png') });
      check('no page errors', !errors.length, errors.join(' | '));
      await context.close();
    } finally { await off.close(); }
  }

  console.log('7. Choose your store: several stores, one shared by another account, one with other files');
  {
    const A7 = dev.kd.auth;
    const me = A7.createAccount('morgan@example.com');
    A7.createAccount('agency@example.com');
    A7.setStore(me.store, { name: 'Morgan Bikes' });
    const handbook = A7.addStore('morgan@example.com', { name: 'Team handbook', files: [{ path: 'hr/leave.md', text: 'Leave policy' }, { path: 'hr/pay.md', text: 'Pay' }, { path: 'notes.txt', text: 'Notes' }] });
    const shared = A7.addStore('agency@example.com', { name: 'Acme client files', files: [{ path: 'live/a.md', text: 'A' }] });
    A7.shareStore(shared, 'morgan@example.com', { role: 'member' });
    // flags that call a shared store "owner" (what happened in production): the creator is someone else
    const lying = A7.addStore('agency@example.com', { name: 'Agency Bots', files: [{ path: 'bot/faq.md', text: 'FAQ' }] });
    A7.shareStore(lying, 'morgan@example.com', { role: 'owner', row: { owner: true } });
    const signInTo = async (X) => {
      await openLaunch(X.page);
      await X.page.locator('#kda-signin').waitFor({ timeout: 10000 });
      const [pop] = await Promise.all([X.context.waitForEvent('page'), X.page.locator('#kda-signin').click()]);
      await finishInPopup(pop, { email: 'morgan@example.com', action: 'signin' });
      await X.page.locator('#kda-use').waitFor({ timeout: 15000 });
    };
    const axe = async (pg) => { await settled(pg, 3000); return injectAxe(pg).then(() => pg.evaluate(async () => (await window.axe.run(document.querySelector('.kda-dialog'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' / ')}`))).catch((e) => [`axe did not run: ${e.message}`]); };

    const t7 = await newTrial();
    const G = await studioPage(browser, t7);
    const pg = G.page;
    await signInTo(G);
    const list = await pg.evaluate(() => ({
      usable: [...document.querySelectorAll('fieldset.kda-stores .kda-store')].map((el) => [el.querySelector('.kda-store-name').textContent, el.querySelector('.kda-store-meta').textContent, !!el.querySelector('input[type="radio"]')]),
      off: [...document.querySelectorAll('.kda-stores-off .kda-store')].map((el) => [el.querySelector('.kda-store-name').textContent, el.querySelector('.kda-store-meta').textContent, el.querySelectorAll('input, button, a, [tabindex]').length]),
      checked: document.querySelectorAll('.kda-dialog input:checked').length, off0: document.getElementById('kda-use').disabled }));
    check('the list: every store by name, file count and what KnowDrive reports', JSON.stringify(list.usable) === JSON.stringify([['Agency Bots', "1 file · KnowDrive doesn't confirm this store is yours", true], ['Morgan Bikes', 'Empty · Your store', true], ['Team handbook', '3 files · Your store', true]]), JSON.stringify(list.usable));
    check('the shared store is greyed with the reason, and is not an option (no control at all)', JSON.stringify(list.off) === JSON.stringify([['Acme client files', "Shared with you by another account: can't be used for a bot", 0]]), JSON.stringify(list.off));
    check('nothing is preselected and the button is off', list.checked === 0 && list.off0);
    await pg.screenshot({ path: path.join(SHOTS, 'store-many.png') });
    const v0 = await axe(pg);
    check('axe: no WCAG A/AA violations in the store list', !v0.length, v0.join(', '));
    // the server refuses the shared store too, whatever the page sends
    const direct = await api(`/api/studio/trials/${t7.trialId}/kd/store`, { method: 'POST', headers: { authorization: `Bearer ${t7.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ storeId: shared, confirmed: true, typedName: 'Acme client files' }) });
    check('the server refuses the shared store too', direct.status === 403 && (await direct.json()).error.code === 'kd_store_shared');
    // by keyboard alone: the first radio has focus; arrows move through the stores; the gates open one by one
    check('focus starts on the first store', await pg.evaluate(() => document.activeElement?.matches('.kda-store input[type="radio"]') && !document.activeElement.checked));
    await pg.keyboard.press('Space');            // Agency Bots: ownership not confirmed
    await pg.locator('#kda-store-name').waitFor({ timeout: 5000 });
    const why1 = await pg.locator('#kda-confirm').innerText();
    check('ownership not confirmed: says so, asks for the tick and the name', /doesn't confirm that "Agency Bots" is yours/.test(why1) && /This is my store, and I want this bot's files added to it/.test(why1) && /Type the store.s name to confirm: Agency Bots/.test(why1.replace(/\s+/g, ' ')), why1);
    await pg.keyboard.press('Tab'); await pg.keyboard.press('Space'); // the tick
    check('the tick alone is not enough', await pg.locator('#kda-use').isDisabled() && (await pg.locator('#kda-use').textContent()).trim() === 'Use Agency Bots');
    await pg.keyboard.press('Tab'); await pg.keyboard.type('agency bots');
    check('the tick and the typed name enable "Use Agency Bots"', !(await pg.locator('#kda-use').isDisabled()));
    await pg.screenshot({ path: path.join(SHOTS, 'store-many-name.png') });
    const v1 = await axe(pg);
    check('axe: no violations with the name confirmation open', !v1.length, v1.join(', '));
    // back to the list, down to the store with other files
    await pg.keyboard.press('Shift+Tab'); await pg.keyboard.press('Shift+Tab');
    await pg.keyboard.press('ArrowDown'); await pg.keyboard.press('ArrowDown');
    const pick2 = await pg.evaluate(() => ({ picked: document.querySelector('.kda-store input:checked')?.closest('.kda-store').querySelector('.kda-store-name').textContent, tick: document.getElementById('kda-store-tick')?.checked, name: !!document.getElementById('kda-store-name'),
      why: document.getElementById('kda-confirm-why')?.textContent, off: document.getElementById('kda-use').disabled, btn: document.getElementById('kda-use').textContent.trim() }));
    check('a store with other files: says how many, needs the tick (not carried over), no name', pick2.picked === 'Team handbook' && pick2.tick === false && !pick2.name && pick2.off && pick2.btn === 'Use Team handbook' && /"Team handbook" already holds 3 other files\. They stay as they are/.test(pick2.why || ''), JSON.stringify(pick2));
    await pg.screenshot({ path: path.join(SHOTS, 'store-many-confirm.png') });
    await pg.keyboard.press('Tab'); await pg.keyboard.press('Space');
    check('the tick enables "Use Team handbook"', !(await pg.locator('#kda-use').isDisabled()));
    await pg.screenshot({ path: path.join(SHOTS, 'store-many-confirmed.png') });
    const v2 = await axe(pg);
    check('axe: no violations with the confirmation ticked', !v2.length, v2.join(', '));
    check('still nothing written anywhere', [me.store, handbook, shared, lying].every((id) => !dev.kd.calls.some((x) => x.store === id && x.method !== 'GET')));
    await pg.keyboard.press('Tab');
    check('Tab reaches the button', await pg.evaluate(() => document.activeElement?.id === 'kda-use'));
    await pg.keyboard.press('Enter');
    await pg.locator('#kda-continue').waitFor({ timeout: 30000 });
    const inHandbook = A7.storeFiles(handbook);
    check('the files went to the chosen store, in their own folder; the files already there are untouched', inHandbook.length === 5 && inHandbook.filter((f) => f.filename.startsWith('KnowBot/')).length === 2 && ['hr/leave.md', 'hr/pay.md', 'notes.txt'].every((n) => inHandbook.some((f) => f.filename === n)), inHandbook.map((f) => f.filename).join(', '));
    check('no other store was written to', A7.storeFiles(me.store).length === 0 && A7.storeFiles(shared).length === 1 && A7.storeFiles(lying).length === 1);
    check('the dialog names the store', /Store: Team handbook/.test(await pg.locator('.kda-where').textContent()));
    // changing the choice before launch: the bot's own copies leave the earlier store, and the dialog says so
    await pg.locator('#kda-change').click();
    await pg.locator('#kda-use').waitFor({ timeout: 15000 });
    check('changing: the current store is marked, and can be kept', /Current/.test(await pg.locator('.kda-store[data-store="' + handbook + '"]').textContent()) && /Keep Team handbook/.test(await pg.locator('#kda-keep').textContent()));
    await pg.locator(`.kda-store[data-store="${me.store}"] input`).check();
    await pg.locator('#kda-use:not([disabled])').click();
    await pg.locator('#kda-removed').waitFor({ timeout: 15000 });
    const note = await pg.locator('#kda-removed').textContent();
    check('says what it removed from the earlier store', /KnowBot removed its copies of 2 files from "Team handbook"\. Nothing else there was touched\./.test(note), note);
    await pg.locator('#kda-continue').waitFor({ timeout: 30000 });
    check('only the bot’s own copies left the earlier store; the files are in the new one', A7.storeFiles(handbook).map((f) => f.filename).sort().join() === 'hr/leave.md,hr/pay.md,notes.txt' && A7.storeFiles(me.store).length === 2, A7.storeFiles(handbook).map((f) => f.filename).join(', '));
    const text7 = await pg.locator('.kda-dialog').textContent();
    check('no third-party names, no em dashes in the copy', !/google|oauth|stripe|twilio|anthropic|claude|cloudflare|\u2014/i.test(`${text7} ${why1} ${pick2.why} ${note}`));
    check('no page errors', !G.errors.length, G.errors.join(' | '));
    await G.context.close();

    for (const theme of ['light', 'dark']) {
      const tp = await newTrial();
      const P7 = await studioPage(browser, tp, { theme, viewport: { width: 390, height: 844 } });
      await signInTo(P7);
      await P7.page.locator('fieldset.kda-stores .kda-store', { hasText: 'Team handbook' }).locator('input').check();
      await P7.page.waitForTimeout(500);
      const fit = await P7.page.evaluate(() => { const d = document.querySelector('.kda-dialog').getBoundingClientRect(); const taps = [...document.querySelectorAll('fieldset.kda-stores .kda-store, .kda-check, #kda-use')].map((el) => el.getBoundingClientRect().height);
        return { scroll: document.documentElement.scrollWidth <= innerWidth + 1, dlg: d.width <= innerWidth + 0.5 && d.top >= 0, inner: document.querySelector('.kda-dialog').scrollWidth <= document.querySelector('.kda-dialog').clientWidth + 1, tap: Math.min(...taps) >= 44 }; });
      check(`${theme} phone: the store list fits (no sideways scroll, 44 px targets)`, fit.scroll && fit.dlg && fit.inner && fit.tap, JSON.stringify(fit));
      const vp = await axe(P7.page);
      check(`${theme} phone: axe clean`, !vp.length, vp.join(', '));
      await P7.page.screenshot({ path: path.join(SHOTS, `store-phone-${theme}.png`) });
      if (theme === 'dark') {
        const D7 = await studioPage(browser, tp, { theme, viewport: { width: 1440, height: 1000 } });
        await openLaunch(D7.page);
        await D7.page.locator('#kda-use').waitFor({ timeout: 15000 });
        await D7.page.locator('fieldset.kda-stores .kda-store', { hasText: 'Agency Bots' }).locator('input').check();
        const vd = await axe(D7.page);
        check('dark desktop: axe clean', !vd.length, vd.join(', '));
        await D7.page.screenshot({ path: path.join(SHOTS, 'store-many-dark.png') });
        await D7.context.close();
      }
      check(`${theme} phone: no page errors`, !P7.errors.length, P7.errors.join(' | '));
      await P7.context.close();
    }
  }
} catch (e) {
  check('kd smoke ran to the end', false, e.stack || e.message);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed · screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);

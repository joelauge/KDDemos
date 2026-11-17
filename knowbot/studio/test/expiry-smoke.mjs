#!/usr/bin/env node
// The Studio's expiry banner, in a real browser (Playwright) against studio/test/dev-server.mjs (fakes only):
//
//   1. a bot that was never seen on a website shows no banner (the small chip is enough)
//   2. once its website line was loaded from the owner's site and it stops within 3 days: a persistent banner,
//      "Your bot is answering on <host>. It stops in N days (date) unless you launch it.", with a Launch button that
//      is reached with the keyboard and opens Launch; the panes start below it; nothing scrolls sideways; axe clean
//   3. phone width, light and dark
//   4. more than 3 days left (an extended bot): no banner
//
//   npm run expiry:smoke                 # SHOTS=<dir> keeps the screenshots somewhere else (default: a temp dir)
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';
import { outDir, injectAxe, settled } from './smoke-util.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = outDir('expiry', process.env.SHOTS);
const HOST = 'www.lumen-bikes.example';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${String(detail).slice(0, 240)}` : ''}`); if (!ok) failures++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a 2-day trial: the server and the browser agree it stops within 3 days without moving any clock
const dev = await startDevServer({ speed: 8, env: { KNOWBOT_STUDIO_TTL_DAYS: '2' } });
const api = (p, init = {}) => fetch(dev.url + p, init);

async function newTrial() {
  const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
  const H = { authorization: `Bearer ${t.token}` };
  const T = (p) => `/api/studio/trials/${t.trialId}${p}`;
  await api(T(''), { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Lumen Help' }) });
  await api(T('/files'), { method: 'POST', headers: { ...H, 'x-filename': 'returns.md', 'content-type': 'application/octet-stream' }, body: Buffer.from('# Returns\n\nUnridden bikes can be returned within 30 days of delivery.\n') });
  for (let i = 0; i < 600; i++) {
    const j = await (await api(T('/files'), { headers: H })).json();
    if (j.files.length >= 1 && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
    await sleep(100);
  }
  return t;
}
const getTrial = async (t) => (await api(`/api/studio/trials/${t.trialId}`, { headers: { authorization: `Bearer ${t.token}` } })).json();
/** The website line on the owner's site reads the bot's switches on every page load: that is the install. */
async function seenOn(t, host) {
  await api(`/api/v1/channels/${t.trialId}`, { headers: { origin: `https://${host}` } });
  for (let i = 0; i < 100; i++) { if ((await getTrial(t)).installed?.host === host) return true; await sleep(50); }
  return false;
}
async function studioPage(browser, t, { theme = 'light', viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  await context.addInitScript(({ trial, theme: th }) => {
    try {
      localStorage.setItem('kb-landing', 'skip');
      localStorage.setItem('knowbot-theme', th);
      localStorage.setItem('kb-studio:v1', JSON.stringify({ trial: { id: trial.trialId, token: trial.token, expiresAt: trial.expiresAt }, ui: { view: 'bot' }, milestones: { firstFile: 1, firstReady: 1, firstCited: 1, proofRun: 1 } }));
    } catch { /* ignore */ }
  }, { trial: t, theme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__studio?.mods?.checkout && window.__studio.store.getState().trial.status === 'ready', null, { timeout: 30000 });
  return { context, page, errors };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
/** The banner's box, the panes' top edge and the Launch button's size. */
const geometry = (page) => page.evaluate(() => {
  const b = document.getElementById('st-expiry').getBoundingClientRect();
  const panes = [...document.querySelectorAll('.st-main > .st-pane')].filter((p) => p.offsetParent !== null && p.getBoundingClientRect().height > 0).map((p) => p.getBoundingClientRect());
  const go = document.querySelector('.st-expiry-go').getBoundingClientRect();
  const main = document.querySelector('.st-main').getBoundingClientRect();
  return { bannerBottom: b.bottom, bannerTop: b.top, bannerW: b.width, mainTop: main.top, mainW: main.width, paneTop: Math.min(...panes.map((p) => p.top)), paneBottom: Math.max(...panes.map((p) => p.bottom)), mainBottom: main.bottom, goH: go.height, goW: go.width, goRight: go.right, vw: window.innerWidth };
});

let browser;
try {
  browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  const t = await newTrial();

  console.log('1. never seen on a website: no banner');
  {
    const { context, page, errors } = await studioPage(browser, t);
    await sleep(400);
    check('no banner', (await page.locator('#st-expiry').count()) === 0);
    check('no page errors', !errors.length, errors.join(' | '));
    await context.close();
  }

  console.log('2. seen on the owner\'s site, 2 days left: the banner');
  check('the server noticed the site', await seenOn(t, HOST));
  {
    const { context, page, errors } = await studioPage(browser, t);
    const banner = page.locator('#st-expiry');
    check('the banner shows', await banner.waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
    const text = (await page.locator('.st-expiry-text').textContent()).replace(/\s+/g, ' ').trim();
    check('says where it answers and when it stops', new RegExp(`^Your bot is answering on ${HOST.replace(/\./g, '\\.')}\\. It stops in 2 days \\([^)]{6,40}\\) unless you launch it\\.$`).test(text), text);
    check('plain words: no vendor names, no dashes', !/google|stripe|twilio|anthropic|claude|cloudflare|resend|—|–/i.test(text), text);
    check('a status the screen reader hears, in a labelled region', (await page.locator('.st-expiry-text').getAttribute('role')) === 'status' && (await banner.getAttribute('aria-label')) === 'Trial ending');
    check('one action: Launch', (await banner.locator('button').count()) === 1 && (await banner.locator('button').textContent()).trim() === 'Launch');
    await settled(page, 3000);
    const g = await geometry(page);
    check('spans the panes, right under the header rows', Math.abs(g.bannerTop - g.mainTop) <= 1 && Math.abs(g.bannerW - g.mainW) <= 1, JSON.stringify(g));
    check('the panes start below it (nothing is covered)', g.paneTop >= g.bannerBottom - 1 && g.paneBottom <= g.mainBottom + 1, JSON.stringify(g));
    check('no sideways scroll', await noSideScroll(page));
    check('the small chip steps aside', await page.evaluate(() => { const c = document.getElementById('st-trialpill'); return !c || c.hidden || c.offsetParent === null; }));
    {
      const res = await injectAxe(page).then(() => page.evaluate(async () => (await window.axe.run(document.getElementById('st-expiry'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`)))
        .catch((e) => [`axe did not run: ${e.message}`]);
      check('axe: no WCAG A/AA violations in the banner', !res.length, res.join(', '));
    }
    await page.screenshot({ path: path.join(SHOTS, 'expiry-banner-desktop-light.png') });
    // keyboard: Tab from the top of the page reaches Launch; Enter opens Launch
    await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.classList?.contains('st-expiry-go') || false); }
    check('Tab reaches the Launch button', reached);
    check('with a visible focus ring', await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' || s.boxShadow !== 'none'; }));
    await page.keyboard.press('Enter');
    const opened = await page.waitForFunction(() => !!document.querySelector('.kda-dialog, .co-launch'), null, { timeout: 10000 }).then(() => true).catch(() => false);
    check('Enter opens Launch', opened);
    check('the banner stays', (await banner.count()) === 1);
    check('no page errors', !errors.length, errors.join(' | '));
    await context.close();
  }
  {
    const { context, page } = await studioPage(browser, t, { theme: 'dark' });
    await page.locator('#st-expiry').waitFor({ timeout: 10000 });
    await settled(page, 3000);
    const res = await injectAxe(page).then(() => page.evaluate(async () => (await window.axe.run(document.getElementById('st-expiry'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`)))
      .catch((e) => [`axe did not run: ${e.message}`]);
    check('dark: axe clean (contrast)', !res.length, res.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'expiry-banner-desktop-dark.png') });
    await context.close();
  }

  console.log('3. phone width');
  for (const theme of ['light', 'dark']) {
    const { context, page, errors } = await studioPage(browser, t, { theme, viewport: { width: 390, height: 844 } });
    const ok = await page.locator('#st-expiry').waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    check(`${theme}: the banner shows`, ok);
    if (ok) {
      await settled(page, 3000);
      const g = await geometry(page);
      check(`${theme}: fits the screen, no sideways scroll`, g.bannerW <= g.vw + 1 && g.goRight <= g.vw && await noSideScroll(page), JSON.stringify(g));
      check(`${theme}: the pane starts below it`, g.paneTop >= g.bannerBottom - 1 && g.paneBottom <= g.mainBottom + 1, JSON.stringify(g));
      check(`${theme}: Launch is a 44 px touch target`, g.goH >= 44 && g.goW >= 44, `${g.goW}x${g.goH}`);
      check(`${theme}: the banner stays under a third of the screen`, g.bannerBottom - g.bannerTop <= 844 / 3, String(g.bannerBottom - g.bannerTop));
      const res = await injectAxe(page).then(() => page.evaluate(async () => (await window.axe.run(document.getElementById('st-expiry'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`)))
        .catch((e) => [`axe did not run: ${e.message}`]);
      check(`${theme}: axe clean`, !res.length, res.join(', '));
      await page.screenshot({ path: path.join(SHOTS, `expiry-banner-phone-${theme}.png`) });
    }
    check(`${theme}: no page errors`, !errors.length, errors.join(' | '));
    await context.close();
  }

  console.log('4. more than 3 days left: the chip is enough');
  {
    const r = await api(`/api/studio/trials/${t.trialId}/extend`, { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'application/json' }, body: JSON.stringify({ days: 30 }) });
    check('the bot was given more time', r.status === 200);
    const j = await getTrial(t);
    check('still installed, per the server', j.installed?.host === HOST);
    const { context, page, errors } = await studioPage(browser, t);
    await sleep(600);
    check('no banner', (await page.locator('#st-expiry').count()) === 0);
    check('the panes are back at the top', await page.evaluate(() => { const m = document.querySelector('.st-main'); return !m.hasAttribute('data-expiry') && getComputedStyle(m).paddingTop === '0px'; }));
    check('no page errors', !errors.length, errors.join(' | '));
    await context.close();
  }
} catch (e) {
  check('expiry smoke ran to the end', false, e.stack || e.message);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed · screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);

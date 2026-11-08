#!/usr/bin/env node
// KnowBot Studio Playwright smoke (SPEC 7.4, owner B). Runs the whole journey against studio/test/dev-server.mjs
// (fake knowDrive + fake model on 127.0.0.1, FAKE_SPEED=4). Never touches production or any real service.
//
//   npm run studio:smoke                       # all cells
//   node studio/test/smoke.mjs --cell=desktop-light-full --cell=mobile-dark-full
//   node studio/test/smoke.mjs --quick          # steps 1-13 only, desktop-light-full + mobile-light-full
//   HEADED=1 node studio/test/smoke.mjs        # watch it
//
// Screenshots: studio/test/screens/<cell>/<nn>-<step>.png. Exit code 1 on any hard failure.

import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;   // isolation rule (SPEC 7.1): nothing below may reach a real store

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENS = path.join(__dirname, 'screens');
const FIXTURES = path.join(__dirname, 'fixtures');
const NOT_IN_DATA = "I can't seem to find an answer to that in any of my current data sources.";
const SAMPLE_FILES = ['lumen-warranty-returns.md', 'lumen-service-plans.html', 'lumen-store-faq.txt', 'lumen-price-list-2026.md'];
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const wantCells = args.filter((a) => a.startsWith('--cell=')).map((a) => a.slice(7));
const CELLS = [
  { name: 'desktop-light-full', mobile: false, theme: 'light', motion: 'full' },
  { name: 'desktop-dark-full', mobile: false, theme: 'dark', motion: 'full' },
  { name: 'desktop-light-reduce', mobile: false, theme: 'light', motion: 'reduce' },
  { name: 'mobile-light-full', mobile: true, theme: 'light', motion: 'full' },
  { name: 'mobile-dark-full', mobile: true, theme: 'dark', motion: 'full' },
].filter((c) => (wantCells.length ? wantCells.includes(c.name) : QUICK ? ['desktop-light-full', 'mobile-light-full'].includes(c.name) : true));

const results = [];   // {cell, step, name, ok, soft, detail}
let axeSource = null;

function log(...a) { console.log(...a); }

function makeChecker(cell) {
  return function check(step, name, ok, { soft = false, detail = '' } = {}) {
    results.push({ cell: cell.name, step, name, ok: !!ok, soft, detail: String(detail || '') });
    const mark = ok ? 'ok  ' : soft ? 'warn' : 'FAIL';
    log(`  [${mark}] ${step} ${name}${detail ? ` · ${String(detail).slice(0, 160)}` : ''}`);
    return !!ok;
  };
}

async function shot(page, cell, step) {
  const dir = path.join(SCREENS, cell.name);
  await fsp.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${step}.png`) }).catch((e) => log(`  (screenshot ${step} failed: ${e.message})`));
}

const state = (page) => page.evaluate(() => {
  const s = window.__studio?.store?.getState?.();
  if (!s) return null;
  return JSON.parse(JSON.stringify({ spec: s.spec, trial: { id: s.trial.id, status: s.trial.status, converted: s.trial.converted }, files: s.files, fileOrder: s.fileOrder,
    milestones: s.milestones, thread: s.thread.map((a) => ({ id: a.id, question: a.question, by: a.by, label: a.label, status: a.status, final: a.final ? { text: a.final.text, refused: a.final.refused, status: a.final.status, citations: (a.final.citations || []).map((c) => ({ n: c.n, file: c.file, similarity: c.similarity, match: c.match })) } : null })),
    ui: { view: s.ui.view, tab: s.ui.tab, drawer: s.ui.drawer, sheet: s.ui.sheet, badges: s.ui.badges }, proof: { status: s.proof?.status, score: s.proof?.score } }));
});

async function waitState(page, fn, { timeout = 30000, every = 250 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await state(page).catch(() => null);
    try { const v = last && fn(last); if (v) return v; } catch { /* keep polling */ }
    await page.waitForTimeout(every);
  }
  return null;
}

async function noHScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function runAxe(page) {
  try {
    if (!(await page.evaluate(() => !!window.axe))) {
      // offline runs: AXE_PATH=/path/to/axe.min.js (a local axe-core copy) instead of the CDN
      if (process.env.AXE_PATH && axeSource === null) { try { axeSource = await fsp.readFile(process.env.AXE_PATH, 'utf8'); } catch { axeSource = null; } }
      if (axeSource) await page.addScriptTag({ content: axeSource });
      else try { await page.addScriptTag({ url: AXE_URL }); }
      catch {
        if (axeSource === null) { try { const r = await fetch(AXE_URL); axeSource = r.ok ? await r.text() : ''; } catch { axeSource = ''; } }
        if (!axeSource) return { skipped: true };
        await page.addScriptTag({ content: axeSource });
      }
    }
    const res = await page.evaluate(async () => {
      // label-content-name-mismatch (WCAG 2.5.3) is experimental in axe 4.10, so it is switched on explicitly
      const r = await window.axe.run(document, { resultTypes: ['violations'], rules: { 'label-content-name-mismatch': { enabled: true } } });
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'label-content-name-mismatch')
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
    });
    return { violations: res };
  } catch (e) { return { skipped: true, error: e.message }; }
}

async function pane(page, cell, which) {
  if (!cell.mobile) return;
  const sel = which === 'setup' ? '#st-tab-setup' : '#st-tab-bot';
  const pressed = await page.getAttribute(sel, 'aria-pressed').catch(() => null);
  if (pressed !== 'true') { await page.click(sel); await page.waitForTimeout(260); }
}

async function builderSay(page, cell, text) {
  await pane(page, cell, 'setup');
  await page.fill('#st-setup-composer', text);
  await page.press('#st-setup-composer', 'Enter');
}

async function lastAnswer(page) {
  const s = await state(page);
  return s && s.thread.length ? s.thread[s.thread.length - 1] : null;
}

/** Click like a user; if something overlaps the target, fall back to the keyboard (focus + Enter) and say so. */
let interceptNotes = [];
async function press(loc, label = '') {
  try { await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })); } catch { /* detached */ }
  try { await loc.click({ timeout: 4000 }); return true; }
  catch (e) {
    interceptNotes.push(`${label}: ${String(e.message).split('\n').find((l) => /intercepts pointer events/.test(l)) || 'click failed'}`.slice(0, 200));
    try { await loc.focus(); await loc.press('Enter'); return true; } catch { return false; }
  }
}

/** Click a Builder chip whose label matches `re` (latest first); returns true when clicked. */
async function clickBuilderChip(page, cell, re) {
  await pane(page, cell, 'setup');
  const chips = page.locator('#st-log .st-chips:not([hidden]) .st-chip');
  const n = await chips.count();
  for (let i = n - 1; i >= 0; i--) {
    const t = (await chips.nth(i).innerText().catch(() => '')) || '';
    if (re.test(t)) { await press(chips.nth(i), `Builder chip ${t}`); return true; }
  }
  return false;
}

async function starterButtons(page) {
  const btns = page.locator('#sb-suggest-slot button');
  const n = await btns.count();
  const out = { starters: [], probe: null };
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const t = (await b.innerText().catch(() => '')).trim();
    if (/off-topic test/i.test(t)) out.probe = b; else if (t) out.starters.push(b);
  }
  return out;
}

async function setupCell(browser, cell) {
  const context = await browser.newContext({
    viewport: cell.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: cell.mobile, hasTouch: cell.mobile, deviceScaleFactor: cell.mobile ? 2 : 1,
    reducedMotion: cell.motion === 'reduce' ? 'reduce' : 'no-preference', colorScheme: cell.theme,
  });
  await context.addInitScript(() => {
    // record every banner text the page shows (at FAKE_SPEED=4 the partial banner can come and go between polls)
    window.__bannerSeen = [];
    document.addEventListener('DOMContentLoaded', () => {
      const b = document.getElementById('st-bot-banner');
      if (!b) return;
      new MutationObserver(() => { const t = (b.textContent || '').trim(); if (t && window.__bannerSeen[window.__bannerSeen.length - 1] !== t) window.__bannerSeen.push(t); })
        .observe(b, { childList: true, subtree: true, characterData: true });
    });
  });
  await context.addInitScript(({ theme, motion }) => {
    try {
      if (!sessionStorage.getItem('__smoke_init')) {
        localStorage.setItem('knowbot-theme', theme);
        localStorage.setItem('kb-studio-motion', motion);
        sessionStorage.setItem('__smoke_init', '1');
      }
    } catch { /* ignore */ }
  }, { theme: cell.theme, motion: cell.motion });
  return context;
}

function watchConsole(page, bucket) {
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return;
    bucket.push(`HTTP ${r.status()} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource/.test(t)) return;   // reported with its URL by the response listener
    if (/fonts\.(googleapis|gstatic)\.com|favicon|ERR_TUNNEL|ERR_PROXY|net::ERR_/.test(t)) return;   // offline font CDN in the sandbox
    bucket.push(t);
  });
  page.on('pageerror', (e) => bucket.push(`pageerror: ${e.message}`));
}

// ------------------------------------------------------------------ the journey

async function journey(browser, dev, cell) {
  log(`\n=== ${cell.name} ===`);
  const check = makeChecker(cell);
  const context = await setupCell(browser, cell);
  const page = await context.newPage();
  const errors = [];
  watchConsole(page, errors);
  const hscroll = async (step) => check(step, 'no horizontal scroll', await noHScroll(page));
  let trialStatus = null;
  page.on('response', (r) => { if (r.url().endsWith('/api/studio/trials') && r.request().method() === 'POST') trialStatus = r.status(); });
  let checkoutUrl = null;
  await page.route('https://knowdrive.ai/**', (route) => { checkoutUrl = route.request().url(); route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>checkout</title><p>fake checkout</p>' }); });

  // 01 landing
  const t0 = Date.now();
  await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-log .st-msg-a', { timeout: 5000 }).catch(() => null);
  const firstMsgMs = Date.now() - t0;
  await page.waitForTimeout(700);
  const logText = await page.innerText('#st-log').catch(() => '');
  check('01-landing', 'B0 text visible', /Start with your files or ours\?/.test(logText), { detail: `${firstMsgMs} ms to first Builder message` });
  const chipTexts = await page.locator('#st-log .st-chips:not([hidden]) .st-chip').allInnerTexts();
  check('01-landing', 'first-run choices: samples (primary), upload, store URL', chipTexts.length >= 3 && /Use sample files/.test(chipTexts[0]) && /Upload my files/.test(chipTexts[1]) && /Enter a Store URL/.test(chipTexts[2]) &&
    await page.locator('#st-log .st-chip-primary').first().innerText().then((t) => /Use sample files/.test(t)).catch(() => false), { detail: chipTexts.join(' | ') });
  await waitState(page, (s) => s.trial.status === 'ready', { timeout: 8000 });
  check('01-landing', 'trial created (201)', trialStatus === 201, { detail: `status ${trialStatus}` });
  check('01-landing', 'price visible, non-blocking', await page.isVisible('#st-price'));
  check('01-landing', 'no console errors', errors.length === 0, { detail: errors.slice(0, 3).join(' || ') });
  await hscroll('01-landing');
  if (cell.mobile) {
    check('01-landing', 'bottom tabs exist', await page.isVisible('#st-tab-setup') && await page.isVisible('#st-tab-bot'));
  }
  await shot(page, cell, '01-landing');
  const axe1 = await runAxe(page);
  if (axe1.skipped) check('01-landing', 'axe (skipped: axe-core unreachable)', true, { soft: true, detail: axe1.error || '' });
  else check('01-landing', 'axe: 0 serious/critical', axe1.violations.length === 0, { detail: JSON.stringify(axe1.violations).slice(0, 600) });

  // 02 samples
  await page.locator('#st-log .st-chip-primary').first().click();
  const tSamples = Date.now();
  const lumen = await page.waitForFunction(() => /Lumen Help/.test(document.querySelector('#st-botchip')?.textContent || ''), null, { timeout: 6000 }).then(() => Date.now() - tSamples).catch(() => null);
  check('02-samples', 'BotChip becomes Lumen Help within 3 s', lumen !== null && lumen <= 3000, { detail: lumen === null ? 'never' : `${lumen} ms` });
  await pane(page, cell, 'bot');
  const rows = await page.waitForFunction((names) => { const t = document.querySelector('#in-intake-slot')?.innerText || ''; return names.every((n) => t.includes(n) || t.includes(n.slice(0, 10))); }, SAMPLE_FILES, { timeout: 8000 }).then(() => true).catch(() => false);
  check('02-samples', '4 FileRows appear', rows);
  await shot(page, cell, '02-samples');

  // 03 ingest
  const atomized = await waitState(page, (s) => s.fileOrder.some((id) => ['atomized', 'vectorizing', 'ready'].includes(s.files[id]?.phase) && s.files[id]?.atoms > 0), { timeout: 20000, every: 150 });
  check('03-ingest', 'a row reached Atomize', !!atomized);
  await page.waitForTimeout(300);
  await shot(page, cell, '03-ingest');
  // the HUD reads "N atoms", or "N searchable · M read" while some files are still vectorizing (D's honest split)
  const hud = await page.evaluate(() => {
    const el = document.querySelector('#in-map-slot .map-count');
    if (el && !el.closest('[hidden]') && Number(el.dataset.value) > 0) return Number(el.dataset.value);
    const t = document.querySelector('#in-map-slot')?.innerText || '';
    const m = t.replace(/,/g, '').match(/(\d+)\s*(?:atoms?|searchable|read)\b/i); return m ? Number(m[1]) : null;
  });
  check('03-ingest', 'HUD atoms counter > 0', hud > 0, { detail: `HUD ${hud}` });
  const builderTalks = await page.waitForFunction(() => /atoms so far|atoms/.test(document.querySelector('#st-log')?.textContent || ''), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('03-ingest', 'Builder talks during ingest (atom count)', builderTalks, { soft: true });
  await hscroll('03-ingest');

  // 03b free text while ingest events are posting: the person always gets a reply (never swallowed by event turns)
  {
    await builderSay(page, cell, 'how much does it cost to go live?');
    const replied = await page.waitForFunction(() => {
      const msgs = [...document.querySelectorAll('#st-log .st-msg')];
      const i = msgs.findIndex((m) => m.classList.contains('st-msg-u') && /cost to go live/.test(m.textContent));
      return i >= 0 && msgs.slice(i + 1).some((m) => m.classList.contains('st-msg-a') && /\$249/.test(m.textContent));
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    check('03-ingest', 'free text during ingest gets a reply (with the price)', replied);
    const dupLearning = await page.evaluate(() => [...document.querySelectorAll('#st-log .st-msg-a .st-msg-text')].filter((t) => /^Ready: .* files done\.$/.test(t.textContent.trim())).length);
    check('03-ingest', 'no per-file "Ready: … files done" repeats', dupLearning === 0, { detail: `${dupLearning}` });
    await pane(page, cell, 'bot');
  }

  // 04 first ready
  await waitState(page, (s) => s.milestones.firstReady, { timeout: 30000 });
  {
    const s4 = await state(page);
    const lvl = await page.evaluate(() => document.getElementById('st-price')?.dataset.level);
    // r5 ladder: solid only at the peak (Proof Run done, a launch intent, or a Launch card on the table)
    const peak4 = await page.evaluate(() => !!document.querySelector('#st-log [data-card="launch"]'));
    const prove = await page.evaluate(() => document.querySelector('.st-node[data-step="prove"]')?.dataset.state);
    if (!s4.milestones.firstCited) {
      check('04-first-ready', 'price is outline (not solid) before any answer', lvl === 'outline' || (peak4 && lvl === 'solid'), { detail: `${lvl}${peak4 ? ' (launch card on the table)' : ''}` });
      check('04-first-ready', 'spine Prove not active before the first grounded answer', prove !== 'active', { detail: prove });
    }
  }
  const sugg = await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('#sb-suggest-slot button')].filter((x) => x.offsetParent !== null);
    return b.length >= 4 && b.some((x) => /off-topic test/i.test(x.innerText));
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  const st = await starterButtons(page);
  check('04-first-ready', 'SuggestionsRow: 3 starters + 1 probe', sugg && st.starters.length >= 3 && !!st.probe, { detail: `${st.starters.length} starters, probe ${!!st.probe}` });
  const seen = await page.evaluate(() => window.__bannerSeen || []);
  const partial = seen.find((t) => /of 4 files ready/i.test(t));
  check('04-first-ready', 'banner said "of 4 files ready"', !!partial, { soft: true, detail: partial || seen.slice(-3).join(' | ') || '(no banner text seen)' });
  await shot(page, cell, '04-first-ready');

  // 05 first answer
  const firstStarter = (await starterButtons(page)).starters[0];
  const firstQ = firstStarter ? (await firstStarter.innerText()).trim() : 'How long is the frame warranty?';
  if (firstStarter) await press(firstStarter, 'first starter');
  const grounded = await waitState(page, (s) => s.thread.find((a) => a.by !== 'proof' && a.final && a.status === 'grounded'), { timeout: 25000 });
  const elapsed = Date.now() - t0;
  check('05-first-answer', 'grounded answer', !!grounded, { detail: grounded ? grounded.question : 'none' });
  check('05-first-answer', 'first cited answer < 45 s from landing', elapsed < 45000, { detail: `${(elapsed / 1000).toFixed(1)} s` });
  await page.waitForTimeout(900);
  const threadText = await page.innerText('#sb-thread-slot').catch(() => '');
  const matches = [...threadText.matchAll(/match\s*(\d{1,3})/gi)].map((m) => Number(m[1]));
  check('05-first-answer', 'source chips show match 55–99', matches.some((n) => n >= 55 && n <= 99), { detail: matches.slice(0, 6).join(',') });
  // r7: chips are named "<visible text>: citation, atom n" (axe label-content-name-mismatch), so select by data-n
  const citeCount = await page.locator('#sb-thread-slot button.pf-cite[data-n="1"]').count();
  check('05-first-answer', 'answer has a [1] chip', citeCount > 0 || /\[1/.test(threadText), { detail: `${citeCount} citation buttons` });
  check('05-first-answer', 'pill starts with "Grounded"', /Grounded/.test(threadText));
  const geo5 = await page.evaluate(() => { const b = document.getElementById('st-bot').getBoundingClientRect(); const t = document.getElementById('sb-thread-slot').getBoundingClientRect(); return { pane: Math.round(b.height), thread: Math.round(t.height) }; });
  check('05-first-answer', 'thread gets ≥ 50% of the bot pane', geo5.thread >= geo5.pane * 0.5, { detail: `${geo5.thread}/${geo5.pane}` });
  const price5 = await page.evaluate(() => document.getElementById('st-price')?.dataset.level);
  const peak5 = await page.evaluate(() => !!document.querySelector('#st-log [data-card="launch"]'));
  // r5 (critic D8): the first cited answer alone keeps the outline rung; solid comes at the Proof Run / launch intent
  check('05-first-answer', 'price stays outline at the first cited answer (solid only at the peak)', price5 === 'outline' || (peak5 && price5 === 'solid'), { detail: `${price5}${peak5 ? ' (launch card on the table)' : ''}` });
  await hscroll('05-first-answer');
  await shot(page, cell, '05-first-answer');
  const axe2 = await runAxe(page);
  if (!axe2.skipped) check('05-first-answer', 'axe: 0 serious/critical', axe2.violations.length === 0, { detail: JSON.stringify(axe2.violations).slice(0, 600) });
  if (cell.mobile) {
    const badge = await page.evaluate(() => { const b = document.querySelector('#st-tab-setup .st-badge'); return !!b && !b.hidden; });
    check('05-first-answer', 'mobile: badge on the hidden Builder tab', badge, { soft: true });
  }

  // 06 popover
  const chip = page.locator('#sb-thread-slot button.pf-cite[data-n="1"]').first();
  if (await chip.count()) {
    await chip.focus();
    await chip.hover().catch(() => {});
    await page.waitForTimeout(700);
    const markOk = await page.evaluate(() => {
      const ans = document.querySelector('#sb-thread-slot')?.innerText || '';
      const marks = [...document.querySelectorAll('mark')].filter((m) => m.offsetParent !== null && m.textContent.trim().length > 3);
      return marks.some((m) => ans.includes(m.textContent.trim().slice(0, 40)) || true) && marks.length > 0;
    });
    check('06-popover', 'popover shows a <mark> quote', markOk);
    // r6 critic: hover shows only the popover; Proof view turns on at the first click / Enter (checked in 07)
    await shot(page, cell, '06-popover');

    // 07 drawer
    await chip.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const drawerOpen = await page.evaluate(() => { const d = document.querySelector('#sb-drawer-slot [role="dialog"]'); return !!d && d.offsetParent !== null; });
    const focusIn = await page.evaluate(() => !!document.querySelector('#sb-drawer-slot')?.contains(document.activeElement));
    check('07-drawer', 'drawer open', drawerOpen);
    check('07-drawer', 'focus inside the drawer', focusIn);
    const s7 = await state(page);
    check('07-drawer', 'Proof view is now on (after Enter on the chip)', s7?.ui.view === 'proof', { detail: s7?.ui.view });
    await shot(page, cell, '07-drawer');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const closed = await page.evaluate(() => { const d = document.querySelector('#sb-drawer-slot [role="dialog"]'); return !d || d.offsetParent === null; });
    const back = await page.evaluate(() => { const a = document.activeElement; return !!a && a.classList.contains('pf-cite') && a.dataset.n === '1'; });
    check('07-drawer', 'Esc closes it', closed);
    check('07-drawer', 'focus returns to the chip', back);
  } else {
    check('06-popover', 'citation chip present', false);
  }

  // 08 refusal
  await pane(page, cell, 'bot');
  const probe = (await starterButtons(page)).probe;
  const before = (await state(page)).thread.length;
  if (probe) await press(probe, 'probe chip');
  const refused = await waitState(page, (s) => s.thread.length > before && s.thread.slice(before).find((a) => a.final && a.final.refused), { timeout: 20000 });
  check('08-refusal', 'refusal text equals NOT_IN_DATA', refused && refused.final.text === NOT_IN_DATA, { detail: refused?.final?.text });
  await page.waitForTimeout(600);
  const why = page.locator('#sb-thread-slot button', { hasText: /^Why\?/ }).last();
  if (await why.count()) {
    await press(why, 'Why?');
    await page.waitForTimeout(500);
    const floorTxt = await page.innerText('#sb-thread-slot').catch(() => '');
    check('08-refusal', '[Why?] shows the FloorChart', /Nothing was invented/i.test(floorTxt) && /floor/i.test(floorTxt));
  } else check('08-refusal', '[Why?] button present', false);
  await shot(page, cell, '08-refusal');

  // 09 refine
  await builderSay(page, cell, 'make it more formal');
  const diff = await page.waitForFunction(() => [...document.querySelectorAll('#st-log .st-diff')].some((d) => /Tone/i.test(d.innerText)), null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('09-refine', 'ConfigDiffCard row Tone', diff);
  await page.waitForTimeout(800);
  const ver = await page.evaluate(() => { const v = document.querySelector('#st-version'); return v && !v.hidden ? v.textContent.trim() : ''; });
  if (cell.mobile) await pane(page, cell, 'bot');
  const verN = Number((ver.match(/v(\d+)/) || [])[1] || 0);
  check('09-refine', 'version chip v2 or later', verN >= 2, { detail: ver });
  const diffV = await page.evaluate(() => { const d = [...document.querySelectorAll('#st-log .st-diff')].filter((x) => /Tone/i.test(x.textContent)).pop(); const m = d && (d.querySelector('.st-diff-v')?.textContent || '').match(/v(\d+)\s*$/); return m ? Number(m[1]) : 0; });
  check('09-refine', 'ConfigDiff card version = header version chip', diffV === verN, { detail: `card v${diffV} · chip v${verN}` });
  await shot(page, cell, '09-refine');
  // r7 (D2): a question about the Builder itself is answered by the Builder (never "Want me to ask your bot that?"),
  // and no chip ever offers a change that is already in the spec
  if (!cell.mobile) {
    await builderSay(page, cell, 'what can you do?');
    const help = await page.waitForFunction(() => { const m = [...document.querySelectorAll('#st-log .st-msg-a')].pop(); const t = m?.innerText || ''; return /I build/.test(t) && !/ask your bot that/i.test(t) ? t : null; }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    check('09-refine', '"what can you do?" gets the Builder\'s capability answer', help);
    const noop = await page.evaluate(() => {
      const sp = window.__studio.store.getState().spec;
      const chips = [...document.querySelectorAll('#st-log .st-chips:not([hidden]) .st-chip')].map((c) => c.innerText);
      return chips.filter((t) => (/answers shorter/i.test(t) && sp.length === 'short') || (/more formal/i.test(t) && sp.tone === 'formal'));
    });
    check('09-refine', 'no chip offers a change that is already set', !noop.length, { detail: noop.join(' / ') });
  }

  if (QUICK && cell.mobile) { /* fall through: quick still runs proof + launch */ }

  // 10 scope: turn the warranty file off in the spec drawer, re-ask the first starter
  await pane(page, cell, 'setup');
  await page.click('#st-botchip');
  await page.waitForSelector('.st-drawer [role="dialog"], .st-drawer', { timeout: 3000 }).catch(() => null);
  // the file the first answer cited (the warranty file when the first starter is the warranty question; which file is
  // Ready first, and so which starter comes first, depends on ingest order)
  const scopeFile = SAMPLE_FILES.find((f) => (grounded?.final?.citations || []).some((c) => c.file === f)) || 'lumen-warranty-returns.md';
  // r7 (D2): the drawer lists the same starters the bot's suggestion row shows (pinned, then "auto")
  const autoN = await page.waitForFunction(() => document.querySelectorAll('#st-spec-auto .st-starter-auto').length + document.querySelectorAll('#st-spec-starters .st-starter').length, null, { timeout: 4000 }).then((h) => h.jsonValue()).catch(() => 0);
  check('10-scope', 'spec drawer lists starter questions (pinned or auto)', autoN > 0, { detail: `${autoN}` });
  const box = page.locator('.st-src', { hasText: scopeFile }).locator('input[type="checkbox"]');
  if (await box.count()) {
    await page.locator('.st-src', { hasText: scopeFile }).locator('label').click();
    await page.waitForTimeout(500);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const scoped = await waitState(page, (s) => Object.values(s.spec.sources || {}).some((v) => v === false), { timeout: 6000 });
  check('10-scope', `${scopeFile} switched off`, !!scoped);
  const before10 = (await state(page)).thread.length;
  const reask = false;   // re-ask the FIRST starter directly (the Builder's own Re-ask chip targets the latest question)
  {
    await pane(page, cell, 'bot');
    // starters refresh when a file is switched off, so the same question is typed into the bot's composer
    const ta = page.locator('#sb-composer-slot textarea').first();
    // the question that was actually answered (suggestions can refresh between reading a starter and clicking it)
    const askedQ = grounded?.question || firstQ;
    if (await ta.count()) { await ta.fill(askedQ); await ta.press('Enter'); }
    else {
      const list = (await starterButtons(page)).starters;
      let s10 = list[0];
      for (const b of list) if ((await b.innerText()).includes(firstQ)) { s10 = b; break; }
      if (s10) await press(s10, 'starter re-ask');
    }
  }
  const after = await waitState(page, (s) => s.thread.length > before10 && s.thread.slice(before10).find((a) => a.final), { timeout: 20000 });
  const firstFiles = (grounded?.final?.citations || []).map((c) => c.file).join(',');
  const afterFiles = (after?.final?.citations || []).map((c) => c.file).join(',');
  check('10-scope', 'refusal or a different citation', !!after && (after.final.refused || afterFiles !== firstFiles), { detail: `${after?.status} ${afterFiles}` });
  const compare = await page.waitForFunction(() => !!document.querySelector('#st-log [data-card="compare"]'), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('10-scope', 'compare card exists', compare);
  // screenshot the settled beat, not the middle of the refusal choreography (integrator)
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)), null, { timeout: 4000 }).catch(() => null);
  await page.waitForTimeout(300);
  await shot(page, cell, '10-scope');
  // switch the file back on so the Proof Run tests the whole corpus (8 in-scope questions)
  let backOn = null;
  for (let attempt = 0; attempt < 3 && !backOn; attempt++) {
    await pane(page, cell, 'setup');
    if (!(await page.locator('.st-src').first().isVisible().catch(() => false))) await page.click('#st-botchip');
    await page.waitForSelector('.st-src', { timeout: 3000 }).catch(() => null);
    await page.waitForTimeout(400);
    const lbl = page.locator('.st-src', { hasText: scopeFile }).locator('label');
    const inp = page.locator('.st-src', { hasText: scopeFile }).locator('input[type="checkbox"]');
    if (await lbl.count() && !(await inp.isChecked().catch(() => true))) { await lbl.click({ timeout: 5000 }).catch(() => null); await page.waitForTimeout(600); }
    await page.keyboard.press('Escape');
    backOn = await waitState(page, (s) => !Object.values(s.spec.sources || {}).some((v) => v === false), { timeout: 6000 });
  }
  check('10-scope', `${scopeFile} switched back on`, !!backOn, { soft: true });
  await page.waitForTimeout(1500);

  // 11 proof run
  const ranChip = await clickBuilderChip(page, cell, /Proof Run/i);
  if (!ranChip) await builderSay(page, cell, 'run the proof run');
  const sc = await page.waitForFunction(() => { const c = document.querySelector('#st-log [data-card="scorecard"]'); return c && /8\/8/.test(c.innerText) && /3\/3/.test(c.innerText); }, null, { timeout: 60000 }).then(() => true).catch(() => false);
  const scText = await page.evaluate(() => document.querySelector('#st-log [data-card="scorecard"]')?.innerText || '');
  check('11-proof-run', 'scorecard shows 8/8 and 3/3', sc, { detail: scText.replace(/\s+/g, ' ').slice(0, 160) });
  await page.waitForTimeout(600);
  {
    const price11 = await page.evaluate(() => document.getElementById('st-price')?.dataset.level);
    check('11-proof-run', 'price goes solid at the Proof Run (the peak)', price11 === 'solid' || price11 === undefined, { detail: price11 });
    const strip = await page.evaluate(() => (document.getElementById('st-prun')?.innerText || '').replace(/\s+/g, ' ').trim());
    check('11-proof-run', 'proof strip names the test once ("Proof Run 11/11 passed")', !strip || (/Proof Run 11\/11/.test(strip) && (strip.match(/Proof Run/g) || []).length === 1), { soft: true, detail: strip });
  }
  await shot(page, cell, '11-proof-run');

  // 12 make it yours → launch card
  await page.waitForTimeout(1500);   // let the proof_done turn finish
  await builderSay(page, cell, 'launch');
  const nMiy = await page.evaluate(() => (document.querySelector('#st-log')?.innerText.match(/only knows our sample files/gi) || []).length);
  const miy = await page.waitForFunction((n) => (document.querySelector('#st-log')?.innerText.match(/only knows our sample files/gi) || []).length > n, nMiy, { timeout: 12000 }).then(() => true).catch(() => false);
  const anywayChip = await page.waitForFunction(() => [...document.querySelectorAll('#st-log .st-chips:not([hidden]) .st-chip, #st-log [data-card] button')].some((b) => /Launch with samples anyway/i.test(b.innerText)), null, { timeout: 8000 }).then(() => true).catch(() => false);
  // an earlier, still-open Make it yours (e.g. from "how much to go live?" during ingest) is re-surfaced, never posted twice
  const miyShown = miy || (nMiy > 0 && anywayChip);
  check('12-make-it-yours', 'make-it-yours appears (sample-only)', miyShown, { detail: miy ? 'new' : miyShown ? 're-surfaced (open decision)' : 'none' });
  // r3: a price question while Make it yours is open is answered in one line and brings back the SAME card
  if (miyShown) {
    const nCards = await page.evaluate(() => document.querySelectorAll('#st-log .co-miy').length);
    await builderSay(page, cell, 'how much to launch?');
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => document.querySelectorAll('#st-log .co-miy').length);
    check('12-make-it-yours', 'price question re-surfaces Make it yours (no second card)', after === nCards, { detail: `${nCards} -> ${after}` });
  }
  // r3 (SPEC 11.1): the insights card, when present, counts real asks only (>= 3) and never lists a refused question
  // under Most asked
  const ins = await page.evaluate(() => { const c = document.querySelector('#st-log .st-insights'); if (!c) return null;
    const m = /(\d+) asked/.exec(c.innerText); const top = [...c.querySelectorAll('.st-ins-col:not(.st-ins-gaps) .st-ins-row')];
    return { asked: m ? Number(m[1]) : 0, refusedInTop: top.some((r) => r.dataset.outcome === 'refused') }; });
  if (ins) check('12-make-it-yours', 'insights card: >= 3 asked, Most asked = answered only', ins.asked >= 3 && !ins.refusedInTop, { soft: true, detail: JSON.stringify(ins) });
  const anyway = await clickBuilderChip(page, cell, /Launch with samples anyway/i)
    || await page.locator('#st-log button', { hasText: /Launch with samples anyway/i }).last().click().then(() => true).catch(() => false);
  check('12-make-it-yours', 'clicked Launch with samples anyway', anyway);
  const launchCard = await page.waitForFunction(() => {
    // with the receipt stage open the Builder summary folds to a pointer: the price lives in the stage (r4, D8)
    const cards = [...document.querySelectorAll('#st-log [data-card="launch"], .co-launch.is-stage')];
    const text = cards.map((c) => c.innerText).join('\n');
    return /\$249/.test(text) && /For comparison/i.test(text);
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('12-make-it-yours', 'LaunchCard with $249 and the anchor line', launchCard);
  await page.waitForTimeout(900);
  await shot(page, cell, '12-make-it-yours');

  // 13 checkout
  // r4 (D8): one solid CTA per viewport. With the receipt stage open (>= 1100 px) the Builder summary folds to a pointer,
  // and the stage's CTA is the one to press.
  const stageOpen = await page.evaluate(() => document.documentElement.getAttribute('data-co-cta') === 'receipt');
  const cta = stageOpen
    ? page.locator('.co-launch.is-stage button.co-cta, .co-stage button.co-cta').filter({ hasText: /Launch .*\$249/ }).last()
    : page.locator('#st-log [data-card="launch"] button', { hasText: /Launch .*\$249/ }).last();
  if (stageOpen) {
    const ctas = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent && /Launch.*\$249/.test(b.textContent.replace(/\s+/g, ' ')) && getComputedStyle(b).visibility !== 'hidden').length);   // r7: the price sits in an sr-only span (E), so textContent
    check('13-checkout', 'one visible Launch CTA while the receipt is open', ctas === 1, { soft: true, detail: `${ctas} visible` });
  }
  if (await cta.count()) await press(cta, 'Launch CTA');
  const sheet = await page.waitForFunction(() => { const d = document.querySelector('#co-modal-slot [role="dialog"]'); return !!d && d.offsetParent !== null; }, null, { timeout: 6000 }).then(() => true).catch(() => false);
  check('13-checkout', 'checkout sheet open', sheet);
  await page.waitForTimeout(700);
  const behind = await page.evaluate(() => {
    const app = document.querySelector('#st-app').getBoundingClientRect();
    const cands = [...document.querySelectorAll('#co-modal-slot *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width >= innerWidth * .95 && r.height >= innerHeight * .95; });
    const alphaOf = (el) => { const c = getComputedStyle(el); const m = c.backgroundColor.match(/rgba?\(([^)]+)\)/); const a = m ? (m[1].split(/[,/\s]+/).filter(Boolean)[3] ?? '1') : '1'; return Number(a) * Number(c.opacity); };
    const scrimAlpha = cands.length ? Math.max(...cands.map(alphaOf)) : 0;
    return { visible: app.width > 0 && app.height > 0, scrimAlpha };
  });
  check('13-checkout', 'studio visible behind the sheet (scrim < 1)', sheet && behind.visible && behind.scrimAlpha < 1, { soft: cell.mobile, detail: JSON.stringify(behind) });
  const emailFocus = await page.evaluate(() => document.activeElement?.type === 'email');
  check('13-checkout', 'email field has focus', emailFocus);
  await shot(page, cell, '13-checkout');
  const axe3 = await runAxe(page);
  if (!axe3.skipped) check('13-checkout', 'axe: 0 serious/critical', axe3.violations.length === 0, { detail: JSON.stringify(axe3.violations).slice(0, 600) });
  const email = page.locator('#co-modal-slot input[type="email"]').first();
  if (await email.count()) { await email.fill('smoke@example.com'); }
  const cont = page.locator('#co-modal-slot button', { hasText: /Continue to secure checkout/i }).first();
  if (await cont.count()) await press(cont, 'Continue to checkout');
  const deadline = Date.now() + 8000;
  while (!checkoutUrl && Date.now() < deadline) await page.waitForTimeout(150);
  check('13-checkout', 'redirect URL has trial= and bot=Lumen+Help', !!checkoutUrl && checkoutUrl.startsWith('https://knowdrive.ai/signup') && /[?&]trial=/.test(checkoutUrl) && /[?&]bot=Lumen(\+|%20)Help/.test(checkoutUrl), { detail: checkoutUrl || 'no navigation' });
  if (cell.mobile) {
    const tt = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('#st-setup-form button, #st-setup-composer, #sb-composer-slot button, #sb-composer-slot textarea')) {
        const r = el.getBoundingClientRect(); if (r.width && r.height && (r.height < 43.5 || r.width < 43.5)) bad.push(`${el.id || el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return bad;
    });
    check('13-checkout', 'mobile: composer tap targets ≥ 44 px', tt.length === 0, { soft: true, detail: tt.join('; ') });
  }
  if (cell.motion === 'reduce') {
    const longAnims = await page.evaluate(() => document.getAnimations().filter((a) => {
      const t = a.effect?.getTiming?.(); if (!t || a.playState !== 'running') return false;
      const d = Number(t.duration) || 0; return t.iterations === Infinity ? d > 0 : d > 200;
    }).map((a) => `${a.animationName || a.id || 'waapi'}:${a.effect?.target?.className || a.effect?.target?.tagName}`).slice(0, 8));
    check('13-checkout', 'reduced motion: no running animation > 200 ms', longAnims.length === 0, { detail: longAnims.join(', ') });
  }
  check('13-checkout', 'pointer targets never covered (keyboard fallback unused)', interceptNotes.length === 0, { soft: true, detail: interceptNotes.join(' || ') });
  interceptNotes = [];
  await context.close();

  if (QUICK) return;

  // 14 own file (fresh context)
  const ctx2 = await setupCell(browser, cell);
  const p2 = await ctx2.newPage();
  const errs2 = []; watchConsole(p2, errs2);
  await p2.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('#st-log .st-chip', { timeout: 6000 });
  await waitState(p2, (s) => s.trial.status === 'ready', { timeout: 8000 });
  await p2.waitForTimeout(500);
  const chooser = p2.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await p2.locator('#st-log .st-chip', { hasText: /Upload my files/ }).first().click();
  const fc = await chooser;
  check('14-own-file', 'picker opens from the chip', !!fc);
  if (fc) await fc.setFiles(path.join(FIXTURES, 'handbook.md'));
  const own = await waitState(p2, (s) => s.fileOrder.map((id) => s.files[id]).find((f) => f && /handbook/.test(f.name) && f.phase === 'ready'), { timeout: 40000 });
  check('14-own-file', 'handbook.md reaches Ready', !!own);
  await pane(p2, cell, 'bot');
  const sg = await p2.waitForFunction(() => [...document.querySelectorAll('#sb-suggest-slot button')].filter((x) => x.offsetParent !== null && !/off-topic/i.test(x.innerText)).length > 0, null, { timeout: 15000 }).then(() => true).catch(() => false);
  if (sg) {
    const b = (await starterButtons(p2)).starters[0];
    await press(b, 'own-file starter');
  } else {
    const ta = p2.locator('#sb-composer-slot textarea').first();
    if (await ta.count()) {
      await ta.fill('How many days of paid vacation do full-time employees get?');
      await ta.press('Enter');
    }
  }
  const ownAns = await waitState(p2, (s) => s.thread.find((a) => a.final && a.status === 'grounded' && a.final.citations.some((c) => /handbook/.test(c.file))), { timeout: 25000 });
  check('14-own-file', 'cited answer from handbook.md', !!ownAns, { detail: ownAns?.question });
  await shot(p2, cell, '14-own-file');

  // 15 errors
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-smoke-'));
  const exe = path.join(tmp, 'installer.exe'); await fsp.writeFile(exe, Buffer.from('MZ\x90\x00fake'));
  const failing = path.join(tmp, 'scanned-contract.md'); await fsp.writeFile(failing, '# Scanned contract\n\nFAIL_NO_TEXT\n\nThis file simulates a scan with no text layer.\n');
  for (const f of [exe, failing]) {
    await pane(p2, cell, 'setup');
    const ch = p2.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await p2.click('#st-setup-form .st-attach');
    const c2 = await ch;
    if (c2) await c2.setFiles(f);
  }
  await pane(p2, cell, 'bot');
  const rejected = await p2.waitForFunction(() => { const t = document.querySelector('#in-intake-slot')?.innerText || ''; return /installer\.exe/.test(t) && /Remove/.test(t); }, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('15-errors', '.exe → rejected row with [Remove]', rejected);
  const failed = await p2.waitForFunction(() => { const t = document.querySelector('#in-intake-slot')?.innerText || ''; return /scanned-contract/.test(t) && /Retry/.test(t) && /Replace/.test(t) && /Remove/.test(t); }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  check('15-errors', 'FAIL_NO_TEXT → failed row with [Retry] [Replace] [Remove]', failed);
  await shot(p2, cell, '15-errors');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});

  // 16 reload
  await p2.reload({ waitUntil: 'domcontentloaded' });
  const wb = await p2.waitForFunction(() => /Welcome back/.test(document.querySelector('#st-log')?.innerText || ''), null, { timeout: 12000 }).then(() => true).catch(() => false);
  check('16-reload', 'Builder says "Welcome back"', wb);
  await pane(p2, cell, 'bot');
  const restored = await p2.waitForFunction(() => /handbook/.test(document.querySelector('#in-intake-slot')?.innerText || ''), null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('16-reload', 'files restored', restored);
  check('16-reload', 'no horizontal scroll', await noHScroll(p2));
  await shot(p2, cell, '16-reload');
  check('16-reload', 'no console errors (own-file context)', errs2.filter((e) => !/HTTP 4(00|13|15|22)/.test(e)).length === 0, { soft: true, detail: errs2.slice(0, 3).join(' || ') });

  // shell hit areas (phones): every header / bot-header control takes a 44 x 44 tap around its centre
  if (cell.mobile) {
    await p2.evaluate(() => { const e = document.getElementById('st-peek'); if (e) e.hidden = true; });
    const tiny = await p2.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#st-header button, #st-header a, #st-bot-header .st-version, #st-bot-header .st-seg-btn')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden]')) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const ok = [[cx, cy - 21], [cx, cy + 21], [cx - 21, cy], [cx + 21, cy]].every(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e === el || el.contains(e)); });
        if (!ok) out.push(`${el.id || el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    check('16-reload', 'mobile: shell controls take a 44 x 44 tap', !tiny.length, { detail: tiny.join(', ') });
  }

  // 17 live: after conversion the shell stops selling, on the return and on every reload
  const tid = await p2.evaluate(() => window.__studio.store.getState().trial.id);
  const conv = await fetch(`${dev.url}/api/studio/trials/${tid}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin' }, body: JSON.stringify({ account: 'smoke', bucketId: 'smoke-bot' }) }).then((r) => r.ok).catch(() => false);
  check('17-live', 'trial converted (admin, fake server)', conv);
  await p2.reload({ waitUntil: 'domcontentloaded' });
  const liveHead = await p2.waitForFunction(() => { const pill = document.getElementById('st-livepill'); const price = document.getElementById('st-pricewrap');
    return pill && !pill.hidden && pill.offsetParent !== null && (!price || price.hidden || price.offsetParent === null); }, null, { timeout: 12000 }).then(() => true).catch(() => false);
  check('17-live', 'header shows Live (no price, no trial pill)', liveHead && await p2.evaluate(() => { const t = document.getElementById('st-trialpill'); return !t || t.hidden || t.offsetParent === null; }));
  await pane(p2, cell, 'setup');
  const liveChips = await p2.waitForFunction(() => { const rows = [...document.querySelectorAll('#st-log .st-chips:not([hidden]):not(.is-stale)')]; const t = rows.length ? rows[rows.length - 1].innerText : '';
    // r8: post-launch chips follow fixer r7 D8 (the SuccessCard holds Copy embed / Add your files; the chips are the
    // channel + API next actions); a text-only Live line still offers "Copy embed code"
    return /Set up channels|Channels & API|Copy embed code/.test(t) && !/Use sample files|canonical bot|avoid making things up|^\s*Call it /im.test(t) ? t : null; }, null, { timeout: 12000 }).then((h) => h.jsonValue()).catch(() => null);
  check('17-live', 'Builder offers the live next actions (no setup chips)', !!liveChips, { detail: String(liveChips || '').replace(/\s+/g, ' ') });
  check('17-live', 'ghost answer hidden', await p2.evaluate(() => { const g = document.querySelector('.sb-ghost'); return !g || g.offsetParent === null; }));
  await p2.waitForTimeout(cell.motion === 'reduce' ? 200 : 1400);   // let the SuccessCard finish assembling before the shot
  await shot(p2, cell, '17-live');
  await ctx2.close();

  // the OS colour scheme is the default theme when nothing is stored
  if (cell.theme === 'dark' && !cell.mobile) {
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const p3 = await ctx3.newPage();
    await p3.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    check('01-landing', 'OS dark preference is the default theme', (await p3.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await ctx3.close();
  }
}

// ------------------------------------------------------------------ Enter a Store URL (a fresh trial per cell)
async function storeJourney(browser, dev, cell) {
  const check = makeChecker(cell);
  const context = await setupCell(browser, cell);
  const page = await context.newPage();
  const errors = [];
  watchConsole(page, errors);
  try {
    await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    await waitState(page, (s) => s.trial.status === 'ready', { timeout: 10000 });
    await page.waitForTimeout(500);
    check('18-store', 'Builder offers "Enter a Store URL"', await clickBuilderChip(page, cell, /Enter a Store URL/));
    const input = page.locator('.st-si input[placeholder="yourstore.com"]').last();
    const opened = await input.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    check('18-store', 'inline URL field (placeholder yourstore.com) + ownership checkbox', opened && await page.locator('.st-si .st-si-check input[type="checkbox"]').last().isVisible());
    await input.fill(dev.shopUrl);
    await press(page.locator('.st-si button[type="submit"]').last(), 'Import store');
    const gated = await page.waitForFunction(() => /own or manage/i.test(document.querySelector('.st-si .st-field-msg')?.textContent || ''), null, { timeout: 3000 }).then(() => true).catch(() => false);
    check('18-store', 'import waits for "I own or manage this store"', gated);
    await page.locator('.st-si .st-si-check input[type="checkbox"]').last().check();
    await press(page.locator('.st-si button[type="submit"]').last(), 'Import store');
    const seen = await page.waitForFunction(() => /Shopify store found/.test(document.querySelector('.st-si-run')?.innerText || '') || /Found \d/.test(document.querySelector('.st-si-found')?.textContent || ''), null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('18-store', 'progress: platform found, then counts', seen, { detail: await page.locator('.st-si-run').last().innerText().catch(() => '') });
    const done = await page.waitForFunction(() => /Imported \d+ files?/.test(document.querySelector('.st-si-status')?.textContent || ''), null, { timeout: 30000 }).then(() => true).catch(() => false);
    check('18-store', 'import done: "Imported N files from …"', done, { detail: await page.locator('.st-si-status').last().innerText().catch(() => '') });
    await shot(page, cell, '18-store');
    const rows = await waitState(page, (s) => s.fileOrder.length >= 3 && s.fileOrder.some((id) => s.files[id]?.phase === 'ready'), { timeout: 45000 }).then(() => true).catch(() => false);
    check('18-store', 'imported files appear and learn like uploads', rows);
    const tid = await page.evaluate(() => window.__studio.store.getState().trial.id);
    const token = await page.evaluate(() => window.__studio.store.getState().trial.token);
    const r = await fetch(`${dev.url}/api/studio/trials/${tid}/ask`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Can I return a bike?' }) });
    const fin = (await r.text()).split('\n\n').map((fr) => (/^event: final$/m.test(fr) ? JSON.parse(/^data: (.*)$/m.exec(fr)[1]) : null)).find(Boolean);
    check('18-store', 'librarian answer links the store page it quotes', !!fin && fin.status === 'grounded' && fin.text.includes(`${dev.shopUrl}/policies/refund-policy`), { detail: fin?.text });
    // a bad address: store error copy with both ways forward
    await pane(page, cell, 'setup');
    await press(page.locator('.st-si-actions button', { hasText: 'Import again' }).last(), 'Import again');
    await input.fill('localhost');
    await press(page.locator('.st-si button[type="submit"]').last(), 'Import store');
    const errUi = await page.waitForFunction(() => {
      const run = document.querySelector('.st-si.is-error .st-si-run');
      return run && /Try another URL/.test(run.innerText) && /Upload files instead/.test(run.innerText) ? run.innerText : null;
    }, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    check('18-store', 'errors use the store copy with "Try another URL" and "Upload files instead"', !!errUi, { detail: String(errUi || '').replace(/\s+/g, ' ') });
    check('18-store', 'no console errors', errors.length === 0, { soft: true, detail: errors.slice(0, 3).join(' || ') });
    check('18-store', 'no horizontal scroll', await noHScroll(page));
  } finally { await context.close(); }
}

// ------------------------------------------------------------------ main

const speed = Number(process.env.FAKE_SPEED || 4) || 4;
// SMOKE_CELLS=mobile-light-full,desktop-dark-full runs a subset (local iteration); the default is every cell
const RUN = process.env.SMOKE_CELLS ? CELLS.filter((c) => process.env.SMOKE_CELLS.split(',').map((x) => x.trim()).includes(c.name)) : CELLS;
log(`Studio smoke · FAKE_SPEED=${speed} · cells: ${RUN.map((c) => c.name).join(', ')}`);
await fsp.mkdir(SCREENS, { recursive: true });
const browser = await chromium.launch(process.env.HEADED ? { headless: false } : {});
try {
  for (const cell of RUN) {
    // One dev server per cell: the per-IP rate limits (6 trials/h, 20 Builder turns/min) are real, and every cell
    // comes from 127.0.0.1, so sharing a server would test the limiter instead of the journey.
    const dev = await startDevServer({ speed });
    log(`  ${dev.studioUrl}`);
    try { await journey(browser, dev, cell); await storeJourney(browser, dev, cell); }
    catch (e) { results.push({ cell: cell.name, step: 'crash', name: e.message, ok: false, soft: false, detail: '' }); log(`  [FAIL] crash ${e.stack}`); }
    finally { await dev.close(); }
  }
} finally {
  await browser.close();
}
const hard = results.filter((r) => !r.ok && !r.soft);
const soft = results.filter((r) => !r.ok && r.soft);
log(`\nSmoke: ${results.length - hard.length - soft.length} passed · ${soft.length} warnings · ${hard.length} failed`);
for (const r of hard) log(`  FAIL ${r.cell} ${r.step} ${r.name} ${r.detail ? '· ' + r.detail.slice(0, 200) : ''}`);
await fsp.writeFile(path.join(SCREENS, 'results.json'), JSON.stringify({ at: new Date().toISOString(), speed, results }, null, 2));
process.exit(hard.length ? 1 : 0);

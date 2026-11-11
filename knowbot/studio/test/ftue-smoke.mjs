#!/usr/bin/env node
// The first-time guide (studio/ftue.js), end to end in a real browser (Playwright) against studio/test/dev-server.mjs
// (fake knowDrive + fake model on 127.0.0.1; never a real service). Each cell walks a brand-new visitor through it:
//
//   steps 1-4    the guide is the only source of the next action (data-ftue="on"): no Builder chip that repeats it, no
//                suggestion row, no empty-state line, no example answer, no Stats & Leads, no jargon, no "Welcome back"
//   1 Add        "Step 1 of 5"; Escape hides it (persisted across a reload) and everything comes back; the empty
//                state's "… Or write a note." opens "Add a note" (tags behind More options); ⋯ → Show the guide restores
//   1 → 2        "Try sample files" attaches the samples; "n of m files ready" is the only progress shown
//   2 → 3        advances on milestones.firstReady; offers one suggested question
//   3 → 4        asking it advances on milestones.firstCited (a cited answer); "Try to trip it up"
//   4 → 5        "Ask something off-topic" advances on milestones.firstRefusal, never while the reply still renders;
//                the refusal stays in view above the card
//   5 view A     a ~1 s burst above the card (a calm check with reduced motion), "Your bot is ready", "Where should it
//                answer?" (saves spec.surfaces)
//   5 view B     "Put it on your site": the real line (bot id, api, the trial key masked on screen and real on Copy),
//                Copy as the one primary, three steps; the AI-agent prompt and developer mailto behind "Other ways"
//   Stats & Leads gets the pulse and opens from the header (desktop; ⋯ on phones); phones: actions visible without
//                scrolling inside the sheet, the header says "Launch"
//
//   npm run ftue:smoke                      # SHOTS=<dir> keeps the screenshots somewhere else
//   node studio/test/ftue-smoke.mjs --cell=desktop-light
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'kb-ftue-shots');

const args = process.argv.slice(2);
const want = args.filter((a) => a.startsWith('--cell=')).map((a) => a.slice(7));
const CELLS = [
  { name: 'desktop-light', theme: 'light', motion: 'full', mobile: false, shots: true },
  { name: 'desktop-dark', theme: 'dark', motion: 'full', mobile: false },
  { name: 'desktop-light-reduce', theme: 'light', motion: 'reduce', mobile: false },
  { name: 'mobile-light', theme: 'light', motion: 'full', mobile: true },
  { name: 'mobile-dark', theme: 'dark', motion: 'full', mobile: true },
].filter((c) => !want.length || want.includes(c.name));

let failures = 0;
const check = (cell, name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${cell.name}: ${name}${detail ? ` · ${String(detail).slice(0, 220)}` : ''}`); if (!ok) failures++; return ok; };

const dev = await startDevServer({ speed: 2 });
let browser;
try {
  browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  let axeSource = null;
  try { const r = await fetch('https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js', { signal: AbortSignal.timeout(8000) }); if (r.ok) axeSource = await r.text(); } catch { axeSource = null; }
  const axe = async (page, cell, label) => {
    if (!axeSource) { console.log(`  (axe skipped for ${label}: CDN unreachable)`); return; }
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => (await window.axe.run(document.getElementById('st-ftue'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`));
    check(cell, `axe: no WCAG A/AA violations in the guide (${label})`, !res.length, res.join(', '));
  };
  for (const cell of CELLS) {
    console.log(`\n${cell.name}`);
    const context = await browser.newContext(cell.mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: cell.theme }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: cell.theme });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(dev.studioUrl).origin }).catch(() => {});
    await context.addInitScript(({ theme, motion }) => {
      try {
        localStorage.setItem('kb-landing', 'skip');
        if (!sessionStorage.getItem('__ftue_init')) {
          localStorage.setItem('knowbot-theme', theme);
          localStorage.setItem('kb-studio-motion', motion);
          sessionStorage.setItem('__ftue_init', '1');
        }
      } catch { /* ignore */ }
    }, { theme: cell.theme, motion: cell.motion });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://knowdrive.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>checkout</title>' }));
    const shot = async (name) => { await page.evaluate(() => document.querySelectorAll('.st-toast').forEach((t) => t.remove())); if (cell.shots || name.startsWith(cell.name)) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
    const ms = () => page.evaluate(() => window.__studio.store.getState().milestones);
    const step = () => page.evaluate(() => { const c = document.getElementById('st-ftue'); return c && !c.hidden && c.offsetParent !== null ? c.dataset.step : null; });
    const waitStep = (s, timeout = 40000) => page.waitForFunction((want) => { const c = document.getElementById('st-ftue'); return c && !c.hidden && c.dataset.step === want; }, s, { timeout }).then(() => true).catch(() => false);
    const cardTop = () => page.evaluate(() => { const c = document.getElementById('st-ftue'); if (c) c.scrollTop = 0; });
    const eyebrow = () => page.locator('#st-ftue .st-ftue-eyebrow').textContent().catch(() => '');

    await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__studio?.store?.getState?.().trial?.status === 'ready', null, { timeout: 20000 }).catch(() => {});


    // the guide is the only source of the next action while steps 1-4 show
    const quiet = () => page.evaluate(() => {
      const shown = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
      const dup = ['use_samples', 'samples', 'upload_files', 'upload', 'import_store', 'store', 'ask_starter', 'ask-starter', 'ask_probe', 'offtopic', 'run_proof', 'proof', 'trick', 'channels']
        .flatMap((id) => [...document.querySelectorAll(`#st-log .st-chip[data-chip="${id}"]`)]).filter(shown).map((b) => b.textContent.trim());
      const words = [...document.querySelectorAll('#st-log .st-chip')].filter(shown).map((b) => b.textContent.trim()).filter((t) => /Proof Run|Test it before going live|What's an atom/.test(t));
      return { flag: document.documentElement.getAttribute('data-ftue'), dup, words, suggest: shown(document.getElementById('sb-suggest-slot')) && !!document.querySelector('#sb-suggest-slot button'),
        empty: [...document.querySelectorAll('.sb-empty')].some(shown), ghost: [...document.querySelectorAll('.sb-ghost')].some(shown), leads: shown(document.getElementById('st-leads')),
        next: !!document.querySelector('.st-next'), welcome: /Welcome back/.test(document.getElementById('st-log')?.innerText || '') };
    });
    const quietCheck = async (label) => {
      const q = await quiet();
      check(cell, `${label}: only the guide offers the next action`, q.flag === 'on' && !q.dup.length && !q.words.length && !q.suggest && !q.empty && !q.ghost && !q.leads && !q.next && !q.welcome, JSON.stringify(q));
    };
    // on phones: the guide's action shows without scrolling inside it
    const actionInView = async (sel, label) => {
      const ok = await page.evaluate((s) => {
        const c = document.getElementById('st-ftue'); const b = c?.querySelector(s);
        if (!c || !b) return false;
        const cr = c.getBoundingClientRect(), br = b.getBoundingClientRect();
        return br.top >= cr.top - 1 && br.bottom <= cr.bottom + 1 && br.bottom <= window.innerHeight && c.scrollTop === 0;
      }, sel);
      check(cell, `${label}: its action is visible without scrolling inside the guide`, ok);
    };

    // ---- 1: Add knowledge
    check(cell, 'a first visit shows the guide at step 1', await waitStep('add', 15000) && /Step 1 of 5/.test(await eyebrow()), await eyebrow());
    const acts = await page.locator('#st-ftue .st-ftue-acts button').allTextContents();
    check(cell, 'step 1 offers samples (primary), upload, website and a note', /Try sample files/.test(acts[0]) && acts.some((t) => /Upload files/.test(t)) && acts.some((t) => /Add your website/.test(t)) && acts.some((t) => /Write a note/.test(t)), acts.join(' | '));
    check(cell, 'one filled action in the guide', await page.locator('#st-ftue .btn-primary').count() === 1);
    await quietCheck('step 1');
    check(cell, 'step 1: the empty bot pane is one calm line (no example answer)', await page.evaluate(() => /Ask your bot anything/.test(getComputedStyle(document.getElementById('sb-thread-slot'), '::before').content)));
    if (cell.mobile) await actionInView('.st-ftue-go', 'step 1');
    if (cell.shots) await shot('1-start');
    if (!cell.mobile && cell.motion === 'full') await axe(page, cell, 'step 1');

    // Escape dismisses (persisted) and everything the guide stood in for comes back
    await page.locator('#st-ftue .st-ftue-h').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check(cell, 'Escape hides the guide', (await step()) === null);
    check(cell, 'the dismissal is saved', await page.evaluate(() => JSON.parse(localStorage.getItem('kb-ftue') || '{}').status === 'dismissed'));
    check(cell, 'dismissed: the page flag is gone and the Builder chips are back', await page.evaluate(() => !document.documentElement.hasAttribute('data-ftue')
      && [...document.querySelectorAll('#st-log .st-chip[data-chip="use_samples"]')].some((b) => b.offsetParent !== null)));
    // the empty state's note link (desktop: the bot pane shows the empty state once the guide is away)
    if (!cell.mobile) {
      const note = page.locator('.sb-empty [data-note-link]');
      await note.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const line = await page.locator('.sb-empty').first().innerText().catch(() => '');
      check(cell, 'empty state: "… Or add your website. Or write a note."', /Add a file/.test(line) && /add your website/i.test(line) && /Or write a note\./.test(line), line);
      await note.click();
      const dlg = page.locator('dialog.sb-miss-dlg[open]');
      const opened = await dlg.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      check(cell, 'it opens the note form, titled "Add a note"', opened && (await page.locator('#sb-miss-h').textContent()) === 'Add a note');
      check(cell, 'the note field has focus', await page.evaluate(() => document.activeElement?.id === 'sb-miss-a'));
      check(cell, 'tags wait behind "More options"', await page.evaluate(() => document.getElementById('sb-miss-more')?.hidden === true && document.querySelector('.sb-miss-moreopts')?.getAttribute('aria-expanded') === 'false'));
      if (cell.shots) await shot('12-empty-note');
      await page.locator('.sb-miss-moreopts').click();
      check(cell, '"More options" shows the tags', await page.evaluate(() => document.getElementById('sb-miss-more')?.hidden === false && document.activeElement?.id === 'sb-miss-t'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      check(cell, 'Escape closes it and focus returns to the link', await page.evaluate(() => !document.querySelector('dialog.sb-miss-dlg') && document.activeElement?.dataset?.noteLink === '1'));
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__studio?.store?.getState?.().trial?.status === 'ready', null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    check(cell, 'a reload keeps it hidden', (await step()) === null);
    check(cell, 'a reload with nothing built yet never says "Welcome back"', !/Welcome back/.test(await page.locator('#st-log').innerText().catch(() => '')));
    await page.locator('#st-more').click();
    await page.locator('[role="menuitem"]', { hasText: 'Show the guide' }).click();
    check(cell, '⋯ → Show the guide brings it back at step 1', await waitStep('add', 5000));
    // × hides it too, then back again
    await page.locator('#st-ftue .st-ftue-x').click();
    check(cell, '× hides the guide', (await step()) === null);
    await page.locator('#st-more').click();
    await page.locator('[role="menuitem"]', { hasText: 'Show the guide' }).click();
    await waitStep('add', 5000);

    // ---- 1 → 2: samples from the guide
    await page.locator('#st-ftue .st-ftue-go').click();
    const reading = await waitStep('reading', 15000);
    check(cell, 'Try sample files → step 2 (reading)', reading && /Step 2 of 5/.test(await eyebrow()));
    if (reading) {
      await page.waitForFunction(() => /\d+ of \d+ files? ready/.test(document.querySelector('#st-ftue .st-ftue-count')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
      const count = await page.locator('#st-ftue .st-ftue-count').textContent().catch(() => '');
      check(cell, 'step 2 shows real progress (n of m ready)', /\d+ of 4 files ready/.test(count), count);
      check(cell, 'step 2 explains the wait plainly', /Usually under a minute/.test(await page.locator('#st-ftue').innerText()));
      check(cell, 'step 2: one progress indicator (the Sources tracker and its buttons wait)', await page.evaluate(() => [...document.querySelectorAll('#in-intake-slot :is(.in-eta, .in-rm-samples, .in-btn-add)')].every((el) => el.offsetParent === null)));
      await quietCheck('step 2');
      if (cell.shots) { await page.waitForTimeout(400); await shot('2-reading'); }
    }
    // ---- 2 → 3 on firstReady
    const ask = await waitStep('ask', 60000);
    check(cell, 'firstReady → step 3 (ask)', ask && !!(await ms()).firstReady);
    await page.waitForFunction(() => /^Ask: ./.test(document.querySelector('#st-ftue .st-ftue-ask')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const askLabel = await page.locator('#st-ftue .st-ftue-ask').textContent().catch(() => '');
    check(cell, 'step 3 offers one suggested question', /^Ask: ./.test(askLabel), askLabel);
    await page.waitForTimeout(600);
    await quietCheck('step 3');
    if (cell.mobile) await actionInView('.st-ftue-ask', 'step 3');
    if (cell.shots) await shot('3-ask');
    // ---- 3 → 4 on firstCited
    await page.locator('#st-ftue .st-ftue-ask').click();
    const trip = await waitStep('trip', 60000);
    check(cell, 'a cited answer → step 4 (trip it up)', trip && !!(await ms()).firstCited);
    const tripText = await page.locator('#st-ftue').innerText();
    check(cell, 'step 4 is "Try to trip it up", with no test jargon', /Try to trip it up/.test(tripText) && !/Proof Run|full test|before going live/i.test(tripText), tripText.replace(/\s+/g, ' ').slice(0, 160));
    await page.waitForTimeout(1500);   // the Builder's reply to the first answer lands
    await quietCheck('step 4');
    if (cell.shots) await shot('4-trip');
    // ---- 4 → 5 on firstRefusal, only once the refusal has fully rendered
    await page.locator('#st-ftue .st-ftue-probe').click();
    const early = await page.waitForFunction(() => {
      const busy = !!document.querySelector('#sb-thread-slot .sb-answer[aria-busy="true"]');
      const done = document.getElementById('st-ftue')?.dataset.step === 'done';
      if (busy && done) return 'covered';
      return done ? 'ok' : null;
    }, null, { timeout: 60000, polling: 50 }).then((h) => h.jsonValue()).catch(() => 'timeout');
    check(cell, 'a refusal → step 5, never while the reply is still rendering', early === 'ok' && !!(await ms()).firstRefusal, early);
    await page.waitForTimeout(450);   // the card's entrance settles (the thread follows it to the end)
    const proofShown = await page.evaluate(() => {
      const t = document.getElementById('sb-thread-slot'); const a = [...t.querySelectorAll('.sb-answer')].pop();
      if (!a) return false;
      const tr = t.getBoundingClientRect(), ar = a.getBoundingClientRect(), cr = document.getElementById('st-ftue').getBoundingClientRect();
      return ar.bottom <= tr.bottom + 2 && ar.bottom <= cr.top + 2;
    });
    check(cell, 'the refusal stays in view above the guide (nothing behind the card)', proofShown);
    if (cell.motion === 'reduce') {
      const calm = await page.evaluate(() => ({ cv: !!document.querySelector('.st-ftue-fireworks'), c: document.getElementById('st-ftue')?.dataset.celebrated }));
      check(cell, 'reduced motion: no fireworks, a calm check instead', !calm.cv && calm.c === 'calm', JSON.stringify(calm));
    } else {
      const fw = await page.waitForSelector('.st-ftue-fireworks', { timeout: 3000 }).then(() => Date.now()).catch(() => 0);
      check(cell, 'fireworks (a short canvas burst above the card)', !!fw);
      if (cell.shots) { await page.waitForTimeout(260); await shot('5-fireworks'); }
      const gone = await page.waitForFunction(() => !document.querySelector('.st-ftue-fireworks'), null, { timeout: 3000 }).then(() => Date.now()).catch(() => 0);
      check(cell, 'the burst is over in about a second', !!gone && gone - fw < 1500, `${gone - fw} ms`);
    }
    // view A
    const viewA = await page.locator('#st-ftue').innerText();
    check(cell, 'view A: "Your bot is ready" + "Where should it answer?"', /Step 5 of 5/.test(await eyebrow()) && /Your bot is ready/.test(viewA) && /Where should it answer\?/.test(viewA));
    check(cell, 'step 5 sets data-ftue="done" (suggestions come back)', await page.evaluate(() => document.documentElement.getAttribute('data-ftue') === 'done'));
    const tools = await page.locator('#st-ftue .st-ftue-tool').allTextContents();
    check(cell, 'the three tools: Website ("A chat bubble on your site"), KnowBot number, Email', tools.length === 3 && /Website/.test(tools[0]) && /A chat bubble on your site/.test(tools[0]) && /KnowBot number/.test(tools[1]) && /Email/.test(tools[2]), tools.join(' | '));
    if (cell.mobile) await actionInView('.st-ftue-continue', 'view A');
    if (process.env.DEBUG_SHOTS) await page.screenshot({ path: path.join(SHOTS, `${cell.name}-viewA.png`) });
    if (cell.shots) await shot('6-deploy');
    await page.locator('#st-ftue .st-ftue-tool[data-tool="email"]').click();
    await page.locator('#st-ftue .st-ftue-continue').click();
    await page.waitForFunction(() => /lib\/embed\.js/.test(document.querySelector('#st-ftue .st-ftue-pre')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    const surf = await page.evaluate(() => window.__studio.store.getState().spec.surfaces);
    check(cell, 'the choice is saved as spec.surfaces (website + email)', Array.isArray(surf) && surf.includes('webchat') && surf.includes('email'), JSON.stringify(surf));
    const trialId = await page.evaluate(() => window.__studio.store.getState().trial.id);
    // view B: one recommended path
    const viewB = await page.locator('#st-ftue').innerText();
    check(cell, 'view B: "Put it on your site", three steps with the CMS hint', /Put it on your site/.test(viewB) && (await page.locator('#st-ftue .st-ftue-steps li').count()) === 3 && /Custom code|Footer scripts/.test(viewB));
    const shownLine = await page.locator('#st-ftue .st-ftue-pre').textContent().catch(() => '');
    const realLine = await page.locator('#st-ftue .st-ftue-copy').getAttribute('data-copy').catch(() => '');
    check(cell, 'the real line: bot id and api', shownLine.includes(`data-bot="${trialId}"`) && /data-api="http:\/\/127\.0\.0\.1:\d+"/.test(shownLine), shownLine.slice(0, 160));
    check(cell, 'the key: masked on screen, the real trial key on Copy (never invented)', /data-key="kb_trial_[^"]*•+/.test(shownLine) && /data-key="kb_trial_[A-Za-z0-9_.-]+"/.test(realLine || ''), (realLine || '').match(/data-key="[^"]*"/)?.[0]);
    check(cell, 'Copy is the one primary; no Launch, no "Change where it answers", no stats footnote in the card',
      await page.locator('#st-ftue .btn-primary').count() === 1 && /Copy the line/.test(await page.locator('#st-ftue .btn-primary').textContent()) && !/Launch\b|Change where it answers|Check your stats/.test(viewB.replace(/once you launch/g, '')));
    check(cell, 'the other ways wait behind a quiet "Other ways"', await page.evaluate(() => document.getElementById('st-ftue-other')?.hidden === true && document.querySelector('#st-ftue .st-ftue-more')?.getAttribute('aria-expanded') === 'false'));
    check(cell, 'no vendor names in the guide', !/twilio|stripe|shopify|gemini|resend|postmark|claude code|cursor/i.test(viewB));
    if (cell.mobile) await actionInView('.st-ftue-copy', 'view B');
    if (cell.shots) { await cardTop(); await shot('7-whatsnext-agent'); }
    if (!cell.mobile && cell.motion === 'full') await axe(page, cell, 'view B');
    await page.locator('#st-ftue .st-ftue-more').click();
    const agent = await page.locator('#st-ftue .st-ftue-copy-agent').getAttribute('data-copy').catch(() => '');
    check(cell, 'Other ways: an AI-agent prompt (before </body>, the real line, how to check it)', /before the closing <\/body>/.test(agent) && agent.includes(`data-bot="${trialId}"`) && /confirm a chat bubble/.test(agent));
    const mail = await page.locator('#st-ftue .st-ftue-mail').getAttribute('href').catch(() => '');
    check(cell, 'Other ways: a developer e-mail (mailto) with the line and the steps', /^mailto:\?subject=/.test(mail || '') && decodeURIComponent(mail || '').includes('lib/embed.js') && /before <\/body>/.test(decodeURIComponent(mail || '')));
    if (cell.shots) { await page.locator('#st-ftue .st-ftue-more').scrollIntoViewIfNeeded(); await shot('8-whatsnext-dev'); }
    await cardTop();
    await page.locator('#st-ftue .st-ftue-copy').click();
    check(cell, 'Copy confirms in words', await page.waitForFunction(() => /Copied|Select and copy/.test(document.querySelector('#st-ftue .st-ftue-copy')?.textContent || ''), null, { timeout: 3000 }).then(() => true).catch(() => false));
    if (cell.shots) { await cardTop(); await shot('9-whatsnext-diy'); }
    if (cell.name === 'desktop-dark') { await page.locator('#st-ftue .st-ftue-more').click(); await page.waitForTimeout(300); await cardTop(); await page.screenshot({ path: path.join(SHOTS, '10-dark.png') }); }
    if (cell.name === 'mobile-light') { await page.locator('#st-ftue .st-ftue-more').click(); await page.waitForTimeout(300); await cardTop(); await page.screenshot({ path: path.join(SHOTS, '11-mobile.png') }); }
    const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(cell, 'no horizontal scroll', !hscroll);
    if (cell.mobile) check(cell, 'phones: the header says "Launch", not the price', /^\s*Launch\s*$/.test(await page.locator('#st-price').innerText().catch(() => '')));

    // ---- Stats & Leads
    if (!cell.mobile) {
      const pulsed = await page.waitForFunction(() => document.getElementById('st-leads')?.classList.contains('is-guide-pulse'), null, { timeout: 4000 }).then(() => true).catch(() => false);
      check(cell, 'the guide points at Stats & Leads (a gentle pulse)', pulsed);
      const btn = page.locator('#st-leads');
      check(cell, 'Stats & Leads sits in the header, left of Launch, with no border', await btn.isVisible() && (await btn.textContent()) === 'Stats & Leads'
        && await page.evaluate(() => document.getElementById('st-leads').getBoundingClientRect().right <= document.getElementById('st-price').getBoundingClientRect().left
          && getComputedStyle(document.getElementById('st-leads')).borderTopWidth === '0px'));
      await btn.click();
      const dlg = await page.locator('dialog.kb-leads[open]').waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      check(cell, 'it opens the Stats & Leads report', dlg && (await page.locator('#kb-leads-title').textContent()) === 'Stats & Leads');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      check(cell, 'Escape closes it; focus returns to the header button', await page.evaluate(() => !document.querySelector('dialog.kb-leads') && document.activeElement?.id === 'st-leads'));
    } else {
      check(cell, 'phones: Stats & Leads is not crammed into the header', !(await page.locator('#st-leads').isVisible()));
      await page.locator('#st-more').click();
      const item = page.locator('[role="menuitem"]', { hasText: 'Stats & Leads' });
      check(cell, 'phones: ⋯ has Stats & Leads', await item.isVisible().catch(() => false));
      await item.click();
      check(cell, 'phones: it opens the report', await page.locator('dialog.kb-leads[open]').waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
      await page.keyboard.press('Escape');
    }
    // Done: the guide is finished and stays finished
    await page.locator('#st-ftue .st-ftue-finish').click();
    check(cell, '"Done" hides the guide and remembers', (await step()) === null && await page.evaluate(() => JSON.parse(localStorage.getItem('kb-ftue') || '{}').status === 'done' && !document.documentElement.hasAttribute('data-ftue')));
    check(cell, 'no page errors', errors.length === 0, errors.slice(0, 3).join(' || '));
    await context.close();
  }
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser?.close();
  await dev.close();
}
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'} · screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// The first-time guide (studio/ftue.js), end to end in a real browser (Playwright) against studio/test/dev-server.mjs
// (fake knowDrive + fake model on 127.0.0.1; never a real service). Each cell walks a brand-new visitor through it:
//
//   empty state  "… Or write a note." opens the note form titled "Add a note"; Escape closes it
//   1 Add        the guide shows "Step 1 of 5"; Escape hides it (persisted across a reload); ⋯ → Show the guide restores
//   1 → 2        "Try sample files" in the guide attaches the samples; the step reads "n of m files ready"
//   2 → 3        advances on milestones.firstReady; offers one suggested question
//   3 → 4        asking it advances on milestones.firstCited (a cited answer)
//   4 → 5        "Ask something off-topic" advances on milestones.firstRefusal
//   5            fireworks (a canvas burst; a calm check with reduced motion), "Where should it answer?" (saves
//                spec.surfaces), then "What's next?" with three tabs carrying the real website line (bot id, api, the
//                trial key masked on screen and real on Copy), a mailto link, Launch, and the Stats & Leads pointer
//   Stats & Leads opens from the header (desktop; ⋯ on phones); Escape returns focus to the header button
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

    // ---- 1: Add knowledge
    check(cell, 'a first visit shows the guide at step 1', await waitStep('add', 15000) && /Step 1 of 5/.test(await eyebrow()), await eyebrow());
    const acts = await page.locator('#st-ftue .st-ftue-acts button').allTextContents();
    check(cell, 'step 1 offers samples (primary), upload, website and a note', /Try sample files/.test(acts[0]) && acts.some((t) => /Upload files/.test(t)) && acts.some((t) => /Add your website/.test(t)) && acts.some((t) => /Write a note/.test(t)), acts.join(' | '));
    check(cell, 'one filled action in the guide', await page.locator('#st-ftue .btn-primary').count() === 1);
    if (cell.shots) await shot('1-start');
    if (!cell.mobile && cell.motion === 'full') await axe(page, cell, 'step 1');

    // the empty state's note link (desktop: the bot pane shows the empty state)
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
      if (cell.shots) await shot('12-empty-note');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      check(cell, 'Escape closes it and focus returns to the link', await page.evaluate(() => !document.querySelector('dialog.sb-miss-dlg') && document.activeElement?.dataset?.noteLink === '1'));
    }

    // Escape dismisses, persisted; ⋯ → Show the guide restores
    await page.locator('#st-ftue .st-ftue-h').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check(cell, 'Escape hides the guide', (await step()) === null);
    check(cell, 'the dismissal is saved', await page.evaluate(() => JSON.parse(localStorage.getItem('kb-ftue') || '{}').status === 'dismissed'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__studio?.store?.getState?.().trial?.status === 'ready', null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
    check(cell, 'a reload keeps it hidden', (await step()) === null);
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
      if (cell.shots) { await page.waitForTimeout(400); await shot('2-reading'); }
    }
    // ---- 2 → 3 on firstReady
    const ask = await waitStep('ask', 60000);
    check(cell, 'firstReady → step 3 (ask)', ask && !!(await ms()).firstReady);
    await page.waitForFunction(() => /^Ask: ./.test(document.querySelector('#st-ftue .st-ftue-ask')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const askLabel = await page.locator('#st-ftue .st-ftue-ask').textContent().catch(() => '');
    check(cell, 'step 3 offers one suggested question', /^Ask: ./.test(askLabel), askLabel);
    if (cell.shots) { await page.waitForTimeout(600); await shot('3-ask'); }
    // ---- 3 → 4 on firstCited
    await page.locator('#st-ftue .st-ftue-ask').click();
    const trip = await waitStep('trip', 60000);
    check(cell, 'a cited answer → step 4 (trip it up)', trip && !!(await ms()).firstCited);
    check(cell, 'step 4 offers the full test too', await page.locator('#st-ftue .st-ftue-test').isVisible().catch(() => false));
    if (cell.shots) { await page.waitForTimeout(800); await shot('4-trip'); }
    // ---- 4 → 5 on firstRefusal
    await page.locator('#st-ftue .st-ftue-probe').click();
    const done = await waitStep('done', 60000);
    check(cell, 'a refusal → step 5 (done)', done && !!(await ms()).firstRefusal);
    if (cell.motion === 'reduce') {
      const calm = await page.evaluate(() => ({ cv: !!document.querySelector('.st-ftue-fireworks'), c: document.getElementById('st-ftue')?.dataset.celebrated }));
      check(cell, 'reduced motion: no fireworks, a calm check instead', !calm.cv && calm.c === 'calm', JSON.stringify(calm));
    } else {
      const fw = await page.waitForSelector('.st-ftue-fireworks', { timeout: 3000 }).then(() => true).catch(() => false);
      check(cell, 'fireworks (a canvas burst)', fw);
      if (cell.shots) { await page.waitForTimeout(350); await shot('5-fireworks'); }
      const gone = await page.waitForFunction(() => !document.querySelector('.st-ftue-fireworks'), null, { timeout: 4000 }).then(() => true).catch(() => false);
      check(cell, 'the burst clears itself in about 2 s', gone);
    }
    check(cell, '"Step 5 of 5" and "Where should it answer?"', /Step 5 of 5/.test(await eyebrow()) && /Where should it answer\?/.test(await page.locator('#st-ftue').innerText()));
    const tools = await page.locator('#st-ftue .st-ftue-tool').allTextContents();
    check(cell, 'the three tools: Website, KnowBot number, Email', tools.length === 3 && /Website/.test(tools[0]) && /KnowBot number/.test(tools[1]) && /Email/.test(tools[2]), tools.join(' | '));
    if (cell.shots) await shot('6-deploy');
    await page.locator('#st-ftue .st-ftue-tool[data-tool="email"]').click();
    await page.locator('#st-ftue .st-ftue-continue').click();
    await page.waitForSelector('#st-ftue .st-ftue-tabs', { timeout: 10000 }).catch(() => {});
    const surf = await page.evaluate(() => window.__studio.store.getState().spec.surfaces);
    check(cell, 'the choice is saved as spec.surfaces (website + email)', Array.isArray(surf) && surf.includes('webchat') && surf.includes('email'), JSON.stringify(surf));
    const trialId = await page.evaluate(() => window.__studio.store.getState().trial.id);
    // What's next: three tabs, a real line
    const tabs = await page.locator('#st-ftue [role="tab"]').allTextContents();
    check(cell, 'What’s next: three tabs', tabs.join('|') === 'Ask your AI agent|Send to your developer|Do it yourself', tabs.join('|'));
    await page.waitForFunction(() => /lib\/embed\.js/.test(document.querySelector('#st-ftue .st-ftue-pre')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    const agent = await page.locator('#st-ftue .st-ftue-pre').textContent().catch(() => '');
    const agentCopy = await page.locator('#st-ftue .st-ftue-copy').getAttribute('data-copy').catch(() => '');
    check(cell, 'agent prompt: before </body>, the real line (bot id, api) and how to check', /before the closing <\/body>/.test(agent) && agent.includes(`data-bot="${trialId}"`) && /data-api="http:\/\/127\.0\.0\.1:\d+"/.test(agent) && /confirm a chat bubble/.test(agent), agent.slice(0, 200));
    check(cell, 'the key: masked on screen, the real trial key on Copy (never invented)', /data-key="kb_trial_[^"]*•+/.test(agent) && /data-key="kb_trial_[A-Za-z0-9_.-]+"/.test(agentCopy || ''), (agentCopy || '').match(/data-key="[^"]*"/)?.[0]);
    check(cell, 'no vendor names in the guide', !/twilio|stripe|shopify|gemini|resend|postmark|claude code|cursor/i.test(await page.locator('#st-ftue').innerText()));
    await page.locator('#st-ftue .st-ftue-copy').click();
    check(cell, 'Copy confirms in words', await page.waitForFunction(() => /Copied|Select and copy/.test(document.querySelector('#st-ftue .st-ftue-copy')?.textContent || ''), null, { timeout: 3000 }).then(() => true).catch(() => false));
    check(cell, 'Launch is the one primary action', await page.locator('#st-ftue .btn-primary').count() === 1 && /Launch/.test(await page.locator('#st-ftue .btn-primary').textContent()));
    if (cell.shots) { await cardTop(); await shot('7-whatsnext-agent'); }
    if (!cell.mobile && cell.motion === 'full') await axe(page, cell, 'What’s next');
    // keyboard: ArrowRight moves between tabs
    await page.locator('#st-ftue [role="tab"][aria-selected="true"]').focus();
    await page.keyboard.press('ArrowRight');
    check(cell, 'ArrowRight selects "Send to your developer"', await page.evaluate(() => document.activeElement?.dataset?.tab === 'dev' && document.activeElement.getAttribute('aria-selected') === 'true'));
    await page.waitForSelector('#st-ftue .st-ftue-mail', { timeout: 5000 }).catch(() => {});
    const mail = await page.locator('#st-ftue .st-ftue-mail').getAttribute('href').catch(() => '');
    check(cell, 'developer: a mailto with the line and the steps', /^mailto:\?subject=/.test(mail || '') && decodeURIComponent(mail || '').includes('lib/embed.js') && /before <\/body>/.test(decodeURIComponent(mail || '')));
    if (cell.shots) { await cardTop(); await shot('8-whatsnext-dev'); }
    await page.locator('#st-ftue [role="tab"][data-tab="diy"]').click();
    await page.waitForSelector('#st-ftue .st-ftue-steps', { timeout: 5000 }).catch(() => {});
    const diy = await page.locator('#st-ftue .st-ftue-panel').innerText().catch(() => '');
    check(cell, 'do it yourself: three steps, the CMS hint and the line', (await page.locator('#st-ftue .st-ftue-steps li').count()) === 3 && /Custom code|Footer scripts/.test(diy) && /lib\/embed\.js/.test(diy));
    if (cell.shots) { await cardTop(); await shot('9-whatsnext-diy'); }
    if (cell.name === 'desktop-dark') { await page.locator('#st-ftue [role="tab"][data-tab="agent"]').click(); await page.waitForTimeout(300); await cardTop(); await page.screenshot({ path: path.join(SHOTS, '10-dark.png') }); }
    if (cell.name === 'mobile-light') { await page.locator('#st-ftue [role="tab"][data-tab="agent"]').click(); await page.waitForTimeout(300); await cardTop(); await page.screenshot({ path: path.join(SHOTS, '11-mobile.png') }); }
    const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(cell, 'no horizontal scroll', !hscroll);

    // ---- Stats & Leads
    if (!cell.mobile) {
      const pulsed = await page.waitForFunction(() => document.getElementById('st-leads')?.classList.contains('is-guide-pulse'), null, { timeout: 4000 }).then(() => true).catch(() => false);
      check(cell, 'the guide points at Stats & Leads (a gentle pulse)', pulsed);
      const btn = page.locator('#st-leads');
      check(cell, 'Stats & Leads sits in the header, left of Launch', await btn.isVisible() && (await btn.textContent()) === 'Stats & Leads'
        && await page.evaluate(() => document.getElementById('st-leads').getBoundingClientRect().right <= document.getElementById('st-price').getBoundingClientRect().left));
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
    // Finish: the guide is done and stays done
    await page.locator('#st-ftue .st-ftue-finish').click();
    check(cell, 'Finish the guide hides it and remembers', (await step()) === null && await page.evaluate(() => JSON.parse(localStorage.getItem('kb-ftue') || '{}').status === 'done'));
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

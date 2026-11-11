#!/usr/bin/env node
// Voice mode smoke (lib/voice-orb.js, lib/voice-mode.js; the mic in site/overlay.js and in the Studio's web chat) against
// studio/test/dev-server.mjs (fake knowDrive + fake model on 127.0.0.1; the voice session runs its browser engine there).
// Chromium gets a fake microphone (a beeping test tone) and auto-accepts the mic prompt. Checks:
//   - the orb: renders with WebGL (and the Canvas2D fallback), follows a real audio level (an OscillatorNode through an
//     AnalyserNode: loud → high level, silence → back down), animates (frames advance, pixels change), grows with the
//     level, pauses off screen, reduced motion still draws; its frame cost is printed;
//   - the Studio: Set up → Homepage search has the colour picker (four presets, a live preview orb); a choice saves at once;
//   - the Studio's web chat: the mic opens voice mode over the bot pane in the saved colour; End and Esc close it;
//   - the Homepage search: the mic opens voice mode in the saved colour, the orb hears the fake mic, a typed question is
//     answered (thinking → speaking, sources as links, transcript), Esc goes back to the search box, then closes;
//     light and dark; no page errors; the overlay still leaks no globals.
//
//   node studio/test/voice-smoke.mjs                    # screenshots to studio/test/screens/voice/ (not committed)
//   VOICE_SHOTS=/some/dir node studio/test/voice-smoke.mjs
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.VOICE_SHOTS || path.join(__dirname, 'screens', 'voice');
const PRESETS = ['ocean', 'violet', 'sunset', 'mint', 'ruby', 'midnight', 'silver'];
let failed = 0;
const check = (cell, name, ok, detail = '') => { if (!ok) failed++; console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${cell} ${name}${detail ? ` · ${String(detail).slice(0, 300)}` : ''}`); return ok; };

const dev = await startDevServer({ speed: 4, quiet: true });
const api = (p, init = {}) => fetch(`${dev.url}${p}`, init);
let browser = null;
try {
  // ------------------------------------------------------------------ a bot with a published Homepage search
  const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
  const H = (x = {}) => ({ authorization: `Bearer ${t.token}`, ...x });
  await api(`/api/studio/trials/${t.trialId}/samples`, { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ set: 'lumen-bikes' }) });
  await api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ name: 'Lumen Bikes Help', surfaces: ['webchat', 'site'] }) });
  for (let i = 0; i < 240; i++) {
    const j = await (await api(`/api/studio/trials/${t.trialId}`, { headers: H() })).json();
    if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const siteApi = (method = 'GET', body) => api(`/api/studio/trials/${t.trialId}/site`, { method, headers: H(body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const built = await siteApi();
  check('setup', 'the site defaults to the Ocean orb', built.site?.orb === 'ocean', built.site?.orb);
  await siteApi('POST', { published: true });

  browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  await fsp.mkdir(SHOTS, { recursive: true });

  // ------------------------------------------------------------------ the orb on its own
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.url}/lib/voice-orb.js`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      document.body.innerHTML = '';
      document.body.style.cssText = 'margin:0;font:14px system-ui';
      const m = await import('/lib/voice-orb.js');
      window.__m = m;
      const add = (id, css) => { const c = document.createElement('canvas'); c.id = id; c.style.cssText = `width:200px;height:200px;display:block;${css || ''}`; document.body.append(c); return c; };
      add('gl');
      add('c2d');
      const ac = new AudioContext();
      const osc = ac.createOscillator(); osc.frequency.value = 220;
      const gain = ac.createGain(); gain.gain.value = 0.6;
      const an = ac.createAnalyser();
      osc.connect(gain); gain.connect(an);
      osc.start();
      await ac.resume();
      window.__gain = gain;
      const meter = m.createMeter(an);
      for (const [id, renderer] of [['gl', 'webgl'], ['c2d', '2d']]) {
        const orb = m.createOrb(document.getElementById(id), { preset: 'violet', renderer, reducedMotion: false });
        orb.setState('listening');
        orb.setLevelSource(meter);
      }
    });
    await page.waitForTimeout(900);
    const loud = await page.evaluate(() => ({ gl: document.getElementById('gl').kbOrb.level, c2d: document.getElementById('c2d').kbOrb.level, stats: document.getElementById('gl').kbOrb.stats(), s2: document.getElementById('c2d').kbOrb.stats() }));
    check('orb', 'WebGL renderer, Canvas2D fallback', loud.stats.renderer === 'webgl' && loud.s2.renderer === '2d', `${loud.stats.renderer} / ${loud.s2.renderer}`);
    check('orb', 'a loud tone through the analyser lifts the level at once', loud.gl > 0.5 && loud.c2d > 0.5, JSON.stringify({ gl: loud.gl, c2d: loud.c2d }));
    check('orb', 'the loop runs (frames advance)', loud.stats.frames > 10 && loud.stats.running, JSON.stringify(loud.stats));
    console.log(`  [info] orb frame cost (JS + draw calls): WebGL avg ${loud.stats.avgMs.toFixed(3)} ms, p95 ${loud.stats.p95Ms.toFixed(3)} ms, max ${loud.stats.maxMs.toFixed(2)} ms; Canvas2D avg ${loud.s2.avgMs.toFixed(3)} ms, p95 ${loud.s2.p95Ms.toFixed(3)} ms`);
    // the 2D fallback is readable: count the orb's pixels loud vs silent (it grows with the level)
    const area = () => page.evaluate(() => { const c = document.getElementById('c2d'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++; return n; });
    const loudArea = await area();
    const shotA = await page.locator('#gl').screenshot();
    await page.waitForTimeout(250);
    const shotB = await page.locator('#gl').screenshot();
    check('orb', 'it animates (two WebGL frames differ)', !shotA.equals(shotB));
    await page.evaluate(() => { window.__gain.gain.value = 0; });
    await page.waitForTimeout(900);
    const quiet = await page.evaluate(() => document.getElementById('gl').kbOrb.level);
    const quietArea = await area();
    check('orb', 'silence: the level falls back (release)', quiet < 0.15, quiet.toFixed(3));
    check('orb', 'the orb is bigger while the voice is loud', loudArea > quietArea * 1.08, `${loudArea} vs ${quietArea}`);
    // states and presets, and a feed of a synthetic level
    const fed = await page.evaluate(async () => {
      const o = document.getElementById('gl').kbOrb;
      o.setLevelSource(() => 0.9);
      o.setState('speaking');
      await new Promise((r) => setTimeout(r, 300));
      const a = o.level;
      o.setState('thinking');
      await new Promise((r) => setTimeout(r, 400));
      o.setPreset('mint');
      return { speaking: a, thinking: o.level, preset: o.preset, unknown: window.__m.orbId('neon') };
    });
    check('orb', 'speaking follows its source; thinking ignores levels; presets switch; unknown → default', fed.speaking > 0.8 && fed.thinking < 0.5 && fed.preset === 'mint' && fed.unknown === 'ocean', JSON.stringify(fed));
    // off screen: the loop stops; back on screen: it runs again
    await page.evaluate(() => { document.getElementById('gl').style.cssText += ';position:absolute;top:-5000px'; });
    await page.waitForTimeout(300);
    const off = await page.evaluate(() => document.getElementById('gl').kbOrb.running);
    await page.evaluate(() => { document.getElementById('gl').style.position = 'static'; });
    await page.waitForTimeout(300);
    const on = await page.evaluate(() => document.getElementById('gl').kbOrb.running);
    check('orb', 'pauses off screen, resumes on screen', off === false && on === true, JSON.stringify({ off, on }));
    const rm = await page.evaluate(async () => { const c = document.createElement('canvas'); c.style.cssText = 'width:120px;height:120px'; document.body.append(c); const o = window.__m.createOrb(c, { reducedMotion: true }); o.setState('listening'); o.setLevelSource(() => 0.5); await new Promise((r) => setTimeout(r, 300)); const s = o.stats(); o.destroy(); return { frames: s.frames, gone: !c.kbOrb }; });
    check('orb', 'reduced motion still draws (a gentle pulse); destroy cleans up', rm.frames > 3 && rm.gone, JSON.stringify(rm));
    // every preset, on light and on dark
    await page.evaluate(async () => {
      document.body.innerHTML = '';
      for (const theme of ['light', 'dark']) {
        const row = document.createElement('div');
        row.id = `row-${theme}`;
        row.style.cssText = `display:flex;gap:8px;padding:16px;background:${theme === 'dark' ? '#15151f' : '#ffffff'}`;
        document.body.append(row);
        for (const p of window.__m.ORB_IDS) {
          const cell = document.createElement('figure');
          cell.id = `${p}-${theme}`;
          cell.style.cssText = `margin:0;width:220px;text-align:center;color:${theme === 'dark' ? '#d4d4de' : '#33333f'}`;
          const c = document.createElement('canvas'); c.style.cssText = 'width:220px;height:220px;display:block';
          const cap = document.createElement('figcaption'); cap.textContent = window.__m.ORB_PRESETS[p].label;
          cell.append(c, cap); row.append(cell);
          const o = window.__m.createOrb(c, { preset: p, reducedMotion: false });
          o.setState('listening');
          const t0 = performance.now();
          o.setLevelSource(() => 0.35 + 0.25 * Math.sin((performance.now() - t0) / 180));
        }
      }
    });
    await page.waitForTimeout(800);
    for (const p of PRESETS) for (const th of ['light', 'dark']) await page.locator(`#${p}-${th}`).screenshot({ path: path.join(SHOTS, `preset-${p}-${th}.png`) });
    await page.locator('#row-light').screenshot({ path: path.join(SHOTS, 'presets-light.png') });
    await page.locator('#row-dark').screenshot({ path: path.join(SHOTS, 'presets-dark.png') });
    check('orb', 'no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------------ the Studio: picker, then web chat voice mode
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 2 });
    await ctx.addInitScript(() => { try { localStorage.setItem('kb-landing', 'skip'); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.studioUrl}?t=${t.trialId}&k=${encodeURIComponent(t.restoreKey)}`, { waitUntil: 'load' });
    await page.waitForSelector('.sh-opt[data-shape="webchat"]', { timeout: 30000 });
    await page.click('.sh-opt[data-shape="webchat"]');
    await page.evaluate(() => { const b = document.querySelector('.st-seg-setup'); if (b) { b.hidden = false; b.click(); } });
    await page.waitForSelector('.gl-chcard[data-ch="site"]', { timeout: 20000 });
    await page.click('.gl-chcard[data-ch="site"]');
    await page.waitForSelector('.gl-sp .ss-orbs', { timeout: 20000 });
    const opts = await page.$$eval('.gl-sp .ss-orb-in', (rs) => rs.map((r) => ({ v: r.value, on: r.checked, label: r.closest('label').textContent.trim() })));
    check('studio', 'the picker: seven colours, named, the saved one chosen', opts.length === 7 && opts.map((o) => o.label).join(',') === 'Ocean,Violet,Sunset,Mint,Ruby,Midnight,Silver' && opts.find((o) => o.on)?.v === 'ocean', JSON.stringify(opts));
    const pv = await page.$eval('.gl-sp .ss-orb-canvas', (c) => c.kbOrb && { r: c.kbOrb.renderer, p: c.kbOrb.preset });
    check('studio', 'a live preview orb', pv && pv.r !== 'none' && pv.p === 'ocean', JSON.stringify(pv));
    await page.locator('.gl-sp .ss-orb-opt[for$="-orb-sunset"]').click();
    await page.waitForFunction(() => /Sunset orb/.test(document.querySelector('.gl-sp .ss-status')?.textContent || ''), null, { timeout: 15000 });
    const savedOrb = (await siteApi()).site.orb;
    check('studio', 'choosing Sunset saves at once; the preview follows', savedOrb === 'sunset' && await page.$eval('.gl-sp .ss-orb-canvas', (c) => c.kbOrb.preset) === 'sunset', savedOrb);
    // keyboard: arrows move between the colours (native radios)
    await page.focus('.gl-sp .ss-orb-in[value="sunset"]');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => /Mint orb/.test(document.querySelector('.gl-sp .ss-status')?.textContent || ''), null, { timeout: 15000 });
    check('studio', 'keyboard: an arrow key picks the next colour and saves it', (await siteApi()).site.orb === 'mint');
    await page.locator('.gl-sp .ss-orbs').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.locator('.gl-sp .ss-orbs').screenshot({ path: path.join(SHOTS, 'studio-colour-picker.png') });
    await page.locator('.gl-sp .ss-orb-opt[for$="-orb-sunset"]').click();
    await page.waitForFunction(() => /Sunset orb/.test(document.querySelector('.gl-sp .ss-status')?.textContent || ''), null, { timeout: 15000 });

    // web chat: back to the chat, the mic in the composer
    await page.goto(`${dev.studioUrl}?t=${t.trialId}&k=${encodeURIComponent(t.restoreKey)}`, { waitUntil: 'load' });
    await page.waitForSelector('.sb-mic', { timeout: 30000 });
    check('studio', 'web chat: a labelled mic in the composer', /voice mode/i.test(await page.getAttribute('.sb-mic', 'aria-label')));
    await page.click('.sb-mic');
    await page.waitForSelector('.sb-voice .kbvm[data-state="listening"]', { timeout: 20000 });
    const wc = await page.evaluate(() => { const st = document.querySelector('.sb-voice .kbvm-stage'); const c = st.querySelector('canvas'); return { orb: st.dataset.orb, preset: c.kbOrb.preset, renderer: c.kbOrb.renderer, focus: document.activeElement?.classList.contains('kbvm') }; });
    check('studio', 'web chat: voice mode opens over the bot pane in the saved colour, focus inside', wc.orb === 'sunset' && wc.preset === 'sunset' && wc.renderer !== 'none' && wc.focus, JSON.stringify(wc));
    await page.waitForTimeout(900);
    const lvl = await page.evaluate(() => document.querySelector('.sb-voice canvas').kbOrb.level);
    check('studio', 'web chat: the orb hears the (fake) microphone', lvl > 0.05, lvl.toFixed(3));
    await page.screenshot({ path: path.join(SHOTS, 'webchat-voice-light.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sb-voice', { state: 'detached', timeout: 5000 });
    check('studio', 'web chat: Esc ends voice mode, focus back on the mic', await page.evaluate(() => document.activeElement?.classList.contains('sb-mic')));
    // dark Studio
    await page.evaluate(() => { localStorage.setItem('knowbot-theme', 'dark'); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.sb-mic', { timeout: 30000 });
    await page.click('.sb-mic');
    await page.waitForSelector('.sb-voice .kbvm[data-state="listening"]', { timeout: 20000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, 'webchat-voice-dark.png') });
    await page.click('.sb-voice .kbvm-end');
    await page.waitForSelector('.sb-voice', { state: 'detached', timeout: 5000 });
    check('studio', 'web chat: End closes voice mode', true);
    check('studio', 'no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------------ the Homepage search (hosted link), light and dark
  for (const theme of ['light', 'dark']) {
    const cell = `overlay-${theme}`;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${dev.url}/site/?bot=${t.trialId}`, { waitUntil: 'load' });
    await page.locator('knowbot-overlay .dialog').waitFor({ state: 'visible', timeout: 15000 });
    const mic = page.locator('knowbot-overlay .mic');
    const size = await mic.boundingBox();
    check(cell, 'a labelled mic in the search box, 44px', (await mic.getAttribute('aria-label')) === 'Ask by voice' && size.width >= 44 && size.height >= 44);
    await mic.click();
    await page.locator('knowbot-overlay .kbvm[data-state="listening"]').waitFor({ timeout: 20000 });
    const sr = (fn) => page.evaluate(`(${fn})(document.querySelector('knowbot-overlay').shadowRoot)`);
    const s0 = await sr((r) => ({ orb: r.querySelector('.kbvm-stage').dataset.orb, theme: r.querySelector('.kbvm').dataset.theme, col: r.querySelector('.col').hidden, focus: r.activeElement?.classList.contains('kbvm') }));
    check(cell, 'voice mode replaces the search, in the owner’s colour and the page theme, focus inside', s0.orb === 'sunset' && s0.theme === theme && s0.col === true && s0.focus, JSON.stringify(s0));
    await page.waitForTimeout(1000);
    const heard = await sr((r) => r.querySelector('.kbvm-orb').kbOrb.level);
    check(cell, 'the orb hears the (fake) microphone', heard > 0.05, heard.toFixed(3));
    await page.screenshot({ path: path.join(SHOTS, `overlay-voice-${theme}.png`) });
    // a typed question in voice mode: thinking, then the answer is spoken with its sources
    await page.locator('knowbot-overlay .kbvm-type input').fill(built.site.questions[0] || 'How long is the warranty?');
    // every state change, recorded in the page
    await sr((r) => { const v = r.querySelector('.kbvm'); window.__states = []; new MutationObserver(() => window.__states.push(v.dataset.state)).observe(v, { attributes: true, attributeFilter: ['data-state'] }); });
    await page.locator('knowbot-overlay .kbvm-type input').press('Enter');
    await page.waitForFunction(() => document.querySelector('knowbot-overlay').shadowRoot.querySelectorAll('.kbvm-log li').length >= 2, null, { timeout: 30000 });
    await page.waitForTimeout(200);
    const states = new Set(await page.evaluate(() => window.__states));
    const a = await sr((r) => ({ log: r.querySelectorAll('.kbvm-log li').length, chips: r.querySelectorAll('.kbvm-chip').length, links: [...r.querySelectorAll('a.kbvm-chip')].map((x) => x.href), cap: r.querySelector('.kbvm-cap').textContent, state: r.querySelector('.kbvm').dataset.state }));
    states.add(a.state);
    check(cell, 'a typed question: thinking, then speaking, with sources and a transcript', states.has('thinking') && states.has('speaking') && a.log >= 2 && a.chips >= 1 && a.cap.length > 10, JSON.stringify({ states: [...states], ...a }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, `overlay-voice-answer-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const back = await sr((r) => ({ voice: !!r.querySelector('.kbvm'), col: r.querySelector('.col').hidden, open: !r.querySelector('.dialog').hidden, focus: r.activeElement?.className }));
    check(cell, 'Esc ends voice mode first: back to the search box, still open, focus on the mic', !back.voice && back.col === false && back.open && back.focus === 'mic', JSON.stringify(back));
    await page.keyboard.press('Escape');
    check(cell, 'a second Esc closes the overlay', await sr((r) => r.querySelector('.dialog').hidden));
    check(cell, 'no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------------ a denied microphone: words, and typing still works
  {
    // the visitor said no to the browser's microphone prompt
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
    const page = await ctx.newPage();
    await page.goto(`${dev.url}/site/?bot=${t.trialId}`, { waitUntil: 'load' });
    await page.locator('knowbot-overlay .mic').click();
    await page.locator('knowbot-overlay .kbvm-err:not([hidden])').waitFor({ timeout: 20000 }).catch(() => {});
    const e = await page.evaluate(() => { const r = document.querySelector('knowbot-overlay').shadowRoot; return { err: r.querySelector('.kbvm-err')?.textContent || '', state: r.querySelector('.kbvm')?.dataset.state, input: !!r.querySelector('.kbvm-type input') }; });
    check('denied', 'a blocked mic is explained in words, the orb rests, typing stays available', /Microphone access is blocked/.test(e.err) && e.state === 'idle' && e.input, JSON.stringify(e));
    await page.screenshot({ path: path.join(SHOTS, 'overlay-voice-mic-denied.png') });
    await ctx.close();
  }
} catch (e) {
  failed++;
  console.error(e);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall voice checks passed');
console.log(`screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);

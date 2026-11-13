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
//     light and dark; no page errors; the overlay still leaks no globals;
//   - product cards in the chat bubble's voice mode (lib/embed.js, a bot that imported the fake store), desktop and phone:
//     a product answer shows the web chat's cards under the spoken answer (new-tab links, named, focusable, inside the
//     panel), its product page is not repeated as a source chip, nothing spoken holds a URL, and the spoken answer says
//     it is on screen; a policy answer shows no cards;
//   - barge-in (live engine, a stub voice socket): the visitor talking over the bot pauses its voice at once, before the
//     server's "interrupted"; "interrupted" then stops it; a false alarm resumes;
//   - the Studio's Voice settings (Set up): the voice picker (30 voices, Kore by default), the reply language, the
//     message-taking switch, and the hand-off number and hours (a bad number is refused in words), each saved to the spec.
//
//   node studio/test/voice-smoke.mjs                    # screenshots to studio/test/screens/voice/ (not committed)
//   VOICE_SHOTS=/some/dir node studio/test/voice-smoke.mjs
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
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

// one IP opens more voice sessions here than the default 6 a minute (every check opens its own)
const dev = await startDevServer({ speed: 4, quiet: true, env: { KNOWBOT_WEBVOICE_RATE_LIMIT: '30' } });
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
    await page.waitForSelector('.sh-tool[data-tool="website"]', { timeout: 30000 });
    await page.click('.sh-tool[data-tool="website"]'); await page.click('.sh-view[data-shape="webchat"]');
    await page.evaluate(() => { const b = document.querySelector('.st-seg-setup'); if (b) { b.hidden = false; b.click(); } });
    await page.waitForSelector('.gl-feat-open[data-ch="site"]', { timeout: 20000 });
    await page.click('.gl-feat-open[data-ch="site"]');
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


  // ------------------------------------------------------------------ barge-in: local voice activity stops the bot's voice (N7)
  {
    // a continuous tone as the fake microphone (the default fake device only beeps), and a stub voice socket that
    // plays the live engine: ready, then the bot's 24 kHz voice for a few seconds
    const wav = path.join(os.tmpdir(), `kb-barge-tone-${process.pid}.wav`);
    const rate = 16000, secs = 12, n = rate * secs;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / rate)), 44 + i * 2);
    await fsp.mkdir(path.dirname(wav), { recursive: true });
    await fsp.writeFile(wav, buf);
    const b2 = await chromium.launch({ headless: !process.env.HEADED, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
    try {
      const ctx = await b2.newContext({ viewport: { width: 900, height: 800 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${dev.url}/lib/voice-orb.js`, { waitUntil: 'load' });
      const r = await page.evaluate(async () => {
        document.body.innerHTML = '<div id="host" style="max-width:480px"></div>';
        const sent = [];
        class StubSocket extends EventTarget {
          constructor() { super(); this.readyState = 0; this.binaryType = 'arraybuffer'; window.__stub = this; setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 10); }
          send(m) {
            if (typeof m !== 'string') { sent.push('audio'); return; }
            const j = JSON.parse(m); sent.push(j.type);
            if (j.type === 'start') setTimeout(() => this.emit({ type: 'ready', engine: 'gemini', bot: { id: 'b', name: 'Test' }, greeting: 'Hi.', input: { rate: 16000 }, output: { rate: 24000 } }), 10);
          }
          emit(o) { this.dispatchEvent(new MessageEvent('message', { data: typeof o === 'string' ? o : o instanceof ArrayBuffer ? o : JSON.stringify(o) })); }
          speak(ms) { // the bot's voice: 100 ms chunks of a 24 kHz tone
            for (let k = 0; k < ms / 100; k++) { const pcm = new Int16Array(2400); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 24000)); this.emit(pcm.buffer); }
          }
          close() { this.readyState = 3; }
        }
        window.WebSocket = StubSocket;
        const { openVoiceMode } = await import('/lib/voice-mode.js');
        const vm = openVoiceMode(document.getElementById('host'), { endpoint: 'wss://stub.invalid/voice', name: 'Test' });
        window.__vm = vm;
        const wait = (fn, ms = 8000) => new Promise((res) => { const t0 = performance.now(); (function poll() { const v = fn(); if (v || performance.now() - t0 > ms) return res(v); setTimeout(poll, 30); })(); });
        await wait(() => vm.engine === 'gemini' && sent.includes('audio'));
        const t0 = performance.now();
        window.__stub.speak(4000); // the bot starts a 4 s answer while the visitor keeps talking
        const barged = await wait(() => Number(vm.el.dataset.bargeIns || 0) >= 1, 3000);
        const tBarge = Math.round(performance.now() - t0);
        const stateAtBarge = vm.el.dataset.state;
        window.__stub.emit({ type: 'interrupted' });
        await wait(() => vm.el.dataset.state !== 'speaking', 2000);
        return { barged: !!barged, tBarge, stateAtBarge, after: vm.el.dataset.state, bargeIns: vm.el.dataset.bargeIns, sentAudio: sent.filter((x) => x === 'audio').length };
      });
      check('barge-in', 'the visitor talking over the bot pauses its voice locally, well before a server round trip would', r.barged && r.tBarge < 1000, JSON.stringify(r));
      check('barge-in', '"interrupted" then stops the answer and the orb listens again', r.after !== 'speaking', JSON.stringify(r));
      check('barge-in', 'the mic keeps streaming while the bot speaks (the server hears the interruption too)', r.sentAudio >= 1, JSON.stringify(r));
      check('barge-in', 'no page errors', !errors.length, errors.join(' | '));
      await ctx.close();
    } finally { await b2.close(); await fsp.rm(wav, { force: true }); }
  }

  // ------------------------------------------------------------------ the Studio's Voice settings (N8, U5, U6, U9)
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 2 });
    await ctx.addInitScript(() => { try { localStorage.setItem('kb-landing', 'skip'); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const H = { authorization: `Bearer ${t.token}` };
    const saved = async () => (await (await api(`/api/studio/trials/${t.trialId}`, { headers: H })).json()).spec?.voiceSetup || null;
    await page.goto(`${dev.studioUrl}?t=${t.trialId}&k=${encodeURIComponent(t.restoreKey)}`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const b = document.querySelector('.st-seg-setup'); if (b) { b.hidden = false; b.click(); } });
    await page.waitForSelector('#gl-vs', { timeout: 20000 });
    await page.locator('#gl-vs').scrollIntoViewIfNeeded();
    const first = await page.evaluate(() => {
      const q = (x) => document.querySelector(x);
      return { voices: [...q('#gl-vs-voice').options].map((o) => o.value), voice: q('#gl-vs-voice').value, lang: q('#gl-vs-lang').value, langs: q('#gl-vs-lang').options.length,
        msg: q('#gl-vs-msg').checked, role: q('#gl-vs-msg').getAttribute('role'), labelled: !!q('label[for="gl-vs-voice"]') && !!q('label[for="gl-vs-lang"]') && !!q('label[for="gl-vs-num"]'), text: q('#gl-vs').textContent };
    });
    check('voice-setup', 'the voice picker: 30 voices, Kore by default; the language defaults to the caller\'s; message-taking on', first.voices.length === 30 && first.voice === 'Kore' && first.lang === 'auto' && first.langs > 10 && first.msg && first.role === 'switch' && first.labelled, JSON.stringify({ ...first, text: undefined }));
    check('voice-setup', 'no vendor names', !/\b(?:Gemini|Google|Twilio)\b/.test(first.text), first.text.slice(0, 300));
    await page.selectOption('#gl-vs-voice', 'Puck');
    await page.waitForTimeout(900);
    check('voice-setup', 'choosing a voice saves it', (await saved())?.voice === 'Puck', JSON.stringify(await saved()));
    await page.selectOption('#gl-vs-lang', 'es');
    await page.waitForTimeout(900);
    check('voice-setup', 'choosing a language saves it', (await saved())?.language === 'es', JSON.stringify(await saved()));
    await page.click('label[for="gl-vs-msg"]');
    await page.waitForTimeout(900);
    const off = await saved();
    check('voice-setup', 'the message-taking switch saves off, and says what happens instead', off?.takeMessages === false && /offers to help with something else/.test(await page.textContent('#gl-vs-msg-d')), JSON.stringify(off));
    await page.click('label[for="gl-vs-msg"]');
    await page.waitForTimeout(700);
    await page.fill('#gl-vs-num', '555-01');
    await page.click('#gl-vs-save');
    await page.waitForTimeout(400);
    const bad = await page.evaluate(() => ({ err: document.querySelector('#gl-vs-err').textContent, shown: !document.querySelector('#gl-vs-err').hidden, inv: document.querySelector('#gl-vs-num').getAttribute('aria-invalid') }));
    check('voice-setup', 'a bad transfer number is refused in words and never saved', bad.shown && /country code/.test(bad.err) && bad.inv === 'true' && !(await saved())?.transfer, JSON.stringify(bad));
    await page.fill('#gl-vs-num', '(415) 555-0100');
    await page.fill('#gl-vs-tz', 'America/New_York');
    await page.fill('#gl-vs-start', '08:30');
    await page.fill('#gl-vs-end', '18:00');
    await page.click('label.gl-vs-day:has(input[data-day="sat"])');
    await page.click('#gl-vs-save');
    await page.waitForTimeout(1000);
    const tr = (await saved())?.transfer;
    check('voice-setup', 'the hand-off saves an E.164 number, time zone, days and hours', tr?.number === '+14155550100' && tr.timezone === 'America/New_York' && tr.start === '08:30' && tr.end === '18:00'
      && tr.days.join(',') === 'mon,tue,wed,thu,fri,sat' && (await page.inputValue('#gl-vs-num')) === '+14155550100', JSON.stringify(tr));
    await page.locator('#gl-vs').screenshot({ path: path.join(SHOTS, 'studio-voice-settings.png') });
    await page.click('#gl-vs-clear');
    await page.waitForTimeout(900);
    check('voice-setup', 'Remove takes the hand-off away', !(await saved())?.transfer, JSON.stringify(await saved()));
    check('voice-setup', 'no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------------ product cards in the chat bubble's voice mode
  {
    const s = await (await api('/api/studio/trials', { method: 'POST' })).json();
    const SH = { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' };
    await (await api(`/api/studio/trials/${s.trialId}/store`, { method: 'POST', headers: SH, body: JSON.stringify({ url: dev.shopUrl, owner: true }) })).text();
    for (let i = 0; i < 480; i++) {
      const f = await (await api(`/api/studio/trials/${s.trialId}/files`, { headers: SH })).json();
      if (f.files?.length >= 5 && f.files.every((x) => x.stage === 'ready')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const key = (await (await api(`/api/studio/trials/${s.trialId}/devkey`, { headers: SH })).json()).key;
    check('cards', 'a store bot with a trial key', /^kb_trial_/.test(key || ''));
    const home = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumen Bikes</title></head><body><h1>Ride further.</h1>
<script type="module" src="${dev.url}/lib/embed.js" data-api="${dev.url}" data-bot="${s.trialId}" data-key="${key}" data-chat="on" data-voice="on" data-homepage="off"></script></body></html>`);
    });
    await new Promise((r) => home.listen(0, '127.0.0.1', r));
    const homeUrl = `http://127.0.0.1:${home.address().port}/`;
    try {
      for (const v of [{ name: 'desktop', viewport: { width: 1280, height: 860 } }, { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true }]) {
        const cell = `cards-${v.name}`;
        const ctx = await browser.newContext({ viewport: v.viewport, colorScheme: 'light', deviceScaleFactor: 2, ...(v.mobile ? { isMobile: true, hasTouch: true } : {}) });
        // every utterance handed to the browser's speech synthesis, to check nothing spoken holds a URL
        await ctx.addInitScript(() => {
          window.__spoken = [];
          const S = window.SpeechSynthesis?.prototype;
          if (S?.speak) { const orig = S.speak; S.speak = function (u) { window.__spoken.push(String(u?.text || '')); return orig.call(this, u); }; }
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(homeUrl, { waitUntil: 'load' });
        await page.waitForSelector('.kb-launcher', { timeout: 20000 });
        await page.click('.kb-launcher');
        await page.waitForSelector('.kb-mic', { timeout: 10000 });
        await page.click('.kb-mic');
        await page.waitForSelector('.kb-voice .kbvm[data-engine]', { state: 'attached', timeout: 20000 })
          .catch(async (e) => { throw new Error(`${cell}: voice mode did not connect (${await page.locator('.kb-voice').innerText().catch(() => '?')})`, { cause: e }); });
        const input = page.locator('.kb-voice .kbvm-type input');
        await input.fill('How much is the Commuter Lite?');
        await input.press('Enter');
        const got = await page.waitForFunction(() => {
          const vm = document.querySelector('.kb-voice .kbvm');
          const a = vm?.querySelector('.kbvm-prods .kb-products .kb-prod');
          if (!a || vm.querySelectorAll('.kbvm-log li').length < 2 || !window.__spoken.length) return null;
          const ul = a.closest('.kb-products'), panel = vm.closest('.kb-root') || vm, pr = panel.getBoundingClientRect(), ur = ul.getBoundingClientRect();
          a.focus();
          return {
            href: a.href, target: a.target, rel: a.rel, label: a.getAttribute('aria-label') || '', title: a.querySelector('.kb-prod-t')?.textContent, price: a.querySelector('.kb-prod-p')?.textContent || '',
            focused: (a.getRootNode().activeElement || document.activeElement) === a, display: getComputedStyle(ul).display, ox: getComputedStyle(ul).overflowX,
            inPanel: ur.left >= pr.left - 1 && ur.right <= pr.right + 1, pageOverflow: document.scrollingElement.scrollWidth > innerWidth + 1,
            underCaption: !!(vm.querySelector('.kbvm-cap').compareDocumentPosition(ul) & Node.DOCUMENT_POSITION_FOLLOWING),
            chipLinks: [...vm.querySelectorAll('a.kbvm-chip')].map((x) => x.href), chipText: [...vm.querySelectorAll('.kbvm-chip')].map((x) => x.textContent),
            orbTop: vm.querySelector('.kbvm-stage').getBoundingClientRect().top >= (vm.closest('.kb-voice') || vm).getBoundingClientRect().top - 1, spoken: window.__spoken.slice(), cap: vm.querySelector('.kbvm-cap').textContent,
          };
        }, null, { timeout: 30000 }).then((x) => x.jsonValue()).catch(() => null);
        check(cell, 'a product answer shows the web chat’s card under the spoken answer: new-tab link, named, focusable',
          !!got && got.href === `${dev.shopUrl}/products/commuter-lite` && got.target === '_blank' && /noopener/.test(got.rel) && /Commuter Lite/.test(got.label) && /opens in a new tab/.test(got.label)
          && got.title === 'Commuter Lite' && /799/.test(got.price) && got.focused && got.underCaption, JSON.stringify(got));
        check(cell, 'the cards use the shared styles, scroll sideways inside the panel, no page overflow', !!got && got.display === 'flex' && /auto|scroll/.test(got.ox) && got.inPanel && !got.pageOverflow, JSON.stringify(got && { display: got.display, ox: got.ox, inPanel: got.inPanel, pageOverflow: got.pageOverflow }));
        check(cell, 'the product page is not repeated as a source chip', !!got && !got.chipLinks.some((h) => /\/products\/commuter-lite/.test(h)) && !got.chipText.some((t) => /Commuter Lite|https?:/.test(t)), JSON.stringify(got && [got.chipLinks, got.chipText]));
        check(cell, 'the orb is not clipped at the top of the panel', !!got && got.orbTop);
        check(cell, 'with product cards on screen, the spoken answer says so (U8)', !!got && got.spoken.some((x) => /I've put it on your screen\./.test(x)), JSON.stringify(got && got.spoken));
        check(cell, 'nothing spoken or captioned holds a URL', !!got && got.spoken.length > 0 && got.spoken.every((t) => !/https?:|www\./i.test(t)) && !/https?:|www\./i.test(got.cap), JSON.stringify(got && { spoken: got.spoken, cap: got.cap }));
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, `bubble-voice-cards-${v.name}.png`) });
        // a policy answer: sources as chips, no cards
        await input.fill('Can I return a bike?');
        await input.press('Enter');
        const pol = await page.waitForFunction(() => {
          const vm = document.querySelector('.kb-voice .kbvm');
          return vm && vm.querySelectorAll('.kbvm-log li').length >= 4 && vm.dataset.state !== 'thinking'
            ? { cards: vm.querySelectorAll('.kb-prod').length, chips: vm.querySelectorAll('.kbvm-chip').length, prods: vm.querySelector('.kbvm-prods').children.length } : null;
        }, null, { timeout: 30000 }).then((x) => x.jsonValue()).catch(() => null);
        check(cell, 'a policy answer shows its sources as chips and no product cards', !!pol && pol.cards === 0 && pol.prods === 0 && pol.chips >= 1, JSON.stringify(pol));
        check(cell, 'no page errors', !errors.length, errors.join(' | '));
        await ctx.close();
      }
    } finally { await new Promise((r) => home.close(() => r())); }
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

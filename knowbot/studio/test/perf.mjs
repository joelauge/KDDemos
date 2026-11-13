#!/usr/bin/env node
// KnowBot Studio frame-budget probe (owner M). Drives the sample journey against studio/test/dev-server.mjs
// (fake knowDrive + fake model on 127.0.0.1) under CDP CPU throttling and reports long animation frames,
// CLS and the longest task. Never touches production or any real service.
//
//   node studio/test/perf.mjs                          # desktop 1440x900 + mobile 390x844, 4x CPU throttle
//   node studio/test/perf.mjs --cell=desktop --throttle=6
//   node studio/test/perf.mjs --launch                 # also run Proof Run + launch choreography
//   node studio/test/perf.mjs --json                   # machine-readable summary on stdout
//   PERF_BUDGET=50 node studio/test/perf.mjs           # exit 1 if any frame is longer than the budget (ms)
//
// Phases are marked so a long frame can be traced to the moment that produced it: landing, samples (shatter +
// map fly-in), ingest, answer (streaming), launch. Each long frame lists its top scripts (LoAF attribution).

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from './dev-server.mjs';

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcCache = new Map();
/** 'ingest.js?v=<stamp>' + char position -> 'ingest.js:123' (LoAF reports char offsets, not lines) */
function where(src, ch) {
  const f = String(src || '').split('?')[0];
  if (!f || !(ch >= 0)) return f || '?';
  if (!srcCache.has(f)) { try { srcCache.set(f, readFileSync(path.join(STUDIO, f), 'utf8')); } catch { srcCache.set(f, null); } }
  const t = srcCache.get(f);
  return t ? `${f}:${t.slice(0, ch).split('\n').length}` : f;
}

delete process.env.KNOWDRIVE_API_KEY;   // isolation rule: nothing below may reach a real store

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const THROTTLE = Number(opt('throttle', 4)) || 4;
const BUDGET = Number(process.env.PERF_BUDGET || opt('budget', 50)) || 50;
const JSON_OUT = args.includes('--json');
const LAUNCH = args.includes('--launch');
const wantCells = args.filter((a) => a.startsWith('--cell=')).map((a) => a.slice(7));
const CELLS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true },
].filter((c) => !wantCells.length || wantCells.includes(c.name));
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/** Injected before any page script: buffered observers for LoAF, long tasks and layout shifts. */
function probe() {
  const P = window.__perf = { phase: 'boot', loaf: [], tasks: [], cls: 0, shifts: [], frames: 0 };
  const obs = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch { /* unsupported */ } };
  obs('long-animation-frame', (e) => P.loaf.push({
    phase: P.phase, start: Math.round(e.startTime), dur: Math.round(e.duration), block: Math.round(e.blockingDuration || 0),
    render: Math.round((e.startTime + e.duration) - (e.renderStart || e.startTime + e.duration)),
    style: Math.round(e.styleAndLayoutStart ? (e.startTime + e.duration) - e.styleAndLayoutStart : 0),
    scripts: (e.scripts || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 4).map((s) => ({
      dur: Math.round(s.duration), fn: s.sourceFunctionName || s.invoker || '', src: String(s.sourceURL || '').split('/').pop(), ch: s.sourceCharPosition, fl: Math.round(s.forcedStyleAndLayoutDuration || 0),
    })),
  }));
  obs('longtask', (e) => P.tasks.push({ phase: P.phase, dur: Math.round(e.duration), start: Math.round(e.startTime) }));
  obs('layout-shift', (e) => { if (!e.hadRecentInput) { P.cls += e.value; if (e.value > 0.001) P.shifts.push({ phase: P.phase, t: Math.round(e.startTime), v: +e.value.toFixed(4), nodes: (e.sources || []).map((s) => s.node && (s.node.id || s.node.className || s.node.nodeName)).slice(0, 3),
    moves: (e.sources || []).slice(0, 3).map((s) => `${Math.round(s.previousRect.y)}+${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.y)}+${Math.round(s.currentRect.height)}`) }); } });
  // PERF_LAYOUT=1: time every layout-reading API and keep the stack of each call that took > 4 ms (a forced reflow)
  P.forced = [];
  if (window.__perfLayout) {
    const keep = (name, ms) => { if (ms > 4 && P.forced.length < 200) P.forced.push({ phase: P.phase, name, ms: Math.round(ms), stack: (new Error().stack || '').split('\n').slice(3, 9).map((l) => l.trim().replace(/https?:\/\/[^/]+\/studio\//, '').replace(/\?v=\d+/, '')).join(' < ') }); };
    const wrapFn = (proto, name) => { const f = proto[name]; if (typeof f !== 'function') return; proto[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { keep(name, performance.now() - t); } }; };
    const wrapGet = (proto, name) => { const d = Object.getOwnPropertyDescriptor(proto, name); if (!d || !d.get) return; Object.defineProperty(proto, name, { ...d, get() { const t = performance.now(); try { return d.get.call(this); } finally { keep(name, performance.now() - t); } } }); };
    for (const n of ['getBoundingClientRect', 'getClientRects', 'scrollIntoView', 'focus']) wrapFn(Element.prototype, n), wrapFn(HTMLElement.prototype, n);
    for (const n of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent', 'innerText']) wrapGet(HTMLElement.prototype, n);
    for (const n of ['clientWidth', 'clientHeight', 'scrollHeight', 'scrollWidth', 'scrollTop']) wrapGet(Element.prototype, n);
    const gcs = window.getComputedStyle; window.getComputedStyle = function (...a) { const cs = gcs.apply(this, a); return new Proxy(cs, { get(o, k) { const t = performance.now(); const v = typeof o[k] === 'function' ? o[k].bind(o) : o[k]; keep('getComputedStyle.' + String(k), performance.now() - t); return v; } }); };
  }
  // launch choreography checks (DOM-only, no layout reads): how many full launch cards (receipt grids) exist at once,
  // and whether the Builder log ever goes blank (no children / no text) after it first had content
  P.maxGrids = 0; P.logBlank = 0;
  document.addEventListener('DOMContentLoaded', () => {
    let had = false;
    new MutationObserver(() => {
      const g = [...document.querySelectorAll('.co-launch-grid')].filter((x) => !x.closest('[hidden]')).length;
      if (g > P.maxGrids) P.maxGrids = g;
      const lg = document.getElementById('st-log');
      if (lg) { const n = lg.childElementCount; if (n > 2) had = true; else if (had && n === 0) P.logBlank++; }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const tick = () => { P.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

const getState = (page) => page.evaluate(() => {
  const s = window.__studio?.store?.getState?.();
  if (!s) return null;
  return { files: s.files, fileOrder: s.fileOrder, thread: s.thread.map((a) => ({ by: a.by, status: a.status, final: !!a.final })), milestones: s.milestones, trial: { status: s.trial.status } };
}).catch(() => null);

async function waitState(page, fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await getState(page);
    try { const v = s && fn(s); if (v) return v; } catch { /* keep polling */ }
    await page.waitForTimeout(250);
  }
  return null;
}

const setPhase = (page, p) => page.evaluate((x) => { window.__perf.phase = x; }, p).catch(() => null);
async function tab(page, cell, which) {
  if (!cell.mobile) return;
  const sel = which === 'setup' ? '#st-tab-setup' : '#st-tab-bot';
  if ((await page.getAttribute(sel, 'aria-pressed').catch(() => null)) !== 'true') { await page.click(sel).catch(() => null); await page.waitForTimeout(260); }
}
async function chip(page, cell, re) {
  await tab(page, cell, 'setup');
  const chips = page.locator('#st-log .st-chips:not([hidden]) .st-chip, #st-log [data-card] button');
  for (let i = (await chips.count()) - 1; i >= 0; i--) {
    const c = chips.nth(i);
    if (re.test((await c.innerText().catch(() => '')) || '')) { await c.click({ timeout: 4000 }).catch(() => c.focus().then(() => c.press('Enter'))); return true; }
  }
  return false;
}

async function run(browser, cell) {
  const dev = await startDevServer({ speed: Number(process.env.FAKE_SPEED || 4) || 4 });
  const context = await browser.newContext({ viewport: cell.viewport, isMobile: cell.mobile, hasTouch: cell.mobile, deviceScaleFactor: cell.mobile ? 2 : 1, reducedMotion: 'no-preference' });
  await context.addInitScript(() => { try { if (!sessionStorage.getItem('__perf_init')) { localStorage.setItem('kb-studio-motion', 'full'); localStorage.setItem('knowbot-theme', 'light'); sessionStorage.setItem('__perf_init', '1'); } } catch { /* ignore */ } });
  if (process.env.PERF_LAYOUT) await context.addInitScript(() => { window.__perfLayout = true; });
  await context.addInitScript(probe);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://knowdrive.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>fake checkout</p>' }));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const marks = [];
  const mark = async (p) => { marks.push(p); await setPhase(page, p); };
  try {
    await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    await mark('landing');
    await page.waitForSelector('#st-log .st-chip-primary', { timeout: 15000 });
    await waitState(page, (s) => s.trial.status === 'ready', 15000);
    await page.waitForTimeout(800);

    await mark('samples');   // shatter + knowledge-map fly-in
    await page.locator('#st-log .st-chip-primary').first().click();
    await tab(page, cell, 'bot');
    await waitState(page, (s) => s.fileOrder.some((id) => (s.files[id]?.atoms || 0) > 0), 30000);
    await mark('ingest');
    await waitState(page, (s) => s.fileOrder.length > 0 && s.fileOrder.every((id) => ['ready', 'failed', 'rejected'].includes(s.files[id]?.phase)), 60000);
    await page.waitForTimeout(1500);

    await mark('answer');    // answer streaming + proof layer
    await tab(page, cell, 'bot');
    const starter = page.locator('#sb-suggest-slot button').filter({ hasNotText: /off-topic/i }).first();
    await starter.waitFor({ timeout: 15000 }).catch(() => null);
    const n0 = (await getState(page))?.thread.length || 0;
    await starter.click({ timeout: 5000 }).catch(() => null);
    await waitState(page, (s) => s.thread.length > n0 && s.thread[s.thread.length - 1].final, 30000);
    await page.waitForTimeout(1500);
    const cite = page.locator('#sb-thread-slot button.pf-cite[data-n="1"]').first();
    if (await cite.count()) { await mark('proof-view'); await cite.click({ timeout: 4000 }).catch(() => null); await page.waitForTimeout(1500); }

    if (LAUNCH) {
      await mark('proof-run');
      if (await chip(page, cell, /Proof Run/i)) {
        await page.waitForFunction(() => !!document.querySelector('#st-log [data-card="scorecard"]'), null, { timeout: 60000 }).catch(() => null);
        await page.waitForTimeout(2500);
      }
      await mark('launch');
      await page.waitForFunction(() => [...document.querySelectorAll('#st-log .st-chips:not([hidden]) .st-chip, #st-log [data-card] button')].some((b) => /Launch with samples anyway/i.test(b.textContent)), null, { timeout: 15000 }).catch(() => null);
      if (await chip(page, cell, /Launch with samples anyway/i) || await chip(page, cell, /Launch/i)) {
        await page.waitForFunction(() => !!document.querySelector('#st-log [data-card="launch"]'), null, { timeout: 15000 }).catch(() => null);
        await page.waitForTimeout(3000);
      }
    }
    await mark('idle');
    await page.waitForTimeout(1500);
    const P = await page.evaluate(() => window.__perf);
    return { cell: cell.name, throttle: THROTTLE, marks, errors, ...summarize(P) };
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => null);
    await context.close();
    await dev.close();
  }
}

function summarize(P) {
  const long = P.loaf.filter((f) => f.dur > BUDGET);
  const byPhase = {};
  for (const f of long) (byPhase[f.phase] ||= []).push(f.dur);
  return {
    frames: P.frames,
    longFrames: long.length,
    longestFrame: P.loaf.reduce((m, f) => Math.max(m, f.dur), 0),
    longestTask: P.tasks.reduce((m, t) => Math.max(m, t.dur), 0),
    cls: +P.cls.toFixed(4),
    byPhase,
    worst: long.slice().sort((a, b) => b.dur - a.dur).slice(0, Number(process.env.PERF_WORST || 8)),
    shifts: P.shifts.slice(0, 8),
    maxLaunchGrids: P.maxGrids, logBlank: P.logBlank,
    forced: (P.forced || []).sort((a, b) => b.ms - a.ms).slice(0, 25),
  };
}

const browser = await chromium.launch(process.env.HEADED ? { headless: false } : {});
const out = [];
try {
  for (const cell of CELLS) {
    log(`\n=== ${cell.name} ${cell.viewport.width}x${cell.viewport.height} · CPU x${THROTTLE} · budget ${BUDGET} ms ===`);
    const r = await run(browser, cell);
    out.push(r);
    log(`  rAF frames ${r.frames} · long frames (>${BUDGET} ms) ${r.longFrames} · longest frame ${r.longestFrame} ms · longest task ${r.longestTask} ms · CLS ${r.cls}`);
    if (LAUNCH) log(`  launch: max full receipt grids at once ${r.maxLaunchGrids} · Builder log blanked ${r.logBlank}x · phases ${r.marks.join(' > ')}`);
    for (const [p, d] of Object.entries(r.byPhase)) log(`    ${p.padEnd(11)} ${d.length} long: ${d.join(', ')} ms`);
    for (const w of r.worst) log(`    ${w.dur} ms [${w.phase}] style/layout ${w.style} ms · ${w.scripts.map((s) => `${where(s.src, s.ch)} ${s.fn || '?'} ${s.dur}ms${s.fl ? ` (forced layout ${s.fl}ms)` : ''}`).join(' | ')}`);
    for (const f of r.forced) log(`    forced ${f.ms} ms [${f.phase}] ${f.name} · ${f.stack}`);
    for (const s of r.shifts) log(`    shift ${s.v} [${s.phase}] @${s.t} ms ${s.nodes.map((n, i) => `${n} (y+h ${s.moves?.[i] || '?'})`).join(', ')}`);
    if (r.errors.length) log(`  page errors: ${r.errors.slice(0, 3).join(' || ')}`);
  }
} finally {
  await browser.close();
}
if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
const fail = out.some((r) => r.longFrames > 0 || r.errors.length);
log(`\nPerf: ${fail ? 'OVER BUDGET' : 'within budget'} (${out.map((r) => `${r.cell}: ${r.longFrames} long, max ${r.longestFrame} ms, CLS ${r.cls}`).join(' · ')})`);
process.exit(fail ? 1 : 0);

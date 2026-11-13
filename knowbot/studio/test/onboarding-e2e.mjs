#!/usr/bin/env node
// Onboarding end to end: a brand-new visitor all the way to a paid, launched bot and back into it later.
//
//   npm run onboarding:e2e                  # LOCAL: the whole journey against studio/test/dev-server.mjs (fake knowDrive
//                                           # incl. its fake authorization server, a fake checkout/payment page that
//                                           # converts the bot and redirects to the `return` URL). Desktop 1440x900 + phone 390x844.
//   npm run onboarding:e2e -- --live        # PRODUCTION, safe steps only: a new visitor up to the real KnowDrive sign-in
//                                           # window opened by Launch. Never submits a form on knowdrive.ai, never pays.
//   ... --only=desktop | --only=phone       # one viewport
//   OUT=/some/dir                           # default /tmp/onboarding/<local|live>
//
// Every step records: a screenshot (OUT/<viewport>/NN-step.png), console errors, failed requests (4xx/5xx), layout
// problems (horizontal scroll, covered or clipped controls, primary buttons off screen), axe (serious/critical WCAG
// A/AA), the time the step took, and dead ends (no visible primary action, no composer to type in). OUT/REPORT.md
// lists every problem with its screenshot. Exit code 1 when a step fails or any problem is recorded.
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const MODE = LIVE ? 'live' : 'local';
const OUT = process.env.OUT || path.join('/tmp/onboarding', MODE);
const STUDIO_LIVE = process.env.LIVE_STUDIO_URL || 'https://knowbot.knowdrive.ai/studio/';
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';
const NOT_IN_DATA = "Looks like we don't have that in our files.";
const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
].filter((v) => !ONLY || v.name === ONLY);

if (!LIVE) delete process.env.KNOWDRIVE_API_KEY; // the local journey never reaches a real store
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let axeSource = null;
async function loadAxe() {
  if (axeSource !== null) return axeSource;
  try { if (process.env.AXE_PATH) axeSource = await fsp.readFile(process.env.AXE_PATH, 'utf8'); } catch { axeSource = null; }
  if (!axeSource) { try { const r = await fetch(AXE_URL, { signal: AbortSignal.timeout(10000) }); axeSource = r.ok ? await r.text() : ''; } catch { axeSource = ''; } }
  return axeSource;
}

// ------------------------------------------------------------------ recorder
const report = { mode: MODE, started: new Date().toISOString(), runs: [] };

function ignorableConsole(t) {
  return /^Failed to load resource/.test(t) // reported with its URL by the response listener
    || /fonts\.(googleapis|gstatic)\.com|favicon|ERR_TUNNEL|ERR_PROXY/.test(t);
}
function ignorableUrl(u) { return /fonts\.(googleapis|gstatic)\.com|favicon\.ico$/.test(u); }

function watch(page, bucket, tag = '') {
  page.on('console', (m) => { if (m.type() === 'error' && !ignorableConsole(m.text())) bucket.console.push(`${tag}${m.text()}`.slice(0, 400)); });
  page.on('pageerror', (e) => bucket.console.push(`${tag}pageerror: ${e.message}`.slice(0, 400)));
  page.on('response', (r) => {
    if (r.status() < 400 || ignorableUrl(r.url())) return;
    bucket.network.push(`${tag}HTTP ${r.status()} ${r.request().method()} ${r.url().replace(/([?&](?:k|token|code|state|sig)=)[^&]+/g, '$1…')}`.slice(0, 300));
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText || '';
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(f) || ignorableUrl(r.url())) return; // navigations away, cancelled streams
    bucket.network.push(`${tag}FAILED ${r.method()} ${r.url().replace(/([?&](?:k|token|code|state|sig)=)[^&]+/g, '$1…')} (${f})`.slice(0, 300));
  });
}

/** In-page layout audit of what the visitor can see right now (the top layer: an open dialog, else the page). */
async function layoutAudit(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = innerWidth, vh = innerHeight;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`horizontal scroll: page is ${document.documentElement.scrollWidth}px wide on a ${vw}px screen`);
    const visible = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; return !el.closest('[hidden],[inert],[aria-hidden="true"]'); };
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')].filter(visible);
    const layer = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
    const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.id || el.className || el.tagName).toString().replace(/\s+/g, ' ').trim().slice(0, 60);
    const ctrls = [...layer.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, select')].filter(visible);
    // scrolled-away controls are fine; check the ones whose box is inside the viewport
    for (const el of ctrls) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // inside a horizontally scrolling strip (chips rows): not a layout fault
      let sc = el.parentElement, inScroller = false;
      while (sc && sc !== document.body) { const cs = getComputedStyle(sc); if (/(auto|scroll)/.test(cs.overflowX) && sc.scrollWidth > sc.clientWidth + 1) { inScroller = true; break; } sc = sc.parentElement; }
      if (!inScroller && (r.right > vw + 1 || r.left < -1) && r.bottom > 0 && r.top < vh) out.push(`off screen sideways: "${name(el)}" (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        // a sticky header/footer or composer legitimately covers scrolled content; only flag when the cover is not the
        // control's own scroll container's chrome (heuristic: the covering element is position fixed/sticky AND the
        // control lives in a scroll container that can move it out from under)
        let p = el.parentElement, scrolls = false;
        while (p && p !== document.body) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) { scrolls = true; break; } p = p.parentElement; }
        let c = hit, chrome = false;
        while (c && c !== document.body) { const cs = getComputedStyle(c); if (cs.position === 'fixed' || cs.position === 'sticky') { chrome = true; break; } c = c.parentElement; }
        if (scrolls && chrome) continue;
        if (scrolls && !p.contains(hit)) continue; // covered by a sibling pane's overlay while this pane scrolls
        // the phone's Builder peek sits over the Builder tab on purpose: it IS the way to that tab
        if (hit.closest('.st-peek') && el.closest('#st-tab-setup')) continue;
        out.push(`covered: "${name(el)}" is under "${name(hit)}"`);
      }
      const cs = getComputedStyle(el);
      if (el.tagName === 'BUTTON' && cs.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis') out.push(`clipped text: "${name(el)}"`);
    }
    // the top layer's primary button must be reachable without hunting: in a dialog it is on screen
    if (layer !== document.body) {
      for (const b of [...layer.querySelectorAll('.co-cta, .btn-primary, button[type=submit]')].filter(visible)) {
        const r = b.getBoundingClientRect();
        if (r.top > vh - 8) out.push(`primary button below the fold: "${name(b)}" starts at ${Math.round(r.top)}px of ${vh}`);
      }
    }
    return [...new Set(out)].slice(0, 12);
  });
}

/** What the visitor can do next: the visible primary actions in the top layer, and whether a composer is usable. */
async function nextActions(page) {
  return page.evaluate(() => {
    const visible = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; return !el.closest('[hidden],[inert]'); };
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible);
    const layer = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const prim = [...layer.querySelectorAll('.btn-primary, .co-cta, .st-chip-primary, .kl-go, button[type=submit], [data-primary]')].filter((b) => visible(b) && !b.disabled)
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const composer = !dialogs.length && [...document.querySelectorAll('#st-setup-composer, #sb-composer-slot textarea, #kl-input')].some((t) => visible(t) && !t.disabled);
    return { primary: [...new Set(prim)].slice(0, 6), composer };
  });
}

/** Copy audit: words a new visitor should never have to decode, in what they can see right now (the Sources map
 *  explains its own "atoms" in its legend, code blocks are code, and the Proof view is the opt-in detail view). */
const JARGON = [
  [/\bSampleBot\b/, 'the placeholder bot name'], [/\batomi[sz]\w*|\batoms?\b/i, '"atom" (storage jargon)'], [/\bingest\w*/i, '"ingest"'],
  [/\bvectori[sz]\w*|\bvector\b/i, '"vector"'], [/\bchunk\w*/i, '"chunk"'], [/\bgrounded\b|\bgrounding\b/i, '"grounded"'], [/\btrial key\b/i, '"trial key"'],
  [/\bbot spec\b/i, '"bot spec"'], [/\bmatch \d{2}\b/i, 'a bare match score'], [/\bextracting\b/i, '"extracting"'], [/\bencoding your knowledge\b/i, '"encoding"'],
  [/\bOAuth\b|\bopenid\b/i, 'auth protocol names'], [/\bunsupported claims?\b/i, '"unsupported claims"'], [/\bQuick check\b/i, '"Quick check" vs "tests" (two names)'],
];
async function copyAudit(page) {
  const text = await page.evaluate(() => {
    const visible = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && +cs.opacity >= 0.05; };
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { const p = n.parentElement; if (p && n.textContent.trim() && visible(p)) { const r = p.getBoundingClientRect(); if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) out.push(n.textContent.trim()); } return; }
      if (n.nodeType !== 1) return;
      if (n.matches('#in-map-slot, pre, code, script, style, [aria-hidden="true"], [hidden], .st-sr, .co-sr, .sr-only, [data-view="proof"]')) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return out.join(' \n ');
  }).catch(() => '');
  const hits = [];
  for (const [re, what] of JARGON) {
    const m = re.exec(text);
    if (m) { const i = text.indexOf(m[0]); hits.push(`${what}: "…${text.slice(Math.max(0, i - 50), i + 60).replace(/\s+/g, ' ').trim()}…"`); }
  }
  return hits;
}

async function axe(page) {
  const src = await loadAxe();
  if (!src) return { skipped: true };
  try {
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: src });
    const v = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] });
      return r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
    });
    return { violations: v };
  } catch (e) { return { skipped: true, error: e.message }; }
}

function makeRun(vp) {
  const run = { viewport: vp.name, steps: [], problems: [] };
  report.runs.push(run);
  const dir = path.join(OUT, vp.name);
  let n = 0;
  /**
   * step(name, fn, opts): runs fn, then records screenshot, errors, requests, layout, axe, time and dead ends.
   * opts.page: page to audit (default the one passed to begin); opts.allowNoAction: a waiting state (e.g. a spinner)
   * is not a dead end; opts.external: the page is not ours (knowdrive.ai): audited and listed separately.
   */
  async function step(page, bucket, name, fn, opts = {}) {
    n++;
    const id = `${String(n).padStart(2, '0')}-${name}`;
    const t0 = Date.now();
    const rec = { id, name, ms: 0, ok: true, error: null, shot: path.join(dir, `${id}.png`), console: [], network: [], layout: [], axe: [], copy: [], next: null, notes: [], external: !!opts.external };
    run.steps.push(rec);
    process.stdout.write(`  ${id} … `);
    try { const r = await fn(rec); if (typeof r === 'string') rec.notes.push(r); }
    catch (e) { rec.ok = false; rec.error = String(e.message || e).split('\n')[0].slice(0, 400); }
    rec.ms = Date.now() - t0;
    const P = opts.page ? opts.page() : page;
    await sleep(opts.settle ?? 450);
    try { await fsp.mkdir(dir, { recursive: true }); await P.screenshot({ path: rec.shot }); } catch (e) { rec.notes.push(`screenshot failed: ${e.message}`); }
    rec.console = bucket.console.splice(0);
    rec.network = bucket.network.splice(0);
    try { rec.layout = await layoutAudit(P); } catch (e) { rec.layout = []; }
    if (!opts.noAxe) { const a = await axe(P); rec.axe = a.violations || []; if (a.skipped) rec.notes.push('axe skipped'); }
    try { rec.next = await nextActions(P); } catch { rec.next = null; }
    if (!opts.external) { try { rec.copy = await copyAudit(P); } catch { rec.copy = []; } }
    const dead = !opts.allowNoAction && !opts.external && rec.next && !rec.next.primary.length && !rec.next.composer;
    const add = (kind, detail) => run.problems.push({ step: id, kind, detail, shot: rec.shot, external: rec.external });
    if (!rec.ok) add('step failed', rec.error);
    for (const c of rec.console) add('console error', c);
    for (const x of rec.network) add('failed request', x);
    for (const l of rec.layout) add('layout', l);
    for (const v of rec.axe) add('accessibility', v);
    for (const v of rec.copy) { const seen = run.problems.some((p) => p.kind === 'copy' && p.detail.split(':')[0] === v.split(':')[0]); if (!seen) add('copy', v); }
    if (dead) add('dead end', 'no visible primary action and nowhere to type');
    if (opts.budgetMs && rec.ms > opts.budgetMs) add('slow', `${(rec.ms / 1000).toFixed(1)} s (budget ${(opts.budgetMs / 1000).toFixed(0)} s)`);
    const bad = run.problems.filter((p) => p.step === id).length;
    console.log(`${rec.ok ? 'ok' : 'FAIL'} ${(rec.ms / 1000).toFixed(1)}s${bad ? ` · ${bad} problem(s)` : ''}${rec.error ? ` · ${rec.error}` : ''}${rec.notes.length ? ` · ${rec.notes.join('; ')}` : ''}`);
    return rec;
  }
  return { run, step };
}

// ------------------------------------------------------------------ helpers on the Studio
const st = (page) => page.evaluate(() => { const s = window.__studio?.store?.getState?.(); return s ? JSON.parse(JSON.stringify({ trial: s.trial, milestones: s.milestones, files: Object.values(s.files || {}).map((f) => ({ name: f.name, stage: f.phase === 'ready' || f.stage === 'ready' ? 'ready' : f.phase === 'failed' || f.phase === 'error' || f.stage === 'failed' ? 'failed' : (f.phase || f.stage), sample: !!f.sample })), thread: (s.thread || []).map((a) => ({ q: a.question, status: a.status, by: a.by, text: a.final?.text || '' })), ui: s.ui })) : null; });
async function waitFor(page, fn, timeout = 30000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const s = await st(page).catch(() => null); try { const v = s && fn(s); if (v) return v; } catch { /* keep polling */ } await sleep(every); }
  return null;
}
async function pane(page, vp, which) {
  if (!vp.mobile) return;
  const sel = which === 'setup' ? '#st-tab-setup' : '#st-tab-bot';
  if (!(await page.isVisible(sel).catch(() => false))) return;
  if ((await page.getAttribute(sel, 'aria-pressed').catch(() => null)) !== 'true') { await page.click(sel); await sleep(300); }
}
async function dismissGuide(page) {
  // the first-time guide is part of the real journey; the harness reads it, then steps past it like a visitor would
  const g = page.locator('.ft-card button, .ftue button, [data-ftue] button').filter({ hasText: /^(Got it|Next|Skip|Close|Done)/ });
  for (let i = 0; i < 6 && await g.count().catch(() => 0); i++) { await g.first().click({ timeout: 2000 }).catch(() => {}); await sleep(250); }
}
async function askFirstStarter(page, vp) {
  await pane(page, vp, 'bot');
  // what a new visitor is offered: the guide's "Ask: …" button, else the first suggested question
  const sel = '.st-ftue button.btn-primary, .st-ftue-card button.btn-primary, #sb-suggest-slot .sb-chip:not(.sb-chip-probe)';
  const isQ = (t) => /^Ask:|\?\s*$/.test(t.trim()) && !/off-topic/i.test(t);
  await page.waitForFunction(([sel, src]) => { const isQ = new Function('t', src); return [...document.querySelectorAll(sel)].some((b) => b.offsetParent && isQ(b.innerText)); }, [sel, `return /^Ask:|\\?\\s*$/.test(t.trim()) && !/off-topic/i.test(t);`], { timeout: 90000 });
  const b = page.locator(sel).filter({ hasText: /^Ask:|\?\s*$/ }).filter({ hasNotText: /off-topic/i }).locator('visible=true').first();
  void isQ;
  const q = (await b.innerText()).trim().replace(/^Ask:\s*/, '');
  const before = (await st(page)).thread.length;
  await b.click();
  const a = await waitFor(page, (s) => s.thread.length > before && s.thread.slice(before).find((x) => x.text && /grounded|refused|fail|error|weak/.test(x.status)), 60000);
  return { q, a };
}
async function askTyped(page, vp, text) {
  await pane(page, vp, 'bot');
  const ta = page.locator('#sb-composer-slot textarea').first();
  await ta.fill(text); await ta.press('Enter');
  return waitFor(page, (s) => s.thread.find((x) => x.q === text && x.text), 60000);
}

// ------------------------------------------------------------------ fake checkout (local only)
function fakeCheckoutPage(u) {
  const p = u.searchParams;
  const price = Number(p.get('price') || 0), interval = p.get('interval') || 'month';
  const pay = new URL('https://knowdrive.ai/__fake_pay'); pay.search = u.search;
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>KnowDrive checkout (fake)</title>
<style>body{font:16px system-ui;margin:0;padding:24px;max-width:480px;margin:auto;color:#222}h1{font-size:22px}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}button{width:100%;padding:14px;font-size:16px;margin-top:20px;border-radius:10px;border:0;background:#222;color:#fff}</style>
<h1>Subscribe to KnowBot</h1><p>Fake payment page (local harness). Nothing is charged.</p>
<div class=row><span>Bot</span><b id=bot>${(p.get('bot') || '').replace(/[<&]/g, '')}</b></div>
<div class=row><span>Plan</span><b>$${price.toLocaleString()} / ${interval}</b></div>
<div class=row><span>Email</span><b id=email>${(p.get('email') || '').replace(/[<&]/g, '')}</b></div>
<div class=row><span>KnowDrive account</span><b id=acct>${(p.get('kd_account') || 'none').replace(/[<&]/g, '')}</b></div>
<form method=get action="${pay.origin}${pay.pathname}">${[...p.entries()].map(([k, v]) => `<input type=hidden name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('')}<button id=pay type=submit>Pay $${price}</button></form>`;
}

// ------------------------------------------------------------------ the LOCAL journey
async function localJourney(browser, dev, vp, files) {
  console.log(`\n=== local · ${vp.name} ===`);
  const { run, step } = makeRun(vp);
  const ctxOpts = { viewport: vp.viewport, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 };
  const context = await browser.newContext(ctxOpts);
  const bucket = { console: [], network: [] };
  let checkoutUrl = null, paid = null;
  const convertDelayMs = 2500; // the payment provider's webhook lands a moment after the redirect, like production
  await context.route(/^https:\/\/knowdrive\.ai\//, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/__fake_pay') {
      const trial = u.searchParams.get('trial');
      paid = { trial, at: Date.now() };
      setTimeout(() => { fetch(`${dev.url}/api/studio/trials/${trial}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin' }, body: JSON.stringify({ account: u.searchParams.get('kd_account') || 'acct-e2e', bucketId: `bot-${trial.slice(3, 15).toLowerCase()}` }) }).then((r) => { paid.convert = r.status; }).catch((e) => { paid.convert = e.message; }); }, convertDelayMs);
      return route.fulfill({ status: 302, headers: { location: u.searchParams.get('return') } });
    }
    if (/^\/signup/.test(u.pathname)) { checkoutUrl = u.toString(); return route.fulfill({ status: 200, contentType: 'text/html', body: fakeCheckoutPage(u) }); }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>KnowDrive</title><h1>KnowDrive</h1>' });
  });
  let page = await context.newPage();
  watch(page, bucket);
  const email = `owner-${vp.name}-${Date.now().toString(36)}@example.com`;
  const t0 = Date.now();
  let firstAnswerMs = null;

  await step(page, bucket, 'landing', async () => {
    await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#kl-landing', { state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-landing'));
  });

  await step(page, bucket, 'upload-my-files', async (rec) => {
    await page.waitForFunction(() => typeof window.__studio?.landing === 'function', null, { timeout: 20000 }).catch(() => {});
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.click('[data-kl="upload"]')]);
    await chooser.setFiles(files);
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-landing'), null, { timeout: 10000 });
    const s = await waitFor(page, (s) => s.files.length >= files.length && s, 15000);
    if (!s) throw new Error('the uploaded files never appeared');
    rec.notes.push(`${s.files.length} file(s) on the way`);
  }, { allowNoAction: false });

  await step(page, bucket, 'files-read', async (rec) => {
    await dismissGuide(page);
    const s = await waitFor(page, (s) => s.files.length && s.files.every((f) => f.stage === 'ready' || f.stage === 'failed') && s, 120000);
    if (!s) throw new Error('files never finished reading');
    const failed = s.files.filter((f) => f.stage === 'failed');
    if (failed.length) throw new Error(`files failed: ${failed.map((f) => f.name).join(', ')}`);
    await pane(page, vp, 'bot');
    rec.notes.push(`ready ${((Date.now() - t0) / 1000).toFixed(1)} s after landing`);
  }, { budgetMs: 90000 });

  await step(page, bucket, 'first-answer', async (rec) => {
    const { q, a } = await askFirstStarter(page, vp);
    if (!a) throw new Error(`no answer to "${q}"`);
    if (a.status !== 'grounded') throw new Error(`first starter was not answered from the files: ${a.status} "${a.text.slice(0, 80)}"`);
    firstAnswerMs = Date.now() - t0;
    rec.notes.push(`"${q}" answered ${(firstAnswerMs / 1000).toFixed(1)} s after landing`);
  });

  await step(page, bucket, 'refusal', async (rec) => {
    const a = await askTyped(page, vp, 'What is the weather in Paris today?');
    if (!a) throw new Error('no reply to an off-topic question');
    if (!a.text.includes(NOT_IN_DATA)) throw new Error(`off-topic reply was not the refusal: "${a.text.slice(0, 120)}"`);
    rec.notes.push('refuses honestly');
  });

  await step(page, bucket, 'launch', async () => {
    await pane(page, vp, 'setup');
    const b = page.locator('#st-price');
    await b.waitFor({ state: 'visible', timeout: 10000 });
    await b.click();
    // Launch first shows what you get (the launch sheet); its one primary button continues to the account step
    await page.locator('.kda-dialog, .co-cta:visible').first().waitFor({ timeout: 15000 });
  });

  await step(page, bucket, 'launch-confirm', async () => {
    if (!(await page.locator('.kda-dialog').count())) await page.locator('.co-cta:visible').filter({ hasText: /^Launch/ }).last().click();
    await page.locator('.kda-dialog').waitFor({ timeout: 15000 });
    await page.locator('#kda-create').waitFor({ timeout: 15000 });
  });

  let popup = null;
  await step(page, bucket, 'account-signup-window', async () => {
    [popup] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), page.locator('#kda-create').click()]);
    watch(popup, bucket, '[sign-in window] ');
    await popup.waitForURL(/\/-\/oauth\/authorize/, { timeout: 15000 });
    await popup.locator('#email').waitFor();
  }, { page: () => popup || page, external: true });

  await step(page, bucket, 'account-created', async () => {
    await popup.locator('#email').fill(email);
    await popup.locator('#kd-create').click();
    await popup.waitForEvent('close', { timeout: 15000 }).catch(() => {});
    if (!popup.isClosed()) throw new Error('the sign-in window did not close itself');
    await page.locator('.kda-who', { hasText: email }).first().waitFor({ timeout: 15000 });
  }, { allowNoAction: true });

  await step(page, bucket, 'files-moved', async (rec) => {
    await page.locator('#kda-continue').waitFor({ timeout: 60000 });
    const acct = dev.kd.auth.accounts.get(email);
    const copies = acct ? dev.kd.auth.storeFiles(acct.store) : [];
    if (copies.length !== files.length) throw new Error(`expected ${files.length} file(s) in the new account's store, found ${copies.length}`);
    rec.notes.push(`${copies.length} file(s) now in the account's own store`);
  });

  await step(page, bucket, 'checkout-sheet', async () => {
    await page.locator('#kda-continue').click();
    await page.locator('#co-email').waitFor({ timeout: 15000 });
    const v = await page.locator('#co-email').inputValue();
    if (v !== email) throw new Error(`checkout email is "${v}", expected the KnowDrive email`);
  });

  await step(page, bucket, 'payment-page', async (rec) => {
    await page.locator('#co-modal-slot button.co-cta', { hasText: /secure checkout/i }).first().click();
    await page.waitForURL(/knowdrive\.ai\/signup/, { timeout: 20000 });
    const u = new URL(checkoutUrl);
    const ret = new URL(u.searchParams.get('return'));
    if (!u.searchParams.get('kd_account')) throw new Error('the checkout link has no kd_account');
    if (ret.searchParams.get('launched') !== '1' || !ret.searchParams.get('t')) throw new Error(`return URL is wrong: ${ret}`);
    rec.notes.push(`return carries ${[...ret.searchParams.keys()].join(', ')}${ret.hash ? ` ${ret.hash}` : ''}`);
  }, { external: true });

  await step(page, bucket, 'paid-return-activating', async (rec) => {
    await page.locator('#pay').click();
    await page.waitForURL((u) => u.toString().startsWith(dev.url), { timeout: 20000 });
    await page.waitForFunction(() => !!window.__studio?.store, null, { timeout: 20000 });
    const seen = await page.locator('.co-act, .co-success').first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    if (!seen) throw new Error('no activation or live card after the return from payment');
    rec.notes.push(`url after return: ${new URL(page.url()).search || '(none)'}${new URL(page.url()).hash}`);
  }, { allowNoAction: true });

  await step(page, bucket, 'live', async (rec) => {
    await pane(page, vp, 'setup');
    await page.locator('.co-success').first().waitFor({ timeout: 60000 });
    const s = await st(page);
    if (!s.trial.converted) throw new Error('trial not converted in the Studio state');
    const txt = await page.locator('.co-success').first().innerText();
    if (!/is live/.test(txt)) throw new Error(`live card text: ${txt.slice(0, 120)}`);
    if (!/<script/.test(txt)) rec.notes.push('no embed snippet on the live card');
    rec.notes.push(`paid → live in ${((Date.now() - paid.at) / 1000).toFixed(1)} s; convert ${paid.convert}`);
  });

  await step(page, bucket, 'live-bot-answers', async (rec) => {
    const a = await askTyped(page, vp, 'How many days of paid vacation do full-time employees get?');
    if (!a) throw new Error('the live bot did not answer');
    if (!/25/.test(a.text)) throw new Error(`live answer: ${a.text.slice(0, 160)}`);
    rec.notes.push('answers from the files in the customer store');
  });

  // reload (refresh safety) on the live bot
  await step(page, bucket, 'reload-live', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__studio?.store?.getState?.().trial?.id, null, { timeout: 20000 });
    await sleep(1500);
    const s = await st(page);
    if (!s.trial.converted) throw new Error('after a reload the bot is not shown as live');
    if (await page.evaluate(() => document.documentElement.hasAttribute('data-landing'))) throw new Error('reload shows the landing page');
  });

  // the restore link a visitor would use on another device: what the Studio offers after launch
  const link = await page.evaluate(() => {
    const a = [...document.querySelectorAll('input[readonly], a, .co-backin [title]')].map((x) => x.value || x.href || x.title || '').find((v) => /[?&]t=tr_[^&]+&k=/.test(v));
    return a || null;
  }).catch(() => null);

  // close the browser tab, come back later in the same browser
  await page.close();
  page = await context.newPage();
  watch(page, bucket);
  await step(page, bucket, 'come-back-same-browser', async (rec) => {
    await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__studio?.store?.getState?.().trial?.id, null, { timeout: 20000 });
    await sleep(1500);
    if (await page.evaluate(() => document.documentElement.hasAttribute('data-landing'))) throw new Error('a returning owner sees the new-visitor landing');
    const s = await st(page);
    if (!s.trial.converted) throw new Error('the returning owner does not see the live bot');
    const live = await page.locator('.co-success, [data-live], .st-live').first().isVisible().catch(() => false);
    rec.notes.push(live ? 'live card visible' : 'no live card on return');
  });

  // a different browser via the restore link
  await step(page, bucket, 'come-back-other-browser', async (rec) => {
    let url = link;
    if (!url) {
      rec.notes.push('the Studio showed no copyable restore link after launch; used the API link');
      url = await page.evaluate(() => { const s = window.__studio.store.getState().trial; return `${location.origin}${location.pathname}?t=${s.id}&k=${encodeURIComponent(s.restoreKey)}`; });
    }
    const other = await browser.newContext(ctxOpts);
    const p2 = await other.newPage();
    watch(p2, bucket, '[other browser] ');
    try {
      await p2.goto(url, { waitUntil: 'domcontentloaded' });
      await p2.waitForFunction(() => !!window.__studio?.store?.getState?.().trial?.id, null, { timeout: 20000 });
      await sleep(2000);
      const s = await st(p2);
      if (!s.trial.converted) throw new Error('restore link in another browser does not open the live bot');
      if (/[?&]k=/.test(p2.url())) throw new Error('the restore key stays in the address bar');
      await p2.screenshot({ path: path.join(OUT, vp.name, 'other-browser.png') });
      const a = await askTyped(p2, vp, 'How many days of paid vacation do full-time employees get?');
      if (!a || !/25/.test(a.text)) throw new Error('the bot in the other browser did not answer from the files');
    } finally { await other.close(); }
  }, { allowNoAction: true });

  run.summary = { firstAnswerMs, totalMs: Date.now() - t0, email };
  await context.close();
  return run;
}

// ------------------------------------------------------------------ the LIVE (production) safe steps
async function liveJourney(browser, vp) {
  console.log(`\n=== live · ${vp.name} ===`);
  const { run, step } = makeRun(vp);
  const context = await browser.newContext({ viewport: vp.viewport, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 });
  const bucket = { console: [], network: [] };
  // belt and braces: no form on knowdrive.ai is ever submitted by this script
  await context.route(/^https:\/\/(?:[a-z0-9-]+\.)?knowdrive\.ai\//, (route) => {
    const r = route.request();
    if (r.method() !== 'GET' && !/knowbot\.knowdrive\.ai/.test(r.url())) return route.abort();
    return route.continue();
  });
  let page = await context.newPage();
  watch(page, bucket);
  const t0 = Date.now();
  let firstAnswerMs = null;

  await step(page, bucket, 'landing', async () => {
    await page.goto(STUDIO_LIVE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#kl-landing', { state: 'visible', timeout: 20000 });
  });
  await step(page, bucket, 'try-samples', async () => {
    await page.waitForFunction(() => typeof window.__studio?.landing === 'function', null, { timeout: 30000 }).catch(() => {});
    await page.click('[data-kl="sample"]');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-landing'), null, { timeout: 10000 });
  });
  await step(page, bucket, 'files-read', async (rec) => {
    await dismissGuide(page);
    const s = await waitFor(page, (s) => s.files.length && s.files.every((f) => f.stage === 'ready' || f.stage === 'failed') && s, 120000);
    if (!s) throw new Error('sample files never finished reading');
    await pane(page, vp, 'bot');
    rec.notes.push(`${s.files.length} files ready ${((Date.now() - t0) / 1000).toFixed(1)} s after landing`);
  }, { budgetMs: 90000 });
  await step(page, bucket, 'first-answer', async (rec) => {
    const { q, a } = await askFirstStarter(page, vp);
    if (!a) throw new Error(`no answer to "${q}"`);
    firstAnswerMs = Date.now() - t0;
    rec.notes.push(`"${q}" → ${a.status} in ${(firstAnswerMs / 1000).toFixed(1)} s after landing`);
  });
  await step(page, bucket, 'launch', async () => {
    await pane(page, vp, 'setup');
    await page.locator('#st-price').click();
    await page.locator('.kda-dialog, .co-cta:visible, #st-log .st-chip:has-text("Launch with samples anyway")').first().waitFor({ timeout: 60000 });
  });
  await step(page, bucket, 'launch-confirm', async (rec) => {
    const anyway = page.locator('#st-log .st-chip:visible', { hasText: /Launch with samples anyway/ });
    if (!(await page.locator('.kda-dialog').count()) && await anyway.count()) {
      rec.notes.push('sample-only bot: Launch first asks to add own files; chose "Launch with samples anyway"');
      await anyway.last().click();
      await page.locator('.kda-dialog, .co-cta:visible').first().waitFor({ timeout: 60000 });
    }
    if (!(await page.locator('.kda-dialog').count())) await page.locator('.co-cta:visible').filter({ hasText: /^Launch/ }).last().click();
    await page.locator('.kda-dialog').waitFor({ timeout: 20000 });
    await page.locator('#kda-create, #kda-move, #kda-continue').first().waitFor({ timeout: 20000 });
  });
  let popup = null;
  await step(page, bucket, 'knowdrive-sign-in-window', async (rec) => {
    if (!(await page.locator('#kda-create').count())) throw new Error('Launch did not ask for a KnowDrive account');
    [popup] = await Promise.all([context.waitForEvent('page', { timeout: 20000 }), page.locator('#kda-create').click()]);
    watch(popup, bucket, '[knowdrive.ai] ');
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await sleep(2500);
    rec.notes.push(`window: ${new URL(popup.url()).origin}${new URL(popup.url()).pathname}`);
  }, { page: () => popup || page, external: true });
  await step(page, bucket, 'studio-waiting-for-sign-in', async () => {
    await page.locator('.kda-body', { hasText: /Finish signing in|Finish in the KnowDrive window|other window/i }).waitFor({ timeout: 10000 });
  }, { allowNoAction: true });
  await step(page, bucket, 'checkout-before-account', async (rec) => {
    // what a visitor gets if they try to reach checkout without an account (the API is the real one)
    const r = await page.evaluate(async () => { try { await window.__studio.api.checkout({}); return 'opened'; } catch (e) { return `${e.status} ${e.code}: ${e.message}`; } });
    rec.notes.push(`checkout without an account → ${r}`);
    await sleep(300);
    for (let i = bucket.network.length - 1; i >= 0; i--) if (/ 409 POST .*\/checkout\b/.test(bucket.network[i])) bucket.network.splice(i, 1);   // the probe's own expected 409
    try { await popup?.close(); } catch { /* ignore */ }
  }, { allowNoAction: true, noAxe: true });
  run.summary = { firstAnswerMs, totalMs: Date.now() - t0 };
  await context.close();
  return run;
}

// ------------------------------------------------------------------ report
async function writeReport() {
  const L = [];
  const all = report.runs.flatMap((r) => r.problems.map((p) => ({ ...p, viewport: r.viewport })));
  const ours = all.filter((p) => !p.external), theirs = all.filter((p) => p.external);
  L.push(`# Onboarding harness report (${MODE})`, '', `Run ${report.started}. Screenshots in \`${OUT}/<viewport>/\`.`, '');
  L.push(`**${ours.length} problem(s) in the Studio**, ${theirs.length} on external (knowdrive.ai / sign-in) pages.`, '');
  for (const r of report.runs) {
    L.push(`## ${r.viewport}`, '');
    if (r.summary) L.push(`First answer ${r.summary.firstAnswerMs ? `${(r.summary.firstAnswerMs / 1000).toFixed(1)} s` : 'never'} after landing; whole journey ${(r.summary.totalMs / 1000).toFixed(0)} s.`, '');
    L.push('| step | ok | time | next action | notes |', '|---|---|---|---|---|');
    for (const s of r.steps) L.push(`| ${s.id} | ${s.ok ? 'yes' : '**no**'} | ${(s.ms / 1000).toFixed(1)} s | ${s.next ? (s.next.primary.join(' / ') || (s.next.composer ? '(composer)' : '—')) : '?'} | ${[s.error, ...s.notes].filter(Boolean).join('; ').replace(/\|/g, '/')} |`);
    L.push('');
    if (r.problems.length) {
      L.push('Problems:', '');
      for (const p of r.problems) L.push(`- [${p.step}]${p.external ? ' (external page)' : ''} **${p.kind}**: ${p.detail.replace(/\n/g, ' ')} — \`${p.shot}\``);
      L.push('');
    } else L.push('No problems.', '');
  }
  const copy = ours.filter((p) => p.kind === 'copy');
  L.push('## Copy', '', copy.length ? 'Words a new visitor would have to decode, where they first appear (fix → plain words):' : 'No jargon found in what a new visitor sees (the Sources map keeps its own legend-explained "atoms"; code blocks and the opt-in Proof view are not audited).', '');
  for (const p of copy) L.push(`- [${p.viewport} ${p.step}] ${p.detail} — \`${p.shot}\``);
  L.push('');
  await fsp.mkdir(OUT, { recursive: true });
  await fsp.writeFile(path.join(OUT, 'REPORT.md'), L.join('\n'));
  await fsp.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  return { ours, theirs };
}

// ------------------------------------------------------------------ main
let browser, dev = null, failed = false;
try {
  await fsp.rm(OUT, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(OUT, { recursive: true });
  browser = await chromium.launch({ headless: !process.env.HEADED, ...(LIVE && process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}) });
  if (LIVE) {
    for (const vp of VIEWPORTS) await liveJourney(browser, vp);
  } else {
    const { startDevServer } = await import('./dev-server.mjs');
    dev = await startDevServer({ speed: Number(process.env.FAKE_SPEED || 4) || 4 });
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-onb-'));
    const extra = path.join(tmp, 'benefits.md');
    await fsp.writeFile(extra, '# Benefits\n\nNorthwind Studio pays for a yearly health check. Bikes to work: we pay up to $300 towards a bicycle once every three years.\n');
    const files = [path.join(__dirname, 'fixtures', 'handbook.md'), extra];
    for (const vp of VIEWPORTS) await localJourney(browser, dev, vp, files);
  }
} catch (e) {
  failed = true;
  console.error(`harness crashed: ${e.stack || e.message}`);
} finally {
  await browser?.close().catch(() => {});
  await dev?.close().catch(() => {});
}
const { ours, theirs } = await writeReport();
const stepFails = report.runs.flatMap((r) => r.steps).filter((s) => !s.ok).length;
console.log(`\n${ours.length} Studio problem(s), ${theirs.length} external, ${stepFails} failed step(s) · ${path.join(OUT, 'REPORT.md')}`);
process.exit(failed || stepFails || ours.length ? 1 : 0);

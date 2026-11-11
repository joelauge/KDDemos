#!/usr/bin/env node
// The plan's three tools (studio/surfaces.js TOOLS) end to end, against the dev server's fakes on 127.0.0.1 only:
//   1. the Website tool's ONE embed line (lib/embed.js) on a homepage: data-chat / data-homepage switch the chat bubble
//      and the homepage search, and a line without them follows the bot's saved switches (GET /v1/channels/:bot → website)
//   2. screenshots (deviceScaleFactor 2) of Set up (three tool cards with switches), the bot spec "Answers on" and the
//      launch / checkout price
//
//   TOOLS_SHOTS=/some/dir node studio/test/tools-shots.mjs      (default: studio/test/screens/tools)
import path from 'node:path';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.TOOLS_SHOTS || path.join(__dirname, 'screens', 'tools');
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`); return ok; };

const dev = await startDevServer({ speed: 4 });
const api = (p, init = {}) => fetch(`${dev.url}${p}`, init);
let home = null, browser = null;
try {
  const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
  const H = (x = {}) => ({ authorization: `Bearer ${t.token}`, ...x });
  const patch = (body) => api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
  await api(`/api/studio/trials/${t.trialId}/samples`, { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ set: 'lumen-bikes' }) });
  await patch({ name: 'Lumen Bikes Help', purpose: 'Answers about Lumen bikes, warranty, service plans and returns.', surfaces: ['webchat', 'sms', 'site'] });
  for (let i = 0; i < 240; i++) {
    const j = await (await api(`/api/studio/trials/${t.trialId}`, { headers: H() })).json();
    if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await api(`/api/studio/trials/${t.trialId}/site`, { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ published: true }) });
  const ch = await (await api(`/api/v1/channels/${t.trialId}`)).json();
  check('GET /v1/channels/:bot → website switches', JSON.stringify(ch.website) === JSON.stringify({ chat: true, voice: false, homepage: true }), JSON.stringify(ch.website));

  // ------------------------------------------------------------------ 1. the one embed line on a homepage
  let line = '';
  home = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Lumen Bikes</title></head><body><h1>Ride further.</h1>${line}</body></html>`);
  });
  await new Promise((r) => home.listen(0, '127.0.0.1', r));
  const homeUrl = `http://127.0.0.1:${home.address().port}/`;
  browser = await chromium.launch({ headless: !process.env.HEADED });
  const embed = (attrs) => `<script type="module" src="${dev.url}/lib/embed.js" data-api="${dev.url}" data-bot="${t.trialId}" ${attrs}></script>`;
  const probe = async (attrs) => {
    if (attrs != null) line = embed(attrs);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(homeUrl, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const got = await page.evaluate(() => ({ chat: !!document.querySelector('.kb-launcher'), homepage: !!document.querySelector('knowbot-overlay'), voice: !!document.querySelector('knowbot-voice') }));
    await ctx.close();
    return { ...got, errors };
  };
  let r = await probe('data-chat="on" data-voice="off" data-homepage="on"');
  check('embed: data-chat="on" data-homepage="on" → chat bubble + homepage search', r.chat && r.homepage && !r.voice, JSON.stringify(r));
  r = await probe('data-chat="off" data-voice="off" data-homepage="on"');
  check('embed: data-chat="off" data-homepage="on" → homepage search only', !r.chat && r.homepage && !r.voice, JSON.stringify(r));
  r = await probe('data-chat="off" data-voice="on" data-homepage="off"');
  check('embed: data-chat="off" data-voice="on" → the voice button only', !r.chat && !r.homepage && r.voice, JSON.stringify(r));
  r = await probe('');
  check('embed: no feature attributes → the bot\'s saved switches (chat bubble + homepage search)', r.chat && r.homepage && !r.voice, JSON.stringify(r));
  line = `<script type="module" src="${dev.url}/lib/embed.js" data-instance="nobot" data-api="${dev.url}"></script>`;
  r = await probe(null);
  check('embed: an old one-line snippet (no saved switches) is the chat bubble, as before', r.chat && !r.homepage && !r.voice, JSON.stringify(r));

  // ------------------------------------------------------------------ 2. screenshots
  await fsp.mkdir(SHOTS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${dev.studioUrl}?t=${t.trialId}&k=${encodeURIComponent(t.restoreKey)}`, { waitUntil: 'load' });
  await page.waitForSelector('.sh-opt[data-shape="webchat"]', { timeout: 30000 });
  await page.evaluate(() => { const b = document.querySelector('.st-seg-setup'); if (b) { b.hidden = false; b.click(); } });
  await page.waitForSelector('.gl-tool[data-tool="website"]', { timeout: 20000 });
  check('Set up: three tool cards', (await page.locator('.gl-tool').count()) === 3);
  const sw = await page.$$eval('.gl-feat input[role="switch"]', (xs) => xs.map((x) => `${x.dataset.surface}:${x.checked ? 'on' : 'off'}`).join(','));
  check('Set up: the saved surfaces map onto the switches', sw === 'webchat:on,webvoice:off,site:on,sms:on,phone:off,whatsapp:off,email:off', sw);
  await page.waitForTimeout(900);
  await page.locator('.gl-toolgrid').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'setup-tools.png') });
  await page.locator('#gl-chdetail').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'setup-website-line.png') });
  await page.click('.gl-tool[data-tool="number"] .gl-feat-open[data-ch="phone"]');
  await page.waitForTimeout(700);
  await page.locator('.gl-toolgrid').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'setup-number.png') });
  await page.click('.gl-tool[data-tool="email"] .gl-feat-open[data-ch="email"]');
  await page.waitForTimeout(700);
  await page.locator('#gl-chdetail').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'setup-email.png') });
  const emailCard = await page.textContent('#gl-chdetail');
  check('Email: vendor-neutral copy', !/SendGrid|Postmark|Mailgun|EMAIL_WEBHOOK_SECRET/.test(emailCard));
  // the bot spec drawer: Answers on = the three tools
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#st-botchip')?.click());
  await page.waitForSelector('.st-tools', { timeout: 20000 });
  await page.locator('.st-tools').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  check('spec: Answers on lists the three tools', (await page.locator('.st-tool').count()) === 3 && await page.isChecked('#st-surf-sms') && !(await page.isChecked('#st-surf-phone')));
  await page.screenshot({ path: path.join(SHOTS, 'spec-answers-on.png') });
  const box = await page.locator('.st-tools').boundingBox();
  if (box) await page.screenshot({ path: path.join(SHOTS, 'spec-answers-on-crop.png'), clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 40), width: box.width + 32, height: box.height + 90 } });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // launch: the Builder opens the launch card; the CTA opens the checkout with the one plan
  const composer = page.locator('#st-setup-composer');
  await composer.fill('launch it');
  await composer.press('Enter');
  const anyway = page.locator('button', { hasText: 'Launch with samples anyway' }).last();
  await anyway.waitFor({ timeout: 15000 }).catch(() => {});
  if (await anyway.count()) await anyway.click();
  await page.waitForSelector('.co-plan, .co-stage', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const price = await page.evaluate(() => document.body.innerText.match(/\$\d[\d,]*(?:\/\w+)?/g) || []);
  check('launch: the one plan price shows, never a per-surface total', price.includes('$549/mo') && !price.some((p) => /^\$(?:249|2,499|747|1,743)\b/.test(p)), price.join(' '));
  await page.screenshot({ path: path.join(SHOTS, 'launch-card.png') });
  const cta = page.locator('.co-stage button.co-cta, [data-card="launch"] button.co-cta').filter({ hasText: /Launch/ }).last();
  if (await cta.count()) {
    await cta.click();
    await page.waitForSelector('.co-surf', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(900);
    const plan = await page.textContent('.co-sheet .co-surf, .co-surf').catch(() => '');
    check('checkout: one plan line at $549/mo, the three tools listed', /KnowBot plan/.test(plan) && /\$549\/mo/.test(plan) && /Website/.test(plan) && /KnowBot number/.test(plan) && /Email/.test(plan), plan);
    await page.screenshot({ path: path.join(SHOTS, 'checkout-plan.png') });
    const yearly = page.locator('.co-iv-btn', { hasText: 'Yearly' }).last();
    if (await yearly.count()) { await yearly.click(); await page.waitForTimeout(500); }
    check('checkout: yearly is $5,490/yr', /\$5,490\/yr/.test(await page.textContent('.co-surf').catch(() => '')));
    await page.screenshot({ path: path.join(SHOTS, 'checkout-plan-yearly.png') });
  } else check('launch CTA found', false);
  const head = await page.textContent('#st-price').catch(() => '');
  check('header chip shows the one plan price', /\$549\/mo|Launch|Free to build/.test(head), head);
  check('no page errors', !errors.length, errors.join(' | '));
  await ctx.close();
} finally {
  await browser?.close();
  home?.close();
  await dev.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

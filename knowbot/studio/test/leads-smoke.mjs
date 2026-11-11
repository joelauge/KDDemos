#!/usr/bin/env node
// The Studio Leads report, end to end in a real browser (Playwright) against studio/test/dev-server.mjs (fake knowDrive,
// fake model, fake mail / texting sinks on 127.0.0.1; never a real service):
//
//   1. a Studio bot with the sample files answers; a visitor asks "email me that" → the address is a lead and the e-mail's
//      links are tracked short links (one is clicked); the bot is texted, messaged on WhatsApp and e-mailed (signed
//      webhooks) → three inbound leads; a phone call's checkout link is recorded (the phone flow itself has its own test
//      in server/test/voice-live.test.mjs) and clicked
//   2. the Leads panel opens from the header: totals, interactions by channel, the leads table, checkout links + clicks,
//      7 / 30 days, the tracking switch, and Download CSV (the downloaded file's columns and rows are checked)
//   3. axe (when the CDN is reachable), Escape closes and focus returns, light + dark screenshots at 2x
//
//   npm run leads:smoke                  # SHOTS=<dir> to keep the screenshots and the sample CSV somewhere else
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { startDevServer, DEV_CHANNEL_SECRETS } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'kb-leads-shots');
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';
const CSV_HEAD = 'timestamp,bot,channel,type,email,phone,question,utm_source,utm_medium,utm_campaign,click_id,clicked_at,checkout_items,consent,session';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`); if (!ok) failures++; return ok; };

const dev = await startDevServer({ speed: 8 });
const api = (p, init = {}) => fetch(dev.url + p, init);
const twSig = (url, params) => createHmac('sha1', DEV_CHANNEL_SECRETS.TWILIO_AUTH_TOKEN).update(Buffer.from(Object.keys(params).sort().reduce((a, k) => a + k + (params[k] ?? ''), url), 'utf8')).digest('base64');
const twilio = (p, params) => api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twSig(dev.url + p, params) }, body: new URLSearchParams(params).toString() });
const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);
let browser;
try {
  console.log('1. data: a Studio bot, a "send me this" e-mail, inbound SMS / WhatsApp / e-mail, a checkout link');
  const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
  const H = { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
  const T = (p) => `/api/studio/trials/${t.trialId}${p}`;
  await api(T('/samples'), { method: 'POST', headers: H, body: JSON.stringify({ set: 'lumen-bikes' }) });
  for (let i = 0; i < 600; i++) {
    const j = await (await api(T('/files'), { headers: H })).json();
    if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ask = async (question) => sse(await (await api(T('/ask'), { method: 'POST', headers: H, body: JSON.stringify({ question }) })).text()).find((e) => e.event === 'final')?.data;
  check('the bot answers from its files', (await ask('How long is the frame warranty?'))?.status === 'grounded');
  const sent = await ask('can you email me that at jordan.lee@example.com?');
  check('"email me that" sends', sent?.sendInfo?.status === 'sent', JSON.stringify(sent?.sendInfo));
  const mail = dev.sink.sent.filter((x) => x.path === '/emails').at(-1)?.body;
  const short = /https?:\/\/[^\s"]+\/r\/[A-Za-z0-9]+/.exec(mail?.text || '')?.[0];
  check('the e-mail carries a tracked short link', !!short, mail?.text?.slice(0, 120));
  if (short) {
    const hop = await fetch(short, { redirect: 'manual' });
    const loc = hop.headers.get('location') || '';
    check('the short link 302s to the proof page with utm_source=knowbot and a click id', hop.status === 302 && /\/p\/[^?]+\?.*utm_source=knowbot.*kb_cid=/.test(loc), loc);
  }
  const sms = await twilio(`/v1/channels/${t.trialId}/sms`, { From: '+14165550142', To: '+15555550100', Body: 'Do you ship to Canada?', MessageSid: 'SMleads1', NumMedia: '0' });
  check('an SMS to the bot is answered', sms.status === 200 && /<Message>/.test(await sms.text()));
  await twilio(`/v1/channels/${t.trialId}/whatsapp`, { From: 'whatsapp:+14165550199', To: 'whatsapp:+15555550100', Body: 'How long is the frame warranty?', MessageSid: 'SMleads2', NumMedia: '0' });
  await api(`/v1/channels/${t.trialId}/email`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`postmark:${DEV_CHANNEL_SECRETS.EMAIL_WEBHOOK_SECRET}`).toString('base64')}` },
    body: JSON.stringify({ From: 'Sam Rivera <sam.rivera@example.org>', FromFull: { Email: 'sam.rivera@example.org', Name: 'Sam Rivera' }, To: 'bot@studio.test', Subject: 'Returns', TextBody: 'Can I return a bike I rode once?', Headers: [] }) });
  // a phone call's caller ID and its texted checkout link (the call itself: server/test/voice-live.test.mjs)
  const L = dev.kb.leads;
  L.lead({ botId: t.trialId, channel: 'phone', value: '+16475550123', consent: 'inbound_call', question: 'Is the E-City 500 in stock in large?' });
  const cid = 'phonecall01';
  const link = L.link({ botId: t.trialId, url: `${dev.shopUrl}/cart/3:1?ref=ai-voice-agent`, channel: 'phone', delivery: 'sms', kind: 'checkout', cid, base: `${dev.url}/api` });
  L.checkout({ botId: t.trialId, channel: 'phone', phone: '+16475550123', items: [{ title: 'E-City 500', quantity: 1 }, { title: 'Commuter Lite', variant: 'Default', quantity: 2 }], cid });
  check('the checkout short link redirects to the cart', (await fetch(link, { redirect: 'manual' })).status === 302);
  await L.idle();
  const rep = await (await api(T('/leads?days=30'), { headers: H })).json();
  check('the report lists 5 leads', rep.leads?.length === 5, JSON.stringify(rep.leads?.map((l) => `${l.channel}:${l.type}`)));
  check('the report needs the trial token', (await api(T('/leads'))).status === 401 && (await api(T('/leads.csv'))).status === 401);

  console.log('2. the Leads panel');
  browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  let axeSource = null;
  try { const r = await fetch(AXE_URL, { signal: AbortSignal.timeout(8000) }); if (r.ok) axeSource = await r.text(); } catch { axeSource = null; }
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme, acceptDownloads: true });
    await context.addInitScript(({ trial, theme: th }) => {
      try {
        localStorage.setItem('kb-landing', 'skip');
        localStorage.setItem('knowbot-theme', th);
        localStorage.setItem('kb-studio:v1', JSON.stringify({ trial: { id: trial.trialId, token: trial.token, expiresAt: trial.expiresAt }, ui: { view: 'bot' }, milestones: { firstFile: 1, firstReady: 1, firstCited: 1 } }));
      } catch { /* ignore */ }
    }, { trial: t, theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    const btn = page.locator('#st-leads');
    await btn.waitFor({ state: 'visible', timeout: 20000 });
    check(`${theme}: the header has a Leads button`, await btn.isVisible());
    await btn.click();
    const dlg = page.locator('dialog.kb-leads[open]');
    await dlg.waitFor({ timeout: 10000 });
    await page.locator('.kb-leads-tile').first().waitFor({ timeout: 10000 });
    check(`${theme}: the dialog is named "Leads"`, (await page.locator('#kb-leads-title').textContent()) === 'Leads');
    const tiles = await page.locator('.kb-leads-tile-n').allTextContents();
    check(`${theme}: totals (questions, leads, checkout links, clicks)`, tiles.length === 4 && Number(tiles[1]) === 5 && Number(tiles[2]) === 1 && Number(tiles[3]) >= 2, tiles.join(' / '));
    const bars = await page.locator('.kb-leads-bars li').allTextContents();
    check(`${theme}: interactions by channel`, bars.some((b) => /SMS/.test(b)) && bars.some((b) => /WhatsApp/.test(b)) && bars.some((b) => /Email/.test(b)), bars.join(' | '));
    const rows = await page.locator('#kb-leads-ls ~ .kb-leads-scroll tbody tr').allTextContents();
    check(`${theme}: the leads table`, rows.length === 5 && rows.some((r) => r.includes('jordan.lee@example.com') && /Clicked/.test(r)) && rows.some((r) => r.includes('(416) 555-0142')), rows.join(' | ').slice(0, 300));
    const co = await page.locator('#kb-leads-co ~ .kb-leads-scroll tbody tr').allTextContents();
    check(`${theme}: checkout links sent, with the click`, co.length === 1 && /E-City 500/.test(co[0]) && /Clicked/.test(co[0]), co.join(' | '));
    const text = await dlg.textContent();
    check(`${theme}: no provider names in the copy`, !/twilio|stripe|shopify|resend|postmark|sendgrid|mailgun|gemini/i.test(text));
    await page.screenshot({ path: path.join(SHOTS, `leads-${theme}.png`) });
    await dlg.locator('.kb-leads-panel').screenshot({ path: path.join(SHOTS, `leads-panel-${theme}.png`) });
    if (theme === 'light') {
      // 7 days, the tracking switch, the CSV
      await page.getByRole('button', { name: 'Last 7 days' }).click();
      await page.waitForFunction(() => /last 7 days/.test(document.querySelector('.kb-leads-status')?.textContent || ''));
      check('7 days: the range switches', (await page.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')) === 'true');
      const sw = page.getByRole('switch', { name: 'Track links' });
      check('tracking is on by default', (await sw.getAttribute('aria-checked')) === 'true');
      await sw.click();
      await page.waitForFunction(() => /tracking is off/i.test(document.querySelector('.kb-leads-status')?.textContent || ''));
      const off = await (await api(T('/leads'), { headers: H })).json();
      check('the switch turns tracking off on the server', off.tracking === false);
      await sw.click();
      await page.waitForFunction(() => /tracking is on/i.test(document.querySelector('.kb-leads-status')?.textContent || ''));
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('button', { name: 'Download CSV' }).click()]);
      const file = path.join(SHOTS, 'sample-leads.csv');
      await download.saveAs(file);
      const csv = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
      const lines = csv.trimEnd().split('\r\n');
      check('the CSV downloads with the CRM columns', lines[0] === CSV_HEAD, lines[0]);
      check('the CSV has every lead and the checkout link', lines.length === 7 && lines.some((l) => /,checkout,,\+16475550123,/.test(l)) && lines.some((l) => l.includes('jordan.lee@example.com') && /,knowbot,webchat,tr_/.test(l)), `${lines.length} lines`);
      check('the file is named for the bot', /^knowbot-leads-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
      if (axeSource) {
        await page.addScriptTag({ content: axeSource });
        const res = await page.evaluate(async () => (await window.axe.run(document.querySelector('dialog.kb-leads'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`));
        check('axe: no WCAG A/AA violations in the panel', !res.length, res.join(', '));
      } else console.log('  (axe skipped: CDN unreachable)');
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.kb-leads', { state: 'detached', timeout: 5000 });
      check('Escape closes it and focus returns to the Leads button', await page.evaluate(() => document.activeElement?.id === 'st-leads'));
      // mobile: the ⋯ menu has it, the panel fills the screen
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#st-more').click();
      await page.getByRole('menuitem', { name: 'Leads' }).click();
      await page.locator('.kb-leads-tile').first().waitFor({ timeout: 10000 });
      const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('.kb-leads-panel').getBoundingClientRect().width <= window.innerWidth);
      check('mobile: opens from the ⋯ menu, no horizontal page scroll', wide);
      await page.screenshot({ path: path.join(SHOTS, 'leads-mobile-light.png') });
    }
    check(`${theme}: no page errors`, !errors.length, errors.join(' | '));
    await context.close();
  }
} catch (e) {
  check('leads smoke ran to the end', false, e.stack || e.message);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed · screenshots and sample CSV in ${SHOTS}`);
process.exit(failures ? 1 : 0);

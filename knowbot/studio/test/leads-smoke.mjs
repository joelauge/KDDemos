#!/usr/bin/env node
// Stats & Leads, end to end in a real browser (Playwright) against studio/test/dev-server.mjs (fake knowDrive, fake
// model, fake mail / texting sinks on 127.0.0.1; never a real service). The browser runs in America/Toronto, so "a day"
// is the viewer's day, not UTC.
//
//   1. data: a Studio bot with the sample files answers; a visitor asks "email me that" → the address is a lead and the
//      e-mail's links are tracked short links (one is clicked); the bot is texted, messaged on WhatsApp and e-mailed
//      (signed webhooks) → three inbound leads; a phone call's checkout link is recorded and clicked; and three weeks of
//      earlier questions on every channel are put in the question log
//   2. the view: opens from the header button as a full view (not a dialog) at #stats; totals; the questions-by-day chart
//      (labelled, keyboard: arrows + Enter pick a day → that day's questions); deep link + reload keep the day; the
//      history's filters (channel, outcome, search, Studio tests), paging, the answer and its sources, "Add what's
//      missing"; What people ask → "see all"; the sortable leads table and a lead's question → the history; checkout
//      links; 7 days / All; the tracking switch; both CSV downloads; axe; Esc and Back close it
//   3. phones: opens from the ⋯ menu, one column, no horizontal page scroll, no clipped tiles; axe
//   Light + dark screenshots at 2x, desktop and phone.
//
//   npm run leads:smoke                  # SHOTS=<dir> to keep the screenshots and the sample CSVs somewhere else
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { startDevServer, DEV_CHANNEL_SECRETS } from './dev-server.mjs';
import { outDir, injectAxe, watchErrors } from './smoke-util.mjs';
import { logQuestion } from '../../server/questions.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = outDir('leads', process.env.SHOTS);
const CSV_HEAD = 'timestamp,bot,channel,type,email,phone,question,utm_source,utm_medium,utm_campaign,click_id,clicked_at,checkout_items,consent,session';
const TZ = 'America/Toronto';
const DAY = 86400000;

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${String(detail).slice(0, 240)}` : ''}`); if (!ok) failures++; return ok; };

const dev = await startDevServer({ speed: 8 });
const api = (p, init = {}) => fetch(dev.url + p, init);
const twSig = (url, params) => createHmac('sha1', DEV_CHANNEL_SECRETS.TWILIO_AUTH_TOKEN).update(Buffer.from(Object.keys(params).sort().reduce((a, k) => a + k + (params[k] ?? ''), url), 'utf8')).digest('base64');
const twilio = (p, params) => api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twSig(dev.url + p, params) }, body: new URLSearchParams(params).toString() });
const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);
let browser;
try {
  console.log('1. data: a Studio bot, a "send me this" e-mail, inbound SMS / WhatsApp / e-mail, a checkout link, three weeks of questions');
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
  // three weeks of earlier questions, on every channel (the same question log the bot writes to; the server runs in this process)
  const now = Date.now();
  const noonAgo = (d) => { const x = new Date(now - d * DAY); x.setUTCHours(17, 0, 0, 0); return x.getTime(); }; // 17:00 UTC = midday in Toronto, the same local day all year
  const ASKS = [['How long is the frame warranty?', 1], ['Do you ship to Canada?', 1], ['What are your opening hours?', 1], ['Can I return a bike I rode once?', 1], ['Is the battery covered?', 1],
    ['Do you price match other shops?', 0], ['Do you sell cargo trailers?', 0], ['What is the capital of France?', 0]];
  const CH = ['web', 'web', 'sms', 'phone', 'whatsapp', 'email', 'site', 'voice'];
  let seeded = 0;
  for (let d = 1; d <= 20; d++) {
    const n = d === 3 ? 12 : d % 7 === 0 ? 0 : 2 + (d % 4); // a busy day, a few empty ones
    for (let i = 0; i < n; i++) {
      const [q, ok] = ASKS[(d * 3 + i) % ASKS.length];
      logQuestion({ scopeTags: [`trial:${t.trialId}`, 'kind:trial'], question: q, outcome: ok ? 'answered' : 'refused', channel: CH[(d + i) % CH.length], callerKey: `seed-${d}-${i}`, now: noonAgo(d) + i * 600000,
        citations: ok ? [{ file: 'warranty-and-returns.md' }] : [], topScore: ok ? 0.88 : /capital/.test(q) ? 0.2 : 0.7,
        // only the newest week carries its answer, like questions asked before answers were stored
        ...(ok && d <= 7 ? { answer: `From your files: ${q.replace(/\?$/, '')}. Details: care@lumen.example or 416 555 0142.` } : {}) });
      seeded++;
    }
  }
  logQuestion({ scopeTags: [`trial:${t.trialId}`, 'kind:trial'], question: 'How much is the tune-up?', outcome: 'answered', channel: 'phone', callerKey: 'seed-flag', now: noonAgo(2) + 3600000, flags: ['unsupported_figure'], note: 'said 79 dollars, not in the facts' });
  seeded++;
  const rep = await (await api(T('/leads?days=30'), { headers: H })).json();
  check('the report lists 5 leads', rep.leads?.length === 5, JSON.stringify(rep.leads?.map((l) => `${l.channel}:${l.type}`)));
  check('the report and the history need the trial token', (await api(T('/leads'))).status === 401 && (await api(T('/leads.csv'))).status === 401 && (await api(T('/history'))).status === 401 && (await api(T('/history.csv'))).status === 401);
  const h30 = await (await api(T('/history?days=30&tz=-300'), { headers: H })).json();
  check(`the history has the seeded questions (${seeded}) and today's`, h30.total >= seeded + 4 && h30.byDay?.length === 30, `${h30.total} of ${seeded}+`);

  console.log('2. the Stats & Leads view');
  browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  const inView = (page, fn, arg) => page.evaluate(fn, arg);
  const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.kb-hist-row')].map((r) => ({ q: r.querySelector('.kb-hist-qtext')?.textContent, ch: r.dataset.channel, out: r.dataset.outcome, time: r.querySelector('time')?.dateTime })));
  const histSettled = (page) => page.waitForFunction(() => document.querySelector('#kb-hist') && !document.querySelector('#kb-hist[aria-busy], .kb-stats-body[aria-busy]'), null, { timeout: 10000 });
  const matched = async (page) => Number((await page.locator('#kb-hist-n').textContent()).replace(/\D/g, ''));
  const axe = async (page) => injectAxe(page).then(() => page.evaluate(async () => (await window.axe.run(document.querySelector('#kb-stats'), { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0]?.target})`)))
    .catch((e) => [`axe did not run: ${e.message}`]);
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme, acceptDownloads: true, timezoneId: TZ, locale: 'en-CA' });
    await context.addInitScript(({ trial, theme: th }) => {
      try {
        localStorage.setItem('kb-landing', 'skip');
        localStorage.setItem('knowbot-theme', th);
        localStorage.setItem('kb-studio:v1', JSON.stringify({ trial: { id: trial.trialId, token: trial.token, expiresAt: trial.expiresAt }, ui: { view: 'bot' }, milestones: { firstFile: 1, firstReady: 1, firstCited: 1 } }));
      } catch { /* ignore */ }
    }, { trial: t, theme });
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(dev.studioUrl, { waitUntil: 'domcontentloaded' });
    // desktop: "Stats & Leads" is a quiet text button in the header, left of Launch
    const btn = page.locator('#st-leads');
    await btn.waitFor({ state: 'visible', timeout: 20000 });
    check(`${theme}: the header has Stats & Leads, left of Launch`, await btn.isVisible() && (await btn.textContent()) === 'Stats & Leads'
      && await page.evaluate(() => document.getElementById('st-leads').getBoundingClientRect().right <= document.getElementById('st-pricewrap').getBoundingClientRect().left));
    await btn.click();
    const view = page.locator('#kb-stats');
    await view.waitFor({ timeout: 10000 });
    await page.locator('.kb-leads-tile').first().waitFor({ timeout: 10000 });
    await histSettled(page);
    check(`${theme}: it opens as a full view at #stats, not a dialog`, await inView(page, () => {
      const v = document.getElementById('kb-stats'), r = v.getBoundingClientRect();
      return location.hash === '#stats' && !document.querySelector('dialog[open]') && v.tagName === 'SECTION' && r.width === innerWidth && r.height === innerHeight
        && document.getElementById('st-app').inert && document.activeElement?.id === 'kb-stats-title';
    }));
    check(`${theme}: the view is named "Stats & Leads"`, (await page.locator('#kb-stats-title').textContent()) === 'Stats & Leads' && /Stats & Leads/.test(await page.title()));
    const tiles = await page.locator('.kb-leads-tile-n').allTextContents();
    check(`${theme}: totals (questions, leads, checkout links, clicks)`, tiles.length === 4 && Number(tiles[0]) === h30.total && Number(tiles[1]) === 5 && Number(tiles[2]) === 1 && Number(tiles[3]) >= 2, tiles.join(' / '));

    // ---- questions by day
    const chart = await inView(page, () => {
      const bars = [...document.querySelectorAll('.kb-bar')];
      const r = getComputedStyle(document.querySelector('.kb-chart-key .kb-bar-r')), a = getComputedStyle(document.querySelector('.kb-chart-key .kb-bar-a'));
      return { n: bars.length, labels: bars.map((b) => b.getAttribute('aria-label')), ticks: [...document.querySelectorAll('.kb-bar-x.is-tick')].map((x) => x.textContent), y: [...document.querySelectorAll('.kb-chart-y span')].map((x) => x.textContent),
        counts: [...document.querySelectorAll('.kb-bar-n')].map((x) => x.textContent), key: [...document.querySelectorAll('.kb-chart-key li')].map((x) => x.textContent), tabStops: bars.filter((b) => b.tabIndex === 0).length,
        hatched: /gradient/.test(r.backgroundImage) && !/gradient/.test(a.backgroundImage), group: document.querySelector('.kb-chart-plot').getAttribute('aria-label') };
    });
    check(`${theme}: the chart has a bar per day with dates on the axis and readable counts`, chart.n === 30 && chart.ticks.length >= 5 && chart.ticks.every((x) => /[A-Za-z]{3}\.? \d|\d{1,2} [A-Za-z]{3}/.test(x)) && chart.y.includes('0') && Number(chart.y[0]) >= 12 && chart.counts.includes('12'),
      `${chart.n} bars · ticks ${chart.ticks.join(', ')} · y ${chart.y.join('/')}`);
    check(`${theme}: answered and not-in-files differ by pattern, not only colour, and are named in a legend`, chart.hatched && chart.key.join('|') === 'Answered|Not in your files');
    check(`${theme}: every bar is a named button; the chart is one tab stop`, chart.labels.every((l) => /: (?:no questions|[\d,]+ questions?: [\d,]+ answered, [\d,]+ not in your files)$/.test(l)) && chart.tabStops === 1 && /Arrow keys/.test(chart.group), chart.labels[26]);
    await page.screenshot({ path: path.join(SHOTS, `stats-desktop-${theme}.png`) });
    await page.screenshot({ path: path.join(SHOTS, `stats-desktop-${theme}-full.png`), fullPage: false });

    if (theme === 'light') {
      // keyboard: the newest day has the tab stop; three days back is the busy day; Enter picks it
      await page.locator('.kb-bar[tabindex="0"]').focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
      const busy = await page.evaluate(() => ({ day: document.activeElement.dataset.day, label: document.activeElement.getAttribute('aria-label') }));
      await page.keyboard.press('Enter');
      await page.waitForFunction((d) => document.querySelector(`.kb-bar[data-day="${d}"]`)?.getAttribute('aria-pressed') === 'true', busy.day);
      await histSettled(page);
      let rows = await rowsOf(page);
      const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
      check('keyboard: arrows move between days and Enter picks one → that day\'s questions', /: 12 questions: /.test(busy.label) && rows.length === 12 && rows.every((r) => localDay(r.time) === busy.day) && (await matched(page)) === 12
        && await page.evaluate((d) => document.activeElement?.dataset.day === d, busy.day), `${busy.label} · ${rows.length} rows`);
      check('the picked day is named with its counts, and is in the address', /12 questions/.test(await page.locator('.kb-chart figcaption').textContent()) && await page.evaluate((d) => location.hash === `#stats?day=${d}`, busy.day), await page.evaluate(() => location.hash));
      check('the day header carries the day\'s count', /12 questions/.test(await page.locator('.kb-hist-dayh').first().textContent()) && (await page.locator('.kb-hist-dayh').count()) === 1);
      await page.screenshot({ path: path.join(SHOTS, 'stats-desktop-day.png') });
      // deep link + reload: the same view, the same day
      await page.reload({ waitUntil: 'domcontentloaded' });
      await view.waitFor({ timeout: 20000 });
      await histSettled(page);
      rows = await rowsOf(page);
      check('reload on #stats?day=… opens the view on that day', rows.length === 12 && await page.evaluate((d) => document.querySelector(`.kb-bar[data-day="${d}"]`)?.getAttribute('aria-pressed') === 'true' && !document.querySelector('dialog[open]'), busy.day));
      // click another day, then back to all days
      const other = await page.evaluate(() => [...document.querySelectorAll('.kb-bar')].find((b) => /: [3-9] questions/.test(b.getAttribute('aria-label')) && b.getAttribute('aria-pressed') !== 'true')?.dataset.day);
      await page.locator(`.kb-bar[data-day="${other}"]`).click();
      await page.waitForFunction((d) => location.hash.includes(d), other);
      await histSettled(page);
      rows = await rowsOf(page);
      check('click: another day shows its own questions', rows.length >= 3 && rows.every((r) => localDay(r.time) === other), `${other}: ${rows.length}`);
      await page.getByRole('button', { name: 'Show all days' }).click();
      await histSettled(page);
      check('"Show all days" returns to the whole range', (await matched(page)) === h30.total && await page.evaluate(() => location.hash === '#stats'));

      // ---- the history: newest first, grouped by day, paged
      rows = await rowsOf(page);
      const heads = await page.locator('.kb-hist-dayh').allTextContents();
      check('the history lists the newest 50, newest first, under day headers with counts', rows.length === 50 && rows.every((r, i) => !i || r.time <= rows[i - 1].time) && heads.length >= 5 && heads.every((x) => /\d+ questions?$/.test(x)), heads.slice(0, 3).join(' | '));
      await page.getByRole('button', { name: /^Show \d+ more$/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('.kb-hist-row').length > 50);
      rows = await rowsOf(page);
      check('paging: "Show more" appends the next page, in order, no row twice', rows.length === Math.min(100, h30.total) && rows.every((r, i) => !i || r.time <= rows[i - 1].time) && new Set(rows.map((r) => r.time + r.q)).size === rows.length, `${rows.length} of ${h30.total}`);
      // an answered question shows its answer (masked) and source; an older one says the answer was not saved
      const withAnswer = page.locator('.kb-hist-row[data-outcome="answered"] .kb-hist-qbtn').first();
      await withAnswer.click();
      const det = await page.locator('.kb-hist-detail:not([hidden])').first().textContent();
      check('an answered question opens its answer and sources', (await withAnswer.getAttribute('aria-expanded')) === 'true' && /Your bot answered/.test(det) && /Source/.test(det) && !/@lumen\.example|416 555 0142/.test(det), det.slice(0, 160));
      await page.locator('#kb-hist-q').fill('opening hours');
      await page.waitForFunction(() => /q=opening/.test(location.hash));
      await histSettled(page);
      rows = await rowsOf(page);
      check('search: only matching questions; the box keeps focus', rows.length >= 3 && rows.every((r) => /opening hours/i.test(r.q)) && await page.evaluate(() => document.activeElement?.id === 'kb-hist-q'), `${rows.length} rows`);
      await page.locator('.kb-hist-row .kb-hist-qbtn').last().click();
      check('an older answered question says its answer was not saved (never a made-up one)', /answer text was not saved/.test(await page.locator('.kb-hist-detail:not([hidden])').last().textContent()));
      await page.locator('#kb-hist-q').fill('');
      await page.waitForFunction(() => !/q=/.test(location.hash));
      // channel
      await page.locator('#kb-hist-ch').selectOption('sms');
      await histSettled(page);
      rows = await rowsOf(page);
      check('channel filter: only SMS, and the chart follows', rows.length >= 3 && rows.every((r) => r.ch === 'sms') && /SMS only/.test(await page.locator('#kb-chart-h').textContent()) && await page.evaluate(() => /ch=sms/.test(location.hash)), `${rows.length} rows`);
      await page.locator('#kb-hist-ch').selectOption('');
      // outcome: not in your files → "Add what's missing" opens the note form with the question filled in
      await page.locator('#kb-hist-out').selectOption('gap');
      await histSettled(page);
      rows = await rowsOf(page);
      check('outcome filter: only questions the files could not answer (off-topic ones are not gaps)', rows.length >= 5 && rows.every((r) => r.out === 'gap') && !rows.some((r) => /capital of France/.test(r.q)), `${rows.length} rows`);
      const add = page.locator('.kb-hist-add').first();
      const gapQ = await page.locator('.kb-hist-row .kb-hist-qtext').first().textContent();
      await add.click();
      await page.locator('dialog.sb-miss-dlg[open]').waitFor({ timeout: 5000 });
      check('"Add what\'s missing" opens the note form with the question filled in', (await page.locator('#sb-miss-q').inputValue()) === gapQ && /Teach your bot/.test(await page.locator('.sb-miss-h').textContent()), gapQ);
      await page.locator('dialog.sb-miss-dlg').getByRole('button', { name: 'Cancel' }).click();
      check('closing the form returns to the view and the button', await page.evaluate(() => !!document.getElementById('kb-stats') && document.activeElement?.classList.contains('kb-hist-add')));
      await page.locator('#kb-hist-out').selectOption('off_topic');
      await histSettled(page);
      rows = await rowsOf(page);
      check('outcome filter: off-topic', rows.length >= 1 && rows.every((r) => r.out === 'off_topic' && /capital of France/.test(r.q)) && !(await page.locator('.kb-hist-add').count()));
      await page.locator('#kb-hist-out').selectOption('flagged');
      await histSettled(page);
      check('outcome filter: flagged for review, with the reason', (await rowsOf(page)).length === 1 && /Flagged: Unsupported figure/.test(await page.locator('.kb-hist-row').first().textContent()));
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await histSettled(page);
      // Studio (your tests)
      const withStudio = await matched(page);
      await page.locator('#kb-hist-tests').uncheck();
      await page.waitForFunction(() => /tests=0/.test(location.hash));
      await histSettled(page);
      const noStudio = await matched(page);
      check('"Include Studio (your tests)" off leaves the owner\'s own Studio questions out everywhere', noStudio < withStudio && (await rowsOf(page)).every((r) => r.ch !== 'studio') && Number((await page.locator('.kb-leads-tile-n').first().textContent())) === withStudio
        && !(await page.locator('.kb-leads-bar-btn', { hasText: 'Studio' }).count()), `${withStudio} → ${noStudio}`);
      await page.locator('#kb-hist-tests').check();
      await histSettled(page);

      // ---- the kept sections
      const bars = await page.locator('.kb-leads-bars li').allTextContents();
      check('interactions by channel', bars.some((b) => /SMS/.test(b)) && bars.some((b) => /WhatsApp/.test(b)) && bars.some((b) => /Email/.test(b)), bars.join(' | '));
      await page.locator('.kb-leads-bar-btn', { hasText: 'WhatsApp' }).click();
      await histSettled(page);
      check('a channel row opens that channel in the history', (await rowsOf(page)).every((r) => r.ch === 'whatsapp') && await page.evaluate(() => document.activeElement?.id === 'kb-hist-h'));
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await histSettled(page);
      check('What people ask: most asked and gaps', (await page.locator('.kb-leads-asks .st-ins-row').count()) >= 2);
      await page.getByRole('button', { name: 'See all answered questions' }).click();
      await histSettled(page);
      rows = await rowsOf(page);
      check('"See all answered questions" opens the history, all time, answered only', rows.length > 0 && rows.every((r) => r.out === 'answered') && await page.evaluate(() => /range=all/.test(location.hash) && /out=answered/.test(location.hash))
        && (await page.getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed')) === 'true');
      check('"All" says what it covers and what is only kept 90 days', /every question since/.test(await page.locator('.kb-stats-note').first().textContent()) && /kept for 90 days/.test(await page.locator('.kb-stats-note').first().textContent()));
      await page.getByRole('button', { name: 'Last 30 days' }).click();
      await histSettled(page);
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await histSettled(page);
      const lrows = () => page.locator('#kb-leads-sec tbody tr').allTextContents();
      let lr = await lrows();
      check('the leads table', lr.length === 5 && lr.some((r) => r.includes('jordan.lee@example.com') && /Clicked/.test(r)) && lr.some((r) => r.includes('(416) 555-0142')), lr.join(' | ').slice(0, 300));
      await page.locator('#kb-leads-sec th[data-key="value"] button').click();
      lr = await lrows();
      const contacts = await page.locator('#kb-leads-sec tbody .kb-leads-contact').allTextContents();
      check('the leads table sorts by a column (and says so)', (await page.locator('#kb-leads-sec th[data-key="value"]').getAttribute('aria-sort')) === 'ascending' && contacts[0].startsWith('+1') && contacts.at(-1) === 'sam.rivera@example.org'
        && await page.evaluate(() => document.activeElement?.closest('th')?.dataset.key === 'value'), contacts.join(', '));
      await page.locator('#kb-leads-sec .kb-leads-qlink', { hasText: 'Do you ship to Canada?' }).click();
      await histSettled(page);
      rows = await rowsOf(page);
      check('a lead\'s question opens it in the history (its day, its words)', rows.length >= 1 && rows.every((r) => r.q === 'Do you ship to Canada?') && rows.some((r) => r.ch === 'sms') && await page.evaluate(() => /day=\d{4}-\d\d-\d\d/.test(location.hash) && /q=Do\+you\+ship/.test(location.hash)));
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await histSettled(page);
      const co = await page.locator('#kb-leads-co ~ .kb-leads-scroll tbody tr').allTextContents();
      check('checkout links sent, with the click', co.length === 1 && /E-City 500/.test(co[0]) && /Clicked/.test(co[0]), co.join(' | '));
      const text = await view.textContent();
      check('no provider names in the copy', !/twilio|stripe|shopify|resend|postmark|sendgrid|mailgun|gemini|knowdrive/i.test(text));
      check('it says which time zone the days use and how long things are kept', /your time zone \(UTC−[45]\)/.test(text) && /kept for as long as your bot exists/.test(text) && /kept for 90 days/.test(text));

      // ---- ranges, the tracking switch, the CSVs
      await page.getByRole('button', { name: 'Last 7 days' }).click();
      await page.waitForFunction(() => /last 7 days/.test(document.querySelector('.kb-stats-status')?.textContent || '') && document.querySelectorAll('.kb-bar').length === 7);
      check('7 days: the range switches (and is in the address)', (await page.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')) === 'true' && await page.evaluate(() => location.hash === '#stats?range=7')
        && (await page.locator('.kb-bar-x.is-tick').count()) === 7);
      await page.getByRole('button', { name: 'Last 90 days' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.kb-bar').length === 90);
      check('90 days: a bar per day, still inside the page', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.getByRole('button', { name: 'Last 30 days' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.kb-bar').length === 30);
      const sw = page.getByRole('switch', { name: 'Track links' });
      check('tracking is on by default', (await sw.getAttribute('aria-checked')) === 'true');
      await sw.click();
      await page.waitForFunction(() => /tracking is off/i.test(document.querySelector('.kb-stats-status')?.textContent || ''));
      const off = await (await api(T('/leads'), { headers: H })).json();
      check('the switch turns tracking off on the server', off.tracking === false);
      await sw.click();
      await page.waitForFunction(() => /tracking is on/i.test(document.querySelector('.kb-stats-status')?.textContent || ''));
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('button', { name: 'Download leads CSV' }).click()]);
      const file = path.join(SHOTS, 'sample-leads.csv');
      await download.saveAs(file);
      const csv = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
      const lines = csv.trimEnd().split('\r\n');
      check('the leads CSV downloads with the CRM columns', lines[0] === CSV_HEAD, lines[0]);
      check('the leads CSV has every lead and the checkout link', lines.length === 7 && lines.some((l) => /,checkout,,\+16475550123,/.test(l)) && lines.some((l) => l.includes('jordan.lee@example.com') && /,knowbot,webchat,tr_/.test(l)), `${lines.length} lines`);
      check('the file is named for the bot', /^knowbot-leads-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
      const [qdl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('button', { name: 'Download questions CSV' }).click()]);
      const qfile = path.join(SHOTS, 'sample-questions.csv');
      await qdl.saveAs(qfile);
      const ql = (await fsp.readFile(qfile, 'utf8')).replace(/^﻿/, '').trimEnd().split('\r\n');
      check('the questions CSV: date, time, channel, question, outcome; one row per question', ql[0] === 'date,time,channel,question,outcome' && ql.length === h30.total + 1 && ql.some((l) => /^\d{4}-\d\d-\d\d,12:\d\d,\w+,What is the capital of France\?,off-topic$/.test(l))
        && /^knowbot-questions-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv$/.test(qdl.suggestedFilename()), `${ql.length - 1} rows · ${ql[1]}`);
      {
        const res = await axe(page);
        check('axe: no WCAG A/AA violations in the view', !res.length, res.join(', '));
      }
      // ---- leaving: Esc, the back arrow, the browser's Back; a deep link opens it
      await page.locator('#kb-stats-title').focus();
      await page.keyboard.press('Escape');
      await view.waitFor({ state: 'detached', timeout: 5000 });
      await page.waitForFunction(() => !/^#stats/.test(location.hash));
      check('Escape closes it: the bot is back, focus returns to the Stats & Leads button', await page.evaluate(() => document.activeElement?.id === 'st-leads' && !document.getElementById('st-app').inert && !/Stats/.test(document.title)));
      await btn.click();
      await view.waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Back to your bot' }).click();
      await view.waitFor({ state: 'detached', timeout: 5000 });
      check('the back arrow closes it', await page.evaluate(() => !/^#stats/.test(location.hash)));
      await btn.click();
      await view.waitFor({ timeout: 10000 });
      await page.goBack();
      await view.waitFor({ state: 'detached', timeout: 5000 });
      check('the browser\'s Back returns to the bot', await page.evaluate(() => !/^#stats/.test(location.hash) && !document.getElementById('st-app').inert));
      await page.goForward();
      await view.waitFor({ timeout: 10000 });
      check('Forward opens it again', await page.evaluate(() => location.hash === '#stats'));
      await page.goto(`${dev.studioUrl}#stats?range=7&out=answered`, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await view.waitFor({ timeout: 20000 });
      await histSettled(page);
      rows = await rowsOf(page);
      check('a deep link opens the view with its range and filters', (await page.locator('.kb-bar').count()) === 7 && rows.length > 0 && rows.every((r) => r.out === 'answered') && (await page.locator('#kb-hist-out').inputValue()) === 'answered');
      await page.keyboard.press('Escape');
      await view.waitFor({ state: 'detached', timeout: 5000 });
      check('Escape from a deep link leaves the Studio on the bot', await page.evaluate(() => location.hash === '' && !document.getElementById('st-app').inert));

      // ---- phones: the header keeps its room; the ⋯ menu has Stats & Leads; one column
      console.log('3. phone width');
      await page.setViewportSize({ width: 390, height: 844 });
      check('mobile: Stats & Leads leaves the header', !(await page.locator('#st-leads').isVisible()));
      await page.locator('#st-more').click();
      await page.getByRole('menuitem', { name: 'Stats & Leads' }).click();
      await view.waitFor({ timeout: 10000 });
      await page.locator('.kb-leads-tile').first().waitFor({ timeout: 10000 });
      await histSettled(page);
      const m = await page.evaluate(() => {
        const v = document.getElementById('kb-stats');
        const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5; };
        const tiles = [...document.querySelectorAll('.kb-leads-tile')];
        return { page: document.documentElement.scrollWidth <= innerWidth + 1 && v.scrollWidth <= v.clientWidth + 1, tiles: tiles.length === 4 && tiles.every((x) => inside(x) && x.scrollWidth <= x.clientWidth + 1 && [...x.children].every((c) => c.scrollWidth <= c.clientWidth + 1)),
          secs: [...document.querySelectorAll('.kb-leads-sec, .kb-hist-row, .kb-stats-tools > *')].every(inside), cols: new Set([...document.querySelectorAll('.kb-stats-body > *, .kb-stats-cols > *, .kb-stats-q > *')].map((x) => Math.round(x.getBoundingClientRect().left))).size === 1,
          bar: Math.min(...[...document.querySelectorAll('.kb-bar')].map((b) => b.getBoundingClientRect().width)), chartScrolls: (() => { const s = document.querySelector('.kb-chart-scroll'); return s.scrollWidth > s.clientWidth && s.scrollLeft > 0; })(), hash: location.hash };
      });
      check('mobile: opens from the ⋯ menu as the same full view', m.hash === '#stats');
      check('mobile: no horizontal page scroll', m.page);
      check('mobile: four tiles, none clipped', m.tiles);
      check('mobile: a single column, every section inside the screen', m.secs && m.cols);
      check('mobile: bars stay big enough to tap; the chart scrolls inside its own box, starting at today', m.bar >= 24 && m.chartScrolls, `${m.bar}px`);
      await page.locator('.kb-bar', { hasText: '12' }).first().click();
      await histSettled(page);
      check('mobile: tapping a day shows that day\'s questions', (await rowsOf(page)).length === 12);
      await page.screenshot({ path: path.join(SHOTS, 'stats-phone-light.png') });
      await page.screenshot({ path: path.join(SHOTS, 'stats-phone-light-full.png'), fullPage: false });
      await page.evaluate(() => document.querySelector('#kb-hist').scrollIntoView());
      await page.screenshot({ path: path.join(SHOTS, 'stats-phone-history.png') });
      {
        const res = await axe(page);
        check('mobile axe: no WCAG A/AA violations', !res.length, res.join(', '));
      }
      await page.getByRole('button', { name: 'Back to your bot' }).click();
      await view.waitFor({ state: 'detached', timeout: 5000 });
    } else {
      const res = await axe(page);
      check('dark axe: no WCAG A/AA violations in the view', !res.length, res.join(', '));
      await page.evaluate(() => document.querySelector('#kb-hist').scrollIntoView());
      await page.screenshot({ path: path.join(SHOTS, 'stats-desktop-dark-history.png') });
    }
    check(`${theme}: no console errors or failed requests`, !errors.length, errors.join(' | '));
    await context.close();
  }
} catch (e) {
  check('leads smoke ran to the end', false, e.stack || e.message);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed · screenshots and sample CSVs in ${SHOTS}`);
process.exit(failures ? 1 : 0);

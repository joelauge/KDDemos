#!/usr/bin/env node
// "Your bots" in the header menu, end to end in a real browser (Playwright) against studio/test/dev-server.mjs:
//
//   1. a browser with one bot that is not launched: the menu lists it with "Not launched", marked as the open one
//   2. "New bot" starts a second bot at once (no dialog) and keeps the first, each with its own conversation
//   3. by keyboard: the menu opens, arrows reach the other bot, Enter opens it at the root; its name and its own
//      conversation show, nothing of the other bot
//   4. a launched bot shows "Live" and sorts first
//   5. a stored token that stopped working falls back to the stored restore key
//   6. a bot deleted on the server says so when opened and leaves the list
//   7. "Start over" deletes the open bot and removes its entry
//   8. phone width (a long name truncates, with a title), axe clean in light and dark, no page errors
//
//   npm run bots:smoke                   # SHOTS=<dir> keeps the screenshots somewhere else (default: a temp dir)
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';
import { outDir, injectAxe, settled } from './smoke-util.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = outDir('bots', process.env.SHOTS);

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${String(detail).slice(0, 300)}` : ''}`); if (!ok) failures++; return ok; };

const dev = await startDevServer({ speed: 20 });
const api = (p, init = {}) => fetch(dev.url + p, init);
const LONG = 'Northern Lights Bicycle Repair Helpdesk';   // 39 characters: a bot name holds at most 40

let browser;
try {
  browser = await chromium.launch({ headless: !process.env.HEADED });
  await fsp.mkdir(SHOTS, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await context.addInitScript(() => { try { localStorage.setItem('kb-landing', 'skip'); if (!localStorage.getItem('knowbot-theme')) localStorage.setItem('knowbot-theme', 'light'); } catch { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.(googleapis|gstatic)|ERR_/.test(m.text())) errors.push(`console: ${m.text()}`); });

  const st = () => page.evaluate(() => { const s = window.__studio.store.getState(); return { id: s.trial.id, status: s.trial.status, converted: !!s.trial.converted, name: s.spec.name }; });
  const ready = async (pred = 'true') => page.waitForFunction(`(() => { const s = window.__studio && window.__studio.store.getState(); return !!s && s.trial.status === 'ready' && (${pred}); })()`, null, { timeout: 30000 });
  // the test reads the stored secrets to act as the owner would from another tab; the page itself never shows them
  const stored = () => page.evaluate(() => (JSON.parse(localStorage.getItem('kb-studio-bots:v1') || '{"bots":[]}').bots || []));
  const authOf = async (id) => { const e = (await stored()).find((b) => b.id === id); return { authorization: `Bearer ${e.token}` }; };
  const rename = async (id, name) => { const r = await api(`/api/studio/trials/${id}`, { method: 'PATCH', headers: { ...(await authOf(id)), 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); return r.status; };
  const openMenu = async () => { if (!(await page.locator('.st-menu').count())) await page.locator('#st-more').click(); await page.locator('.st-menu .st-bots').waitFor({ timeout: 5000 }); await settled(page, 1500); };
  const closeMenu = async () => { if (await page.locator('.st-menu').count()) await page.keyboard.press('Escape'); await page.locator('.st-menu').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}); };
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.st-menu .st-bot-row')].map((r) => ({
    id: r.dataset.bot, name: r.querySelector('.st-bot-name').textContent, tag: r.querySelector('.st-bot-tag').textContent, current: r.getAttribute('aria-current') === 'true',
    title: r.getAttribute('title'), role: r.getAttribute('role'), clipped: r.querySelector('.st-bot-name').scrollWidth > r.querySelector('.st-bot-name').clientWidth })));
  const say = async (text) => {
    await page.locator('#st-setup-composer').fill(text);
    await page.locator('#st-setup-composer').press('Enter');
    await page.waitForFunction((t) => (document.querySelector('#st-setup')?.innerText || '').includes(t), text, { timeout: 15000 });
    // the conversation is saved a moment after each turn; the reply has to be in before the test moves on
    await page.waitForFunction(() => !document.querySelector('#st-setup .is-streaming, #st-setup [aria-busy="true"]'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
  };
  const logText = () => page.evaluate(() => document.querySelector('#st-setup')?.innerText || '');
  const axe = async (label) => {
    await settled(page, 3000);
    const v = await injectAxe(page).then(() => page.evaluate(async () => (await window.axe.run(document.querySelector('.st-menu'), { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(' / ')}`)))
      .catch((e) => [`axe did not run: ${e.message}`]);
    check(`axe: no WCAG A/AA violations in the menu (${label})`, !v.length, v.join(', '));
  };
  const noSecrets = async (label) => {
    const leak = await page.evaluate(() => {
      const list = (JSON.parse(localStorage.getItem('kb-studio-bots:v1') || '{"bots":[]}').bots || []);
      const html = document.documentElement.outerHTML;
      return list.some((b) => html.includes(b.token) || (b.restoreKey && html.includes(b.restoreKey))) || list.some((b) => location.href.includes(b.token));
    });
    check(`no token or restore key in the page or its address (${label})`, !leak);
  };

  console.log('1. One bot, not launched');
  await page.goto(`${dev.url}/`, { waitUntil: 'domcontentloaded' });
  await ready();
  const b1 = (await st()).id;
  const headerBox0 = await page.locator('#st-more').boundingBox();
  await openMenu();
  let r = await rows();
  check('the menu has a "Your bots" section first', await page.evaluate(() => { const m = document.querySelector('.st-menu [role="menu"]'); return m.firstElementChild.querySelector('.st-menu-label')?.textContent === 'Your bots' && m.firstElementChild.querySelector('[role="group"]')?.getAttribute('aria-labelledby') === 'st-bots-label'; }));
  check('it lists the one bot', r.length === 1 && r[0].id === b1, JSON.stringify(r));
  check('with the "Not launched" tag', r[0]?.tag === 'Not launched', r[0]?.tag);
  check('marked as the open bot (aria-current)', r[0]?.current === true);
  check('rows are menu items', r.every((x) => x.role === 'menuitem'));
  check('"New bot" is the last row of the section', await page.evaluate(() => { const g = document.querySelector('.st-menu .st-bots'); const items = [...g.querySelectorAll('[role="menuitem"]')]; return items[items.length - 1].textContent.trim() === 'New bot'; }));
  check('the header did not move when the menu opened', JSON.stringify(await page.locator('#st-more').boundingBox()) === JSON.stringify(headerBox0));
  await axe('light, one bot');
  await noSecrets('one bot');
  await page.screenshot({ path: path.join(SHOTS, 'one-unlaunched-bot.png') });
  // choosing the open bot only closes the menu
  await page.locator('.st-menu .st-bot-row[aria-current="true"]').click();
  await page.locator('.st-menu').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  check('choosing the open bot closes the menu and stays on it', !(await page.locator('.st-menu').count()) && (await st()).id === b1);
  // an empty new bot is not duplicated
  await openMenu();
  await page.locator('.st-menu .st-bot-new').click();
  await page.waitForTimeout(600);
  check('"New bot" on a bot that is still empty keeps that bot', (await st()).id === b1 && (await stored()).length === 1);

  console.log('2. New bot keeps the first');
  await say('alpha bot answers bike repair questions');
  check('the first bot can be renamed', (await rename(b1, 'Lumen Bikes')) === 200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(`s.trial.id === '${b1}' && s.spec.name === 'Lumen Bikes'`);
  check('its conversation is back after a reload', (await logText()).includes('alpha bot answers bike repair questions'));
  await openMenu();
  await page.locator('.st-menu .st-bot-new').click();
  await ready(`s.trial.id !== '${b1}'`);
  const b2 = (await st()).id;
  check('a second bot opened, with no dialog', b2 !== b1 && !(await page.locator('.st-confirm, [role="alertdialog"]').count()));
  check('the new bot starts with an empty conversation', !(await logText()).includes('alpha bot'));
  await openMenu();
  r = await rows();
  check('both bots are listed', r.length === 2 && r.some((x) => x.id === b1) && r.some((x) => x.id === b2), JSON.stringify(r));
  check('the first bot kept its name', r.find((x) => x.id === b1)?.name === 'Lumen Bikes');
  check('the new bot is the open one', r.find((x) => x.id === b2)?.current === true && r.find((x) => x.id === b1)?.current === false);
  check('the first bot still exists on the server', (await api(`/api/studio/trials/${b1}`, { headers: await authOf(b1) })).status === 200);
  await closeMenu();
  await say('beta bot answers shoe care questions');
  check('the second bot can be renamed', (await rename(b2, 'Shoe Care Desk')) === 200);

  console.log('3. Switching, by keyboard');
  await page.locator('#st-more').focus();
  await page.keyboard.press('Enter');
  await page.locator('.st-menu .st-bots').waitFor({ timeout: 5000 });
  check('focus lands on the first bot row', await page.evaluate(() => document.activeElement?.classList.contains('st-bot-row')));
  for (let i = 0; i < 6 && !(await page.evaluate((id) => document.activeElement?.dataset.bot === id, b1)); i++) await page.keyboard.press('ArrowDown');
  check('arrow keys reach the other bot', await page.evaluate((id) => document.activeElement?.dataset.bot === id, b1));
  await page.keyboard.press('Escape');
  check('Escape closes the menu and returns focus to its button', !(await page.locator('.st-menu').count()) && await page.evaluate(() => document.activeElement?.id === 'st-more'));
  await page.keyboard.press('Enter');
  await page.locator('.st-menu .st-bots').waitFor({ timeout: 5000 });
  for (let i = 0; i < 6 && !(await page.evaluate((id) => document.activeElement?.dataset.bot === id, b1)); i++) await page.keyboard.press('ArrowDown');
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.keyboard.press('Enter')]);
  await ready(`s.trial.id === '${b1}'`);
  check('Enter opened the first bot', (await st()).id === b1);
  check('at the root, with no query', new URL(page.url()).pathname === '/' && !new URL(page.url()).search && !new URL(page.url()).hash, page.url());
  check('no dialog on the way', !(await page.locator('.st-confirm, [role="alertdialog"]').count()));
  check("the header shows the first bot's name", (await page.locator('#st-botchip .st-botchip-name').innerText()) === 'Lumen Bikes');
  let log = await logText();
  check('its own conversation shows', log.includes('alpha bot answers bike repair questions'));
  check("none of the other bot's conversation", !log.includes('beta bot answers shoe care questions'));
  await openMenu();
  r = await rows();
  check('the list marks the first bot as open now', r.find((x) => x.id === b1)?.current === true && r.filter((x) => x.current).length === 1);
  check('the second bot shows its new name once it was renamed', r.find((x) => x.id === b2)?.name !== undefined);
  // and back to the second: its conversation, not the first's
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.locator(`.st-menu .st-bot-row[data-bot="${b2}"]`).click()]);
  await ready(`s.trial.id === '${b2}' && s.spec.name === 'Shoe Care Desk'`);
  log = await logText();
  check("the second bot shows its own conversation and not the first's", log.includes('beta bot answers shoe care questions') && !log.includes('alpha bot answers bike repair questions'));

  console.log('4. A launched bot is "Live" and sorts first');
  {
    const cv = await api(`/api/studio/trials/${b2}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin' }, body: JSON.stringify({ account: 'acct-smoke', bucketId: 'shoecare' }) });
    check('the second bot was launched (admin convert)', cv.status === 200, `HTTP ${cv.status}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(`s.trial.id === '${b2}' && s.trial.converted === true`);
  await openMenu();
  r = await rows();
  check('the launched bot shows "Live"', r.find((x) => x.id === b2)?.tag === 'Live', JSON.stringify(r));
  check('"Start over" is not offered for a live bot, "New bot" is', !(await page.locator('.st-menu').innerText()).includes('Start over') && await page.locator('.st-menu .st-bot-new').count() === 1);
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.locator(`.st-menu .st-bot-row[data-bot="${b1}"]`).click()]);
  await ready(`s.trial.id === '${b1}'`);
  await openMenu();
  r = await rows();
  check('live sorts first, also when another bot is open', r[0]?.id === b2 && r[0]?.tag === 'Live' && r[1]?.id === b1 && r[1]?.tag === 'Not launched' && r[1]?.current === true, JSON.stringify(r));
  check('the live tag is green and the other is not', await page.evaluate(() => { const t = [...document.querySelectorAll('.st-menu .st-bot-tag')]; return t[0].classList.contains('green') && !t[1].classList.contains('green'); }));
  await closeMenu();
  // the command palette lists the other bot and "New bot"
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.waitForTimeout(500);
  {
    const text = await page.evaluate(() => document.querySelector('#st-overlay, .st-overlay, body').innerText);
    check('the command palette offers the other bot and "New bot"', /Open Shoe Care Desk \(Live\)/.test(text) && /New bot/.test(text));
  }
  await page.keyboard.press('Escape');

  console.log('5. A token that stopped working falls back to the restore key');
  await page.evaluate((id) => { const k = 'kb-studio-bots:v1'; const v = JSON.parse(localStorage.getItem(k)); const e = v.bots.find((b) => b.id === id); e.token = `${e.token.slice(0, -6)}zzzzzz`; localStorage.setItem(k, JSON.stringify(v)); }, b2);
  const expected401 = [];
  page.on('response', (res) => { if (res.status() === 401 || res.status() === 404 || res.status() === 410) expected401.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  await openMenu();
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.locator(`.st-menu .st-bot-row[data-bot="${b2}"]`).click()]);
  await ready(`s.trial.id === '${b2}' && s.trial.converted === true`);
  check('the bot opened although its stored token was refused', (await st()).id === b2 && expected401.some((x) => x.startsWith('401')), expected401.join(', '));
  check('it is still in the list, with a working token again', await (async () => { const e = (await stored()).find((b) => b.id === b2); return !!e && !/zzzzzz$/.test(e.token) && (await api(`/api/studio/trials/${b2}`, { headers: { authorization: `Bearer ${e.token}` } })).status === 200; })());

  console.log('6. A bot deleted on the server leaves the list after a failed open');
  await openMenu();
  await page.locator('.st-menu .st-bot-new').click();   // the open bot is live, so a third starts at once
  await ready(`s.trial.id !== '${b2}' && s.trial.id !== '${b1}'`);
  const b3 = (await st()).id;
  await say('gamma bot answers garden questions');
  check('the third bot can be renamed', (await rename(b3, 'Garden Helper')) === 200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(`s.trial.id === '${b3}' && s.spec.name === 'Garden Helper'`);
  await openMenu();
  r = await rows();
  check('three bots are listed: live first, then the two not launched, most recent first', r.length === 3 && r[0].id === b2 && r[1].id === b3 && r[2].id === b1, JSON.stringify(r.map((x) => x.name)));
  await page.screenshot({ path: path.join(SHOTS, 'several-bots-one-live.png') });
  await axe('light, three bots');
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.locator(`.st-menu .st-bot-row[data-bot="${b1}"]`).click()]);
  await ready(`s.trial.id === '${b1}'`);
  check('the third bot was deleted on the server', [200, 204].includes((await api(`/api/studio/trials/${b3}`, { method: 'DELETE', headers: await authOf(b3) })).status));
  await openMenu();
  check('it is still listed until it is opened', (await rows()).some((x) => x.id === b3));
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.locator(`.st-menu .st-bot-row[data-bot="${b3}"]`).click()]);
  await page.waitForFunction(() => window.__studio?.store.getState().trial.status === 'expired', null, { timeout: 30000 });
  await page.locator('#st-setup').getByText('Start a new bot').first().waitFor({ timeout: 10000 });
  check('opening it says the bot is gone', true);
  await openMenu();
  r = await rows();
  check('it left the list', r.length === 2 && !r.some((x) => x.id === b3), JSON.stringify(r.map((x) => x.name)));
  check('no bot is marked as open', r.every((x) => !x.current));
  check("the deleted bot's conversation is not kept", await page.evaluate((id) => localStorage.getItem(`kb-studio-log:${id}`) === null, b3));
  await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.locator(`.st-menu .st-bot-row[data-bot="${b1}"]`).click()]);
  await ready(`s.trial.id === '${b1}' && s.spec.name === 'Lumen Bikes'`);
  check('another bot opens from there', (await logText()).includes('alpha bot answers bike repair questions'));

  console.log('7. Start over removes the entry');
  await openMenu();
  await page.locator('.st-menu [role="menuitem"]', { hasText: 'Start over' }).click();
  await page.locator('.st-confirm').waitFor({ timeout: 5000 });
  check('Start over still asks first', /permanently deletes Lumen Bikes/.test(await page.locator('.st-confirm').innerText()));
  await page.locator('.st-confirm .st-btn-danger').click();
  await ready(`s.trial.id !== '${b1}'`);
  const b4 = (await st()).id;
  // Start over shows the first view again (as before); saying what the bot is for opens the Studio
  await page.locator('#kl-input').waitFor({ timeout: 10000 });
  await page.locator('#kl-input').fill('delta bot answers rental questions');
  await page.locator('#kl-input').press('Enter');
  await page.locator('#st-more').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('#st-setup')?.innerText || '').includes('delta bot answers rental questions'), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await openMenu();
  r = await rows();
  check('the deleted bot left the list; the fresh bot and the live bot remain', r.length === 2 && r[0].id === b2 && r[1].id === b4 && r[1].current && r[1].tag === 'Not launched' && !r.some((x) => x.id === b1), JSON.stringify(r));
  check('the server no longer has it', [401, 404, 410].includes((await api(`/api/studio/trials/${b1}`, { headers: { authorization: 'Bearer nope' } })).status));
  await closeMenu();

  console.log('8. Phone width, dark, long names');
  check('the open bot gets a long name', (await rename(b4, LONG)) === 200);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(`s.trial.id === '${b4}' && s.spec.name.length > 30`);
  const moreBox = await page.locator('#st-more').boundingBox();
  await openMenu();
  r = await rows();
  const long = r.find((x) => x.id === b4);
  check('a long name is cut with an ellipsis and carries the full name as its title', !!long && long.clipped && long.title === LONG, JSON.stringify(long));
  check('the tag stays whole beside a long name', await page.evaluate(() => [...document.querySelectorAll('.st-menu .st-bot-tag')].every((t) => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= document.querySelector('.st-menu').getBoundingClientRect().right)));
  check('the menu fits the phone screen', await page.evaluate(() => { const b = document.querySelector('.st-menu').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; }));
  check('no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('rows are at least 44 px tall on a phone', await page.evaluate(() => [...document.querySelectorAll('.st-menu .st-bots [role="menuitem"]')].every((x) => x.getBoundingClientRect().height >= 44)));
  check('the header did not move', JSON.stringify(await page.locator('#st-more').boundingBox()) === JSON.stringify(moreBox));
  await axe('light, phone');
  await page.screenshot({ path: path.join(SHOTS, 'phone-light.png') });
  await closeMenu();
  await page.evaluate(() => localStorage.setItem('knowbot-theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(`s.trial.id === '${b4}'`);
  await openMenu();
  check('dark theme is on', await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark'));
  await axe('dark, phone');
  await page.screenshot({ path: path.join(SHOTS, 'phone-dark.png') });
  await closeMenu();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(`s.trial.id === '${b4}'`);
  await openMenu();
  await axe('dark, desktop');
  await noSecrets('several bots');
  await page.screenshot({ path: path.join(SHOTS, 'several-bots-dark.png') });
  {
    const text = await page.locator('.st-menu').innerText();
    check('plain wording: no em dash, no vendor names', !/—/.test(text) && !/google|oauth|stripe|twilio|anthropic|claude|cloudflare/i.test(text), text.replace(/\s+/g, ' ').slice(0, 120));
  }
  await closeMenu();

  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  await context.close();
} catch (err) {
  failures++;
  console.error('\nSMOKE ABORTED:', err);
} finally {
  if (browser) await browser.close();
  await dev.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
console.log(`screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);

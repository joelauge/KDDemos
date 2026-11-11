// Product cards in the Studio chat: imports the dev server's fake store, asks product questions and saves screenshots
// (desktop light, desktop dark, phone). Usage: node studio/test/cards-shots.mjs [outDir]   (default studio/test/screens/cards)
// Fakes only (dev-server.mjs): nothing reaches a real store, knowDrive or model.
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'screens', 'cards'));
const QUESTIONS = ['How much is the Commuter Lite?', 'How much are the Trail Pro, the Kids 20 and the Gravel X?', 'Compare the Kids 20 and the Gravel X prices', 'Is the Gravel X in stock?', 'What bikes do you sell and how much are they?'];

const sse = async (res) => (await res.text()).split('\n\n').map((fr) => { const e = /^event: (.*)$/m.exec(fr)?.[1]; const d = /^data: (.*)$/m.exec(fr)?.[1]; try { return e ? { event: e, data: JSON.parse(d) } : null; } catch { return null; } }).filter(Boolean);

await fsp.mkdir(OUT, { recursive: true });
const dev = await startDevServer({ speed: 4 });
const browser = await chromium.launch();
try {
  const t = await (await fetch(`${dev.url}/api/studio/trials`, { method: 'POST' })).json();
  const auth = { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
  const done = (await sse(await fetch(`${dev.url}/api/studio/trials/${t.trialId}/store`, { method: 'POST', headers: auth, body: JSON.stringify({ url: dev.shopUrl, owner: true }) }))).at(-1);
  console.log(`imported ${done?.data?.fileCount} files`);
  for (let i = 0; i < 120; i++) {
    const f = await (await fetch(`${dev.url}/api/studio/trials/${t.trialId}/files`, { headers: auth })).json();
    if (f.files?.length && f.files.every((x) => x.stage === 'ready')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  let best = { n: 0, q: QUESTIONS[1] };
  for (const q of QUESTIONS) {
    const fin = (await sse(await fetch(`${dev.url}/api/studio/trials/${t.trialId}/ask`, { method: 'POST', headers: auth, body: JSON.stringify({ question: q }) }))).find((e) => e.event === 'final')?.data;
    console.log(`${q} → ${fin?.status} · ${(fin?.products || []).map((p) => `${p.title} ${p.price} ${p.availability}${p.image ? ' [photo]' : ''}`).join(' | ') || 'no cards'}`);
    if (q !== QUESTIONS[0] && (fin?.products?.length || 0) > best.n) best = { n: fin.products.length, q };
  }
  const SHOW = [QUESTIONS[0], best.n > 1 ? best.q : 'Is the Gravel X in stock?'];   // two cards when the (fake) model cites two products, else a sold-out one
  for (const v of [{ name: 'desktop-light', theme: 'light', viewport: { width: 1440, height: 900 } }, { name: 'desktop-dark', theme: 'dark', viewport: { width: 1440, height: 900 } },
    { name: 'phone-light', theme: 'light', viewport: { width: 390, height: 844 }, mobile: true }]) {
    const ctx = await browser.newContext({ viewport: v.viewport, colorScheme: v.theme, deviceScaleFactor: 2, ...(v.mobile ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([trial]) => { try { localStorage.setItem('kb-studio:v1', JSON.stringify({ trial, ui: { view: 'bot' } })); localStorage.setItem('knowbot-theme', trial.theme); } catch {} }, [{ id: t.trialId, token: t.token, expiresAt: t.expiresAt, theme: v.theme }]);
    const page = await ctx.newPage();
    await page.goto(dev.studioUrl, { waitUntil: 'load' });
    await page.waitForSelector('#sb-composer-slot textarea', { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(1500);
    if (v.mobile) await page.click('#st-tab-bot').catch(() => {});
    for (const q of SHOW) {
      const ta = page.locator('#sb-composer-slot textarea').first();
      await ta.fill(q); await ta.press('Enter');
      await page.waitForFunction((n) => document.querySelectorAll('.sb-answer[data-status="grounded"], .sb-answer[data-status="refused"]').length >= n, SHOW.indexOf(q) + 1, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => [...document.querySelectorAll('.sb-answer')].pop()?.scrollIntoView({ block: 'end' })).catch(() => {});
    await page.waitForTimeout(600);
    const file = path.join(OUT, `cards-${v.name}.png`);
    await page.screenshot({ path: file });
    console.log(`saved ${file}`);
    await ctx.close();
  }
} finally { await browser.close(); await dev.close(); }

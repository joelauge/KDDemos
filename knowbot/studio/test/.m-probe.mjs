// scratch probe (owner M, temporary): rect timeline of the mobile bot pane during the sample journey
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';
delete process.env.KNOWDRIVE_API_KEY;
const { chromium } = createRequire(import.meta.url)('playwright');
const mobile = process.argv.includes('--mobile');
const dev = await startDevServer({ speed: 4 });
const b = await chromium.launch();
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('kb-studio-motion', 'full'); } catch {} });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.goto(dev.studioUrl); await page.waitForSelector('#st-log .st-chip-primary'); await page.waitForTimeout(2500);
await page.evaluate(() => {
  window.__tl = []; const t0 = performance.now(); let last = '';
  const sel = ['#in-map-slot', '#in-map-slot > *', '#in-map-slot .map-legend', '#in-map-slot .map-hud', '#in-intake-slot', '#in-intake-slot > * > *', '#sb-thread-slot', '.in-replay'];
  const tick = () => {
    const out = [];
    for (const s of sel) for (const el of document.querySelectorAll(s)) { const r = el.getBoundingClientRect(); if (r.height) out.push(`${(el.id || el.className || el.nodeName).toString().slice(0, 30)}:${Math.round(r.y)}+${Math.round(r.height)}`); }
    const k = out.join(' | ');
    if (k !== last) { window.__tl.push(`${Math.round(performance.now() - t0)} ${k}`); last = k; }
    if (performance.now() - t0 < 9000) setTimeout(tick, 50);
  };
  tick();
});
await page.locator('#st-log .st-chip-primary').first().click();
if (mobile) { await page.click('#st-tab-bot').catch(() => {}); }
await page.waitForTimeout(9500);
console.log((await page.evaluate(() => window.__tl)).join('\n'));
await b.close(); await dev.close();

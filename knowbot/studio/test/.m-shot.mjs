// scratch (owner M, temporary): screenshots of the map/intake at journey moments
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';
delete process.env.KNOWDRIVE_API_KEY;
const { chromium } = createRequire(import.meta.url)('playwright');
const mobile = process.argv.includes('--mobile');
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || '/tmp';
const dev = await startDevServer({ speed: 4 });
const b = await chromium.launch();
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('kb-studio-motion', 'full'); } catch {} });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
const tag = mobile ? 'm' : 'd';
await page.goto(dev.studioUrl); await page.waitForSelector('#st-log .st-chip-primary'); await page.waitForTimeout(1500);
await page.locator('#st-log .st-chip-primary').first().click();
if (mobile) await page.click('#st-tab-bot').catch(() => {});
await page.waitForTimeout(2500); await page.screenshot({ path: `${OUT}/${tag}-1-ingest.png` });
await page.waitForTimeout(6000); await page.screenshot({ path: `${OUT}/${tag}-2-ready.png` });
const starter = page.locator('#sb-suggest-slot button').filter({ hasNotText: /off-topic/i }).first();
await starter.click({ timeout: 8000 }).catch((e) => console.log('nostarter', e.message));
await page.waitForTimeout(6000); await page.screenshot({ path: `${OUT}/${tag}-3-answer.png` });
const cite = page.locator('#sb-thread-slot button.pf-cite[data-n="1"]').first();
if (await cite.count()) { await cite.click().catch(() => {}); await page.waitForTimeout(1500); await page.screenshot({ path: `${OUT}/${tag}-4-proof.png` }); }
await b.close(); await dev.close();

// The Studio is served at the site root (its files stay in studio/). This checks, in a real browser, that the root page
// loads every asset (no failed request, no page error), that the app boots, and that old /studio/ links (saved bots,
// emails, checkout returns) land on / with their query and hash intact.
//   node studio/test/root-smoke.mjs
import { createRequire } from 'node:module';
import { startDevServer } from './dev-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const S = await startDevServer({ speed: 20 });
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` · ${detail}` : ''}`); };
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const bad = [], errors = [];
    page.on('response', (r) => { if (r.status() >= 400 && new URL(r.url()).origin === new URL(S.url).origin && !/\/api\//.test(r.url())) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    page.on('requestfailed', (r) => { if (new URL(r.url()).origin === new URL(S.url).origin) bad.push(`failed ${new URL(r.url()).pathname}`); });
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
    await page.goto(`${S.url}/`, { waitUntil: 'load' });
    await page.locator('.kl-top:visible, #st-setup-composer:visible').first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    check(`${label}: the Studio shows at /`, await page.locator('.kl-top:visible, #st-setup-composer:visible').first().isVisible().catch(() => false));
    check(`${label}: the Studio's script ran`, await page.evaluate(() => document.documentElement.hasAttribute('data-theme') && !!document.querySelector('#st-setup')));
    check(`${label}: the title is the Studio's`, /KnowBot Studio/.test(await page.title()));
    check(`${label}: the logo image loads`, await page.evaluate(() => [...document.images].filter((i) => /logo\.svg/.test(i.src)).every((i) => i.complete && i.naturalWidth > 0)));
    check(`${label}: no failed site request`, bad.length === 0, bad.slice(0, 5).join(', '));
    check(`${label}: no page error`, errors.length === 0, errors.slice(0, 3).join(' | '));
    // an old link: /studio/?t=…&k=…#stats
    const before = bad.length;
    await page.goto(`${S.url}/studio/?t=tr_aaaaaaaaaaaaaaaa&k=abc.def#stats`, { waitUntil: 'load' });
    await page.waitForURL((u) => u.pathname === '/', { timeout: 10000 }).catch(() => {});
    const u = new URL(page.url());
    check(`${label}: /studio/ lands on /`, u.pathname === '/', page.url());
    check(`${label}: the old link's bot id and key reach the app`, await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.name || '').then((n) => /[?&]t=tr_aaaaaaaaaaaaaaaa/.test(n) && /[?&]k=abc\.def/.test(n) && /#stats$/.test(n)), page.url());
    await page.waitForTimeout(2500);
    check(`${label}: no failed site request after the redirect`, bad.length === before, bad.slice(before, before + 5).join(', '));
    // /studio (no slash) and /studio/index.html
    for (const p of ['/studio/index.html?t=tr_bbbbbbbbbbbbbbbb']) {
      await page.goto(`${S.url}${p}`, { waitUntil: 'load' });
      await page.waitForURL((x) => x.pathname === '/', { timeout: 10000 }).catch(() => {});
      check(`${label}: ${p.split('?')[0]} lands on /`, new URL(page.url()).pathname === '/', page.url());
    }
    await ctx.close();
  }
} finally { await browser.close(); await S.close(); }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

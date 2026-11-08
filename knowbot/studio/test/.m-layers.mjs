// scratch (owner M, temporary): composited layer census during the sample journey
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
const cdp = await ctx.newCDPSession(page);
await cdp.send('DOM.enable'); await cdp.send('LayerTree.enable');
let layers = [];
cdp.on('LayerTree.layerTreeDidChange', (e) => { if (e.layers) layers = e.layers; });
await page.goto(dev.studioUrl); await page.waitForSelector('#st-log .st-chip-primary'); await page.waitForTimeout(2000);
async function census(tag) {
  const r = await page.evaluate(() => {
    const anims = document.getAnimations();
    const byEl = {};
    const nm = (n) => n ? `${n.nodeName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.classList && n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : ''}` : '?';
    for (const a of anims) { const t = a.effect && a.effect.target; const k = `${nm(t)}${a.effect?.pseudoElement || ''} ${a.playState}${a instanceof CSSAnimation ? ' css:' + a.animationName : a instanceof CSSTransition ? ' tr:' + a.transitionProperty : ''}`; byEl[k] = (byEl[k] || 0) + 1; }
    const wc = {};
    for (const el of document.querySelectorAll('body *')) { const w = getComputedStyle(el).willChange; if (w && w !== 'auto') { const k = nm(el) + ' ' + w; wc[k] = (wc[k] || 0) + 1; } }
    const bf = {};
    for (const el of document.querySelectorAll('body *')) { const cs = getComputedStyle(el); if (cs.backdropFilter && cs.backdropFilter !== 'none') bf[nm(el)] = cs.backdropFilter; if (cs.filter && cs.filter !== 'none') bf[nm(el) + ' filter'] = cs.filter; }
    return { n: anims.length, byEl, wc, bf, nodes: document.getElementsByTagName('*').length };
  });
  console.log(`--- ${tag}: ${r.n} animations, ${r.nodes} nodes`);
  console.log(Object.entries(r.byEl).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `  ${v}x ${k}`).join('\n'));
  console.log('  will-change: ' + Object.entries(r.wc).map(([k, v]) => `${v}x ${k}`).join(' | '));
  console.log('  filters: ' + JSON.stringify(r.bf));
}
await census('landing');
await page.locator('#st-log .st-chip-primary').first().click();
if (mobile) await page.click('#st-tab-bot').catch(() => {});
for (const t of [1200, 1500, 2000]) { await page.waitForTimeout(t); await census(`samples+${t}`); }
await page.waitForTimeout(5000); await census('ready');
await b.close(); await dev.close();

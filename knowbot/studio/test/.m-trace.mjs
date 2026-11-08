// scratch (owner M, temporary): CDP trace of the sample journey; attributes long style/layout to invalidations
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { startDevServer } from './dev-server.mjs';
delete process.env.KNOWDRIVE_API_KEY;
const { chromium } = createRequire(import.meta.url)('playwright');
const mobile = process.argv.includes('--mobile');
const until = process.argv.find((a) => a.startsWith('--until='))?.slice(8) || 'ingest';
const dev = await startDevServer({ speed: 4 });
const b = await chromium.launch();
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('kb-studio-motion', 'full'); } catch {} });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.goto(dev.studioUrl); await page.waitForSelector('#st-log .st-chip-primary'); await page.waitForTimeout(2500);
const events = [];
cdp.on('Tracing.dataCollected', (d) => events.push(...d.value));
const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking', 'blink.user_timing'] } });
await page.locator('#st-log .st-chip-primary').first().click();
if (mobile) await page.click('#st-tab-bot').catch(() => {});
await page.waitForTimeout(until === 'samples' ? 5000 : 12000);
if (until === 'answer') {
  const starter = page.locator('#sb-suggest-slot button').filter({ hasNotText: /off-topic/i }).first();
  await starter.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(7000);
}
await cdp.send('Tracing.end'); await done;
writeFileSync(process.env.TRACE_OUT || '/tmp/trace.json', JSON.stringify(events));
// analysis: long Layout / UpdateLayoutTree, plus the invalidations recorded since the previous one
const evs = events.filter((e) => e.ts).sort((a, b) => a.ts - b.ts);
const pid = evs.find((e) => e.name === 'TracingStartedInBrowser')?.pid;
let inv = [];
const out = [];
for (const e of evs) {
  if (e.name === 'LayoutInvalidationTracking' || e.name === 'StyleRecalcInvalidationTracking' || e.name === 'ScheduleStyleInvalidationTracking' || e.name === 'StyleInvalidatorInvalidationTracking') {
    const d = e.args?.data || {}; inv.push(`${e.name.replace('InvalidationTracking', '')}:${d.nodeName || ''}${d.reason ? ` (${d.reason})` : ''}${d.invalidatedSelectorId ? ` sel=${d.invalidatedSelectorId}` : ''}${d.changedClass ? ` .${d.changedClass}` : ''}${d.changedAttribute ? ` [${d.changedAttribute}]` : ''}${d.stackTrace?.[0] ? ` @${String(d.stackTrace[0].url).split('/').pop()}:${d.stackTrace[0].lineNumber}` : ''}`);
    continue;
  }
  if ((e.name === 'Layout' || e.name === 'UpdateLayoutTree') && e.ph === 'X' && e.dur > 12000) {
    const d = e.args?.beginData || e.args?.elementCount != null ? e.args : {};
    const counts = {}; for (const x of inv) counts[x] = (counts[x] || 0) + 1;
    out.push(`${(e.dur / 1000).toFixed(1)} ms ${e.name} ${e.name === 'Layout' ? `dirty ${e.args?.beginData?.dirtyObjects}/${e.args?.beginData?.totalObjects}` : `elements ${e.args?.elementCount}`}\n    ` + Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${v}x ${k}`).join('\n    '));
  }
  if (e.name === 'Layout' || e.name === 'UpdateLayoutTree') inv = [];
}
console.log(out.join('\n'));
await b.close(); await dev.close();

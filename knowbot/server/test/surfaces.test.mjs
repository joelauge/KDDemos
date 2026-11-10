// Answer surfaces (spec.surfaces) and per-surface pricing: validation, the Builder's plain-words acknowledgment, the
// landing hand-off markup, checkout totals and params, and the owner rule that no price shows before testing.
// Fakes only (127.0.0.1): never touches knowDrive, Twilio or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { validatePatch, defaultSpec, parseIntent, surfacesIntentOf, SURFACE_IDS as SERVER_IDS } from '../trials.mjs';
import { SURFACES as TOOL_IDS } from '../builder/tools.mjs';
import { SURFACES, SURFACE_IDS, normalizeSurfaces, planTotals, surfacesText, money } from '../../studio/surfaces.js';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

describe('answer surfaces: shared ids and plan math (studio/surfaces.js)', () => {
  test('the seven surfaces, in one order, everywhere', () => {
    assert.deepEqual(SURFACE_IDS, ['webchat', 'sms', 'whatsapp', 'email', 'phone', 'webvoice', 'site']);
    assert.deepEqual(SERVER_IDS, SURFACE_IDS, 'server/trials.mjs SURFACE_IDS matches studio/surfaces.js');
    assert.deepEqual(TOOL_IDS, SURFACE_IDS, 'server/builder/tools.mjs SURFACES matches studio/surfaces.js');
    assert.deepEqual(SURFACES.map((s) => s.label), ['Website chat', 'SMS', 'WhatsApp', 'Email', 'Phone', 'Web voice assistant', 'Single-page site']);
  });
  test('normalize: known ids only, deduped, canonical order, website chat when empty', () => {
    assert.deepEqual(normalizeSurfaces(['sms', 'webchat', 'sms', 'nope', 'WhatsApp']), ['webchat', 'sms', 'whatsapp']);
    assert.deepEqual(normalizeSurfaces([]), ['webchat']);
    assert.deepEqual(normalizeSurfaces(undefined), ['webchat']);
    assert.deepEqual(normalizeSurfaces(['nope'], { fallback: false }), []);
    assert.equal(surfacesText(['whatsapp', 'webchat', 'sms']), 'Website chat, SMS and WhatsApp');
  });
  test('totals: each surface $249/month or $2,499/year (3 surfaces = $747/month or $7,497/year)', () => {
    const m = planTotals(['webchat', 'sms', 'whatsapp'], 'month');
    assert.equal(m.count, 3); assert.equal(m.each, 249); assert.equal(m.total, 747); assert.equal(m.per, 'mo');
    assert.deepEqual(m.lines.map((l) => [l.id, l.amount]), [['webchat', 249], ['sms', 249], ['whatsapp', 249]]);
    const y = planTotals(['webchat', 'sms', 'whatsapp'], 'year');
    assert.equal(y.total, 7497); assert.equal(y.per, 'yr'); assert.equal(money(y.total), '$7,497');
    assert.equal(planTotals(SURFACE_IDS, 'month').total, 1743);
    assert.equal(planTotals(SURFACE_IDS, 'year').total, 17493);
    assert.equal(planTotals([], 'month').total, 249, 'no surfaces = the default website chat line');
    assert.equal(planTotals(['sms'], 'bogus').interval, 'month');
    assert.equal(planTotals(['sms', 'email'], 'month', { month: 300 }).total, 600, 'the configured price wins');
  });
});

describe('spec.surfaces validation (server/trials.mjs validatePatch)', () => {
  const spec = defaultSpec();
  test('a new trial answers on website chat', () => assert.deepEqual(spec.surfaces, ['webchat']));
  test('known ids, deduped, canonical order; not material (no version bump)', () => {
    const r = validatePatch({ surfaces: ['whatsapp', 'sms', 'whatsapp', 'webchat'] }, spec);
    assert.deepEqual(r.next.surfaces, ['webchat', 'sms', 'whatsapp']);
    assert.deepEqual(r.diff.map((d) => d.field), ['surfaces']);
    assert.equal(r.material, false);
    assert.equal(r.next.version, spec.version);
    assert.deepEqual(validatePatch({ surfaces: SURFACE_IDS }, spec).next.surfaces, SURFACE_IDS, 'all seven');
    assert.equal(validatePatch({ surfaces: ['webchat'] }, spec).diff.length, 0, 'same set: no diff');
    assert.equal(validatePatch({ surfaces: ['webchat'] }, { ...spec, surfaces: undefined }).diff.length, 0, 'an old trial without surfaces is website chat');
  });
  test('rejects empty, unknown, non-string and non-array values with a 400 naming the field', () => {
    for (const bad of [[], ['fax'], [1], 'sms', { sms: true }, null, Array(13).fill('sms')]) {
      assert.throws(() => validatePatch({ surfaces: bad }, spec), (e) => e.status === 400 && /surfaces/.test(e.message), JSON.stringify(bad));
    }
  });
});

describe('the Builder reads surface changes in plain words (parseIntent)', () => {
  const cur = ['webchat', 'sms'];
  const cases = [
    ['add WhatsApp', ['webchat', 'sms', 'whatsapp']],
    ['just web chat', ['webchat']],
    ['only SMS and email', ['sms', 'email']],
    ['drop SMS', ['webchat']],
    ['answer on SMS and WhatsApp too', ['webchat', 'sms', 'whatsapp']],
    ['also a voice assistant on my website', ['webchat', 'sms', 'webvoice']],
    ['add phone calls', ['webchat', 'sms', 'phone']],
    ['I want it on all channels', SURFACE_IDS],
  ];
  for (const [msg, want] of cases) test(`"${msg}"`, () => {
    const p = parseIntent(msg, { spec: { surfaces: cur } });
    assert.deepEqual(p.patch.surfaces, want);
    assert.ok(p.intents.includes('surfaces'));
    assert.ok(!p.intents.includes('set_scope'), 'never a file scope');
  });
  test('not a surface change', () => {
    for (const msg of ['Can it answer on WhatsApp?', 'my email is ana@example.com', 'add my phone number', 'a support bot for my bike shop', 'just the FAQ', 'make it shorter']) {
      assert.equal(surfacesIntentOf(msg, cur), null, msg);
      assert.equal(parseIntent(msg, { spec: { surfaces: cur } }).patch.surfaces, undefined, msg);
    }
  });
  test('removing the last one leaves none: refused, never an empty list', () => {
    assert.deepEqual(surfacesIntentOf('remove web chat', ['webchat']), { surfaces: null, named: ['webchat'] });
    assert.ok(parseIntent('remove web chat', { spec: { surfaces: ['webchat'] } }).intents.includes('surfaces_empty'));
  });
});

describe('landing: "Where should it answer?" (studio/index.html, landing.js) never shows a price', () => {
  const html = read('studio/index.html');
  const land = html.slice(html.indexOf('<div id="kl-landing"'), html.indexOf('<!-- end landing -->') > 0 ? html.indexOf('<!-- end landing -->') : html.indexOf('id="st-app"'));
  test('seven toggle buttons with visible names, website chat pressed by default', () => {
    const btns = [...land.matchAll(/<button type="button" class="kl-ch"[^>]*data-surface="(\w+)" aria-pressed="(true|false)">[\s\S]*?<span class="kl-ch-t">([^<]+)<\/span>/g)];
    assert.deepEqual(btns.map((m) => m[1]), SURFACE_IDS);
    assert.deepEqual(btns.map((m) => m[3]), SURFACES.map((s) => s.label), 'the accessible name is the visible text');
    assert.deepEqual(btns.filter((m) => m[2] === 'true').map((m) => m[1]), ['webchat']);
    assert.match(land, /role="group" aria-labelledby="kl-surf-h"/);
    assert.match(land, /id="kl-surf-h"[^>]*>Where should it answer\?</);
  });
  test('no price on the landing (markup or script); the hand-off carries the surfaces', () => {
    assert.doesNotMatch(land.replace(/<svg[\s\S]*?<\/svg>/g, ''), /\$\s?\d|\/mo\b|per month|per year/i);
    const js = read('studio/landing.js');
    assert.doesNotMatch(js.replace(/\/\*[\s\S]*?\*\//g, ''), /\$\s?\d|249|2,?499/);
    assert.match(js, /action\.surfaces = selectedSurfaces\(\)/);
    assert.match(js, /aria-pressed/);
    const app = read('studio/app.js');
    assert.match(app, /if \(Array\.isArray\(a\.surfaces\)\) landingSurfaces\(a\.surfaces\)/, 'app.js landingAction saves the hand-off');
  });
  test('studio price lines: multi-surface total everywhere, and no price on the palette before testing', () => {
    const app = read('studio/app.js');
    // priceText() sums one plan line per chosen surface: 3 surfaces + "how much" in Make it yours = $747/mo
    assert.match(app, /function priceText\(\) \{[\s\S]{0,200}planTotals\(getState\(\)\.spec\?\.surfaces, 'month'/);
    assert.equal(`${money(planTotals(['webchat', 'sms', 'phone'], 'month', { month: 249 }).total)}/mo`, '$747/mo');
    const pi = app.slice(app.indexOf('function priceIntent('), app.indexOf('if (isLive())', app.indexOf('function priceIntent(')));
    assert.match(pi, /if \(miy\) \{[\s\S]*Going live is \*\*\$\{priceText\(\)\}\*\*/, 'the Make it yours price line uses the surface total');
    assert.match(pi, /plan lines/, 'and says it is per answer surface');
    assert.doesNotMatch(app, /Going live is \*\*\$\$\{amt\}\/mo\*\*;/, 'no single-surface price in the Make it yours branch');
    assert.match(app, /\{ id: 'launch', label: launchChipLabel\(\), ico: 'rocket', run: \(\) => launchOpen\('palette'\) \}/, 'the palette hides the price until tested');
  });
  test('the Builder knowledge base states the per-surface price truthfully (asked directly, cited)', () => {
    const kb = read('studio/kb/pricing-and-trial.md');
    assert.match(kb, /Each answer surface is \$249 per month, or \$2,499 per year/);
    assert.match(kb, /website chat, SMS, WhatsApp, email, phone, the web voice assistant, and the single-page site/);
    assert.match(read('studio/kb/faq.md'), /Each answer surface is \$249 per month, or \$2,499 per year/);
  });
});

// ------------------------------------------------------------------------------------------------ over HTTP
async function boot() {
  const kd = await startFakeKnowDrive({ speed: 3, narrowScope: 'all' });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-surf-'));
  const env = { KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen' };
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env, studio: { sweep: false, pingMs: 200, pollMs: 40 } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  return { base, async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}
let ipSeq = 20;
describe('answer surfaces over HTTP (spec route, Builder turn, checkout)', () => {
  let S;
  before(async () => { S = await boot(); });
  after(async () => { await S?.close(); });
  const trial = async () => {
    const ip = `198.51.100.${ipSeq++}`;
    const r = await fetch(`${S.base}/api/studio/trials`, { method: 'POST', headers: { 'x-forwarded-for': ip } });
    assert.equal(r.status, 201);
    const t = { ...(await r.json()), ip };
    t.h = (extra = {}) => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': ip, 'content-type': 'application/json', ...extra });
    t.call = (p, method = 'GET', body) => fetch(`${S.base}/api/studio/trials/${t.trialId}${p}`, { method, headers: t.h(), body: body ? JSON.stringify(body) : undefined });
    return t;
  };
  const turn = async (t, body) => {
    const r = await t.call('/setup', 'POST', body);
    assert.equal(r.status, 200);
    return (await r.text()).split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);
  };

  test('PATCH spec: surfaces saved (deduped, ordered), junk refused with 400, version unchanged', async () => {
    const t = await trial();
    const before0 = (await (await t.call('')).json()).spec;
    assert.deepEqual(before0.surfaces, ['webchat']);
    const ok = await (await t.call('', 'PATCH', { surfaces: ['sms', 'webchat', 'sms', 'phone'] })).json();
    assert.deepEqual(ok.spec.surfaces, ['webchat', 'sms', 'phone']);
    assert.equal(ok.spec.version, before0.version);
    for (const bad of [[], ['fax'], 'sms']) {
      const r = await t.call('', 'PATCH', { surfaces: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match((await r.json()).error?.message || '', /surfaces/);
    }
    assert.deepEqual((await (await t.call('')).json()).spec.surfaces, ['webchat', 'sms', 'phone']);
  });

  test('Builder: "add WhatsApp" is acknowledged in plain words, saved, and no price before testing', async () => {
    const t = await trial();
    const ev = await turn(t, { message: 'add WhatsApp and SMS' });
    const reply = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(reply, /will answer on Website chat, SMS and WhatsApp/);
    assert.match(reply, /same sources/);
    assert.doesNotMatch(reply, /\$\s?\d/, 'never volunteers the price');
    const chips = ev.find((e) => e.event === 'chips')?.data.chips || [];
    assert.ok(chips.every((c) => !/\$\s?\d/.test(c.label)), `no price on a chip before testing: ${chips.map((c) => c.label)}`);
    assert.deepEqual((await (await t.call('')).json()).spec.surfaces, ['webchat', 'sms', 'whatsapp']);
    const ev2 = await turn(t, { message: 'just web chat' });
    assert.match(ev2.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /will answer on Website chat\./);
    assert.deepEqual((await (await t.call('')).json()).spec.surfaces, ['webchat']);
    const ev3 = await turn(t, { message: 'remove web chat' });
    assert.match(ev3.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /at least one place to answer/);
    assert.deepEqual((await (await t.call('')).json()).spec.surfaces, ['webchat']);
  });

  test('checkout: surfaces and interval in the URL with the live total; the visitor can remove surfaces there', async () => {
    const t = await trial();
    await t.call('', 'PATCH', { surfaces: ['webchat', 'sms', 'whatsapp'] });
    const go = async (body) => {
      const r = await fetch(`${S.base}/api/studio/trials/${t.trialId}/checkout`, { method: 'POST', headers: t.h({ origin: 'http://127.0.0.1:9999' }), body: JSON.stringify(body) });
      return { status: r.status, j: await r.json() };
    };
    let { status, j } = await go({ email: 'ana@example.com' });
    assert.equal(status, 200);
    let u = new URL(j.url);
    assert.equal(u.searchParams.get('surfaces'), 'webchat,sms,whatsapp');
    assert.equal(u.searchParams.get('interval'), 'month');
    assert.equal(u.searchParams.get('total'), '747');
    assert.equal(u.searchParams.get('price'), '249', 'the per-surface price param is kept');
    ({ j } = await go({ email: 'ana@example.com', interval: 'year' }));
    u = new URL(j.url);
    assert.equal(u.searchParams.get('interval'), 'year');
    assert.equal(u.searchParams.get('total'), '7497', 'yearly x 3 = $7,497');
    assert.equal(u.searchParams.get('price'), '2499', 'the per-surface price follows the interval');
    const yearSig = u.searchParams.get('sig');
    assert.match(String(yearSig), /^[A-Za-z0-9_-]{20,}$/, 'the plan params are signed');
    ({ j } = await go({ email: 'ana@example.com', interval: 'month' }));
    assert.notEqual(new URL(j.url).searchParams.get('sig'), yearSig, 'the signature covers interval and total');
    ({ j } = await go({ email: 'ana@example.com', surfaces: ['whatsapp', 'webchat'], interval: 'month' }));
    u = new URL(j.url);
    assert.equal(u.searchParams.get('surfaces'), 'webchat,whatsapp', 'removed at checkout');
    assert.equal(u.searchParams.get('total'), '498');
    assert.deepEqual((await (await t.call('')).json()).spec.surfaces, ['webchat', 'whatsapp'], 'and saved on the spec');
    assert.equal((await go({ email: 'ana@example.com', interval: 'weekly' })).status, 400);
    assert.equal((await go({ email: 'ana@example.com', surfaces: [] })).status, 400);
  });

  test('config: the per-surface price (month and year) for the checkout plan', async () => {
    const r = await fetch(`${S.base}/api/studio/config`);
    assert.equal(r.status, 200);
    const cfg = await r.json();
    assert.equal(cfg.price.amount, 249);
    assert.equal(cfg.price.yearAmount, 2499);
    assert.equal(cfg.price.perSurface, true);
  });
});

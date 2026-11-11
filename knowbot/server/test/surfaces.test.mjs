// Answer surfaces (spec.surfaces) as the features of the plan's three tools (Website, KnowBot number, Email) and the one
// plan price ($549/month or $5,490/year): validation, the tools mapping (no data loss), the Builder's plain-words
// acknowledgment, the landing hand-off markup, checkout params, and the owner rule that no price shows before testing.
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
import { SURFACES, SURFACE_IDS, TOOLS, SURFACE_TOOLS, AGENTS_FEATURE, agentSwitches, normalizeSurfaces, planTotals, surfacesText, money, toolSwitches, setFeature, toolsText, featureLabel } from '../../studio/surfaces.js';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

describe('answer surfaces: shared ids and plan math (studio/surfaces.js)', () => {
  test('the seven surfaces, in one order, everywhere', () => {
    assert.deepEqual(SURFACE_IDS, ['webchat', 'sms', 'whatsapp', 'email', 'phone', 'webvoice', 'site']);
    assert.deepEqual(SERVER_IDS, SURFACE_IDS, 'server/trials.mjs SURFACE_IDS matches studio/surfaces.js');
    assert.deepEqual(TOOL_IDS, SURFACE_IDS, 'server/builder/tools.mjs SURFACES matches studio/surfaces.js');
    assert.deepEqual(SURFACES.map((s) => s.label), ['Website chat', 'SMS', 'WhatsApp', 'Email', 'Phone calls', 'Website voice', 'Homepage search']);
  });
  test('normalize: known ids only, deduped, canonical order, website chat when empty', () => {
    assert.deepEqual(normalizeSurfaces(['sms', 'webchat', 'sms', 'nope', 'WhatsApp']), ['webchat', 'sms', 'whatsapp']);
    assert.deepEqual(normalizeSurfaces([]), ['webchat']);
    assert.deepEqual(normalizeSurfaces(undefined), ['webchat']);
    assert.deepEqual(normalizeSurfaces(['nope'], { fallback: false }), []);
    assert.equal(surfacesText(['whatsapp', 'webchat', 'sms']), 'Website chat, SMS and WhatsApp');
  });
  test('one plan: $549/month or $5,490/year, whatever features are on', () => {
    const m = planTotals(['webchat', 'sms', 'whatsapp'], 'month');
    assert.equal(m.count, 3); assert.equal(m.each, 549); assert.equal(m.total, 549); assert.equal(m.per, 'mo');
    assert.equal(m.lines.length, 1, 'one plan line');
    assert.deepEqual(m.lines.map((l) => [l.id, l.amount]), [['knowbot', 549]]);
    const y = planTotals(['webchat', 'sms', 'whatsapp'], 'year');
    assert.equal(y.total, 5490); assert.equal(y.per, 'yr'); assert.equal(money(y.total), '$5,490');
    assert.equal(planTotals(SURFACE_IDS, 'month').total, 549, 'every feature on: the same price');
    assert.equal(planTotals(SURFACE_IDS, 'year').total, 5490);
    assert.equal(planTotals([], 'month').total, 549);
    assert.equal(planTotals(['sms'], 'bogus').interval, 'month');
    assert.equal(planTotals(['sms', 'email'], 'month', { month: 600 }).total, 600, 'the configured price wins');
  });
});

describe('the four tools (studio/surfaces.js TOOLS): stored surfaces map to switches with no data loss', () => {
  test('Website, KnowBot number, Email, AI agents; every surface id is a feature of exactly one tool', () => {
    assert.deepEqual(TOOLS.map((t) => t.id), ['website', 'number', 'email', 'agents']);
    assert.deepEqual(TOOLS.map((t) => t.features), [['webchat', 'webvoice', 'site'], ['sms', 'phone', 'whatsapp'], ['email'], ['agents']]);
    assert.deepEqual(SURFACE_TOOLS.flatMap((t) => t.features).sort(), [...SURFACE_IDS].sort(), 'the plan tools cover every answer surface');
    assert.ok(!SURFACE_IDS.includes(AGENTS_FEATURE), 'AI agents is spec.agents.public, never a spec.surfaces id');
    assert.deepEqual(TOOLS.map((t) => t.features.map(featureLabel)), [['Chat bubble', 'Voice', 'Homepage search'], ['Texts', 'Calls', 'WhatsApp'], ['Inbox'], ['Public answers']]);
    assert.deepEqual(TOOLS.slice(3).map((t) => [t.label, t.sub]), [['AI agents', 'Answers other AI assistants, with sources']]);
  });
  test('AI agents: public by default, off only when spec.agents.public is false; never part of the plan text', () => {
    assert.equal(toolSwitches(['webchat']).find((t) => t.id === 'agents').on, true);
    assert.equal(toolSwitches(['webchat'], { agents: { public: false } }).find((t) => t.id === 'agents').on, false);
    assert.deepEqual(agentSwitches(undefined), { public: true, paid: false });
    assert.deepEqual(setFeature(['webchat'], AGENTS_FEATURE, true), ['webchat'], 'not a surface switch');
    assert.equal(toolsText(['webchat']), 'Website (Chat bubble)');
  });
  test('every stored list round-trips through the switches', () => {
    for (const list of [['webchat'], ['sms', 'whatsapp'], ['email', 'site'], SURFACE_IDS, ['phone', 'webvoice']]) {
      const sw = toolSwitches(list);
      const back = sw.flatMap((t) => t.features.filter((f) => f.on).map((f) => f.id));
      assert.deepEqual(normalizeSurfaces(back), normalizeSurfaces(list), JSON.stringify(list));
    }
    const sw = toolSwitches(['webchat', 'sms']);
    assert.deepEqual(sw.map((t) => t.on), [true, true, false, true]);
    assert.deepEqual(toolSwitches(undefined)[0].features.map((f) => f.on), [true, false, false], 'an old trial = the chat bubble');
  });
  test('switching a feature: on, off, and never the last one off', () => {
    assert.deepEqual(setFeature(['webchat'], 'phone', true), ['webchat', 'phone']);
    assert.deepEqual(setFeature(['webchat', 'phone'], 'webchat', false), ['phone']);
    assert.equal(setFeature(['phone'], 'phone', false), null);
    assert.deepEqual(setFeature(['webchat'], 'nope', true), ['webchat']);
    assert.equal(toolsText(['webchat', 'site', 'sms', 'email']), 'Website (Chat bubble, Homepage search), KnowBot number (Texts) and Email');
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
  test('a toggle per tool (Website, KnowBot number, Email, AI agents) covering every feature; website and AI agents pressed by default', () => {
    const btns = [...land.matchAll(/<button type="button" class="kl-ch kl-tool"[^>]*data-tool="(\w+)" data-surfaces="([\w,]+)" aria-pressed="(true|false)">[\s\S]*?<span class="kl-ch-t">([^<]+)<span/g)];
    assert.deepEqual(btns.map((m) => m[1]), ['website', 'number', 'email', 'agents']);
    assert.deepEqual(btns.map((m) => m[4].trim()), ['Website', 'KnowBot number', 'Email', 'AI agents'], 'the accessible name starts with the visible text');
    assert.deepEqual(btns.slice(0, 3).flatMap((m) => m[2].split(',')).sort(), [...SURFACE_IDS].sort(), 'every feature belongs to exactly one tool');
    assert.deepEqual(btns.filter((m) => m[3] === 'true').map((m) => m[1]), ['website', 'agents'], 'bots are public to AI agents by default');
    const js = read('studio/landing.js');
    assert.match(js, /action\.agents = agentsBtn\.getAttribute\('aria-pressed'\) === 'true'/, 'the AI agents toggle is handed off as spec.agents.public, not as a surface');
    assert.match(read('studio/app.js'), /typeof a\.agents === 'boolean'/);
    assert.match(land, /role="group" aria-labelledby="kl-surf-h"/);
    assert.match(land, /id="kl-surf-h"[^>]*>Where should it answer\?</);
  });
  test('no price on the landing (markup or script); the hand-off carries the surfaces', () => {
    assert.doesNotMatch(land.replace(/<svg[\s\S]*?<\/svg>/g, ''), /\$\s?\d|\/mo\b|per month|per year/i);
    const js = read('studio/landing.js');
    assert.doesNotMatch(js.replace(/\/\*[\s\S]*?\*\//g, ''), /\$\s?\d|549|5,?490|249|2,?499/);
    assert.match(js, /action\.surfaces = selectedSurfaces\(\)/);
    assert.match(js, /aria-pressed/);
    const app = read('studio/app.js');
    assert.match(app, /if \(Array\.isArray\(a\.surfaces\)\) landingSurfaces\(a\.surfaces\)/, 'app.js landingAction saves the hand-off');
  });
  test('studio price lines: the one plan price everywhere, and no price on the palette before testing', () => {
    const app = read('studio/app.js');
    assert.match(app, /function priceText\(\) \{[\s\S]{0,200}planTotals\(getState\(\)\.spec\?\.surfaces, 'month'/);
    assert.equal(`${money(planTotals(['webchat', 'sms', 'phone'], 'month', { month: 549 }).total)}/mo`, '$549/mo', 'three features, one price');
    const pi = app.slice(app.indexOf('function priceIntent('), app.indexOf('if (isLive())', app.indexOf('function priceIntent(')));
    assert.match(pi, /if \(miy\) \{[\s\S]*Going live is \*\*\$\{priceText\(\)\}\*\*/, 'the Make it yours price line uses the plan price');
    assert.match(pi, /all three tools/);
    assert.doesNotMatch(app, /per answer surface|plan lines|7 channels/, 'no per-surface copy left');
    assert.match(app, /\{ id: 'launch', label: launchChipLabel\(\), ico: 'rocket', run: \(\) => launchOpen\('palette'\) \}/, 'the palette hides the price until tested');
  });
  test('the spec drawer shows "Answers on" as the three tools with their feature checkboxes', () => {
    const app = read('studio/app.js');
    const form = app.slice(app.indexOf('function buildSpecForm('), app.indexOf('function syncSpecForm(') > 0 ? app.indexOf('function syncSpecForm(') : undefined);
    assert.match(form, /'Answers on'[\s\S]{0,200}TOOLS\.map\(\(t\) =>/);
    assert.match(form, /t\.features\.map\(\(id\) =>[\s\S]{0,160}name: 'surface', value: id/);
  });
  test('Set up: three tool cards with feature switches; no vendor names in customer copy', () => {
    const gl = read('studio/golive.js');
    assert.match(gl, /TOOLS\.forEach\(\(t, i\) =>/);
    assert.match(gl, /role: 'switch'/);
    assert.match(gl, /emit\('spec:request', \{ patch: \{ surfaces: next \}, by: 'user', quiet: true \}\)/);
    const copy = gl.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(copy, /SendGrid|Postmark|Mailgun|Twilio|Gemini|Stripe|EMAIL_WEBHOOK_SECRET|MAILGUN_SIGNING_KEY/);
    const co = read('studio/checkout.js').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(co, /answer surfaces?\b|Remove \$\{line\.label\}/, 'checkout has no per-surface lines');
  });
  test('the Builder knowledge base states the one plan truthfully (asked directly, cited)', () => {
    const kb = read('studio/kb/pricing-and-trial.md');
    assert.match(kb, /\$549 per month, or \$5,490 per year/);
    assert.match(kb, /There is one plan\. It includes all three tools, Website, KnowBot number and Email, with every feature/);
    assert.match(kb, /Switching a feature on or off never changes the price/);
    assert.doesNotMatch(kb, /\$249|\$2,499|answer surface/);
    assert.match(read('studio/kb/faq.md'), /No\. One plan, \$549 per month or \$5,490 per year, includes all three tools with every feature/);
    for (const f of ['pricing-and-trial.md', 'faq.md', 'channels.md']) assert.doesNotMatch(read(`studio/kb/${f}`), /SendGrid|Postmark|Mailgun|Twilio|Gemini|Stripe/, f);
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

  test('checkout: one plan line (plan, price = total) for the interval; the features ride along and never change it', async () => {
    const t = await trial();
    await t.call('', 'PATCH', { surfaces: ['webchat', 'sms', 'whatsapp'] });
    const go = async (body) => {
      const r = await fetch(`${S.base}/api/studio/trials/${t.trialId}/checkout`, { method: 'POST', headers: t.h({ origin: 'http://127.0.0.1:9999' }), body: JSON.stringify(body) });
      return { status: r.status, j: await r.json() };
    };
    let { status, j } = await go({ email: 'ana@example.com' });
    assert.equal(status, 200);
    let u = new URL(j.url);
    assert.equal(u.searchParams.get('plan'), 'knowbot');
    assert.equal(u.searchParams.get('surfaces'), 'webchat,sms,whatsapp');
    assert.equal(u.searchParams.get('interval'), 'month');
    assert.equal(u.searchParams.get('price'), '549');
    assert.equal(u.searchParams.get('total'), '549', 'three features, one plan price');
    ({ j } = await go({ email: 'ana@example.com', interval: 'year' }));
    u = new URL(j.url);
    assert.equal(u.searchParams.get('interval'), 'year');
    assert.equal(u.searchParams.get('price'), '5490');
    assert.equal(u.searchParams.get('total'), '5490');
    const yearSig = u.searchParams.get('sig');
    assert.match(String(yearSig), /^[A-Za-z0-9_-]{20,}$/, 'the plan params are signed');
    ({ j } = await go({ email: 'ana@example.com', interval: 'month' }));
    assert.notEqual(new URL(j.url).searchParams.get('sig'), yearSig, 'the signature covers interval and total');
    ({ j } = await go({ email: 'ana@example.com', surfaces: SURFACE_IDS, interval: 'month' }));
    u = new URL(j.url);
    assert.equal(u.searchParams.get('surfaces'), SURFACE_IDS.join(','));
    assert.equal(u.searchParams.get('total'), '549', 'every feature on: still one price');
    assert.deepEqual((await (await t.call('')).json()).spec.surfaces, SURFACE_IDS, 'and saved on the spec');
    assert.equal((await go({ email: 'ana@example.com', interval: 'weekly' })).status, 400);
    assert.equal((await go({ email: 'ana@example.com', surfaces: [] })).status, 400);
  });

  test('config: the one plan price (month and year) for the checkout', async () => {
    const r = await fetch(`${S.base}/api/studio/config`);
    assert.equal(r.status, 200);
    const cfg = await r.json();
    assert.equal(cfg.price.amount, 549);
    assert.equal(cfg.price.yearAmount, 5490);
    assert.equal(cfg.price.perSurface, false);
    assert.equal(cfg.price.plan, 'knowbot');
    assert.match(cfg.price.annualLine, /\$5,490\/year/);
  });

  test('GET /v1/channels/:bot exposes the Website switches for the one-line embed (lib/embed.js)', async () => {
    const t = await trial();
    await t.call('', 'PATCH', { surfaces: ['webchat', 'site', 'sms'] });
    const r = await fetch(`${S.base}/api/v1/channels/${t.trialId}`);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).website, { chat: true, voice: false, homepage: true });
  });
});

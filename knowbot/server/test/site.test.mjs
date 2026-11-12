// The Homepage search answer surface, a search overlay on the business's homepage (server/site.mjs, site/overlay.js,
// GET|POST /api/studio/trials/:id/site, GET /api/site/:id, scope "site" keys): nothing invented (facts are verbatim
// lines with their source, chips and popular questions only from validated questions), owner edits and options persist,
// publish gates the public page, the site key can only ask questions, the homepage line and how-to download.
// Fakes only (127.0.0.1): never touches knowDrive or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { buildSite, factsFrom, brandColors, contrast, validateSiteEdit, publicSite, siteHtml, siteNameOf, fileLabel, overlaySnippet, siteLogo, editsView, SITE_ORBS } from '../site.mjs';
import { ORB_IDS } from '../../lib/voice-orb.js';
import { brandOfHtml, frameableOf } from '../storeimport.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const CONTACT = `# Contact us

Call us on (555) 123-4567 for help with an order.

Email help@lumen.example and we reply within one business day.

The shop is open Monday to Friday, 9am to 5pm.
`;
const RETURNS = `# Returns policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.

# Shipping

We ship to Canada and the United States. Standard shipping takes 3 to 5 business days.
`;

describe('site generator (pure)', () => {
  const files = [
    { id: 'f1', name: 'Lumen Bikes · Refund policy.md', path: 'site/lumen.example/policy/refund-policy.md', url: 'https://lumen.example/policies/refund-policy', summary: { topics: ['Refunds', 'Exchanges'] } },
    { id: 'f2', name: 'manual.pdf', summary: null },
  ];
  const questions = { starters: [{ q: 'How long do I have to return a bike?', fileId: 'f1' }, { q: 'What is the capital of Peru?', fileId: 'nope' }],
    proof: [{ q: 'How do refunds work?', fileId: 'f1' }, { q: 'How do I adjust the brakes?', fileId: 'f2' }, { q: 'How long do I have to return a bike?', fileId: 'f1' }] };
  const atomsByFile = [{ file: files[0], atoms: [{ text: 'Questions? Call us on +1 555 123 4567, Monday to Friday.' }, { text: '- Email **help@lumen.example** for returns.' }] }];
  const g = buildSite({ spec: { name: 'Lumen Bikes Help', avatar: { hue: 2, initials: 'LB' } }, files, questions, atomsByFile, store: { name: 'Lumen Bikes', url: 'https://lumen.example', frameable: true, brand: { color: '#ffd400', logo: 'https://lumen.example/icon.png' } } });

  test('chips and popular questions only from validated questions about ready files', () => {
    const valid = new Set(['How long do I have to return a bike?', 'How do refunds work?', 'How do I adjust the brakes?']);
    assert.ok(g.chips.length >= 2 && g.chips.length <= 8, JSON.stringify(g.chips));
    for (const c of g.chips) assert.ok(valid.has(c.q), `chip question is validated: ${c.q}`);
    for (const q of g.questions) assert.ok(valid.has(q), `popular question is validated: ${q}`);
    assert.ok(!g.questions.includes('What is the capital of Peru?'), 'a question about a file that is not ready is dropped');
    assert.equal(new Set(g.questions).size, g.questions.length, 'no duplicates');
    assert.deepEqual(g.chips.map((c) => c.label).slice(0, 2), ['Refund policy', 'Manual'], 'labels are file titles first');
    assert.ok(g.chips.some((c) => c.label === 'Refunds'), 'then the file’s own topics');
  });
  test('facts: verbatim lines with their source; emphasis lines are skipped, never rewritten', () => {
    assert.deepEqual(g.facts.map((f) => f.kind), ['phone']);
    assert.equal(g.facts[0].text, 'Questions? Call us on +1 555 123 4567, Monday to Friday.');
    assert.equal(g.facts[0].fileId, 'f1');
    assert.equal(g.facts[0].url, 'https://lumen.example/policies/refund-policy');
    assert.deepEqual(factsFrom([]), []);
    assert.deepEqual(factsFrom([{ file: { id: 'x', name: 'x.md' }, atoms: [{ text: 'We have no phone line.' }] }]), [], 'no number, no fact');
  });
  test('links: a website page links to the page itself, by file id and by the file name a citation carries', () => {
    assert.equal(g.links.byId.f1, 'https://lumen.example/policies/refund-policy');
    assert.equal(g.links.byName['refund-policy.md'], 'https://lumen.example/policies/refund-policy');
    assert.equal(g.links.byId.f2, undefined, 'an uploaded file has no page (the answer links its proof page)');
  });
  test('name, brand and colour: from the website, made readable; else the bot’s hue', () => {
    assert.equal(g.name, 'Lumen Bikes');
    assert.equal(siteNameOf({ name: 'Acme Help' }), 'Acme');
    assert.equal(siteNameOf({ name: 'SampleBot' }), 'Our help centre');
    assert.equal(g.brand.logo, 'https://lumen.example/icon.png');
    assert.ok(contrast(g.brand.color, '#ffffff') >= 4.5, `white text on ${g.brand.color}`);
    assert.ok(contrast(g.brand.colorDark, '#15151f') >= 4.5, `${g.brand.colorDark} on the dark page`);
    assert.equal(brandColors(null, 0).color, '#4f46e5');
    assert.equal(brandColors(null, 0).fromSite, false);
    assert.equal(g.homeUrl, 'https://lumen.example');
    assert.equal(g.homeFrame, 'https://lumen.example', 'a homepage that allows framing shows behind the hosted overlay');
    assert.equal(buildSite({ spec: {}, store: { url: 'https://lumen.example' } }).homeFrame, null, 'unknown framing: a neutral backdrop');
    assert.equal(fileLabel('site/x.example/faq/shipping-and-returns.md'), 'Shipping and returns');
    assert.equal(fileLabel('lumen-store-faq.txt', 'Lumen Bikes'), 'Store FAQ', 'the business name is not repeated on every chip');
  });
  test('brandOfHtml: theme-color and a square icon from the head, https only', () => {
    assert.deepEqual(brandOfHtml('<head><meta name="theme-color" content="#0F766E"><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/f.ico"></head>', 'https://shop.example/'),
      { color: '#0f766e', logo: 'https://shop.example/apple.png' });
    assert.equal(brandOfHtml('<meta name="theme-color" content="red"><link rel="icon" href="/favicon.ico">', 'https://shop.example/'), null, 'named colours and tiny icons are not used');
    assert.deepEqual(brandOfHtml('<link rel="icon" href="/logo.svg">', 'http://shop.example/'), null, 'http icons are not used');
  });
  test('frameableOf: only a homepage whose headers allow framing', () => {
    assert.equal(frameableOf({}), true, 'no frame headers');
    assert.equal(frameableOf({ 'x-frame-options': 'SAMEORIGIN' }), false);
    assert.equal(frameableOf({ 'x-frame-options': 'DENY' }), false);
    assert.equal(frameableOf({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }), false);
    assert.equal(frameableOf({ 'content-security-policy': "frame-ancestors 'self' https://knowbot.knowdrive.ai" }), true);
    assert.equal(frameableOf({ 'content-security-policy': 'frame-ancestors *' }), true);
    assert.equal(frameableOf({ 'content-security-policy': "script-src 'self'" }), true, 'a CSP without frame-ancestors');
    assert.equal(frameableOf(null), false, 'unknown is no');
  });
  test('options: show until dismissed (default) or every visit; topic chips off unless turned on', () => {
    const p0 = publicSite(g, {}, { botId: 'acme' });
    assert.equal(p0.showOn, 'until-dismissed');
    assert.equal(p0.showChips, false);
    assert.ok(p0.chips.length >= 1, 'chips stay in the spec for the owner to turn on');
    const e = validateSiteEdit({ showOn: 'every-visit', showChips: true });
    assert.deepEqual(e, { showOn: 'every-visit', showChips: true });
    const p1 = publicSite(g, e, { botId: 'acme' });
    assert.equal(p1.showOn, 'every-visit');
    assert.equal(p1.showChips, true);
    for (const [bad, field] of [[{ showOn: 'sometimes' }, 'showOn'], [{ showChips: 'yes' }, 'showChips']]) {
      assert.throws(() => validateSiteEdit(bad), (err) => err.status === 400 && err.field === field, JSON.stringify(bad));
    }
    assert.deepEqual(validateSiteEdit({ showOn: null }, { showOn: 'every-visit' }), {}, 'null goes back to the default');
    assert.deepEqual(validateSiteEdit({ showOn: 'first-visit' }), { showOn: 'until-dismissed' }, 'the earlier name still works');
    assert.equal(publicSite(g, { showOn: 'first-visit' }, { botId: 'acme' }).showOn, 'until-dismissed', 'saved under the earlier name');
  });
  test('orb: voice mode’s colour, one of the presets (default ocean); null resets; junk is a 400', () => {
    assert.deepEqual([...SITE_ORBS], [...ORB_IDS], 'the server knows the same presets as lib/voice-orb.js');
    assert.equal(publicSite(g, {}, { botId: 'acme' }).orb, 'ocean');
    const e = validateSiteEdit({ orb: 'sunset' });
    assert.deepEqual(e, { orb: 'sunset' });
    assert.equal(publicSite(g, e, { botId: 'acme' }).orb, 'sunset');
    assert.deepEqual(validateSiteEdit({ orb: null }, e), {}, 'null goes back to the default');
    assert.equal(publicSite(g, { orb: 'neon' }, { botId: 'acme' }).orb, 'ocean', 'an unknown saved value shows the default');
    for (const bad of ['neon', 7, true, 'Ocean']) assert.throws(() => validateSiteEdit({ orb: bad }), (err) => err.status === 400 && err.field === 'orb', String(bad));
  });
  test('subline: the line under the search box, owner-set or the default (null)', () => {
    const e = validateSiteEdit({ subline: '  Ask about rules, campaigns   and dice. ' });
    assert.deepEqual(e, { subline: 'Ask about rules, campaigns and dice.' });
    assert.equal(publicSite(g, e, { botId: 'acme' }).subline, 'Ask about rules, campaigns and dice.');
    assert.equal(publicSite(g, {}, { botId: 'acme' }).subline, null, 'the overlay then shows its default sentence');
    assert.deepEqual(validateSiteEdit({ subline: '' }, e), {}, 'empty resets it');
    assert.throws(() => validateSiteEdit({ subline: 'x'.repeat(141) }), (err) => err.status === 400 && err.field === 'subline');
    assert.throws(() => validateSiteEdit({ subline: 7 }), (err) => err.status === 400 && err.field === 'subline');
  });
  test('logo: PNG, JPEG or WebP data URL up to 150 KB; served by path with a digest; null removes it', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
    const e = validateSiteEdit({ logo: `data:image/png;base64,${png.toString('base64')}` });
    assert.equal(e.logo.type, 'image/png');
    assert.match(e.logo.v, /^[a-f0-9]{12}$/);
    assert.deepEqual(siteLogo(e).bytes, png);
    assert.deepEqual(editsView(e).logo, { type: 'image/png', v: e.logo.v }, 'the Studio is never sent the bytes back');
    const p = publicSite(g, e, { botId: 'acme' });
    assert.deepEqual(p.logo, { path: `/api/site/acme/logo?v=${e.logo.v}` });
    assert.equal(publicSite(g, {}, { botId: 'acme' }).logo, null);
    assert.deepEqual(validateSiteEdit({ logo: null }, e), { noLogo: true }, 'null removes it (and keeps a sample logo away)');
    assert.equal(validateSiteEdit({ logo: `data:image/png;base64,${png.toString('base64')}` }, { noLogo: true }).noLogo, undefined, 'a new logo clears that');
    const big = Buffer.concat([png, Buffer.alloc(151 * 1024)]);
    for (const bad of ['data:image/svg+xml;base64,PHN2Zy8+', `data:image/png;base64,${Buffer.from('not a png').toString('base64')}`, `data:image/png;base64,${big.toString('base64')}`, 'https://example.com/logo.png', 42]) {
      assert.throws(() => validateSiteEdit({ logo: bad }), (err) => err.status === 400 && err.field === 'logo', String(bad).slice(0, 40));
    }
  });
  test('owner edits: validated, 400 with the field name on junk', () => {
    const e = validateSiteEdit({ name: '  Lumen  Bikes ', tagline: 'Bikes for trails.', chips: ['Opening hours?', { label: 'Returns', q: 'How do returns work?' }], published: true });
    assert.deepEqual(e, { name: 'Lumen Bikes', tagline: 'Bikes for trails.', chips: [{ label: 'Opening hours?', q: 'Opening hours?' }, { label: 'Returns', q: 'How do returns work?' }], published: true });
    for (const [bad, field] of [[{ name: 'x'.repeat(61) }, 'name'], [{ chips: Array(9).fill('a') }, 'chips'], [{ published: 'yes' }, 'published'], [{ colour: 'red' }, 'colour'], [{ chips: [{ label: '' }] }, 'chips']]) {
      assert.throws(() => validateSiteEdit(bad), (err) => err.status === 400 && err.field === field, JSON.stringify(bad));
    }
    assert.deepEqual(validateSiteEdit({ name: null }, { name: 'Old' }), {}, 'null clears an edit (back to the generated value)');
  });
  test('the homepage line: one async script tag with the bot id (data-api only for a loopback dev server)', () => {
    assert.equal(overlaySnippet('tr_abcdefghijklmnop'), '<script src="https://knowbot.knowdrive.ai/site/overlay.js" data-bot="tr_abcdefghijklmnop" async></script>');
    assert.equal(overlaySnippet('acme', { apiBase: 'https://api.example' }), '<script src="https://knowbot.knowdrive.ai/site/overlay.js" data-bot="acme" async></script>', 'the hosted API is found from the script');
    assert.equal(overlaySnippet('acme', { assetBase: 'http://127.0.0.1:8080/', apiBase: 'http://127.0.0.1:8080' }), '<script src="http://127.0.0.1:8080/site/overlay.js" data-bot="acme" data-api="http://127.0.0.1:8080" async></script>');
    assert.equal(overlaySnippet('a"b'), '<script src="https://knowbot.knowdrive.ai/site/overlay.js" data-bot="a&quot;b" async></script>', 'escaped');
  });
  test('download: a short how-to with the line to paste, and the line itself (opening it shows the overlay)', () => {
    const html = siteHtml(publicSite(g, { name: 'Lumen <Bikes>' }, { botId: 'tr_abcdefghijklmnop', trial: true }), { botId: 'tr_abcdefghijklmnop', apiBase: 'https://api.example' });
    assert.match(html, /<title>Add Lumen &lt;Bikes&gt; search to your homepage<\/title>/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<pre><code>&lt;script src=&quot;https:\/\/knowbot\.knowdrive\.ai\/site\/overlay\.js&quot; data-bot=&quot;tr_abcdefghijklmnop&quot; async&gt;&lt;\/script&gt;<\/code><\/pre>/, 'the line to copy');
    assert.match(html, /\n<script src="https:\/\/knowbot\.knowdrive\.ai\/site\/overlay\.js" data-bot="tr_abcdefghijklmnop" async><\/script>\n<\/body>/, 'and live at the end');
    assert.match(html, /before <code>&lt;\/body&gt;<\/code>/);
    assert.doesNotMatch(html, /site\.js/, 'not the old full page');
    assert.doesNotMatch(html, /\b(?:AI|OpenAI|Gemini|Twilio|Qwen)\b/, 'no vendor names');
  });
  test('overlay.js: the hosted API map matches lib/site-config.js; it parses as a classic script with no globals', () => {
    const src = readFileSync(path.join(ROOT, 'site', 'overlay.js'), 'utf8');
    const cfg = readFileSync(path.join(ROOT, 'lib', 'site-config.js'), 'utf8');
    const pick = (s) => Object.fromEntries([...s.matchAll(/'([a-z0-9.-]+\.[a-z]{2,})':\s*'(https:\/\/[^']+)'/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(pick(src), pick(cfg));
    assert.ok(Object.keys(pick(cfg)).length >= 1);
    assert.doesNotThrow(() => new vm.Script(src), 'a classic script (async on any page), not a module');
    assert.match(src, /^\/\*[\s\S]*?\*\/\n\(\(\) => \{/, 'one IIFE: nothing on window');
    assert.match(src, /attachShadow\(\{ mode: 'open' \}\)/);
    assert.doesNotMatch(src, /\b(?:OpenAI|Gemini|Twilio|Qwen)\b/, 'no vendor names in what visitors load');
  });
});

// ------------------------------------------------------------------------------------------------ over HTTP
async function boot() {
  const kd = await startFakeKnowDrive({ speed: 20 });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-site-'));
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen',
    RESEND_API_KEY: 'fake-resend', // this server can email (nothing is sent: no test gives an address)
  }, studio: { sweep: false, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  return { kd, kb, base, async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}
const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);

describe('Homepage search over HTTP', () => {
  let S, t, tok, files;
  const ip = '198.51.100.77';
  before(async () => {
    S = await boot();
    t = await (await fetch(`${S.base}/api/studio/trials`, { method: 'POST', headers: { 'x-forwarded-for': ip } })).json();
    tok = (extra = {}) => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': ip, ...extra });
    for (const [name, body] of [['contact.md', CONTACT], ['returns.md', RETURNS]]) {
      const r = await fetch(`${S.base}/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: tok({ 'x-filename': name, 'content-type': 'application/octet-stream' }), body });
      assert.equal(r.status, 201);
    }
    // the sample files come with questions the Studio validates (the chips' and popular questions' only source)
    assert.equal((await fetch(`${S.base}/api/studio/trials/${t.trialId}/samples`, { method: 'POST', headers: tok({ 'content-type': 'application/json' }), body: JSON.stringify({ set: 'lumen-bikes' }) })).status, 201);
    assert.equal((await fetch(`${S.base}/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: tok({ 'content-type': 'application/json' }), body: JSON.stringify({ name: 'Lumen Bikes Help' }) })).status, 200);
    for (let i = 0; i < 300; i++) {
      const j = await (await fetch(`${S.base}/api/studio/trials/${t.trialId}`, { headers: tok() })).json();
      files = j.files;
      if (files.length >= 6 && files.every((f) => f.stage === 'ready')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(files.every((f) => f.stage === 'ready'), 'files ready');
  });
  after(async () => { await S?.close(); });
  const site = (method = 'GET', body, q = '') => fetch(`${S.base}/api/studio/trials/${t.trialId}/site${q}`, { method, headers: tok(body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });

  test('GET builds the site from the files: no invented facts, chips and questions only from validated ones', async () => {
    const r = await site();
    assert.equal(r.status, 200);
    const v = await r.json();
    assert.equal(v.site.name, 'Lumen Bikes');
    assert.equal(v.published, false);
    assert.equal(v.hostedUrl, `https://knowbot.knowdrive.ai/site/?bot=${t.trialId}`);
    assert.match(v.snippet, new RegExp(`^<script src="http://127\\.0\\.0\\.1:\\d+/site/overlay\\.js" data-bot="${t.trialId}" data-api="http://127\\.0\\.0\\.1:\\d+" async></script>$`), 'a loopback dev server: its own copy');
    assert.equal(v.site.showOn, 'until-dismissed');
    assert.match(v.site.logo?.path || '', /\/logo\?v=[a-f0-9]{12}$/, 'the sample shop shows its own logo');
    assert.equal(v.site.showChips, false);
    // facts: each one a verbatim line of the file it names
    assert.ok(v.site.facts.length >= 3, JSON.stringify(v.site.facts));
    const byId = new Map(files.map((f) => [f.id, f.name]));
    for (const f of v.site.facts) {
      const kdFile = S.kd.files.get(f.fileId);
      assert.ok(kdFile, `the fact names a real file: ${f.fileId}`);
      assert.ok(kdFile.text.includes(f.text), `verbatim from ${f.file}: ${f.text}`);
      assert.ok(kdFile.atoms.some((a) => String(a.text ?? a).includes(f.text)), 'within one passage');
      assert.equal(f.file, byId.get(f.fileId));
    }
    assert.ok(v.site.facts.some((f) => f.text === 'Call us on (555) 123-4567 for help with an order.'));
    assert.deepEqual(v.site.facts.map((f) => f.kind), ['phone', 'email', 'hours']);
    // chips and popular questions: only questions the Studio validated against the files
    const qs = await (await fetch(`${S.base}/api/studio/trials/${t.trialId}/questions`, { headers: tok() })).json();
    const valid = new Set([...qs.starters, ...qs.proof].map((x) => x.q));
    assert.ok(v.site.chips.length >= 1 && v.site.chips.length <= 8, JSON.stringify({ chips: v.site.chips, qs }));
    for (const c of v.site.chips) assert.ok(valid.has(c.q), `chip: ${c.q}`);
    assert.ok(v.site.questions.length >= 1 && v.site.questions.length <= 5);
    for (const q of v.site.questions) assert.ok(valid.has(q), `question: ${q}`);
  });

  test('not published: the public page is 404, the owner’s trial key still opens the preview', async () => {
    assert.equal((await fetch(`${S.base}/api/site/${t.trialId}`)).status, 404);
    assert.equal((await fetch(`${S.base}/api/site/tr_aaaaaaaaaaaaaaaa`)).status, 404);
    const dk = await (await fetch(`${S.base}/api/studio/trials/${t.trialId}/devkey`, { headers: tok() })).json();
    const r = await fetch(`${S.base}/api/site/${t.trialId}`, { headers: { authorization: `Bearer ${dk.key}` } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.preview, true);
    assert.equal(j.noindex, true);
  });

  test('owner edits persist (saved in the spec doc, survive a reload) and junk is a 400', async () => {
    const chips = [{ label: 'Returns', q: 'How many days do I have to return an unused item?' }, { label: 'Hours', q: 'When is the shop open?' }];
    const r = await site('POST', { name: 'Lumen Bikes Co', tagline: 'Bikes for trails and towns.', chips, showOn: 'every-visit', showChips: true });
    assert.equal(r.status, 200);
    const v = await r.json();
    assert.equal(v.site.showOn, 'every-visit');
    assert.equal(v.site.showChips, true);
    assert.equal(v.site.name, 'Lumen Bikes Co');
    assert.equal(v.site.tagline, 'Bikes for trails and towns.');
    assert.deepEqual(v.site.chips, chips);
    assert.equal(v.generated.name, 'Lumen Bikes', 'the generated name is kept beside the edit');
    const bad = await site('POST', { name: '' .padEnd(70, 'x') });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.field, 'name');
    // a restart: the trial is read back from its spec doc in knowDrive
    S.kb.studio.trials.delete(t.trialId);
    const again = await (await site()).json();
    assert.equal(again.site.name, 'Lumen Bikes Co');
    assert.deepEqual(again.site.chips, chips);
    assert.equal(again.site.showOn, 'every-visit', 'options survive a reload');
    assert.equal((await site('POST', { showOn: 'often' })).status, 400);
    // a logo: saved, served as bytes (cached by its digest), never echoed back to the Studio, removable
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const withLogo = await (await site('POST', { logo: `data:image/png;base64,${png.toString('base64')}` })).json();
    assert.match(withLogo.site.logo.path, new RegExp(`^/api/site/${t.trialId}/logo\\?v=[a-f0-9]{12}$`));
    assert.equal(withLogo.edits.logo.data, undefined);
    const lr = await fetch(`${S.base}${withLogo.site.logo.path}`);
    assert.equal(lr.status, 200);
    assert.equal(lr.headers.get('content-type'), 'image/png');
    assert.match(lr.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await lr.arrayBuffer()), png);
    assert.equal((await site('POST', { logo: 'data:image/png;base64,AAAA' })).status, 400);
    const noLogo = await (await site('POST', { logo: null })).json();
    assert.equal(noLogo.site.logo, null);
    assert.equal((await fetch(`${S.base}/api/site/${t.trialId}/logo`)).status, 404);
    assert.ok(again.site.facts.length >= 3, 'the generated site was saved too');
    // a spec PATCH that carries the site field is not a way around validation (read-only there)
    assert.equal((await fetch(`${S.base}/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: tok({ 'content-type': 'application/json' }), body: JSON.stringify({ site: { name: 'x', published: true } }) })).status, 200);
    assert.equal((await (await site()).json()).published, false);
  });

  test('publish: the public page and a key that can only ask questions, answers logged as channel site', async () => {
    const p = await (await site('POST', { published: true })).json();
    assert.equal(p.published, true);
    const r = await fetch(`${S.base}/api/site/${t.trialId}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const pub = await r.json();
    assert.equal(pub.name, 'Lumen Bikes Co');
    assert.equal(pub.showOn, 'every-visit', 'the overlay reads its options from the public site');
    assert.equal(pub.showChips, true);
    assert.equal(pub.preview, false);
    assert.match(pub.key, /^kb_trial_/);
    assert.ok(Date.parse(pub.keyExpiresAt) <= Date.now() + 6 * 3600 * 1000 + 5000, 'a few hours at most');
    const auth = { authorization: `Bearer ${pub.key}`, 'content-type': 'application/json' };
    // it asks questions, streamed, with citations
    const ans = await fetch(`${S.base}/api/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ question: 'How many days do I have to return an unused item?', stream: true, format: 'bullets', user: 'v1' }) });
    assert.equal(ans.status, 200);
    const ev = sse(await ans.text());
    const fin = ev.find((e) => e.event === 'final')?.data;
    assert.ok(fin && !fin.refused, JSON.stringify(ev.slice(-2)));
    assert.ok(fin.citations.length >= 1);
    assert.match(fin.answer, /30 days/);
    assert.match(fin.proofUrl || '', /\/p\//, 'an uploaded file’s source links to the proof page');
    // and nothing else
    for (const [p2, body] of [[`/v1/bots/${t.trialId}/preview`, { channel: 'sms', question: 'hi' }], ['/v1/chat/completions', { model: t.trialId, messages: [{ role: 'user', content: 'hi' }] }]]) {
      const x = await fetch(`${S.base}${p2}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      assert.equal(x.status, 403, p2);
      assert.equal((await x.json()).error.code, 'wrong_scope');
    }
    assert.equal((await fetch(`${S.base}/v1/models`, { headers: auth })).status, 403);
    assert.equal((await fetch(`${S.base}/v1/bots/tr_bbbbbbbbbbbbbbbb/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ question: 'hi' }) })).status, 403, 'another bot');
    // logged under channel site
    let logged = [];
    for (let i = 0; i < 50 && !logged.length; i++) {
      logged = [...S.kd.files.values()].filter((f) => f.tags.includes('questions') && f.tags.includes(`trial:${t.trialId}`) && f.tags.includes('channel:site'));
      if (!logged.length) await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.ok(logged.length >= 1, 'channel:site question logged');
  });

  test('voice mode: the site key opens the bot’s voice session, asks, and offers "send me this" like the typed search; the orb colour is the owner’s', async () => {
    assert.equal((await (await site('POST', { orb: 'violet' })).json()).site.orb, 'violet');
    const pub = await (await fetch(`${S.base}/api/site/${t.trialId}`)).json();
    assert.equal(pub.orb, 'violet');
    assert.equal(pub.endpoints.voice, `${S.base.replace(/^http/, 'ws')}/api/v1/bots/${t.trialId}/voice/live`);
    const dk = await (await fetch(`${S.base}/api/studio/trials/${t.trialId}/devkey`, { headers: tok() })).json();
    assert.equal(dk.channels.webVoice.orb, 'violet', 'web chat reads the same choice');
    const session = (key) => new Promise((resolve, reject) => {
      const ws = new WebSocket(pub.endpoints.voice);
      const got = [];
      const timer = setTimeout(() => { ws.close(); reject(new Error(`timed out: ${JSON.stringify(got)}`)); }, 20000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start', key })));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data));
        got.push(m);
        if (m.type === 'ready') ws.send(JSON.stringify({ type: 'text', text: 'How many days do I have to return an unused item?' }));
        if (m.type === 'answer' && got.filter((x) => x.type === 'answer').length === 1) { ws.send(JSON.stringify({ type: 'text', text: 'Can you email me that?' })); return; }
        if (m.type === 'answer' || m.type === 'error') { clearTimeout(timer); ws.close(); resolve(got); }
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket failed')); });
    });
    const got = await session(pub.key);
    assert.equal(got[0].type, 'ready', JSON.stringify(got[0]));
    const [a, ask] = got.filter((m) => m.type === 'answer');
    assert.ok(a, JSON.stringify(got.slice(-1)));
    assert.equal(a.sendInfo, undefined);
    assert.match(a.text, /30 days/);
    assert.ok(a.citations.length >= 1);
    // "email me that" in voice mode on the Homepage search asks for the address (it used to fall through to a refusal)
    assert.ok(ask, JSON.stringify(got.slice(-1)));
    assert.equal(ask.refused, false, JSON.stringify(ask));
    assert.equal(ask.sendInfo?.status, 'ask', JSON.stringify(ask));
    assert.match(ask.text, /email address/i);
    // a key for another bot is still refused
    const other = await session(pub.key.replace(/^kb_trial_[A-Za-z0-9_-]+/, 'kb_trial_x'));
    assert.equal(other.find((m) => m.type === 'error')?.code, 'unauthorized');
  });

  test('a question that is not in the files gets the refusal sentence, no sources', async () => {
    const pub = await (await fetch(`${S.base}/api/site/${t.trialId}`)).json();
    const r = await fetch(`${S.base}/api/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${pub.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What is the capital of Australia?' }) });
    const j = await r.json();
    assert.equal(j.refused, true);
    assert.deepEqual(j.citations, []);
  });

  test('download: the how-to with the homepage line, as an attachment', async () => {
    const r = await site('GET', null, '?download=1&api=https%3A%2F%2Fapi.example');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename="add-to-homepage\.html"/);
    const html = await r.text();
    assert.match(html, new RegExp(`<script src="https://knowbot\\.knowdrive\\.ai/site/overlay\\.js" data-bot="${t.trialId}" async></script>`));
    assert.match(html, /<title>Add Lumen Bikes Co search to your homepage<\/title>/);
    assert.match(html, /noindex/);
  });
  test('the hosted link and the overlay script are served', async () => {
    const page = await (await fetch(`${S.base}/site/`)).text();
    assert.match(page, /<script src="\.\/overlay\.js(?:\?v=[\w.-]+)?" data-hosted defer><\/script>/);
    const js = await fetch(`${S.base}/site/overlay.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);
  });

  test('unpublish takes the public page down; the trial token is required for the owner routes', async () => {
    await site('POST', { published: false });
    assert.equal((await fetch(`${S.base}/api/site/${t.trialId}`)).status, 404);
    assert.equal((await fetch(`${S.base}/api/studio/trials/${t.trialId}/site`)).status, 401);
  });
});

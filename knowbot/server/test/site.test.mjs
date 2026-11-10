// The Single-page site answer surface (server/site.mjs, GET|POST /api/studio/trials/:id/site, GET /api/site/:id, scope
// "site" keys): nothing invented (facts are verbatim lines with their source, chips and popular questions only from
// validated questions), owner edits persist, publish gates the public page, the site key can only ask questions.
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
import { buildSite, factsFrom, brandColors, contrast, validateSiteEdit, publicSite, siteHtml, siteNameOf, fileLabel } from '../site.mjs';
import { brandOfHtml } from '../storeimport.mjs';

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
  const g = buildSite({ spec: { name: 'Lumen Bikes Help', avatar: { hue: 2, initials: 'LB' } }, files, questions, atomsByFile, store: { name: 'Lumen Bikes', url: 'https://lumen.example', brand: { color: '#ffd400', logo: 'https://lumen.example/icon.png' } } });

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
    assert.equal(fileLabel('site/x.example/faq/shipping-and-returns.md'), 'Shipping and returns');
    assert.equal(fileLabel('lumen-store-faq.txt', 'Lumen Bikes'), 'Store FAQ', 'the business name is not repeated on every chip');
  });
  test('brandOfHtml: theme-color and a square icon from the head, https only', () => {
    assert.deepEqual(brandOfHtml('<head><meta name="theme-color" content="#0F766E"><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/f.ico"></head>', 'https://shop.example/'),
      { color: '#0f766e', logo: 'https://shop.example/apple.png' });
    assert.equal(brandOfHtml('<meta name="theme-color" content="red"><link rel="icon" href="/favicon.ico">', 'https://shop.example/'), null, 'named colours and tiny icons are not used');
    assert.deepEqual(brandOfHtml('<link rel="icon" href="/logo.svg">', 'http://shop.example/'), null, 'http icons are not used');
  });
  test('owner edits: validated, 400 with the field name on junk', () => {
    const e = validateSiteEdit({ name: '  Lumen  Bikes ', tagline: 'Bikes for trails.', chips: ['Opening hours?', { label: 'Returns', q: 'How do returns work?' }], published: true });
    assert.deepEqual(e, { name: 'Lumen Bikes', tagline: 'Bikes for trails.', chips: [{ label: 'Opening hours?', q: 'Opening hours?' }, { label: 'Returns', q: 'How do returns work?' }], published: true });
    for (const [bad, field] of [[{ name: 'x'.repeat(61) }, 'name'], [{ chips: Array(9).fill('a') }, 'chips'], [{ published: 'yes' }, 'published'], [{ colour: 'red' }, 'colour'], [{ chips: [{ label: '' }] }, 'chips']]) {
      assert.throws(() => validateSiteEdit(bad), (err) => err.status === 400 && err.field === field, JSON.stringify(bad));
    }
    assert.deepEqual(validateSiteEdit({ name: null }, { name: 'Old' }), {}, 'null clears an edit (back to the generated value)');
  });
  test('download: one HTML file that loads the hosted script with the bot id, noindex while a trial', () => {
    const html = siteHtml(publicSite(g, { name: 'Lumen <Bikes>' }, { botId: 'tr_abcdefghijklmnop', trial: true }), { botId: 'tr_abcdefghijklmnop', apiBase: 'https://api.example' });
    assert.match(html, /<title>Lumen &lt;Bikes&gt; · Ask anything<\/title>/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /src="https:\/\/knowbot\.knowdrive\.ai\/site\/site\.js" data-bot="tr_abcdefghijklmnop" data-api="https:\/\/api\.example"/);
    assert.match(html, /How long do I have to return a bike\?/, 'popular questions in the markup');
    assert.doesNotMatch(siteHtml(publicSite(g, {}, { botId: 'acme', trial: false }), { botId: 'acme', apiBase: 'https://api.example' }), /noindex/);
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
  }, studio: { sweep: false, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  return { kd, kb, base, async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}
const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);

describe('Single-page site over HTTP', () => {
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
    const r = await site('POST', { name: 'Lumen Bikes Co', tagline: 'Bikes for trails and towns.', chips });
    assert.equal(r.status, 200);
    const v = await r.json();
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

  test('a question that is not in the files gets the refusal sentence, no sources', async () => {
    const pub = await (await fetch(`${S.base}/api/site/${t.trialId}`)).json();
    const r = await fetch(`${S.base}/api/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${pub.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What is the capital of Australia?' }) });
    const j = await r.json();
    assert.equal(j.refused, true);
    assert.deepEqual(j.citations, []);
  });

  test('download: the single HTML file, as an attachment', async () => {
    const r = await site('GET', null, '?download=1&api=https%3A%2F%2Fapi.example');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename="index\.html"/);
    const html = await r.text();
    assert.match(html, new RegExp(`data-bot="${t.trialId}" data-api="https://api.example"`));
    assert.match(html, /<title>Lumen Bikes Co · Ask anything<\/title>/);
    assert.match(html, /noindex/);
  });

  test('unpublish takes the public page down; the trial token is required for the owner routes', async () => {
    await site('POST', { published: false });
    assert.equal((await fetch(`${S.base}/api/site/${t.trialId}`)).status, 404);
    assert.equal((await fetch(`${S.base}/api/studio/trials/${t.trialId}/site`)).status, 401);
  });
});

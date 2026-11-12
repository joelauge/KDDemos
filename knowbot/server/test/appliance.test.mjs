// Appliance switches (KnowDrive Home & Office): the narrow web root and KNOWBOT_BUILTIN_BOT. Owner mode
// (KNOWBOT_MODE=owner) is tested with the Studio in trials.test.mjs. Fakes only: no real store, no model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation: nothing here may reach a real store
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = 'knowbot/_config/instances.json';

async function boot({ env = {}, root = ROOT, opts = {} } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-appliance-'));
  const kb = createKnowBotServer({ root, dataDir, quiet: true, watch: false, env: { LLM_BASE_URL: 'http://127.0.0.1:9/v1', ...env }, studio: { sweep: false }, ...opts });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  return { kb, base, get: (p, init) => fetch(base + p, init), async close() { await new Promise((r) => kb.server.close(() => r())); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}

// ------------------------------------------------------------------------------------------- reference crawler
const REF_RES = [
  /\b(?:src|href)\s*=\s*["']([^"']+)["']/g,                         // HTML attributes
  /\b(?:import|export)\b[^'"`;()]*?\bfrom\s*["'](\.{0,2}\/[^"']+)["']/g, // static imports / re-exports (bare specifiers are code samples)
  /\bimport\s*\(\s*["'](\.{0,2}\/[^"']+)["']\s*\)/g,                // dynamic import of a literal
  /\bimport\s+["'](\.{0,2}\/[^"']+)["']/g,                          // side-effect import
  /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,      // assets next to a module
  /url\(\s*["']?([^"')]+?)["']?\s*\)/g,                              // CSS url()
  /@import\s+["']([^"']+)["']/g,                                     // CSS @import
];
/** Same-origin references a page, module or stylesheet loads (literal ones; computed paths are listed by hand). */
function refsOf(body, pageUrl, origin) {
  const out = new Set();
  for (const re of REF_RES) {
    for (const m of body.matchAll(re)) {
      const ref = m[1].trim();
      if (!ref || ref.startsWith('#') || ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref) || /[{}$<>`\s]|\.\.\./.test(ref)) continue;
      const u = new URL(ref, pageUrl);
      if (u.origin !== origin) continue;
      if (/^\/(?:api|v1|p)\//.test(u.pathname)) continue; // server routes, not files
      out.add(u.pathname);
    }
  }
  return out;
}

/** Is there a file (or a directory with an index.html) at this URL path in the tree? */
function onDisk(p) {
  try { const st = statSync(path.join(ROOT, decodeURIComponent(p))); return st.isFile() || statSync(path.join(ROOT, decodeURIComponent(p), 'index.html')).isFile(); } catch { return false; }
}

async function crawl(S, starts) {
  const seen = new Map(); // pathname → status
  const corpusRefs = new Set();
  const queue = [...starts];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    if (p.startsWith('/corpus/')) { corpusRefs.add(p); continue; }
    const r = await S.get(p);
    seen.set(p, r.status);
    if (r.status !== 200) { await r.arrayBuffer(); continue; }
    const type = r.headers.get('content-type') || '';
    if (!/html|javascript|css/.test(type)) { await r.arrayBuffer(); continue; }
    for (const ref of refsOf(await r.text(), S.base + p, S.base)) if (!seen.has(ref)) queue.push(ref);
  }
  return { seen, corpusRefs };
}

const htmlIn = (dir) => readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.html')).map((f) => `/${dir}/${f}`);
const filesIn = (dir) => readdirSync(path.join(ROOT, dir), { recursive: true }).map(String).filter((f) => statSync(path.join(ROOT, dir, f)).isFile()).map((f) => `/${dir}/${f.split(path.sep).join('/')}`);
const PAGES = ['/', '/index.html', '/404.html', '/studio/', '/dashboard/', '/site/', '/demo/', ...htmlIn('demo')];
// never in the web root: the tree around the app, tests, server code, package files, dotfiles
const NEVER = ['/corpus/', '/corpus/MANIFEST.json', '/corpus/README.md', '/eval/', '/eval/REPORT.md', '/eval/benchmark.json', '/attendd/main.go', '/attendd/ENGINE_SHA',
  '/cloudflare/worker.js', '/cloudflare/Dockerfile', '/cloudflare/wrangler.jsonc', '/scripts/dev.sh', '/scripts/fetch-engine.sh', '/server/server.mjs', '/server/trials.mjs',
  '/server/test/fake-llm.mjs', '/package.json', '/package-lock.json', '/README.md', '/SPEC.md', '/CNAME', '/.env.example', '/.gitignore', '/.dockerignore', '/.nojekyll',
  '/.github/workflows/deploy-cloudflare.yml', '/.git/config', '/lib/test/core.test.mjs', '/studio/test/smoke.mjs', '/studio/kb/faq.md', '/lib/knowbot.js.orig', '/server/', '/scripts/'];

describe('web root (always on)', () => {
  let S;
  before(async () => { S = await boot(); });
  after(async () => { await S.close(); });

  test('every page, script, stylesheet and asset the app references answers 200', async () => {
    const { seen, corpusRefs } = await crawl(S, PAGES);
    const bad = [...seen].filter(([p, st]) => st !== 200 && onDisk(p));
    assert.deepEqual(bad, [], `references that do not load: ${JSON.stringify(bad)}`);
    // links to files that are not in this tree at all (demo/index.html points at the parent site's icons): 404 before and after
    assert.deepEqual([...seen].filter(([p, st]) => st !== 200 && !onDisk(p)).map(([p]) => p).sort(), ['/favicon.svg', '/logo.svg']);
    assert.ok(seen.size > 60, `crawled ${seen.size} paths`);
    for (const p of ['/lib/knowbot.js', '/lib/widget.js', '/lib/knowbot.css', '/studio/app.js', '/dashboard/dashboard.js', '/site/overlay.js', '/demo/demo.js']) assert.equal(seen.get(p), 200, p);
    assert.ok([...seen.keys()].some((p) => p.startsWith('/vendor/')), 'vendored libraries load');
    // the one reference outside the web root: the browser-only demo's in-browser index (KNOWBOT_SERVE_CORPUS)
    assert.deepEqual([...corpusRefs], ['/corpus/']);
  });

  test('computed references load too: the widget, embed and overlay entry points and the Studio sample files', async () => {
    for (const p of ['/lib/embed.js', '/lib/voice-widget.js', '/site/overlay.js', '/site/index.html', '/vendor/kd-theme/tokens.css', ...filesIn('studio/samples')]) {
      const r = await S.get(p);
      assert.equal(r.status, 200, p);
      await r.arrayBuffer();
    }
  });

  test('the rest of the tree answers 404', async () => {
    for (const p of NEVER) {
      const r = await S.get(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(await r.text(), /ENGINE|knowDrive corpus|"dependencies"|FROM node/, p);
    }
  });

  test('corpus/ is served only with KNOWBOT_SERVE_CORPUS, and never without the built-in bot', async () => {
    const on = await boot({ env: { KNOWBOT_SERVE_CORPUS: '1' } });
    const offBot = await boot({ env: { KNOWBOT_SERVE_CORPUS: '1', KNOWBOT_BUILTIN_BOT: 'off' } });
    try {
      const m = await on.get('/corpus/MANIFEST.json');
      assert.equal(m.status, 200);
      const [first] = await m.json();
      assert.equal((await on.get(`/corpus/${first.path}`)).status, 200);
      assert.equal((await on.get('/eval/REPORT.md')).status, 404, 'only corpus/ is added');
      assert.equal((await offBot.get('/corpus/MANIFEST.json')).status, 404);
    } finally { await on.close(); await offBot.close(); }
  });
});

describe('built-in bot switch (KNOWBOT_BUILTIN_BOT)', () => {
  test('default: The Ultimate Game Master answers from corpus/, demo/ is served', async () => {
    const S = await boot();
    try {
      await S.kb.registry.ready;
      const g = await (await S.get('/api/graph')).json();
      assert.deepEqual(g.bots.map((b) => b.id), ['ugm']);
      assert.deepEqual(g.buckets.map((b) => b.id), ['ugm']);
      assert.deepEqual(g.flows.map((f) => f.id), ['demo']);
      const c = await (await S.get('/api/config')).json();
      assert.equal(c.instance.id, 'ugm');
      await S.kb.ready;
      assert.ok(S.kb.local.fileCount > 50, 'corpus/ is indexed');
      assert.equal((await S.get('/demo/')).status, 200);
      const r = await S.get('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'return policy' }) });
      assert.equal(r.status, 200);
      assert.ok((await r.json()).results.length > 0);
    } finally { await S.close(); }
  });

  test('off: starts and works with no corpus/ and no demo/ in the tree, and offers no built-in bot', async () => {
    // the box package: the app's directories only
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-boxroot-'));
    for (const d of ['lib', 'studio', 'dashboard', 'site', 'vendor', 'index.html', '404.html']) await fsp.symlink(path.join(ROOT, d), path.join(root, d));
    const S = await boot({ root, env: { KNOWBOT_BUILTIN_BOT: 'off' } });
    try {
      await S.kb.registry.ready; await S.kb.ready;
      const h = await (await S.get('/healthz')).json();
      assert.equal(h.ok, true);
      assert.equal(h.files, 0, 'nothing indexed');
      const g = await (await S.get('/api/graph')).json();
      assert.deepEqual([g.bots, g.buckets], [[], []]);
      assert.deepEqual(g.flows.map((f) => [f.id, f.name, f.bots, f.buckets]), [['demo', 'All bots & buckets', 0, 0]], 'one neutral starting flow, as the dashboard expects');
      const c = await S.get('/api/config');
      assert.equal(c.status, 200, 'the config still loads (pages read it at start-up)');
      assert.equal((await c.json()).instance, undefined, 'with no instance in it');
      for (const p of ['/api/search', '/api/canonical']) {
        const r = await S.get(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'return policy', question: 'return policy' }) });
        assert.equal(r.status, 404, p);
        assert.match((await r.json()).error.message, /no built-in bot/);
      }
      assert.equal((await S.get('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x', instance: 'ugm' }) })).status, 404);
      assert.equal((await S.get('/demo/')).status, 404);
      assert.equal((await S.get('/corpus/MANIFEST.json')).status, 404);
      for (const p of ['/', '/studio/', '/dashboard/', '/site/', '/lib/knowbot.js']) assert.equal((await S.get(p)).status, 200, p);
      const home = await S.get('/', { redirect: 'manual' });
      assert.equal(home.status, 302, 'the root opens the Studio, not the demos');
      assert.equal(home.headers.get('location'), './studio/');
      // the dashboard's own requests
      assert.equal((await S.get('/api/instances')).status, 200);
      assert.equal((await S.get('/api/buckets')).status, 200);
    } finally { await S.close(); await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('off, with a store: bots the owner creates answer; the stored built-in settings are kept as they were', async () => {
    const kd = await startFakeKnowDrive();
    const llm = await startFakeLLM({ slowMs: 9000 });
    const stored = { v: 2, buckets: [], bots: [{ id: 'old-bot', name: 'Old Bot', flow: 'demo', buckets: [], createdAt: 1, updatedAt: 1 }], builtinBot: { buckets: [{ id: 'ugm', enabled: true }], settings: { greeting: 'Kept as it was' } }, flows: [] };
    kd.add({ path: REGISTRY_PATH, text: JSON.stringify(stored), tags: ['knowbot', 'kind:config'], mime: 'application/json' });
    const S = await boot({ env: { KNOWBOT_BUILTIN_BOT: 'off', KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_STORE: 'vs_fake', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_ANSWER_MODE: 'generate' } });
    const json = { 'content-type': 'application/json' };
    try {
      await S.kb.registry.ready;
      assert.equal(S.kb.mode, 'knowdrive');
      const g0 = await (await S.get('/api/graph')).json();
      assert.deepEqual(g0.bots.map((x) => [x.id, x.flow]), [['old-bot', 'demo']], 'a bot from the demo flow stays in it');
      assert.deepEqual(g0.flows.map((f) => [f.id, f.bots]), [['demo', 1]]);
      const b = await S.get('/api/buckets', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Office Handbook' }) });
      assert.equal(b.status, 201);
      const bucket = await b.json();
      assert.equal((await S.get('/api/instances', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Office Bot', buckets: [{ id: 'ugm' }] }) })).status, 400, 'there is no built-in bucket to link');
      const bot = await (await S.get('/api/instances', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Office Bot', buckets: [{ id: bucket.id }] }) })).json();
      kd.add({ path: 'knowbot/office-handbook/leave.md', text: '# Leave\n\nStaff get 25 days of paid leave a year, booked through the office manager.', tags: ['knowbot', bucket.tag] });
      const g = await (await S.get('/api/graph')).json();
      assert.deepEqual(g.bots.map((x) => x.id).sort(), [bot.id, 'old-bot'].sort());
      assert.equal(g.bots.find((x) => x.id === bot.id).flow, bucket.flow, 'a new bot joins its bucket\'s flow, never the demo flow');
      // the dashboard creates buckets and bots in the flow it has open: flow 'demo' on a fresh server
      const x = await S.get('/api/buckets', { method: 'POST', headers: json, body: JSON.stringify({ name: 'X', flow: 'demo' }) });
      assert.equal(x.status, 201, 'the demo flow is a flow like any other');
      const xb = await S.get('/api/instances', { method: 'POST', headers: json, body: JSON.stringify({ name: 'X Bot', flow: 'demo', buckets: [{ id: (await x.json()).id }] }) });
      assert.equal(xb.status, 201);
      assert.equal((await S.get('/api/instances/old-bot', { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'Old Helper', flow: 'demo' }) })).status, 200);
      const ugmish = await (await S.get('/api/instances', { method: 'POST', headers: json, body: JSON.stringify({ name: 'ugm', flow: 'demo' }) })).json();
      assert.notEqual(ugmish.id, 'ugm', 'the configured built-in id stays free');
      const a = await S.get('/api/search', { method: 'POST', headers: json, body: JSON.stringify({ query: 'How many days of paid leave do staff get?', instance: bot.id }) });
      assert.equal(a.status, 200);
      const hits = (await a.json()).results;
      assert.ok(hits.some((x) => /leave\.md$/.test(x.filename) && /25 days/.test(x.text)), JSON.stringify(hits));
      const ans = await S.get('/api/canonical', { method: 'POST', headers: json, body: JSON.stringify({ question: 'How many days of paid leave do staff get?', instance: bot.id }) });
      assert.equal(ans.status, 200, 'the bot answers (or refuses) through the model');
      const saved = JSON.parse([...kd.files.values()].find((f) => f.filename === REGISTRY_PATH).text);
      assert.deepEqual(saved.builtinBot, stored.builtinBot, 'turning the built-in bot off never rewrites its stored settings');
      assert.deepEqual(saved.bots.filter((x) => [bot.id, 'old-bot'].includes(x.id)).map((x) => [x.id, x.flow]).sort(), [[bot.id, bot.flow], ['old-bot', 'demo']].sort());
    } finally { await S.close(); await kd.close(); await llm.close(); }
  });

  test('off, with a store: start-up leaves the built-in bot\'s bot:<id> tags in the store alone, and still syncs the others', async () => {
    const kd = await startFakeKnowDrive();
    const botTagged = { 'ugm>ugm': 'knowbot:ugm', 'ugm>faq': 'bucket:faq', 'faq-bot>faq': 'bucket:faq', 'gone-bot>faq': 'bucket:faq' };
    const stored = { v: 2, buckets: [{ id: 'faq', name: 'FAQ', tag: 'bucket:faq', root: 'knowbot/faq/', flow: 'demo' }],
      bots: [{ id: 'faq-bot', name: 'FAQ Bot', flow: 'demo', buckets: [{ id: 'faq', enabled: true }] }],
      builtinBot: { buckets: [{ id: 'ugm', enabled: true }, { id: 'faq', enabled: true }] }, migrated: { ugm: 1, faq: 1 }, botTagged, flows: [] };
    kd.add({ path: REGISTRY_PATH, text: JSON.stringify(stored), tags: ['knowbot', 'kind:config'], mime: 'application/json' });
    const ugmFile = kd.add({ path: 'knowbot/ugm/rules.md', text: '# Rules', tags: ['knowbot', 'knowbot:ugm', 'bot:ugm'] });
    const faqFile = kd.add({ path: 'knowbot/faq/hours.md', text: '# Hours', tags: ['knowbot', 'bucket:faq', 'bot:ugm', 'bot:faq-bot', 'bot:gone-bot'] });
    const S = await boot({ env: { KNOWBOT_BUILTIN_BOT: 'off', KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_STORE: 'vs_fake' } });
    try {
      await S.kb.registry.ready; await S.kb.registry.migration; await S.kb.registry.botTagging;
      assert.deepEqual(kd.files.get(ugmFile.id).tags, ['knowbot', 'knowbot:ugm', 'bot:ugm'], 'the built-in bucket keeps bot:ugm');
      assert.deepEqual([...kd.files.get(faqFile.id).tags].sort(), ['bot:faq-bot', 'bot:ugm', 'bucket:faq', 'knowbot'], 'bot:ugm stays; a deleted bot\'s tag still goes');
      const saved = JSON.parse([...kd.files.values()].find((f) => f.filename === REGISTRY_PATH).text);
      assert.deepEqual(saved.botTagged, { 'ugm>ugm': 'knowbot:ugm', 'ugm>faq': 'bucket:faq', 'faq-bot>faq': 'bucket:faq' });
    } finally { await S.close(); await kd.close(); }
  });
});

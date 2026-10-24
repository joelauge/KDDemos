// node --test knowbot/server/test/server.test.mjs
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { LocalRetriever, KnowDriveRetriever, chunkMarkdown, tokenize, parseFrontmatter } from '../retrievers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIB = process.env.KNOWBOT_LIB || path.join(ROOT, 'lib', 'knowbot.js');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => srv.close(() => r()));

// ---------------------------------------------------------------- fixtures

const CORPUS = {
  'policies/refund-policy.md': `---
title: Refund policy
kind: policy
source: shopify
url: https://example.test/policies/refund-policy
updated: 2026-10-24
---
# Refund policy

We have a 30-day return policy, which means you have 30 days after receiving your item to request a return.

To be eligible for a return, your item must be in the same condition that you received it, unworn or unused, with tags, and in its original packaging.

## Damages and issues

Please inspect your order upon reception and contact us immediately if the item is defective, damaged or if you receive the wrong item.
`,
  'catalog/products/dragon-dice.md': `---
title: "Dragon Dice Set"
kind: product
source: shopify
source_id: gid://shopify/Product/1
url: https://example.test/products/dragon-dice
---
# Dragon Dice Set

A seven-piece polyhedral dice set with dragon engravings, for tabletop role-playing games. Price: $24.99.
`,
  'pages/contact.md': `---
title: Contact us
kind: page
---
Email support for help with orders and shipping questions.
`,
};

async function makeCorpus() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-corpus-'));
  for (const [rel, body] of Object.entries(CORPUS)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

function fakeLLM() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake"}]}'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      calls.push(j);
      const content = 'You can return items within 30 days of receiving them [1]. Items must be unused [1]. Nonsense [9].';
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of ['You can ', 'return ', 'items [1].']) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
  });
  return { srv, calls };
}

function fakeKnowDrive({ fail = false, data = null } = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      if (fail) { res.writeHead(500); return res.end('boom'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'vector_store.search_results.page',
        data: data || [
          { file_id: 'file_a', filename: 'knowbot/ugm/policies/refund-policy.md', score: 0.91, content: [{ type: 'text', text: '30-day return policy.' }], attributes: {} },
          { file_id: 'file_x', filename: 'other-team/secret.md', score: 0.95, content: [{ type: 'text', text: 'not ours' }], attributes: { title: 'Secret' } },
          { file_id: 'file_b', filename: '/knowbot/ugm/catalog/products/dragon-dice.md', score: 0.5, content: [{ type: 'text', text: 'Dragon dice' }], attributes: { title: 'Dragon Dice (KD)' } },
        ],
      }));
    });
  });
  return { srv, calls };
}

async function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

/** Read SSE events from /api/stream until `n` knowbot events arrive. */
function sseCollect(port, n, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^event: knowbot/m.test(block)) {
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            events.push(JSON.parse(data));
            if (events.length >= n) { req.destroy(); resolve(events); }
          }
        }
      });
    });
    req.on('error', (e) => { if (events.length < n) reject(e); });
    setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs).unref();
  });
}

// ---------------------------------------------------------------- unit: retrievers

describe('retrievers (unit)', () => {
  test('frontmatter + tokenizer + chunker', () => {
    const { meta, body } = parseFrontmatter(CORPUS['catalog/products/dragon-dice.md']);
    assert.equal(meta.title, 'Dragon Dice Set');
    assert.equal(meta.source_id, 'gid://shopify/Product/1');
    assert.match(body, /seven-piece/);
    assert.deepEqual(tokenize('Shipping the shipped ships'), ['ship', 'ship', 'ship']);
    assert.deepEqual(tokenize('What is your return policy?'), ['return', 'policy']);
    const long = Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n` + 'word '.repeat(60)).join('\n\n');
    const chunks = chunkMarkdown(long);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(c.text.split(/\s+/).length <= 420, 'chunk within ~350 words');
  });

  test('LocalRetriever BM25: ranking, title prefix, dedupe ≤2 per file', async () => {
    const dir = await makeCorpus();
    const r = new LocalRetriever({ corpusDir: dir, watch: false });
    const { source, results } = await r.search('What is your return policy?', 6);
    assert.equal(source, 'local');
    assert.equal(results[0].filename, 'policies/refund-policy.md');
    assert.equal(results[0].file_id, 'local:policies/refund-policy.md');
    assert.equal(results[0].title, 'Refund policy');
    assert.equal(results[0].url, 'https://example.test/policies/refund-policy');
    assert.ok(results[0].text.startsWith('Refund policy'));
    assert.ok(results[0].score > 0 && results[0].score < 1);
    const per = {};
    for (const x of results) per[x.filename] = (per[x.filename] || 0) + 1;
    assert.ok(Object.values(per).every((n) => n <= 2));
    const none = await r.search('quantum chromodynamics', 6);
    assert.equal(none.results.length, 0);
  });

  test('KnowDriveRetriever: tag filter, prefix strip, out-of-prefix hits dropped, local url/title fill', async () => {
    const dir = await makeCorpus();
    const local = new LocalRetriever({ corpusDir: dir, watch: false });
    await local.ready;
    const kd = fakeKnowDrive();
    const port = await listen(kd.srv);
    try {
      const r = new KnowDriveRetriever({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', store: 'vs_test', tag: 'knowbot:ugm', prefix: 'knowbot/ugm/', local });
      const out = await r.search('return policy', 5);
      assert.equal(out.source, 'knowdrive');
      assert.equal(kd.calls.length, 1);
      const call = kd.calls[0];
      assert.equal(call.url, '/api/v1/vector_stores/vs_test/search');
      assert.equal(call.auth, 'Bearer sk-test');
      assert.deepEqual(call.body, { query: 'return policy', max_num_results: 5, mode: 'hybrid', text: 'raw', filter: { all_of: ['knowbot:ugm', 'dir:knowbot', 'dir:ugm'] } });
      assert.deepEqual(out.results.map((x) => x.filename), ['policies/refund-policy.md', 'catalog/products/dragon-dice.md']);
      assert.ok(!out.results.some((x) => x.file_id === 'file_x'));
      // title/url looked up from local frontmatter when attributes lack them
      assert.equal(out.results[0].title, 'Refund policy');
      assert.equal(out.results[0].url, 'https://example.test/policies/refund-policy');
      assert.equal(out.results[1].title, 'Dragon Dice (KD)');
      assert.equal(out.results[1].url, 'https://example.test/products/dragon-dice');
    } finally { await close(kd.srv); }
  });

  test('KnowDriveRetriever: relevance floor refuses weak matches; canonical cards above the floor come first', async () => {
    const local = new LocalRetriever({ corpusDir: await makeCorpus(), watch: false });
    const hit = (filename, score) => ({ file_id: `f_${filename}`, filename, score, content: [{ type: 'text', text: `about ${filename}` }], attributes: {} });
    let vectorTop = 0.86;
    const calls = [];
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
        const body = JSON.parse(b); calls.push(body);
        const data = body.mode === 'vector'
          ? [hit('canonical/returns.md', vectorTop), hit('policies/refund-policy.md', vectorTop - 0.05)]
          : [hit('policies/refund-policy.md', 0.033), hit('catalog/products/dragon-dice.md', 0.031)];
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data }));
      });
    });
    const port = await listen(srv);
    try {
      const r = new KnowDriveRetriever({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', store: 's', local, minSimilarity: 0.745 });
      const on = await r.search('how do returns work', 4);
      assert.deepEqual(calls.map((c) => c.mode).sort(), ['hybrid', 'vector']);
      assert.ok(calls.every((c) => c.filter?.all_of?.[0] === 'knowbot:ugm'), 'both queries stay in the tag window');
      assert.deepEqual(on.results.map((x) => x.filename), ['canonical/returns.md', 'policies/refund-policy.md', 'catalog/products/dragon-dice.md']);
      vectorTop = 0.70;
      const off = await r.search('weather this weekend', 4);
      assert.equal(off.results.length, 0, 'below the floor => no sources => refusal');
      assert.equal(off.floor.top, 0.70);
      vectorTop = 0.76; // above the floor but below floor + canonical margin: card not promoted
      const mid = await r.search('returns', 4);
      assert.equal(mid.results[0].filename, 'policies/refund-policy.md');
    } finally { await close(srv); }
  });

  test('KnowDriveRetriever falls back to local on failure', async () => {
    const dir = await makeCorpus();
    const local = new LocalRetriever({ corpusDir: dir, watch: false });
    const kd = fakeKnowDrive({ fail: true });
    const port = await listen(kd.srv);
    try {
      const r = new KnowDriveRetriever({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', store: 's', local });
      const out = await r.search('return policy', 3);
      assert.equal(out.source, 'local-fallback');
      assert.equal(out.results[0].filename, 'policies/refund-policy.md');
    } finally { await close(kd.srv); }
  });
});

// ---------------------------------------------------------------- integration: HTTP server

describe('server (HTTP)', () => {
  let kb, port, llm, llmPort, dataDir, corpusDir;

  before(async () => {
    corpusDir = await makeCorpus();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-data-'));
    llm = fakeLLM();
    llmPort = await listen(llm.srv);
    kb = createKnowBotServer({
      root: ROOT, corpusDir, dataDir, libPath: LIB, quiet: true, watch: false, rateLimit: 1000,
      env: { LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, LLM_MODEL: 'fake-model', KNOWBOT_ANSWER_MODE: 'generate' },
    });
    await kb.ready;
    port = await listen(kb.server);
  });

  after(async () => { await close(kb.server); await close(llm.srv); });

  const api = (p, body, method = body === undefined ? 'GET' : 'POST') =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });

  test('GET /api/config + /healthz', async () => {
    const c = await (await api('/api/config')).json();
    assert.equal(c.retrieval, 'local');
    assert.deepEqual(c.engine, { type: 'openai', model: 'fake-model' });
    assert.deepEqual(c.canonical, { temperature: 0, top_p: 1, max_tokens: 300, seed: 7, frequency_penalty: 0.4 });
    const h = await (await api('/healthz')).json();
    assert.equal(h.ok, true); assert.equal(h.llm, true); assert.equal(h.retrieval, 'local');
  });

  test('CORS + OPTIONS preflight', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/search`, { method: 'OPTIONS', headers: { origin: 'https://x.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-methods'), /POST/);
  });

  test('POST /api/search', async () => {
    const r = await api('/api/search', { query: 'What is your return policy?', k: 3 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.source, 'local');
    assert.ok(j.results.length >= 1 && j.results.length <= 3);
    const top = j.results[0];
    for (const k of ['file_id', 'filename', 'title', 'url', 'score', 'text']) assert.ok(k in top, `result has ${k}`);
    assert.equal(top.filename, 'policies/refund-policy.md');
    const bad = await api('/api/search', {});
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).error.message);
  });

  test('body limit 256KB → 413, invalid JSON → 400', async () => {
    const big = await api('/api/events', { type: 'feedback', text: 'x'.repeat(300 * 1024) });
    assert.equal(big.status, 413);
    const inv = await fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(inv.status, 400);
  });

  test('events → SSE fan-out (+replay), persisted to events.jsonl, sessions aggregation', async () => {
    const surface = { kind: 'widget', device: 'mobile', host: 'shop.test', path: '/', referrer: '', embedded: false, channel: 'web', lang: 'en', ua: 'test' };
    const live = sseCollect(port, 4);
    await new Promise((r) => setTimeout(r, 100));
    const r = await api('/api/events', [
      { v: 1, type: 'session.start', ts: 1000, sessionId: 's1', surface },
      { v: 1, type: 'message.user', ts: 1100, sessionId: 's1', turnId: 's1.1', surface, text: 'hi' },
      { v: 1, type: 'message.bot', ts: 1200, sessionId: 's1', turnId: 's1.1', surface, text: 'hello [1]', grounded: true },
    ]);
    assert.deepEqual(await r.json(), { ok: true, count: 3 });
    await api('/api/events', { v: 1, type: 'message.bot', ts: 1300, sessionId: 's1', turnId: 's1.2', surface, grounded: false });
    const got = await live;
    assert.deepEqual(got.map((e) => e.type), ['session.start', 'message.user', 'message.bot', 'message.bot']);

    // a late subscriber gets the replay buffer
    const replayed = await sseCollect(port, 4);
    assert.equal(replayed.length, 4);
    assert.equal(replayed[0].sessionId, 's1');

    const bad = await api('/api/events', { type: 'nope' });
    assert.equal(bad.status, 400);

    const sessions = await (await api('/api/sessions')).json();
    const s1 = sessions.find((s) => s.sessionId === 's1');
    assert.deepEqual(s1, { sessionId: 's1', surface, startedAt: 1000, lastAt: 1300, turns: 1, groundedRate: 0.5 });

    await kb.flush();
    const lines = (await fsp.readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[0]).type, 'session.start');
  });

  test('POST /api/chat passthrough (JSON + streaming)', async () => {
    const r = await api('/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.choices[0].message.content, /30 days/);
    assert.equal(llm.calls.at(-1).model, 'fake-model');
    const s = await api('/api/chat', { stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.match(s.headers.get('content-type'), /event-stream/);
    const txt = await s.text();
    assert.match(txt, /data: \[DONE\]/);
    assert.equal((txt.match(/^data: /gm) || []).length, 4);
  });

  test('POST /api/canonical → Answer with citations, emits canonical event', { skip: !existsSync(LIB) && 'lib/knowbot.js not present' }, async () => {
    const live = sseCollect(port, 5, 4000); // 4 replayed + canonical
    await new Promise((r) => setTimeout(r, 100));
    const r = await api('/api/canonical', { question: 'What is your return policy?', sessionId: 's1', turnId: 's1.2' });
    assert.equal(r.status, 200);
    const a = await r.json();
    assert.equal(a.grounded, true);
    assert.equal(a.refused, false);
    assert.ok(a.citations.length >= 1);
    assert.equal(a.citations[0].n, 1);
    assert.equal(a.citations[0].filename, 'policies/refund-policy.md');
    assert.ok(!/\[9\]/.test(a.text), 'invalid marker stripped');
    assert.match(a.text, /\[1\]/);
    assert.equal(a.sessionId, 's1'); assert.equal(a.turnId, 's1.2');
    assert.deepEqual(a.engine, { type: 'openai', model: 'fake-model' });
    for (const k of ['retrieval', 'generation', 'total']) assert.equal(typeof a.latencyMs[k], 'number');
    assert.equal(a.surface.kind, 'api');
    // canonical LLM settings
    const call = llm.calls.at(-1);
    assert.equal(call.temperature, 0); assert.equal(call.top_p, 1); assert.equal(call.max_tokens, 300); assert.equal(call.seed, 7);
    assert.equal(call.messages[0].role, 'system');
    const evs = await live;
    const ce = evs.find((e) => e.type === 'canonical');
    assert.ok(ce, 'canonical event on SSE');
    assert.equal(ce.question, 'What is your return policy?');
    assert.equal(ce.retrieval.source, 'local');
  });

  test('POST /api/canonical refuses without LLM call when nothing relevant', { skip: !existsSync(LIB) && 'lib/knowbot.js not present' }, async () => {
    const before = llm.calls.length;
    const a = await (await api('/api/canonical', { question: 'quantum chromodynamics lattice' })).json();
    assert.equal(a.refused, true);
    assert.equal(a.grounded, false);
    assert.deepEqual(a.citations, []);
    assert.equal(llm.calls.length, before);
  });

  test('static serving + MIME types', async () => {
    const r = await api('/SPEC.md');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/markdown/);
    const js = await api('/server/retrievers.mjs');
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    const missing = await api('/nope.html');
    assert.equal(missing.status, 404);
    const unknownApi = await api('/api/nope');
    assert.equal(unknownApi.status, 404);
  });

  test('path traversal blocked', async () => {
    for (const p of ['/../../../../etc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/lib/..%2f..%2f..%2fetc%2fpasswd', '/..%5c..%5cetc%5cpasswd', '/%00', '/server/data/events.jsonl', '/.git/config']) {
      const r = await rawGet(port, p);
      assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!/root:/.test(r.body), `${p} leaked`);
    }
  });

  test('rate limit on /api/chat', async () => {
    const kb2 = createKnowBotServer({ root: ROOT, corpusDir, dataDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-data-')), libPath: LIB, quiet: true, watch: false, rateLimit: 2,
      env: { LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1` } });
    const p2 = await listen(kb2.server);
    try {
      // a spoofed X-Forwarded-For per request must not mint a fresh rate-limit bucket (red-team)
      const go = (i) => fetch(`http://127.0.0.1:${p2}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
      const codes = [];
      for (let i = 0; i < 3; i++) { const r = await go(i); codes.push(r.status); await r.text(); }
      assert.deepEqual(codes, [200, 200, 429]);
    } finally { await close(kb2.server); }
  });

  test('server in knowdrive mode (defaults: production store, knowbot/ugm/ prefix) sends tag filter', async () => {
    const kd = fakeKnowDrive({ data: [
      { file_id: 'file_a', filename: 'knowbot/ugm/policies/refund-policy.md', score: 0.9, content: [{ type: 'text', text: '30-day returns' }], attributes: {} },
      { file_id: 'file_b', filename: 'knowbot/ugm/catalog/products/dragon-dice.md', score: 0.4, content: [{ type: 'text', text: 'dice' }], attributes: {} },
    ] });
    const kdPort = await listen(kd.srv);
    const kb3 = createKnowBotServer({ root: ROOT, corpusDir, dataDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-data-')), libPath: LIB, quiet: true, watch: false,
      env: { LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, KNOWDRIVE_BASE_URL: `http://127.0.0.1:${kdPort}`, KNOWDRIVE_API_KEY: 'k' } });
    const p3 = await listen(kb3.server);
    try {
      const c = await (await fetch(`http://127.0.0.1:${p3}/api/config`)).json();
      assert.equal(c.retrieval, 'knowdrive');
      assert.equal(c.store, 'vs_97c857474b1f4e8892b134c283cf9849');
      const j = await (await fetch(`http://127.0.0.1:${p3}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'returns' }) })).json();
      assert.equal(j.source, 'knowdrive');
      assert.deepEqual(kd.calls[0].body, { query: 'returns', max_num_results: 6, mode: 'hybrid', text: 'raw', filter: { all_of: ['knowbot:ugm', 'dir:knowbot', 'dir:ugm'] } });
      assert.equal(kd.calls[0].url, '/api/v1/vector_stores/vs_97c857474b1f4e8892b134c283cf9849/search');
      assert.deepEqual(j.results.map((x) => x.filename), ['policies/refund-policy.md', 'catalog/products/dragon-dice.md']);
      assert.equal(j.results[0].url, 'https://example.test/policies/refund-policy');
    } finally { await close(kb3.server); await close(kd.srv); }
  });

  test('server in knowdrive mode with KNOWDRIVE_PREFIX strips prefix and drops foreign hits', async () => {
    const kd = fakeKnowDrive();
    const kdPort = await listen(kd.srv);
    const kb4 = createKnowBotServer({ root: ROOT, corpusDir, dataDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-data-')), libPath: LIB, quiet: true, watch: false,
      env: { LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, KNOWDRIVE_BASE_URL: `http://127.0.0.1:${kdPort}`, KNOWDRIVE_API_KEY: 'k',
        KNOWDRIVE_STORE: 'vs_shared', KNOWDRIVE_PREFIX: 'knowbot/ugm/', KNOWDRIVE_TAG: 'knowbot:ugm' } });
    const p4 = await listen(kb4.server);
    try {
      const j = await (await fetch(`http://127.0.0.1:${p4}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'returns', k: 3 }) })).json();
      assert.equal(kd.calls[0].url, '/api/v1/vector_stores/vs_shared/search');
      assert.deepEqual(kd.calls[0].body.filter, { all_of: ['knowbot:ugm', 'dir:knowbot', 'dir:ugm'] }, 'prefix enforced in the search via folder tags');
      assert.deepEqual(j.results.map((x) => x.filename), ['policies/refund-policy.md', 'catalog/products/dragon-dice.md']);
    } finally { await close(kb4.server); await close(kd.srv); }
  });

  // ------------------------------------------------------------ red-team regressions

  test('red-team: /api/chat is not an open relay — fields allow-listed, model forced, output capped', async () => {
    const r = await api('/api/chat', { model: 'gpt-4', messages: [{ role: 'user', content: 'hi', name: 'x' }], max_tokens: 100000, n: 8,
      grammar: 'root ::= "x"', n_predict: -1, id_slot: 0, temperature: 0.2, seed: 7 });
    assert.equal(r.status, 200); await r.text();
    const c = llm.calls.at(-1);
    assert.deepEqual(Object.keys(c).sort(), ['max_tokens', 'messages', 'model', 'seed', 'stream', 'temperature']);
    assert.equal(c.model, 'fake-model');
    assert.equal(c.max_tokens, 1024);
    assert.deepEqual(c.messages, [{ role: 'user', content: 'hi' }]);
    for (const bad of [{ messages: [] }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'user', content: { x: 1 } }] },
      { messages: Array.from({ length: 17 }, () => ({ role: 'user', content: 'x' })) }]) {
      const b = await api('/api/chat', bad); assert.equal(b.status, 400, JSON.stringify(bad).slice(0, 60)); await b.text();
    }
    const huge = await api('/api/chat', { messages: [{ role: 'user', content: 'x'.repeat(30000) }] });
    assert.equal(huge.status, 413); await huge.text();
  });

  test('red-team: clients cannot forge server-only canonical events; oversized events rejected', async () => {
    const forged = await api('/api/events', { type: 'canonical', sessionId: 's1', turnId: 's1.1', text: 'Fake canonical [1]', grounded: true });
    assert.equal(forged.status, 403);
    const fat = await api('/api/events', { type: 'message.bot', sessionId: 's1', text: 'x'.repeat(40 * 1024) });
    assert.equal(fat.status, 413);
    const ok = await api('/api/events', { type: 'feedback', sessionId: 's1', rating: 'up' });
    assert.equal(ok.status, 200);
  });

  test('red-team: event flooding is rate limited, disk use bounded by rotation, SSE subscribers capped', async () => {
    const dd = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-data-'));
    const kb5 = createKnowBotServer({ root: ROOT, corpusDir, dataDir: dd, libPath: LIB, quiet: true, watch: false, eventsRateLimit: 3, eventsMaxBytes: 300, maxSse: 1,
      env: { LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1` } });
    const p5 = await listen(kb5.server);
    try {
      const post = (i) => fetch(`http://127.0.0.1:${p5}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `1.2.3.${i}` },
        body: JSON.stringify({ type: 'message.user', sessionId: `flood${i}`, text: 'y'.repeat(120) }) });
      const codes = [];
      for (let i = 0; i < 4; i++) { const r = await post(i); codes.push(r.status); await r.text(); }
      assert.deepEqual(codes, [200, 200, 200, 429]);
      await kb5.flush();
      const cur = (await fsp.stat(path.join(dd, 'events.jsonl'))).size;
      assert.ok(cur <= 300, `events.jsonl ${cur} bytes not rotated`);
      assert.ok(existsSync(path.join(dd, 'events.jsonl.1')));
      const first = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: p5, path: '/api/stream' }, resolve));
      const second = await fetch(`http://127.0.0.1:${p5}/api/stream`);
      assert.equal(second.status, 503); await second.text();
      first.destroy();
    } finally { await close(kb5.server); }
  });

  test('red-team: optional operator token gates the live conversation feed', async () => {
    const kb6 = createKnowBotServer({ root: ROOT, corpusDir, dataDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-data-')), libPath: LIB, quiet: true, watch: false,
      dashboardToken: 'sekret', env: { LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1` } });
    const p6 = await listen(kb6.server);
    try {
      const u = (q) => `http://127.0.0.1:${p6}${q}`;
      for (const q of ['/api/sessions', '/api/events', '/api/stream', '/api/sessions?token=wrong']) {
        const r = await fetch(u(q)); assert.equal(r.status, 401, q); await r.text();
      }
      const ok = await fetch(u('/api/sessions?token=sekret')); assert.equal(ok.status, 200); await ok.text();
      const okH = await fetch(u('/api/events'), { headers: { authorization: 'Bearer sekret' } }); assert.equal(okH.status, 200); await okH.text();
      const cfg = await fetch(u('/api/config')); assert.equal(cfg.status, 200); assert.ok(!(await cfg.text()).includes('sekret'));
    } finally { await close(kb6.server); }
  });
});

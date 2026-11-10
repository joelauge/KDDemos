// The evidence selector (server/evidence.mjs, KNOWBOT_EVIDENCE=attend): a fake attendd picks the passages; the answer
// quotes only from them, refuses with no model call when it finds nothing, and falls back to search when it is down.
// Fakes only: never touches knowDrive, attendd or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { createEvidenceSelector, mergeBundles, scopesFromRetriever, hashFor } from '../evidence.mjs';
import * as lib from '../../lib/knowbot.js';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 40;
const nextIp = () => `198.51.100.${ipSeq++ % 250}`;

function parseSSE(text) {
  return text.split('\n\n').map((fr) => {
    const ev = /^event: (.*)$/m.exec(fr)?.[1];
    return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null;
  }).filter(Boolean);
}

/**
 * A fake attendd over the fake knowDrive's files. respond(body, kdFiles) → bundle (default: atoms of the files that
 * carry every tags_all tag and match `match`). Like the fake knowDrive, it ignores tags_none: the server's own fences
 * are what the tests check.
 */
async function startFakeAttendd(kdFiles) {
  const calls = [];
  const state = { status: 'ok', match: /.^/, respond: null, down: false };
  const bundleOf = (body) => {
    const all = body.scope?.tags_all || [];
    const ev = [];
    for (const f of kdFiles.values()) {
      if (!all.every((t) => f.tags.includes(t))) continue;
      for (const a of f.atoms || []) if (state.match.test(a.text)) ev.push({ h: `e${ev.length + 1}`, kind: 'passage', coverage: 'ranked', path: f.filename, file_id: f.id, atom_index: a.seq, content_hash: `blake3:${f.id}-${a.seq}`, text: a.text, via: ['H-query'] });
    }
    const status = state.status === 'ok' && !ev.length ? 'none_in_window' : state.status;
    return { request: body, status, evidence: ['ok', 'truncated'].includes(status) ? ev : [], facts: [], match: {}, receipt: { bundle_digest: `blake3:bundle-${calls.length}` } };
  };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (state.down) { res.writeHead(503); res.end('{"error":"down"}'); return; }
      if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      const body = JSON.parse(b || '{}');
      calls.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.respond ? state.respond(body, bundleOf) : bundleOf(body)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, state, close: () => new Promise((r) => server.close(() => r())) };
}

/** A research agent that quotes every line matching `want` it is shown (none: found=false). Records each request. */
function quotingAgent(want) {
  const seen = [];
  const agent = async (params) => {
    seen.push(params);
    const all = JSON.stringify(params.messages);
    const ns = [...all.matchAll(/L(\d+) ([^\\]*)/g)].filter((m) => want.test(m[2])).map((m) => Number(m[1]));
    if (!ns.length) return { content: [{ type: 'tool_use', id: 'a1', name: 'answer', input: { found: false, quotes: [] } }] };
    return { content: [{ type: 'tool_use', id: 'a1', name: 'answer', input: { found: true, quotes: ns.slice(0, 2).map((n) => ({ from: n })) } }] };
  };
  agent.model = 'fake-research';
  agent.seen = seen;
  return agent;
}

async function boot({ env = {}, studio = {}, agent, attendDown = false, fixtures = [] } = {}) {
  const kd = await startFakeKnowDrive({ speed: 6, narrowScope: 'all', fixtures });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const att = await startFakeAttendd(kd.files);
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-evidence-'));
  const fullEnv = {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen',
    KNOWBOT_EVIDENCE: 'attend', ATTENDD_URL: attendDown ? 'http://127.0.0.1:9' : att.url, ...env,
  };
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: fullEnv, researchAgent: agent ?? null,
    studio: { sweep: false, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400, ...(agent !== undefined ? { researchAgent: agent } : {}), ...studio } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  return {
    kd, llm, att, kb, base, api,
    async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await att.close(); await fsp.rm(dataDir, { recursive: true, force: true }); },
  };
}

function client(S) {
  const h = (t, extra = {}) => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': t.ip, ...extra });
  return {
    async trial() {
      const ip = nextIp();
      const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } });
      assert.equal(r.status, 201);
      return { ...(await r.json()), ip };
    },
    json: (t, p, method = 'GET', body) => S.api(`/api/studio/trials/${t.trialId}${p}`, { method, headers: h(t, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }),
    upload: (t, name, text) => S.api(`/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: h(t, { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' }), body: Buffer.from(text) }),
    async ask(t, question) {
      const r = await S.api(`/api/studio/trials/${t.trialId}/ask`, { method: 'POST', headers: h(t, { 'content-type': 'application/json' }), body: JSON.stringify({ question }) });
      assert.equal(r.status, 200);
      const ev = parseSSE(await r.text());
      return { ev, final: ev.find((e) => e.event === 'final')?.data };
    },
    async waitReady(t, n, ms = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const j = await (await this.json(t, '/files')).json();
        if (j.files.length >= n && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) return j.files;
        await sleep(60);
      }
      throw new Error('files never became ready');
    },
  };
}

const RETURNS = '# Returns\n\nYou can return any unused item within 30 days of delivery for a full refund.\n\nRefunds are paid to the original card within 10 business days.\n';
const SHIPPING = '# Shipping\n\nOrders ship within 2 business days from our warehouse.\n\nShipping is free on orders over $75.\n';

describe('evidence selector: pure parts', () => {
  test('off unless KNOWBOT_EVIDENCE=attend', () => {
    assert.equal(createEvidenceSelector({}), null);
    assert.equal(createEvidenceSelector({ KNOWBOT_EVIDENCE: 'search' }), null);
    assert.ok(createEvidenceSelector({ KNOWBOT_EVIDENCE: 'attend' }));
  });

  test('mergeBundles keeps scope order, drops repeats by (file_id, atom_index), and picks the status', () => {
    const it = (f, i, text = `t${f}${i}`) => ({ file_id: f, atom_index: i, path: `x/${f}.md`, text, content_hash: `h${f}${i}` });
    const m = mergeBundles([
      { status: 'ok', evidence: [it('a', 0), it('a', 1)], receipt: { bundle_digest: 'd1' } },
      { status: 'truncated', evidence: [it('a', 1), it('b', 3)], receipt: { bundle_digest: 'd2' } },
    ]);
    assert.equal(m.status, 'truncated');
    assert.deepEqual(m.sources.map((s) => `${s.file_id}${s.seq}`), ['a0', 'a1', 'b3']);
    assert.deepEqual(m.receipt.bundles, ['d1', 'd2']);
    assert.match(m.receipt.digest, /^sha256:[0-9a-f]{64}$/);
    // one scope answers, the other finds nothing: the answer wins
    assert.equal(mergeBundles([{ status: 'none_in_window', evidence: [] }, { status: 'ok', evidence: [it('c', 0)] }]).status, 'ok');
    assert.equal(mergeBundles([{ status: 'none_in_window', evidence: [] }, { status: 'weak_match', evidence: [] }]).status, 'weak_match');
    assert.equal(mergeBundles([{ status: 'underspecified', evidence: [] }]).status, 'underspecified');
    // KNOWBOT_EVIDENCE_WEAK=answer: a weak match's passages go to the answer step instead of the refusal
    assert.equal(mergeBundles([{ status: 'weak_match', evidence: [it('a', 0)] }]).status, 'weak_match');
    assert.equal(mergeBundles([{ status: 'weak_match', evidence: [it('a', 0)] }], { weakAnswers: true }).status, 'ok');
    assert.equal(mergeBundles([{ status: 'degraded', evidence: [it('a', 0)] }]).status, 'degraded');
    assert.equal(mergeBundles([{ status: 'ok', evidence: [it('a', 0)], receipt: { bundle_digest: 'd9' } }]).receipt.digest, 'd9');
    assert.equal(hashFor(m.sources, 'a', 'ta1'), 'ha1');
  });

  test('scopesFromRetriever: tag-scoped knowDrive retrievers only', () => {
    const kd = (tag, ex = []) => ({ allOf: [tag], exclude: ex, store: 'vs_1', prefix: '' });
    assert.deepEqual(scopesFromRetriever({ parts: [{ retriever: kd('bucket:a', ['questions']) }, { retriever: kd('bucket:b') }] }).scopes,
      [{ tags_all: ['bucket:a'], tags_none: ['questions'] }, { tags_all: ['bucket:b'], tags_none: [] }]);
    assert.equal(scopesFromRetriever({ search() {} }), null, 'the local corpus keeps its search');
    assert.equal(scopesFromRetriever({ parts: [] }), null);
  });

  test('answerFromSources(evidenceOnly): the research agent gets only the answer tool and quotes only the given passages', async () => {
    const agent = quotingAgent(/30 days/);
    let searched = 0;
    const r = await lib.answerFromSources({ question: 'How long do I have to return something?', results: [{ file_id: 'f1', filename: 'returns.md', title: 'Returns', text: RETURNS, score: null }],
      complete: async () => { throw new Error('no select call expected'); }, search: async () => { searched++; return { results: [] }; }, research: agent, evidenceOnly: true });
    assert.equal(r.fin.refused, false);
    assert.equal(searched, 0);
    assert.deepEqual(agent.seen[0].tools.map((t) => t.name), ['answer']);
    assert.doesNotMatch(agent.seen[0].system, /search_files/);
    assert.match(r.fin.text, /30 days of delivery/);
    assert.equal(r.fin.citations[0].file_id, 'f1');
  });
});

describe('evidence selector in the Studio answer path', () => {
  let S, c, t, files;
  const agent = quotingAgent(/30 days|ship within 2 business days/);
  before(async () => {
    S = await boot({ agent });
    c = client(S);
    t = await c.trial();
    assert.equal((await c.upload(t, 'returns.md', RETURNS)).status, 201);
    assert.equal((await c.upload(t, 'shipping.md', SHIPPING)).status, 201);
    files = await c.waitReady(t, 2);
  });
  after(async () => { await S.close(); });

  test('ok: quotes only from the selected passages, with citations, content hashes and the receipt', async () => {
    S.att.state.status = 'ok';
    S.att.state.match = /30 days/; // only the returns passage is evidence; the agent would also quote shipping if shown it
    const before = S.kd.calls.filter((x) => x.url.endsWith('/search')).length;
    const seen0 = agent.seen.length;
    const { ev, final } = await c.ask(t, 'How long do I have to return an item?');
    assert.equal(final.status, 'grounded', JSON.stringify(final.why));
    assert.match(final.text, /30 days of delivery/);
    const returns = files.find((f) => f.name === 'returns.md');
    assert.deepEqual([...new Set(final.citations.map((x) => x.fileId))], [returns.id]);
    assert.equal(S.kd.calls.filter((x) => x.url.endsWith('/search')).length, before, 'no knowDrive search ran');
    const call = S.att.calls.at(-1);
    assert.deepEqual(call.scope.tags_all, [`trial:${t.trialId}`]);
    for (const tag of ['kind:trial-spec', 'kind:config', 'questions']) assert.ok(call.scope.tags_none.includes(tag), tag);
    const req = agent.seen[seen0];
    assert.deepEqual(req.tools.map((x) => x.name), ['answer'], 'no search tool with selected evidence');
    assert.doesNotMatch(JSON.stringify(req.messages), /ship within/, 'the agent only saw the selected passages');
    assert.ok(final.proof.quotedLines.every((q) => /^blake3:/.test(q.contentHash)));
    assert.match(final.proof.receipt.digest, /^blake3:bundle-/);
    assert.ok(ev.find((e) => e.event === 'retrieval').data.hits.every((h) => h.label === 'selected passage'));
  });

  for (const status of ['weak_match', 'none_in_window', 'underspecified']) {
    test(`${status}: the fixed refusal, no model call`, async () => {
      S.att.state.status = status;
      const seen0 = agent.seen.length, llm0 = S.llm.calls.length;
      const { final } = await c.ask(t, 'Do you sell boats?');
      assert.equal(final.text, lib.NOT_IN_DATA);
      assert.equal(final.status, 'refused');
      assert.equal(agent.seen.length, seen0, 'no research call');
      assert.equal(S.llm.calls.length, llm0, 'no select call');
    });
  }

  test('a disabled file is dropped even when the selector returns it', async () => {
    S.att.state.status = 'ok';
    S.att.state.match = /30 days|ship within/;
    const returns = files.find((f) => f.name === 'returns.md');
    await c.json(t, '', 'PATCH', { sources: { [returns.id]: false } });
    try {
      const { final } = await c.ask(t, 'How long do I have to return an item?');
      assert.ok(final.refused || !final.citations.some((x) => x.fileId === returns.id), JSON.stringify(final.citations));
      assert.ok(S.att.calls.at(-1).scope.tags_none.some((x) => x.startsWith('tfile:')), 'the disabled file is excluded by tag too');
    } finally { await c.json(t, '', 'PATCH', { sources: { [returns.id]: true } }); }
  });

  test('selector down: the answer uses search as before', async () => {
    S.att.state.down = true;
    try {
      const before = S.kd.calls.filter((x) => x.url.endsWith('/search')).length;
      const t2 = await c.trial();
      await c.upload(t2, 'returns.md', `${RETURNS}\nGift cards cannot be returned.\n`); // not byte-identical: a duplicate is never searchable
      await c.waitReady(t2, 1);
      const { final } = await c.ask(t2, 'How long do I have to return an item?');
      assert.equal(final.status, 'grounded', JSON.stringify(final.why));
      assert.ok(S.kd.calls.filter((x) => x.url.endsWith('/search')).length > before, 'knowDrive search ran');
      assert.equal(final.proof.receipt, undefined);
    } finally { S.att.state.down = false; }
  });
});

describe('evidence selector: unreachable sidecar and shared samples', () => {
  test('ATTENDD_URL not answering: Studio answers from search', async () => {
    const S = await boot({ agent: quotingAgent(/30 days/), attendDown: true });
    try {
      const c = client(S);
      const t = await c.trial();
      await c.upload(t, 'returns.md', RETURNS);
      await c.waitReady(t, 1);
      const { final } = await c.ask(t, 'How long do I have to return an item?');
      assert.equal(final.status, 'grounded', JSON.stringify(final.why));
      assert.equal(S.att.calls.length, 0);
    } finally { await S.close(); }
  });

  test('shared samples: a second scoped call, merged after the trial\'s own passages, repeats dropped', async () => {
    const agent = quotingAgent(/30 days|lifetime/i);
    const S = await boot({ agent, env: { KNOWBOT_STUDIO_SAMPLE_MODE: 'shared' }, studio: { replayTargetMs: 1500 } });
    try {
      const c = client(S);
      const t = await c.trial();
      assert.ok([200, 201].includes((await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' })).status));
      assert.equal((await c.upload(t, 'returns.md', RETURNS)).status, 201);
      const files = await c.waitReady(t, 5);
      await sleep(300);
      // the sample scope's bundle repeats the trial's own first passage: it must appear once
      S.att.state.match = /30 days|lifetime/i;
      S.att.state.respond = (body, bundleOf) => {
        const b = bundleOf(body);
        if (body.scope.tags_all.includes('kind:trial-sample') && S.att.calls.length >= 2) {
          const own = bundleOf(S.att.calls.at(-2));
          b.evidence = [...own.evidence.slice(0, 1), ...b.evidence];
        }
        return b;
      };
      const { final } = await c.ask(t, 'How long is the frame warranty and how long do I have to return?');
      const calls = S.att.calls.slice(-2);
      assert.deepEqual(calls[0].scope.tags_all, [`trial:${t.trialId}`]);
      assert.ok(calls[1].scope.tags_all.includes('sample-set:lumen-bikes') && calls[1].scope.tags_all.includes('kind:trial-sample'));
      assert.equal(final.status, 'grounded', JSON.stringify(final.why));
      const ids = new Set(files.map((f) => f.id));
      assert.ok(final.citations.every((x) => ids.has(x.fileId)), 'every citation is one of this trial\'s files');
      const own = files.find((f) => f.name === 'returns.md');
      const sampleIds = new Set(files.filter((f) => f.replay).map((f) => f.id));
      const quoted = final.proof.quotedLines;
      assert.ok(quoted.some((q) => q.fileId === own.id), 'own passage quoted');
      assert.ok(quoted.some((q) => sampleIds.has(q.fileId)), 'sample passage quoted');
      // the agent saw the trial's own passage first, and only once
      const shown = JSON.stringify(agent.seen.at(-1).messages);
      assert.equal(shown.split('within 30 days of delivery').length - 1, 1);
      assert.ok(shown.indexOf('30 days of delivery') < shown.search(/lifetime/i));
    } finally { await S.close(); }
  });
});

describe('evidence selector on the developer API and live bots', () => {
  let S, c, t;
  before(async () => {
    S = await boot({ agent: quotingAgent(/30 days/), fixtures: [{ store: 'vs_fake', path: 'knowbot/ugm/returns.md', text: RETURNS, tags: ['knowbot:ugm', 'dir:knowbot', 'dir:ugm'] }] });
    c = client(S);
  });
  after(async () => { await S.close(); });

  test('/api/canonical (built-in bot): the selector refusal needs no model call; an answer carries the receipt', async () => {
    S.att.state.status = 'weak_match';
    const llm0 = S.llm.calls.length;
    const r = await (await S.api('/api/canonical', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Do you sell boats?' }) })).json();
    assert.equal(r.text, lib.NOT_IN_DATA);
    assert.equal(r.refused, true);
    assert.equal(S.llm.calls.length, llm0);
    const call = S.att.calls.at(-1);
    assert.deepEqual(call.scope.tags_all, ['knowbot:ugm', 'dir:knowbot', 'dir:ugm'], 'the bot\'s own tags');
    assert.ok(call.scope.tags_none.includes('questions'));
    S.att.state.status = 'ok';
    S.att.state.match = /30 days/;
    const a = await (await S.api('/api/canonical', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How long do I have to return an item?' }) })).json();
    assert.equal(a.refused, false, a.text);
    assert.match(a.text, /30 days of delivery/);
    assert.equal(a.citations[0].filename, 'returns.md', 'named relative to the bot folder, as its search names it');
    assert.match(a.receipt.digest, /^blake3:bundle-/);
  });

  test('/v1/bots/:id/chat (launched bot): quotes carry content hashes, the proof page shows the receipt; a refusal needs no model call', async () => {
    await S.kb.registry.ready;
    const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
    assert.equal((await S.api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
    assert.equal((await S.api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'policy.md' }, body: `${RETURNS}\nAcme only.\n` })).status, 201);
    assert.equal((await S.api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
    await S.kd.settle();
    const key = (await (await S.api('/api/instances/front-desk/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 't' }) })).json()).key;
    const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    S.att.state.status = 'ok';
    S.att.state.match = /30 days/;
    const j = await (await S.api('/v1/bots/front-desk/chat', { method: 'POST', headers: auth, body: JSON.stringify({ question: 'How long do I have to return an item?' }) })).json();
    assert.equal(j.refused, false, j.answer);
    assert.ok(S.att.calls.at(-1).scope.tags_all.some((x) => x.startsWith('bucket:')), 'scoped to the bot\'s bucket');
    assert.match(j.proof.receipt.digest, /^blake3:bundle-/);
    assert.ok(j.proof.quoted.length && j.proof.quoted.every((q) => /^blake3:/.test(q.contentHash)), JSON.stringify(j.proof.quoted));
    const html = await (await fetch(j.proofUrl.replace(/^https?:\/\/[^/]+/, S.base))).text();
    assert.match(html, /Receipt <span class="file">blake3:bundle-/);
    assert.match(html, /content hash blake3:/);
    assert.doesNotMatch(html, /attend|resolve\.engine|gitlab/i, 'the page never names the engine');
    S.att.state.status = 'none_in_window';
    const llm0 = S.llm.calls.length;
    const off = await (await S.api('/v1/bots/front-desk/chat', { method: 'POST', headers: auth, body: JSON.stringify({ question: 'Do you sell boats?' }) })).json();
    assert.equal(off.refused, true);
    assert.equal(off.answer, lib.NOT_IN_DATA);
    assert.equal(S.llm.calls.length, llm0);
  });
});

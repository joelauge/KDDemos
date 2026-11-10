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
import { createEvidenceSelector, createResolver, spanToDoc, combineDigests, mergeBundles, scopesFromRetriever, hashFor } from '../evidence.mjs';
import { normHit, resolvedRetrieval } from '../trials.mjs';
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
  // resolve: POST /resolve (KNOWBOT_EVIDENCE=resolve): every atom of the files carrying every tags_all tag of some
  // scope, in file order, each with similarity sim(text) (default 0.8); fail: an HTTP 500; noSim: spans without one
  const resolveCalls = [];
  const state = { status: 'ok', match: /.^/, respond: null, down: false, sim: () => 0.8, fail: false, noSim: false };
  const resolveOf = (body) => {
    const scopes = body.scopes || [body.scope || {}];
    const all = [];
    for (const f of kdFiles.values()) {
      if (!scopes.some((sc) => (sc.tags_all || []).every((t) => f.tags.includes(t)))) continue;
      for (const a of f.atoms || []) all.push({ f, a, sim: state.sim(a.text) });
    }
    // ranked like a search would rank them (best first), then cut to the window
    const spans = all.sort((x, y) => y.sim - x.sim).slice(0, body.limit || 20).map(({ f, a, sim }, i) => ({ file_id: f.id, path: f.filename, atom_index: a.seq, text: a.text,
      content_hash: `blake3:${f.id}`, score: 0.033 - i * 0.001, rank: i, tags: f.tags, ...(state.noSim ? {} : { similarity: sim }) }));
    return { spans, score_kind: 'rrf', rank_mode: 'server_hybrid', calls: 1, receipt: { digest: `blake3:resolve-${resolveCalls.length}` } };
  };
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
      if (req.url === '/resolve') {
        resolveCalls.push(body);
        if (state.fail) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resolveOf(body)));
        return;
      }
      calls.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.respond ? state.respond(body, bundleOf) : bundleOf(body)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, resolveCalls, state, close: () => new Promise((r) => server.close(() => r())) };
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

  test('mergeBundles attributes each passage to the heads that surfaced it, internally only', () => {
    const it = (f, i, via) => ({ file_id: f, atom_index: i, path: `x/${f}.md`, text: `t${f}${i}`, via });
    const m = mergeBundles([
      { status: 'ok', evidence: [it('a', 0, ['H-query']), it('a', 2, ['H-section'])],
        summary: { heads_run: ['H-query', 'H-fact', 'H-section'], heads_failed: [], section_available: true, rank_mode: 'client_rrf' } },
      { status: 'ok', evidence: [it('a', 0, ['H-query']), it('b', 1, ['H-query', 'H-entity'])],
        summary: { heads_run: ['H-query', 'H-entity'], heads_failed: ['H-section'], section_available: false, rank_mode: 'client_rrf' } },
    ]);
    assert.deepEqual(m.attribution.heads, { 'H-query': 2, 'H-section': 1, 'H-entity': 1 });
    assert.deepEqual(m.attribution.items.map((x) => `${x.file_id}${x.seq}:${x.via.join('+')}`), ['a0:H-query', 'a2:H-section', 'b1:H-query+H-entity']);
    assert.deepEqual(m.attribution.heads_run, ['H-query', 'H-fact', 'H-section', 'H-entity']);
    assert.deepEqual(m.attribution.heads_failed, ['H-section']);
    assert.equal(m.attribution.section_available, false);
    assert.equal(m.attribution.rank_mode, 'client_rrf');
    // the sources answers and proofs carry say nothing about heads
    assert.ok(m.sources.every((s) => !('via' in s)));
    // an older sidecar without a summary: heads_run comes from the heads it reports
    const old = mergeBundles([{ status: 'ok', evidence: [it('a', 0, ['H-query'])], heads: [{ id: 'H-query', status: 'ok' }, { id: 'H-entity', status: 'skipped' }] }]);
    assert.deepEqual(old.attribution.heads_run, ['H-query']);
    assert.equal(old.attribution.section_available, true);
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

// ------------------------------------------------------------------------------------------------ resolve mode
describe('resolve mode (KNOWBOT_EVIDENCE=resolve): pure parts', () => {
  test('off unless KNOWBOT_EVIDENCE=resolve; attend and resolve are never both on', () => {
    assert.equal(createResolver({}), null);
    assert.equal(createResolver({ KNOWBOT_EVIDENCE: 'attend' }), null);
    assert.ok(createResolver({ KNOWBOT_EVIDENCE: 'resolve' }));
    assert.equal(createEvidenceSelector({ KNOWBOT_EVIDENCE: 'resolve' }), null);
  });

  test('a span reads as a search hit: similarity = the span\'s (as 1 - distance/2), rrf = its score', () => {
    const d = spanToDoc({ file_id: 'f1', path: 'knowbot/trials/t1/returns.md', atom_index: 3, text: 'Return within 30 days.', score: 0.0328, rank: 0, similarity: 0.7925, tags: ['trial:t1'], content_hash: 'blake3:x' });
    const h = normHit(d, 'hybrid');
    assert.ok(Math.abs(h.similarity - 0.7925) < 1e-9);
    assert.equal(h.rrf, 0.0328);
    assert.equal(h.seq, 3);
    assert.equal(h.fileId, 'f1');
    assert.deepEqual(h.tags, ['trial:t1']);
    assert.equal(normHit(spanToDoc({ file_id: 'f', path: 'p', text: 't', score: 0.01 }), 'hybrid').similarity, null);
  });

  test('resolvedRetrieval keeps resolve\'s order, fences hits, interleaves clauses, and reports the best similarity', () => {
    const doc = (f, i, sim, tags = ['trial:t1']) => spanToDoc({ file_id: f, path: `x/${f}.md`, atom_index: i, text: `${f}${i} text`, score: 0.03, similarity: sim, tags });
    const main = [doc('a', 0, 0.71), doc('b', 1, 0.85), doc('c', 2, 0.9, ['trial:other']), doc('a', 4, 0.6)];
    const ok = (h) => h.tags.includes('trial:t1');
    const r = resolvedRetrieval([main], ok);
    assert.deepEqual(r.vector.map((h) => `${h.fileId}${h.seq}`), ['a0', 'b1', 'a4'], 'rank order, not re-sorted; the out-of-scope hit fenced');
    assert.equal(r.top, 0.85);
    assert.deepEqual(r.hybridOnly, []);
    assert.ok(r.vector.every((h) => h.hybridRank && h.rrf === 0.03 && h.mode === 'vector' && h.contentHash === null));
    // what today's keep step keeps at a 0.7 floor
    assert.deepEqual(r.vector.filter((h) => h.similarity >= 0.7).map((h) => `${h.fileId}${h.seq}`), ['a0', 'b1']);
    // two clauses: each clause's two best first, then the rest in rank order, each passage once
    const r2 = resolvedRetrieval([main, [doc('d', 0, 0.8), doc('a', 0, 0.71)], [doc('e', 0, 0.75)]], ok);
    assert.deepEqual(r2.vector.map((h) => `${h.fileId}${h.seq}`), ['d0', 'e0', 'a0', 'b1', 'a4']);
    assert.equal(combineDigests(['blake3:a']), 'blake3:a');
    assert.match(combineDigests(['blake3:a', 'blake3:b']), /^sha256:[0-9a-f]{64}$/);
    assert.equal(combineDigests([]), null);
  });

  test('createResolver: an HTTP error, a span without a similarity, or a dead sidecar returns null (search instead)', async () => {
    const mk = (body, status = 200) => async (u) => (String(u).endsWith('/healthz') ? new Response('{"ok":true}') : new Response(JSON.stringify(body), { status }));
    const span = { file_id: 'f', path: 'p.md', atom_index: 0, text: 't', score: 0.03, rank: 0, tags: [] };
    let sent = null;
    const good = createResolver({ KNOWBOT_EVIDENCE: 'resolve' }, { fetch: async (u, init) => { if (init?.body) sent = JSON.parse(init.body); return mk({ spans: [{ ...span, similarity: 0.8 }], receipt: { digest: 'blake3:z' }, rank_mode: 'server_hybrid' })(u); } });
    const r = await good.resolve({ store: 'vs', question: 'q', scopes: [{ tags_all: ['trial:t1'] }, { tags_all: ['sample-set:s'] }] });
    assert.equal(r.digest, 'blake3:z');
    assert.equal(r.docs.length, 1);
    assert.equal(sent.scopes.length, 2, 'both scopes in one request');
    assert.equal(await createResolver({ KNOWBOT_EVIDENCE: 'resolve' }, { fetch: mk({ error: 'x' }, 502) }).resolve({ store: 'vs', question: 'q' }), null);
    assert.equal(await createResolver({ KNOWBOT_EVIDENCE: 'resolve' }, { fetch: mk({ spans: [span] }) }).resolve({ store: 'vs', question: 'q' }), null);
    assert.equal(await createResolver({ KNOWBOT_EVIDENCE: 'resolve' }, { fetch: async () => { throw new Error('ECONNREFUSED'); } }).resolve({ store: 'vs', question: 'q' }), null);
  });
});

describe('resolve mode in the Studio answer path', () => {
  let S, c, t;
  before(async () => {
    S = await boot({ env: { KNOWBOT_EVIDENCE: 'resolve' }, agent: null });
    c = client(S);
    t = await c.trial();
    assert.equal((await c.upload(t, 'returns.md', RETURNS)).status, 201);
    assert.equal((await c.upload(t, 'shipping.md', SHIPPING)).status, 201);
    await c.waitReady(t, 2);
  });
  after(async () => { await S.close(); });
  const searches = () => S.kd.calls.filter((x) => x.url.endsWith('/search')).length;

  test('resolve replaces the search; KnowBot\'s floor, answer, citations and proof run as today, with the receipt', async () => {
    S.att.state.sim = (text) => (/30 days/.test(text) ? 0.82 : 0.55);
    const s0 = searches(), r0 = S.att.resolveCalls.length;
    const { ev, final } = await c.ask(t, 'How long do I have to return an item?');
    assert.equal(final.status, 'grounded', JSON.stringify(final.why));
    assert.match(final.text, /30 days/);
    assert.equal(searches(), s0, 'no knowDrive search ran');
    assert.equal(S.att.calls.length, 0, 'no attend call');
    assert.ok(S.att.resolveCalls.length > r0);
    const call = S.att.resolveCalls.at(-1);
    assert.deepEqual(call.scope.tags_all, [`trial:${t.trialId}`]);
    for (const tag of ['kind:trial-spec', 'kind:config', 'questions']) assert.ok(call.scope.tags_none.includes(tag), tag);
    assert.match(final.proof.receipt.digest, /^blake3:resolve-/);
    const ret = ev.find((e) => e.event === 'retrieval').data;
    assert.equal(ret.floor.top, 0.82);
    // the floor is KnowBot's own: only passages at or above it are kept; the others are shown, not kept
    assert.ok(ret.hits.filter((h) => h.kept).every((h) => h.similarity >= ret.floor.min));
    assert.ok(ret.hits.some((h) => !h.kept && h.similarity === 0.55));
    assert.ok(ret.hits.every((h) => h.label === 'match'), 'labelled like search hits, not selected passages');
  });

  test('below the floor: the same floor refusal as today (best, floor, candidates), with the receipt', async () => {
    S.att.state.sim = () => 0.52;
    const { final } = await c.ask(t, 'Do you sell boats?');
    assert.equal(final.status, 'refused');
    assert.equal(final.text, lib.NOT_IN_DATA);
    assert.equal(final.why.best, 0.52);
    assert.equal(final.why.floor, 0.7);
    assert.ok(final.why.candidates.length > 0 && final.why.candidates.every((x) => x.similarity === 0.52));
    assert.ok('closeMiss' in final);
    assert.match(final.proof.receipt.digest, /^blake3:resolve-/);
  });

  test('resolve fails or carries no similarity: today\'s search answers, without a receipt', async () => {
    for (const mode of ['fail', 'noSim']) {
      S.att.state.sim = () => 0.82;
      S.att.state[mode] = true;
      try {
        const t2 = await c.trial();
        await c.upload(t2, 'returns.md', `${RETURNS}\n${mode} copy.\n`);
        await c.waitReady(t2, 1);
        const s0 = searches();
        const { final } = await c.ask(t2, 'How long do I have to return an item?');
        assert.equal(final.status, 'grounded', `${mode}: ${JSON.stringify(final.why)}`);
        assert.ok(searches() > s0, `${mode}: knowDrive search ran`);
        assert.equal(final.proof.receipt, undefined);
      } finally { S.att.state[mode] = false; }
    }
  });
});

describe('resolve mode: shared samples, developer API and live bots', () => {
  test('shared samples: one call with both scopes; every citation is this trial\'s', async () => {
    const S = await boot({ env: { KNOWBOT_EVIDENCE: 'resolve', KNOWBOT_STUDIO_SAMPLE_MODE: 'shared' }, agent: null, studio: { replayTargetMs: 1500 } });
    try {
      const c = client(S);
      const t = await c.trial();
      assert.ok([200, 201].includes((await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' })).status));
      assert.equal((await c.upload(t, 'returns.md', RETURNS)).status, 201);
      const files = await c.waitReady(t, 5);
      await sleep(300);
      S.att.state.sim = (text) => (/30 days/i.test(text) ? 0.8 : 0.5);
      const { final } = await c.ask(t, 'How long do I have to return an item?');
      const call = S.att.resolveCalls.findLast((x) => Array.isArray(x.scopes));
      assert.ok(call, 'one call carries both scopes');
      assert.deepEqual(call.scopes[0].tags_all, [`trial:${t.trialId}`]);
      assert.ok(call.scopes[1].tags_all.includes('sample-set:lumen-bikes') && call.scopes[1].tags_all.includes('kind:trial-sample'));
      assert.equal(final.status, 'grounded', JSON.stringify(final.why));
      const ids = new Set(files.map((f) => f.id));
      assert.ok(final.citations.every((x) => ids.has(x.fileId)));
    } finally { await S.close(); }
  });

  test('/api/canonical and /v1/bots/:id/chat: the retriever reads the resolve window; floor and receipt as with search', async () => {
    const S = await boot({ env: { KNOWBOT_EVIDENCE: 'resolve' }, agent: quotingAgent(/30 days/), fixtures: [{ store: 'vs_fake', path: 'knowbot/ugm/returns.md', text: RETURNS, tags: ['knowbot:ugm', 'dir:knowbot', 'dir:ugm'] }] });
    try {
      S.att.state.sim = (text) => (/30 days/.test(text) ? 0.86 : 0.5);
      const s0 = S.kd.calls.filter((x) => x.url.endsWith('/search')).length;
      const a = await (await S.api('/api/canonical', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How long do I have to return an item?' }) })).json();
      assert.equal(a.refused, false, a.text);
      assert.match(a.text, /30 days of delivery/);
      assert.match(a.receipt.digest, /^blake3:resolve-/);
      assert.equal(S.kd.calls.filter((x) => x.url.endsWith('/search')).length, s0, 'no knowDrive search ran');
      assert.equal(S.att.resolveCalls.at(-1).scope.tags_all[0], 'knowbot:ugm');
      // below the built-in floor: refused by the retriever's own floor, as with search
      S.att.state.sim = () => 0.6;
      const off = await (await S.api('/api/canonical', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Do you sell boats?' }) })).json();
      assert.equal(off.refused, true);

      await S.kb.registry.ready;
      const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
      assert.equal((await S.api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
      assert.equal((await S.api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'policy.md' }, body: `${RETURNS}\nAcme only.\n` })).status, 201);
      assert.equal((await S.api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
      await S.kd.settle();
      const key = (await (await S.api('/api/instances/front-desk/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 't' }) })).json()).key;
      S.att.state.sim = (text) => (/30 days/.test(text) ? 0.86 : 0.5);
      const j = await (await S.api('/v1/bots/front-desk/chat', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How long do I have to return an item?' }) })).json();
      assert.equal(j.refused, false, j.answer);
      assert.ok(S.att.resolveCalls.at(-1).scope.tags_all.some((x) => x.startsWith('bucket:')), 'scoped to the bot\'s bucket');
      assert.match(j.proof.receipt.digest, /^blake3:resolve-/);
      assert.equal(j.proof.floor.top, 0.86);
      const html = await (await fetch(j.proofUrl.replace(/^https?:\/\/[^/]+/, S.base))).text();
      assert.match(html, /Receipt <span class="file">blake3:resolve-/);
      assert.doesNotMatch(html, /attend|resolve\.engine|gitlab/i, 'the page never names the engine');
    } finally { await S.close(); }
  });
});

describe('resolve mode per bot (KNOWBOT_EVIDENCE_BOTS)', () => {
  test('only the listed bots use the sidecar; others, and no bot, keep today\'s search; KNOWBOT_EVIDENCE=resolve is everyone', async () => {
    const { createResolver } = await import('../evidence.mjs');
    assert.equal(createResolver({}), null, 'off by default');
    const calls = [];
    const fake = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/healthz')) return new Response('{"ok":true}', { status: 200 });
      return new Response(JSON.stringify({ spans: [{ file_id: 'f1', path: 'a.md', text: 'hello', atom_index: 0, similarity: 0.9, score: 0.03, rank: 1 }], receipt: { digest: 'sha256:x' } }), { status: 200 });
    };
    const r = createResolver({ KNOWBOT_EVIDENCE_BOTS: ' tr_AAAAAAAAAAAAAAAA , ugm ' }, { fetch: fake });
    assert.ok(r && !r.all);
    const q = { store: 'vs_x', question: 'hi', scope: { tags_all: ['trial:x'] } };
    assert.ok(await r.resolve({ ...q, bot: 'tr_aaaaaaaaaaaaaaaa' }), 'listed (case-insensitive)');
    assert.ok(await r.resolve({ ...q, bot: 'ugm' }));
    const before = calls.length;
    assert.equal(await r.resolve({ ...q, bot: 'tr_bbbbbbbbbbbbbbbb' }), null, 'not listed');
    assert.equal(await r.resolve(q), null, 'no bot named');
    assert.equal(calls.length, before, 'no sidecar call for an unlisted bot');
    const all = createResolver({ KNOWBOT_EVIDENCE: 'resolve' }, { fetch: fake });
    assert.ok(all.all && await all.resolve({ ...q, bot: 'anyone' }));
  });
});

// One answer pipeline (server/answer.mjs): the same question on the same bot gets the same answer on every surface —
// the Studio's ask, the AI-agent ask (/v1/bots/:id/ask), the developer chat (/v1/bots/:id/chat), a channel (the SMS
// preview: the same pipeline and formatter as the webhook) and the website widget's endpoint (/v1/bots/:id/web).
// Same answered/refused outcome, same cited source lines. Plus: spoken answers never wait for the verdict.
// Fakes only: never touches knowDrive or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { runAnswer, NO_VERDICT_CHANNELS, VERDICT_CAP_MS } from '../answer.mjs';
import { NOT_IN_DATA } from '../../lib/knowbot.js';

delete process.env.KNOWDRIVE_API_KEY; // isolation: nothing here may reach a real store
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSSE = (text) => text.split('\n\n').map((fr) => {
  const ev = /^event: (.*)$/m.exec(fr)?.[1];
  return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null;
}).filter(Boolean);
const norm = (lines) => [...new Set((lines || []).map((t) => String(t).replace(/\s+/g, ' ').trim()))].sort();

describe('parity: one question, one answer, on every surface (trial bot)', () => {
  let kd, llm, kb, base, dataDir, t, key;
  const H = () => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': '198.51.100.201' });
  before(async () => {
    kd = await startFakeKnowDrive({ speed: 3, narrowScope: 'all' });
    llm = await startFakeLLM({});
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-parity-'));
    kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: {
      KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
      KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen' },
    studio: { sweep: false, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 } });
    await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${kb.server.address().port}`;
    t = await (await fetch(`${base}/api/studio/trials`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.201' } })).json();
    await fetch(`${base}/api/studio/trials/${t.trialId}/samples`, { method: 'POST', headers: { ...H(), 'content-type': 'application/json' }, body: JSON.stringify({ set: 'lumen-bikes' }) });
    for (let i = 0; i < 400; i++) {
      const j = await (await fetch(`${base}/api/studio/trials/${t.trialId}/files`, { headers: H() })).json();
      if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
      await sleep(60);
    }
    key = (await (await fetch(`${base}/api/studio/trials/${t.trialId}/devkey`, { headers: H() })).json()).key;
  });
  after(async () => { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); });

  /** The question on every surface → [{surface, refused, lines, text}]. */
  async function everywhere(q) {
    const out = [];
    const studio = parseSSE(await (await fetch(`${base}/api/studio/trials/${t.trialId}/ask`, { method: 'POST', headers: { ...H(), 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })).text())
      .find((e) => e.event === 'final').data;
    out.push({ surface: 'studio', refused: studio.refused, lines: norm(studio.proof.quotedLines.map((x) => x.text)), text: studio.text, tabular: studio.proof.claims?.some((c) => c.summary) });
    const agent = await (await fetch(`${base}/api/v1/bots/${t.trialId}/ask?q=${encodeURIComponent(q)}`)).json();
    out.push({ surface: 'agent', refused: agent.answered === 'no', lines: norm(agent.cited_lines) });
    const chat = await (await fetch(`${base}/api/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })).json();
    out.push({ surface: 'chat', refused: chat.refused, lines: norm(chat.proof.lines.map((x) => x.text)) });
    const sms = await (await fetch(`${base}/api/v1/bots/${t.trialId}/preview`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms', question: q }) })).json();
    out.push({ surface: 'sms', refused: sms.refused, lines: norm(sms.lines), text: sms.text });
    const webRes = await fetch(`${base}/api/v1/bots/${t.trialId}/web`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-forwarded-for': '198.51.100.202' }, body: JSON.stringify({ question: q, stream: true, format: 'markdown' }) });
    const evs = parseSSE(await webRes.text());
    const web = evs.find((e) => e.event === 'final').data;
    out.push({ surface: 'web', refused: web.refused, lines: norm(web.proof.lines.map((x) => x.text)), text: web.answer, statuses: evs.filter((e) => e.event === 'status').map((e) => e.data.step) });
    return out;
  }
  const same = (rows, q) => {
    const [ref] = rows;
    for (const r of rows) {
      assert.equal(r.refused, ref.refused, `${q}: ${r.surface} refused=${r.refused}, studio refused=${ref.refused}`);
      assert.deepEqual(r.lines, ref.lines, `${q}: ${r.surface} cites the same lines as the Studio`);
    }
  };

  test('a plain question: answered everywhere, the same cited lines; the widget shows the Studio\'s own text', async () => {
    const q = 'How long is the frame warranty?';
    const rows = await everywhere(q);
    same(rows, q);
    assert.equal(rows[0].refused, false);
    assert.ok(rows[0].lines.length >= 1);
    const web = rows.find((r) => r.surface === 'web');
    assert.equal(web.text, rows[0].text, 'the widget answer is the Studio answer, word for word');
    assert.ok(web.statuses.includes('search') && web.statuses.includes('select'), `the widget hears the pipeline's steps: ${web.statuses}`);
  });

  test('a table question (price-list rows): answered everywhere from the same rows', async () => {
    const q = 'How much does the Lumen Kids 20 cost?';
    const rows = await everywhere(q);
    same(rows, q);
    assert.equal(rows[0].refused, false, rows[0].text);
    assert.ok(rows[0].lines.some((l) => /Kids 20/.test(l) && /\$449/.test(l)), JSON.stringify(rows[0].lines));
  });

  test('a question the files do not answer: the fixed refusal everywhere', async () => {
    const q = 'Do you sell skateboards?';
    const rows = await everywhere(q);
    same(rows, q);
    assert.equal(rows[0].refused, true);
    assert.equal(rows[0].text, NOT_IN_DATA);
    assert.equal(rows.find((r) => r.surface === 'web').text, NOT_IN_DATA);
  });
});

describe('the verdict never holds up a spoken answer', () => {
  // an in-memory bot: one passage, a selector that names L1, and a verdict call that never returns
  const passage = 'The frame is covered for 10 years.\nBatteries are covered for 2 years.';
  const adapter = {
    retrieve: async () => ({ vector: [{ fileId: 'f1', atomId: 'a1', seq: 0, text: passage, similarity: 0.92 }], hybridOnly: [], top: 0.92 }),
    sources: async (hits) => ({ sources: hits.map((h) => ({ file_id: h.fileId, filename: 'warranty.md', title: 'Warranty', text: h.text, score: h.similarity })), srcHit: hits }),
    fileName: () => 'warranty.md',
  };
  const make = () => {
    const calls = { judge: 0 };
    const complete = (messages) => {
      if (/grade one answer/i.test(String(messages[0]?.content || ''))) { calls.judge++; return new Promise(() => {}); }
      return Promise.resolve('L1');
    };
    return { calls, complete };
  };
  const ask = (channel, complete) => runAnswer({ question: 'How long is the frame covered?', persona: { name: 'Bot', org: 'Lumen' }, floor: 0.7, adapter, complete, channel });

  test('voice, phone, SMS and WhatsApp skip the verdict: no call, no wait', async () => {
    for (const channel of ['voice', 'phone', 'sms', 'whatsapp']) {
      assert.ok(NO_VERDICT_CHANNELS.has(channel));
      const { calls, complete } = make();
      const t0 = Date.now();
      const a = await ask(channel, complete);
      assert.equal(a.refused, false, a.text);
      assert.equal(calls.judge, 0, `${channel}: the verdict is never asked`);
      assert.ok(Date.now() - t0 < 500, `${channel}: answered without waiting (${Date.now() - t0} ms)`);
      assert.equal(a.timings.verdict, 0);
      for (const k of ['rewrite', 'search', 'select', 'interpret', 'verdict', 'total']) assert.equal(typeof a.timings[k], 'number', k);
    }
  });

  test('a research "not found" is a clean refusal, never a failure at step select (prod ref e95d0511)', async () => {
    for (const input of [{ found: false }, { found: true, quotes: [{ from: 999, to: 999 }] }]) {
      const research = Object.assign(async () => ({ content: [{ type: 'tool_use', id: 't', name: 'answer', input }], stop_reason: 'tool_use' }), { model: 'fake-research' });
      const a = await runAnswer({ question: 'How many bikes are in stock?', persona: { name: 'Bot' }, floor: 0.7, adapter, complete: async () => 'L1', research, channel: 'web' });
      assert.equal(a.refused, true);
      assert.equal(a.text, NOT_IN_DATA);
      assert.equal(a.failure, undefined, JSON.stringify(a.failure));
    }
  });

  test('other surfaces wait for the verdict at most VERDICT_CAP_MS, and the answer stands without it', async () => {
    const { calls, complete } = make();
    const t0 = Date.now();
    const a = await ask('web', complete);
    const took = Date.now() - t0;
    assert.equal(calls.judge, 1);
    assert.equal(a.refused, false);
    assert.equal(a.verdict, undefined, 'no verdict: the closing line is left as it was');
    assert.ok(took >= VERDICT_CAP_MS - 50 && took < VERDICT_CAP_MS + 1000, `capped wait (${took} ms)`);
  });
});

describe('parity: a launched bot (the built-in demo corpus) answers the same on the widget, agents and /api/canonical', () => {
  let llm, kb, base, dataDir, bot;
  before(async () => {
    llm = await startFakeLLM({});
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-parity-live-'));
    kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, rateLimit: 1000, env: { LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_ANSWER_MODE: 'select' } });
    await kb.ready;
    await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${kb.server.address().port}`;
    bot = (await (await fetch(`${base}/api/config`)).json()).instance.id;
  });
  after(async () => { await new Promise((r) => kb.server.close(() => r())); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); });

  for (const q of ['What is your return policy?', 'Do you sell quantum chromodynamics lattices?']) {
    test(q, async () => {
      const web = parseSSE(await (await fetch(`${base}/api/v1/bots/${bot}/web`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, stream: true, format: 'markdown' }) })).text())
        .find((e) => e.event === 'final').data;
      const agent = await (await fetch(`${base}/api/v1/bots/${bot}/ask?q=${encodeURIComponent(q)}`)).json();
      const canon = await (await fetch(`${base}/api/canonical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })).json();
      assert.equal(web.refused, !/return/.test(q), web.answer);
      assert.equal(agent.answered === 'no', web.refused);
      assert.equal(canon.refused, web.refused);
      assert.deepEqual(norm(agent.cited_lines), norm(web.proof.lines.map((x) => x.text)));
      assert.equal(canon.text, web.answer, 'the canonical answer is the widget answer');
      assert.deepEqual(canon.citations.map((c) => c.filename), web.citations.map((c) => c.file));
    });
  }
});

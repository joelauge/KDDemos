// Recall wiring through the server: the hidden query expansion and conversation history on the API, AI agents and the
// website widget's /api/chat, and Claude Haiku 5.5 as the default engine where the server has the key (a fake here:
// opts.haiku). Fakes only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { createLeads } from '../leads.mjs';
import { _resetQuestions, configureQuestions } from '../questions.mjs';
import { completeWith, queryVariantsOf, PROVIDERS, HAIKU_MODEL } from '../providers.mjs';
import { createResearchAgent, researchEffort } from '../research.mjs';
import { startFakeAnthropic } from './fake-anthropic.mjs';

delete process.env.KNOWDRIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DOC = `# Returns policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.

# Gift cards

Gift cards never expire and can be used in the store or online.
`;
const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };

/** A fake Claude Haiku: rewrites (JSON), selects lines by word overlap, grades A; records every call. */
function fakeHaiku({ fail = false } = {}) {
  const calls = [];
  const words = (t) => new Set(String(t).toLowerCase().match(/[a-z]{4,}/g) || []);
  return {
    model: HAIKU_MODEL, calls, available: () => true,
    async complete(messages, settings) {
      const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const user = String(messages.filter((m) => m.role === 'user').at(-1)?.content || '');
      const kind = /You turn a visitor's question into search queries/.test(sys) ? 'rewrite' : /You select lines/.test(sys) ? 'select' : /You grade one answer/.test(sys) ? 'judge' : 'other';
      calls.push({ kind, user, settings });
      if (fail) throw new Error('haiku down');
      if (kind === 'rewrite') {
        const q = /Question: (.*)$/m.exec(user)?.[1] || '';
        return JSON.stringify({ standalone: /refund/i.test(q) && /soon|fast|long/i.test(q) ? 'How long until a refund is paid back?' : q, queries: ['refund payment time', 'return policy days'] });
      }
      if (kind === 'select') {
        const q = words(/QUESTION: (.*)$/m.exec(user)?.[1] || '');
        let best = null, score = 0;
        for (const m of user.matchAll(/^L(\d+) (.*)$/gm)) { const s = [...words(m[2])].filter((w) => q.has(w)).length; if (s > score) { score = s; best = m[1]; } }
        return best ? `L${best}` : 'NONE';
      }
      if (kind === 'judge') return 'A';
      return 'ok';
    },
  };
}

async function boot({ env = {}, haiku } = {}) {
  const kd = await startFakeKnowDrive({ speed: 20 });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-recall-'));
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, leads: createLeads({ dataDir }), haiku: haiku ?? null, researchAgent: null, env: {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_PUBLIC_URL: 'https://kb.example.test',
    KNOWBOT_AGENT_FREE_PER_DAY: '100', KNOWBOT_AGENT_IP_RATE_LIMIT: '1000', ...env,
  }, studio: { sweep: false, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  await kb.registry.ready;
  assert.equal((await api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
  assert.equal((await api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'returns.md' }, body: DOC })).status, 201);
  assert.equal((await api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
  await kd.settle();
  return { kd, llm, kb, api, async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}

describe('recall: Claude Haiku 5.5 by default, the hidden expansion and the conversation history (server)', () => {
  let S, H;
  before(async () => { _resetQuestions(); configureQuestions({ debounceMs: 5 }); H = fakeHaiku(); S = await boot({ haiku: H }); });
  after(async () => { _resetQuestions(); await S.close(); });

  test('AI agents: answers run on Haiku whatever the bot model; history only helps understand the question; one rewrite call', async () => {
    const llm0 = S.llm.calls.length, h0 = H.calls.length;
    const r = await S.api('/v1/bots/front-desk/ask', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'and how soon is the refund paid?', history: [{ q: 'Can I return an unused item?', a: 'Yes, within 30 days. Store credit costs $12.' }] }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.answered, 'yes', JSON.stringify(j));
    assert.match(j.answer, /5 business days/);
    assert.doesNotMatch(j.answer, /\$12|store credit/i, 'a fact only in the history is never stated');
    const mine = H.calls.slice(h0);
    assert.equal(mine.filter((c) => c.kind === 'rewrite').length, 1);
    assert.match(mine.find((c) => c.kind === 'rewrite').user, /Visitor: Can I return an unused item\?/);
    assert.equal(mine.find((c) => c.kind === 'rewrite').settings.max_tokens, 120);
    const sel = mine.find((c) => c.kind === 'select');
    assert.ok(sel, 'the select step ran on Haiku');
    assert.match(sel.user, /QUESTION: How long until a refund is paid back\?\nASKED AS: and how soon is the refund paid\?/);
    assert.match(sel.user, /^Earlier in this conversation \(for understanding the question only; not a source\):/);
    assert.equal(S.llm.calls.slice(llm0).filter((c) => c.kind === 'select').length, 0, 'the local model is not used for an agent answer');
  });

  test('/v1 chat: a live bot keeps its own (local) model; history in {q,a} form reaches the select prompt; the API never shows the rewrite', async () => {
    const key = (await (await S.api('/api/instances/front-desk/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'k' }) })).json()).key;
    const llm0 = S.llm.calls.length;
    const r = await S.api('/v1/bots/front-desk/chat', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'and how soon is the refund paid?', history: [{ q: 'Can I return an unused item?', a: 'Yes, within 30 days [1].' }] }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.question, 'and how soon is the refund paid?');
    assert.ok(!JSON.stringify(j).includes('How long until a refund is paid back'), 'the standalone rewrite stays hidden');
    const sel = S.llm.calls.slice(llm0).filter((c) => c.kind === 'select');
    assert.ok(sel.length, 'the bot answered with its own model');
    assert.match(sel[0].user, /Visitor: Can I return an unused item\?\nBot: Yes, within 30 days\./);
  });

  test('/api/chat (the website widget): Haiku answers, JSON and SSE, OpenAI-shaped; the rewrite asks for low effort', async () => {
    const llm0 = S.llm.calls.length;
    const messages = [{ role: 'system', content: 'You select lines from x.' }, { role: 'user', content: 'LINES:\nL1 Gift cards never expire.\nQUESTION: Do gift cards expire?' }];
    const j = await (await S.api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, max_tokens: 24 }) })).json();
    assert.equal(j.choices[0].message.content, 'L1');
    assert.equal(j.model, HAIKU_MODEL);
    const sse = await (await S.api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, max_tokens: 24, stream: true }) })).text();
    assert.match(sse, /^data: \{.*"content":"L1".*\}\n\ndata: \[DONE\]\n\n$/s);
    await S.api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: "You turn a visitor's question into search queries for x." }, { role: 'user', content: 'Question: hi' }], max_tokens: 120, reasoning_effort: 'low' }) });
    assert.equal(H.calls.at(-1).settings.reasoning_effort, 'low');
    assert.equal(S.llm.calls.length, llm0, 'the local model was not called');
  });
});

describe('recall: KNOWBOT_WIDGET_ENGINE=local, a failing Haiku, and no key', () => {
  test('local engine: /api/chat relays to the local model; a Haiku error falls back to it; no key: the rewrite rules', async () => {
    const H = fakeHaiku();
    const L = await boot({ haiku: H, env: { KNOWBOT_WIDGET_ENGINE: 'local' } });
    try {
      const n = L.llm.calls.length;
      const r = await L.api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'low' }) });
      assert.equal(r.status, 200);
      assert.equal(L.llm.calls.length, n + 1);
      assert.equal(H.calls.length, 0);
    } finally { await L.close(); }
    const F = fakeHaiku({ fail: true });
    const D = await boot({ haiku: F });
    try {
      const n = D.llm.calls.length;
      const r = await D.api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
      assert.equal(r.status, 200);
      assert.equal(F.calls.length, 1);
      assert.equal(D.llm.calls.length, n + 1, 'fell back to the local model');
      // Haiku down: the rewrite falls back to the rules and the select step to the keyword selector; the agent still answers
      const a = await (await D.api('/v1/bots/front-desk/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How many days do I have to return an unused item?' }) })).json();
      assert.match(a.answer, /30 days/);
    } finally { await D.close(); }
  });
});

test('providers: the Anthropic default model is Claude Haiku 5.5; a short step with reasoning_effort gets that effort', async () => {
  assert.equal(PROVIDERS.anthropic.defaultModel, 'claude-haiku-5-5');
  assert.deepEqual([queryVariantsOf(undefined), queryVariantsOf('0'), queryVariantsOf('3'), queryVariantsOf('12')], [4, 0, 3, 4]);
  const fake = await startFakeAnthropic();
  const prev = process.env.KNOWBOT_ANTHROPIC_BASE_URL;
  process.env.KNOWBOT_ANTHROPIC_BASE_URL = fake.url;
  try {
    fake.push?.({ content: [{ type: 'text', text: '{"standalone":"x","queries":["y"]}' }], stop_reason: 'end_turn' });
    await completeWith('anthropic', 'sk-ant-test', undefined, [{ role: 'system', content: 's' }, { role: 'user', content: 'Question: q' }], { max_tokens: 120, temperature: 0, reasoning_effort: 'low' }).catch(() => '');
    const req = fake.requests.at(-1)?.body;
    assert.equal(req.model, 'claude-haiku-5-5');
    assert.deepEqual(req.output_config, { effort: 'low' });
    assert.equal(req.temperature, undefined);
    assert.equal(req.reasoning_effort, undefined);
    assert.equal(req.max_tokens, 4000);
  } finally {
    if (prev === undefined) delete process.env.KNOWBOT_ANTHROPIC_BASE_URL; else process.env.KNOWBOT_ANTHROPIC_BASE_URL = prev;
    await fake.close();
  }
});

test('research effort: KNOWBOT_RESEARCH_EFFORT low|medium|high on the research step only; unset (or invalid) = low', async () => {
  assert.deepEqual(['low', 'MEDIUM', 'high', '', 'max', undefined].map(researchEffort), ['low', 'medium', 'high', 'low', 'low', 'low']);
  const fake = await startFakeAnthropic();
  try {
    const run = async (effort) => {
      const agent = createResearchAgent({ ANTHROPIC_API_KEY: 'sk-ant-test', KNOWBOT_ANTHROPIC_BASE_URL: fake.url, ...(effort ? { KNOWBOT_RESEARCH_EFFORT: effort } : {}) });
      fake.push?.({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' });
      await agent({ system: 's', messages: [{ role: 'user', content: 'q' }], max_tokens: 64 }).catch(() => null);
      return fake.requests.at(-1)?.body;
    };
    assert.deepEqual((await run(null)).output_config, { effort: 'low' });
    assert.deepEqual((await run('high')).output_config, { effort: 'high' });
    assert.deepEqual((await run('max')).output_config, { effort: 'low' });
  } finally { await fake.close(); }
});

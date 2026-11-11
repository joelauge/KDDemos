// AI agents (server/agents.mjs + server/devapi.mjs): the remote MCP server per bot (initialize → tools/list →
// tools/call), the plain HTTP ask, discovery, public by default with a free daily allowance, the owner's key bypassing it,
// paid (metered) access, the public-off switch, and counting in Stats & Leads. Fakes only, on 127.0.0.1.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { configureQuestions, _resetQuestions, flushQuestions } from '../questions.mjs';
import { createLeads } from '../leads.mjs';
import { NOT_IN_DATA, FOLLOW_UPS } from '../../lib/knowbot.js';
import { answeredOf, agentResult, agentText, mcpDispatch, askTool, toolDescription, agentSettings, agentLimits, readAsk, secondsToReset, plainText, followUpOf,
  LIMIT_MESSAGE, limitMessage, OFF_MESSAGE, MCP_PROTOCOL_VERSIONS } from '../agents.mjs';
import { validatePatch, defaultSpec } from '../trials.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const VENDORS = /\b(?:claude|anthropic|chatgpt|openai|gpt-?\d|gemini|google|copilot|cursor|perplexity|twilio|stripe|meta)\b/i;

const DOC = `# Returns policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const OFF = 'What is the capital of Australia?';

// ------------------------------------------------------------------ units
describe('agents: shapes (pure)', () => {
  test('answered: refused or a "no" verdict → no, a partial verdict → partly, else yes', () => {
    assert.equal(answeredOf({ refused: true }), 'no');
    assert.equal(answeredOf({ refused: false, verdict: 'no' }), 'no');
    assert.equal(answeredOf({ refused: false, verdict: 'partial' }), 'partly');
    assert.equal(answeredOf({ refused: false, verdict: 'answers' }), 'yes');
    assert.equal(answeredOf({ refused: false }), 'yes');
    assert.equal(answeredOf(null), 'no');
  });
  test('the structured result: plain answer, sources with quotes, products, the follow-up', () => {
    const a = { refused: false, verdict: 'partial', citations: [{ n: 1, file: 'returns.md', title: 'Returns policy', url: 'https://shop.example/returns', excerpt: 'within 30 days', spans: ['within 30 days'] }],
      products: [{ title: 'Lumen Trail', url: 'https://shop.example/p/trail', price: '$1,200', junk: 'x' }] };
    const sc = agentResult(a, { text: `In [“Returns policy”](https://shop.example/returns), it says: “within 30 days” [1]. ${FOLLOW_UPS.partial}`, followUps: FOLLOW_UPS, proofUrl: 'https://kb.example/p/abc' });
    assert.equal(sc.answered, 'partly');
    assert.equal(sc.answer, `In “Returns policy”, it says: “within 30 days” [1]. ${FOLLOW_UPS.partial}`, 'markdown links become plain text; [n] stays');
    assert.deepEqual(sc.sources, [{ n: 1, title: 'Returns policy', url: 'https://shop.example/returns', quote: 'within 30 days' }]);
    assert.deepEqual(sc.products, [{ title: 'Lumen Trail', url: 'https://shop.example/p/trail', price: '$1,200' }]);
    assert.equal(sc.follow_up, FOLLOW_UPS.partial);
    assert.equal(sc.proof_url, 'https://kb.example/p/abc');
    const text = agentText(sc);
    assert.match(text, /\n\nSources:\n\[1\] Returns policy <https:\/\/shop\.example\/returns>/);
    assert.match(text, /Products:\n- Lumen Trail \(\$1,200\)/);
    const no = agentResult({ refused: true, citations: [{ n: 1 }], products: [{ title: 'x' }] }, { text: 'whatever', followUps: FOLLOW_UPS });
    assert.deepEqual(no, { answered: 'no', answer: NOT_IN_DATA, sources: [] });
    assert.equal(plainText('**Bold** and [a](https://x.example/a)'), 'Bold and a');
    assert.equal(followUpOf(`x. ${FOLLOW_UPS.general}`, FOLLOW_UPS), FOLLOW_UPS.general);
  });
  test('the ask tool: named after the bot, described from its name, org and purpose, tells the model to show sources, no vendor names', () => {
    const bot = { id: 'front-desk', name: 'Front Desk', org: 'Lumen Bikes', purpose: 'Answers questions about returns and warranty.' };
    const t = askTool(bot);
    assert.equal(t.name, 'ask');
    assert.equal(t.title, 'Ask Front Desk');
    assert.match(t.description, /Front Desk, the assistant for Lumen Bikes: Answers questions about returns and warranty\./);
    assert.match(t.description, /only from Lumen Bikes's own files/);
    assert.match(t.description, /Show the user the answer with its sources/);
    assert.ok(t.description.includes(NOT_IN_DATA));
    assert.deepEqual(t.inputSchema.required, ['question']);
    assert.deepEqual(Object.keys(t.inputSchema.properties), ['question', 'context', 'history']);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.doesNotMatch(JSON.stringify(t), VENDORS);
    assert.match(toolDescription({ name: 'Bot' }), /^Ask Bot\. It answers only from Bot's own files/);
  });
  test('settings, limits and input: public unless turned off, paid off unless on; env defaults', () => {
    assert.deepEqual(agentSettings(undefined), { public: true, paid: false });
    assert.deepEqual(agentSettings({ public: false }), { public: false, paid: false });
    assert.deepEqual(agentSettings({ paid: true }), { public: true, paid: true });
    const L = agentLimits({});
    assert.equal(L.freePerDay, 20); assert.equal(L.pricePer1k, 10); assert.equal(L.ipPerMinute, 20); assert.equal(L.paidIpPerMinute, 120);
    assert.equal(agentLimits({ KNOWBOT_AGENT_FREE_PER_DAY: '7', KNOWBOT_AGENT_PRICE_PER_1K: '12.5' }).freePerDay, 7);
    assert.equal(agentLimits({ KNOWBOT_AGENT_PRICE_PER_1K: '12.5' }).pricePer1k, 12.5);
    assert.deepEqual(readAsk({ question: '  How   long? ', context: 'c' }), { question: 'How long?', context: 'c' });
    assert.deepEqual(readAsk({ q: 'x' }), { question: 'x', context: '' });
    assert.throws(() => readAsk({}), (e) => e.status === 400);
    assert.throws(() => readAsk({ question: 'x'.repeat(1001) }), (e) => e.status === 400);
    const t = Date.UTC(2026, 10, 11, 23, 59, 0);
    assert.equal(secondsToReset(t), 60);
  });
  test('spec.agents: validated, merged, never material; absent means public', () => {
    const spec = defaultSpec();
    assert.equal(spec.agents, undefined, 'a new bot is public by default (no stored switch)');
    const r = validatePatch({ agents: { public: false } }, spec);
    assert.deepEqual(r.next.agents, { public: false, paid: false });
    assert.deepEqual(r.diff.map((d) => d.field), ['agents']);
    assert.equal(r.material, false);
    assert.deepEqual(validatePatch({ agents: { paid: true } }, r.next).next.agents, { public: false, paid: true }, 'merged with what is stored');
    assert.equal(validatePatch({ agents: { public: true } }, spec).diff.length, 0, 'public on is the default: no diff');
    for (const bad of [null, true, [], { public: 'yes' }, { free: true }]) assert.throws(() => validatePatch({ agents: bad }, spec), (e) => e.status === 400 && /agents/.test(e.message), JSON.stringify(bad));
  });
  test('MCP dispatch: initialize negotiates a version, notifications are silent, unknown methods and tools are errors', async () => {
    const bot = { id: 'b', name: 'B Bot' };
    const call = async (args) => ({ content: [{ type: 'text', text: args.question }] });
    const init = await mcpDispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { bot, call });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal((await mcpDispatch({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { bot, call })).result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.title, 'B Bot');
    assert.equal(await mcpDispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, { bot, call }), null);
    assert.equal((await mcpDispatch({ jsonrpc: '2.0', id: 3, method: 'nope' }, { bot, call })).error.code, -32601);
    assert.equal((await mcpDispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: {} } }, { bot, call })).error.code, -32602);
    const bad = await mcpDispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask', arguments: {} } }, { bot, call });
    assert.equal(bad.result.isError, true);
    assert.equal((await mcpDispatch({ id: 6, method: 'ping' }, { bot, call })).error.code, -32600);
    assert.deepEqual((await mcpDispatch({ jsonrpc: '2.0', id: 7, method: 'ping' }, { bot, call })).result, {});
  });
});

// ------------------------------------------------------------------ through the server
async function boot(env = {}) {
  const kd = await startFakeKnowDrive({ speed: 20 });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-agents-'));
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, leads: createLeads({ dataDir }), env: {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_PUBLIC_URL: 'https://kb.example.test', ...env,
  }, studio: { sweep: false, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  return { kd, llm, kb, base, api, dataDir, async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}
const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
async function liveBot(S) {
  await S.kb.registry.ready;
  assert.equal((await S.api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
  assert.equal((await S.api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'returns.md' }, body: DOC })).status, 201);
  assert.equal((await S.api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
  await S.kd.settle();
  return 'front-desk';
}
async function trialBot(S) {
  const t = await (await S.api('/api/studio/trials', { method: 'POST' })).json();
  const tok = { authorization: `Bearer ${t.token}` };
  assert.equal((await S.api(`/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: { ...tok, 'x-filename': 'returns.md', 'content-type': 'application/octet-stream' }, body: DOC })).status, 201);
  await S.kd.settle();
  const dk = await (await S.api(`/api/studio/trials/${t.trialId}/devkey`, { headers: tok })).json();
  return { id: t.trialId, token: t.token, key: dk.key, devkey: dk, patch: (body) => S.api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: { ...tok, 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}
/** A minimal MCP client over Streamable HTTP (JSON responses). */
function mcpClient(S, url, headers = {}) {
  let id = 0;
  const post = (msg) => S.api(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers }, body: JSON.stringify(msg) });
  return {
    post,
    async rpc(method, params) { const r = await post({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }); return { status: r.status, body: await r.json() }; },
    notify: (method, params) => post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
  };
}

describe('agents: the MCP server, REST ask and discovery (a launched bot)', () => {
  let S, bot, key;
  before(async () => {
    _resetQuestions(); configureQuestions({ debounceMs: 5 });
    S = await boot({ KNOWBOT_AGENT_FREE_PER_DAY: '100', KNOWBOT_AGENT_IP_RATE_LIMIT: '1000' });
    bot = await liveBot(S);
    key = (await (await S.api(`/api/instances/${bot}/keys`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'agents' }) })).json()).key;
  });
  after(async () => { _resetQuestions(); await S.close(); });

  test('MCP handshake: initialize → notifications/initialized → tools/list → tools/call, no key needed', async () => {
    const c = mcpClient(S, `/mcp/bots/${bot}`);
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.jsonrpc, '2.0');
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.body.result.serverInfo, { name: 'front-desk', title: 'Front Desk', version: '1.0.0' });
    assert.ok(init.body.result.capabilities.tools);
    const n = await c.notify('notifications/initialized');
    assert.equal(n.status, 202, 'a notification is accepted with no body');
    assert.equal((await n.text()), '');
    assert.deepEqual((await c.rpc('ping')).body.result, {});
    const list = await c.rpc('tools/list');
    assert.equal(list.body.result.tools.length, 1);
    const tool = list.body.result.tools[0];
    assert.equal(tool.name, 'ask');
    assert.equal(tool.title, 'Ask Front Desk');
    assert.match(tool.description, /Show the user the answer with its sources/);
    assert.doesNotMatch(JSON.stringify([init.body, list.body]), VENDORS, 'no vendor names');
    const call = await c.rpc('tools/call', { name: 'ask', arguments: { question: Q } });
    assert.equal(call.status, 200);
    const r = call.body.result;
    assert.notEqual(r.isError, true);
    const sc = r.structuredContent;
    assert.ok(['yes', 'partly'].includes(sc.answered), sc.answered);
    assert.match(sc.answer, /30 days/);
    assert.ok(sc.sources.length >= 1);
    assert.equal(typeof sc.sources[0].title, 'string');
    assert.match(sc.sources[0].quote, /30 days/);
    assert.doesNotMatch(sc.answer, /\]\(http/, 'plain text, no markdown links');
    assert.equal(r.content[0].type, 'text');
    assert.match(r.content[0].text, /\n\nSources:\n\[1\] /);
    assert.match(sc.proof_url, /^https:\/\/kb\.example\.test\/p\//);
    // the same answer as the chat bubble's pipeline (/v1/bots/:id/chat)
    const chat = await (await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: Q }) })).json();
    assert.deepEqual(sc.sources.map((s) => s.title), chat.citations.map((x) => x.title));
    assert.equal(sc.answer, chat.answer.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1').trim());
  });
  test('MCP: not in the files → answered "no" and the canonical refusal; unknown method, bad JSON, GET', async () => {
    const c = mcpClient(S, `/api/v1/bots/${bot}/mcp`);
    const sc = (await c.rpc('tools/call', { name: 'ask', arguments: { question: OFF } })).body.result.structuredContent;
    assert.deepEqual(sc, { answered: 'no', answer: NOT_IN_DATA, sources: [] });
    assert.equal((await c.rpc('resources/read', {})).body.error.code, -32601);
    const bad = await S.api(`/mcp/bots/${bot}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, -32700);
    const get = await S.api(`/mcp/bots/${bot}`);
    assert.equal(get.status, 405);
    const nob = await mcpClient(S, '/mcp/bots/no-such-bot').rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(nob.status, 404);
    assert.equal(nob.body.jsonrpc, '2.0');
    // CORS: a browser-based agent can call it
    const pre = await S.api(`/api/mcp/bots/${bot}`, { method: 'OPTIONS', headers: { origin: 'https://agent.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-protocol-version' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /mcp-protocol-version/);
  });
  test('REST ask: POST {question} and GET ?q= return the same structured result, CORS open', async () => {
    const r = await S.api(`/v1/bots/${bot}/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://agent.example' }, body: JSON.stringify({ question: Q }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const j = await r.json();
    assert.ok(['yes', 'partly'].includes(j.answered));
    assert.ok(j.sources.length >= 1);
    const g = await (await S.api(`/api/v1/bots/${bot}/ask?q=${encodeURIComponent(OFF)}`)).json();
    assert.deepEqual(g, { answered: 'no', answer: NOT_IN_DATA, sources: [] });
    const e = await S.api(`/v1/bots/${bot}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(e.status, 400);
    assert.equal((await S.api('/v1/bots/no-such-bot/ask?q=hi')).status, 404);
    // a bearer that is not a KnowBot key (an agent's own token) is ignored; a bad KnowBot key is refused
    assert.equal((await S.api(`/v1/bots/${bot}/ask?q=${encodeURIComponent(Q)}`, { headers: { authorization: 'Bearer some-oauth-token' } })).status, 200);
    assert.equal((await S.api(`/v1/bots/${bot}/ask?q=${encodeURIComponent(Q)}`, { headers: { authorization: 'Bearer kb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status, 401);
  });
  test('discovery: agent.json and llms.txt name the bot, its MCP and ask URLs, the limits and the terms', async () => {
    const m = await (await S.api(`/v1/bots/${bot}/agent.json`)).json();
    assert.equal(m.name, 'Front Desk');
    assert.equal(m.public, true);
    assert.equal(m.mcp.url, `https://kb.example.test/api/mcp/bots/${bot}`);
    assert.equal(m.mcp.transport, 'streamable-http');
    assert.equal(m.ask.url, `https://kb.example.test/api/v1/bots/${bot}/ask`);
    assert.equal(m.rate_limits.free_per_day, 100);
    assert.match(m.terms, /^https:\/\//);
    assert.equal(m.auth.required, false);
    const t = await S.api(`/api/v1/bots/${bot}/llms.txt`);
    assert.match(t.headers.get('content-type'), /^text\/plain/);
    const txt = await t.text();
    assert.match(txt, /^# Front Desk\n/);
    assert.ok(txt.includes(`(https://kb.example.test/api/mcp/bots/${bot})`));
    assert.doesNotMatch(txt + JSON.stringify(m), VENDORS);
    const idx = await (await S.api('/v1')).json();
    assert.ok(idx.endpoints.some((e) => e.path === '/v1/bots/{botId}/ask'));
  });
  test('counting: every agent question is in the questions loop on channel "agent"', async () => {
    await flushQuestions();
    const ins = await (await S.api(`/api/instances/${bot}/insights`, { headers: admin })).json();
    assert.ok(ins.byChannel.agent >= 2, JSON.stringify(ins.byChannel)); // the loop counts distinct questions per caller (10-minute de-duplication)
  });
});

describe('agents: free allowance, the owner\'s key, paid access, public off, Stats & Leads', () => {
  let S, bot, key, T;
  before(async () => {
    _resetQuestions(); configureQuestions({ debounceMs: 5 });
    S = await boot({ KNOWBOT_AGENT_FREE_PER_DAY: '3', KNOWBOT_AGENT_IP_RATE_LIMIT: '1000', KNOWBOT_AGENT_PAID_IP_RATE_LIMIT: '4', KNOWBOT_AGENT_PRICE_PER_1K: '12' });
    bot = await liveBot(S);
    key = (await (await S.api(`/api/instances/${bot}/keys`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'owner' }) })).json()).key;
    T = await trialBot(S);
  });
  after(async () => { _resetQuestions(); await S.close(); });
  const ask = (b, q = Q, headers = {}) => S.api(`/v1/bots/${b}/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ question: q }) });

  test('past the free allowance: REST 429 with the plain message, retry_after and how to lift it; MCP isError + limited', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await ask(bot, i === 1 ? OFF : Q)).status, 200, `free answer ${i + 1}`);
    const r = await ask(bot);
    assert.equal(r.status, 429);
    const ra = Number(r.headers.get('retry-after'));
    assert.ok(ra > 0 && ra <= 86400, `retry-after ${ra}`);
    const j = await r.json();
    assert.equal(j.answered, 'no');
    assert.equal(j.limited, true);
    assert.equal(j.answer, limitMessage(3));
    assert.equal(limitMessage(3), 'This bot has reached its free limit for AI agents today (3 answers a day). Its owner can turn on paid agent access in KnowBot Studio to lift the limit.');
    assert.equal(LIMIT_MESSAGE, limitMessage(20), 'the default allowance is 20 a day');
    assert.equal(j.retry_after, ra);
    assert.match(j.upgrade.price, /^\$12 per 1,000 agent answers$/);
    assert.equal(j.error.status, 429);
    const c = mcpClient(S, `/mcp/bots/${bot}`);
    assert.equal((await c.rpc('initialize', { protocolVersion: '2025-06-18' })).status, 200, 'the handshake still works');
    const call = await c.rpc('tools/call', { name: 'ask', arguments: { question: Q } });
    assert.equal(call.status, 200);
    assert.equal(call.body.result.isError, true);
    assert.equal(call.body.result.structuredContent.answered, 'no');
    assert.equal(call.body.result.structuredContent.limited, true);
    assert.ok(call.body.result.structuredContent.retry_after > 0);
    assert.equal(call.body.result.content[0].text, limitMessage(3));
  });
  test('the owner\'s own key (kb_live_ / kb_trial_) is never limited by the free allowance', async () => {
    const r = await ask(bot, Q, { authorization: `Bearer ${key}` });
    assert.equal(r.status, 200);
    assert.ok(Number(r.headers.get('x-ratelimit-limit')) > 0, 'the key\'s own rate limit applies');
    const c = mcpClient(S, `/mcp/bots/${bot}`, { authorization: `Bearer ${key}` });
    assert.notEqual((await c.rpc('tools/call', { name: 'ask', arguments: { question: Q } })).body.result.isError, true);
    // another bot's key is refused, never silently treated as anonymous
    assert.equal((await ask(bot, Q, { authorization: `Bearer ${T.key}` })).status, 403);
  });
  test('a Studio bot: public by default; its owner switches public answers off → 403 with a plain message; its trial key still works', async () => {
    assert.equal(T.devkey.agents.public, true);
    assert.equal(T.devkey.agents.paid, false);
    assert.equal(T.devkey.agents.freePerDay, 3);
    assert.equal(T.devkey.agents.priceText, '$12 per 1,000 agent answers');
    assert.match(T.devkey.agents.mcp, new RegExp(`/api/mcp/bots/${T.id}$`));
    assert.equal((await ask(T.id)).status, 200);
    assert.equal((await T.patch({ agents: { public: false } })).status, 200);
    const r = await ask(T.id);
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.answer, OFF_MESSAGE);
    assert.equal(j.answered, 'no');
    const m = await mcpClient(S, `/mcp/bots/${T.id}`).rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(m.status, 403);
    assert.equal(m.body.error.message, OFF_MESSAGE);
    assert.equal((await ask(T.id, Q, { authorization: `Bearer ${T.key}` })).status, 200, 'the owner can still try it');
    assert.equal((await (await S.api(`/v1/bots/${T.id}/agent.json`)).json()).public, false);
    assert.equal((await T.patch({ agents: { public: true } })).status, 200);
    assert.equal((await ask(T.id)).status, 200);
  });
  test('paid agent access replaces the free limit with metered usage; a per-address burst limit still applies', async () => {
    // the free allowance (3) is used up for this Studio bot after one more free answer
    for (let i = 0; i < 2; i++) await ask(T.id);
    assert.equal((await ask(T.id)).status, 429);
    assert.equal((await T.patch({ agents: { paid: true } })).status, 200);
    let ok = 0, last;
    for (let i = 0; i < 6; i++) { last = await ask(T.id); if (last.status === 200) ok++; else break; }
    assert.equal(ok, 4, 'four metered answers within the burst limit');
    assert.equal(last.status, 429);
    const j = await last.json();
    assert.equal(j.limited, true);
    assert.equal(j.reason, 'burst');
    assert.match(j.answer, /^Too many questions from this address at once/);
    const dk = await (await S.api(`/api/studio/trials/${T.id}/devkey`, { headers: { authorization: `Bearer ${T.token}` } })).json();
    assert.equal(dk.agents.paid, true);
    assert.equal(dk.agents.today.paid, 4);
    assert.equal(dk.agents.today.free, 3);
    assert.ok(dk.agents.today.owner >= 1);
  });
  test('Stats & Leads: an "AI agents" channel in interactions, agent counts, and CSV rows on channel agent', async () => {
    await flushQuestions();
    const H = { authorization: `Bearer ${T.token}` };
    const j = await (await S.api(`/api/studio/trials/${T.id}/leads?days=7`, { headers: H })).json();
    assert.ok(j.interactions.byChannel.agent >= 2, JSON.stringify(j.interactions.byChannel));
    assert.equal(j.agents.paid, 4);
    assert.equal(j.agents.free, 3);
    assert.ok(j.agents.limited >= 1);
    assert.ok(j.agents.owner >= 1);
    assert.equal(j.agents.questions, j.agents.answered + j.agents.refused);
    assert.equal(j.agentItems, undefined, 'the per-question list is only in the CSV');
    const csv = await (await S.api(`/api/studio/trials/${T.id}/leads.csv?days=7`, { headers: H })).text();
    const rows = csv.trim().split('\r\n').slice(1).map((l) => l.split(','));
    const agentRows = rows.filter((r) => r[2] === 'agent');
    assert.equal(agentRows.length, j.agents.questions);
    assert.ok(agentRows.every((r) => /^agent_(?:answered|refused)$/.test(r[3]) && ['free', 'paid', 'owner'].includes(r[14])));
    // the launched bot's usage is its own
    const live = await S.kb.leads.report([bot], { days: 7 });
    assert.equal(live.agents.free, 3);
    assert.ok(live.agents.limited >= 2);
  });
  test('usage survives a restart: the day\'s free count is read back from the recorded events', async () => {
    await S.kb.leads.idle();
    const L2 = createLeads({ dataDir: S.dataDir });
    const today = await L2.agentDay(bot);
    assert.equal(today.free, 3);
    assert.ok(today.owner >= 2);
  });
});

// Developer API (SPEC 11.2): /v1/bots/:id/chat (JSON + SSE), OpenAI-compatible /v1/chat/completions (JSON + chunks),
// per-bot kb_live_ keys (hashed + sealed), kb_trial_ keys, rate limits, CORS. Fakes only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { flushQuestions, configureQuestions, _resetQuestions, hashCaller } from '../questions.mjs';
import { NOT_IN_DATA } from '../../lib/knowbot.js';
import { proseAnswer, proseSentence } from '../devapi.mjs';

test('prose composer: bullet lines become sentences with inline [n], as the Studio shows them', () => {
  assert.equal(proseSentence('- returns are accepted within 30 days. [1]'), 'Returns are accepted within 30 days [1].');
  assert.equal(proseSentence('Is it waterproof? [2][3]'), 'Is it waterproof [2][3]?');
  assert.equal(proseSentence('- Model | Price | $1,200 [1]'), 'Model, Price, $1,200 [1].');
  assert.equal(proseAnswer('- You can return unused items within 30 days. [1]\n- Refunds take 5 business days [1]'),
    'You can return unused items within 30 days [1]. Refunds take 5 business days [1].');
  assert.equal(proseAnswer(''), '');
});

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const DOC = `# Returns policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.

# Shipping

We ship to Canada and the United States. Standard shipping takes 3 to 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const OFF = 'What is the capital of Australia?';

async function boot({ env = {}, devapi = {}, kdKey = true, corpusDir } = {}) {
  const kd = await startFakeKnowDrive({ speed: 20 });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-devapi-'));
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, ...(corpusDir ? { corpusDir } : {}), env: {
    KNOWDRIVE_BASE_URL: kd.url, ...(kdKey ? { KNOWDRIVE_API_KEY: 'fake-key' } : {}), KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', ...env,
  }, studio: { sweep: false, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 }, devapi });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
  return {
    kd, llm, kb, base, api, admin, dataDir,
    async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); },
  };
}
async function setupBot(S) {
  await S.kb.registry.ready;
  assert.equal((await S.api('/api/buckets', { method: 'POST', headers: S.admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
  assert.equal((await S.api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'returns.md' }, body: DOC })).status, 201);
  assert.equal((await S.api('/api/instances', { method: 'POST', headers: S.admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
  await S.kd.settle();
  return 'front-desk';
}
async function newKey(S, bot, name = 'test') {
  const r = await S.api(`/api/instances/${bot}/keys`, { method: 'POST', headers: S.admin, body: JSON.stringify({ name }) });
  assert.equal(r.status, 201);
  return r.json();
}
function parseSSE(text) {
  return text.split('\n\n').map((fr) => {
    const ev = /^event: (.*)$/m.exec(fr)?.[1];
    return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null;
  }).filter(Boolean);
}
const dataLines = (text) => text.split('\n\n').map((fr) => /^data: (.*)$/m.exec(fr)?.[1]).filter(Boolean);
/** The headers the official OpenAI Node SDK sends (v4/v5): changing baseURL is all a developer does. */
const sdkHeaders = (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'OpenAI/JS 4.104.0',
  'x-stainless-lang': 'js', 'x-stainless-package-version': '4.104.0', 'x-stainless-os': 'Linux', 'x-stainless-arch': 'x64', 'x-stainless-runtime': 'node', 'x-stainless-runtime-version': 'v22.0.0', 'x-stainless-retry-count': '0' });

describe('developer API (knowDrive mode)', () => {
  let S, bot, K;
  before(async () => {
    _resetQuestions(); configureQuestions({ debounceMs: 5 });
    S = await boot();
    bot = await setupBot(S);
    K = await newKey(S, bot, 'website');
  });
  after(async () => { _resetQuestions(); await S.close(); });
  const auth = (k = K.key) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

  test('keys: created by an admin, shown once, listed without the secret, stored only as a hash inside a sealed document', async () => {
    assert.match(K.key, /^kb_live_[A-Za-z0-9_-]{43}$/);
    assert.equal(K.bot, bot);
    assert.equal(K.last4, K.key.slice(-4));
    assert.equal((await S.api(`/api/instances/${bot}/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'admin only');
    const list = await (await S.api(`/api/instances/${bot}/keys`, { headers: S.admin })).json();
    assert.equal(list.keys.length, 1);
    assert.ok(!JSON.stringify(list).includes(K.key.slice(8, 30)), 'the key is never listed');
    assert.equal(list.keys[0].name, 'website');
    const stored = [...S.kd.files.values()].find((f) => f.filename === 'knowbot/_config/devkeys.json');
    assert.ok(stored, 'persisted to knowDrive');
    assert.ok(stored.tags.includes('kind:config'), 'kind:config: never searchable');
    const raw = stored.raw ?? stored.text;
    assert.ok(!raw.includes(K.key) && !raw.includes(createHash('sha256').update(K.key).digest('hex')), 'neither the key nor its hash is readable');
    assert.match(JSON.parse(raw).sealed, /^v1\./, 'AES-256-GCM sealed');
    assert.equal((await S.api('/api/instances/nope/keys', { headers: S.admin })).status, 404);
  });

  test('POST /v1/bots/:id/preview: the reply exactly as SMS, WhatsApp or email would send it', async () => {
    const post = (body) => S.api(`/v1/bots/${bot}/preview`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
    const sms = await (await post({ channel: 'sms', question: Q })).json();
    assert.equal(sms.channel, 'sms');
    assert.equal(sms.refused, false);
    assert.ok(sms.text.length <= 320, `SMS fits: ${sms.text.length}`);
    assert.match(sms.text, /30 days/);
    assert.match(sms.text, /\[1\]/);
    assert.match(sms.text, /Proof: http/);
    const wa = await (await post({ channel: 'whatsapp', question: Q })).json();
    assert.match(wa.text, /\*Sources\*/);
    const em = await (await post({ channel: 'email', question: Q })).json();
    assert.match(em.subject, /^Re: /);
    assert.match(em.text, /Sources/);
    assert.match(em.html, /<sup/);
    const off = await (await post({ channel: 'sms', question: 'What is the capital of Australia?' })).json();
    assert.equal(off.refused, true);
    assert.equal((await post({ channel: 'fax', question: Q })).status, 400);
    assert.equal((await S.api(`/v1/bots/${bot}/preview`, { method: 'POST', body: JSON.stringify({ channel: 'sms', question: Q }) })).status, 401);
  });

  test('POST /v1/bots/:id/chat answers with citations, real similarities (never RRF) and a proof link', async () => {
    const r = await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ question: Q }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.ok(Number(r.headers.get('x-ratelimit-limit')) > 0);
    const j = await r.json();
    assert.match(j.id, /^ans_/);
    assert.equal(j.refused, false);
    assert.equal(j.grounded, true);
    assert.match(j.answer, /30 days[^\n]*\[1\]/);
    assert.ok(!/^\s*[-*•]\s/m.test(j.answer) && !j.answer.includes('\n'), `prose like the Studio, not a bullet list: ${j.answer}`);
    // the citation sits inline before the stop; the librarian voice may add one courtesy closer (no fact, no marker) after it
    assert.match(j.answer, /^[A-Z].*\[1\][.!?](?: [A-Z][^[\]\d“”"]*[.!?])?$/, 'sentences with the citation inline before the stop');
    assert.match(j.answer, /“[^”]*30 days[^”]*” \[1\]/, 'the librarian voice quotes the source line verbatim, in curly quotes, cited');
    assert.equal(j.format, 'prose');
    const b = await (await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ question: Q, format: 'bullets' }) })).json();
    assert.equal(b.format, 'bullets');
    assert.match(b.answer, /30 days.*\[1\]$/m, 'format:"bullets" keeps one cited claim per line, marks at the end');
    // page and section appear only when the source really has them (url too); nothing else is added
    const keys = Object.keys(j.citations[0]);
    for (const k of ['excerpt', 'file', 'n', 'spans', 'title']) assert.ok(keys.includes(k), `citation has ${k}`);
    for (const k of keys) assert.ok(['excerpt', 'file', 'n', 'spans', 'title', 'page', 'section', 'url'].includes(k), `unexpected citation key ${k}`);
    if ('page' in j.citations[0]) assert.ok(Number.isInteger(j.citations[0].page) && j.citations[0].page > 0);
    if ('section' in j.citations[0]) assert.equal(typeof j.citations[0].section, 'string');
    for (const c of j.citations) {
      assert.ok(!c.excerpt.includes(' … '), `one footnote is one verbatim span, never two lines stitched: ${c.excerpt}`);
      assert.equal(c.excerpt, c.spans[0], 'excerpt is the first verbatim span');
      for (const sp of c.spans) assert.ok(DOC.includes(sp.replace(/\.$/, '')), `span "${sp}" is verbatim`);
    }
    assert.equal(j.citations[0].n, 1);
    assert.match(j.citations[0].file, /returns\.md$/);
    assert.ok(DOC.includes(j.citations[0].excerpt.replace(/\.$/, '')), 'the excerpt is the quoted line');
    for (const h of j.proof.hits) {
      assert.ok(h.similarity >= 0.55 && h.similarity <= 0.95, `similarity ${h.similarity}`);
      assert.ok(h.similarity > 0.1, 'an RRF score (~0.016) is never shown as similarity');
    }
    assert.ok(j.proof.quoted.length >= 1);
    for (const q of j.proof.quoted) assert.ok(DOC.includes(q.text.replace(/\.$/, '')), `quoted "${q.text}" is verbatim`);
    assert.equal(typeof j.usage.latencyMs, 'number');
    assert.match(j.proofUrl, /^https?:\/\/[^/]+\/p\/[A-Za-z0-9_-]+$/, 'one short public proof-link form on every surface: <origin>/p/<id>');
    assert.equal((await S.api(new URL(j.proofUrl).pathname.replace(/^\/p\//, '/api/p/'))).status, 200, '/api/p/<id> stays an alias');
    const oai = await (await S.api('/v1/chat/completions', { method: 'POST', headers: auth(), body: JSON.stringify({ model: bot, messages: [{ role: 'user', content: Q }] }) })).json();
    assert.equal(new URL(oai.knowbot.proofUrl).pathname.replace(/[^/]+$/, ''), new URL(j.proofUrl).pathname.replace(/[^/]+$/, ''), '/v1/chat/completions and /v1/bots/:id/chat hand out the same proofUrl form');
    for (const line of oai.choices[0].message.content.split('\n').filter((l) => /^\[\d+\] /.test(l))) {
      assert.ok(!/^\[\d+\] [a-z]/.test(line), `footnote titles are never a lower-cased slug: ${line}`);
    }
    const proof = await fetch(j.proofUrl.replace(/^https?:\/\/[^/]+/, S.base));
    assert.equal(proof.status, 200);
    const html = await proof.text();
    assert.match(proof.headers.get('content-type'), /text\/html/);
    assert.ok(html.includes('<mark>') && html.includes('within 30 days'));
    // branded like the Studio: KnowDrive type system, wordmark, "answered only from <bot>'s files", mono metadata
    assert.ok(/fonts\.googleapis\.com\/css2\?family=Plus\+Jakarta\+Sans[^"]*Inter[^"]*JetBrains\+Mono/.test(html), 'loads the Studio fonts');
    assert.ok(!/ui-sans-serif/.test(html));
    assert.match(html, /Know<b>Bot<\/b>/);
    assert.match(html, /Answered only from [^<]+ files/);
    assert.match(html, /<div class="meta mono"><span class="file">returns\.md<\/span>/);
    assert.ok(!/aria-label="source/.test(html), 'no aria-label that hides the visible citation number');
    const csp = proof.headers.get('content-security-policy');
    assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
    assert.match(csp, /default-src 'none'/);
    assert.equal((await S.api('/p/doesnotexist1')).status, 404);
  });

  test('messages[] form: the last user message is the question, earlier turns are history', async () => {
    const j = await (await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ messages: [
      { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello! Ask me anything.' }, { role: 'user', content: [{ type: 'text', text: Q }] }] }) })).json();
    assert.equal(j.question, Q);
    assert.equal(j.refused, false);
    assert.equal((await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }] }) })).status, 400);
    assert.equal((await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: '{nope' })).status, 400);
  });

  test('stream: true → SSE retrieval, delta+, final, done', async () => {
    const r = await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ question: Q, stream: true }) });
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const ev = parseSSE(await r.text());
    const names = ev.map((e) => e.event);
    assert.equal(names[0], 'retrieval');
    assert.ok(names.filter((n) => n === 'delta').length >= 1);
    assert.deepEqual(names.slice(-2), ['final', 'done']);
    assert.ok(ev[0].data.hits.every((h) => h.similarity === null || h.similarity > 0.5));
    const fin = ev.find((e) => e.event === 'final').data;
    assert.equal(fin.refused, false);
    assert.equal(ev.filter((e) => e.event === 'delta').map((e) => e.data.raw).join(''), fin.answer, 'the deltas concatenate to the final answer');
    const plain = await (await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ question: Q }) })).json();
    assert.equal(fin.answer, plain.answer, 'streamed and JSON answers are the same text');
  });

  test('a question outside the files gets the canonical refusal, exactly', async () => {
    const j = await (await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ question: OFF }) })).json();
    assert.equal(j.answer, NOT_IN_DATA);
    assert.equal(j.refused, true);
    assert.equal(j.grounded, false);
    assert.deepEqual(j.citations, []);
    assert.equal(j.proofUrl, undefined);
  });

  test('auth: missing, malformed, unknown, wrong-bot and revoked keys', async () => {
    const ask = (headers, b = bot) => S.api(`/v1/bots/${b}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ question: Q }) });
    let r = await ask({});
    assert.equal(r.status, 401);
    const e1 = await r.json();
    assert.deepEqual([e1.error.code, e1.error.type], ['missing_api_key', 'authentication_error']);
    assert.equal((await (await ask({ authorization: 'Bearer sk-not-ours' })).json()).error.code, 'invalid_api_key');
    assert.equal((await ask({ authorization: `Bearer kb_live_${'A'.repeat(43)}` })).status, 401);
    // a well-prefixed key that fails to verify is called invalid/revoked/expired, never "not a KnowBot key"
    for (const bad of ['kb_trial_bogus', `kb_live_${'B'.repeat(43)}`, `kb_trial_${'C'.repeat(40)}.x`]) {
      const e = (await (await ask({ authorization: `Bearer ${bad}` })).json()).error;
      assert.deepEqual([e.code, e.message], ['invalid_api_key', 'This API key is invalid, revoked or expired.'], bad);
    }
    assert.match((await (await ask({ authorization: 'Bearer sk-not-ours' })).json()).error.message, /start with kb_live_ or kb_trial_/);
    r = await ask({ authorization: `Bearer ${K.key}` }, 'ugm');
    assert.equal(r.status, 403);
    const wb = await r.json();
    assert.equal(wb.error.code, 'wrong_bot');
    assert.equal(wb.error.message, 'This key is not valid for this bot.');
    assert.ok(!JSON.stringify(wb).includes(bot), 'the key\'s own bot id is never echoed to a prober');
    const K2 = await newKey(S, bot, 'temp');
    assert.equal((await ask({ authorization: `Bearer ${K2.key}` })).status, 200);
    const del = await S.api(`/api/instances/${bot}/keys/${K2.id}`, { method: 'DELETE', headers: S.admin });
    assert.equal(del.status, 200);
    assert.ok((await del.json()).revokedAt);
    assert.equal((await ask({ authorization: `Bearer ${K2.key}` })).status, 401, 'revoked keys stop working at once');
  });

  test('OpenAI-compatible /v1/chat/completions: the exact request the SDK sends, a valid chat.completion back', async () => {
    const r = await S.api('/v1/chat/completions', { method: 'POST', headers: sdkHeaders(K.key), body: JSON.stringify({ model: bot, messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: Q }], temperature: 0.7 }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.id, /^chatcmpl-/);
    assert.equal(j.object, 'chat.completion');
    assert.equal(typeof j.created, 'number');
    assert.equal(j.model, bot);
    assert.equal(j.choices.length, 1);
    const c = j.choices[0];
    assert.equal(c.index, 0);
    assert.equal(c.finish_reason, 'stop');
    assert.equal(c.message.role, 'assistant');
    assert.match(c.message.content, /30 days[^\n]*\[1\]/);
    assert.match(c.message.content, /\n\n\[1\] .*returns\.md$/m, 'citations appended as numbered footnotes');
    for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) assert.equal(typeof j.usage[k], 'number');
    // usage is never a token count of the bare question: the grounded prompt (system + quoted context + question) is
    // metered, and an estimate says so (the fake model reports no usage)
    assert.equal(j.knowbot.usageEstimated, true);
    assert.ok(j.usage.prompt_tokens > Math.ceil(Q.length / 4) * 3, `prompt_tokens ${j.usage.prompt_tokens} covers the full grounded prompt`);
    assert.equal(j.usage.total_tokens, j.usage.prompt_tokens + j.usage.completion_tokens);
    assert.ok(j.usage.completion_tokens >= Math.ceil(c.message.content.length / 4) - 1);
    assert.equal(j.knowbot.refused, false);
    assert.equal(j.knowbot.citations[0].n, 1);
    assert.ok(j.knowbot.proof.quoted.length >= 1);

    const ref = await (await S.api('/v1/chat/completions', { method: 'POST', headers: sdkHeaders(K.key), body: JSON.stringify({ model: bot, messages: [{ role: 'user', content: OFF }] }) })).json();
    assert.equal(ref.choices[0].message.content, NOT_IN_DATA);
    assert.equal(ref.knowbot.refused, true);

    const bad = await S.api('/v1/chat/completions', { method: 'POST', headers: sdkHeaders(K.key), body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: Q }] }) });
    assert.equal(bad.status, 404);
    const be = await bad.json();
    assert.deepEqual([be.error.code, be.error.type, typeof be.error.message], ['model_not_found', 'not_found_error', 'string']);
    const models = await (await S.api('/v1/models', { headers: sdkHeaders(K.key) })).json();
    assert.deepEqual(models, { object: 'list', data: [{ id: bot, object: 'model', created: 0, owned_by: 'knowbot' }] });
  });

  test('OpenAI streaming: chat.completion.chunk objects, role first, the same content, knowbot on the last chunk, usage, [DONE]', async () => {
    const plain = await (await S.api('/v1/chat/completions', { method: 'POST', headers: sdkHeaders(K.key), body: JSON.stringify({ model: bot, messages: [{ role: 'user', content: Q }] }) })).json();
    const r = await S.api('/v1/chat/completions', { method: 'POST', headers: { ...sdkHeaders(K.key), accept: 'text/event-stream' },
      body: JSON.stringify({ model: bot, messages: [{ role: 'user', content: Q }], stream: true, stream_options: { include_usage: true } }) });
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const lines = dataLines(await r.text());
    assert.equal(lines.at(-1), '[DONE]');
    const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
    for (const ch of chunks) { assert.equal(ch.object, 'chat.completion.chunk'); assert.match(ch.id, /^chatcmpl-/); assert.equal(ch.model, bot); }
    assert.equal(new Set(chunks.map((c) => c.id)).size, 1);
    assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
    const withChoices = chunks.filter((c) => c.choices.length);
    const content = withChoices.map((c) => c.choices[0].delta.content || '').join('');
    assert.equal(content, plain.choices[0].message.content);
    const pieces = withChoices.map((c) => c.choices[0].delta.content).filter(Boolean);
    assert.ok(pieces.length >= 8 && pieces.length > content.split('\n').length, `token-sized deltas, not one per line (${pieces.length})`);
    assert.ok(pieces.every((p) => p.length < 60), 'no delta carries a whole answer');
    const last = withChoices.at(-1);
    assert.equal(last.choices[0].finish_reason, 'stop');
    assert.equal(last.knowbot.refused, false);
    const usage = chunks.at(-1);
    assert.deepEqual(usage.choices, []);
    assert.equal(typeof usage.usage.total_tokens, 'number');
  });

  test('CORS: preflight for the SDK headers, and readable rate-limit headers', async () => {
    const pre = await S.api('/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-stainless-lang' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
    assert.match(pre.headers.get('access-control-allow-headers'), /x-stainless-lang/);
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
    for (const h of ['retry-after', 'x-request-id', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) assert.match(pre.headers.get('access-control-expose-headers'), new RegExp(h), `preflight exposes ${h}`);
    const r = await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: { ...auth(), origin: 'https://app.example.com' }, body: JSON.stringify({ question: Q }) });
    assert.match(r.headers.get('access-control-expose-headers'), /x-ratelimit-remaining/);
    assert.match(r.headers.get('access-control-expose-headers'), /retry-after/);
    assert.match(r.headers.get('x-request-id') || '', /^req_[A-Za-z0-9]+$/, 'every /v1 response carries x-request-id');
    assert.ok(Number(r.headers.get('x-ratelimit-limit-requests')) > 0, 'OpenAI rate-limit header names, so SDK backoff works');
    assert.match(r.headers.get('x-ratelimit-reset-requests') || '', /^\d+s$/);
    await r.text();
    const bad = await S.api('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401); assert.match(bad.headers.get('x-request-id') || '', /^req_/, 'errors carry x-request-id too'); await bad.text();
  });

  test('every API call is logged to the questions loop as channel:api, with the caller hashed', async () => {
    await flushQuestions();
    const files = [...S.kd.files.values()].filter((f) => f.tags.includes('questions') && f.tags.includes(`bot:${bot}`));
    const api = files.filter((f) => f.tags.includes('channel:api'));
    assert.ok(api.length >= 2);
    assert.ok(api.every((f) => f.filename.startsWith(`knowbot/_bots/${bot}/questions/`)));
    assert.ok(api.some((f) => f.tags.includes(`from:${hashCaller(K.id)}`)));
    assert.ok(api.some((f) => f.tags.includes('outcome:refused')) && api.some((f) => f.tags.includes('outcome:answered')));
    for (const f of files) assert.ok(!f.text.includes(K.key) && !f.tags.join(',').includes(K.key.slice(8, 20)));
  });

  test('trial keys: handed to the trial token holder, scoped to that trial, expiring with it', async () => {
    const t = await (await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.40' } })).json();
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'x-filename': 'returns.md', 'content-type': 'application/octet-stream' }, body: DOC })).status, 201);
    await S.kd.settle();
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}/devkey`)).status, 401);
    const dk = await (await S.api(`/api/studio/trials/${t.trialId}/devkey`, { headers: { authorization: `Bearer ${t.token}` } })).json();
    assert.match(dk.key, /^kb_trial_/);
    assert.equal(dk.botId, t.trialId);
    assert.equal(dk.expiresAt, t.expiresAt);
    assert.equal(typeof dk.voice.google, 'boolean');
    assert.match(dk.endpoints.chat, new RegExp(`/api/v1/bots/${t.trialId}/chat$`));
    // the devkey and the channel status hand out the same base
    assert.match(dk.channels.sms.webhook, new RegExp(`/api/v1/channels/${t.trialId}/sms$`));
    assert.equal(dk.endpoints.channels.replace(/\/channels\/.*$/, ''), dk.channels.sms.webhook.replace(/\/channels\/.*$/, ''));
    // every URL the devkey payload advertises resolves on this server (no 404s: /lib/embed.js lives at the site root)
    assert.match(dk.channels.chat.embed, /^https?:\/\/[^/]+\/lib\/embed\.js$/);
    const advertised = [];
    const walk = (o) => { for (const v of Object.values(o || {})) { if (typeof v === 'string' && /^https?:\/\//.test(v)) advertised.push(v); else if (v && typeof v === 'object') walk(v); } };
    walk(dk);
    assert.ok(advertised.length >= 8, `advertised ${advertised.length} URLs`);
    for (const u of new Set(advertised)) {
      const local = u.replace(/^https?:\/\/[^/]+/, S.base);
      const isPost = !/\/lib\/embed\.js$|\/v1\/channels\/[^/]+$/.test(u);
      const r = isPost ? await S.api(local.replace(S.base, ''), { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } })
        : await S.api(local.replace(S.base, ''), { headers: { authorization: `Bearer ${dk.key}` } });
      assert.notEqual(r.status, 404, `${u} → 404`);
      assert.ok(r.status < 500 || r.status === 503, `${u} → ${r.status}`);
      if (/embed\.js$/.test(u)) { assert.equal(r.status, 200); assert.match(r.headers.get('content-type') || '', /javascript/); }
    }
    const again = await (await S.api(`/api/studio/trials/${t.trialId}/devkey`, { headers: { authorization: `Bearer ${t.token}` } })).json();
    assert.equal(again.key, dk.key, 'stable for the life of the trial');
    const j = await (await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: auth(dk.key), body: JSON.stringify({ question: Q }) })).json();
    assert.equal(j.refused, false, j.answer);
    assert.equal(j.citations[0].file, 'returns.md');
    const o = await (await S.api('/v1/chat/completions', { method: 'POST', headers: sdkHeaders(dk.key), body: JSON.stringify({ model: t.trialId, messages: [{ role: 'user', content: Q }] }) })).json();
    assert.equal(o.model, t.trialId);
    assert.equal((await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(dk.key), body: JSON.stringify({ question: Q }) })).status, 403, 'a trial key cannot reach another bot');
    // an expired key (same signing scheme, past expiry) is refused
    const payload = Buffer.from(JSON.stringify({ t: t.trialId, e: Date.now() - 1000 })).toString('base64url');
    const sig = createHmac('sha256', 'knowbot-devkey\ndev-secret').update(payload).digest().subarray(0, 18).toString('base64url');
    const ex = await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: auth(`kb_trial_${payload}.${sig}`), body: JSON.stringify({ question: Q }) });
    assert.equal(ex.status, 401);
    assert.equal((await ex.json()).error.code, 'expired_api_key');
    const forged = await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: auth(`kb_trial_${payload}.AAAAAAAAAAAAAAAAAAAAAAAA`), body: JSON.stringify({ question: Q }) });
    assert.equal(forged.status, 401);
    await flushQuestions();
    const logged = [...S.kd.files.values()].filter((f) => f.tags.includes('questions') && f.tags.includes(`trial:${t.trialId}`) && f.tags.includes('channel:api'));
    assert.ok(logged.length >= 1);
    assert.ok(logged[0].filename.startsWith(`knowbot/trials/${t.trialId}/questions/`));
    assert.ok(logged[0].tags.includes('kind:trial') && logged[0].tags.some((x) => x.startsWith('expires:')), 'swept with the trial');
  });

  test('voice endpoint: text in works without Google; raw audio without Google says so clearly', async () => {
    const j = await (await S.api(`/v1/bots/${bot}/voice`, { method: 'POST', headers: auth(), body: JSON.stringify({ text: Q }) })).json();
    assert.equal(j.transcript, Q);
    assert.match(j.spoken, /^According to .+, you can return/i);
    assert.ok(!/\[\d\]/.test(j.spoken), 'no markers in speech');
    assert.equal(j.audio, null);
    const r = await S.api(`/v1/bots/${bot}/voice`, { method: 'POST', headers: { authorization: `Bearer ${K.key}`, 'content-type': 'audio/webm' }, body: Buffer.from('fake') });
    assert.equal(r.status, 503);
    const e = await r.json();
    assert.equal(e.error.code, 'voice_not_configured');
    assert.equal(e.error.fallback, 'browser');
  });

  test('index and OpenAPI description', async () => {
    const idx = await (await S.api('/v1')).json();
    assert.equal(idx.version, 'v1');
    assert.equal(idx.refusal, NOT_IN_DATA);
    // one base for every snippet: the index names it, says /v1 and /api/v1 are aliases, and every endpoint url uses it
    assert.match(idx.base, /^https?:\/\/[^/]+\/api\/v1$/);
    assert.equal(idx.aliases.length, 2);
    assert.match(idx.note, /aliases/);
    for (const e of idx.endpoints) assert.ok(e.url.startsWith(idx.base.replace(/\/v1$/, '')) && e.url.includes('/api/v1/'), e.url);
    assert.deepEqual((await (await S.api('/api/v1')).json()).base, idx.base);
    const chV1 = await (await S.api(`/v1/channels/${bot}`)).json(), chApi = await (await S.api(`/api/v1/channels/${bot}`)).json();
    assert.deepEqual(chV1, chApi, 'the same URLs whichever alias was called');
    assert.ok(chV1.channels.sms.webhook.startsWith(idx.base + '/channels/'), chV1.channels.sms.webhook);
    const oa = await (await S.api('/v1/openapi.json')).json();
    assert.equal(oa.openapi, '3.1.0');
    assert.ok(oa.paths['/v1/chat/completions'] && oa.paths['/v1/bots/{botId}/chat']);
    assert.equal((await S.api('/v1/nope')).status, 404);
    // the same API under /api/v1 (the production Worker forwards /api/* only), with proof links that follow the prefix
    const viaApi = await (await S.api(`/api/v1/bots/${bot}/chat`, { method: 'POST', headers: auth(), body: JSON.stringify({ question: Q }) })).json();
    assert.equal(viaApi.refused, false);
    assert.match(viaApi.proofUrl, /^https?:\/\/[^/]+\/p\/[A-Za-z0-9_-]+$/, 'the same short proof link whichever alias was called');
    assert.equal((await S.api(new URL(viaApi.proofUrl).pathname)).status, 200);
    const oai = await S.api('/api/v1/chat/completions', { method: 'POST', headers: sdkHeaders(K.key), body: JSON.stringify({ model: bot, messages: [{ role: 'user', content: Q }] }) });
    assert.equal((await oai.json()).object, 'chat.completion');
    assert.equal((await S.api('/v1/chat/completions')).status, 405);
  });
});

describe('developer API: rate limit per key', () => {
  let S, bot, K;
  before(async () => { _resetQuestions(); S = await boot({ devapi: { limits: { live: 2 } } }); bot = await setupBot(S); K = await newKey(S, bot); });
  after(async () => { _resetQuestions(); await S.close(); });
  test('the third call in a minute is 429 with retry-after and x-ratelimit-*; another key is unaffected', async () => {
    const ask = (k) => S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: Q }) });
    const a = await ask(K.key); assert.equal(a.headers.get('x-ratelimit-remaining'), '1'); await a.text();
    const b = await ask(K.key); assert.equal(b.headers.get('x-ratelimit-remaining'), '0'); await b.text();
    const c = await ask(K.key);
    assert.equal(c.status, 429);
    assert.ok(Number(c.headers.get('retry-after')) >= 1);
    assert.equal(c.headers.get('x-ratelimit-remaining-requests'), '0');
    assert.match(c.headers.get('access-control-expose-headers'), /retry-after/);
    const e = await c.json();
    assert.deepEqual([e.error.type, e.error.code], ['rate_limit_error', 'rate_limit_exceeded']);
    const K2 = await newKey(S, bot);
    assert.equal((await ask(K2.key)).status, 200);
  });
});

describe('developer API: behind the production Worker (forwards /api/* only)', () => {
  let S, bot, K;
  before(async () => { _resetQuestions(); S = await boot({ env: { KNOWBOT_TRUST_PROXY: '1' } }); bot = await setupBot(S); K = await newKey(S, bot); });
  after(async () => { _resetQuestions(); await S.close(); });
  test('proof links keep the /api prefix there, so they still resolve', async () => {
    const j = await (await S.api(`/v1/bots/${bot}/chat`, { method: 'POST', headers: { authorization: `Bearer ${K.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: Q }) })).json();
    assert.match(j.proofUrl, /^https?:\/\/[^/]+\/api\/p\/[A-Za-z0-9_-]+$/);
    assert.equal((await S.api(new URL(j.proofUrl).pathname)).status, 200);
  });
});

describe('developer API: local mode (no knowDrive)', () => {
  let S, corpus;
  before(async () => {
    _resetQuestions();
    corpus = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-corpus-'));
    await fsp.writeFile(path.join(corpus, 'returns.md'), `---\ntitle: Returns policy\n---\n${DOC}`);
    S = await boot({ kdKey: false, corpusDir: corpus });
  });
  after(async () => { _resetQuestions(); await S.close(); await fsp.rm(corpus, { recursive: true, force: true }); });
  test('keys live in the data dir (sealed); a keyword hit shows "keyword match", never a made-up similarity', async () => {
    const K = await newKey(S, 'ugm');
    const raw = await fsp.readFile(path.join(S.dataDir, 'devkeys.json'), 'utf8');
    assert.ok(!raw.includes(K.key));
    const j = await (await S.api('/v1/bots/ugm/chat', { method: 'POST', headers: { authorization: `Bearer ${K.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: Q }) })).json();
    assert.equal(j.refused, false, j.answer);
    assert.ok(j.proof.hits.length >= 1);
    for (const h of j.proof.hits) { assert.equal(h.similarity, null); assert.equal(h.label, 'keyword match'); }
    const ins = await (await S.api('/api/instances/ugm/insights', { headers: S.admin })).json();
    assert.equal(ins.source, 'memory');
    assert.equal(ins.top[0].q, Q);
  });
});

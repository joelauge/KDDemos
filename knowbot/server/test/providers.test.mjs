// Hosted answering platforms against local stand-ins: request shapes, refusals, key errors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { completeWith, listModels } from '../providers.mjs';

let srv, calls = [];
before(async () => {
  srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      calls.push({ url: req.url, headers: req.headers, body });
      const json = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers['x-api-key'] === 'bad' || req.headers.authorization === 'Bearer bad') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (req.url.startsWith('/v1/messages')) {
        if (body.messages.at(-1).content.includes('REFUSE')) return json(200, { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } });
        return json(200, { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'L2' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      }
      if (req.url.startsWith('/v1/models')) return json(200, { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' });
      if (req.url === '/oa/chat/completions') {
        if (body.temperature !== undefined && body.model.startsWith('o')) return json(400, { error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } });
        return json(200, { choices: [{ message: { role: 'assistant', content: 'L1' } }] });
      }
      if (req.url === '/oa/models') return json(200, { data: [{ id: 'gpt-4.1-mini' }, { id: 'text-embedding-3-small' }, { id: 'o4-mini' }] });
      json(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.KNOWBOT_ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.KNOWBOT_OPENAI_BASE_URL = `http://127.0.0.1:${srv.address().port}/oa`;
});
after(() => new Promise((r) => srv.close(r)));

const msgs = (q) => [{ role: 'system', content: 'Pick lines.' }, { role: 'user', content: q }];
const SELECT = { max_tokens: 24, temperature: 0, seed: 7 };

test('Claude: system split out, no sampling params, low effort for line picking, refusal fallback on current models', async () => {
  assert.equal(await completeWith('anthropic', 'k', 'claude-opus-5-5', msgs('Q?'), SELECT), 'L2');
  const c = calls.at(-1);
  assert.equal(c.body.system, 'Pick lines.');
  assert.deepEqual(c.body.messages, [{ role: 'user', content: 'Q?' }]);
  assert.equal(c.body.temperature, undefined); assert.equal(c.body.seed, undefined);
  assert.deepEqual(c.body.output_config, { effort: 'low' });
  assert.equal(c.body.fallbacks, 'default');
  assert.match(c.headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
  assert.ok(c.body.max_tokens >= 2000, 'room for thinking before the line numbers');
  await completeWith('anthropic', 'k', 'claude-haiku-4-5', msgs('Q?'), { max_tokens: 300 });
  assert.equal(calls.at(-1).body.output_config, undefined, 'no effort on models that reject it');
  assert.equal(calls.at(-1).body.fallbacks, undefined);
});

test('Claude: a refusal answers nothing, and a bad key is a clear 401', async () => {
  assert.equal(await completeWith('anthropic', 'k', 'claude-sonnet-5-5', msgs('REFUSE'), SELECT), '');
  await assert.rejects(completeWith('anthropic', 'bad', 'claude-opus-5-5', msgs('Q?'), SELECT), (e) => e.status === 401 && /rejected the API key/.test(e.message));
  assert.deepEqual((await listModels('anthropic', 'k')).map((m) => m.id), ['claude-opus-5-5']);
});

test('OpenAI: chat completions, temperature dropped for models that refuse it, chat models listed', async () => {
  assert.equal(await completeWith('openai', 'k', 'gpt-4.1-mini', msgs('Q?'), SELECT), 'L1');
  assert.equal(calls.at(-1).body.temperature, 0);
  assert.equal(await completeWith('openai', 'k', 'o4-mini', msgs('Q?'), SELECT), 'L1');
  assert.equal(calls.at(-1).body.temperature, undefined, 'retried without temperature');
  assert.deepEqual((await listModels('openai', 'k')).map((m) => m.id), ['gpt-4.1-mini', 'o4-mini']);
  await assert.rejects(completeWith('openai', 'bad', 'gpt-4.1-mini', msgs('Q?'), SELECT), (e) => e.status === 401);
});

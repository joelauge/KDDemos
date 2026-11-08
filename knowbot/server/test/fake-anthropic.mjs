// A scriptable stand-in for the Anthropic Messages API on 127.0.0.1 (never the network). It speaks the wire shape the
// official @anthropic-ai/sdk sends and expects (POST /v1/messages, GET /v1/models), so tests can drive the real SDK.
//
//   const fake = await startFakeAnthropic({ latencyMs: 0 });
//   fake.push(toolUse('kb_search', { query: 'price' }));          // next response: stop_reason tool_use
//   fake.push(text('It is $249 per month [1].'));                   // then: stop_reason end_turn
//   fake.push({ status: 500, error: 'boom' });                      // an API error
//   fake.push((body, i) => text(`saw ${body.messages.length}`));    // computed from the request
//   fake.setHandler((body, i) => …)                                  // used when the queue is empty
//   fake.requests  -> [{ headers, body }] every request received
//   fake.url       -> base URL for the SDK (baseURL)
// Any queued item may carry delayMs; setLatency(ms) delays every response (time-out tests).
import http from 'node:http';

let seq = 0;
const id = (p) => `${p}_fake${(++seq).toString(36).padStart(6, '0')}`;
export const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', ...extra });
/** One or more tool calls in one assistant turn: toolUse('a', {…}) or toolUse([['a', {…}], ['b', {…}]], 'preamble'). */
export function toolUse(name, input = {}, preamble = null) {
  const calls = Array.isArray(name) ? name : [[name, input]];
  const pre = Array.isArray(name) ? input : preamble;
  return { content: [...(typeof pre === 'string' && pre ? [{ type: 'text', text: pre }] : []), ...calls.map(([n, inp]) => ({ type: 'tool_use', id: id('toolu'), name: n, input: inp }))], stop_reason: 'tool_use' };
}

export async function startFakeAnthropic({ latencyMs = 0, handler = null } = {}) {
  const queue = [];
  const requests = [];
  let latency = latencyMs;
  let fallbackHandler = handler;
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = { invalid: true }; }
    const send = (status, obj, headers = {}) => { if (res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json', 'request-id': id('req'), ...headers }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://x');
    if (!req.headers['x-api-key'] && !req.headers.authorization) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'missing key' } });
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(200, { data: [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-10-01T00:00:00Z' }], has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5' });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    const i = requests.length;
    requests.push({ headers: { ...req.headers }, body });
    if (body.invalid || !body.model || !Array.isArray(body.messages) || !Number(body.max_tokens)) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'model, messages and max_tokens are required' } });
    let item = queue.length ? queue.shift() : fallbackHandler ? fallbackHandler : text('OK.');
    if (typeof item === 'function') item = await item(body, i);
    const wait = Number(item?.delayMs ?? 0) + latency;
    // (a fully read request is auto-destroyed, so only the response side tells whether the client went away)
    if (wait > 0) await new Promise((r) => { const t = setTimeout(r, wait); res.on('close', () => { clearTimeout(t); r(); }); });
    if (res.destroyed || res.writableEnded) return;
    if (item?.status && item.status >= 400) {
      const type = { 400: 'invalid_request_error', 401: 'authentication_error', 404: 'not_found_error', 429: 'rate_limit_error', 529: 'overloaded_error' }[item.status] || 'api_error';
      return send(item.status, { type: 'error', error: { type, message: String(item.error || 'error') } });
    }
    send(200, { id: id('msg'), type: 'message', role: 'assistant', model: body.model, content: item?.content || [], stop_reason: item?.stop_reason || 'end_turn', stop_sequence: null, ...(item?.stop_details ? { stop_details: item.stop_details } : {}),
      usage: { input_tokens: JSON.stringify(body).length >> 2, output_tokens: JSON.stringify(item?.content || []).length >> 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`, port, requests,
    push: (...items) => { queue.push(...items); },
    setHandler: (fn) => { fallbackHandler = fn; },
    setLatency: (ms) => { latency = Number(ms) || 0; },
    pending: () => queue.length,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

// standalone: node server/test/fake-anthropic.mjs [port]  (answers "OK." to everything)
if (import.meta.url === `file://${process.argv[1]}`) {
  startFakeAnthropic().then((f) => console.log(`fake Anthropic Messages API on ${f.url}`));
}

// An OpenAI-compatible model stand-in (POST /v1/chat/completions, JSON and SSE; GET /v1/models) for Studio tests and
// the local dev server (spec 7.2). Deterministic; never talks to the network.
//
//   select prompts  (system contains "You select lines")  -> the 1-2 line numbers sharing the most terms with the
//                    QUESTION, or NONE when the best overlap is under 2
//   summary prompts (system contains "summarize")          -> {"oneLine","topics"} from the first lines of the file
//   question prompts (system contains "write test questions") -> a JSON list of heading questions
//   setup prompts   (system contains "KnowBot Builder")    -> {"reply","patch","actions","chips"} built from the
//                    intent parser exported by server/trials.mjs plus canned replies
//   any message containing FAIL -> HTTP 500; SLOW -> a 9 s delay (exercises time-outs and fallbacks)
import http from 'node:http';
import { bag } from './fake-knowdrive.mjs';

const lastUser = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content || '';
const textOf = (c) => (Array.isArray(c) ? c.map((b) => b?.text || '').join('') : String(c ?? ''));

function selectReply(messages) {
  const u = textOf(lastUser(messages));
  const q = /QUESTION:\s*([\s\S]*)$/.exec(u)?.[1] || '';
  const qb = bag(q);
  // A question line ("Can I take a test ride?") is never an answer; among equal overlaps the shorter, denser line wins.
  const lines = [...u.matchAll(/^L(\d+)\s+(.*)$/gm)].filter((m) => !/\?\s*$/.test(m[2])).map((m) => ({ n: Number(m[1]), len: m[2].length, b: bag(m[2]) }));
  const scored = lines.map((l) => ({ n: l.n, len: l.len, hit: [...l.b.keys()].filter((w) => qb.has(w)).length })).filter((x) => x.hit >= 2)
    .sort((a, b) => b.hit - a.hit || a.len - b.len || a.n - b.n);
  if (!scored.length) return 'NONE';
  const best = scored[0].hit;
  return scored.filter((x) => x.hit >= Math.max(2, best - 1)).slice(0, 2).map((x) => `L${x.n}`).join(', ');
}

function summaryReply(messages) {
  const u = textOf(lastUser(messages));
  const body = u.replace(/^[\s\S]*?FILE[^\n]*\n/, '');
  const heads = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim());
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !/^[#|]/.test(l));
  const first = (lines[0] || 'A short document.').replace(/\s+/g, ' ');
  const oneLine = first.length > 110 ? `${first.slice(0, 107).replace(/\s+\S*$/, '')}…` : first;
  const topics = (heads.length ? heads : [...bag(body).entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w)).slice(0, 3).map((t) => t.toLowerCase());
  return JSON.stringify({ oneLine, topics });
}

function questionsReply(messages) {
  const u = textOf(lastUser(messages));
  const heads = [...u.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 4);
  return JSON.stringify(heads.map((h) => `What does it say about ${h.toLowerCase()}?`));
}

async function setupReply(messages) {
  const u = textOf(lastUser(messages));
  let ctx = {};
  try { ctx = JSON.parse(u); } catch { /* free text */ }
  const msg = String(ctx.message ?? (typeof ctx === 'object' ? '' : u) ?? '');
  let patch = {}, actions = [];
  try {
    const { parseIntent } = await import('../trials.mjs');
    const r = parseIntent(msg, { files: ctx.files || [], spec: ctx.spec || {} });
    patch = r.patch || {};
    actions = (r.actions || []).map((a) => (typeof a === 'string' ? { type: a } : a));
  } catch { /* trials.mjs not available: canned reply only */ }
  const name = patch.name || ctx.spec?.name || 'your bot';
  const reply = Object.keys(patch).length ? `Done. I've updated ${name}. Want to test it?` : `Got it. Drop a file on the right, or try the samples.`;
  return JSON.stringify({ reply, patch, actions, chips: [{ label: 'Use sample files', action: { type: 'attach_samples' } }, { label: 'Upload my files', action: { type: 'request_upload' } }] });
}

/**
 * @returns {Promise<{ url: string, port: number, calls: object[], close: () => Promise<void> }>}
 */
export async function startFakeLLM({ host = '127.0.0.1', slowMs = 9000, model = 'fake-qwen2.5-1.5b' } = {}) {
  const calls = [];
  const pending = new Set();
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const json = (status, b) => { if (res.headersSent || res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.method === 'GET' && /\/models$/.test(url.pathname)) return json(200, { object: 'list', data: [{ id: model, object: 'model' }] });
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) return json(404, { error: { message: 'not found' } });
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(400, { error: { message: 'bad json' } }); }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const sys = textOf(messages.find((m) => m.role === 'system')?.content);
      const all = messages.map((m) => textOf(m.content)).join('\n');
      const user = textOf(lastUser(messages));
      const kind = /You select lines/.test(sys) ? 'select' : /summari[sz]e/i.test(sys) ? 'summary' : /write test questions/i.test(sys) ? 'questions' : /KnowBot Builder/.test(sys) ? 'setup' : 'chat';
      calls.push({ kind, at: Date.now(), stream: !!body.stream, user: user.slice(0, 400) });
      if (/\bFAIL\b/.test(user) || (kind !== 'select' && /\bFAIL\b/.test(all))) return json(500, { error: { message: 'injected failure' } });
      if (/\bSLOW\b/.test(user)) {
        await new Promise((r) => { const t = setTimeout(r, slowMs); pending.add(t); res.on('close', () => { clearTimeout(t); pending.delete(t); r(); }); });
        if (res.destroyed) return;
      }
      let content;
      if (kind === 'select') content = selectReply(messages);
      else if (kind === 'summary') content = summaryReply(messages);
      else if (kind === 'questions') content = questionsReply(messages);
      else if (kind === 'setup') content = await setupReply(messages);
      else content = 'Fake model reply.';
      const id = `chatcmpl-fake-${calls.length}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const piece of content.match(/.{1,16}/gs) || ['']) {
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      return json(200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.ceil(all.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil((all.length + content.length) / 4) } });
    });
  });
  await new Promise((r) => srv.listen(0, host, r));
  const port = srv.address().port;
  return {
    url: `http://${host}:${port}`, port, calls,
    close() {
      for (const t of pending) clearTimeout(t);
      srv.closeAllConnections?.();
      return new Promise((r) => srv.close(() => r()));
    },
  };
}

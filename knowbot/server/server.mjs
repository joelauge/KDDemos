#!/usr/bin/env node
// KnowBot server — Node 22, no npm dependencies (node:http + global fetch).
// See ../SPEC.md "Server HTTP API" for the contract.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fsp, createReadStream, existsSync, mkdirSync, appendFile, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createRetriever, DEFAULT_STORE } from './retrievers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CANONICAL = Object.freeze({ temperature: 0, top_p: 1, max_tokens: 400, seed: 7 });
const DEFAULT_PERSONA = Object.freeze({ name: 'KnowBot', org: 'The Ultimate Game Master' });
const BODY_LIMIT = 256 * 1024;
const REPLAY = 200;
const EVENT_MAX = 32 * 1024;       // one telemetry event, serialized
const MAX_SESSIONS = 5000;         // in-memory aggregation cap (oldest evicted)
const CHAT_ROLES = new Set(['system', 'user', 'assistant']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.xml': 'application/xml', '.csv': 'text/csv; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const tsNum = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts) || 0);

/**
 * Create (but do not start) a KnowBot server.
 * @param {object} [opts]
 */
export function createKnowBotServer(opts = {}) {
  const env = opts.env || process.env;
  const root = path.resolve(opts.root || path.join(__dirname, '..'));
  const corpusDir = path.resolve(opts.corpusDir || env.KNOWBOT_CORPUS_DIR || path.join(root, 'corpus'));
  const dataDir = path.resolve(opts.dataDir || env.KNOWBOT_DATA_DIR || path.join(__dirname, 'data'));
  const libPath = path.resolve(opts.libPath || env.KNOWBOT_LIB || path.join(root, 'lib', 'knowbot.js'));
  const llmBase = String(env.LLM_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/+$/, '');
  const llmModel = env.LLM_MODEL || 'qwen2.5-1.5b-instruct';
  const rateLimit = Number(opts.rateLimit ?? env.KNOWBOT_RATE_LIMIT ?? 30);
  const eventsRateLimit = Number(opts.eventsRateLimit ?? env.KNOWBOT_EVENTS_RATE_LIMIT ?? 240);
  const trustProxy = !!(opts.trustProxy ?? /^(1|true|yes)$/i.test(env.KNOWBOT_TRUST_PROXY || ''));
  const maxTokens = Number(env.KNOWBOT_MAX_TOKENS || 1024);
  const maxSse = Number(opts.maxSse ?? env.KNOWBOT_MAX_SSE ?? 100);
  const eventsMaxBytes = Number(opts.eventsMaxBytes ?? env.KNOWBOT_EVENTS_MAX_BYTES ?? 50 * 1024 * 1024);
  const readToken = String(opts.dashboardToken ?? env.KNOWBOT_DASHBOARD_TOKEN ?? '');
  const quiet = opts.quiet ?? false;
  const log = (...a) => { if (!quiet) console.log(...a); };

  const { mode, retriever, local } = createRetriever({ corpusDir, env, logger: log, watch: opts.watch ?? true });
  const store = mode === 'knowdrive' ? (env.KNOWDRIVE_STORE || DEFAULT_STORE) : 'local:corpus';

  // ------------------------------------------------------------ events / SSE
  mkdirSync(dataDir, { recursive: true });
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const replay = [];
  const sessions = new Map();
  const clients = new Set();

  function aggregate(ev) {
    if (!ev || typeof ev.sessionId !== 'string' || !ev.sessionId) return;
    if (ev.type === 'canonical' && !sessions.has(ev.sessionId)) return; // operator lookups don't create sessions
    let s = sessions.get(ev.sessionId);
    const t = tsNum(ev.ts);
    if (!s) {
      s = { sessionId: ev.sessionId, surface: null, startedAt: ev.ts, lastAt: ev.ts, _start: t, _last: t, turns: 0, _bot: 0, _grounded: 0, _canonical: 0 };
      sessions.set(ev.sessionId, s);
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // bound memory under flooding
    }
    if (ev.surface && ev.type !== 'canonical' && (!s.surface || ev.type === 'session.start')) s.surface = ev.surface;
    if (t && t < s._start) { s._start = t; s.startedAt = ev.ts; }
    if (t >= s._last) { s._last = t; s.lastAt = ev.ts; }
    if (ev.type === 'message.user') s.turns++;
    else if (ev.type === 'message.bot') { s._bot++; if (ev.grounded) s._grounded++; }
    else if (ev.type === 'canonical') s._canonical++;
  }

  // load history
  if (existsSync(eventsFile)) {
    try {
      const lines = readFileSync(eventsFile, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          aggregate(ev);
          replay.push(ev);
          if (replay.length > REPLAY) replay.shift();
        } catch {}
      }
      log(`[events] loaded ${lines.length - 1} events from ${eventsFile}`);
    } catch (e) { log(`[events] failed to load history: ${e.message}`); }
  }

  let writeQueue = Promise.resolve();
  let eventsBytes = 0;
  try { eventsBytes = existsSync(eventsFile) ? statSync(eventsFile).size : 0; } catch {}
  function persist(evs) {
    const chunk = evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeQueue = writeQueue.then(async () => {
      if (eventsMaxBytes && eventsBytes + chunk.length > eventsMaxBytes) { // rotate: keep one previous file, bound disk use
        try { await fsp.rename(eventsFile, eventsFile + '.1'); } catch {}
        eventsBytes = 0;
      }
      eventsBytes += Buffer.byteLength(chunk);
      await new Promise((resolve) => appendFile(eventsFile, chunk, (err) => {
        if (err) log(`[events] append failed: ${err.message}`);
        resolve();
      }));
    });
    return writeQueue;
  }

  function sseSend(res, ev) { res.write(`event: knowbot\ndata: ${JSON.stringify(ev)}\n\n`); }

  function publish(evs) {
    for (const ev of evs) {
      replay.push(ev);
      if (replay.length > REPLAY) replay.shift();
      aggregate(ev);
      for (const c of clients) { try { sseSend(c, ev); } catch {} }
    }
    return persist(evs);
  }

  // 'canonical' is server-only (emitted by /api/canonical): clients must not be able to forge the operator's reference answer.
  const CLIENT_EVENT_TYPES = new Set(['session.start', 'message.user', 'message.bot', 'feedback']);
  function normalizeEvent(ev) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new HttpError(400, 'event must be an object');
    if (typeof ev.type !== 'string' || !ev.type) throw new HttpError(400, 'event.type is required');
    if (ev.type === 'canonical') throw new HttpError(403, 'canonical events are emitted by the server only');
    if (!CLIENT_EVENT_TYPES.has(ev.type)) throw new HttpError(400, `unknown event.type "${ev.type}"`);
    const out = { v: 1, ...ev, ts: ev.ts ?? Date.now() };
    if (JSON.stringify(out).length > EVENT_MAX) throw new HttpError(413, `event exceeds ${EVENT_MAX} bytes`);
    return out;
  }

  const pingTimer = setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch {} } }, opts.pingMs || 15000);
  pingTimer.unref?.();

  // ------------------------------------------------------------ rate limit
  const hits = new Map();
  function rateLimited(ip, bucket = 'llm', limit = rateLimit) {
    if (!limit) return false;
    const now = Date.now(), key = `${bucket} ${ip}`;
    const arr = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (arr.length >= limit) { hits.set(key, arr); return true; }
    arr.push(now); hits.set(key, arr);
    return false;
  }
  const rlSweep = setInterval(() => { const now = Date.now(); for (const [ip, a] of hits) if (!a.some((t) => now - t < 60000)) hits.delete(ip); }, 60000);
  rlSweep.unref?.();

  // ------------------------------------------------------------ lib (canonical)
  let libCache = null, libMtime = 0;
  async function loadLib() {
    let st;
    try { st = await fsp.stat(libPath); } catch { throw new HttpError(503, `core library not found at ${path.relative(root, libPath) || libPath}`); }
    if (!libCache || st.mtimeMs !== libMtime) {
      libCache = await import(pathToFileURL(libPath).href + `?v=${st.mtimeMs}`);
      libMtime = st.mtimeMs;
      if (typeof libCache.buildMessages !== 'function' || typeof libCache.finalizeAnswer !== 'function') {
        libCache = null;
        throw new HttpError(503, 'core library does not export buildMessages + finalizeAnswer');
      }
    }
    return libCache;
  }

  async function llmComplete(messages, settings = CANONICAL) {
    const res = await fetch(`${llmBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.LLM_API_KEY ? { authorization: `Bearer ${env.LLM_API_KEY}` } : {}) },
      body: JSON.stringify({ model: llmModel, messages, stream: false, ...settings }),
      signal: AbortSignal.timeout(Number(env.LLM_TIMEOUT_MS || 300000)),
    }).catch((e) => {
      if (e.name === 'TimeoutError') throw new HttpError(504, `LLM timed out after ${Number(env.LLM_TIMEOUT_MS || 300000)}ms`);
      throw new HttpError(502, `LLM unreachable at ${llmBase}: ${e.cause?.code || e.message}`);
    });
    if (!res.ok) throw new HttpError(502, `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? '';
  }

  async function canonical({ question, sessionId, turnId, history }) {
    const lib = await loadLib();
    const persona = { ...DEFAULT_PERSONA, ...(env.KNOWBOT_ORG ? { org: env.KNOWBOT_ORG } : {}) };
    const k = 6;
    const minScore = Number(env.KNOWBOT_MIN_SCORE || 0);
    const settings = { ...CANONICAL, ...(lib.CANONICAL || {}) };
    const t0 = performance.now();
    const guard = typeof lib.guardRequest === 'function' ? lib.guardRequest(question, persona) : null;
    const ret = guard ? { source: 'guard', results: [] } : await retriever.search(question, k);
    const tRet = performance.now();
    const results = ret.results;
    const surface = { kind: 'api', device: 'desktop', host: 'server', path: '/api/canonical', referrer: '', embedded: false, channel: 'api', lang: 'en', ua: `node/${process.versions.node}` };
    const engine = { type: 'openai', model: llmModel };

    // Mirror KnowBot.ask() in lib/knowbot.js exactly: selectSources -> buildMessages -> LLM -> finalizeAnswer.
    const relevant = typeof lib.selectSources === 'function'
      ? lib.selectSources(results, minScore, k)
      : results.filter((r) => r.score == null || r.score > minScore).slice(0, k);
    let raw = null, tGen = tRet;
    if (!guard && relevant.length) {
      const messages = lib.buildMessages(question, relevant, persona, Array.isArray(history) ? history : []);
      raw = await llmComplete(messages, settings);
      tGen = performance.now();
    }
    const fin = guard || lib.finalizeAnswer(raw, relevant.length ? relevant : results, { minScore, persona });
    const latencyMs = { retrieval: Math.round(tRet - t0), generation: Math.round(tGen - tRet), total: Math.round(performance.now() - t0) };
    const answer = {
      ...fin,
      latencyMs, engine, surface,
      sessionId: sessionId ?? null,
      turnId: turnId ?? `canonical.${randomUUID().slice(0, 8)}`,
    };
    const retrieval = { source: ret.source, count: results.length, topScore: results[0]?.score ?? null };
    const event = {
      v: 1, type: 'canonical', ts: Date.now(), sessionId: answer.sessionId, turnId: answer.turnId, surface,
      question, text: answer.text, citations: answer.citations, grounded: answer.grounded, refused: answer.refused,
      latencyMs, engine, retrieval,
    };
    publish([event]);
    return { ...answer, retrieval };
  }

  /** /api/chat is a KnowBot engine, not an open LLM relay: allow-list fields, force the model, cap size and output. */
  function chatBody(body) {
    const msgs = body.messages;
    if (!Array.isArray(msgs) || !msgs.length) throw new HttpError(400, 'messages[] is required');
    if (msgs.length > 16) throw new HttpError(400, 'too many messages (max 16)');
    let chars = 0;
    const messages = msgs.map((m) => {
      if (!m || !CHAT_ROLES.has(m.role) || typeof m.content !== 'string') throw new HttpError(400, 'each message needs role system|user|assistant and string content');
      chars += m.content.length;
      return { role: m.role, content: m.content };
    });
    if (chars > 24000) throw new HttpError(413, 'messages too long (max 24000 chars)');
    const out = { model: llmModel, messages, stream: body.stream === true };
    for (const k of ['temperature', 'top_p', 'seed']) if (typeof body[k] === 'number' && Number.isFinite(body[k])) out[k] = body[k];
    const mt = Math.floor(Number(body.max_tokens));
    out.max_tokens = Math.min(maxTokens, mt > 0 ? mt : CANONICAL.max_tokens);
    return out;
  }

  /** Optional operator token (KNOWBOT_DASHBOARD_TOKEN) for endpoints that expose other users' conversations. */
  function requireReader(req, url) {
    if (!readToken) return;
    const auth = String(req.headers.authorization || '');
    const got = Buffer.from(url.searchParams.get('token') || (auth.startsWith('Bearer ') ? auth.slice(7) : ''));
    const want = Buffer.from(readToken);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'operator token required');
  }

  // ------------------------------------------------------------ helpers
  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length'] || 0);
      if (len > BODY_LIMIT) { req.resume(); return reject(new HttpError(413, `body exceeds ${BODY_LIMIT} bytes`)); }
      const parts = []; let size = 0; let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > BODY_LIMIT) { done = true; req.resume(); reject(new HttpError(413, `body exceeds ${BODY_LIMIT} bytes`)); return; }
        parts.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts).toString('utf8')); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }

  async function readJson(req) {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON body'); }
  }

  function clientIp(req) {
    // X-Forwarded-For is client-controlled: only honour it behind a trusted proxy, else it bypasses rate limits.
    const xf = trustProxy ? req.headers['x-forwarded-for'] : null;
    return (typeof xf === 'string' && xf.split(',').pop().trim()) || req.socket.remoteAddress || 'unknown';
  }

  async function llmReachable() {
    try {
      const r = await fetch(`${llmBase}/models`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }

  // ------------------------------------------------------------ static
  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad path encoding'); }
    if (rel.includes('\0') || rel.includes('\\')) throw new HttpError(400, 'bad path');
    const abs = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new HttpError(403, 'forbidden');
    const segs = relToRoot.split(path.sep);
    if (segs.some((s) => s.startsWith('.') && s !== '.well-known') || relToRoot.startsWith(path.join('server', 'data'))) throw new HttpError(404, 'not found');
    // raw ".." in the request (e.g. %2e%2e) that normalized inside root is still refused, to be explicit
    if (rel.split('/').includes('..')) throw new HttpError(403, 'forbidden');

    let file = abs, st;
    try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'not found'); }
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { location: pathname + '/' }); res.end(); return; }
      file = path.join(abs, 'index.html');
      try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'not found'); }
    }
    if (!st.isFile()) throw new HttpError(404, 'not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return; }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, etag, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  }

  // ------------------------------------------------------------ routes
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    if (m === 'OPTIONS') {
      res.writeHead(204, { 'access-control-max-age': '86400' });
      res.end();
      return;
    }

    if (p === '/healthz' && m === 'GET') {
      return send(res, 200, { ok: true, retrieval: mode, files: local.fileCount, chunks: local.chunkCount, llm: await llmReachable(), llmBase, sseClients: clients.size });
    }

    if (p.startsWith('/api/')) {
      switch (`${m} ${p}`) {
        case 'GET /api/config':
          return send(res, 200, { store, retrieval: mode, engine: { type: 'openai', model: llmModel }, canonical: { ...CANONICAL } });

        case 'POST /api/search': {
          const body = await readJson(req);
          const query = typeof body.query === 'string' ? body.query.trim() : '';
          if (!query) throw new HttpError(400, 'query is required');
          if (query.length > 4000) throw new HttpError(400, 'query too long');
          const r = await retriever.search(query, body.k ?? 6);
          return send(res, 200, r);
        }

        case 'POST /api/reindex': {
          requireReader(req, url);
          const r = await local.reindex();
          return send(res, 200, { ok: true, ...r });
        }

        case 'POST /api/chat': {
          if (rateLimited(clientIp(req))) throw new HttpError(429, 'rate limit exceeded (30/min)');
          const body = chatBody(await readJson(req));
          const ac = new AbortController();
          res.on('close', () => { if (!res.writableFinished) ac.abort(); });
          let up;
          try {
            up = await fetch(`${llmBase}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json', ...(env.LLM_API_KEY ? { authorization: `Bearer ${env.LLM_API_KEY}` } : {}) },
              body: JSON.stringify(body),
              signal: ac.signal,
            });
          } catch (e) {
            throw new HttpError(502, `LLM unreachable at ${llmBase}: ${e.cause?.code || e.message}`);
          }
          const headers = { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' };
          if (body.stream) { headers['x-accel-buffering'] = 'no'; headers.connection = 'keep-alive'; }
          res.writeHead(up.status, headers);
          if (!up.body) return res.end();
          const node = Readable.fromWeb(up.body);
          node.on('error', () => { try { res.end(); } catch {} });
          node.pipe(res);
          return;
        }

        case 'POST /api/canonical': {
          if (rateLimited(clientIp(req))) throw new HttpError(429, 'rate limit exceeded (30/min)');
          const body = await readJson(req);
          const question = typeof body.question === 'string' ? body.question.trim() : '';
          if (!question) throw new HttpError(400, 'question is required');
          if (question.length > 4000) throw new HttpError(400, 'question too long');
          const answer = await canonical({ question, sessionId: body.sessionId, turnId: body.turnId, history: body.history });
          return send(res, 200, answer);
        }

        case 'POST /api/events': {
          if (rateLimited(clientIp(req), 'events', eventsRateLimit)) throw new HttpError(429, 'rate limit exceeded (events)');
          const body = await readJson(req);
          const list = Array.isArray(body) ? body : [body];
          if (!list.length) return send(res, 200, { ok: true, count: 0 });
          if (list.length > 500) throw new HttpError(400, 'too many events (max 500)');
          const evs = list.map(normalizeEvent);
          publish(evs);
          return send(res, 200, { ok: true, count: evs.length });
        }

        case 'GET /api/stream': {
          requireReader(req, url);
          if (maxSse && clients.size >= maxSse) throw new HttpError(503, 'too many live subscribers');
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive', 'x-accel-buffering': 'no',
          });
          res.write('retry: 3000\n\n');
          for (const ev of replay) sseSend(res, ev);
          clients.add(res);
          req.socket.setKeepAlive?.(true);
          req.socket.setTimeout?.(0);
          const drop = () => clients.delete(res);
          req.on('close', drop); res.on('close', drop); res.on('error', drop);
          return;
        }

        case 'GET /api/sessions': {
          requireReader(req, url);
          const list = [...sessions.values()]
            .sort((a, b) => b._last - a._last)
            .map((s) => ({
              sessionId: s.sessionId, surface: s.surface, startedAt: s.startedAt, lastAt: s.lastAt, turns: s.turns,
              groundedRate: s._bot ? Math.round((s._grounded / s._bot) * 1000) / 1000 : null,
            }));
          return send(res, 200, list);
        }

        case 'GET /api/events': // convenience: recent buffer
          requireReader(req, url);
          return send(res, 200, replay);

        default:
          if (['/api/config', '/api/search', '/api/chat', '/api/canonical', '/api/events', '/api/stream', '/api/sessions', '/api/reindex'].includes(p)) {
            throw new HttpError(405, `method ${m} not allowed on ${p}`);
          }
          throw new HttpError(404, `no such endpoint ${p}`);
      }
    }

    if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return serveStatic(req, res, p);
  }

  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] || 'content-type, authorization');
    res.setHeader('access-control-expose-headers', 'content-type');
    const isStream = req.url.startsWith('/api/stream');
    const logUrl = req.url.replace(/([?&]token=)[^&]*/g, '$1***').slice(0, 200); // never log the operator token
    if (isStream) log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${logUrl} SSE open`);
    res.on('finish', () => {
      log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${logUrl} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`);
    });
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`[error] ${req.method} ${logUrl}: ${e.stack || e}`);
      if (!res.headersSent) send(res, status, { error: { status, message: e.message || 'internal error', ...(e.extra || {}) } });
      else { try { res.end(); } catch {} }
    }
  });

  server.on('close', () => {
    clearInterval(pingTimer); clearInterval(rlSweep); local.close();
    for (const c of clients) { try { c.end(); } catch {} }
  });

  const origClose = server.close.bind(server);
  server.close = (cb) => {
    for (const c of clients) { try { c.end(); } catch {} }
    clients.clear();
    server.closeAllConnections?.();
    return origClose(cb);
  };

  return { server, retriever, local, mode, ready: local.ready, flush: () => writeQueue, config: { root, corpusDir, dataDir, libPath, llmBase, llmModel } };
}

// ------------------------------------------------------------ main
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '0.0.0.0';
  const kb = createKnowBotServer();
  kb.server.listen(port, host, () => {
    const c = kb.config;
    console.log(`[knowbot] listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`[knowbot] retrieval=${kb.mode} corpus=${c.corpusDir} llm=${c.llmBase} model=${c.llmModel}`);
    console.log(`[knowbot] dashboard: http://localhost:${port}/dashboard/   demo: http://localhost:${port}/demo/`);
  });
  const stop = () => { console.log('[knowbot] shutting down'); kb.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

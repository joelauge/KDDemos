#!/usr/bin/env node
// KnowBot server — Node 22, no npm dependencies (node:http + global fetch).
// See ../SPEC.md "Server HTTP API" for the contract.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fsp, createReadStream, existsSync, mkdirSync, appendFile, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { createRetriever, DEFAULT_STORE, DEFAULT_PREFIX } from './retrievers.mjs';
import { InstanceRegistry, InstanceError, MAX_UPLOAD_BYTES } from './instances.mjs';
import { completeWith, ProviderError, HAIKU_MODEL, queryVariantsOf } from './providers.mjs';
import { createStudio } from './trials.mjs';
import { createDevApi, isDevApiPath, EXPOSE_HEADERS as DEV_EXPOSE_HEADERS } from './devapi.mjs';
import { createSendInfo } from './sendinfo.mjs';
import { createLeads } from './leads.mjs';
import { logSendEvent } from './questions.mjs';
import { phoneSessions } from './channels/voice-live.mjs';
import { activeWebVoiceSessions } from './channels/webvoice.mjs';
import { createResearchAgent } from './research.mjs';
import { createEvidenceSelector, createResolver } from './evidence.mjs';
import { createHmAuth, LEEWAY_S } from './hmauth.mjs';

/**
 * The header the Cloudflare Worker sends on internal calls to this server (GET /api/internal/busy): an HMAC of a fixed
 * label under KNOWBOT_ADMIN_TOKEN, a secret both already hold, so the admin token itself never travels. cloudflare/
 * worker.js computes the same value (internalSecret). The Worker refuses /api/internal/* from the internet (404).
 */
export const INTERNAL_HEADER = 'x-knowbot-internal';
export const internalSecret = (adminToken) => createHmac('sha256', String(adminToken)).update('knowbot-internal-v1').digest('hex');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CANONICAL = Object.freeze({ temperature: 0, top_p: 1, max_tokens: 300, seed: 7, frequency_penalty: 0.4 });
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

// The web root: only what the pages, the widget, the Studio, the dashboard and the homepage site load (SPEC "Static
// files"). Everything else in the tree (corpus/, eval/, attendd/, cloudflare/, scripts/, server/, package files, tests,
// dotfiles) answers 404. demo/ needs the built-in bot; corpus/ is served only with KNOWBOT_SERVE_CORPUS (browser-only demo).
const STATIC_FILES = new Set(['index.html', '404.html']);
const STATIC_DIRS = new Set(['lib', 'studio', 'dashboard', 'site', 'vendor']);
const STATIC_HIDDEN = ['lib/test', 'studio/test', 'studio/kb'];
const isOff = (v) => /^(0|off|false|no)$/i.test(String(v ?? '').trim());
const isOn = (v) => /^(1|on|true|yes)$/i.test(String(v ?? '').trim());

class HttpError extends Error {
  constructor(status, message, extra, headers) { super(message); this.status = status; this.extra = extra; this.headers = headers; }
}

const tsNum = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts) || 0);

// Behind host-manager (KNOWBOT_AUTH_*): the only paths answered through it, i.e. the operator dashboard and its API.
// Studio, site, widget, /p, /v1 stay on KnowBot's own port; through host-manager they would run on its auth origin.
const HM_STATIC = /^\/(?:dashboard(?:\/[^/]*)?|lib\/site-config\.js)$/;
const INSTANCE_API = /^\/api\/(?:instances|buckets|graph|providers|flows)(?:\/|$)/; // instanceRoutes (and devapi's bot keys)
const HM_API = /^\/api\/(?:(?:stream|sessions|events|reindex|config|canonical)$|studio\/trials\/[^/]+\/convert$)/;
const hmRoute = (m, p) => HM_STATIC.test(p) || INSTANCE_API.test(p) || (HM_API.test(p) && !(p === '/api/events' && m !== 'GET'));
const UPLOAD_PATH = /^\/api\/buckets\/[^/]+\/files$/;

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
  // KNOWBOT_LLM_THINKING=off: every request to LLM_BASE_URL (select, generate, the local Studio provider, /api/chat)
  // asks the chat template not to think (llama.cpp/Qwen3, as Provenance sends it). Hosted providers and KNOWBOT_MODELS
  // entries whose baseUrl is not LLM_BASE_URL never get the field.
  const noThink = String(env.KNOWBOT_LLM_THINKING || '').trim().toLowerCase() === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {};
  const researchAgent = opts.researchAgent !== undefined ? opts.researchAgent : createResearchAgent(env, { log: (x) => { if (!opts.quiet) console.log(x); } });
  // Evidence selector (server/evidence.mjs): off unless KNOWBOT_EVIDENCE=attend; shared by every answer path
  const evidence = opts.evidence !== undefined ? opts.evidence : createEvidenceSelector(env, { log: (x) => { if (!opts.quiet) console.log(x); } });
  // Resolve mode (KNOWBOT_EVIDENCE=resolve): the sidecar's ranked search replaces only the retrieval call of every
  // answer path (knowDrive retrievers, trial search); the floor, refusal and answer steps are unchanged
  const resolver = opts.resolver !== undefined ? opts.resolver : createResolver(env, { log: (x) => { if (!opts.quiet) console.log(x); } });
  // Models a bot can answer with. Today one local model; KNOWBOT_MODELS (JSON [{id,label,baseUrl?,apiKeyEnv?}]) adds more.
  const models = (() => {
    const base = [{ id: llmModel, label: env.LLM_MODEL_LABEL || 'Qwen2.5 1.5B Instruct (Q4_K_M, llama.cpp)', default: true }];
    try {
      const extra = JSON.parse(env.KNOWBOT_MODELS || '[]');
      return [...base, ...extra.filter((m) => m && typeof m.id === 'string' && m.id !== llmModel).map((m) => ({ id: m.id, label: String(m.label || m.id), baseUrl: m.baseUrl, apiKeyEnv: m.apiKeyEnv }))];
    } catch { return base; }
  })();
  const publicModels = models.map(({ id, label, default: d }) => ({ id, label, ...(d ? { default: true } : {}) }));
  const rateLimit = Number(opts.rateLimit ?? env.KNOWBOT_RATE_LIMIT ?? 30);
  const eventsRateLimit = Number(opts.eventsRateLimit ?? env.KNOWBOT_EVENTS_RATE_LIMIT ?? 240);
  const trustProxy = !!(opts.trustProxy ?? isOn(env.KNOWBOT_TRUST_PROXY));
  const maxTokens = Number(env.KNOWBOT_MAX_TOKENS || 1024);
  const maxSse = Number(opts.maxSse ?? env.KNOWBOT_MAX_SSE ?? 100);
  const eventsMaxBytes = Number(opts.eventsMaxBytes ?? env.KNOWBOT_EVENTS_MAX_BYTES ?? 50 * 1024 * 1024);
  const readToken = String(opts.dashboardToken ?? env.KNOWBOT_DASHBOARD_TOKEN ?? '');
  const adminToken = String(opts.adminToken ?? env.KNOWBOT_ADMIN_TOKEN ?? '');
  // KNOWBOT_BUILTIN_BOT=off: no built-in bot (UGM), no corpus/ index and no demo pages; corpus/ and demo/ may be absent
  const builtinBot = !isOff(env.KNOWBOT_BUILTIN_BOT);
  const serveCorpus = builtinBot && isOn(env.KNOWBOT_SERVE_CORPUS);
  const quiet = opts.quiet ?? false;
  const log = (...a) => { if (!quiet) console.log(...a); };
  // Admin sign-in through host-manager (server/hmauth.mjs): null unless KNOWBOT_AUTH_* are all set (the cloud: never)
  const hmAuth = opts.hmAuth !== undefined ? opts.hmAuth : createHmAuth({ env, log });
  // seals provider keys (registry) and kb_live_ keys (devapi.mjs, same order); the constant is for local development only
  const sealSecret = env.KNOWBOT_SECRET_KEY || adminToken;
  if (hmAuth && !sealSecret) {
    // without either, provider keys and kb_live_ keys would be sealed with the public constant below
    throw new Error('KNOWBOT_AUTH_* is set: set KNOWBOT_SECRET_KEY too (it seals provider and API keys)');
  }

  // Stored questions (SPEC 11.1) are never searchable, so never citable.
  const { mode, retriever, local } = createRetriever({ corpusDir: builtinBot ? corpusDir : null, env: { ...env, KNOWDRIVE_EXCLUDE_TAGS: [env.KNOWDRIVE_EXCLUDE_TAGS, 'questions'].filter(Boolean).join(',') }, logger: log, watch: opts.watch ?? true, resolver });
  const store = mode === 'knowdrive' ? (env.KNOWDRIVE_STORE || DEFAULT_STORE) : 'local:corpus';

  // ------------------------------------------------------------ chat instances (one knowDrive folder each)
  const kdKeyFile = env.KNOWDRIVE_API_KEY_FILE;
  const kd = mode === 'knowdrive' ? {
    baseUrl: String(env.KNOWDRIVE_BASE_URL || 'https://knowdrive.ai').replace(/\/+$/, ''), store,
    apiKey: kdKeyFile ? () => { try { return readFileSync(kdKeyFile, 'utf8').trim(); } catch { return ''; } } : env.KNOWDRIVE_API_KEY,
    resolver,
  } : null;
  const builtinOrg = env.KNOWBOT_ORG || DEFAULT_PERSONA.org;
  const registry = opts.registry || new InstanceRegistry({
    kd, dataDir, logger: log, builtinRetriever: retriever,
    // The built-in floor (0.745) is calibrated for its corpus; smaller uploaded folders score lower, so new instances start at 0.70.
    defaultMinSimilarity: Number(env.KNOWBOT_INSTANCE_MIN_SIMILARITY ?? 0.7),
    models: models.map((x) => x.id),
    // Seals the operator's OpenAI/Anthropic keys in the registry. Changing it means re-entering those keys.
    secret: sealSecret || 'knowbot-local-dev',
    builtinId: env.KNOWBOT_BUILTIN_ID || 'ugm',
    builtin: builtinBot ? { id: env.KNOWBOT_BUILTIN_ID || 'ugm', tag: env.KNOWDRIVE_TAG || 'knowbot:ugm', name: builtinOrg, org: builtinOrg, folder: mode === 'knowdrive' ? (env.KNOWDRIVE_PREFIX ?? DEFAULT_PREFIX) : 'corpus/', guards: 'store' } : null,
  });

  // ------------------------------------------------------------ Claude Haiku 5.5, the default answering engine
  // Where the server has an Anthropic key (the dashboard's sealed registry key, else ANTHROPIC_API_KEY): the website
  // widget's /api/chat (KNOWBOT_WIDGET_ENGINE=haiku|local, default haiku), every AI-agent answer, trial bots' answers
  // on the API and channels, and the hidden query rewrite. Without a key: the local model and the rewrite rules.
  const anthropicKey = () => { try { return registry.providerKey('anthropic') || env.ANTHROPIC_API_KEY || null; } catch { return env.ANTHROPIC_API_KEY || null; } };
  const haiku = opts.haiku !== undefined ? opts.haiku : (() => {
    const model = env.KNOWBOT_HAIKU_MODEL || HAIKU_MODEL;
    return { model, available: () => !!anthropicKey(), complete: (messages, settings) => completeWith('anthropic', anthropicKey(), model, messages, settings) };
  })();
  const widgetEngine = String(env.KNOWBOT_WIDGET_ENGINE || 'haiku').toLowerCase() === 'local' ? 'local' : 'haiku';
  const queryVariants = queryVariantsOf(env.KNOWBOT_QUERY_VARIANTS);

  // ------------------------------------------------------------ KnowBot Studio (/api/studio/*, server/trials.mjs)
  const kdConfig = kd; // { baseUrl, apiKey, store }: the same knowDrive config as the registry (null in local mode)
  // "send me this" (server/sendinfo.mjs): one instance for the Studio and every /v1 surface (one memory, one opt-out list)
  // a text sent from a bot's own KnowBot number is paid from that bot's prepaid credit, like every other text on it
  // the leads report (server/leads.mjs): contacts visitors give a bot, tracked links, checkout links sent and clicks
  const leads = opts.leads || createLeads({ dataDir, env, log });
  const sendInfo = createSendInfo({ env, log, dataDir, onLead: (e) => leads.lead(e), onSent: (e) => {
    logSendEvent({ scopeTags: e.scopeTags, via: e.via, callerKey: e.callerKey });
    if (e.via !== 'text' || !e.fromNumber) return;
    const T = studio?.trials?.get?.(e.botId);
    Promise.resolve(studio?.numbers?.meterFor?.({ kind: 'trial', id: e.botId, flags: T?.flags, T })).then((m) => m && m.phoneNumber === e.fromNumber && m.charge('text', Math.max(1, Math.ceil((e.length || 160) / 153)), 'send_info'))
      .catch((err) => log(`[sendinfo] credit not recorded: ${err.message}`));
  } });
  const studio = createStudio({ env, registry, lib: () => loadLib(), kd: kdConfig, llmComplete, completeWith, researchAgent, evidence, resolver, haiku, queryVariants,
    rateLimited, clientIp, readRaw, readJson, HttpError, logger: log, dataDir, requireAdmin, sendInfo, leads,
    // tracked links for the Studio's own "send me this" sends (server/leads.mjs), made by the developer API like proof links
    linkTracker: (req, trialId, channel) => devapi.linkTracker(req, trialId, channel),
    // a Studio answer's public proof link (/p/<id>) for what it sends, made by the developer API (created below)
    proofLink: (req, trialId, a) => devapi.proofLink(req, trialId, a), ...(opts.studio || {}) });

  // ------------------------------------------------------------ developer API, channels, questions loop (/v1/*, server/devapi.mjs)
  const devapi = createDevApi({ env, registry, studio, kd, loadLib, llmComplete, completeWith, researchAgent, evidence, resolver, haiku, queryVariants, readRaw, readJson, clientIp, requireAdmin,
    logger: log, dataDir, llmModel, canonical: CANONICAL, sendInfo, leads, ...(opts.devapi || {}) });

  // ------------------------------------------------------------ admin sign-in through host-manager (KNOWBOT_AUTH_*)
  // The CSP for everything answered through host-manager: no third-party script on its origin, no inline script but the
  // dashboard's own (hashed here from dashboard/index.html, so the theme bootstrap keeps working).
  const hmCsp = hmAuth ? (() => {
    let html = '';
    try { html = readFileSync(path.join(root, 'dashboard', 'index.html'), 'utf8'); } catch {}
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => `'sha256-${createHash('sha256').update(x[1]).digest('base64')}'`);
    return ["default-src 'self'", `script-src 'self'${hashes.map((h) => ` ${h}`).join('')}`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com', "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
  })() : '';
  if (hmAuth) {
    hmAuth.start();
    log(`[auth] host-manager sign-in on: iss=${hmAuth.issuer} aud=${hmAuth.audience}`);
    // the seals must still open with this secret (it changes when the admin token stops being the sealing input)
    Promise.resolve(registry.ready).then(async () => {
      const bad = [];
      for (const pr of registry.providerList().filter((x) => x.needsKey && x.configured)) {
        try { registry.providerKey(pr.id); } catch { bad.push(`${pr.id} key`); }
      }
      // only a failed unseal names the secret; knowDrive down or slow at boot is not a reason to change it
      try { await devapi.keysCheck?.(); } catch (e) { if (e?.cause instanceof ProviderError) bad.push('kb_live_ keys'); else log(`[auth] could not check the kb_live_ keys: ${e?.message || e}`); }
      if (bad.length) log(`[auth] KNOWBOT_SECRET_KEY does not open the stored ${bad.join(', ')}: set it to the value that sealed them`);
    }).catch(() => {});
  }

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

  async function llmComplete(messages, settings = CANONICAL, modelId = llmModel) {
    const m = models.find((x) => x.id === modelId) || models[0];
    const base = String(m.baseUrl || llmBase).replace(/\/+$/, '');
    const key = m.apiKeyEnv ? env[m.apiKeyEnv] : env.LLM_API_KEY;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      // reasoning_effort is a hosted-model setting (Claude): never sent to the local model
      body: JSON.stringify({ model: m.id, messages, stream: false, ...Object.fromEntries(Object.entries(settings || {}).filter(([k]) => k !== 'reasoning_effort')), ...(base === llmBase ? noThink : {}) }),
      signal: AbortSignal.timeout(Number(env.LLM_TIMEOUT_MS || 300000)),
    }).catch((e) => {
      if (e.name === 'TimeoutError') throw new HttpError(504, `LLM timed out after ${Number(env.LLM_TIMEOUT_MS || 300000)}ms`);
      throw new HttpError(502, `LLM unreachable at ${llmBase}: ${e.cause?.code || e.message}`);
    });
    if (!res.ok) throw new HttpError(502, `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? '';
  }

  /**
   * POST /api/canonical: one live bot's answer in the library's Answer shape. It runs the one answer pipeline
   * (server/answer.mjs through devapi.answer: guard, search with the hidden expansion, select or the bot's generate
   * mode, citation gate, table interpretation, verdict), so it answers exactly as the widget, the API and the channels do.
   */
  async function canonical({ question, sessionId, turnId, history, instance, callerKey = null }) {
    await registry.ready;
    const inst = registry.get(instance);
    const target = { kind: 'live', id: inst.id, inst, name: inst.botName || inst.name || inst.org || inst.id };
    const a = await devapi.answer(target, question, { history: Array.isArray(history) ? history : [], channel: 'web', callerKey, cards: true });
    const surface = { kind: 'api', device: 'desktop', host: 'server', path: '/api/canonical', referrer: '', embedded: false, channel: 'api', lang: 'en', ua: `node/${process.versions.node}`, instance: inst.id };
    // type stays 'openai' (the wire protocol) for the local model; hosted platforms also name the provider.
    const engine = { type: 'openai', model: inst.model || llmModel, ...(inst.provider ? { provider: inst.provider } : {}) };
    const latencyMs = { retrieval: a.retrievalMs, generation: Math.max(0, a.latencyMs - a.retrievalMs), total: a.latencyMs };
    const citations = a.citations.map((c) => ({ n: c.n, filename: c.file, title: c.title, url: c.url ?? null, snippet: c.excerpt, ...(c.page ? { page: c.page } : {}), ...(c.section ? { section: c.section } : {}) }));
    const answer = {
      text: a.answer, citations, grounded: a.grounded, refused: a.refused, fallback: false, ...(a.guard ? { guard: a.guard } : {}), ...(a.products?.length ? { products: a.products } : {}),
      ...(a.proof.receipt ? { receipt: a.proof.receipt } : {}),
      latencyMs, timings: a.timings, engine, surface,
      sessionId: sessionId ?? null,
      turnId: turnId ?? `canonical.${randomUUID().slice(0, 8)}`,
    };
    const results = a.proof.hits;
    const retrieval = { source: a.retrievalSource || (a.guard ? 'guard' : null), count: results.length, topScore: a.proof.floor.top ?? results[0]?.similarity ?? null };
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
    const out = { model: llmModel, messages, stream: body.stream === true, ...noThink };
    for (const k of ['temperature', 'top_p', 'seed', 'frequency_penalty', 'presence_penalty']) if (typeof body[k] === 'number' && Number.isFinite(body[k])) out[k] = body[k];
    // the hidden query rewrite asks for low effort (Claude only; dropped before the local model)
    if (['low', 'medium', 'high'].includes(body.reasoning_effort)) out.reasoning_effort = body.reasoning_effort;
    const mt = Math.floor(Number(body.max_tokens));
    out.max_tokens = Math.min(maxTokens, mt > 0 ? mt : CANONICAL.max_tokens);
    return out;
  }

  /** The static-token rule for both gates: `?token=` (only when `url` is given: the reader gate), else the Bearer. */
  function tokenOk(req, token, url) {
    const auth = String(req.headers.authorization || '');
    const got = Buffer.from((url && url.searchParams.get('token')) || (auth.startsWith('Bearer ') ? auth.slice(7) : ''));
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** Optional operator token (KNOWBOT_DASHBOARD_TOKEN) for endpoints that expose other users' conversations. */
  function requireReader(req, url) {
    if (hmAuth) return hmGate(req, 'reader', url);
    if (!readToken) return;
    if (!tokenOk(req, readToken, url)) throw new HttpError(401, 'operator token required');
  }

  /** Instance management writes to the knowDrive store: KNOWBOT_ADMIN_TOKEN, or loopback only when none is set. */
  function requireAdmin(req) {
    if (hmAuth) return hmGate(req, 'admin');
    if (!adminToken) {
      const ip = req.socket.remoteAddress || '';
      if (/^(?:127\.|::1$|::ffff:127\.)/.test(ip) && !req.headers['x-forwarded-for']) return;
      throw new HttpError(403, 'instance management is disabled: set KNOWBOT_ADMIN_TOKEN on the server');
    }
    if (!tokenOk(req, adminToken)) throw new HttpError(401, 'admin token required');
  }

  /**
   * The gates with KNOWBOT_AUTH_* set: a host-manager FAT granting `need` (knowbot:*:admin, or :read for reader),
   * else the admin token (admin) or the dashboard token (reader). No loopback bypass, no open reader.
   */
  function hmGate(req, need, url) {
    const v = hmAuth.verify(req);
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    const p = new URL(req.url, 'http://localhost').pathname; // as handle() routes it
    if (v?.ok && v[need]) {
      if (write) sameOriginWrite(req, p);
      req.knowbotAuth = { sub: v.sub, exp: v.exp };
      if (write) log(`[auth] ${req.method} ${p} by ${v.sub}`);
      return;
    }
    if (v) log(`[auth] denied ${v.sub || '-'} ${v.ok ? `no ${need} grant${v.why ? ` (${v.why})` : ''}` : v.why}`);
    if (v?.ok) throw new HttpError(403, `this sign-in does not grant KnowBot ${need} access`);
    const token = need === 'admin' ? adminToken : readToken;
    if (token && tokenOk(req, token, need === 'reader' ? url : null)) { if (write) log(`[auth] ${req.method} ${p} by admin-token`); return; }
    throw new HttpError(401, need === 'admin' ? 'sign in through host-manager, or send the admin token' : 'sign in through host-manager, or send the operator token',
      undefined, { 'www-authenticate': 'Bearer realm="knowbot"' });
  }

  /**
   * A FAT rides on the owner's host-manager cookie, which every page on 127.0.0.1 (any port: same site) can make the
   * browser send. So a write admitted by a FAT must come from host-manager's own origin, as JSON (or a raw upload named
   * in X-Filename): both force a CORS preflight on a cross-origin page.
   */
  function sameOriginWrite(req, p) {
    const h = req.headers;
    if (h['sec-fetch-site'] && !['same-origin', 'none'].includes(h['sec-fetch-site'])) throw new HttpError(403, 'cross-site request refused');
    let from = h.origin;
    if (from === undefined && h.referer) { try { from = new URL(h.referer).origin; } catch { from = 'null'; } }
    if (from !== undefined && from !== hmAuth.origin) throw new HttpError(403, 'cross-origin request refused');
    if (req.method === 'POST' && UPLOAD_PATH.test(p)) {
      if (!h['x-filename']) throw new HttpError(400, 'name the file in X-Filename');
    } else if ((Number(h['content-length']) > 0 || h['transfer-encoding']) && String(h['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, 'send the body as application/json');
    }
  }

  /** Raw upload body (one file per request), capped below the Cloudflare request limit. */
  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length'] || 0);
      if (len > limit) { req.resume(); return reject(new HttpError(413, `file exceeds ${Math.round(limit / 1048576)} MB`)); }
      const parts = []; let size = 0; let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > limit) { done = true; req.resume(); reject(new HttpError(413, `file exceeds ${Math.round(limit / 1048576)} MB`)); return; }
        parts.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }

  async function instanceRoutes(req, res, url, p, m) {
    await registry.ready;
    const [kind, id, sub, fileId, parts4] = p.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // after /api
    const graph = () => ({ flows: registry.flowList(), bots: registry.list(), buckets: registry.bucketList(), models: publicModels,
      providers: registry.providerList().map(({ last4, updatedAt, ...p }) => p), canManage: registry.canWrite });
    if (kind === 'graph' && !id && m === 'GET') return send(res, 200, graph());
    if (kind === 'providers') {
      requireAdmin(req);
      if (!id && m === 'GET') return send(res, 200, { providers: registry.providerList() });
      if (id && !sub && m === 'PUT') return send(res, 200, await registry.setProviderKey(id, (await readJson(req)).apiKey));
      if (id && !sub && m === 'DELETE') return send(res, 200, await registry.setProviderKey(id, ''));
      if (id && sub === 'models' && m === 'GET') return send(res, 200, { models: await registry.providerModels(id) });
    }
    if (kind === 'flows') {
      if (!id && m === 'GET') return send(res, 200, { flows: registry.flowList() });
      if (!id && m === 'POST') { requireAdmin(req); return send(res, 201, await registry.createFlow(await readJson(req))); }
      if (id && !sub && m === 'PATCH') { requireAdmin(req); return send(res, 200, await registry.updateFlow(id, await readJson(req))); }
      if (id && !sub && m === 'DELETE') { requireAdmin(req); return send(res, 200, await registry.removeFlow(id)); }
    }
    if (kind === 'instances') {
      if (!id) {
        if (m === 'GET') return send(res, 200, { instances: registry.list(), canManage: registry.canWrite });
        if (m === 'POST') { requireAdmin(req); return send(res, 201, await registry.create(await readJson(req))); }
      } else if (!sub) {
        if (m === 'GET') return send(res, 200, registry.list().find((x) => x.id === registry.get(id).id));
        if (m === 'PATCH') { requireAdmin(req); return send(res, 200, await registry.update(id, await readJson(req))); }
        if (m === 'DELETE') { requireAdmin(req); const it = await registry.remove(id); return send(res, 200, { ok: true, id: it.id }); }
      }
    }
    if (kind === 'buckets') {
      if (!id) {
        if (m === 'GET') return send(res, 200, { buckets: registry.bucketList(), canManage: registry.canWrite });
        if (m === 'POST') { requireAdmin(req); return send(res, 201, await registry.createBucket(await readJson(req))); }
      } else if (!sub) {
        if (m === 'GET') return send(res, 200, registry.bucketList().find((x) => x.id === registry.bucket(id).id));
        if (m === 'PATCH') { requireAdmin(req); return send(res, 200, await registry.updateBucket(id, await readJson(req))); }
        if (m === 'DELETE') { requireAdmin(req); const b = await registry.removeBucket(id); return send(res, 200, { ok: true, id: b.id }); }
      } else if (sub === 'tags' && m === 'GET') {
        return send(res, 200, { tags: await registry.bucketTags(id) });
      } else if (sub === 'files') {
        requireAdmin(req);
        if (!fileId && m === 'GET') return send(res, 200, { files: await registry.listFiles(id) });
        if (!fileId && m === 'POST') {
          registry.bucket(id); // 404 before reading a large body
          const name = decodeURIComponent(String(req.headers['x-filename'] || (req.knowbotAuth ? '' : url.searchParams.get('name')) || ''));
          const bytes = await readRaw(req, MAX_UPLOAD_BYTES);
          // through host-manager (60 s request cut) a retry must not ingest the same file twice: 409 if it is there
          return send(res, 201, await registry.upload(id, name, String(req.headers['content-type'] || '').split(';')[0].trim(), bytes, { once: !!req.knowbotAuth }));
        }
        if (fileId && m === 'DELETE') return send(res, 200, await registry.deleteFile(id, fileId));
        if (fileId && !parts4 && m === 'PATCH') return send(res, 200, await registry.moveFile(id, fileId, (await readJson(req)).folders));
        if (fileId && m === 'GET' && parts4 === 'atoms') return send(res, 200, await registry.fileAtoms(id, fileId, url.searchParams.get('limit')));
      }
    }
    throw new HttpError(['GET', 'POST', 'PATCH', 'DELETE'].includes(m) ? 404 : 405, `no such endpoint ${m} ${p}`);
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
  /** Is this root-relative path (split in segments) inside the web root? '' is the root itself. */
  function staticAllowed(segs) {
    const [top] = segs;
    if (segs.length === 1 && (top === '' || STATIC_FILES.has(top))) return true;
    if (top === 'demo') return builtinBot;
    if (top === 'corpus') return serveCorpus;
    const rel = segs.join('/');
    return STATIC_DIRS.has(top) && !STATIC_HIDDEN.some((h) => rel === h || rel.startsWith(`${h}/`));
  }
  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad path encoding'); }
    if (rel.includes('\0') || rel.includes('\\')) throw new HttpError(400, 'bad path');
    const abs = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new HttpError(403, 'forbidden');
    const segs = relToRoot.split(path.sep);
    if (segs.some((s) => s.startsWith('.')) || !staticAllowed(segs)) throw new HttpError(404, 'not found');
    // raw ".." in the request (e.g. %2e%2e) that normalized inside root is still refused, to be explicit
    if (rel.split('/').includes('..')) throw new HttpError(403, 'forbidden');
    // no built-in bot, so no demos: the root (index.html redirects to demo/) opens the Studio instead
    if (!builtinBot && (relToRoot === '' || relToRoot === 'index.html')) { res.writeHead(302, { location: './studio/' }); res.end(); return; }

    let file = abs, st;
    try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'not found'); }
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { location: path.posix.basename(pathname) + '/' }); res.end(); return; } // relative: stays under a proxy prefix
      file = path.join(abs, 'index.html');
      try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'not found'); }
    }
    const type = MIME[path.extname(file).toLowerCase()];
    if (!st.isFile() || !type) throw new HttpError(404, 'not found');
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

    // Through host-manager (it sets X-Kdex-Forwarded; a FAT only ever arrives that way): the dashboard and its API only,
    // under a CSP, since these pages run on host-manager's origin. The header only ever restricts, so forging it gains nothing.
    if (hmAuth && (req.headers['x-kdex-forwarded'] === 'true' || hmAuth.looksLikeFat(req))) {
      res.setHeader('content-security-policy', hmCsp);
      if (!hmRoute(m, p)) throw new HttpError(404, `no such endpoint ${p}`);
    }

    if (p === '/healthz' && m === 'GET') {
      return send(res, 200, { ok: true, retrieval: mode, files: local.fileCount, chunks: local.chunkCount, llm: await llmReachable(), llmBase, sseClients: clients.size });
    }

    // Restart safety: the Worker asks before it restarts the container for a new deploy (cloudflare/worker.js). Busy
    // while a website import runs (or is about to resume) or a phone call / web voice session is open. Only the Worker
    // may ask: the header secret is derived from KNOWBOT_ADMIN_TOKEN; without one the endpoint does not exist.
    if (p === '/api/internal/busy') {
      const want = adminToken ? Buffer.from(internalSecret(adminToken)) : null;
      const got = Buffer.from(String(req.headers[INTERNAL_HEADER] || ''));
      if (!want || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(404, `no such endpoint ${p}`);
      if (m !== 'GET') throw new HttpError(405, `method ${m} not allowed on ${p}`);
      const storeJobs = studio.busy?.().storeJobs || 0;
      const phone = phoneSessions().total || 0;
      const webVoice = activeWebVoiceSessions() || 0;
      res.setHeader('cache-control', 'no-store');
      return send(res, 200, { busy: storeJobs + phone + webVoice > 0, storeJobs, phone, webVoice });
    }

    if (isDevApiPath(p)) return devapi.handle(req, res, url, p, m); // /v1/*, /p/:id, bot keys + insights, trial devkey (server/devapi.mjs)
    if (p.startsWith('/api/studio/')) return studio.handle(req, res, url, p, m);
    if (INSTANCE_API.test(p)) return instanceRoutes(req, res, url, p, m);

    if (p.startsWith('/api/')) {
      switch (`${m} ${p}`) {
        case 'GET /api/config': {
          await registry.ready;
          const inst = registry.list().find((x) => x.id === registry.get(url.searchParams.get('instance')).id);
          return send(res, 200, { store, retrieval: mode, engine: { type: 'openai', model: inst?.model || llmModel }, canonical: { ...CANONICAL }, models: publicModels, instance: inst });
        }

        case 'POST /api/search': {
          const body = await readJson(req);
          const query = typeof body.query === 'string' ? body.query.trim() : '';
          if (!query) throw new HttpError(400, 'query is required');
          if (query.length > 4000) throw new HttpError(400, 'query too long');
          await registry.ready;
          const r = await registry.retriever(body.instance).search(query, body.k ?? 6);
          return send(res, 200, r);
        }

        case 'POST /api/reindex': {
          requireReader(req, url);
          const r = await local.reindex();
          return send(res, 200, { ok: true, ...r });
        }

        case 'POST /api/chat': {
          if (rateLimited(clientIp(req))) throw new HttpError(429, 'rate limit exceeded (30/min)');
          const rawBody = await readJson(req);
          const body = chatBody(rawBody);
          // the website widget's answers: Claude Haiku 5.5 when the server has the key (KNOWBOT_WIDGET_ENGINE=local keeps
          // the local model); any failure falls back to the local model below
          if (widgetEngine === 'haiku' && haiku?.available?.()) {
            const settings = { max_tokens: body.max_tokens, ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}) };
            let text = null;
            try { text = String(await haiku.complete(body.messages, settings) ?? ''); } catch (e) { log(`[chat] ${haiku.model} failed (${e.message}); local model`); }
            if (text !== null) {
              const model = haiku.model;
              const reply = body.stream
                ? `data: ${JSON.stringify({ id: `chatcmpl-${randomUUID().slice(0, 8)}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
                : JSON.stringify({ id: `chatcmpl-${randomUUID().slice(0, 8)}`, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
              res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...(body.stream ? { 'x-accel-buffering': 'no' } : {}) });
              res.end(reply);
              devapi.logChat({ body: rawBody, reply, stream: body.stream, callerKey: clientIp(req) });
              return;
            }
          }
          delete body.reasoning_effort; // a Claude setting: never forwarded to the local model
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
          let tap = ''; // the questions loop reads the reply once it has been relayed
          node.on('data', (c) => { if (tap.length < 262144) tap += c; });
          node.on('end', () => devapi.logChat({ body: rawBody, reply: tap, stream: body.stream, callerKey: clientIp(req) }));
          node.pipe(res);
          return;
        }

        case 'POST /api/canonical': {
          if (rateLimited(clientIp(req))) throw new HttpError(429, 'rate limit exceeded (30/min)');
          const body = await readJson(req);
          const question = typeof body.question === 'string' ? body.question.trim() : '';
          if (!question) throw new HttpError(400, 'question is required');
          if (question.length > 4000) throw new HttpError(400, 'question too long');
          // the question is logged by the pipeline (channel 'web'), as every surface's is
          const answer = await canonical({ question, sessionId: body.sessionId, turnId: body.turnId, history: body.history, instance: body.instance, callerKey: body.sessionId || clientIp(req) });
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
          // opened with a FAT: closed when it expires; EventSource reconnects through host-manager with a fresh one
          const until = req.knowbotAuth ? setTimeout(() => { try { res.end(); } catch {} }, Math.max(0, (req.knowbotAuth.exp + LEEWAY_S) * 1000 - Date.now())) : null;
          until?.unref?.();
          const drop = () => { clients.delete(res); clearTimeout(until); };
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
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] || 'content-type, authorization');
    // /v1 (and its /api/v1 alias): a browser client can read retry-after, the rate-limit headers and x-request-id, preflight included
    res.setHeader('access-control-expose-headers', isDevApiPath(String(req.url || '').split('?')[0]) ? DEV_EXPOSE_HEADERS : 'content-type');
    const isStream = req.url.startsWith('/api/stream') || /^\/api\/studio\/trials\/[^/]+\/(?:events|setup|ask|store)/.test(req.url);
    const logUrl = req.url.replace(/([?&][^=&]*token=)[^&]*/gi, '$1***').slice(0, 200); // never log a token (operator token, api_token, …)
    if (isStream) log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${logUrl} SSE open`);
    res.on('finish', () => {
      log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${logUrl} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`);
    });
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof HttpError || e instanceof InstanceError || e instanceof ProviderError ? e.status : 500;
      if (status === 500) log(`[error] ${req.method} ${logUrl}: ${e.stack || e}`);
      if (!res.headersSent) send(res, status, { error: { status, message: e.message || 'internal error', ...(e.extra || {}) } }, e.headers);
      else { try { res.end(); } catch {} }
    }
  });

  // WebSocket upgrades: only the phone channel's Twilio Media Streams path (/v1/channels/:botId/voice/media, and its /api
  // alias) is served; anything else is refused. The production Worker forwards these upgrades to this container.
  server.on('upgrade', (req, socket, head) => {
    let handled = false;
    try { handled = devapi.upgrade(req, socket, head); } catch (e) { log(`[error] upgrade ${req.url}: ${e.message}`); }
    if (!handled) { try { socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch {} }
  });

  server.on('close', () => {
    clearInterval(pingTimer); clearInterval(rlSweep); local.close(); studio.close(); devapi.close(); hmAuth?.close();
    for (const c of clients) { try { c.end(); } catch {} }
  });

  const origClose = server.close.bind(server);
  server.close = (cb) => {
    studio.close();
    for (const c of clients) { try { c.end(); } catch {} }
    clients.clear();
    server.closeAllConnections?.();
    return origClose(cb);
  };

  return { server, retriever, registry, studio, leads, local, mode, hmAuth, ready: local.ready, flush: () => writeQueue, config: { root, corpusDir, dataDir, libPath, llmBase, llmModel, builtinBot } };
}

// ------------------------------------------------------------ main
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Local runs: load knowbot/.env (git-ignored; see .env.example). Never overrides a variable already set, and the
  // live server never has this file (it gets the same names from Worker secrets).
  try {
    const envFile = path.join(__dirname, '..', '.env');
    if (existsSync(envFile)) {
      for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || line.trim().startsWith('#')) continue;
        const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
        if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    }
  } catch { /* a bad .env never stops the server */ }
  const port = Number(process.env.PORT || 8787);
  const kb = createKnowBotServer();
  // behind host-manager (KNOWBOT_AUTH_*) KnowBot is reached through it: loopback unless HOST says otherwise
  const host = process.env.HOST || (kb.hmAuth ? '127.0.0.1' : '0.0.0.0');
  if (kb.hmAuth && !/^(?:127\.|::1$|localhost$)/.test(host)) console.log(`[auth] KNOWBOT_AUTH_* is on but HOST=${host}: KnowBot's own port is reachable without host-manager`);
  kb.server.listen(port, host, () => {
    const c = kb.config;
    console.log(`[knowbot] listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`[knowbot] retrieval=${kb.mode} corpus=${c.corpusDir} llm=${c.llmBase} model=${c.llmModel}`);
    console.log(`[knowbot] dashboard: http://localhost:${port}/dashboard/${c.builtinBot ? `   demo: http://localhost:${port}/demo/` : ''}`);
  });
  const stop = () => { console.log('[knowbot] shutting down'); kb.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

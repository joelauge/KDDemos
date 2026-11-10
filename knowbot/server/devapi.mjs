// KnowBot developer platform (SPEC 11.2 + 11.3): the /v1 API, per-bot API keys, channel webhooks and proof links.
//
//   POST /v1/bots/:botId/chat          {question | messages, stream?, channel?}  → JSON answer, or SSE retrieval/delta/final/done
//   POST /v1/chat/completions          OpenAI-compatible (model = bot id); chat.completion / chat.completion.chunk objects,
//                                      citations as numbered footnotes in `content` AND a structured `knowbot` field
//   GET  /v1/models                    the bot this key can use, OpenAI list shape
//   POST /v1/bots/:botId/voice         audio in (or {text}) → transcript → answer → audio out (Google STT/TTS)
//   GET  /v1, /v1/openapi.json         API index and an OpenAPI 3.1 description
//   *    /v1/channels/:botId/<sms|voice|whatsapp|email>   provider webhooks (server/channels/*)
//   GET  /v1/channels/:botId           which channels this server can run, with the webhook URLs
//   GET  /p/:id (and /v1/p/:id)        public proof page of one answer: the question, the answer, every quoted line
//
//   admin (KNOWBOT_ADMIN_TOKEN):
//   GET|POST /api/instances/:id/keys, DELETE /api/instances/:id/keys/:keyId   live keys (kb_live_…), shown once
//   GET  /api/instances/:id/insights                                           top questions and gaps (questions.mjs)
//   trial (Studio bearer token):
//   GET  /api/studio/trials/:id/devkey                                         the trial's kb_trial_ key
//   public:
//   GET  /api/site/:botId                                                      a published Single-page site + a key that can
//                                                                              only ask questions (scope "site", a few hours)
//
// Keys: kb_live_<32 random bytes, base64url>. Only a SHA-256 of each key is kept, in a registry document that is itself
// AES-256-GCM sealed (the same sealing as provider keys) and stored in knowDrive at knowbot/_config/devkeys.json
// (kind:config, so never searchable) or, without knowDrive, in <dataDir>/devkeys.json. Trial keys are stateless:
// kb_trial_<payload>.<hmac>, scoped to one trial and expiring with it.
//
// Every answer goes through the same pipeline as the widget (guard → retrieval that excludes `questions` and
// `kind:config` → lib answerFromSources → requireCitations) and is logged to the questions loop with its channel.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { sealKey, openKey } from './providers.mjs';
import { logQuestion, questionInsights, NEVER_CITE_TAGS, parseQuestionPath, scrubQuestion, questionFromChat, hashCaller, CHANNELS } from './questions.mjs';
import { ChannelError, channelStatus, publicBase, answerLines, splitSentences, NOT_IN_DATA, formatSpoken, docTitle, formatSms, formatWhatsApp, formatEmail, smsInfo } from './channels/util.mjs';
import { SMS_MAX } from './channels/sms.mjs';
import { handleSms } from './channels/sms.mjs';
import { handleVoice, phoneEngine } from './channels/voice.mjs';
import { handleMediaStream } from './channels/voice-live.mjs';
import { handleWebVoice, webVoiceEngine } from './channels/webvoice.mjs';
import { acceptWebSocket, rejectUpgrade, isWebSocketUpgrade } from './channels/ws.mjs';
import { shopDomainFor } from './channels/shop.mjs';
import { handleWhatsApp } from './channels/whatsapp.mjs';
import { handleEmail } from './channels/email.mjs';
import { googleConfig, transcribe, synthesize } from './channels/google.mjs';
import { createResearchAgent } from './research.mjs';
import { createEvidenceSelector, createResolver, selectForRetriever, isRefusal, isAnswerable, hashFor } from './evidence.mjs';
import { createSendInfo } from './sendinfo.mjs';

export const DEVKEYS_PATH = 'knowbot/_config/devkeys.json';
export const KEY_RE = /^kb_(live|trial)_[A-Za-z0-9_.-]{20,600}$/;
const TRIAL_ID_RE = /^tr_[a-z2-7]{16}$/;
const BOT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PROOF_ID_RE = /^[A-Za-z0-9_-]{10,24}$/;
const CHAT_ROLES = new Set(['system', 'user', 'assistant', 'developer']);
const MAX_Q = 1000;

/** Response headers a browser client may read on every /v1 response (CORS). Both the OpenAI names (so SDK backoff
 * works unchanged) and the short x-ratelimit-* names, plus retry-after and x-request-id. */
export const EXPOSE_HEADERS = 'content-type, retry-after, x-request-id, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset';

/** True for the paths createDevApi().handle serves (the one dispatch test server.mjs uses). */
// Every /v1 route is also served under /api/v1 (and /p under /api/p): the production Worker forwards only /api/*.
export const isDevApiPath = (p) => p === '/v1' || p.startsWith('/v1/') || p === '/api/v1' || p.startsWith('/api/v1/') || /^\/(?:api\/)?p\/[A-Za-z0-9_-]+$/.test(p)
  || /^\/api\/instances\/[^/]+\/(?:keys|insights)(?:\/[^/]*)?$/.test(p) || /^\/api\/studio\/trials\/[^/]+\/devkey$/.test(p) || /^\/api\/site\/[^/]+$/.test(p);

export class ApiError extends Error {
  constructor(status, code, message, extra = {}, headers = {}) { super(message); this.status = status; this.code = code; this.extra = extra; this.headers = headers; }
}
const TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 405: 'invalid_request_error',
  409: 'conflict_error', 413: 'invalid_request_error', 415: 'invalid_request_error', 429: 'rate_limit_error', 503: 'service_unavailable' };

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const round4 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10000) / 10000);
const yyyymmdd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const rid = (n = 12) => randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n) || randomBytes(n).toString('hex').slice(0, n);
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const stripMarks = (s) => String(s || '').replace(/\s*\[\d{1,3}\]/g, '').replace(/\s+([.,;:!?])/g, '$1').trim();
/**
 * One answer line ("- Returns are accepted within 30 days. [1]") → one prose sentence with its citation marks inline
 * before the final stop ("Returns are accepted within 30 days [1]."), the way the Studio's SampleBot shows it.
 */
export function proseSentence(line) {
  const body = String(line || '').replace(/^\s*[-*•]\s+/, '').trim();
  // A line of several sentences (the librarian voice: opener, "In “Title”, it says: “…” [1].", closer) keeps each
  // sentence's own markers in place; a sentence without markers (a courtesy opener or closer) passes through as written.
  const parts = splitSentences(body);
  if (parts.length > 1) return parts.map((x) => (/\[\d{1,3}\]/.test(x) ? proseOne(x) : x.trim())).filter(Boolean).join(' ');
  return proseOne(body);
}
function proseOne(body) {
  const marks = [...new Set([...body.matchAll(/\[(\d{1,3})\]/g)].map((m) => m[1]))];
  let s = stripMarks(body).replace(/\s*\|\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  let stop = '.';
  const m = /([.!?…]+|[:;,])$/.exec(s);
  if (m) { if (/[.!?…]/.test(m[1])) stop = m[1]; s = s.slice(0, -m[1].length).trimEnd(); }
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return `${s}${marks.length ? ` ${marks.map((n) => `[${n}]`).join('')}` : ''}${stop}`;
}
/** A bulleted answer → the same answer as one paragraph of sentences (refusals and single plain lines pass through). */
export function proseAnswer(answer) {
  return String(answer || '').split('\n').map((l) => l.trim()).filter(Boolean).map(proseSentence).filter(Boolean).join(' ');
}
/**
 * format:"bullets": one claim per line with its marks at the end ("… “30 days” [1]" stays whole: a quotation never
 * splits). A line of several sentences (opener, cited sentence, closer) becomes one line per sentence; list items stay.
 */
export function bulletsAnswer(answer) {
  return String(answer || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).flatMap((l) => {
    if (/^\s*[-*•]\s/.test(l)) return [l];
    const parts = splitSentences(l);
    if (parts.length < 2) return [l];
    return parts.map((x) => {
      const marks = [...new Set([...x.matchAll(/\[(\d{1,3})\]/g)].map((m) => m[1]))];
      if (!marks.length) return x;
      let t = stripMarks(x);
      if (/”[.!?]?$/.test(t)) t = t.replace(/(”)[.!?]$/, '$1'); // “…” [1]: the quotation ends the claim
      else if (!/[.!?…]$/.test(t)) t = `${t.replace(/[:;,]$/, '')}.`;
      return `${t} ${marks.map((n) => `[${n}]`).join('')}`;
    });
  }).join('\n');
}
const textOfContent = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p && (p.type === 'text' || p.type === 'input_text') ? p.text || '' : '')).join('') : '');
const approxTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / 4));

/**
 * @param {{ env: object, registry: object, studio?: object, kd?: object|null, loadLib: Function, llmComplete: Function,
 *           completeWith: Function, readRaw: Function, readJson: Function, clientIp: Function, requireAdmin: Function,
 *           logger?: Function, dataDir: string, llmModel?: string, canonical?: object, secret?: string, now?: Function }} o
 */
export function createDevApi(o = {}) {
  const env = o.env || {};
  const log = o.logger || (() => {});
  const registry = o.registry;
  const studio = o.studio || null;
  const kd = o.kd || null;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  /** Milliseconds between streamed chat.completion.chunk deltas (capped so a whole answer streams in under ~1 s); 0 disables. */
  const streamPaceMs = Math.max(0, Number(o.streamPaceMs ?? env.KNOWBOT_STREAM_PACE_MS ?? 12) || 0);
  const llmModel = o.llmModel || env.LLM_MODEL || 'qwen2.5-1.5b-instruct';
  // every bot's answers (chat, API, widget, phone, SMS, WhatsApp, email): the research step when the server has a key
  const researchAgent = o.researchAgent !== undefined ? o.researchAgent : createResearchAgent(env, { log });
  // the evidence selector (server/evidence.mjs; KNOWBOT_EVIDENCE=attend): when it answers, its passages replace the search
  const evidence = o.evidence !== undefined ? o.evidence : createEvidenceSelector(env, { log });
  // resolve mode (KNOWBOT_EVIDENCE=resolve): the sidecar's ranked window replaces trialSearch's searches (a live bot's
  // retriever does the same itself); everything after the search is unchanged
  const resolver = o.resolver !== undefined ? o.resolver : createResolver(env, { log });
  const CANON = o.canonical || { temperature: 0, top_p: 1, max_tokens: 300, seed: 7, frequency_penalty: 0.4 };
  const sealSecret = String(o.secret || registry?.secret || env.KNOWBOT_SECRET_KEY || env.KNOWBOT_ADMIN_TOKEN || 'knowbot-local-dev');
  const trialSecret = env.KNOWBOT_SECRET_KEY || env.KNOWBOT_ADMIN_TOKEN || randomBytes(32).toString('hex');
  const limits = {
    live: Number(env.KNOWBOT_API_RATE_LIMIT || 60),        // requests per minute per live key
    trial: Number(env.KNOWBOT_API_TRIAL_RATE_LIMIT || 20), // per trial key
    site: Number(env.KNOWBOT_SITE_RATE_LIMIT || 60),       // Single-page site: questions per minute per bot (all visitors)
    siteIp: Number(env.KNOWBOT_SITE_IP_RATE_LIMIT || 10),  // … and per visitor address
    siteKeyMs: Number(env.KNOWBOT_SITE_KEY_MS || 6 * 3600 * 1000), // a site key's life (never past its trial)
    channel: Number(env.KNOWBOT_CHANNEL_RATE_LIMIT || 12), // per caller per bot per channel
    ...(o.limits || {}),
  };
  // "send me this": one shared instance (server.mjs passes the same one to the Studio), else this module's own
  const sendInfo = o.sendInfo || createSendInfo({ env, log, now, dataDir: o.dataDir });
  const background = new Set();
  const track = (p) => { const q = Promise.resolve(p).catch(() => {}).finally(() => background.delete(q)); background.add(q); return q; };

  // ---------------------------------------------------------------- rate limits (sliding window: a minute unless `ms` says otherwise)
  const windows = new Map();
  function limit(key, n, ms = 60000) {
    if (!n) return { limited: false, remaining: Infinity, reset: 0 };
    const t = now();
    const arr = (windows.get(key) || []).filter((x) => t - x < ms);
    arr.ms = ms;
    const reset = Math.ceil(((arr[0] ?? t) + ms - t) / 1000);
    if (arr.length >= n) { windows.set(key, arr); return { limited: true, remaining: 0, reset, retryAfter: Math.max(1, reset) }; }
    arr.push(t); windows.set(key, arr);
    return { limited: false, remaining: n - arr.length, reset };
  }
  const sweep = setInterval(() => { const t = now(); for (const [k, a] of windows) if (!a.some((x) => t - x < (a.ms || 60000))) windows.delete(k); }, 60000);
  sweep.unref?.();

  // ---------------------------------------------------------------- live keys (hashed, sealed)
  const K = { list: [], byHash: new Map(), loaded: null, chain: Promise.resolve() };
  const kdKey = () => (typeof kd?.apiKey === 'function' ? kd.apiKey() : kd?.apiKey);
  const kdFetch = (p, init = {}) => fetch(`${kd.baseUrl}${p}`, { ...init, headers: { authorization: `Bearer ${kdKey()}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(init.timeout || 20000) });
  function indexKeys() { K.byHash = new Map(K.list.filter((k) => !k.revokedAt).map((k) => [k.hash, k])); }
  function loadKeys() {
    if (!K.loaded) {
      K.loaded = (async () => {
        let raw = null;
        if (kd) {
          const res = await kdFetch(`/api/v1/vector_stores/${encodeURIComponent(kd.store)}/path/content/${DEVKEYS_PATH.split('/').map(encodeURIComponent).join('/')}`);
          if (res.ok) raw = await res.text(); else if (res.status !== 404) throw new Error(`knowDrive HTTP ${res.status} reading API keys`);
        } else {
          try { raw = await fsp.readFile(path.join(o.dataDir, 'devkeys.json'), 'utf8'); } catch { /* none yet */ }
        }
        if (raw) {
          const doc = JSON.parse(raw);
          const inner = JSON.parse(openKey(doc.sealed, sealSecret));
          K.list = Array.isArray(inner.keys) ? inner.keys.filter((k) => k && typeof k.hash === 'string' && BOT_ID_RE.test(String(k.bot))) : [];
        }
        indexKeys();
      })().catch((e) => { K.loaded = null; throw new ApiError(503, 'keys_unavailable', `API keys could not be loaded: ${e.message}`); });
    }
    return K.loaded;
  }
  function saveKeys() {
    const doc = JSON.stringify({ v: 1, kind: 'knowbot-devkeys', sealed: sealKey(JSON.stringify({ keys: K.list }), sealSecret) });
    K.chain = K.chain.catch(() => {}).then(async () => {
      if (!kd) {
        await fsp.mkdir(o.dataDir, { recursive: true });
        await fsp.writeFile(path.join(o.dataDir, 'devkeys.json'), doc, { mode: 0o600 });
        return;
      }
      const fd = new FormData();
      fd.append('tags', 'knowbot,kind:config');
      fd.append('mime_type', 'application/json');
      fd.append('file', new Blob([doc], { type: 'application/json' }), DEVKEYS_PATH);
      const res = await kdFetch('/api/v1/ingest', { method: 'POST', headers: { 'x-vector-store-id': kd.store }, body: fd, timeout: 30000 });
      if (!res.ok) throw new ApiError(502, 'upstream', `saving API keys failed: knowDrive HTTP ${res.status}`);
    });
    return K.chain;
  }
  const keyView = (k) => ({ id: k.id, bot: k.bot, name: k.name || null, prefix: 'kb_live_', last4: k.last4, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null, revokedAt: k.revokedAt || null });
  async function createKey(botId, name) {
    await loadKeys();
    const key = `kb_live_${b64u(randomBytes(32))}`;
    const rec = { id: `key_${rid(14)}`, bot: botId, name: String(name || '').trim().slice(0, 60) || null, hash: sha256(key), last4: key.slice(-4), createdAt: new Date(now()).toISOString() };
    const before = K.list;
    K.list = [...K.list, rec]; indexKeys();
    try { await saveKeys(); } catch (e) { K.list = before; indexKeys(); throw e; }
    return { ...keyView(rec), key };
  }
  async function revokeKey(botId, keyId) {
    await loadKeys();
    const rec = K.list.find((k) => k.id === keyId && k.bot === botId);
    if (!rec) throw new ApiError(404, 'not_found', 'No such key for this bot.');
    if (rec.revokedAt) return keyView(rec);
    const before = K.list;
    K.list = K.list.map((k) => (k === rec ? { ...k, revokedAt: new Date(now()).toISOString() } : k)); indexKeys();
    try { await saveKeys(); } catch (e) { K.list = before; indexKeys(); throw e; }
    return keyView(K.list.find((k) => k.id === keyId));
  }

  // ---------------------------------------------------------------- trial keys (stateless)
  const trialSig = (payload) => createHmac('sha256', `knowbot-devkey\n${trialSecret}`).update(payload).digest().subarray(0, 18).toString('base64url');
  // scope "site": the Single-page site's key (GET /api/site/:id). It can only ask questions (POST /v1/bots/:id/chat), is
  // limited per bot and per visitor address, and lives a few hours: the page fetches a fresh one when it runs out.
  function trialKey(trialId, expiresAt, scope = null) {
    const payload = b64u(JSON.stringify({ t: trialId, e: Number(expiresAt), ...(scope ? { s: scope } : {}) }));
    return `kb_trial_${payload}.${trialSig(payload)}`;
  }
  function openTrialKey(key) {
    const body = key.slice('kb_trial_'.length);
    const dot = body.lastIndexOf('.');
    if (dot < 1) return null;
    const payload = body.slice(0, dot), sig = body.slice(dot + 1);
    if (!eq(sig, trialSig(payload))) return null;
    try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return TRIAL_ID_RE.test(d.t) && Number(d.e) > 0 && (d.s == null || d.s === 'site') ? d : null; } catch { return null; }
  }

  // ---------------------------------------------------------------- auth
  const bearerOf = (req) => { const a = String(req.headers.authorization || ''); return /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : ''; };
  /** → {kind, bot, keyId, expiresAt?}. Throws 401/403. */
  async function authKey(req, botId = null, { site = false } = {}) {
    const token = bearerOf(req);
    if (!token) throw new ApiError(401, 'missing_api_key', 'Send your KnowBot API key as "Authorization: Bearer kb_…".');
    // a kb_live_/kb_trial_ key that fails to verify is a bad key, not a wrong kind of key: say so
    const BAD_KEY = 'This API key is invalid, revoked or expired.';
    if (!/^kb_(?:live|trial)_/.test(token)) throw new ApiError(401, 'invalid_api_key', 'That is not a KnowBot API key (they start with kb_live_ or kb_trial_).');
    if (!KEY_RE.test(token)) throw new ApiError(401, 'invalid_api_key', BAD_KEY);
    let who;
    if (token.startsWith('kb_trial_')) {
      const d = openTrialKey(token);
      if (!d) throw new ApiError(401, 'invalid_api_key', BAD_KEY);
      if (!(d.e > now())) throw new ApiError(401, 'expired_api_key', 'This trial key expired with its trial.');
      who = d.s === 'site' ? { kind: 'trial', scope: 'site', bot: d.t, keyId: `site:${d.t}`, expiresAt: d.e } : { kind: 'trial', bot: d.t, keyId: `trial:${d.t}`, expiresAt: d.e };
      if (who.scope === 'site' && !site) throw new ApiError(403, 'wrong_scope', 'This key can only ask questions on its Single-page site.');
    } else {
      await loadKeys();
      const rec = K.byHash.get(sha256(token));
      if (!rec) throw new ApiError(401, 'invalid_api_key', BAD_KEY);
      rec.lastUsedAt = new Date(now()).toISOString();
      who = { kind: 'live', bot: rec.bot, keyId: rec.id };
    }
    if (botId && String(botId).toLowerCase() !== who.bot) throw new ApiError(403, 'wrong_bot', 'This key is not valid for this bot.'); // never echo the key's own bot id
    return who;
  }
  function rateLimit(res, who) {
    if (who.scope === 'site') {
      const ip = typeof o.clientIp === 'function' ? o.clientIp(res.req) : (res.req?.socket?.remoteAddress || 'unknown');
      const r2 = limit(`siteip:${who.bot}:${ip}`, limits.siteIp);
      if (r2.limited) throw new ApiError(429, 'rate_limit_exceeded', `Too many questions at once. Try again in ${r2.retryAfter}s.`, {}, { 'retry-after': String(r2.retryAfter) });
    }
    const n = who.scope === 'site' ? limits.site : who.kind === 'trial' ? limits.trial : limits.live;
    const r = limit(`key:${who.keyId}`, n);
    if (Number.isFinite(n) && n > 0) {
      const rem = String(Math.max(0, r.remaining));
      res.setHeader('x-ratelimit-limit', String(n));
      res.setHeader('x-ratelimit-remaining', rem);
      res.setHeader('x-ratelimit-reset', String(r.reset));
      // OpenAI header names: the official SDKs read these (reset as a duration, e.g. "12s") for their own backoff
      res.setHeader('x-ratelimit-limit-requests', String(n));
      res.setHeader('x-ratelimit-remaining-requests', rem);
      res.setHeader('x-ratelimit-reset-requests', `${Math.max(0, r.reset)}s`);
    }
    if (r.limited) throw new ApiError(429, 'rate_limit_exceeded', `Rate limit reached (${n} requests per minute for this key). Retry in ${r.retryAfter}s.`, {}, { 'retry-after': String(r.retryAfter) });
  }

  // ---------------------------------------------------------------- targets (live bot or Studio trial)
  async function loadTrialDoc(id) {
    if (!kd || !studio?.store) return null;
    try {
      const res = await kdFetch(`/api/v1/vector_stores/${encodeURIComponent(studio.store)}/path/content/${`knowbot/trials/${id}/_spec.json`.split('/').map(encodeURIComponent).join('/')}`, { timeout: 10000 });
      if (!res.ok) return null;
      return JSON.parse(await res.text());
    } catch { return null; }
  }
  async function resolveTarget(botId, who = null) {
    const id = String(botId || '').toLowerCase();
    if (TRIAL_ID_RE.test(id)) {
      if (!studio?.enabled) throw new ApiError(503, 'no_store', 'Trial bots need the Studio (a knowDrive store) on this server.');
      const T = studio.trials?.get?.(id) || null;
      let spec = T?.specLoaded ? T.spec : null;
      let expiresAt = who?.expiresAt || T?.expiresAt || null;
      let flags = T?.specLoaded ? T.flags : null;
      if (!spec) {
        const doc = await loadTrialDoc(id);
        if (doc?.spec) { spec = doc.spec; expiresAt = expiresAt || Date.parse(doc.expiresAt) || null; flags = doc.flags || null; }
      }
      if (!spec && T?.spec) spec = T.spec;
      if (!spec) throw new ApiError(404, 'bot_not_found', `No bot "${id}".`);
      if (expiresAt && expiresAt <= now()) throw new ApiError(404, 'bot_not_found', 'This trial expired and its files were deleted.');
      // flags (e.g. the Shopify store import that turns on texted product links) also when only the saved doc is loaded
      return { kind: 'trial', id, T, spec, flags: flags || T?.flags || null, expiresAt: expiresAt || now() + 86400000, name: spec.name || 'Your bot' };
    }
    if (!BOT_ID_RE.test(id)) throw new ApiError(404, 'bot_not_found', `No bot "${botId}".`);
    await registry.ready;
    let inst;
    try { inst = registry.get(id); } catch { throw new ApiError(404, 'bot_not_found', `No bot "${id}".`); }
    if (inst.id !== id) throw new ApiError(404, 'bot_not_found', `No bot "${id}".`);
    return { kind: 'live', id, inst, name: inst.botName || inst.name || inst.org || id };
  }

  // ---------------------------------------------------------------- retrieval
  const isQuestionFile = (name) => !!parseQuestionPath(name) || /(^|\/)_config\//.test(String(name || ''));
  const contentText = (d) => (Array.isArray(d.content) ? d.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n') : typeof d.content === 'string' ? d.content : String(d.text || ''));
  const simOf = (d) => (d.distance != null && Number.isFinite(Number(d.distance)) ? 1 - Number(d.distance) / 2 : Number(d.score));

  const chunkKey = (file, text) => `${file}\u0000${String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)}`;
  /** Vector similarities (never RRF) for a live bot's hits, by file and by chunk; absent where the retriever has none. */
  async function liveSimilarities(retriever, question) {
    const sims = new Map();
    const parts = Array.isArray(retriever?.parts) ? retriever.parts.map((p) => p.retriever) : [retriever];
    await Promise.all(parts.filter((r) => r && typeof r.query === 'function' && typeof r.mapResult === 'function').map(async (r) => {
      try {
        // production: a pure vector search under a narrow tag filter can come back empty while hybrid (same filter) still
        // finds the atoms, each hit carrying its vector `distance`; only that distance is a similarity (RRF never is)
        let docs = await r.query(question, 8, 'vector');
        if (!docs.length) docs = (await r.query(question, 8, 'hybrid')).filter((d) => d && d.distance != null && Number.isFinite(Number(d.distance)));
        for (const d of docs) {
          const m = r.mapResult(d);
          if (!m || !m.text) continue;
          const s = simOf(d);
          if (!Number.isFinite(s)) continue;
          sims.set(m.filename, Math.max(sims.get(m.filename) ?? 0, s));
          sims.set(chunkKey(m.filename, m.text), Math.max(sims.get(chunkKey(m.filename, m.text)) ?? 0, s));
        }
      } catch { /* similarity stays unknown */ }
    }));
    return sims;
  }

  async function trialSearch(t, question) {
    const store = studio.store;
    const none = [...NEVER_CITE_TAGS, 'kind:trial-spec'];
    const disabled = new Set(Object.entries(t.spec.sources || {}).filter(([, v]) => v === false).map(([k]) => k));
    const shared = t.T?.flags?.sharedSet && t.T?.flags?.sharedAt ? t.T.flags.sharedSet : null;
    const filters = [{ all_of: [`trial:${t.id}`], none_of: none }, ...(shared ? [{ all_of: [`sample-set:${shared}`, 'kind:trial-sample'], none_of: none }] : [])];
    const page = async (filter, mode) => {
      const res = await kdFetch(`/api/v1/vector_stores/${encodeURIComponent(store)}/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 10000,
        body: JSON.stringify({ query: question, max_num_results: 12, mode, text: 'raw', filter, fields: 'tags,uri,score,text,file_id,metadata' }),
      });
      if (!res.ok) throw new ApiError(502, 'upstream', `knowDrive search failed (HTTP ${res.status})`);
      const j = await res.json();
      return Array.isArray(j.data) ? j.data : [];
    };
    // resolve mode: one ranked window over the trial's scope and its shared samples (ORed), resolve's order kept; each
    // passage's similarity (its cosine with the question) is the floor's measure, as a vector hit's is. null: search.
    const rw = resolver ? await resolver.resolve({ store, question, scopes: filters.map((f) => ({ tags_all: f.all_of, tags_none: f.none_of })), limit: 20, bot: t.id }) : null;
    // production: a pure vector search under a narrow tag filter (one trial) can come back empty while hybrid, same
    // filter, finds the atoms and still reports each hit's vector `distance`; keep only those (simOf scores by distance,
    // never by the RRF score)
    const pages = rw ? [rw.docs] : await Promise.all(filters.map(async (filter) => {
      const v = await page(filter, 'vector');
      if (v.length) return v;
      return (await page(filter, 'hybrid')).filter((d) => d && d.distance != null && Number.isFinite(Number(d.distance)));
    }));
    const seen = new Set();
    const hits = [];
    for (const d of pages.flat()) {
      const tags = Array.isArray(d.tags) ? d.tags.map(String) : null;
      if (!tags) continue; // fail closed: an untagged hit cannot be proven in scope
      const inScope = tags.includes(`trial:${t.id}`) || (shared && tags.includes(`sample-set:${shared}`) && tags.includes('kind:trial-sample'));
      if (!inScope || none.some((x) => tags.includes(x)) || disabled.has(d.file_id) || isQuestionFile(d.filename)) continue;
      const text = contentText(d);
      if (!text) continue;
      const k = `${d.file_id}|${sha256(text).slice(0, 16)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const filename = String(d.filename || '').split('/').pop();
      hits.push({ file_id: d.file_id, filename, title: docTitle(d.attributes?.breadcrumb ? String(d.attributes.breadcrumb).split(' > ')[0] : '', filename), url: null, score: round4(simOf(d)), similarity: round4(simOf(d)), text,
        ...(rw && d.content_hash ? { content_hash: d.content_hash } : {}) });
    }
    if (rw) Object.defineProperty(hits, 'receipt', { value: rw.digest, enumerable: false });
    else hits.sort((a, b) => b.similarity - a.similarity);
    return hits;
  }

  /** The selector's evidence for a trial bot, fenced like trialSearch (scope tags, disabled files, stored questions). */
  async function trialEvidence(t, question) {
    if (!evidence || !studio?.store) return null;
    const none = [...NEVER_CITE_TAGS, 'kind:trial-spec'];
    const disabled = new Set(Object.entries(t.spec.sources || {}).filter(([, v]) => v === false).map(([k]) => k));
    const shared = t.T?.flags?.sharedSet && t.T?.flags?.sharedAt ? t.T.flags.sharedSet : null;
    const scopes = [{ tags_all: [`trial:${t.id}`], tags_none: none }, ...(shared ? [{ tags_all: [`sample-set:${shared}`, 'kind:trial-sample'], tags_none: none }] : [])];
    const sel = await evidence.select({ store: studio.store, question, scopes }).catch(() => null);
    if (!sel || (!isRefusal(sel) && !isAnswerable(sel))) return null;
    const results = sel.sources.filter((x) => !disabled.has(x.file_id) && !isQuestionFile(x.path)).map((x) => {
      const filename = String(x.path || '').split('/').pop();
      return { ...x, filename, title: docTitle(x.title ? String(x.title).split(' · ')[0] : '', filename), url: null, evidence: true };
    });
    if (isAnswerable(sel) && !results.length) return { ...sel, status: 'none_in_window', results: [] };
    return { ...sel, results };
  }

  // ---------------------------------------------------------------- the answer pipeline
  /**
   * @returns {Promise<{ id, bot, botName, question, answer, refused, grounded, citations, proof, latencyMs, guard? }>}
   */
  async function answer(target, question, { history = [], channel = 'api', callerKey = null, onRetrieval } = {}) {
    const t0 = performance.now();
    const lib = await o.loadLib();
    const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
    let persona, profile, results = [], sims = new Map(), floor = null, retriever = null, mode = 'select', complete, settings = { ...CANON, ...(lib.CANONICAL || {}) };
    if (target.kind === 'trial') {
      const s = target.spec;
      persona = { name: s.name || 'KnowBot', org: s.org || s.name || 'this company', ...(s.instructions ? { instructions: s.instructions } : {}) };
      profile = 'general';
      floor = Number(s.floor) || 0.7;
      complete = (m, c) => o.llmComplete(m, c?.settings || settings);
    } else {
      const inst = target.inst;
      persona = { name: 'KnowBot', org: inst.org || inst.name, ...(inst.botName ? { name: inst.botName } : {}), ...(inst.instructions ? { instructions: inst.instructions } : {}) };
      profile = inst.guards || 'general';
      mode = inst.answerMode || env.KNOWBOT_ANSWER_MODE || 'select';
      const provider = inst.provider || 'local';
      complete = provider === 'local'
        ? (m, c) => o.llmComplete(m, c?.settings || settings, inst.model || llmModel)
        : (m, c) => o.completeWith(provider, registry.providerKey(provider), inst.model, m, c?.settings || settings);
      retriever = registry.retriever(inst.id);
    }
    // Token metering: every model call's full prompt (system + grounding context + history + question) and its output.
    // A provider that reports usage ({usage:{prompt_tokens, completion_tokens}} on its result) is counted exactly;
    // otherwise the count is an estimate (chars / 4) and the response says so (knowbot.usageEstimated).
    const meter = { calls: 0, prompt: 0, completion: 0, real: { prompt: 0, completion: 0, calls: 0 } };
    const msgText = (m) => (Array.isArray(m) ? m : [m]).map((x) => (typeof x === 'string' ? x : `${x?.role || ''}: ${typeof x?.content === 'string' ? x.content : JSON.stringify(x?.content ?? '')}`)).join('\n');
    const outText = (r) => (typeof r === 'string' ? r : String(r?.text ?? r?.content ?? r?.choices?.[0]?.message?.content ?? ''));
    const rawComplete = complete;
    complete = async (m, c) => {
      meter.calls++;
      meter.prompt += approxTokens(msgText(m)) + 4 * (Array.isArray(m) ? m.length : 1); // + per-message chat framing
      const r = await rawComplete(m, c);
      const u = r && typeof r === 'object' ? r.usage : null;
      if (u && Number.isFinite(Number(u.prompt_tokens))) { meter.real.calls++; meter.real.prompt += Number(u.prompt_tokens); meter.real.completion += Number(u.completion_tokens) || 0; }
      meter.completion += approxTokens(outText(r));
      return r;
    };
    // In select mode an unreachable model falls back to the keyword selector rather than failing the answer.
    const safeComplete = mode === 'select' ? async (m, c) => { try { return await complete(m, c); } catch (e) { log(`[devapi] model failed (${e.message}); keyword fallback`); return ''; } } : complete;

    // A hit's similarity is its own chunk's vector similarity; a hit only the keyword side found is labelled, not scored.
    const hitView = (r) => {
      const sim = sims.get(chunkKey(r.filename, r.text));
      return { file: r.filename, similarity: round4(sim ?? null), ...(sim == null ? { label: r.evidence ? 'selected passage' : 'keyword match' } : {}), excerpt: String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
    };
    const guard = typeof lib.guardRequest === 'function' ? lib.guardRequest(q, persona, { profile }) : null;
    let fin = guard, tRet = performance.now(), top = null, candidates = [], sel = null, resolvedReceipt = null;
    if (!guard) {
      // the evidence selector, when on and answering, replaces the search below (and the research agent's search tool)
      sel = target.kind === 'trial' ? await trialEvidence(target, q) : await selectForRetriever(evidence, retriever, q);
      if (sel) {
        results = isRefusal(sel) ? [] : sel.results;
        candidates = results.slice(0, 5);
      } else if (target.kind === 'trial') {
        const hits = await trialSearch(target, q);
        // (resolve mode keeps resolve's order, so the best similarity is not always first)
        top = hits.length ? Math.max(...hits.map((h) => h.similarity)) : 0;
        resolvedReceipt = hits.receipt || null;
        candidates = hits.slice(0, 5);
        results = hits.filter((h) => h.similarity >= floor).slice(0, 6);
        for (const h of hits) { sims.set(h.filename, Math.max(sims.get(h.filename) ?? 0, h.similarity)); sims.set(chunkKey(h.filename, h.text), h.similarity); }
      } else {
        const [ret, s] = await Promise.all([retriever.search(q, 6), liveSimilarities(retriever, q)]);
        sims = s;
        resolvedReceipt = ret.receipt || null;
        // never cite a stored question or a config file, whatever the retriever returned
        results = (ret.results || []).filter((r) => r && r.text && !isQuestionFile(r.filename));
        top = ret.floor?.top ?? (sims.size ? Math.max(...sims.values()) : null);
        floor = ret.floor?.min ?? null;
        candidates = results.slice(0, 5);
      }
      tRet = performance.now();
      onRetrieval?.({ hits: (results.length ? results : candidates).slice(0, 6).map((r) => ({ ...hitView(r), title: r.title || null, kept: results.includes(r) })),
        floor: { min: floor, top: round4(top) }, ms: Math.round(tRet - t0) });
      // voice: every bot answers as a kind librarian (lib guideText): where it found it, the exact words, one opener/closer
      // the selector found nothing that answers it: the fixed refusal, no model call
      if (sel && isRefusal(sel)) fin = { text: NOT_IN_DATA, citations: [], grounded: false, refused: true, fallback: false };
      else {
        const r = await lib.answerFromSources({ question: q, results, complete: safeComplete, search: !sel && retriever ? (x) => retriever.search(x, 6) : undefined, persona, minScore: 0, k: 6,
          history: Array.isArray(history) ? history : [], mode, settings, voice: target.inst?.voice ?? true, evidenceOnly: !!sel,
          ...(mode === 'select' && researchAgent ? { research: researchAgent, onResearch: (e) => { if (e.type === 'error') log(`[api] research failed: ${e.message}`); } } : {}) });
        fin = r.fin;
      }
    } else onRetrieval?.({ hits: [], floor: { min: null, top: null }, ms: 0, guard: guard.guard || 'guard' });

    const refused = !!fin.refused;
    // A courtesy opener never hedges right before a verbatim quote on the API and channels ("I think I found …" → "Good news, I found …").
    // CONTRACT-GAP: lib/knowbot.js (owner Q) OPENERS still contains the hedging form for Studio; drop it there to align every surface.
    const text = refused && !guard ? NOT_IN_DATA : String(fin.text || '').replace(/^I think I found what you(?:'|’)re looking for!/, "Good news, I found what you're looking for!");
    const lines = refused ? [] : answerLines(text, { markdown: true });
    // The verbatim quote of a cited line is the span inside “…” right before its [n] (the librarian voice wraps the source's
    // exact words in curly quotes and names the document around them); a cited line with no such span is quoted whole,
    // minus the document pointer. Lines with no [n] (a courtesy opener or closer) are never quotes.
    const isCourtesy = typeof lib.isCourtesy === 'function' ? lib.isCourtesy : () => false;
    const quoted = lines.flatMap((l) => {
      const spans = [...l.matchAll(/“([^”\n]+)”\s*((?:\[\d{1,3}\]\s*)+)/g)].flatMap((m) => [...m[2].matchAll(/\[(\d{1,3})\]/g)].map((k) => ({ n: Number(k[1]), text: m[1].trim() })));
      if (spans.length) return spans;
      const n = Number(/\[(\d{1,3})\]/.exec(l)?.[1]) || null;
      const t = stripMarks(l).replace(/^\s*[-*•]\s+/, '').replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, '$1');
      return n && !isCourtesy(t) ? [{ n, text: t }] : [];
    }).filter((x) => x.n && x.text)
      .map((x) => { const c = (fin.citations || []).find((y) => y.n === x.n); const h = (sel || resolvedReceipt) && c?.file_id ? hashFor(results, c.file_id, x.text) : null;
        return { ...x, file: c?.filename || null, ...(c?.file_id ? { fileId: c.file_id } : {}), ...(h ? { contentHash: h } : {}) }; });
    // One footnote, one verbatim span: excerpt is the FIRST line quoted under [n] exactly as written (never two lines
    // stitched together); every line quoted under [n] is listed, each verbatim, in spans (and in proof.quoted).
    const citations = refused ? [] : (fin.citations || []).map((c) => {
      const qs = quoted.filter((x) => x.n === c.n).map((x) => x.text);
      const snip = String(c.snippet || '').replace(/\s+/g, ' ').trim();
      return { n: c.n, file: c.filename, title: docTitle(c.title, c.filename), excerpt: qs[0] || snip, spans: qs.length ? qs : snip ? [snip] : [], ...(c.url ? { url: c.url } : {}),
        ...(Number.isInteger(c.page) && c.page > 0 ? { page: c.page } : {}), ...(typeof c.section === 'string' && c.section.trim() ? { section: c.section.trim() } : {}),
        similarity: round4(sims.get(c.filename) ?? null) };
    });
    const hits = (refused ? candidates : results).slice(0, 6).map(hitView);
    const latencyMs = Math.round(performance.now() - t0);
    // usage: exact when every model call reported it; else estimated from the full prompt actually sent (or, when no
    // model ran, from the question, history and retrieved context the answer was built from)
    const exact = meter.calls > 0 && meter.real.calls === meter.calls;
    const ctxChars = (results.length ? results : candidates).reduce((n, r) => n + String(r.text || '').length, 0);
    const histChars = (Array.isArray(history) ? history : []).reduce((n, m) => n + String(m?.content || '').length, 0);
    const tokens = exact
      ? { prompt: meter.real.prompt, completion: meter.real.completion, estimated: false, modelCalls: meter.calls }
      : { prompt: meter.calls ? meter.prompt : Math.ceil((q.length + histChars + ctxChars) / 4) + 8, completion: Math.max(meter.completion, approxTokens(text)), estimated: true, modelCalls: meter.calls };
    const out = {
      id: `ans_${rid(16)}`, bot: target.id, botName: target.name, question: q, answer: text, refused, grounded: !refused && citations.length > 0, citations,
      proof: { hits, quoted, floor: { min: floor, top: round4(top) }, ...(sel?.receipt?.digest ? { receipt: { digest: sel.receipt.digest } } : resolvedReceipt ? { receipt: { digest: resolvedReceipt } } : {}) }, latencyMs, retrievalMs: Math.round(tRet - t0), tokens, ...(guard ? { guard: guard.guard || 'guard' } : {}),
    };
    logAnswer(target, out, channel, callerKey);
    return out;
  }

  /** Fire-and-forget: the questions loop (never delays or fails an answer). */
  function logAnswer(target, a, channel, callerKey, extra = {}) {
    try {
      const ch = CHANNELS.includes(channel) ? channel : 'api';
      const base = { question: a.question, outcome: a.refused ? 'refused' : 'answered', citations: a.citations.map((c) => ({ file: c.file })),
        topScore: a.proof.floor.top ?? a.citations[0]?.similarity ?? null, channel: ch, callerKey, ...extra };
      const p = target.kind === 'trial'
        ? logQuestion({ ...base, kd: kd ? { ...kd, store: studio.store } : null, store: studio?.store, scopeTags: [`trial:${target.id}`, 'kind:trial', `expires:${yyyymmdd(target.expiresAt)}`], root: `knowbot/trials/${target.id}/` })
        : logQuestion({ ...base, kd, store: kd?.store, scopeTags: [`bot:${target.id}`], root: `knowbot/_bots/${target.id}/` });
      track(p);
      if (target.kind === 'trial') studio?.noteAsk?.(target.id, { question: base.question, outcome: base.outcome, channel: ch });
    } catch (e) { log(`[devapi] question log failed: ${e.message}`); }
  }

  /**
   * For server.mjs's own answer paths (/api/canonical, /api/chat): log a live-bot question. Never throws.
   * @param {{ instance?: string, question: string, outcome: string, citations?: object[], topScore?: number|null, channel?: string, callerKey?: string }} a
   */
  function logLive(a) {
    try {
      Promise.resolve(registry.ready).then(() => {
        let id;
        try { id = registry.get(a.instance).id; } catch { return; }
        const citations = (a.citations || []).map((c) => ({ file: c.filename || c.file || c.title }));
        track(logQuestion({ kd, store: kd?.store, scopeTags: [`bot:${id}`], root: `knowbot/_bots/${id}/`, question: a.question, outcome: a.outcome,
          citations, topScore: a.topScore ?? null, channel: CHANNELS.includes(a.channel) ? a.channel : 'web', callerKey: a.callerKey }));
      }).catch(() => {});
    } catch { /* never affects the answer */ }
  }
  /** /api/chat relay: the question from the prompt, the outcome from the model's reply text (JSON or SSE). */
  function logChat({ body, reply = '', stream = false, callerKey }) {
    try {
      const question = questionFromChat(body?.messages);
      if (!question) return;
      let text = '';
      if (stream) {
        for (const line of String(reply).split('\n')) {
          const m = /^data:\s*(\{.*\})\s*$/.exec(line);
          if (!m) continue;
          try { const j = JSON.parse(m[1]); text += j?.choices?.[0]?.delta?.content || ''; } catch { /* partial */ }
        }
      } else { try { text = JSON.parse(reply)?.choices?.[0]?.message?.content || ''; } catch { text = ''; } }
      if (!String(text).trim()) return;
      const refused = /^\s*none\b/i.test(text) || text.includes(NOT_IN_DATA);
      logLive({ instance: body?.instance, question, outcome: refused ? 'refused' : 'answered', channel: 'web', callerKey });
    } catch { /* never affects the relay */ }
  }

  // ---------------------------------------------------------------- proofs (/p/:id)
  // The proof page wears the Studio's type system: Plus Jakarta Sans (display), Inter (text), JetBrains Mono (file names,
  // locators, numbers). System fonts are the fallback when Google Fonts is unreachable.
  const PROOF_FONTS = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
  const PROOF_CSS = `
:root{--bg:#f6f7fb;--card:#fff;--ink:#0f172a;--mute:#5b6476;--line:#e3e6ee;--acc:#4f46e5;--acc2:#6366f1;--accbg:#eef0ff;--mark:#fff1a8;--ok:#047857;
--font:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--display:'Plus Jakarta Sans','Inter',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#111831;--ink:#e7eaf3;--mute:#a3abc2;--line:#232c47;--acc:#a5b4fc;--acc2:#818cf8;--accbg:#1b2147;--mark:rgba(250,204,21,.22);--ok:#34d399}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--font)}
main{max-width:680px;margin:0 auto;padding:24px 16px 64px}.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 28px}
.wm{display:inline-flex;align-items:center;gap:8px;font:700 16px/1 var(--display);letter-spacing:-.3px}.wm b{color:var(--acc);font-weight:700}
.glyph{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:8px;color:#fff;font:800 14px/1 var(--display);background:linear-gradient(135deg,var(--acc2),var(--acc))}
@media (prefers-color-scheme:dark){.glyph{color:#0b1020}}
.ch{font-size:12px;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:3px 10px;text-transform:lowercase}
.k{display:flex;flex-wrap:wrap;gap:6px;font-size:12.5px;color:var(--mute);margin:0 0 8px;font-weight:400}
h1{font:700 clamp(21px,4.6vw,26px)/1.3 var(--display);letter-spacing:-.4px;margin:0 0 10px;overflow-wrap:anywhere}
h2.k{font:600 12px/1.4 var(--font);letter-spacing:.08em;text-transform:uppercase;margin:0 0 14px}
.only{display:inline-flex;align-items:center;gap:6px;margin:0 0 20px;font-size:14px;font-weight:500;color:var(--ok)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:0 0 16px;box-shadow:0 1px 2px rgb(15 23 42/.05)}
.pill{display:inline-flex;gap:6px;align-items:center;font-size:13px;color:var(--ok);font-weight:600;margin:0 0 10px}
.pill.r{color:var(--mute)}.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}ul{margin:0;padding-left:20px}li{margin:0 0 6px}
a.n{display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;padding:0 6px;margin-left:3px;border-radius:7px;background:var(--accbg);color:var(--acc);font:600 12px/1 var(--mono);text-decoration:none;vertical-align:1px}
a.n:hover{background:var(--acc);color:var(--card)}a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
ol{list-style:none;margin:0;padding:0}ol li{margin:0 0 18px;scroll-margin-top:16px}ol li:last-child{margin-bottom:0}
ol li:target .src .num{background:var(--acc);color:var(--card)}
.src{display:flex;align-items:baseline;gap:8px;font-weight:600}.src .t{overflow-wrap:anywhere}
.num{flex:none;display:inline-grid;place-items:center;min-width:24px;height:22px;border-radius:7px;background:var(--accbg);color:var(--acc);font-size:12px;font-weight:500}
.meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin:4px 0 0 32px;font-size:12px;color:var(--mute)}.meta .file{overflow-wrap:anywhere}
blockquote{margin:8px 0 0 32px;padding:8px 12px;border-left:3px solid var(--acc2);background:var(--accbg);border-radius:0 10px 10px 0}
mark{background:var(--mark);color:inherit;padding:0 2px;border-radius:3px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
footer{display:flex;flex-direction:column;gap:6px;color:var(--mute);font-size:13px;margin-top:24px}footer .mono{font-size:12px}
@media (max-width:420px){.card{padding:16px}.meta,blockquote{margin-left:0}}
@media (prefers-reduced-motion:no-preference){ol li:target blockquote{animation:kbp 900ms cubic-bezier(.2,.8,.2,1)}@keyframes kbp{from{box-shadow:0 0 0 4px color-mix(in srgb,var(--acc2) 35%,transparent)}to{box-shadow:0 0 0 0 transparent}}}
`;
  const PROOF_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:";
  const proofs = new Map();
  const proofDir = path.join(o.dataDir || '.', 'proofs');
  function saveProof(a, channel) {
    const id = rid(12);
    const rec = { id, bot: a.bot, botName: a.botName, question: scrubQuestion(a.question), answer: a.answer, refused: a.refused, citations: a.citations, quoted: a.proof.quoted,
      hits: a.proof.hits, ...(a.proof.receipt?.digest ? { receipt: { digest: String(a.proof.receipt.digest) } } : {}), channel, at: new Date(now()).toISOString() };
    proofs.set(id, rec);
    if (proofs.size > 2000) proofs.delete(proofs.keys().next().value);
    track(fsp.mkdir(proofDir, { recursive: true }).then(() => fsp.writeFile(path.join(proofDir, `${id}.json`), JSON.stringify(rec))).catch(() => {}));
    return id;
  }
  async function getProof(id) {
    if (proofs.has(id)) return proofs.get(id);
    try { const rec = JSON.parse(await fsp.readFile(path.join(proofDir, `${id}.json`), 'utf8')); proofs.set(id, rec); return rec; } catch { return null; }
  }
  function proofHtml(p) {
    const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const lines = answerLines(p.answer);
    const sup = (s) => e(s).replace(/\[(\d{1,3})\]/g, '<a class="n" href="#s$1"><span class="vh">Source </span>$1</a>');
    const when = new Date(p.at);
    const bot = p.botName || 'This bot';
    const owner = /s$/i.test(bot) ? `${bot}’` : `${bot}’s`;
    const stamp = when.toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Answer proof · ${e(bot)}</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${PROOF_FONTS}">
<style>${PROOF_CSS}</style></head><body><main>
<header class="top"><span class="wm"><span class="glyph" aria-hidden="true">K</span><span>Know<b>Bot</b></span></span><span class="ch mono">${e(p.channel || 'api')}</span></header>
<p class="k mono"><span>${e(bot)}</span><span aria-hidden="true">·</span><time datetime="${e(when.toISOString())}">${e(stamp)}</time></p>
<h1>${e(p.question)}</h1>
<p class="only"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d="M8 1.5 2.5 3.6v4.1c0 3.2 2.3 5.9 5.5 6.8 3.2-.9 5.5-3.6 5.5-6.8V3.6L8 1.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m5.6 8 1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Answered only from ${e(owner)} files</p>
<section class="card" aria-label="Answer"><p class="pill${p.refused ? ' r' : ''}">${p.refused ? 'Not in its files' : `Grounded · ${p.citations.length} source${p.citations.length === 1 ? '' : 's'}`}</p>
${p.refused ? `<p>${e(p.answer)}</p>` : lines.length > 1 ? `<ul>${lines.map((l) => `<li>${sup(l)}</li>`).join('')}</ul>` : `<p>${sup(lines[0] || '')}</p>`}</section>
${p.citations.length ? `<section class="card" aria-labelledby="srch"><h2 class="k" id="srch">Every line, quoted from its source</h2><ol>${p.citations.map((c) => {
    const qs = (p.quoted || []).filter((x) => x.n === c.n);
    return `<li id="s${c.n}"><div class="src"><span class="num mono">${c.n}</span><span class="t">${e(c.title || c.file)}</span></div><div class="meta mono"><span class="file">${e(String(c.file || '').split('/').pop())}</span>${c.similarity != null ? `<span>similarity ${e(Number(c.similarity).toFixed(2))}</span>` : ''}${qs.length ? `<span>${qs.length} line${qs.length === 1 ? '' : 's'} quoted</span>` : ''}</div>${(qs.length ? qs.map((x) => `<blockquote><mark>${e(x.text)}</mark>${x.contentHash ? `<span class="meta mono">content hash ${e(String(x.contentHash))}</span>` : ''}</blockquote>`) : c.excerpt ? [`<blockquote>${e(c.excerpt)}</blockquote>`] : []).join('')}</li>`;
  }).join('')}</ol></section>` : ''}
${p.receipt?.digest ? `<p class="meta mono">Receipt <span class="file">${e(String(p.receipt.digest))}</span></p>` : ''}
<footer><span>${e(bot)} answers only from its own files. Every sentence above is a line from the cited file; a question the files do not cover gets a plain “not in my files”.</span><span class="mono">Powered by KnowDrive</span></footer>
</main></body></html>`;
  }

  // ---------------------------------------------------------------- http helpers
  /**
   * The ONE base every URL we hand out is built on, whatever path the caller came in through: <public origin>/api, so
   * every endpoint, webhook, voice callback and snippet reads <origin>/api/v1/…  (/v1/… is served too, as an alias, but
   * never handed out: the production Worker forwards /api/* only). KNOWBOT_API_PREFIX overrides ('' for a bare /v1 host).
   */
  const API_PREFIX = env.KNOWBOT_API_PREFIX != null ? String(env.KNOWBOT_API_PREFIX).replace(/\/+$/, '') : '/api';
  const apiBase = (req) => publicBase(req, env) + API_PREFIX;
  /** The one public form of a proof link, whatever endpoint or channel made it: <public origin>/p/<id> (short, so an SMS
   * keeps its characters for the answer). /api/p/<id> is served too, as an alias. Behind the production Worker, which
   * forwards /api/* only (KNOWBOT_TRUST_PROXY=1 in its image), the link keeps the /api prefix so it still resolves;
   * KNOWBOT_PROOF_PREFIX overrides either way. Every proofUrl this module hands out is built here. */
  const PROOF_PREFIX = env.KNOWBOT_PROOF_PREFIX != null ? String(env.KNOWBOT_PROOF_PREFIX).replace(/\/+$/, '')
    : /^(1|true|yes)$/i.test(String(env.KNOWBOT_TRUST_PROXY || '')) ? '/api' : '';
  /** KNOWBOT_PROOF_URL puts proof links on the public site instead of the API host (https://knowbot.knowdrive.ai/p/<id>;
   * the site's 404.html forwards /p/<id> to this server's proof page), so a texted link never shows the API's address. */
  const PROOF_URL = String(env.KNOWBOT_PROOF_URL || '').replace(/\/+$/, '');
  const proofUrlFor = (req, id) => (id ? (PROOF_URL ? `${PROOF_URL}/p/${id}` : `${publicBase(req, env)}${PROOF_PREFIX}/p/${id}`) : null);
  // ---------------------------------------------------------------- "send me this" (sendinfo.mjs)
  /** A bot's own texting number once it has one (provisioned lines); else the server's shared line is used. */
  /** The KnowBot number provisioned for this bot (server/numbers.mjs: kept on the trial it was bought in), when active. */
  const provisionedNumber = (target) => {
    const id = target?.kind === 'trial' ? target.id : target?.inst?.numberTrial;
    const rec = (id && studio?.trials?.get?.(id)?.flags?.number) || (target?.flags || target?.T?.flags)?.number;
    return rec && rec.state === 'active' ? rec.phoneNumber || null : null;
  };
  const botFromNumber = (target) => provisionedNumber(target) || target?.inst?.smsNumber || target?.inst?.phoneNumber || target?.spec?.smsNumber || target?.spec?.phoneNumber || null;
  const siOf = (target) => ({ botId: target.id, botName: target.name || 'KnowBot', replyTo: target.inst?.replyTo || target.spec?.replyTo || null, fromNumber: botFromNumber(target),
    scopeTags: target.kind === 'trial' ? [`trial:${target.id}`] : [`bot:${target.id}`] });
  /** A proof link for any answer that has none yet (a remembered or Studio answer): saved like any other proof. */
  const proofLinkFor = (req, target, channel) => (a) => {
    if (a.proofUrl) return a.proofUrl;
    if (!a.citations?.length) return null;
    const id = saveProof({ bot: target.id, botName: target.name, question: a.question || '', answer: a.answer, refused: false, citations: a.citations, proof: { quoted: a.proof?.quoted || [], hits: a.proof?.hits || [], ...(a.proof?.receipt ? { receipt: a.proof.receipt } : {}) } }, channel);
    return proofUrlFor(req, id);
  };
  /**
   * One visitor turn on a text surface: null to answer normally, else {reply, status, ...} to send instead. Grounded answers
   * on the same conversation key are remembered by rememberAnswer() so "send me that" sends the last one.
   */
  function sendInfoTurn(req, target, { key, question, history = [], channel, caller = null, callerKey = null, lastAnswer = null }) {
    return sendInfo.maybeSendInfo({ ...siOf(target), key, question, history, channel, caller, callerKey, lastAnswer, proofUrlFor: proofLinkFor(req, target, channel),
      answerFor: async (q) => {
        const a = await answer(target, String(q || '').slice(0, MAX_Q), { channel, callerKey });
        a.proofId = a.refused ? null : saveProof(a, channel);
        a.proofUrl = proofUrlFor(req, a.proofId);
        return a;
      } });
  }
  const rememberAnswer = (key, a, req) => { if (!a.refused) sendInfo.remember(key, { ...a, proofUrl: a.proofUrl || proofUrlFor(req, a.proofId) }); };
  const siView = (si) => ({ status: si.status, ...(si.via ? { via: si.via } : {}), ...(si.to ? { to: si.to } : {}) });
  /** A send-info reply in the developer API's answer shape (no citations: it is the bot speaking, not an answer). */
  const sendInfoAnswer = (target, question, si) => ({ id: `ans_${rid(16)}`, object: 'knowbot.answer', created: Math.floor(now() / 1000), bot: target.id, question: scrubQuestion(question), answer: si.reply, format: 'text',
    citations: [], refused: false, grounded: false, proof: { hits: [], quoted: [], floor: { min: null, top: null } }, sendInfo: siView(si), usage: { latencyMs: 0 } });

  function send(res, status, body, headers = {}) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }
  function sendErr(res, e) {
    const status = Number(e?.status) || 500;
    const code = e?.code || (status === 404 ? 'not_found' : status >= 500 ? 'internal_error' : 'bad_request');
    if (status >= 500 && !(e instanceof ApiError) && !(e instanceof ChannelError)) log(`[devapi] ${e?.stack || e}`);
    send(res, status, { error: { message: e?.message || 'internal error', type: TYPES[status] || (status >= 500 ? 'api_error' : 'invalid_request_error'), code, param: null, status, ...(e?.extra || {}) } }, e?.headers || {});
  }
  async function bodyJson(req) {
    try { return await o.readJson(req); } catch (e) { throw new ApiError(Number(e.status) || 400, Number(e.status) === 413 ? 'body_too_large' : 'invalid_json', e.message || 'invalid JSON body'); }
  }
  const sseHead = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders?.();
  };

  /** Question + history from a /chat or /completions body. */
  function readConversation(body) {
    if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'Body must be a JSON object.');
    if (typeof body.question === 'string' && body.question.trim()) {
      const q = body.question.trim();
      if (q.length > MAX_Q) throw new ApiError(400, 'question_too_long', `question must be ${MAX_Q} characters or fewer`);
      return { question: q, history: [] };
    }
    const msgs = body.messages;
    if (!Array.isArray(msgs) || !msgs.length) throw new ApiError(400, 'invalid_request', 'Send "question" (a string) or "messages" ([{role, content}]).');
    if (msgs.length > 50) throw new ApiError(400, 'invalid_request', 'Too many messages (max 50).');
    const clean = msgs.map((m) => {
      if (!m || !CHAT_ROLES.has(m.role)) throw new ApiError(400, 'invalid_request', 'Each message needs role user|assistant|system and content.');
      return { role: m.role, content: textOfContent(m.content) };
    });
    const lastUser = [...clean].reverse().find((m) => m.role === 'user');
    if (!lastUser || !lastUser.content.trim()) throw new ApiError(400, 'invalid_request', 'The conversation needs a user message.');
    const q = lastUser.content.trim();
    if (q.length > MAX_Q) throw new ApiError(400, 'question_too_long', `The last user message must be ${MAX_Q} characters or fewer.`);
    const idx = clean.lastIndexOf(lastUser);
    const history = clean.slice(0, idx).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    return { question: q, history };
  }
  /** The answer text as the API returns it: prose with inline [n] (the Studio's form) or, with format:"bullets", one claim per line. */
  const answerText = (a, format = 'prose') => (a.refused ? a.answer : format === 'bullets' ? bulletsAnswer(a.answer) || a.answer : proseAnswer(a.answer) || a.answer);
  /** The streamed pieces of answerText: concatenating every piece's `raw` gives exactly answerText. */
  const answerPieces = (a, format = 'prose') => {
    if (a.refused) return [{ raw: a.answer, n: [] }];
    const lines = answerLines(a.answer, { markdown: true });
    const parts = format === 'bullets' ? answerText(a, 'bullets').split('\n').filter((l) => l.trim()) : lines.map(proseSentence).filter(Boolean);
    return parts.map((t, i) => ({ raw: `${i ? (format === 'bullets' ? '\n' : ' ') : ''}${t}`, text: stripMarks(t).replace(/^\s*[-*•]\s+/, ''), n: [...t.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])) }));
  };
  const formatOf = (body) => (String(body?.format || '').toLowerCase() === 'bullets' ? 'bullets' : 'prose');
  const publicAnswer = (a, req, format = 'prose') => ({
    id: a.id, object: 'knowbot.answer', created: Math.floor(now() / 1000), bot: a.bot, question: a.question, answer: answerText(a, format), format: a.refused ? 'text' : format, citations: a.citations.map(({ similarity, ...c }) => c),
    refused: a.refused, grounded: a.grounded, proof: { hits: a.proof.hits, quoted: a.proof.quoted, floor: a.proof.floor, ...(a.proof.receipt ? { receipt: a.proof.receipt } : {}) }, ...(a.proofId ? { proofUrl: proofUrlFor(req, a.proofId) } : {}),
    ...(a.guard ? { guard: a.guard } : {}), usage: { latencyMs: a.latencyMs, ...(a.tokens ? { promptTokens: a.tokens.prompt, completionTokens: a.tokens.completion, tokensEstimated: a.tokens.estimated } : {}) },
  });
  const footnotes = (a, format = 'prose') => (a.refused ? a.answer : `${answerText(a, format)}\n\n${a.citations.map((c) => `[${c.n}] ${c.title && c.title !== c.file ? `${c.title}${c.page ? `, page ${c.page}` : ''}${c.section ? `, “${c.section}”` : ''} — ` : ''}${c.file}${c.url ? ` <${c.url}>` : ''}`).join('\n')}`.trim());

  // ---------------------------------------------------------------- /v1/bots/:id/chat
  /**
   * POST /v1/bots/:id/preview {channel: sms|whatsapp|email, question} → the reply exactly as that channel would send it
   * (the same answer pipeline and the same formatter as the real webhook), logged to insights under that channel.
   * The Studio's bot pane uses it to show the bot in the shape the visitor will launch.
   */
  async function botPreview(req, res, botId) {
    const who = await authKey(req, botId);
    rateLimit(res, who);
    const body = await bodyJson(req);
    const channel = String(body.channel || '');
    if (!['sms', 'whatsapp', 'email'].includes(channel)) throw new ApiError(400, 'invalid_request_error', 'channel must be sms, whatsapp or email');
    const question = String(body.question || '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
    if (!question) throw new ApiError(400, 'invalid_request_error', 'question is required');
    const target = await resolveTarget(botId, who);
    // "send me this" in the channel's own shape: the preview conversation is the key's, per channel
    const siKey = `${target.id}|preview:${channel}|${who.keyId}`;
    const si = await sendInfoTurn(req, target, { key: siKey, question, history: Array.isArray(body.history) ? body.history.slice(-8) : [], channel, callerKey: who.keyId,
      caller: typeof body.from === 'string' ? body.from.slice(0, 200) : null });
    if (si) {
      const out = { channel, question: scrubQuestion(question), refused: false, proofUrl: null, citations: [], text: si.reply, sendInfo: siView(si) };
      if (channel === 'email') {
        const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        out.html = `<p>${esc(si.reply)}</p>`; out.subject = `Re: ${question.slice(0, 120)}`; out.from = target.name || 'KnowBot';
      }
      return send(res, 200, out);
    }
    const a = await answer(target, question, { channel, callerKey: who.keyId });
    a.proofId = a.refused ? null : saveProof(a, channel);
    const proofUrl = a.refused ? null : proofUrlFor(req, a.proofId);
    rememberAnswer(siKey, { ...a, proofUrl }, req);
    const r = { ...a, question };
    const out = { channel, question, refused: !!a.refused, proofUrl, citations: publicAnswer(a, req).citations || [] };
    if (channel === 'sms') out.text = formatSms(r, proofUrl, SMS_MAX);
    else if (channel === 'whatsapp') out.text = formatWhatsApp(r, proofUrl);
    else { const e = formatEmail(r, { proofUrl, botName: target.name || 'KnowBot', question }); out.text = e.text; out.html = e.html; out.subject = `Re: ${question.slice(0, 120)}`; out.from = target.name || 'KnowBot'; }
    return send(res, 200, out);
  }

  async function botChat(req, res, botId) {
    const who = await authKey(req, botId, { site: true });
    rateLimit(res, who);
    const body = await bodyJson(req);
    const { question, history } = readConversation(body);
    const target = await resolveTarget(botId, who);
    const channel = who.scope === 'site' ? 'site' : typeof body.channel === 'string' && CHANNELS.includes(body.channel) ? body.channel : 'api';
    const callerKey = typeof body.user === 'string' && body.user ? `${who.keyId}|${String(body.user).slice(0, 80)}` : who.keyId;
    const format = formatOf(body);
    const siKey = `${target.id}|${channel}|${callerKey}`;
    const si = await sendInfoTurn(req, target, { key: siKey, question, history, channel, callerKey });
    if (si) {
      const out = sendInfoAnswer(target, question, si);
      if (body.stream !== true) return send(res, 200, out);
      sseHead(res);
      const frame = (id, event, data) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(frame(1, 'delta', { text: si.reply, n: [], raw: si.reply }) + frame(2, 'final', out) + frame(3, 'done', { latencyMs: 0 }));
      return res.end();
    }
    if (body.stream === true) {
      sseHead(res);
      let n = 0;
      const emit = (event, data) => { try { res.write(`id: ${++n}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
      try {
        const a = await answer(target, question, { history, channel, callerKey, onRetrieval: (r) => emit('retrieval', r) });
        a.proofId = a.refused ? null : saveProof(a, channel);
        rememberAnswer(siKey, a, req);
        for (const piece of answerPieces(a, format)) emit('delta', { text: piece.text ?? piece.raw, n: piece.n, raw: piece.raw });
        emit('final', publicAnswer(a, req, format));
        emit('done', { latencyMs: a.latencyMs });
      } catch (e) {
        emit('error', { code: e.code || 'internal_error', message: e instanceof ApiError ? e.message : "Couldn't answer right now." });
        emit('done', { error: true });
      }
      return res.end();
    }
    const a = await answer(target, question, { history, channel, callerKey });
    a.proofId = a.refused ? null : saveProof(a, channel);
    rememberAnswer(siKey, a, req);
    return send(res, 200, publicAnswer(a, req, format));
  }

  // ---------------------------------------------------------------- /v1/chat/completions (OpenAI-compatible)
  async function completions(req, res) {
    const body = await bodyJson(req);
    const who = await authKey(req);
    const model = typeof body.model === 'string' ? body.model.trim().toLowerCase() : '';
    if (model && model !== who.bot && model !== 'knowbot') throw new ApiError(404, 'model_not_found', `The model "${body.model}" does not exist or this key cannot use it. Use your bot id ("${who.bot}") as the model.`);
    rateLimit(res, who);
    const { question, history } = readConversation(body);
    const target = await resolveTarget(who.bot, who);
    const id = `chatcmpl-${rid(24)}`, created = Math.floor(now() / 1000), modelName = who.bot;
    const callerKey = typeof body.user === 'string' && body.user ? `${who.keyId}|${body.user}` : who.keyId;
    const format = formatOf(body);
    const ext = (a) => ({ citations: a.citations.map(({ similarity, ...c }) => c), refused: a.refused, grounded: a.grounded, proof: { hits: a.proof.hits, quoted: a.proof.quoted, floor: a.proof.floor, ...(a.proof.receipt ? { receipt: a.proof.receipt } : {}) },
      ...(a.proofId ? { proofUrl: proofUrlFor(req, a.proofId) } : {}), latencyMs: a.latencyMs, usageEstimated: a.tokens ? !!a.tokens.estimated : true });
    // real provider usage when every model call reported it; otherwise an estimate from the FULL prompt sent to the model
    // (system, grounding context, history, question: chars / 4), flagged knowbot.usageEstimated so metering can tell
    const usage = (a) => {
      const t = a.tokens || { prompt: approxTokens(history.map((m) => m.content).join(' ') + question), completion: 0, estimated: true };
      const p = t.prompt, c = t.estimated ? Math.max(t.completion, approxTokens(footnotes(a, format))) : t.completion;
      return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
    };
    if (body.stream === true) {
      sseHead(res);
      const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model: modelName, system_fingerprint: 'knowbot-v1', choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra });
      const write = (o2) => { try { res.write(`data: ${JSON.stringify(o2)}\n\n`); } catch {} };
      write(chunk({ role: 'assistant', content: '' }));
      try {
        const a = await answer(target, question, { history, channel: 'api', callerKey });
        a.proofId = a.refused ? null : saveProof(a, 'api');
        const content = footnotes(a, format);
        // token-sized deltas (a word plus its trailing space/newline), paced lightly so a client renders it as a stream;
        // concatenating every delta gives exactly `content`
        const parts = content.match(/\S+\s*|\s+/g) || [content];
        const pace = Math.min(streamPaceMs, 900 / Math.max(1, parts.length));
        for (const p of parts) {
          if (res.destroyed || res.writableEnded) break;
          write(chunk({ content: p }));
          if (pace >= 1) await new Promise((r) => setTimeout(r, pace));
        }
        write(chunk({}, 'stop', { knowbot: ext(a) }));
        if (body.stream_options?.include_usage) write({ id, object: 'chat.completion.chunk', created, model: modelName, system_fingerprint: 'knowbot-v1', choices: [], usage: usage(a) });
      } catch (e) {
        write({ error: { message: e instanceof ApiError ? e.message : "Couldn't answer right now.", type: 'api_error', code: e.code || 'internal_error' } });
      }
      try { res.write('data: [DONE]\n\n'); } catch {}
      return res.end();
    }
    const a = await answer(target, question, { history, channel: 'api', callerKey });
    a.proofId = a.refused ? null : saveProof(a, 'api');
    return send(res, 200, {
      id, object: 'chat.completion', created, model: modelName, system_fingerprint: 'knowbot-v1',
      choices: [{ index: 0, message: { role: 'assistant', content: footnotes(a, format), refusal: null }, logprobs: null, finish_reason: 'stop' }],
      usage: usage(a), knowbot: ext(a),
    });
  }

  // ---------------------------------------------------------------- /v1/bots/:id/voice (browser voice bot)
  async function botVoice(req, res, botId) {
    const who = await authKey(req, botId);
    rateLimit(res, who);
    const g = googleConfig(env);
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    let transcript = '', confidence = null;
    if (/json/.test(ct)) {
      const body = await bodyJson(req);
      if (typeof body.text === 'string' && body.text.trim()) transcript = body.text.trim().slice(0, MAX_Q);
      else if (typeof body.audio === 'string' && body.audio) {
        if (!g.stt) throw new ApiError(503, 'voice_not_configured', 'Google speech-to-text is not configured on this server. Recognize speech in the browser and send {"text": …}.', { fallback: 'browser' });
        const r = await transcribe(Buffer.from(body.audio, 'base64'), { env, mime: body.mime || 'audio/webm' }).catch((e) => { throw new ApiError(e.status || 502, 'speech_failed', e.message); });
        transcript = r.transcript; confidence = r.confidence;
      } else throw new ApiError(400, 'invalid_request', 'Send audio (raw body with an audio/* content type, or {"audio": base64, "mime"}) or {"text": …}.');
    } else {
      if (!/^audio\/|^application\/octet-stream/.test(ct)) throw new ApiError(415, 'unsupported_media_type', 'Send the clip with an audio/* content type (audio/webm, audio/ogg, audio/wav, audio/mpeg).');
      if (!g.stt) { req.resume(); throw new ApiError(503, 'voice_not_configured', 'Google speech-to-text is not configured on this server. Recognize speech in the browser and send {"text": …}.', { fallback: 'browser' }); }
      const buf = await o.readRaw(req, 8 * 1024 * 1024).catch((e) => { throw new ApiError(e.status || 400, 'body_too_large', e.message); });
      const r = await transcribe(buf, { env, mime: ct }).catch((e) => { throw new ApiError(e.status || 502, 'speech_failed', e.message); });
      transcript = r.transcript; confidence = r.confidence;
    }
    const target = await resolveTarget(botId, who);
    if (!transcript) return send(res, 200, { transcript: '', answer: null, text: null, spoken: "Sorry, I didn't catch that.", citations: [], refused: false, grounded: false, audio: null, mime: null, heard: false });
    const a = await answer(target, transcript, { channel: 'voice', callerKey: who.keyId });
    a.proofId = a.refused ? null : saveProof(a, 'voice');
    const spoken = formatSpoken(a, 450, { names: [target.name, target.inst?.org, target.spec?.org, target.spec?.name] });
    let audioOut = null, mime = null;
    if (g.tts) {
      try { const s = await synthesize(spoken, { env }); audioOut = s.audio.toString('base64'); mime = s.mime; } catch (e) { log(`[devapi] TTS failed: ${e.message}`); }
    }
    return send(res, 200, { ...publicAnswer(a, req), transcript, confidence, text: answerText(a), spoken, audio: audioOut, mime, heard: true, speech: { recognition: 'google', synthesis: audioOut ? 'google' : 'browser' } });
  }

  // ---------------------------------------------------------------- channels
  const CHANNEL_HANDLERS = { sms: handleSms, voice: handleVoice, whatsapp: handleWhatsApp, email: handleEmail };
  async function channelRoute(req, res, url, botId, name, sub) {
    const h = CHANNEL_HANDLERS[name];
    if (!h) throw new ApiError(404, 'not_found', `No channel "${name}". Channels: ${Object.keys(CHANNEL_HANDLERS).join(', ')}.`);
    const target = await resolveTarget(botId);
    const raw = req.method === 'POST' ? await o.readRaw(req, name === 'email' ? 25 * 1024 * 1024 : 1024 * 1024) : Buffer.alloc(0);
    const base = apiBase(req);
    const cx = {
      // the bot's own KnowBot number and its prepaid credit (server/numbers.mjs), or null: unmetered, as before
      meter: name === 'sms' || name === 'voice' ? await meterOf(target) : null,
      env, req, res, url, raw, sub: sub || '', botId: target.id, botName: target.name, org: target.inst?.org || target.spec?.org || null, base, log,
      background: (p) => track(p),
      limited: (k) => limit(`ch:${name}:${target.id}:${hashCaller(k)}`, limits.channel).limited,
      ask: async (question, { channel, callerKey }) => {
        const a = await answer(target, String(question || '').slice(0, MAX_Q), { channel, callerKey });
        a.proofId = a.refused ? null : saveProof(a, channel);
        a.proofUrl = proofUrlFor(req, a.proofId);
        rememberAnswer(`${target.id}|${channel}|${callerKey}`, a, req);
        return a;
      },
      // "send me this": null (answer normally) or {reply, status} to send instead; the caller's own address is known
      sendInfo: (question, { channel, callerKey }) => sendInfoTurn(req, target, { key: `${target.id}|${channel}|${callerKey}`, question, channel, caller: callerKey, callerKey }),
      // a texted STOP / START (the opt-out list sendinfo.mjs honours before every text)
      optOut: (number) => sendInfo.optOut(target.id, number),
      optIn: (number) => sendInfo.optIn(target.id, number),
    };
    return h(cx);
  }
  async function meterOf(target) {
    try { return (await studio?.numbers?.meterFor?.(target)) || null; } catch (e) { log(`[channels] credit lookup for ${target.id} failed: ${e.message}`); return null; }
  }
  // ---------------------------------------------------------------- phone: Twilio Media Streams WebSocket (voice-live.mjs)
  /** Retrieval only (no answer, nothing logged): the bot's own scope. The phone channel's product-handle lookup. */
  async function searchRaw(target, q) {
    if (target.kind === 'trial') return (await trialSearch(target, q)).slice(0, 6).map((h) => ({ text: h.text, file: h.filename, title: h.title }));
    const ret = await registry.retriever(target.inst.id).search(q, 6);
    return (ret.results || []).filter((r) => r && r.text && !isQuestionFile(r.filename)).map((r) => ({ text: r.text, file: r.filename, title: r.title || null }));
  }
  const MEDIA_RE = /^(?:\/api)?\/v1\/channels\/([^/]+)\/voice\/media\/?$/;
  const DAY_MS = 24 * 3600 * 1000;
  const phoneTexts = { perNumberDay: Number(env.KNOWBOT_PHONE_TEXTS_PER_NUMBER || 3), perBotDay: Number(env.KNOWBOT_PHONE_TEXTS_PER_DAY || 100) };
  // ---------------------------------------------------------------- web voice assistant WebSocket (webvoice.mjs)
  // A launched bot is public (like the chat widget), limited per IP; a trial bot needs its kb_trial_ key in the start
  // message. Questions are answered by this bot's own pipeline and logged with channel 'voice'.
  const WEBVOICE_RE = /^(?:\/api)?\/v1\/bots\/([^/]+)\/voice\/live\/?$/;
  const webVoiceLimit = Number(env.KNOWBOT_WEBVOICE_RATE_LIMIT || 6); // sessions per minute per IP
  function webVoiceUpgrade(req, socket, head, botId) {
    if (!isWebSocketUpgrade(req)) { rejectUpgrade(socket, 426, 'WebSocket only.'); return true; }
    const ip = typeof o.clientIp === 'function' ? o.clientIp(req) : (req.socket?.remoteAddress || 'unknown');
    if (limit(`wv:${ip}`, webVoiceLimit).limited) { rejectUpgrade(socket, 429, 'Too many voice sessions; try again in a minute.'); return true; }
    socket.on('error', () => {});
    (async () => {
      let target;
      try { target = await resolveTarget(botId); } catch { return rejectUpgrade(socket, 404, 'No such bot.'); }
      const ws = acceptWebSocket(req, socket, head, { maxMessage: 512 * 1024 });
      if (!ws) return;
      handleWebVoice(ws, {
        env, log, botId: target.id, botName: target.name, org: target.inst?.org || target.spec?.org || null, callerKey: `ip:${ip}`, ip,
        authorize: async (key) => {
          if (key) return authKey({ headers: { authorization: `Bearer ${key}` } }, target.id);
          if (target.kind === 'live') return { keyId: null };
          throw new ApiError(401, 'missing_api_key', 'A trial bot needs its trial key (kb_trial_…) in the start message.');
        },
        ask: async (question, { callerKey }) => {
          const a = await answer(target, String(question || '').slice(0, MAX_Q), { channel: 'voice', callerKey });
          a.proofId = a.refused ? null : saveProof(a, 'voice');
          a.proofUrl = proofUrlFor(req, a.proofId);
          rememberAnswer(`${target.id}|voice|${callerKey}`, a, req);
          return a;
        },
        // "send me this": typed turns (text engine) and the send_info tool (live engine; the visitor confirms out loud)
        sendInfoMedia: sendInfo.media(botFromNumber(target)),
        maybeSendInfo: (question, { callerKey }) => sendInfoTurn(req, target, { key: `${target.id}|voice|${callerKey}`, question, channel: 'voice', callerKey }),
        sendInfo: ({ via, to, answer: ans, callerKey }) => sendInfo.send({ ...siOf(target), channel: 'voice', via, to, answer: ans, callerKey, proofUrlFor: proofLinkFor(req, target, 'voice') }),
        onEnd: ({ sid, engine, questions }) => log(`[webvoice] ${sid} ended (${engine || 'not started'}, ${questions} questions)`),
      });
    })().catch((e) => { log(`[webvoice] upgrade failed: ${e.message}`); try { socket.destroy(); } catch {} });
    return true;
  }
  /** server.mjs 'upgrade' listener. → true when the path is ours (handled or refused), false to let others decide. */
  function upgrade(req, socket, head) {
    const p = String(req.url || '').split('?')[0];
    const wv = WEBVOICE_RE.exec(p);
    if (wv) return webVoiceUpgrade(req, socket, head, decodeURIComponent(wv[1]));
    const mt = MEDIA_RE.exec(p);
    if (!mt) return false;
    if (!isWebSocketUpgrade(req)) { rejectUpgrade(socket, 426, 'WebSocket only.'); return true; }
    if (!env.TWILIO_AUTH_TOKEN || phoneEngine(env) !== 'gemini') { rejectUpgrade(socket, 503, 'The voice-to-voice phone engine is not configured (TWILIO_AUTH_TOKEN, GEMINI_API_KEY).'); return true; }
    socket.on('error', () => {});
    (async () => {
      let target;
      try { target = await resolveTarget(decodeURIComponent(mt[1])); } catch { return rejectUpgrade(socket, 404, 'No such bot.'); }
      const meter = await meterOf(target);
      const ws = acceptWebSocket(req, socket, head, { maxMessage: 256 * 1024 });
      if (!ws) return;
      let callStart = 0;
      handleMediaStream(ws, {
        // on its own KnowBot number: texts go out from that number, and the call is metered (minutes rounded up)
        fromNumber: meter?.phoneNumber || null, maxSeconds: meter ? meter.secondsLeft() : 0,
        onTextSent: meter ? ({ body }) => { meter.charge('text', Math.max(1, smsInfo(body).segments), 'call-text').catch(() => {}); } : null,
        env, log, botId: target.id, botName: target.name, org: target.inst?.org || target.spec?.org || null,
        shopDomain: shopDomainFor(target, env),
        // texts cost the owner money: at most PHONE_TEXTS_PER_NUMBER per destination per 24 h and PHONE_TEXTS_PER_DAY per bot
        // (the per-number quota spans every bot on this server: one Twilio account pays for all of them)
        textAllowed: (to) => !limit(`sms-to:${hashCaller(to)}`, phoneTexts.perNumberDay, DAY_MS).limited && !limit(`sms-bot:${target.id}`, phoneTexts.perBotDay, DAY_MS).limited,
        ask: async (question) => {
          const a = await answer(target, String(question || '').slice(0, MAX_Q), { channel: 'phone', callerKey: ws.callerKey || null });
          a.proofId = a.refused ? null : saveProof(a, 'phone');
          a.proofUrl = proofUrlFor(req, a.proofId);
          return a;
        },
        // "send me this" on a call: the send_info tool (texts default to the verified caller ID; the caller confirms first)
        sendInfoMedia: sendInfo.media(botFromNumber(target)),
        sendInfo: ({ via, to, answer: ans }) => sendInfo.send({ ...siOf(target), channel: 'phone', via, to, answer: ans, callerKey: ws.callerKey || null, proofUrlFor: proofLinkFor(req, target, 'phone') }),
        searchRaw: (q) => searchRaw(target, q),
        onStart: ({ from }) => { ws.callerKey = from || null; callStart = now(); },
        // a spoken figure with no search behind it: flagged in the questions loop for the owner to review
        onUngrounded: ({ question, text }) => logAnswer(target, { question: question || '(question not transcribed)', refused: false, citations: [], proof: { floor: { top: null } } },
          'phone', ws.callerKey || null, { flags: ['ungrounded'], note: String(text || '').slice(0, 300) }),
        onEnd: ({ callSid, transcript, answers }) => {
          if (meter && callStart) meter.charge('call', Math.max(1, Math.ceil((now() - callStart) / 60000)), callSid || 'call').catch(() => {});
          callStart = 0;
          log(`[voice-live] ${callSid || '?'} ended: ${transcript.length} turns, ${answers.length} searches (${answers.filter((x) => x.refused).length} not in the files)`);
        },
      });
    })().catch((e) => { log(`[voice-live] upgrade failed: ${e.message}`); try { socket.destroy(); } catch {} });
    return true;
  }

  function channelsInfo(req, botId, target = null) {
    const base = apiBase(req);
    const st = channelStatus(env);
    // texted checkout links: the gemini engine, Twilio texting configured, and a Shopify store for THIS bot
    st.voice.texts = !!(st.voice.texts && phoneEngine(env) === 'gemini' && target && shopDomainFor(target, env));
    const url = (n) => `${base}/v1/channels/${encodeURIComponent(botId)}/${n}`;
    return {
      bot: botId,
      channels: {
        sms: { ...st.sms, webhook: url('sms'), method: 'POST' },
        voice: { ...st.voice, webhook: url('voice'), method: 'POST', engine: phoneEngine(env), ...(phoneEngine(env) === 'gemini' ? { mediaStream: `${url('voice').replace(/^http/, 'ws')}/media` } : {}) },
        whatsapp: { ...st.whatsapp, webhook: url('whatsapp'), method: 'POST', verify: 'GET (hub.challenge)' },
        email: { ...st.email, webhook: url('email'), method: 'POST' },
        // the widget is a static file at the site root (never under the /api prefix the API may be served from)
        chat: { configured: true, endpoint: `${base}/v1/bots/${encodeURIComponent(botId)}/chat`, embed: `${publicBase(req, env)}/lib/embed.js` },
        voiceBot: { ...st.voiceBot, endpoint: `${base}/v1/bots/${encodeURIComponent(botId)}/voice` },
        webVoice: { configured: true, engine: webVoiceEngine(env), live: webVoiceEngine(env) === 'gemini', socket: `${base.replace(/^http/, 'ws')}/v1/bots/${encodeURIComponent(botId)}/voice/live`,
          embed: `${publicBase(req, env)}/lib/embed.js`, widget: `${publicBase(req, env)}/lib/voice-widget.js` },
      },
      // "send me this": which media a visitor can ask to be sent this bot's answers by (both false: never offered)
      sendInfo: sendInfo.media(botFromNumber(target)),
    };
  }

  // ---------------------------------------------------------------- docs
  function index(req) {
    const base = apiBase(req);
    return {
      object: 'knowbot.api', version: 'v1', base: `${base}/v1`, docs: `${base}/v1/openapi.json`,
      // one base for every snippet: each endpoint's `url` is `base` + the rest of its path. /api/v1/… and /v1/… are
      // aliases (same handlers, same keys); every URL this API returns (webhooks, proof links, voice callbacks) uses `base`.
      aliases: [`${publicBase(req, env)}/api/v1`, `${publicBase(req, env)}/v1`],
      note: `/api/v1 and /v1 are aliases; use ${base}/v1 everywhere (it also works behind proxies that forward /api/* only).`,
      auth: 'Authorization: Bearer kb_live_… (or a Studio trial key, kb_trial_…)',
      endpoints: [
        { method: 'POST', path: '/v1/bots/{botId}/chat', about: 'Answer one question with citations. JSON, or SSE with "stream": true (events: retrieval, delta, final, done).' },
        { method: 'POST', path: '/v1/chat/completions', about: 'OpenAI-compatible. model = your bot id. Citations as footnotes in content plus a "knowbot" field.' },
        { method: 'GET', path: '/v1/models', about: 'The bot this key can use (OpenAI list shape).' },
        { method: 'POST', path: '/v1/bots/{botId}/voice', about: 'Audio in → transcript → cited answer → audio out (Google speech when configured).' },
        { method: 'GET', path: '/v1/channels/{botId}', about: 'Channel status and webhook URLs.' },
        { method: 'POST', path: '/v1/channels/{botId}/{sms|voice|whatsapp|email}', about: 'Channel webhooks (SMS, phone, WhatsApp, inbound email).' },
      ].map((e) => ({ ...e, url: `${base}${e.path}` })),
      refusal: NOT_IN_DATA,
    };
  }
  function openapi(req) {
    const base = apiBase(req);
    const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
    const str = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
    const int = (description, extra = {}) => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
    const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
    const exampleCitation = { n: 1, file: 'lumen-warranty-returns.md', title: 'Lumen Bikes Warranty and Returns Policy', excerpt: 'Lumen frames carry a lifetime warranty for the original owner.',
      spans: ['Lumen frames carry a lifetime warranty for the original owner.'], section: 'Frames', url: 'https://lumen.example/warranty' };
    const exampleAnswer = { id: 'ans_8f2k1q', object: 'knowbot.answer', created: 1762560000, bot: 'lumen-bikes', question: 'How long is the frame warranty?',
      answer: 'Good news, I found what you\'re looking for! In [“Lumen Bikes Warranty and Returns Policy”](https://lumen.example/warranty), under “Frames”, it says: “Lumen frames carry a lifetime warranty for the original owner.” [1] Feel free to open the link for the full details.',
      format: 'prose', citations: [exampleCitation], refused: false, grounded: true,
      proof: { hits: [{ file: 'lumen-warranty-returns.md', similarity: 0.8312, excerpt: 'Lumen frames carry a lifetime warranty …' }], quoted: [{ n: 1, text: 'Lumen frames carry a lifetime warranty for the original owner.', file: 'lumen-warranty-returns.md' }], floor: { min: 0.55, top: 0.8312 } },
      proofUrl: `${publicBase(req, env)}/p/Xk29fQ1a`, usage: { latencyMs: 640, promptTokens: 912, completionTokens: 58, tokensEstimated: true } };
    const Citation = { type: 'object', description: 'One source the answer cites as [n]. Optional fields appear only when the source really carries them.',
      properties: { n: int('Footnote number used in the answer text as [n]', { minimum: 1 }), file: str('Path of the cited file in the bot\'s store'), title: str('Human title of the document'),
        excerpt: str('One verbatim line quoted under [n] (never two lines joined)'), spans: arr({ type: 'string' }, 'Every line quoted under [n], each verbatim'),
        page: int('Page of the quote, when the document has pages', { minimum: 1 }), section: str('Heading the quote sits under, when known'), url: str('Link to open or download the source (http/https)', { format: 'uri' }) },
      required: ['n', 'file', 'title', 'excerpt', 'spans'], example: exampleCitation };
    const Hit = { type: 'object', properties: { file: str(), similarity: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Vector similarity 0-1 (1 - distance/2), never a rank-fusion score; null with label "keyword match" when unknown.' }, label: str('"keyword match" when only keyword search found it'), excerpt: str('First 200 characters of the passage') }, required: ['file', 'similarity'] };
    const Quoted = { type: 'object', properties: { n: int(), text: str('Verbatim quote'), file: { type: ['string', 'null'] }, fileId: str() }, required: ['n', 'text'] };
    const Proof = { type: 'object', description: 'What the answer stands on: the retrieved passages and every quote, verbatim.', properties: { hits: arr(ref('Hit')), quoted: arr(ref('Quoted')),
      floor: { type: 'object', properties: { min: { type: ['number', 'null'], description: 'Similarity floor below which nothing is cited' }, top: { type: ['number', 'null'], description: 'Best similarity seen' } } } }, required: ['hits', 'quoted'] };
    const Usage = { type: 'object', properties: { latencyMs: int(), promptTokens: int(), completionTokens: int(), tokensEstimated: { type: 'boolean', description: 'true when the provider did not report usage (chars / 4 estimate)' } }, required: ['latencyMs'] };
    const Answer = { type: 'object', properties: { id: str(), object: { const: 'knowbot.answer' }, created: int('Unix seconds'), bot: str(), question: str(),
      answer: str(`Markdown in the librarian voice: where it was found (title, page/section, link), the exact words in “…” with [n], at most one courtesy opener and closer. A refusal is exactly "${NOT_IN_DATA}"`),
      format: { type: 'string', enum: ['prose', 'bullets', 'text'] }, citations: arr(ref('Citation')), refused: { type: 'boolean' }, grounded: { type: 'boolean', description: 'true when at least one citation backs the answer' },
      proof: ref('Proof'), proofUrl: str('Public page showing every quote in context (expires)', { format: 'uri' }), guard: str('Set when a safety/scope guard answered instead of retrieval'), usage: ref('Usage') },
      required: ['id', 'object', 'answer', 'citations', 'refused', 'grounded', 'proof', 'usage'], example: exampleAnswer };
    const Message = { type: 'object', properties: { role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { oneOf: [{ type: 'string' }, arr({ type: 'object', properties: { type: { const: 'text' }, text: str() } })] } }, required: ['role', 'content'] };
    const ChatRequest = { type: 'object', description: 'Send "question" or "messages" (the last user message is the question; up to 8 earlier turns are context).',
      properties: { question: str('', { maxLength: MAX_Q }), messages: arr(ref('Message'), 'max 50'), stream: { type: 'boolean', default: false, description: 'SSE events: retrieval, delta, final, done (error on failure)' },
        format: { type: 'string', enum: ['prose', 'bullets'], default: 'prose', description: 'prose: sentences with inline [n] (as the Studio shows it); bullets: one cited claim per line' },
        channel: { type: 'string', enum: CHANNELS, default: 'api', description: 'Which surface asked (question insights)' }, user: str('Your end-user id (hashed, for de-duplication only)') },
      example: { question: 'How long is the frame warranty?' } };
    const KnowbotExt = { type: 'object', description: 'KnowBot extension on chat.completion (and on the final chunk when streaming)', properties: { citations: arr(ref('Citation')), refused: { type: 'boolean' }, grounded: { type: 'boolean' }, proof: ref('Proof'), proofUrl: str(), latencyMs: int(), usageEstimated: { type: 'boolean' } } };
    const ChatCompletionRequest = { type: 'object', properties: { model: str('Your bot id (or "knowbot")'), messages: arr(ref('Message')), stream: { type: 'boolean' }, stream_options: { type: 'object', properties: { include_usage: { type: 'boolean' } } },
      format: { type: 'string', enum: ['prose', 'bullets'] }, user: str() }, required: ['messages'], example: { model: 'lumen-bikes', messages: [{ role: 'user', content: 'How long is the frame warranty?' }] } };
    const ChatCompletion = { type: 'object', properties: { id: str(), object: { const: 'chat.completion' }, created: int(), model: str(), system_fingerprint: str(),
      choices: arr({ type: 'object', properties: { index: int(), message: { type: 'object', properties: { role: { const: 'assistant' }, content: str('Answer followed by numbered footnotes "[n] Title, page, “section” — file <url>"'), refusal: { type: 'null' } } }, logprobs: { type: 'null' }, finish_reason: { type: 'string', enum: ['stop'] } } }),
      usage: { type: 'object', properties: { prompt_tokens: int(), completion_tokens: int(), total_tokens: int() } }, knowbot: ref('KnowbotExtension') }, required: ['id', 'object', 'choices', 'knowbot'] };
    const ChatCompletionChunk = { type: 'object', description: 'One SSE "data:" line; the stream ends with "data: [DONE]". The last content chunk has finish_reason "stop" and the knowbot extension.',
      properties: { id: str(), object: { const: 'chat.completion.chunk' }, created: int(), model: str(), choices: arr({ type: 'object', properties: { index: int(), delta: { type: 'object', properties: { role: str(), content: str() } }, finish_reason: { type: ['string', 'null'] } } }), knowbot: ref('KnowbotExtension') } };
    const StreamEvents = { type: 'object', description: 'Server-sent events of /v1/bots/{botId}/chat with stream:true',
      properties: { retrieval: { type: 'object', properties: { hits: arr(ref('Hit')), floor: { type: 'object' }, ms: int() } }, delta: { type: 'object', properties: { text: str(), raw: str('Concatenate every raw to get the full answer'), n: arr({ type: 'integer' }) } }, final: ref('Answer'), done: { type: 'object', properties: { latencyMs: int(), error: { type: 'boolean' } } }, error: ref('ErrorBody') } };
    const ErrorBody = { type: 'object', properties: { message: str(), type: str('', { enum: [...new Set(Object.values(TYPES)), 'api_error'] }), code: str(), param: { type: ['string', 'null'] }, status: int() }, required: ['message', 'type', 'code'] };
    const ErrorSchema = { type: 'object', properties: { error: ref('ErrorBody') }, required: ['error'] };
    const rlHeaders = { 'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Requests allowed per minute for this key' }, 'x-ratelimit-remaining': { schema: { type: 'integer' } }, 'x-ratelimit-reset': { schema: { type: 'integer' }, description: 'Seconds until the window resets' },
      'x-ratelimit-limit-requests': { schema: { type: 'integer' }, description: 'OpenAI-style alias' }, 'x-ratelimit-remaining-requests': { schema: { type: 'integer' } }, 'x-ratelimit-reset-requests': { schema: { type: 'string' }, description: 'e.g. "42s"' }, 'x-request-id': { schema: { type: 'string' } } };
    const err = (status, code, message) => ({ description: message, content: { 'application/json': { schema: ref('Error'), example: { error: { message, type: TYPES[status] || 'api_error', code, param: null, status } } } } });
    const responses = {
      BadRequest: err(400, 'invalid_request', 'Send "question" (a string) or "messages" ([{role, content}]).'),
      Unauthorized: err(401, 'invalid_api_key', 'Missing, invalid, revoked or expired key.'),
      Forbidden: err(403, 'key_not_for_bot', 'This key is not valid for this bot.'),
      NotFound: err(404, 'bot_not_found', 'No such bot.'),
      RateLimited: { ...err(429, 'rate_limited', 'Too many requests for this key. Retry after the number of seconds in retry-after.'), headers: { 'retry-after': { schema: { type: 'integer' } }, ...rlHeaders } },
      NotConfigured: err(503, 'channel_not_configured', 'The SMS channel is not configured on this server. Set TWILIO_AUTH_TOKEN.'),
    };
    const std = { 400: { $ref: '#/components/responses/BadRequest' }, 401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' }, 404: { $ref: '#/components/responses/NotFound' }, 429: { $ref: '#/components/responses/RateLimited' } };
    const botId = { name: 'botId', in: 'path', required: true, schema: { type: 'string' }, description: 'Your bot id (a trial id for kb_trial_ keys)', example: 'lumen-bikes' };
    const webhook = (summary, ct, description) => ({ post: { summary, security: [], tags: ['Channels'], parameters: [botId], description,
      requestBody: { content: Object.fromEntries(ct.map((c) => [c, { schema: { type: 'object' } }])) },
      responses: { 200: { description: 'Reply in the provider\'s format' }, 403: { description: 'Provider signature did not verify', content: { 'application/json': { schema: ref('Error') } } }, 503: { $ref: '#/components/responses/NotConfigured' } } } });
    return {
      openapi: '3.1.0',
      info: { title: 'KnowBot API', version: '1.0.0', description: `Grounded answers with citations from your own files. Every fact is quoted and cited as [n]; a question the files do not answer gets exactly: "${NOT_IN_DATA}"\n\n/v1 and /api/v1 are aliases. Rate limits are per key (see the x-ratelimit-* headers).` },
      servers: [{ url: base.replace(/\/v1$/, ''), description: 'KnowBot' }],
      tags: [{ name: 'Answers' }, { name: 'OpenAI-compatible' }, { name: 'Voice' }, { name: 'Channels', description: 'Provider webhooks; authenticated by provider signatures, not API keys' }],
      security: [{ bearer: [] }],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'kb_live_… | kb_trial_…' } },
        schemas: { Answer, Citation, Hit, Quoted, Proof, Usage, Message, ChatRequest, StreamEvents, ChatCompletionRequest, ChatCompletion, ChatCompletionChunk, KnowbotExtension: KnowbotExt, ErrorBody, Error: ErrorSchema },
        responses, headers: rlHeaders,
      },
      paths: {
        '/v1': { get: { summary: 'API index', security: [], responses: { 200: { description: 'Endpoints and the base URL to use' } } } },
        '/v1/bots/{botId}/chat': { post: { operationId: 'askBot', tags: ['Answers'], summary: 'Ask a bot (JSON or SSE)', parameters: [botId],
          requestBody: { required: true, content: { 'application/json': { schema: ref('ChatRequest') } } },
          responses: { 200: { description: 'The answer (JSON), or text/event-stream with events retrieval, delta, final, done', headers: rlHeaders,
            content: { 'application/json': { schema: ref('Answer') }, 'text/event-stream': { schema: ref('StreamEvents') } } }, ...std } } },
        '/v1/chat/completions': { post: { operationId: 'createChatCompletion', tags: ['OpenAI-compatible'], summary: 'OpenAI-compatible chat completion (model = bot id). Works with the OpenAI SDKs by changing baseURL.',
          requestBody: { required: true, content: { 'application/json': { schema: ref('ChatCompletionRequest') } } },
          responses: { 200: { description: 'chat.completion, or chat.completion.chunk SSE ending in [DONE]', headers: rlHeaders,
            content: { 'application/json': { schema: ref('ChatCompletion') }, 'text/event-stream': { schema: ref('ChatCompletionChunk') } } }, ...std } } },
        '/v1/models': { get: { operationId: 'listModels', tags: ['OpenAI-compatible'], summary: 'The bot this key can use', responses: { 200: { description: 'OpenAI list', content: { 'application/json': { schema: { type: 'object', properties: { object: { const: 'list' }, data: arr({ type: 'object', properties: { id: str(), object: { const: 'model' }, created: int(), owned_by: str() } }) } } } } }, 401: std[401] } } },
        '/v1/bots/{botId}/voice': { post: { operationId: 'voice', tags: ['Voice'], summary: 'Voice: audio or text in, cited answer and speech out', parameters: [botId],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { text: str('Already-recognised speech'), audio: str('base64 audio'), mime: str() } } }, 'audio/*': { schema: { type: 'string', format: 'binary' } } } },
          responses: { 200: { description: 'Transcript, answer and audio', content: { 'application/json': { schema: { type: 'object', properties: { transcript: str(), answer: str(), citations: arr(ref('Citation')), refused: { type: 'boolean' }, spoken: str('What is read aloud ("According to page 17 of the Owner\'s Manual, …"); never a URL'), audio: str('base64'), mime: str() } } } } },
            503: { description: 'Google speech not configured (use browser speech and send {"text"})', content: { 'application/json': { schema: ref('Error') } } }, ...std } } },
        '/v1/channels/{botId}': { get: { operationId: 'channels', tags: ['Channels'], summary: 'Channel status and webhook URLs', security: [], parameters: [botId], responses: { 200: { description: 'Per channel: configured, needs (env var names), webhook URL' }, 404: std[404] } } },
        '/v1/channels/{botId}/sms': webhook('SMS webhook for your KnowBot number (reply: GSM-7, at most 2 segments, quotes with [n] and a proof link)', ['application/x-www-form-urlencoded'], 'Signed by your number; every request is signature-checked.'),
        '/v1/channels/{botId}/voice': webhook('Voice webhook for your KnowBot number (live voice)', ['application/x-www-form-urlencoded'], 'Signed by your number; every request is signature-checked.'),
        '/v1/channels/{botId}/whatsapp': { ...webhook('WhatsApp (Meta Cloud API)', ['application/json', 'application/x-www-form-urlencoded'], 'Signed with X-Hub-Signature-256.'),
          get: { summary: 'Meta verify-token handshake', security: [], tags: ['Channels'], parameters: [botId, { name: 'hub.challenge', in: 'query', schema: { type: 'string' } }, { name: 'hub.verify_token', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'The challenge, echoed' }, 403: { description: 'Wrong verify token' } } } },
        '/v1/channels/{botId}/email': webhook('Inbound e-mail (SendGrid Inbound Parse multipart, Postmark JSON {From, Subject, TextBody}, Mailgun signed form, or plain JSON {from, subject, text})', ['multipart/form-data', 'application/json', 'application/x-www-form-urlencoded'],
          'Authenticated by ?key=EMAIL_WEBHOOK_SECRET (or Basic auth) or a Mailgun signature. A payload with no sender returns {ok:true, ignored:true, reason:"unrecognized_payload"}.'),
        '/p/{proofId}': { get: { summary: 'Public proof page: every quote in context (?format=json for JSON)', security: [], parameters: [{ name: 'proofId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'HTML or JSON' }, 404: { description: 'Expired' } } } },
      },
    };
  }

  // ---------------------------------------------------------------- dispatch
  async function route(req, res, url, p, m) {
    res.setHeader('access-control-expose-headers', EXPOSE_HEADERS);
    if (!res.getHeader('x-request-id')) res.setHeader('x-request-id', `req_${rid(16)}`);
    let mt;
    // admin: keys + insights for live bots
    if ((mt = /^\/api\/instances\/([^/]+)\/(keys|insights)(?:\/([^/]*))?$/.exec(p))) {
      const [, rawId, what, sub] = mt;
      o.requireAdmin(req);
      await registry.ready;
      let inst;
      try { inst = registry.get(decodeURIComponent(rawId)); } catch (e) { throw new ApiError(404, 'bot_not_found', e.message); }
      if (what === 'insights') {
        if (m !== 'GET' || sub) throw new ApiError(405, 'method_not_allowed', 'GET only');
        const lim = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
        // a gap's suggested fix names the nearest file in THIS bot's own sources (its retriever; never a stored question)
        const nearest = async (q) => {
          let retr; try { retr = registry.retriever(inst.id); } catch { return null; }
          const [ret, s] = await Promise.all([retr.search(q, 4), liveSimilarities(retr, q)]);
          const hit = (ret?.results || []).find((r) => r && r.text && !isQuestionFile(r.filename));
          if (!hit) return null;
          const file = String(hit.filename || '').split('/').pop();
          const sim = s.get(chunkKey(hit.filename, hit.text)) ?? s.get(hit.filename) ?? null;
          // the other close passages only decide whether the question is on-topic at all (off-topic: refused correctly)
          const context = (ret?.results || []).filter((r) => r && r !== hit && r.text && !isQuestionFile(r.filename)).map((r) => `${r.title || ''} ${String(r.text).slice(0, 400)}`).join(' ').slice(0, 1600);
          return { file, title: docTitle(hit.title, file), similarity: round4(sim), text: String(hit.text).slice(0, 400), context };
        };
        const r = await questionInsights({ kd, store: kd?.store, scopeTags: [`bot:${inst.id}`], limit: lim, nearest, includeTest: url.searchParams.get('include') === 'test' })
          .catch((e) => { throw new ApiError(502, 'upstream', `question insights failed: ${e.message}`); });
        return send(res, 200, { bot: inst.id, ...r });
      }
      if (!sub && m === 'GET') { await loadKeys(); return send(res, 200, { bot: inst.id, keys: K.list.filter((k) => k.bot === inst.id).map(keyView) }); }
      if (!sub && m === 'POST') { const body = await bodyJson(req); return send(res, 201, await createKey(inst.id, body.name)); }
      if (sub && m === 'DELETE') return send(res, 200, await revokeKey(inst.id, decodeURIComponent(sub)));
      throw new ApiError(405, 'method_not_allowed', `${m} not allowed on ${p}`);
    }
    // Studio: the trial's own key
    if ((mt = /^\/api\/studio\/trials\/([^/]+)\/devkey$/.exec(p))) {
      if (m !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
      if (!studio?.enabled) throw new ApiError(503, 'no_store', 'Studio needs a knowDrive store.');
      const id = decodeURIComponent(mt[1]);
      if (!TRIAL_ID_RE.test(id)) throw new ApiError(404, 'not_found', 'No such trial.');
      const data = studio.verifyToken(bearerOf(req), id); // throws 401 unauthorized / expired
      const g = googleConfig(env);
      const base = apiBase(req);
      return send(res, 200, { key: trialKey(id, Number(data.e)), botId: id, expiresAt: new Date(Number(data.e)).toISOString(), scope: 'trial',
        rateLimit: { perMinute: limits.trial }, voice: { google: g.stt && g.tts, stt: g.stt ? 'google' : 'browser', tts: g.tts ? 'google' : 'browser' },
        endpoints: { chat: `${base}/v1/bots/${id}/chat`, completions: `${base}/v1/chat/completions`, voice: `${base}/v1/bots/${id}/voice`, channels: `${base}/v1/channels/${id}` },
        channels: channelsInfo(req, id, await resolveTarget(id).catch(() => null)).channels });
    }
    // the Single-page site (server/site.mjs): its public view and a key that can only ask questions. Published sites
    // only; the owner's own trial key (the Studio's preview) also opens a site that is not published yet.
    if ((mt = /^\/api\/site\/([^/]+)$/.exec(p))) {
      if (m !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
      const id = decodeURIComponent(mt[1]).toLowerCase();
      const ip = typeof o.clientIp === 'function' ? o.clientIp(req) : (req.socket?.remoteAddress || 'unknown');
      const rl = limit(`sitecfg:${ip}`, 30);
      if (rl.limited) throw new ApiError(429, 'rate_limit_exceeded', `Too many requests. Try again in ${rl.retryAfter}s.`, {}, { 'retry-after': String(rl.retryAfter) });
      const s = TRIAL_ID_RE.test(id) && studio?.sitePublic ? await studio.sitePublic(id) : null;
      if (!s) throw new ApiError(404, 'site_not_found', 'This page is not available.');
      let owner = false;
      if (bearerOf(req)) { try { const who = await authKey(req, id); owner = who.kind === 'trial' && !who.scope; } catch { owner = false; } }
      if (!s.published && !owner) throw new ApiError(404, 'site_not_found', 'This page is not available.');
      const exp = Math.min(Number(s.expiresAt) || now() + limits.siteKeyMs, now() + limits.siteKeyMs);
      res.setHeader('cache-control', 'no-store');
      return send(res, 200, { ...s.site, preview: !s.published, key: trialKey(id, exp, 'site'), keyExpiresAt: new Date(exp).toISOString(),
        endpoints: { chat: `${apiBase(req)}/v1/bots/${id}/chat` } });
    }
    // proof pages
    if ((mt = /^\/(?:v1\/)?p\/([A-Za-z0-9_-]+)$/.exec(p))) {
      if (m !== 'GET' && m !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'GET only');
      const pr = PROOF_ID_RE.test(mt[1]) ? await getProof(mt[1]) : null;
      if (url.searchParams.get('format') === 'json') { if (!pr) throw new ApiError(404, 'not_found', 'This proof link has expired.'); return send(res, 200, pr); }
      const html = pr ? proofHtml(pr) : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Proof link expired</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><link rel="stylesheet" href="${PROOF_FONTS}"><style>${PROOF_CSS}</style></head><body><main><header class="top"><span class="wm"><span class="glyph" aria-hidden="true">K</span><span>Know<b>Bot</b></span></span></header><h1>This proof link has expired</h1><p>Ask the bot again to get a fresh answer with its sources.</p></main></body></html>`;
      res.writeHead(pr ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': PROOF_CSP });
      return res.end(m === 'HEAD' ? undefined : html);
    }
    if (p === '/v1' || p === '/v1/') { if (m !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only'); return send(res, 200, index(req)); }
    if (p === '/v1/openapi.json') { if (m !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only'); return send(res, 200, openapi(req)); }
    if (p === '/v1/models') {
      if (m !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
      const who = await authKey(req);
      return send(res, 200, { object: 'list', data: [{ id: who.bot, object: 'model', created: 0, owned_by: 'knowbot' }] });
    }
    if ((mt = /^\/v1\/models\/([^/]+)$/.exec(p)) && m === 'GET') {
      const who = await authKey(req);
      if (decodeURIComponent(mt[1]).toLowerCase() !== who.bot) throw new ApiError(404, 'model_not_found', 'No such model for this key.');
      return send(res, 200, { id: who.bot, object: 'model', created: 0, owned_by: 'knowbot' });
    }
    if (p === '/v1/chat/completions') { if (m !== 'POST') throw new ApiError(405, 'method_not_allowed', 'POST only'); return completions(req, res); }
    if ((mt = /^\/v1\/bots\/([^/]+)\/(chat|voice|preview)$/.exec(p))) {
      if (m !== 'POST') throw new ApiError(405, 'method_not_allowed', 'POST only');
      const botId = decodeURIComponent(mt[1]);
      return mt[2] === 'chat' ? botChat(req, res, botId) : mt[2] === 'preview' ? botPreview(req, res, botId) : botVoice(req, res, botId);
    }
    if ((mt = /^\/v1\/channels\/([^/]+)\/?$/.exec(p))) {
      if (m !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
      const t = await resolveTarget(decodeURIComponent(mt[1]));
      return send(res, 200, channelsInfo(req, t.id, t));
    }
    if ((mt = /^\/v1\/channels\/([^/]+)\/([a-z]+)(?:\/(.+))?$/.exec(p))) return channelRoute(req, res, url, decodeURIComponent(mt[1]), mt[2], mt[3] ? decodeURIComponent(mt[3]) : '');
    throw new ApiError(404, 'not_found', `No such endpoint ${m} ${p}. See ${apiBase(req)}/v1 for the API index.`);
  }

  async function handle(req, res, url, p, m) {
    url = url || new URL(req.url, 'http://localhost');
    p = p || url.pathname;
    m = m || req.method;
    if (/^\/api\/(?:v1(?:\/|$)|p\/)/.test(p)) { req.kbApiPrefix = '/api'; p = p.slice(4); }
    try { await route(req, res, url, p, m); } catch (e) {
      if (!['GET', 'HEAD'].includes(m) && !req.readableEnded) req.resume();
      if (res.headersSent) { try { res.end(); } catch {} return; }
      sendErr(res, e);
    }
  }

  return {
    handle, upgrade, answer, resolveTarget, logLive, logChat, trialKey, createKey, revokeKey, sendInfo,
    /** The Studio's "send me this" proof link: a public /p/<id> for a trial answer (sendinfo.mjs normalizeAnswer shape). */
    proofLink: async (req, trialId, a) => proofLinkFor(req, await resolveTarget(trialId), 'studio')(a),
    /** Resolves when background work (question logs, WhatsApp replies, proof files) has settled. Tests. */
    idle: async () => { while (background.size) await Promise.all([...background]); },
    close() { clearInterval(sweep); },
  };
}

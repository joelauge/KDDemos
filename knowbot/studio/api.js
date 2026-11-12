// KnowBot Studio: the HTTP client (owner B; contract: SPEC 3.5, server: SPEC 4).
//
// Conventions every caller can rely on:
// - Errors are ApiError {status, code, retryAfter (seconds|null), detail}. status 0 = network, code 'aborted' = signal.
// - Streaming helpers call onEvent(type, data, id) with `data` already JSON-parsed (comment pings are skipped).
// - Every trial call sends Authorization: Bearer <token>. 401 (or a 404/expired on the trial itself) marks the trial
//   expired in the store and emits 'trial:expired' {status, code}; B posts the ExpiredCard.
// - No custom request headers other than content-type, authorization and x-filename (Worker CORS).

import { hostedApi } from '../lib/site-config.js?v=eb49811';
import { getState, setState, emit, batch } from './store.js?v=eb49811';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network', retryAfter = null, detail = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

/** API base: ?api= override (dev), else the hosted Worker for this host, else same origin. */
export const BASE = (() => {
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q && /^https?:\/\/[^\s]+$/i.test(q)) return q.replace(/\/+$/, '');
  } catch { /* ignore */ }
  return hostedApi() ?? '';
})();

const T = () => getState().trial;
const trialPath = (suffix = '') => {
  const id = T().id;
  if (!id) throw new ApiError('No trial yet', { status: 0, code: 'no_trial' });
  return `/api/studio/trials/${encodeURIComponent(id)}${suffix}`;
};
const authHeaders = () => (T().token ? { authorization: `Bearer ${T().token}` } : {});
/** Owner mode (KNOWBOT_MODE=owner on the server): the bots are the owner's; nothing to launch, price or buy. */
export const isOwnerMode = () => getState().config?.mode === 'owner';
/**
 * Owner mode: only the server's owner creates bots, with the dashboard's admin token when this browser has one. Sent only
 * to this page's own origin, never to an API a ?api= link names. The key is the dashboard's TOKEN_KEY (dashboard/bots.js).
 */
function ownerHeaders() {
  if (!isOwnerMode()) return {};
  try {
    if (BASE && new URL(BASE, location.href).origin !== location.origin) return {};
    const t = localStorage.getItem('knowbot-admin-token');
    return t ? { authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

function retryAfterOf(res, body) {
  const h = res && res.headers && res.headers.get('retry-after');
  const n = h != null ? Number(h) : (body && body.error && Number(body.error.retryAfter));
  return Number.isFinite(n) ? n : null;
}

async function toError(res, { trialCall = false, trialRoot = false } = {}) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const e = (body && body.error) || {};
  const err = new ApiError(e.message || `HTTP ${res.status}`, {
    status: res.status, code: e.code || (res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'upstream' : 'http'),
    retryAfter: retryAfterOf(res, body), detail: body && body.error ? body.error : body,
  });
  if (trialCall) maybeExpire(err, trialRoot);
  return err;
}

function maybeExpire(err, trialRoot) {
  const expired = err.status === 401 || err.code === 'expired' || (trialRoot && err.status === 404);
  if (!expired) return;
  const t = T();
  if (t.status === 'expired') return;
  setState({ trial: { ...t, status: 'expired' } }, 'expired');
  emit('trial:expired', { status: err.status, code: err.code });
}

function netError(err, signal) {
  if ((signal && signal.aborted) || (err && err.name === 'AbortError')) return new ApiError('Aborted', { status: 0, code: 'aborted' });
  return new ApiError("Couldn't reach the studio", { status: 0, code: 'network', detail: String(err && err.message || err) });
}

async function request(method, path, { body, trial = true, signal, root = false, raw = false, headers: extra = {} } = {}) {
  const headers = { ...(trial ? authHeaders() : {}), ...extra };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(BASE + path, { method, headers, body: payload, signal, credentials: 'omit' }); }
  catch (err) { throw netError(err, signal); }
  if (!res.ok) throw await toError(res, { trialCall: trial, trialRoot: root });
  if (raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new ApiError('Bad JSON from the studio', { status: res.status, code: 'bad_json' }); }
}

// ------------------------------------------------------------------ SSE

/**
 * Parses a text/event-stream fetch Response. Calls onEvent(type, data, id) per frame; `data` is JSON-parsed
 * (raw string if it isn't JSON). Comment lines (':') are pings and are skipped. Resolves when the stream ends and
 * every parsed event has been delivered.
 *
 * Frame coalescing (perf, r3): parsing happens as bytes arrive, but delivery is queued and flushed once per animation
 * frame inside store.batch(), so a burst of events (fast pipeline, reconnect replay, token deltas) costs one round of
 * store fan-out and one style/layout pass per frame. Each flush stops after FLUSH_BUDGET ms and continues on the next
 * frame. Order is unchanged. Hidden tabs (no rAF) flush on a timer.
 */
const FLUSH_BUDGET = 6;
const HEAVY = new Set(['final', 'retrieval', 'selected', 'hello', 'card', 'status', 'file', 'atoms']);
export async function readSSE(response, onEvent, { onActivity } = {}) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ev = { type: 'message', data: [], id: null };
  const q = [];
  let scheduled = false;
  let drainWaiters = [];
  const deliverOne = (type, data, id) => {
    const t = now();
    try { onEvent && onEvent(type, data, id); } catch (err) { console.error(`[studio] SSE handler for "${type}" failed`, err); }
    const perf = globalThis.__kbPerfLog;   // dev/perf probe hook (an array set by a test); off in normal use
    if (perf && now() - t > 12) perf.push(['sse', type, Math.round(now() - t), Math.round(t)]);
  };
  const flush = () => {
    scheduled = false;
    const t0 = now();
    batch(() => {
      let n = 0;
      while (q.length) {
        // Events whose handlers render a lot (a whole answer, the retrieval fan, a replay snapshot) start a frame of
        // their own instead of sharing one with whatever arrived just before them.
        if (n && HEAVY.has(q[0][0])) break;
        const [type, data, id] = q.shift();
        deliverOne(type, data, id);
        n++;
        if (now() - t0 > FLUSH_BUDGET) break;
      }
    });
    if (q.length) schedule();
    else { const w = drainWaiters; drainWaiters = []; w.forEach((r) => r()); }
  };
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    nextFrame(flush);
  }
  const drained = () => (q.length || scheduled ? new Promise((r) => { drainWaiters.push(r); schedule(); }) : Promise.resolve());
  const dispatch = () => {
    if (!ev.data.length && ev.type === 'message') { ev = { type: 'message', data: [], id: null }; return; }
    const rawData = ev.data.join('\n');
    let data = rawData;
    if (rawData) { try { data = JSON.parse(rawData); } catch { /* keep string */ } } else data = {};
    const { type, id } = ev;
    ev = { type: 'message', data: [], id: null };
    q.push([type, data, id]);
    schedule();
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (onActivity) { try { onActivity(); } catch { /* ignore */ } }
      buf += dec.decode(value, { stream: true });
      let nl;
      let t0 = now();
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        if (line === '') {
          dispatch();
          // A large chunk (a big 'final' payload, a replay) is parsed in slices so parsing never shares a frame with
          // a long flush.
          if (now() - t0 > 6 && buf.length) { await yieldToFrame(); t0 = now(); }
          continue;
        }
        if (line[0] === ':') continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        let val = c < 0 ? '' : line.slice(c + 1);
        if (val[0] === ' ') val = val.slice(1);
        if (field === 'event') ev.type = val || 'message';
        else if (field === 'data') ev.data.push(val);
        else if (field === 'id') ev.id = val;
      }
    }
    buf += dec.decode();
    if (buf.trim()) { for (const line of buf.split(/\r?\n/)) { if (line.startsWith('data:')) ev.data.push(line.slice(5).replace(/^ /, '')); else if (line.startsWith('event:')) ev.type = line.slice(6).trim(); } }
    if (ev.data.length) dispatch();
  } finally {
    // Whatever was parsed before the end (or an abort) is still delivered, in order, before readSSE settles.
    await drained();
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldToFrame = () => (typeof globalThis.scheduler?.yield === 'function' ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));
/** rAF when the page is visible (one flush per painted frame), a short timer otherwise (rAF never fires hidden). */
function nextFrame(fn) {
  const hidden = typeof document !== 'undefined' && document.hidden;
  if (!hidden && typeof requestAnimationFrame === 'function') {
    let doneOnce = false;
    const run = () => { if (doneOnce) return; doneOnce = true; clearTimeout(tm); fn(); };
    const tm = setTimeout(run, 100);          // safety net: a tab hidden mid-wait still drains
    requestAnimationFrame(run);
  } else setTimeout(fn, 16);
}

async function postStream(path, body, { onEvent, signal, until } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: 'POST', signal, credentials: 'omit',
      headers: { ...authHeaders(), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body || {}),
    });
  } catch (err) { throw netError(err, signal); }
  if (!res.ok) throw await toError(res, { trialCall: true });
  let result; let errEvent = null;
  try {
    await readSSE(res, (type, data, id) => {
      if (type === until) result = data;
      if (type === 'error') errEvent = data;
      onEvent && onEvent(type, data, id);
    });
  } catch (err) {
    if (result !== undefined) return result;
    throw netError(err, signal);
  }
  if (result === undefined && errEvent) {
    const e = errEvent.error || errEvent;
    throw new ApiError(e.message || 'Stream failed', { status: e.status || 500, code: e.code || 'upstream', retryAfter: e.retryAfter ?? null, detail: e });
  }
  if (result === undefined) throw new ApiError('The stream ended early', { status: 0, code: 'network' });
  return result;
}

// ------------------------------------------------------------------ endpoints

/** GET /api/studio/config (no auth). */
export async function getConfig() {
  return request('GET', '/api/studio/config', { trial: false });
}

/** POST /api/studio/trials -> Trial. Stores trial, usage and spec in the store. */
export async function createTrial() {
  const prev = T();
  setState({ trial: { ...prev, status: 'creating' } }, 'trial:creating');
  let r;
  try { r = await request('POST', '/api/studio/trials', { trial: false, body: {}, headers: ownerHeaders() }); }
  catch (err) { setState({ trial: { ...T(), status: 'error' } }, 'trial:error'); throw err; }
  const s = getState();
  setState({
    trial: { ...s.trial, id: r.trialId, token: r.token, expiresAt: r.expiresAt || null, status: 'ready',
             quota: r.quota || s.trial.quota, converted: false, email: null, restoreKey: r.restoreKey || null },
    usage: r.usage || s.usage,
    spec: r.spec ? { ...s.spec, ...r.spec } : s.spec,
  }, 'trial:created');
  return r;
}

/** GET /api/studio/trials/:id -> {trial, spec, files, usage, converted, email, trialId, expiresAt}. */
export async function getTrial() {
  const r = await request('GET', trialPath(), { root: true });
  const t = T();
  if (r.restoreKey && r.restoreKey !== t.restoreKey) setState({ trial: { ...T(), restoreKey: r.restoreKey } }, 'trial:restoreKey');
  return { ...r, trial: { ...t, id: r.trialId || t.id, expiresAt: r.expiresAt || t.expiresAt, converted: !!r.converted, email: r.email ?? t.email } };
}

/** POST /api/studio/trials/:id/restore {k} -> exchanges a share-link restore key for this trial's bearer token. */
export async function restoreTrial(id, k) {
  const r = await request('POST', `/api/studio/trials/${encodeURIComponent(id)}/restore`, { trial: false, body: { k } });
  const s = getState();
  setState({ trial: { ...s.trial, id: r.trialId || id, token: r.token, expiresAt: r.expiresAt || null, status: 'idle', restoreKey: r.restoreKey || k } }, 'trial:restored-link');
  return r;
}

/** PATCH /api/studio/trials/:id -> {spec}. */
export async function patchSpec(patch) {
  return request('PATCH', trialPath(), { body: patch });
}

/**
 * XHR POST /files (raw body; x-filename URI-encoded). Resolves the FileRow (plus `.usage` when the server sent it).
 * onProgress({loaded, total, pct}, loaded, total). Rejects ApiError (status 0 = network, code 'aborted' on signal).
 */
export function uploadFile(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = BASE + trialPath('/files'); } catch (err) { reject(err); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const t = T();
    if (t.token) xhr.setRequestHeader('authorization', `Bearer ${t.token}`);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'file'));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      const total = e.lengthComputable ? e.total : file.size;
      const p = { loaded: e.loaded, total, pct: total ? Math.min(100, (e.loaded / total) * 100) : 0 };
      try { onProgress && onProgress(p, p.loaded, p.total); } catch (err) { console.error(err); }
    };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText || 'null'); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        const row = (body && body.file) || body || {};
        if (body && body.usage && typeof row === 'object') { try { Object.defineProperty(row, 'usage', { value: body.usage, enumerable: false }); } catch { row.usage = body.usage; } }
        resolve(row);
        return;
      }
      const e = (body && body.error) || {};
      const ra = Number(xhr.getResponseHeader('retry-after'));
      const err = new ApiError(e.message || `HTTP ${xhr.status}`, { status: xhr.status, code: e.code || 'upstream', retryAfter: Number.isFinite(ra) && xhr.getResponseHeader('retry-after') != null ? ra : null, detail: e });
      maybeExpire(err, false);
      reject(err);
    };
    xhr.onerror = () => reject(new ApiError('Connection lost', { status: 0, code: 'network' }));
    xhr.ontimeout = () => reject(new ApiError('Upload timed out', { status: 0, code: 'network' }));
    xhr.onabort = () => reject(new ApiError('Aborted', { status: 0, code: 'aborted' }));
    if (signal) {
      if (signal.aborted) { reject(new ApiError('Aborted', { status: 0, code: 'aborted' })); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

/** GET /files -> {files, usage}. */
export async function listFiles() { return request('GET', trialPath('/files')); }

/**
 * One page of the trial's website files of one page kind, for the Sources group's search and paging:
 * GET /files?origin=store&page=<kind>&q=&offset=&limit= -> {files, total, offset}.
 * CONTRACT-GAP (F): until /files honours these filters (and answers with `total`) it returns every row; the filter and
 *   the page are then cut here from that full list (one fetch, reused for 15 s), so the search works either way.
 */
let storeListCache = null;   // {at, files}
export async function listStoreFiles({ page, q = '', offset = 0, limit = 40, fresh = false } = {}) {
  const query = String(q || '').trim().toLowerCase().slice(0, 120);
  const qs = new URLSearchParams({ origin: 'store', ...(page ? { page } : {}), ...(query ? { q: query } : {}), offset: String(offset), limit: String(limit) });
  let r;
  if (!fresh && storeListCache && Date.now() - storeListCache.at < 15000) r = { files: storeListCache.files };
  else {
    r = await request('GET', trialPath(`/files?${qs}`));
    if (r && Number.isFinite(Number(r.total)) && r.offset != null) return { files: r.files || [], total: Number(r.total), offset: Number(r.offset) };
    storeListCache = { at: Date.now(), files: Array.isArray(r?.files) ? r.files : [] };
  }
  const all = (r.files || []).filter((f) => f && f.origin === 'store' && (!page || (f.page || 'page') === page)
    && (!query || `${f.name || ''} ${f.url || ''} ${f.path || ''}`.toLowerCase().includes(query)));
  return { files: all.slice(offset, offset + limit), total: all.length, offset };
}
export function forgetStoreFiles(id = null) {
  if (!storeListCache) return;
  if (id == null) storeListCache = null; else storeListCache.files = storeListCache.files.filter((f) => f.id !== id);
}

/** DELETE /files/:fid. */
export async function deleteFile(fileId) { return request('DELETE', trialPath(`/files/${encodeURIComponent(fileId)}`)); }

/** GET /files/:fid/atoms?limit&around&span -> {id, name, stage, atoms, items:[{seq, atomId, text, tokens, kind, meta}]}. */
export async function fileAtoms(fileId, { limit = 12, around, span = 1 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (around != null) { q.set('around', String(around)); q.set('span', String(span)); }
  return request('GET', trialPath(`/files/${encodeURIComponent(fileId)}/atoms?${q}`));
}

/** POST /samples -> {files, usage}. */
export async function attachSamples(set = 'lumen-bikes') { return request('POST', trialPath('/samples'), { body: { set } }); }

// ------------------------------------------------------------------ the website import as a background job
//
// F's contract (server/trials.mjs storeImport, one job per trial, it outlives the request):
//   POST   /store {url, owner}       starts the job and streams its events (SSE ids = job sequence numbers); 409 busy
//   GET    /store?since=<seq>        re-attaches: replays the job's events after <seq>, then live until `done`; 404 none
//   DELETE /store                    cancels (202 {cancelled, job}); files already added stay
//   trial events stream: 'store' {job, type, seq, data} (progress ~2/s), 'storegroup' {kind, total, shown, ready, …};
//   'hello' carries storeJob {id, state, seq} and groups [storegroup].
//   Job events: detect, plan {counts:{kind:n}, samples:{kind:[url]}, total, robots:{crawlDelay,…}, helpdesks, feedTotal},
//   found, fetching, reading {kind, done, total, read}, building {files, n}, uploaded {k, uploaded, kind, files|n},
//   capped, built {n, bytes, written, report}, error {code, message}, done {fileCount, report, spec, cancelled?, error?}.
// The Studio sends planOnly:true first (the finder's plan: no job, nothing imported, closing the request cancels it;
//   detect · discovering · plan · found · done {planOnly, plan}) and then kinds:[kind] with the visitor's ticks. An older
//   route that starts the full import on the first request is still followed (reading / uploaded events after the plan),
//   and a Stop pressed then is sent as DELETE /store when the events stream names the job.

/** POST /store (SSE). onEvent(type, data, id). Resolves with the 'done' data; rejects with the importer's code/copy. */
export async function importStore(url, { owner = true, onEvent, signal, planOnly = false, kinds = null } = {}) {
  const path = trialPath('/store');
  let errEvent = null;
  const body = { url: String(url || '').trim(), owner: !!owner, ...(planOnly ? { planOnly: true } : {}), ...(Array.isArray(kinds) ? { kinds } : {}) };
  const done = await postStream(path, body, { signal, until: 'done',
    onEvent: (type, data, id) => { if (type === 'error') errEvent = data; onEvent && onEvent(type, data, id); } });
  if ((errEvent || done?.error) && !(done && (done.fileCount > 0 || done.cancelled))) {
    const e = errEvent || {};
    throw new ApiError(e.message || 'Something went wrong reading that website.', { status: 200, code: e.code || 'upstream', detail: e });
  }
  return { ...(done || {}), ...(errEvent ? { errorEvent: errEvent } : {}) };
}

/** GET /store?since (SSE): re-attaches to the running (or last) job. Resolves the 'done' data, or null when none ran. */
export async function attachStoreImport({ since = 0, onEvent, signal } = {}) {
  let res;
  try {
    res = await fetch(BASE + trialPath(`/store?since=${encodeURIComponent(since)}`), { signal, credentials: 'omit', headers: { ...authHeaders(), accept: 'text/event-stream' } });
  } catch (err) { throw netError(err, signal); }
  if (res.status === 404) return null;
  if (!res.ok) throw await toError(res, { trialCall: true });
  let done;
  try { await readSSE(res, (type, data, id) => { if (type === 'done') done = data; onEvent && onEvent(type, data, id); }); }
  catch (err) { if (done === undefined) throw netError(err, signal); }
  return done === undefined ? { running: true } : done;   // a stream that ends before 'done' (rotation): still running
}

/** DELETE /store: cancels the running import (what was already added stays). */
export async function cancelStoreImport() { return request('DELETE', trialPath('/store')); }

/** DELETE the whole trial ("Start over"): its files, spec and logged questions. */
export async function deleteTrial() { return request('DELETE', trialPath('')); }

/** DELETE /samples. */
export async function removeSamples() { return request('DELETE', trialPath('/samples')); }

/** GET /questions -> {starters, proof, probes}. */
export async function questions() { return request('GET', trialPath('/questions')); }

/** GET /insights (SPEC 11.1) -> {total, answered, refused, top:[{q, count, lastAt, outcome}], gaps:[{q, count, lastAt}]}. */
export async function insights() { return request('GET', trialPath('/insights')); }
/** GET /leads?days=7|30 (Leads report, studio/leads.js) -> {interactions:{total, byChannel, byDay}, leads:[…], conversions:{sent, clicks, items}, links, tracking, days}. */
export async function leads(days = 30) { return request('GET', trialPath(`/leads?days=${encodeURIComponent(days)}`)); }
/** GET /leads.csv?days= -> the raw Response (text/csv): the CRM export, downloaded by the Leads report. */
export async function leadsCsv(days = 30) { return request('GET', trialPath(`/leads.csv?days=${encodeURIComponent(days)}`), { raw: true }); }
/** PATCH /leads {tracking} -> {tracking}: tracked links on (default) or off for this bot. */
export async function setLeadTracking(tracking) { return request('PATCH', trialPath('/leads'), { body: { tracking: !!tracking } }); }
/** GET /notes -> {tags:[{tag, count}]}: the tags this bot's notes and files already use (knowDrive topic:* tags). */
export async function noteTags() { return request('GET', trialPath('/notes')); }
/** POST /notes {question, answer, tags[]} -> {file, tags, usage}: the owner's missing answer, saved as a source file. */
export async function addNote(body) { return request('POST', trialPath('/notes'), { body }); }

/** GET /site -> the Homepage search view {site, edits, snippet, published, hostedUrl, ...} (built from the files when missing). */
export async function getSite() { return request('GET', trialPath('/site')); }
/** POST /site {name?, logo? (image data URL | null), showOn?, ...} -> the same view, saved. */
export async function saveSite(body) { return request('POST', trialPath('/site'), { body }); }
/** GET /api/studio/trials/:id/devkey: the trial's own key, bot id and channels (voice socket, voice mode's orb colour). */
export async function devKey() { return request('GET', trialPath('/devkey')); }

/** POST /email -> {sent, link}. */
export async function sendEmail(email) { return request('POST', trialPath('/email'), { body: { email } }); }

/** POST /checkout -> {url}. surfaces (answer surfaces on the plan) and interval ('month'|'year') ride along when set. */
export async function checkout({ email, surfaces, interval } = {}) {
  return request('POST', trialPath('/checkout'), { body: { ...(email ? { email } : {}), ...(Array.isArray(surfaces) && surfaces.length ? { surfaces } : {}), ...(interval ? { interval } : {}) } });
}

/** `${origin}${pathname}?t=<id>&k=<restore key>` (never contains the bearer token; the restore key only works on POST /restore). */
export function shareLink() {
  const id = T().id || '';
  const k = T().restoreKey;
  return `${location.origin}${location.pathname}?t=${encodeURIComponent(id)}${k ? `&k=${encodeURIComponent(k)}` : ''}`;
}

/** POST /setup (SSE). onEvent(type, data, id) for typing|delta|patch|action|card|chips|done. Resolves with 'done' data. */
export function setupTurn(body, { onEvent, signal } = {}) {
  let path;
  try { path = trialPath('/setup'); } catch (err) { return Promise.reject(err); }
  return postStream(path, body, { onEvent, signal, until: 'done' });
}

/** POST /ask (SSE). onEvent(type, data, id) for status|retrieval|lines|selected|delta|final|done. Resolves with 'final' data. */
export function ask(body, { onEvent, signal } = {}) {
  let path;
  try { path = trialPath('/ask'); } catch (err) { return Promise.reject(err); }
  return postStream(path, body, { onEvent, signal, until: 'final' });
}

// ------------------------------------------------------------------ trial events (SSE with resume + polling fallback)

const FILE_KEYS = ['stage', 'chunks', 'atoms', 'vectorized', 'error', 'stalledFor', 'enabled', 'summary', 'bytes', 'name'];

/**
 * SSE GET /events?since=<n> via fetch (EventSource can't send Authorization). Auto-reconnects (1, 2, 4, 8 s; cap 15 s).
 * After 2 failures within 30 s it switches to polling GET /files every 1.5 s (4 s after 30 s without change),
 * emitting synthetic 'file' (and 'usage') events for diffs, and retries the stream every 30 s.
 * onEvent(type, data, id); onStatus('live'|'reconnecting'|'polling'). Also emits store event 'sse:status' {status}.
 * Returns {close()}.
 */
export function openEvents({ onEvent, onStatus } = {}) {
  let closed = false, since = null, ctrl = null, timer = 0, pollTimer = 0, retryTimer = 0;
  let failures = [], attempt = 0, status = null, polling = false, lastChange = Date.now(), gen = 0, stallTimer = 0;
  const STALL_MS = 40000;
  const known = new Map();       // fileId -> snapshot of FILE_KEYS (shared by stream + polling, so diffs stay quiet)

  const setStatus = (s) => {
    if (s === status) return; status = s;
    try { onStatus && onStatus(s); } catch (err) { console.error(err); }
    emit('sse:status', { status: s });
  };
  const remember = (row) => { if (row && row.id) known.set(row.id, JSON.stringify(FILE_KEYS.map((k) => row[k]))); };
  const deliver = (type, data, id) => {
    if (type === 'hello' && data && Array.isArray(data.files)) { known.clear(); data.files.forEach(remember); }
    if (type === 'file') remember(data);
    if (type === 'file' || type === 'hello') lastChange = Date.now();
    // the website import (a background job) rides on this stream; the store card and the Sources groups listen on the bus
    if (data && typeof data === 'object') {
      try {
        if (type === 'store') emit('store:event', data);
        else if (type === 'storegroup') emit('store:group', data);
        else if (type === 'asked') emit('insights:asked', data);
        else if (type === 'hello') {
          if (Array.isArray(data.files)) emit('store:rows', { rows: data.files.filter((r) => r && r.origin === 'store'), reset: true });
          for (const g of Array.isArray(data.groups) ? data.groups : []) emit('store:group', g);
          if (data.storeJob) emit('store:job', data.storeJob);
        } else if (type === 'file' && data.origin === 'store') emit('store:rows', { rows: [data] });
      } catch (err) { console.error(err); }
    }
    try { onEvent && onEvent(type, data, id); } catch (err) { console.error(`[studio] events handler for "${type}" failed`, err); }
  };

  async function connect() {
    if (closed) return;
    const my = ++gen;
    ctrl = new AbortController();
    let path;
    try { path = trialPath(`/events${since != null ? `?since=${encodeURIComponent(since)}` : ''}`); } catch { return; }
    let gotAny = false;
    // r8 (D10): a stream that goes silent (no event and no ': ping' for 40 s; the server pings every 15 s) is treated
    // as dropped: 'Reconnecting…' shows and the client reconnects, instead of waiting on a dead socket
    let lastByte = Date.now();
    const myCtrl = ctrl;
    clearInterval(stallTimer);
    stallTimer = setInterval(() => {
      if (closed || my !== gen) { clearInterval(stallTimer); return; }
      if (Date.now() - lastByte > STALL_MS) { clearInterval(stallTimer); setStatus('reconnecting'); try { myCtrl.abort(); } catch { /* ignore */ } }
    }, 5000);
    try {
      const res = await fetch(BASE + path, { headers: { ...authHeaders(), accept: 'text/event-stream' }, signal: ctrl.signal, credentials: 'omit' });
      lastByte = Date.now();
      if (!res.ok) {
        const err = await toError(res, { trialCall: true, trialRoot: res.status === 404 });
        if (err.status === 401 || err.code === 'expired' || err.status === 404) { closed = true; setStatus('reconnecting'); return; }
        throw err;
      }
      await readSSE(res, (type, data, id) => {
        if (my !== gen) return;
        if (id != null && id !== '') since = id;
        if (!gotAny) { gotAny = true; attempt = 0; if (polling) stopPolling(); setStatus('live'); }
        if (type === 'bye') { try { ctrl.abort(); } catch { /* ignore */ } return; }
        deliver(type, data, id);
      }, { onActivity: () => { lastByte = Date.now(); } });
    } catch (err) {
      if (closed) return;
      if (!(err && (err.name === 'AbortError' || err.code === 'aborted')) || !gotAny) { /* fall through to retry */ }
    }
    if (my === gen) clearInterval(stallTimer);
    if (closed || my !== gen) return;
    // Stream ended (rotate, network, server restart). A clean 'bye' reconnects at once.
    const now = Date.now();
    if (!gotAny) failures.push(now);
    failures = failures.filter((t) => now - t < 30000);
    if (failures.length >= 2 && !polling) { startPolling(); return; }
    if (polling) return;   // polling mode retries on its own schedule
    setStatus('reconnecting');
    const delay = gotAny ? 250 : Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4));
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
  }

  async function pollOnce() {
    if (closed || !polling) return;
    try {
      const r = await listFiles();
      // one poll = one round of store notifications (perf r4: every changed row used to fan out on its own)
      batch(() => {
        for (const row of (r && r.files) || []) {
          const snap = JSON.stringify(FILE_KEYS.map((k) => row[k]));
          if (known.get(row.id) !== snap) { known.set(row.id, snap); lastChange = Date.now(); deliver('file', row, null); }
        }
        if (r && r.usage) deliver('usage', r.usage, null);
      });
    } catch (err) {
      if (err && (err.status === 401 || err.code === 'expired')) { close(); return; }
    }
    if (closed || !polling) return;
    pollTimer = setTimeout(pollOnce, Date.now() - lastChange > 30000 ? 4000 : 1500);
  }

  function startPolling() {
    polling = true;
    setStatus('polling');
    clearTimeout(pollTimer);
    pollOnce();
    clearInterval(retryTimer);
    retryTimer = setInterval(() => { if (!closed && polling) { try { ctrl && ctrl.abort(); } catch { /* ignore */ } connect(); } }, 30000);
  }
  function stopPolling() { polling = false; failures = []; clearTimeout(pollTimer); clearInterval(retryTimer); }

  function close() {
    closed = true;
    clearTimeout(timer); clearTimeout(pollTimer); clearInterval(retryTimer); clearInterval(stallTimer);
    try { ctrl && ctrl.abort(); } catch { /* ignore */ }
  }

  const onOnline = () => { if (!closed) { clearTimeout(timer); attempt = 0; try { ctrl && ctrl.abort(); } catch { /* ignore */ } connect(); } };
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  connect();
  return { close() { close(); if (typeof window !== 'undefined') window.removeEventListener('online', onOnline); } };
}

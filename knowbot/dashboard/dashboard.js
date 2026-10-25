// KnowBot operator dashboard — plain ESM, no build, no deps.
// Events come from untrusted clients: every value is normalised, and all text is
// written with textContent / createTextNode (never innerHTML).

import { simulator, simCanonical } from './sim.js?v=814a170';
import { hostedApi } from '../lib/site-config.js?v=814a170';
import { mountBots } from './bots.js?v=814a170';

/* ------------------------------------------------------------------ utils */
const $ = (s, r = document) => r.querySelector(s);
const TYPES = ['session.start', 'message.user', 'message.bot', 'canonical', 'feedback'];
const KINDS = ['widget', 'inline', 'fullpage', 'api', 'dashboard'];
const DEVICES = ['mobile', 'tablet', 'desktop'];
const ACTIVE_MS = 5 * 60 * 1000;
const MAX_FEED = 80;
const MAX_SEEN = 20000;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}
function rc(el, ...kids) { el.replaceChildren(); return append(el, kids); }
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
// Constant, author-written SVG only.
const SVGNS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  mobile: [['rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2 }], ['path', { d: 'M11 18.5h2' }]],
  tablet: [['rect', { x: 4, y: 3, width: 16, height: 18, rx: 2 }], ['path', { d: 'M11 18h2' }]],
  desktop: [['rect', { x: 2.5, y: 4, width: 19, height: 12.5, rx: 1.5 }], ['path', { d: 'M8.5 20h7M12 16.5V20' }]],
  unknown: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 8v5M12 16h.01' }]],
  widget: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M8.5 11.5h7M8.5 14.5h4' }]],
  inline: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M3 10h18' }]],
  fullpage: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['path', { d: 'M7 8h10M7 12h10M7 16h6' }]],
  api: [['path', { d: 'M8 7l-5 5 5 5M16 7l5 5-5 5' }]],
  dashboard: [['path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }]],
  frame: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['rect', { x: 7, y: 7, width: 10, height: 10, rx: 1 }]],
};
function icon(name) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const [t, a] of ICON_PATHS[name] || ICON_PATHS.unknown) {
    const n = document.createElementNS(SVGNS, t);
    for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
    svg.append(n);
  }
  return svg;
}
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}

const str = (v, max = 500) => (v == null ? '' : (typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '')).slice(0, max);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null));
function safeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
}
function parseTs(v) {
  const n = num(v);
  if (n != null) return n < 1e12 ? n * 1000 : n; // accept seconds or ms
  if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  return Date.now();
}
function normSurface(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    kind: KINDS.includes(s.kind) ? s.kind : 'unknown',
    device: DEVICES.includes(s.device) ? s.device : 'unknown',
    host: str(s.host, 120), path: str(s.path, 300), referrer: str(s.referrer, 400),
    embedded: s.embedded === true, channel: str(s.channel, 24), lang: str(s.lang, 24), ua: str(s.ua, 400),
    instance: /^[a-z0-9-]{1,40}$/.test(s.instance || '') ? s.instance : '', // chat instance (bot) id; '' = built-in
  };
}
function normCitations(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 24).filter((c) => c && typeof c === 'object').map((c, i) => ({
    n: num(c.n) ?? i + 1, file_id: str(c.file_id, 200), filename: str(c.filename, 300) || str(c.file_id, 200) || `source-${i + 1}`,
    title: str(c.title, 300), url: safeUrl(c.url), score: num(c.score), snippet: str(c.snippet || c.text, 1200),
  }));
}
function normLatency(l) {
  if (!l || typeof l !== 'object') return null;
  const o = { retrieval: num(l.retrieval), generation: num(l.generation), total: num(l.total) };
  if (o.total == null && (o.retrieval != null || o.generation != null)) o.total = (o.retrieval || 0) + (o.generation || 0);
  return o.total == null ? null : o;
}
function normEngine(e) { return e && typeof e === 'object' ? { type: str(e.type, 40), model: str(e.model, 160) } : null; }
function normAnswer(a) {
  a = a && typeof a === 'object' ? a : {};
  const citations = normCitations(a.citations);
  return {
    text: str(a.text, 12000), citations,
    grounded: typeof a.grounded === 'boolean' ? a.grounded : citations.length > 0,
    refused: a.refused === true, latencyMs: normLatency(a.latencyMs), engine: normEngine(a.engine),
  };
}
function normEvent(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.includes(raw.type)) return null;
  const sessionId = str(raw.sessionId, 160);
  if (!sessionId) return null;
  const e = {
    type: raw.type, ts: parseTs(raw.ts), sessionId, turnId: str(raw.turnId, 160),
    surface: normSurface(raw.surface), text: str(raw.text, 12000),
  };
  if (e.type === 'message.bot' || e.type === 'canonical') Object.assign(e, normAnswer(raw));
  const r = raw.retrieval;
  if (r && typeof r === 'object') e.retrieval = { source: str(r.source, 40), count: num(r.count), topScore: num(r.topScore) };
  if (e.type === 'feedback') e.rating = raw.rating === 'up' || raw.rating === 'down' ? raw.rating : null;
  e.sim = e.surface.channel === 'sim';
  return e;
}

const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 2)} s` : `${Math.round(ms)} ms`);
const fmtPct = (x) => (x == null ? '—' : `${Math.round(x * 100)}`);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}
function median(sorted) {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
const rid = () => Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------------ state */
const S = {
  apiBase: '', apiFromParam: false, conn: 'connecting', connInfo: '', config: null,
  seen: new Set(), sessions: new Map(), canonical: new Map(), feed: [], newFeed: [],
  filter: null, selected: null, autoCanon: false, autoCanonSince: 0,
  ask: null, simRunning: false, flashKpi: false,
  bots: [], builtinBot: 'ugm', botFilter: '', // bots from GET /api/graph; botFilter narrows everything to one bot
};
const ckey = (sid, tid) => `${sid}\u0001${tid}`;

function getSession(e) {
  let s = S.sessions.get(e.sessionId);
  if (!s) {
    s = { sessionId: e.sessionId, surface: e.surface, startedAt: e.ts, lastAt: e.ts, turns: new Map(), sim: e.sim, serverTurns: 0, pulse: 0 };
    S.sessions.set(e.sessionId, s);
  }
  if ((s.surface.kind === 'unknown' && e.surface.kind !== 'unknown') || (e.type === 'session.start' && e.surface.kind !== 'unknown')) s.surface = e.surface;
  if (e.sim) s.sim = true;
  s.startedAt = Math.min(s.startedAt, e.ts);
  s.lastAt = Math.max(s.lastAt, e.ts);
  return s;
}
function getTurn(s, tid, ts) {
  const id = tid || `_${s.turns.size}`;
  let t = s.turns.get(id);
  if (!t) { t = { turnId: id, user: null, bot: null, feedback: null, ts }; s.turns.set(id, t); }
  t.ts = Math.min(t.ts, ts);
  return t;
}
const turnsOf = (s) => [...s.turns.values()].filter((t) => t.user || t.bot).sort((a, b) => a.ts - b.ts);

function ingest(raw, origin) {
  if (Array.isArray(raw)) { raw.forEach((r) => ingest(r, origin)); return; }
  if (raw && typeof raw === 'object' && !raw.type && raw.event) raw = raw.event; // tolerate {event} wrappers
  const e = normEvent(raw);
  if (!e) return;
  const key = `${e.sessionId}\u0000${e.turnId}\u0000${e.type}`;
  if (S.seen.has(key)) return;
  if (S.seen.size > MAX_SEEN) S.seen.clear();
  S.seen.add(key);

  if (e.type === 'canonical') {
    const k = ckey(e.sessionId, e.turnId);
    const cur = S.canonical.get(k);
    if (!cur || cur.status !== 'done') S.canonical.set(k, { status: 'done', answer: normAnswer(raw), via: 'stream', at: e.ts });
    pushFeed(e);
    schedule();
    return;
  }
  const s = getSession(e);
  if (e.type === 'message.user') getTurn(s, e.turnId, e.ts).user = e;
  else if (e.type === 'message.bot') getTurn(s, e.turnId, e.ts).bot = e;
  else if (e.type === 'feedback') { const t = s.turns.get(e.turnId); if (t) t.feedback = e.rating; else getTurn(s, e.turnId, e.ts).feedback = e.rating; }
  s.pulse = Date.now();
  pushFeed(e);
  if (e.type === 'message.user') {
    announce(`New question via ${e.surface.kind}${e.surface.host ? ' on ' + e.surface.host : ''}: ${e.text.slice(0, 90)}`);
    if (S.autoCanon && e.ts >= S.autoCanonSince - 3000 && e.text) requestCanonical(e.sessionId, e.turnId, e.text, { auto: true });
  }
  S.flashKpi = true;
  schedule();
}

function pushFeed(e) {
  const item = { e, id: rid() };
  S.feed.unshift(item); S.newFeed.push(item);
  if (S.feed.length > MAX_FEED) S.feed.length = MAX_FEED;
}

let liveTimer = 0;
function announce(msg) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { $('#sr-status').textContent = msg; }, 400);
}

/* ------------------------------------------------------------------ filter */
const botOf = (s) => s.surface.instance || S.builtinBot;
function botName(id) { const b = S.bots.find((x) => x.id === id); return b ? b.name : id; }
// The bot filter (meta-row select) stacks with the single click-to-filter dimension below.
function sessionMatches(s, f = S.filter) {
  if (S.botFilter && botOf(s) !== S.botFilter) return false;
  if (!f) return true;
  if (f.dim === 'kind') return s.surface.kind === f.value;
  if (f.dim === 'device') return s.surface.device === f.value;
  if (f.dim === 'host') return (s.surface.host || '(none)') === f.value;
  if (f.dim === 'source') return turnsOf(s).some((t) => t.bot && t.bot.citations.some((c) => c.filename === f.value));
  return true;
}
function setFilter(dim, value) {
  S.filter = S.filter && S.filter.dim === dim && S.filter.value === value ? null : { dim, value };
  S.feedReset = true;
  schedule();
}
const DIM_LABEL = { kind: 'surface', device: 'device', host: 'host', source: 'cites' };

/* ------------------------------------------------------------------ canonical */
async function requestCanonical(sessionId, turnId, question, opts = {}) {
  const k = ckey(sessionId, turnId);
  const cur = S.canonical.get(k);
  if (cur && (cur.status === 'pending' || (cur.status === 'done' && opts.auto))) return;
  S.canonical.set(k, { status: 'pending', auto: !!opts.auto });
  schedule();
  const session = S.sessions.get(sessionId);
  try {
    // Canonical answers must come from the same bot (same enabled buckets) the visitor talked to.
    const answer = await postCanonical({ question, sessionId, turnId, instance: session && session.surface.instance ? session.surface.instance : undefined });
    S.canonical.set(k, { status: 'done', answer, via: 'api', at: Date.now() });
  } catch (err) {
    if (session && session.sim) {
      const t = session.turns.get(turnId);
      S.canonical.set(k, { status: 'done', answer: normAnswer(simCanonical(question, t && t.bot)), via: 'sim', at: Date.now() });
    } else {
      S.canonical.set(k, { status: 'error', error: String(err && err.message || err) });
    }
  }
  schedule();
}
async function postCanonical(body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000); // CPU inference can be slow
  try {
    const r = await fetch(`${S.apiBase}/api/canonical`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    return normAnswer(await r.json());
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Timed out waiting for canonical answer');
    if (e instanceof TypeError) throw new Error(`KnowBot server unreachable at ${S.apiBase}`);
    throw e;
  } finally { clearTimeout(timer); }
}
const fileSet = (a) => new Set((a && !a.refused ? a.citations : []).map((c) => c.filename));
function compare(surfaceAns, canonAns) {
  const A = fileSet(surfaceAns), B = fileSet(canonAns);
  const union = new Set([...A, ...B]);
  const shared = [...A].filter((x) => B.has(x));
  const j = union.size ? shared.length / union.size : 1;
  const sameMode = !!surfaceAns.refused === !!canonAns.refused && !!surfaceAns.grounded === !!canonAns.grounded;
  return { A, B, shared: new Set(shared), j, union: union.size, matches: sameMode && j >= 0.5 };
}

/* ------------------------------------------------------------------ connection */
// Optional operator token (server env KNOWBOT_DASHBOARD_TOKEN): open the dashboard with ?token=<it>.
const TOKEN = new URLSearchParams(location.search).get('token');
const withToken = (u) => (TOKEN ? `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : u);
async function fetchJSON(url, ms = 3000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); }
  finally { clearTimeout(t); }
}
function resolveCandidates() {
  const q = new URLSearchParams(location.search).get('api');
  const fromQ = q && safeUrl(q);
  if (fromQ) { S.apiFromParam = true; return [fromQ.replace(/\/+$/, '')]; }
  const out = [];
  if (hostedApi()) out.push(hostedApi());
  if (/^https?:$/.test(location.protocol)) out.push(location.origin);
  out.push('http://localhost:8787');
  return [...new Set(out)];
}
async function resolveApi() {
  const cands = resolveCandidates();
  for (const c of cands) {
    try { const cfg = await fetchJSON(`${c}/api/config`, c === hostedApi() ? 30000 : 2500); S.apiBase = c; setConfig(cfg); return; } catch { /* next */ }
  }
  // None answered: prefer same origin when it looks like the KnowBot server, else localhost.
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname) && location.port === '8787';
  S.apiBase = S.apiFromParam ? cands[0] : (local ? location.origin : cands[cands.length - 1]);
}
function setConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  S.config = {
    store: str(cfg.store, 120), retrieval: str(cfg.retrieval, 40),
    engine: normEngine(cfg.engine), canonical: cfg.canonical && typeof cfg.canonical === 'object' ? cfg.canonical : null,
  };
  renderMeta();
}
async function seedSessions() {
  try {
    const list = await fetchJSON(withToken(`${S.apiBase}/api/sessions`), 4000);
    if (!Array.isArray(list)) return;
    for (const r of list.slice(0, 1000)) {
      if (!r || typeof r !== 'object') continue;
      const sid = str(r.sessionId, 160); if (!sid) continue;
      let s = S.sessions.get(sid);
      const surface = normSurface(r.surface);
      if (!s) {
        s = { sessionId: sid, surface, startedAt: parseTs(r.startedAt), lastAt: parseTs(r.lastAt ?? r.startedAt), turns: new Map(), sim: surface.channel === 'sim', serverTurns: 0, pulse: 0 };
        S.sessions.set(sid, s);
      }
      s.serverTurns = Math.max(s.serverTurns, num(r.turns) || 0);
      s.serverGrounded = num(r.groundedRate);
      if (r.lastAt != null) s.lastAt = Math.max(s.lastAt, parseTs(r.lastAt));
    }
    schedule();
  } catch { /* optional */ }
}

let es = null, attempts = 0, retryTimer = 0, countdownTimer = 0;
function setConn(state, info = '') {
  S.conn = state; S.connInfo = info;
  const pill = $('#conn'); pill.dataset.state = state;
  $('#conn-label').textContent = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : info || 'Offline';
  pill.setAttribute('aria-label', `Server stream: ${state === 'live' ? 'live' : state}. ${info}. Activate to reconnect now.`);
}
function connect() {
  clearTimeout(retryTimer); clearInterval(countdownTimer);
  if (es) { es.close(); es = null; }
  if (typeof EventSource === 'undefined') { setConn('offline', 'No EventSource'); return; }
  setConn('connecting');
  let opened = false;
  try { es = new EventSource(withToken(`${S.apiBase}/api/stream`)); } catch { scheduleRetry(); return; }
  es.addEventListener('open', () => {
    opened = true; attempts = 0; setConn('live');
    if (!S.config) fetchJSON(`${S.apiBase}/api/config`).then(setConfig).catch(() => {});
    seedSessions();
    renderMeta();
  });
  const onMsg = (ev) => { try { ingest(JSON.parse(ev.data), 'sse'); } catch { /* malformed */ } };
  es.addEventListener('knowbot', onMsg);
  es.onmessage = onMsg;
  es.onerror = () => {
    if (es) es.close();
    es = null;
    if (opened) attempts = 0;
    scheduleRetry();
  };
}
function scheduleRetry() {
  attempts++;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5));
  const at = Date.now() + delay;
  const tick = () => {
    const left = Math.max(0, Math.ceil((at - Date.now()) / 1000));
    setConn('offline', `Offline · retry ${left}s`);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
  retryTimer = setTimeout(async () => {
    clearInterval(countdownTimer);
    if (!S.apiFromParam && attempts % 3 === 0) await resolveApi();
    connect();
  }, delay);
}

let bc = null;
function listenBroadcast() {
  const pill = $('#bc');
  if (typeof BroadcastChannel === 'undefined') { pill.dataset.state = 'off'; return; }
  bc = new BroadcastChannel('knowbot');
  bc.onmessage = (ev) => {
    let d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    ingest(d, 'bc');
  };
  pill.dataset.state = 'on';
}

/* ------------------------------------------------------------------ rendering */
let rafId = 0;
function schedule() { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; renderAll(); }); }

function renderAll() {
  const any = S.sessions.size > 0;
  $('#empty-hero').hidden = any;
  $('#grid').hidden = !any;
  renderKpis();
  renderFilterChip();
  if (any) {
    renderSessions();
    renderConvo();
    renderSurfaces();
    renderSources();
    renderFeed();
  }
  S.newFeed = [];
}

function withFocus(container, fn) {
  const a = document.activeElement;
  const fk = a && container.contains(a) ? a.dataset.fk : null;
  const top = container.scrollTop;
  fn();
  container.scrollTop = top;
  if (fk) { const n = container.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (n) n.focus({ preventScroll: true }); }
}

function surfaceBadge(surface, { full = false, sim = false } = {}) {
  const kind = surface.kind;
  const where = h('span', { class: 'where', title: `${surface.host}${surface.path}` });
  if (surface.host) where.append(h('b', null, surface.host));
  if (surface.path && (full || surface.path !== '/')) where.append(surface.path);
  if (!surface.host && !surface.path) where.append(kind === 'api' ? 'server-side' : 'unknown host');
  return h('span', { class: 'sbadge' },
    h('span', { class: `kind kind-${kind}`, title: `Surface: ${kind}, device: ${surface.device}` },
      icon(surface.device === 'unknown' ? (kind === 'api' ? 'api' : 'unknown') : surface.device), kind),
    sim ? simFlag() : null,
    where,
    surface.embedded ? h('span', { class: 'flag flag-iframe', title: 'Rendered inside an iframe' }, 'iframe') : null,
  );
}
// Bot badge: shown once custom bots exist (or the session names one), so single-bot setups stay uncluttered.
function botBadge(s) {
  if (!s.surface.instance && S.bots.length < 2) return null;
  const id = botOf(s);
  return h('span', { class: 'flag flag-inst', title: `Bot: ${botName(id)} (${id})` }, botName(id));
}
const simFlag = () => h('span', { class: 'flag flag-sim', title: 'Simulated traffic (surface.channel = sim)' }, 'sim');

/* KPIs */
function computeKpis() {
  const now = Date.now();
  let active = 0, users = 0, bots = 0, grounded = 0, refused = 0, cites = 0;
  const lat = [];
  const N = 24; const buckets = new Array(N).fill(0);
  let first = now;
  for (const s of S.sessions.values()) if (sessionMatches(s)) for (const t of s.turns.values()) for (const m of [t.user, t.bot]) if (m) first = Math.min(first, m.ts);
  const span = Math.min(30 * 60000, Math.max(2 * 60000, now - first)); // adaptive window: 2–30 min
  for (const s of S.sessions.values()) {
    if (!sessionMatches(s)) continue;
    if (now - s.lastAt <= ACTIVE_MS) active++;
    for (const t of s.turns.values()) {
      for (const m of [t.user, t.bot]) {
        if (!m) continue;
        const b = N - 1 - Math.floor(((now - m.ts) / span) * N);
        if (b >= 0 && b < N) buckets[b]++;
      }
      if (t.user) users++;
      if (t.bot) {
        bots++;
        if (t.bot.citations.length >= 1) grounded++;
        if (t.bot.refused) refused++;
        cites += t.bot.citations.length;
        if (t.bot.latencyMs && t.bot.latencyMs.total != null) lat.push(t.bot.latencyMs.total);
      }
    }
  }
  lat.sort((a, b) => a - b);
  return {
    active, users, bots, messages: users + bots, buckets,
    grounded: bots ? grounded / bots : null, refused: bots ? refused / bots : null,
    med: median(lat), p95: quantile(lat, 0.95), avgCites: bots ? cites / bots : null, latN: lat.length,
  };
}
function sparkline(buckets) {
  const max = Math.max(1, ...buckets);
  const w = 76, hgt = 26;
  const pts = buckets.map((v, i) => `${(i / (buckets.length - 1)) * w},${hgt - 2 - (v / max) * (hgt - 4)}`).join(' ');
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true' });
  svg.append(svgEl('polyline', { points: `0,${hgt} ${pts} ${w},${hgt}`, stroke: 'none', style: 'fill: var(--accent-soft)' }));
  svg.append(svgEl('polyline', { points: pts, fill: 'none', style: 'stroke: var(--accent-2)', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }));
  return svg;
}
function renderKpis() {
  const k = computeKpis();
  const tile = (label, value, sub, extra, id) => h('div', { class: 'kpi', 'data-kpi': id }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null, extra);
  const meter = (x, bad) => h('div', { class: `meter${bad ? ' bad' : ''}`, 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round((x || 0) * 100)}%` } }));
  const pct = (x) => [fmtPct(x), x == null ? null : h('small', null, '%')];
  const el = $('#kpis');
  rc(el, 
    tile('Active sessions', String(k.active), 'activity in last 5 min', null, 'active'),
    tile('Messages', String(k.messages), `${k.users} asked · ${k.bots} answered`, k.messages ? sparkline(k.buckets) : null, 'messages'),
    tile('Grounded', pct(k.grounded), 'answers with ≥1 citation', meter(k.grounded), 'grounded'),
    tile('Refusals', pct(k.refused), 'not covered by knowDrive', meter(k.refused, true), 'refused'),
    tile('Median latency', fmtMs(k.med), `total · n=${k.latN}`, null, 'median'),
    tile('p95 latency', fmtMs(k.p95), 'total, retrieval + generation', null, 'p95'),
    tile('Citations / answer', k.avgCites == null ? '—' : k.avgCites.toFixed(1), 'avg across bot answers', null, 'cites'),
  );
  const parts = [S.botFilter ? `bot ${botName(S.botFilter)}` : null, S.filter ? `${DIM_LABEL[S.filter.dim]} ${S.filter.value}` : null].filter(Boolean);
  el.setAttribute('aria-label', parts.length ? `Live metrics, filtered to ${parts.join(' and ')}` : 'Live metrics');
}

function renderFilterChip() {
  const chip = $('#filter-chip');
  if (!S.filter) { chip.hidden = true; rc(chip); return; }
  chip.hidden = false;
  rc(chip, 
    h('span', null, `Filter · ${DIM_LABEL[S.filter.dim]} = `, h('b', null, S.filter.value)),
    h('button', { type: 'button', 'aria-label': 'Clear filter', onclick: () => { S.filter = null; S.feedReset = true; schedule(); } }, '×'),
  );
}

function renderMeta() {
  const api = $('#cfg-api');
  rc(api, 'api ', h('b', null, S.apiBase || '…'));
  const d = $('#cfg-detail');
  const c = S.config;
  if (!c) { rc(d, S.conn === 'live' ? '' : h('span', null, 'server not reachable — showing same-browser events')); return; }
  rc(d, 
    c.store ? h('span', null, 'store ', h('b', null, c.store)) : null,
    c.retrieval ? h('span', null, 'retrieval ', h('b', null, c.retrieval)) : null,
    c.engine && c.engine.model ? h('span', null, 'engine ', h('b', null, c.engine.model)) : null,
    c.canonical ? h('span', null, 'canonical ', h('b', null, Object.entries(c.canonical).slice(0, 4).map(([k, v]) => `${str(k, 20)}=${str(v, 20)}`).join(' '))) : null,
  );
}

/* sessions list */
const rowEls = new Map();
function turnDots(s) {
  const wrap = h('span', { class: 'turn-dots', 'aria-hidden': 'true' });
  for (const t of turnsOf(s).slice(-8)) wrap.append(h('i', { class: !t.bot ? 'p' : t.bot.refused ? 'r' : t.bot.citations.length ? 'g' : '' }));
  return wrap;
}
function sessionRow(s) {
  const turns = turnsOf(s);
  const lastQ = [...turns].reverse().find((t) => t.user);
  const nTurns = Math.max(turns.length, s.serverTurns || 0);
  const active = Date.now() - s.lastAt <= ACTIVE_MS;
  const btn = h('button', {
    type: 'button', class: 'srow', 'data-fk': `s:${s.sessionId}`, 'aria-current': S.selected === s.sessionId ? 'true' : 'false',
    onclick: () => selectSession(s.sessionId, true),
  },
    h('span', { class: 'srow-meta' }, surfaceBadge(s.surface, { sim: s.sim }), botBadge(s)),
    h('span', { class: `srow-q${lastQ ? '' : ' none'}` }, lastQ ? lastQ.user.text : 'No questions yet'),
    h('span', { class: 'srow-meta' },
      active ? h('span', { class: 'live-dot', title: 'active in last 5 min' }) : null,
      h('span', { class: 'mono' }, clock(s.startedAt)),
      h('span', null, `${nTurns} turn${nTurns === 1 ? '' : 's'}`),
      h('span', null, ago(s.lastAt)),
      turnDots(s)),
  );
  btn.setAttribute('aria-label', `${s.sim ? 'Simulated ' : ''}${S.bots.length > 1 || s.surface.instance ? `bot ${botName(botOf(s))}, ` : ''}${s.surface.kind} session on ${s.surface.host || 'unknown host'}, ${s.surface.device}, ${nTurns} turns, last activity ${ago(s.lastAt)}${lastQ ? '. Last question: ' + lastQ.user.text.slice(0, 120) : ''}`);
  return btn;
}
function renderSessions() {
  const list = $('#sessions');
  const rows = [...S.sessions.values()].filter((s) => sessionMatches(s)).sort((a, b) => b.lastAt - a.lastAt);
  $('#sessions-count').textContent = `${rows.length}${S.filter || S.botFilter ? ' filtered' : ''} · ${S.sessions.size} total`;
  withFocus(list, () => {
    const now = Date.now();
    const kids = rows.slice(0, 300).map((s) => {
      const li = h('div', { role: 'listitem' }, sessionRow(s));
      const prev = rowEls.get(s.sessionId);
      if (s.pulse && now - s.pulse < 1200 && (!prev || prev.pulse !== s.pulse)) li.firstChild.classList.add('pulse');
      rowEls.set(s.sessionId, { pulse: s.pulse });
      return li;
    });
    rc(list, ...(kids.length ? kids : [h('div', { class: 'list-empty' }, 'No sessions match this filter.')]));
  });
}
function selectSession(id, focusConvo) {
  S.selected = id;
  renderAll();
  if (focusConvo) {
    const c = $('#convo');
    if (matchMedia('(max-width: 900px)').matches) $('#convo-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    c.focus({ preventScroll: true });
  }
}

/* markdown-lite → DOM (no innerHTML) */
function renderMd(text, cites, onCite) {
  const root = h('div', { class: 'md' });
  const byN = new Map(cites.map((c) => [c.n, c]));
  const inline = (s) => {
    const out = [];
    const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]{1,200}\]\([^)\s]{1,500}\)|\[\d{1,2}(?:\s*,\s*\d{1,2})*\])/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) out.push(h('strong', null, tok.slice(2, -2)));
      else if (tok.startsWith('`')) out.push(h('code', null, tok.slice(1, -1)));
      else if (/^\[\d/.test(tok)) {
        for (const n of tok.slice(1, -1).split(',').map((x) => parseInt(x, 10))) {
          const c = byN.get(n);
          out.push(c && onCite
            ? h('button', { type: 'button', class: 'cite', title: c.title || c.filename, 'aria-label': `Citation ${n}: ${c.title || c.filename}`, onclick: () => onCite(n) }, String(n))
            : h('span', { class: `cite${c ? '' : ' dead'}`, title: c ? (c.title || c.filename) : 'no matching source' }, String(n)));
        }
      } else {
        const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
        const url = lm && safeUrl(lm[2]);
        out.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, lm[1]) : tok);
      }
      last = re.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  let list = null, para = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const li = /^\s*(?:[-*•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = h('ul'); root.append(list); } list.append(h('li', null, inline(li[1]))); para = null; continue; }
    list = null;
    if (!line.trim()) { para = null; continue; }
    const hd = /^#{1,6}\s+(.*)$/.exec(line);
    if (hd) { root.append(h('p', { class: 'md-h' }, inline(hd[1]))); para = null; continue; }
    if (!para) { para = h('p'); root.append(para); } else para.append(h('br'));
    append(para, inline(line));
  }
  return root;
}
function sourcesList(cites) {
  const els = new Map();
  const ol = h('ol', { class: 'srcs', 'aria-label': 'Sources' });
  for (const c of cites) {
    const title = c.title || c.filename;
    const li = h('li', { class: 'src' },
      h('span', { class: 'cite', 'aria-hidden': 'true' }, String(c.n)),
      h('span', { class: 'src-title' }, c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, title) : title),
      h('span', { class: 'src-file' }, c.filename, c.score != null ? h('span', { class: 'score' }, `score ${c.score.toFixed(3)}`) : null),
      c.snippet ? h('span', { class: 'src-snip' }, c.snippet) : null,
    );
    els.set(c.n, li); ol.append(li);
  }
  const focus = (n) => {
    const li = els.get(n); if (!li) return;
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    li.classList.add('flash'); setTimeout(() => li.classList.remove('flash'), 1200);
  };
  return { ol, focus };
}
function latencyView(l) {
  if (!l) return null;
  const tot = l.total || ((l.retrieval || 0) + (l.generation || 0)) || 1;
  const r = l.retrieval || 0, g = l.generation || 0;
  return h('span', { class: 'lat', title: `retrieval ${fmtMs(l.retrieval)} · generation ${fmtMs(l.generation)} · total ${fmtMs(l.total)}` },
    h('span', { class: 'lat-bar', 'aria-hidden': 'true' }, h('span', { class: 'r', style: { width: `${(r / tot) * 100}%` } }), h('span', { class: 'g', style: { width: `${(g / tot) * 100}%` } })),
    h('span', { class: 'lat-legend' }, fmtMs(l.total),
      h('i', { style: { background: 'var(--lat-r)' } }), `ret ${fmtMs(l.retrieval)}`,
      h('i', { style: { background: 'var(--accent-2)' } }), `gen ${fmtMs(l.generation)}`));
}
function answerBadges(a) {
  if (a.refused) return h('span', { class: 'badge badge-bad' }, 'refused · not in knowDrive');
  if (a.citations.length) return h('span', { class: 'badge badge-good' }, `grounded · ${a.citations.length} source${a.citations.length === 1 ? '' : 's'}`);
  return h('span', { class: 'badge badge-warn' }, 'ungrounded');
}
function answerBody(a, { sources = true } = {}) {
  const src = sourcesList(a.citations);
  const body = renderMd(a.text || (a.refused ? '(refused)' : '(empty answer)'), a.citations, src.focus);
  return [body, sources && a.citations.length ? [h('div', { class: 'srcs-title' }, 'Sources'), src.ol] : null];
}
function engineLabel(e) { return e ? [e.type, e.model].filter(Boolean).join(' · ') || null : null; }

function renderConvo() {
  const box = $('#convo');
  const tools = $('#convo-tools');
  const s = S.selected && S.sessions.get(S.selected);
  withFocus(box, () => {
    rc(tools);
    if (!s) {
      rc(box, h('div', { class: 'convo-empty' },
        h('div', { class: 'display' }, 'Select a session'),
        h('div', null, 'Pick any session to read the transcript, its sources, and compare each answer with KnowBot’s canonical response.')));
      return;
    }
    const turns = turnsOf(s);
    const userTurns = turns.filter((t) => t.user && t.user.text);
    if (userTurns.length) {
      tools.append(h('button', {
        type: 'button', class: 'btn btn-sm', 'data-fk': 'canon-all',
        onclick: () => userTurns.forEach((t) => requestCanonical(s.sessionId, t.turnId, t.user.text)),
      }, 'Canonicalize all'));
    }
    const sf = s.surface;
    const head = h('div', { class: 'convo-head' },
      h('div', { class: 'convo-head-top' }, surfaceBadge(sf, { full: true, sim: s.sim }), botBadge(s)),
      h('dl', { class: 'facts' },
        fact('Bot', `${botName(botOf(s))}${sf.instance ? '' : ' (built-in)'}`), fact('Surface', sf.kind), fact('Device', sf.device), fact('Channel', sf.channel || '—'), fact('Embedded', sf.embedded ? 'yes (iframe)' : 'no'),
        fact('Started', `${clock(s.startedAt)}`), fact('Last activity', ago(s.lastAt)), fact('Lang', sf.lang || '—'),
        fact('Turns', String(Math.max(turns.length, s.serverTurns || 0))),
        sf.referrer ? fact('Referrer', sf.referrer, true) : null,
        sf.ua ? fact('User agent', sf.ua, 'ua') : null),
      h('div', { class: 'convo-sid' }, `session ${s.sessionId}`),
    );
    const kids = [head];
    if (!turns.length) kids.push(h('p', { class: 'note' }, s.serverTurns ? `${s.serverTurns} turn(s) happened before this dashboard connected; the transcript isn’t in the stream replay.` : 'Session started — no messages yet.'));
    turns.forEach((t, i) => kids.push(turnView(s, t, i)));
    rc(box, ...kids);
  });
}
function fact(k, v, wrap) { return h('div', { class: wrap ? 'fact-wide' : null }, h('dt', null, k), h('dd', { class: wrap ? `wrap${wrap === 'ua' ? ' clamp' : ''}` : null, title: v }, v)); }

function turnView(s, t, i) {
  const wrap = h('article', { class: 'turn', 'aria-label': `Turn ${i + 1}` });
  const k = ckey(s.sessionId, t.turnId);
  const cs = S.canonical.get(k);
  if (t.user) {
    wrap.append(h('div', { class: 'msg msg-user' },
      h('div', { class: 'who' }, 'visitor', h('span', { class: 'mono' }, clock(t.user.ts))),
      h('div', { class: 'md' }, h('p', null, t.user.text || '(empty)')),
      h('div', { class: 'msg-meta' },
        t.user.text ? h('button', {
          type: 'button', class: 'btn btn-sm', 'data-fk': `canon:${i}`, disabled: cs && cs.status === 'pending',
          onclick: () => requestCanonical(s.sessionId, t.turnId, t.user.text),
        }, cs && cs.status === 'done' ? 'Refresh canonical' : cs && cs.status === 'pending' ? 'Asking KnowBot…' : 'Get canonical answer') : null)));
  }
  if (t.bot) {
    const b = t.bot;
    wrap.append(h('div', { class: 'msg msg-bot' },
      h('div', { class: 'who' }, `KnowBot via ${s.surface.kind}`, h('span', { class: 'mono' }, clock(b.ts)), answerBadges(b),
        t.feedback ? h('span', { class: `thumb ${t.feedback}`, title: `Visitor rated ${t.feedback}` }, t.feedback === 'up' ? '▲ helpful' : '▼ not helpful') : null),
      answerBody(b),
      h('div', { class: 'msg-meta' },
        latencyView(b.latencyMs),
        engineLabel(b.engine) ? h('span', { class: 'mono' }, engineLabel(b.engine)) : null,
        b.retrieval ? h('span', { class: 'mono' }, `${b.retrieval.source || 'retrieval'} · ${b.retrieval.count ?? '?'} hits${b.retrieval.topScore != null ? ' · top ' + b.retrieval.topScore.toFixed(2) : ''}`) : null)));
  } else if (t.user) {
    wrap.append(h('div', { class: 'msg msg-bot' }, h('span', { class: 'pending' }, h('span', { class: 'spinner' }), 'Waiting for the surface’s answer…')));
  }
  if (cs) wrap.append(canonView(t, cs));
  return wrap;
}

function overlapRing(j) {
  const svg = svgEl('svg', { class: 'overlap-ring', viewBox: '0 0 36 36', 'aria-hidden': 'true' });
  const C = 2 * Math.PI * 15;
  svg.append(svgEl('circle', { cx: 18, cy: 18, r: 15, fill: 'none', style: 'stroke: var(--raise)', 'stroke-width': 5 }));
  svg.append(svgEl('circle', { cx: 18, cy: 18, r: 15, fill: 'none', style: `stroke: var(${j >= 0.5 ? '--good' : '--warn'})`, 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-dasharray': `${C * j} ${C}`, transform: 'rotate(-90 18 18)' }));
  return svg;
}
function filesList(a, other, shared) {
  const ul = h('ul', { class: 'files', 'aria-label': 'Cited files' });
  const files = [...fileSet(a)];
  if (!files.length) ul.append(h('li', { class: 'none' }, a.refused ? 'no citations (refused)' : 'no citations'));
  for (const f of files) ul.append(h('li', { class: shared.has(f) ? 'shared' : 'only', title: shared.has(f) ? 'Cited by both' : `Only cited ${other}` }, f));
  return ul;
}
function canonView(t, cs) {
  const box = h('section', { class: 'canon', 'aria-label': 'Canonical comparison' });
  const title = h('div', { class: 'canon-title' }, 'Canonical comparison', h('span', { class: 'tag-canon' }, cs.via === 'sim' ? 'simulated' : 'temp 0'));
  if (cs.status === 'pending') {
    box.append(h('div', { class: 'canon-head' }, title), h('span', { class: 'pending' }, h('span', { class: 'spinner' }), cs.auto ? 'Auto-canonicalizing…' : 'Asking KnowBot for the canonical answer…'));
    return box;
  }
  if (cs.status === 'error') {
    box.append(h('div', { class: 'canon-head' }, title), h('div', { class: 'err' }, cs.error), h('div', { class: 'note' }, 'Canonical answers are computed by the KnowBot server (POST /api/canonical). Start it, or open the dashboard with ?api=<server>.'));
    return box;
  }
  const c = cs.answer;
  const head = h('div', { class: 'canon-head' }, title);
  let cmp = null;
  if (t.bot) {
    cmp = compare(t.bot, c);
    head.append(
      h('span', { class: 'overlap', title: 'Jaccard overlap of cited filenames' }, overlapRing(cmp.j), `overlap ${cmp.j.toFixed(2)}`, h('span', { class: 'note' }, `${cmp.shared.size}/${cmp.union} files`)),
      h('span', { class: `badge badge-big ${cmp.matches ? 'badge-good' : 'badge-warn'}` }, cmp.matches ? 'matches canonical' : 'diverges'));
  } else head.append(h('span', { class: 'badge badge-accent' }, 'surface has not answered yet'));
  const shared = cmp ? cmp.shared : new Set();
  const cols = h('div', { class: 'canon-cols' },
    h('div', { class: 'canon-col' },
      h('div', { class: 'col-head' }, 'What the surface answered', t.bot ? answerBadges(t.bot) : null),
      t.bot ? [renderMd(t.bot.text || '(empty)', t.bot.citations, null), filesList(t.bot, 'by the surface', shared)] : h('span', { class: 'pending' }, 'No answer yet')),
    h('div', { class: 'canon-col is-canon' },
      h('div', { class: 'col-head' }, cs.via === 'sim' ? 'Canonical (simulated, no server)' : 'KnowBot canonical', answerBadges(c)),
      answerBody(c, { sources: true }),
      filesList(c, 'canonically', shared)));
  box.append(head, cols, h('div', { class: 'canon-foot' },
    h('span', null, h('i', { class: 'legend-sq', style: { background: 'var(--good)' } }), 'cited by both'),
    h('span', null, h('i', { class: 'legend-sq', style: { background: 'var(--warn)' } }), 'cited by one side'),
    c.latencyMs ? h('span', null, `canonical ${fmtMs(c.latencyMs.total)}`) : null,
    engineLabel(c.engine) ? h('span', null, engineLabel(c.engine)) : null,
    h('span', null, 'match = same grounded/refused outcome and overlap ≥ 0.5')));
  return box;
}

/* surfaces breakdown */
function renderSurfaces() {
  const el = $('#surfaces');
  const groups = { kind: new Map(), device: new Map(), host: new Map() };
  for (const s of S.sessions.values()) {
    if (!sessionMatches(s, null)) continue; // bot filter only
    const msgs = turnsOf(s).length;
    for (const [dim, v] of [['kind', s.surface.kind], ['device', s.surface.device], ['host', s.surface.host || '(none)']]) {
      const g = groups[dim].get(v) || { n: 0, msgs: 0 };
      g.n++; g.msgs += msgs; groups[dim].set(v, g);
    }
  }
  const order = { kind: [...KINDS, 'unknown'], device: [...DEVICES, 'unknown'] };
  withFocus(el, () => {
    rc(el, ...[['kind', 'By surface kind'], ['device', 'By device'], ['host', 'By host']].map(([dim, label]) => {
      let entries = [...groups[dim].entries()];
      if (dim === 'kind') entries = order.kind.filter((k) => KINDS.includes(k) && k !== 'dashboard' || groups.kind.has(k)).map((k) => [k, groups.kind.get(k) || { n: 0, msgs: 0 }]);
      else if (order[dim]) entries.sort((a, b) => order[dim].indexOf(a[0]) - order[dim].indexOf(b[0]));
      else entries.sort((a, b) => b[1].n - a[1].n);
      entries = entries.slice(0, 8);
      const max = Math.max(1, ...entries.map(([, g]) => g.n));
      return h('div', { class: 'sgroup', role: 'group', 'aria-label': label },
        h('div', { class: 'sgroup-title' }, label),
        h('div', { class: 'bars' }, entries.length ? entries.map(([v, g]) => {
          const pressed = !!(S.filter && S.filter.dim === dim && S.filter.value === v);
          return h('button', {
            type: 'button', class: `bar${dim === 'kind' ? ' k-' + v : ''}`, 'aria-pressed': String(pressed), 'data-fk': `b:${dim}:${v}`,
            'aria-label': `${label.replace('By ', '')} ${v}: ${g.n} sessions, ${g.msgs} turns. ${pressed ? 'Active filter, activate to clear.' : 'Activate to filter.'}`,
            onclick: () => setFilter(dim, v),
          },
            h('span', { class: `bar-label${dim === 'host' ? ' mono' : ''}` }, dim === 'kind' ? icon(v) : dim === 'device' ? icon(v) : null, h('span', null, v)),
            h('span', { class: 'bar-track', 'aria-hidden': 'true' }, h('span', { class: 'bar-fill', style: { width: g.n ? `${(g.n / max) * 100}%` : '0', display: 'block', minWidth: g.n ? '2px' : '0' } })),
            h('span', { class: 'bar-n' }, String(g.n), h('small', null, `${g.msgs}t`)));
        }) : h('div', { class: 'muted-empty' }, 'No data')));
    }));
  });
}

/* sources leaderboard */
function renderSources() {
  const el = $('#sources');
  const agg = new Map();
  for (const s of S.sessions.values()) {
    if (!sessionMatches(s, S.filter && S.filter.dim === 'source' ? null : S.filter)) continue;
    for (const t of s.turns.values()) {
      if (!t.bot) continue;
      for (const c of t.bot.citations) {
        const a = agg.get(c.filename) || { n: 0, title: c.title, url: c.url };
        a.n++; if (!a.title && c.title) a.title = c.title;
        agg.set(c.filename, a);
      }
    }
  }
  const top = [...agg.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  const max = Math.max(1, ...top.map(([, a]) => a.n));
  withFocus(el, () => {
    rc(el, ...(top.length ? top.map(([file, a], i) => {
      const pressed = !!(S.filter && S.filter.dim === 'source' && S.filter.value === file);
      return h('li', null, h('button', {
        type: 'button', class: 'lb', 'aria-pressed': String(pressed), 'data-fk': `lb:${file}`, title: file,
        'aria-label': `${a.title || file}, ${file}, cited ${a.n} times. Activate to show sessions citing it.`,
        onclick: () => setFilter('source', file),
      },
        h('span', { class: 'lb-rank' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'lb-title' }, a.title || file),
        h('span', { class: 'lb-n' }, `${a.n}×`),
        h('span', { class: 'lb-file' }, file),
        h('span', { class: 'lb-track', 'aria-hidden': 'true' }, h('span', { style: { width: `${(a.n / max) * 100}%` } }))));
    }) : [h('li', { class: 'muted-empty' }, 'No citations yet.')]));
  });
}

/* live feed */
const FEED_LABEL = { 'session.start': 'session', 'message.user': 'question', 'message.bot': 'answer', canonical: 'canonical', feedback: 'feedback' };
function feedText(e) {
  if (e.type === 'session.start') return `${e.surface.device} · ${e.surface.host}${e.surface.path}`;
  if (e.type === 'message.bot' || e.type === 'canonical') return `${e.refused ? 'refused' : `${e.citations.length} cites`}${e.latencyMs ? ' · ' + fmtMs(e.latencyMs.total) : ''} — ${e.text}`;
  if (e.type === 'feedback') return e.rating === 'up' ? 'thumbs up' : e.rating === 'down' ? 'thumbs down' : 'feedback';
  return e.text;
}
function feedItem(item, isNew) {
  const e = item.e;
  const s = S.sessions.get(e.sessionId);
  const surface = s ? s.surface : e.surface;
  return h('li', null, h('button', {
    type: 'button', class: `fitem${isNew ? ' new' : ''}`, 'data-fk': `f:${item.id}`,
    onclick: () => { if (S.sessions.has(e.sessionId)) selectSession(e.sessionId, true); },
  },
    h('span', { class: 'f-time' }, clock(e.ts)),
    h('span', { class: 'f-body' },
      h('span', { class: 'f-top' },
        h('span', { class: `f-type t-${e.type.split('.').pop()}` }, FEED_LABEL[e.type]),
        h('span', { class: `kind kind-${surface.kind}` }, surface.kind),
        e.sim || (s && s.sim) ? simFlag() : null),
      h('span', { class: 'f-text' }, feedText(e)))));
}
function feedVisible(item) {
  const s = S.sessions.get(item.e.sessionId);
  return (!S.filter && !S.botFilter) || (s ? sessionMatches(s) : false);
}
function renderFeed() {
  const el = $('#feed');
  $('#feed-count').textContent = `${S.feed.length} recent`;
  if (S.feedReset || !el.childElementCount) {
    S.feedReset = false;
    el.setAttribute('aria-busy', 'true');
    withFocus(el, () => rc(el, ...S.feed.filter(feedVisible).map((it) => feedItem(it, false))));
    el.setAttribute('aria-busy', 'false');
    return;
  }
  const fresh = S.newFeed.filter(feedVisible);
  if (!fresh.length) return;
  if (fresh.length > 5) el.setAttribute('aria-busy', 'true');
  for (const it of fresh) el.prepend(feedItem(it, true));
  while (el.childElementCount > MAX_FEED) el.lastElementChild.remove();
  el.setAttribute('aria-busy', 'false');
}

/* free-form ask */
function renderAsk() {
  const out = $('#ask-out');
  const a = S.ask;
  if (!a) { rc(out); return; }
  if (a.status === 'pending') { rc(out, h('div', { class: 'ask-q' }, a.bot ? `${botName(a.bot)} · ` : '', 'Q: ', h('b', null, a.question)), h('span', { class: 'pending' }, h('span', { class: 'spinner' }), 'KnowBot is answering with canonical settings…')); return; }
  if (a.status === 'error') { rc(out, h('div', { class: 'ask-q' }, 'Q: ', h('b', null, a.question)), h('div', { class: 'err' }, a.error), h('div', { class: 'note' }, 'Needs the KnowBot server: node knowbot/server/server.mjs')); return; }
  const ans = a.answer;
  rc(out, 
    h('div', { class: 'ask-q' }, a.bot ? `${botName(a.bot)} · ` : '', 'Q: ', h('b', null, a.question)),
    h('div', { class: 'msg-meta' }, answerBadges(ans), latencyView(ans.latencyMs)),
    ...answerBody(ans).flat(),
    engineLabel(ans.engine) ? h('div', { class: 'note mono' }, engineLabel(ans.engine)) : '');
}
async function onAsk(ev) {
  ev.preventDefault();
  const input = $('#ask-input');
  const q = input.value.trim();
  if (!q || (S.ask && S.ask.status === 'pending')) return;
  const bot = S.botFilter && S.botFilter !== S.builtinBot ? S.botFilter : '';
  S.ask = { status: 'pending', question: q, bot }; renderAsk();
  $('#ask-btn').disabled = true;
  try {
    const answer = await postCanonical({ question: q, sessionId: `dashboard-${rid()}`, turnId: `t-${rid()}`, instance: S.botFilter && S.botFilter !== S.builtinBot ? S.botFilter : undefined });
    S.ask = { status: 'done', question: q, answer, bot };
  } catch (err) {
    S.ask = { status: 'error', question: q, bot, error: String(err && err.message || err) };
  }
  $('#ask-btn').disabled = false;
  renderAsk();
}

/* ------------------------------------------------------------------ simulate */
let sim = null;
function toggleSim() {
  if (!sim) {
    const tx = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('knowbot') : null;
    sim = simulator((ev) => { if (tx) tx.postMessage(ev); ingest(ev, 'sim'); }, { onStop: () => { sim = null; syncSimBtn(); } });
    sim.start();
  } else { sim.stop(); sim = null; }
  syncSimBtn();
}
function syncSimBtn() {
  const b = $('#sim-btn');
  const on = !!sim;
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('.sim-label').textContent = on ? 'Simulating — stop' : 'Simulate traffic';
}

/* ------------------------------------------------------------------ theme */
// Light by default; the <head> script already applied the saved choice before first paint.
function syncThemeBtn() {
  const b = $('#theme-btn');
  if (!b) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  b.setAttribute('aria-label', label); b.title = label;
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('knowbot-theme', next); } catch { /* storage blocked: theme lasts this page view */ }
  syncThemeBtn();
}

/* ------------------------------------------------------------------ bots & buckets */
let bots = null;
function setBots(list, builtinId) {
  S.bots = list; S.builtinBot = builtinId;
  if (S.botFilter && !list.some((b) => b.id === S.botFilter)) S.botFilter = '';
  const sel = $('#inst-filter');
  rc(sel, h('option', { value: '' }, 'All bots'), list.map((b) => h('option', { value: b.id }, b.builtin ? `${b.name} (built-in)` : b.name)));
  sel.value = S.botFilter;
  $('#inst-filter-wrap').hidden = list.length < 2;
  $('#ask-input').placeholder = S.botFilter && S.botFilter !== S.builtinBot ? `Ask ${botName(S.botFilter)} (its enabled buckets only)…` : 'Ask anything the knowDrive covers…';
  S.feedReset = true;
  schedule();
}

/* ------------------------------------------------------------------ keyboard */
function onSessionsKey(ev) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
  const btns = [...$('#sessions').querySelectorAll('.srow')];
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  ev.preventDefault();
  const j = ev.key === 'Home' ? 0 : ev.key === 'End' ? btns.length - 1 : Math.max(0, Math.min(btns.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
  btns[j].focus();
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  $('#conn').addEventListener('click', () => { attempts = 0; connect(); });
  $('#sim-btn').addEventListener('click', toggleSim);
  $('#theme-btn')?.addEventListener('click', toggleTheme);
  syncThemeBtn();
  $('#sim-btn-hero').addEventListener('click', toggleSim);
  $('#ask-form').addEventListener('submit', onAsk);
  $('#ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask-form').requestSubmit(); } });
  $('#sessions').addEventListener('keydown', onSessionsKey);
  const auto = $('#auto-canon');
  auto.addEventListener('change', () => {
    S.autoCanon = auto.checked; S.autoCanonSince = Date.now();
    announce(auto.checked ? 'Auto-canonicalize on: every new visitor question gets a canonical answer.' : 'Auto-canonicalize off.');
  });
  bots = mountBots({ S, h, rc, str, num, parseTs, ago, announce, onList: setBots });
  $('#inst-filter').addEventListener('change', (e) => {
    S.botFilter = e.target.value; S.feedReset = true;
    setBots(S.bots, S.builtinBot);
    announce(S.botFilter ? `Showing sessions for ${botName(S.botFilter)}` : 'Showing all bots');
  });
  listenBroadcast();
  renderAll();
  renderMeta();
  setConn('connecting');
  await resolveApi();
  renderMeta();
  connect();
  bots.load();
  setInterval(() => { if (S.sessions.size) { renderKpis(); renderSessions(); } }, 5000);
  if (new URLSearchParams(location.search).get('sim') === '1') toggleSim();
}

// Test hook (read-only snapshot).
window.__knowbotDashboard = { ingest: (e) => ingest(e, 'test'), state: S };
boot();

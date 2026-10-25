// KnowBot bots & buckets panel. Plain ESM, no build, no deps (the ReactFlow canvas loads lazily from flow-canvas.js).
// BUCKET = one knowDrive folder of files. BOT = a chat instance that searches and cites only its ENABLED linked
// buckets — many-to-many: a bucket can feed any number of bots, a bot can draw on any number of buckets.
// Server values are written with textContent only (via h()). The admin token lives in localStorage and is sent
// only as an Authorization header: never logged, never put in a URL.

const TOKEN_KEY = 'knowbot-admin-token';
const MAX_BYTES = 95 * 1024 * 1024; // server MAX_UPLOAD_BYTES (Cloudflare request bodies stop at 100 MB)
const CONCURRENCY = 2;
const POLL_MS = 4000;
const MAX_BATCH = 2000;
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']); // OS litter from folder picks
const ID_RE = /^[a-z0-9-]{1,40}$/;

// Same rule as server/instances.mjs, so placeholders show the id the server will assign.
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
export const fmtBytes = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

/** knowDrive file status → ready | processing | failed. */
export function fileState(f) {
  const s = String(f.status || '').toLowerCase(), p = String(f.phase || '').toLowerCase();
  if (f.error || /fail|error|cancel|reject/.test(s) || /fail|error/.test(p)) return 'failed';
  if (/^(processed|completed|ready|succeeded|done)$/.test(s) || p === 'completed') return 'ready';
  return 'processing';
}
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

/**
 * @param {{ S: object, h: Function, rc: Function, str: Function, num: Function, parseTs: Function, ago: Function,
 *           announce: Function, onList: Function }} ctx  helpers and state from dashboard.js
 */
export function mountBots(ctx) {
  const { S, h, rc, str, num, parseTs, ago, announce, onList } = ctx;
  const $ = (s, r = document) => r.querySelector(s);
  const G = { bots: [], buckets: [], canManage: false, loaded: false, error: '', counts: new Map(), version: 0 };
  const I = { token: readToken(), auth: 'unknown', authMsg: '', open: false, opener: null, view: 'overview', id: null,
    files: null, filesError: '', queue: [], running: 0, sheet: true };
  let pollTimer = 0, paintRaf = 0, canvas = null, canvasErr = '', toastTimer = 0;

  /* ---------------------------------------------------------------- token + api */
  function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function saveToken(v) {
    I.token = v;
    try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: token lasts this page view */ }
  }
  function noteAuth(status, msg) {
    if (status === 401) { I.auth = 'bad'; I.authMsg = I.token ? 'The server rejected this admin token.' : 'This server needs an admin token.'; }
    else if (status === 403 && /admin|disabled/i.test(msg)) { I.auth = 'off'; I.authMsg = msg; }
    else return;
    paintToken(); refresh();
  }
  function authOk() { if (I.auth !== 'ok') { I.auth = 'ok'; I.authMsg = ''; paintToken(); refresh(); } }
  const errMsg = (j, status) => str(j && j.error && (j.error.message || j.error), 400) || `Server answered ${status}`;
  const loopback = () => /^https?:\/\/(localhost|127\.|\[::1\])/.test(S.apiBase);
  const editable = () => G.canManage && I.auth !== 'bad' && I.auth !== 'off' && (!!I.token || loopback() || I.auth === 'ok');

  async function api(path, { method = 'GET', json, admin = true, timeout = 30000 } = {}) {
    const headers = {};
    if (admin && I.token) headers.authorization = `Bearer ${I.token}`;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    let r;
    try { r = await fetch(`${S.apiBase}${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: ctl.signal }); }
    catch (e) { throw new ApiError(0, e && e.name === 'AbortError' ? 'Timed out waiting for the server' : `KnowBot server unreachable at ${S.apiBase}`); }
    finally { clearTimeout(t); }
    let j = null; try { j = await r.json(); } catch { /* empty or not JSON */ }
    if (!r.ok) { const m = errMsg(j, r.status); if (admin) noteAuth(r.status, m); throw new ApiError(r.status, m); }
    if (admin) authOk();
    return j;
  }

  /** One file per request, raw bytes (not multipart); XHR for upload progress. */
  function uploadOne(item) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${S.apiBase}/api/buckets/${encodeURIComponent(item.bucket)}/files`);
      x.setRequestHeader('content-type', item.file.type || 'application/octet-stream');
      x.setRequestHeader('x-filename', encodeURIComponent(item.rel));
      if (I.token) x.setRequestHeader('authorization', `Bearer ${I.token}`);
      x.timeout = 15 * 60 * 1000;
      x.upload.onprogress = (e) => { if (e.lengthComputable) { item.pct = e.loaded / e.total; paint(); } };
      x.onload = () => {
        let j = null; try { j = JSON.parse(x.responseText); } catch { /* not JSON */ }
        if (x.status >= 200 && x.status < 300) { authOk(); resolve(j || {}); return; }
        const m = x.status === 413 ? 'Larger than the 95 MB upload limit' : errMsg(j, x.status);
        noteAuth(x.status, m); reject(new ApiError(x.status, m));
      };
      x.onerror = () => reject(new ApiError(0, `Upload failed — KnowBot server unreachable at ${S.apiBase}`));
      x.ontimeout = () => reject(new ApiError(0, 'Upload timed out'));
      x.send(item.file);
    });
  }

  /* ---------------------------------------------------------------- data */
  const bot = (id) => G.bots.find((x) => x.id === id) || null;
  const bucket = (id) => G.buckets.find((x) => x.id === id) || null;
  const builtinId = () => (G.bots.find((x) => x.builtin) || {}).id || 'ugm';
  const feeds = (bucketId) => G.bots.filter((b) => b.buckets.some((l) => l.id === bucketId));
  function normLinks(arr) {
    const seen = new Set();
    return (Array.isArray(arr) ? arr : []).map((l) => (typeof l === 'string' ? { id: l, enabled: true } : l))
      .filter((l) => l && ID_RE.test(String(l.id || '')) && !seen.has(l.id) && seen.add(l.id)).map((l) => ({ id: l.id, enabled: l.enabled !== false }));
  }
  function normBot(x) {
    if (!x || typeof x !== 'object' || !ID_RE.test(String(x.id || ''))) return null;
    return {
      id: x.id, name: str(x.name, 80) || x.id, org: str(x.org, 80), botName: str(x.botName, 80), greeting: str(x.greeting, 300),
      starters: Array.isArray(x.starters) ? x.starters.map((s) => str(s, 120)).filter(Boolean).slice(0, 6) : [],
      guards: x.guards === 'store' ? 'store' : 'general', minSimilarity: num(x.minSimilarity), builtin: x.builtin === true,
      buckets: normLinks(x.buckets), updatedAt: x.updatedAt ? parseTs(x.updatedAt) : null,
    };
  }
  function normBucket(x) {
    if (!x || typeof x !== 'object' || !ID_RE.test(String(x.id || ''))) return null;
    return { id: x.id, name: str(x.name, 80) || x.id, folder: str(x.folder, 300), builtin: x.builtin === true, updatedAt: x.updatedAt ? parseTs(x.updatedAt) : null };
  }
  function normFile(f) {
    if (!f || typeof f !== 'object') return null;
    const o = { id: str(f.id, 200), path: str(f.path, 400), bytes: num(f.bytes), status: str(f.status, 40), phase: str(f.phase, 40),
      mime: str(f.mime, 120), atoms: num(f.atoms), error: str(f.error, 400) };
    o.state = fileState(o);
    return o.id ? o : null;
  }
  const countOf = (files) => ({ n: files.length, processing: files.filter((f) => f.state === 'processing').length, failed: files.filter((f) => f.state === 'failed').length });

  async function load() {
    try {
      const j = await api('/api/graph', { admin: false, timeout: 15000 });
      G.bots = (Array.isArray(j && j.bots) ? j.bots : []).map(normBot).filter(Boolean);
      G.buckets = (Array.isArray(j && j.buckets) ? j.buckets : []).map(normBucket).filter(Boolean);
      G.canManage = !!(j && j.canManage); G.error = '';
    } catch (e) { G.error = e.status === 404 ? 'This KnowBot server has no bots & buckets API (GET /api/graph). Update the server.' : e.message; }
    G.loaded = true; G.version++;
    onList(G.bots, builtinId());
    if (!I.open) return;
    if ((I.view === 'bucket' && !bucket(I.id)) || (I.view === 'bot' && !bot(I.id))) I.view = 'overview';
    if (I.view === 'overview') render(); else paintLinks();
    refresh();
    loadCounts();
  }
  async function loadCounts() {
    if (!G.canManage) return;
    await Promise.all(G.buckets.filter((b) => !b.builtin).map(async (b) => {
      try { const j = await api(`/api/buckets/${encodeURIComponent(b.id)}/files`); G.counts.set(b.id, countOf((j.files || []).map(normFile).filter(Boolean))); }
      catch { G.counts.delete(b.id); }
    }));
    G.version++; refresh();
  }
  async function loadFiles() {
    const id = I.id;
    try {
      const j = await api(`/api/buckets/${encodeURIComponent(id)}/files`);
      if (I.id !== id) return;
      I.files = (Array.isArray(j && j.files) ? j.files : []).map(normFile).filter(Boolean);
      I.filesError = ''; G.counts.set(id, countOf(I.files)); G.version++;
      const map = new Map(I.files.map((f) => [f.id, f]));
      for (const q of I.queue) {
        if (q.bucket !== id || q.state !== 'processing' || !q.fileId) continue;
        const f = map.get(q.fileId);
        if (f && f.state !== 'processing') { q.state = f.state; q.msg = f.error || ''; announce(`${q.rel} ${f.state === 'ready' ? 'is ready' : 'failed: ' + (f.error || 'processing failed')}`); }
      }
    } catch (e) { if (I.id === id) I.filesError = e.message; }
    if (I.open && I.view === 'bucket' && I.id === id) { paintFiles(); paintQueue(); }
    refresh();
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!I.open || I.view !== 'bucket' || I.filesError) return;
    const busy = (I.files || []).some((f) => f.state === 'processing') || I.queue.some((q) => q.bucket === I.id && q.state === 'processing');
    if (busy) pollTimer = setTimeout(loadFiles, POLL_MS);
  }

  /* ---------------------------------------------------------------- links (bot → buckets) */
  const chains = new Map();
  // Optimistic: the canvas updates at once; PATCHes for one bot run in order; a failure reloads the true graph.
  function setLinks(botId, next, what) {
    const b = bot(botId);
    if (!b || !editable()) return;
    b.buckets = normLinks(next); G.version++; refresh();
    const body = b.buckets.map((l) => ({ id: l.id, enabled: l.enabled }));
    const run = (chains.get(botId) || Promise.resolve()).then(async () => {
      try { await api(`/api/instances/${encodeURIComponent(botId)}`, { method: 'PATCH', json: { buckets: body } }); announce(what); }
      catch (e) { toast(`Couldn’t update ${b.name}: ${e.message}`, true); await load(); }
    });
    chains.set(botId, run);
  }
  function link(botId, bucketId) {
    const b = bot(botId), k = bucket(bucketId);
    if (!b || !k) return;
    if (b.buckets.some((l) => l.id === bucketId)) { toast(`${k.name} already feeds ${b.name}`); return; } // duplicates are ignored
    setLinks(botId, [...b.buckets, { id: bucketId, enabled: true }], `Linked ${k.name} to ${b.name}`);
  }
  function toggle(botId, bucketId) {
    const b = bot(botId), k = bucket(bucketId);
    const l = b && b.buckets.find((x) => x.id === bucketId);
    if (!l) return;
    setLinks(botId, b.buckets.map((x) => (x.id === bucketId ? { ...x, enabled: !x.enabled } : x)), `${k ? k.name : bucketId} ${l.enabled ? 'off' : 'on'} for ${b.name}`);
  }
  function unlink(botId, bucketId) {
    const b = bot(botId), k = bucket(bucketId);
    if (!b) return;
    setLinks(botId, b.buckets.filter((x) => x.id !== bucketId), `Unlinked ${k ? k.name : bucketId} from ${b.name}`);
  }

  /* ---------------------------------------------------------------- uploads */
  function enqueue(entries) {
    const k = bucket(I.id);
    if (!k || k.builtin || !editable()) return;
    let n = 0;
    for (const { file, rel } of entries.slice(0, MAX_BATCH)) {
      if (SKIP.has(rel.split('/').pop())) continue;
      const q = { key: Math.random().toString(36).slice(2, 10), bucket: k.id, file, rel: rel.replace(/^\/+/, ''), state: 'queued', pct: 0, msg: '', fileId: '' };
      if (file.size > MAX_BYTES) { q.state = 'failed'; q.msg = `${fmtBytes(file.size)} is over the 95 MB per-file limit`; }
      else if (!file.size) { q.state = 'failed'; q.msg = 'Empty file'; }
      I.queue.push(q); n++;
    }
    if (entries.length > MAX_BATCH) announce(`Only the first ${MAX_BATCH} files were queued.`);
    if (n) announce(`${n} file${n === 1 ? '' : 's'} queued for ${k.folder}`);
    paintQueue(); pump();
  }
  function pump() {
    while (I.running < CONCURRENCY) {
      const q = I.queue.find((x) => x.state === 'queued');
      if (!q) break;
      I.running++; q.state = 'uploading'; q.pct = 0; paint();
      uploadOne(q).then((r) => {
        q.fileId = str(r.id, 200);
        q.state = fileState({ status: r.status }) === 'ready' ? 'ready' : 'processing';
      }, (e) => {
        q.state = 'failed'; q.msg = e.message;
        if (e.status === 401 || (e.status === 403 && I.auth === 'off')) for (const x of I.queue) if (x.state === 'queued') { x.state = 'failed'; x.msg = 'Not uploaded — admin access needed'; }
      }).finally(() => {
        I.running--; paint();
        if (q.bucket === I.id && I.open && I.view === 'bucket') {
          const left = I.queue.some((x) => x.bucket === q.bucket && (x.state === 'queued' || x.state === 'uploading'));
          clearTimeout(pollTimer); pollTimer = setTimeout(loadFiles, left ? 1500 : 0);
        }
        pump();
      });
    }
  }
  // Folders dropped onto the zone keep their sub-folders (webkitGetAsEntry), like the folder picker does.
  async function dropped(dt) {
    const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (!entries.length || entries.some((e) => !e)) return [...(dt.files || [])].map((f) => ({ file: f, rel: f.name }));
    const out = [];
    const walk = async (entry, prefix) => {
      if (out.length >= MAX_BATCH) return;
      if (entry.isFile) { const f = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file: f, rel: prefix + f.name }); return; }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }
  const picked = (input) => [...(input.files || [])].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));

  /* ---------------------------------------------------------------- links out */
  function chatUrl(id) {
    const u = new URL('../demo/chat.html', location.href);
    u.searchParams.set('instance', id);
    if (S.apiFromParam && S.apiBase) u.searchParams.set('api', S.apiBase);
    return u.href;
  }
  // embed.js is an ES module (it imports widget.js), so the tag needs type="module" (modules are deferred already).
  function embedCode(id) {
    const site = `${location.origin}${location.pathname.replace(/\/dashboard(?:\/.*)?$/, '/')}`.replace(/\/?$/, '/');
    return `<script type="module" src="${site}lib/embed.js" data-instance="${id}" data-api="${S.apiBase}"></script>`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
    const ta = h('textarea', { class: 'sr-only', readonly: true }); ta.value = text;
    $('#flow-panel').append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
    ta.remove();
    return ok;
  }

  /* ---------------------------------------------------------------- overlay */
  const drawer = $('#flow-drawer'), panel = $('#flow-panel'), side = $('#flow-side-body');
  function open(opener) {
    if (I.open) return;
    I.open = true; I.opener = opener || document.activeElement;
    drawer.hidden = false; document.body.classList.add('drawer-open');
    for (const el of document.body.children) if (el !== drawer && el.id !== 'sr-status') el.inert = true;
    $('#flow-btn').setAttribute('aria-expanded', 'true');
    paintToken(); render(); syncSheet();
    $('#flow-title').focus();
    ensureCanvas();
    load();
  }
  function close() {
    if (!I.open) return;
    I.open = false; clearTimeout(pollTimer);
    drawer.hidden = true; document.body.classList.remove('drawer-open');
    for (const el of document.body.children) el.inert = false;
    $('#flow-btn').setAttribute('aria-expanded', 'false');
    const o = I.opener; I.opener = null;
    if (o && o.isConnected) o.focus();
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    const f = [...panel.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]')]
      .filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  function go(view, id = null) {
    I.view = view; I.id = id;
    clearTimeout(pollTimer);
    if (view === 'bucket') { I.files = null; I.filesError = ''; }
    I.sheet = true; syncSheet();
    render();
    side.scrollTop = 0;
    const t = side.querySelector('[data-autofocus]'); if (t) t.focus({ preventScroll: true });
    if (view === 'bucket' && !bucket(id).builtin && G.canManage) loadFiles();
    refresh();
  }
  function syncSheet() {
    $('#flow-side').classList.toggle('collapsed', !I.sheet);
    const b = $('#flow-sheet-btn');
    b.setAttribute('aria-expanded', String(I.sheet));
    rc(b, I.sheet ? 'Hide details ▾' : 'Show details ▴');
  }

  function toast(msg, bad = false) {
    const el = $('#flow-toast');
    el.dataset.state = bad ? 'bad' : 'ok';
    rc(el, msg); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3000);
    announce(msg);
  }

  function paintToken() {
    const st = $('#flow-token-status'), input = $('#flow-token');
    if (document.activeElement !== input) input.value = I.token;
    $('#flow-token-forget').hidden = !I.token;
    st.dataset.state = I.auth;
    rc(st, I.auth === 'bad' || I.auth === 'off' ? I.authMsg
      : I.auth === 'ok' ? (I.token ? 'Token accepted' : 'Admin access (local server)')
      : I.token ? 'Saved in this browser' : loopback() ? 'Local server: no token needed' : 'Add a token to edit');
  }
  function hint() {
    if (!G.loaded) return 'Loading…';
    if (G.error) return '';
    if (!G.canManage) return 'Read-only — this server has no knowDrive key, so buckets and links can’t be changed here.';
    if (I.auth === 'bad' || I.auth === 'off') return `Read-only — ${I.authMsg}`;
    if (!editable()) return 'Read-only — add the admin token above to link, toggle, upload and edit.';
    return 'Drag from a bucket’s handle to a bot to link it. Click on/off on a link to toggle it; × or Delete unlinks.';
  }

  /* ---------------------------------------------------------------- canvas */
  async function ensureCanvas() {
    if (canvas || canvasErr === 'loading') return;
    canvasErr = 'loading'; paintCanvasState();
    if (!document.querySelector('link[data-flow-css]')) {
      const { FLOW_CSS } = await import('./flow-canvas.js').catch(() => ({ FLOW_CSS: null }));
      if (FLOW_CSS) document.head.insertBefore(h('link', { rel: 'stylesheet', href: FLOW_CSS, 'data-flow-css': '' }), document.querySelector('link[href="./bots.css"]'));
    }
    try {
      const { createCanvas } = await import('./flow-canvas.js');
      const el = $('#flow-canvas'); rc(el);
      canvas = await createCanvas(el);
      canvasErr = '';
    } catch (e) {
      canvasErr = `The canvas library (ReactFlow from esm.sh) didn’t load: ${str(e && e.message, 200) || 'network error'}. Everything still works from the lists in the details panel.`;
    }
    paintCanvasState(); refresh();
  }
  function paintCanvasState() {
    const el = $('#flow-canvas');
    if (canvas) return;
    rc(el, h('div', { class: 'flow-canvas-msg' }, canvasErr === 'loading' ? [h('span', { class: 'spinner' }), ' Loading canvas…'] : canvasErr ? h('span', { class: 'err' }, canvasErr) : null));
  }
  const colorMode = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  function refresh() {
    if (!I.open) return;
    rc($('#flow-hint'), hint());
    $('#flow-add-bucket').disabled = !editable(); $('#flow-add-bot').disabled = !editable();
    if (canvas) {
      canvas.render({
        buckets: G.buckets, bots: G.bots, counts: G.counts, canCount: G.canManage && editable(), editable: editable(), colorMode: colorMode(),
        active: I.view === 'bucket' || I.view === 'bot' ? `${I.view}:${I.id}` : null, version: G.version,
        onSelect: (kind, id) => { if (!kind) { if (I.view === 'bucket' || I.view === 'bot') go('overview'); return; } go(kind, id); },
        onLink: link, onToggle: toggle, onUnlink: unlink,
      });
    }
    if (I.view === 'overview') paintOverview();
    paintLinks();
  }

  /* ---------------------------------------------------------------- side panel */
  function keepFocus(container, fn) {
    const a = document.activeElement;
    const fk = a && container.contains(a) ? a.dataset.fk : null;
    fn();
    if (fk) { const n = container.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (n) n.focus({ preventScroll: true }); }
  }
  function paint() { if (!paintRaf) paintRaf = requestAnimationFrame(() => { paintRaf = 0; paintQueue(); }); }
  function render() {
    if (!I.open) return;
    keepFocus(side, () => {
      if (I.view === 'bucket' && bucket(I.id)) rc(side, bucketView(bucket(I.id)));
      else if (I.view === 'bot' && bot(I.id)) rc(side, botView(bot(I.id)));
      else if (I.view === 'new-bucket') rc(side, bucketForm());
      else if (I.view === 'new-bot') rc(side, botForm(null));
      else { I.view = 'overview'; rc(side, h('div', { id: 'flow-overview' })); paintOverview(); }
    });
  }
  const kicker = (t, ...more) => h('div', { class: 'mono kicker flow-kicker' }, t, ...more);
  const back = () => h('button', { type: 'button', class: 'btn btn-ghost btn-sm flow-back', 'data-fk': 'back', onclick: () => go('overview') }, '← Overview');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function filesLabel(k) {
    if (k.builtin) return 'synced corpus';
    const c = G.counts.get(k.id);
    if (!c) return '';
    return `${plural(c.n, 'file')}${c.processing ? ` · ${c.processing} processing` : ''}${c.failed ? ` · ${c.failed} failed` : ''}`;
  }

  function paintOverview() {
    const el = $('#flow-overview');
    if (!el) return;
    keepFocus(el, () => {
      if (!G.loaded) { rc(el, h('p', { class: 'pending' }, h('span', { class: 'spinner' }), 'Loading bots and buckets…')); return; }
      if (G.error) { rc(el, h('div', { class: 'inst-alert bad', role: 'alert' }, G.error)); return; }
      rc(el,
        h('p', { class: 'flow-lede' }, 'A ', h('b', null, 'bucket'), ' is one knowDrive folder of files. A ', h('b', null, 'bot'), ' answers and cites only from its ', h('b', null, 'enabled'),
          ' buckets — one bucket can feed many bots, and a bot can draw on many buckets. Nothing outside them is searched.'),
        h('h3', { class: 'inst-sub' }, `Buckets · ${G.buckets.length}`),
        h('ul', { class: 'flow-list', 'aria-label': 'Buckets' }, G.buckets.map((k) => {
          const n = feeds(k.id);
          return h('li', null, h('button', { type: 'button', class: 'flow-item', 'data-fk': `bk:${k.id}`, onclick: () => go('bucket', k.id) },
            h('span', { class: 'flow-item-top' }, h('span', { class: 'inst-name' }, k.name), k.builtin ? h('span', { class: 'flag flag-inst' }, 'built-in') : null),
            h('span', { class: 'inst-card-meta mono' }, h('span', null, k.folder), filesLabel(k) ? h('span', null, filesLabel(k)) : null, h('span', null, `feeds ${plural(n.length, 'bot')}`))));
        })),
        h('h3', { class: 'inst-sub' }, `Bots · ${G.bots.length}`),
        h('ul', { class: 'flow-list', 'aria-label': 'Bots' }, G.bots.map((b) => {
          const on = b.buckets.filter((l) => l.enabled).length;
          return h('li', null, h('button', { type: 'button', class: 'flow-item', 'data-fk': `bt:${b.id}`, onclick: () => go('bot', b.id) },
            h('span', { class: 'flow-item-top' }, h('span', { class: 'inst-name' }, b.name), b.builtin ? h('span', { class: 'flag flag-inst' }, 'built-in') : null),
            h('span', { class: 'inst-card-meta mono' }, h('span', null, b.id),
              h('span', { class: on ? null : 'warn' }, on ? `${plural(on, 'bucket')} on` : 'no enabled buckets'),
              b.buckets.length > on ? h('span', null, `${b.buckets.length - on} off`) : null)));
        })));
    });
  }

  // Link rows: shared by both details views (bot → its buckets, bucket → its bots). Repainted alone so forms keep edits.
  function paintLinks() {
    const el = I.open && $('#flow-links');
    if (!el) return;
    const ed = editable();
    const isBot = I.view === 'bot';
    const rows = isBot ? (bot(I.id) || { buckets: [] }).buckets.map((l) => ({ l, b: bot(I.id), k: bucket(l.id) })).filter((r) => r.k)
      : feeds(I.id).map((b) => ({ b, k: bucket(I.id), l: b.buckets.find((x) => x.id === I.id) }));
    const others = isBot ? G.buckets.filter((k) => !rows.some((r) => r.k.id === k.id)) : G.bots.filter((b) => !rows.some((r) => r.b.id === b.id));
    const sel = h('select', { 'aria-label': isBot ? 'Bucket to link' : 'Bot to link', 'data-fk': 'link-sel' },
      others.map((x) => h('option', { value: x.id }, isBot ? `${x.name} (${x.folder})` : `${x.name} (${x.id})`)));
    keepFocus(el, () => rc(el,
      h('div', { class: 'inst-files-head' }, h('h4', { class: 'inst-sub', id: 'flow-links-h' }, isBot ? 'Buckets feeding this bot' : 'Bots this bucket feeds'),
        h('span', { class: 'panel-count mono' }, `${rows.filter((r) => r.l.enabled).length} on · ${rows.length} linked`)),
      rows.length ? h('ul', { class: 'flow-links', 'aria-labelledby': 'flow-links-h' }, rows.map(({ l, b, k }) => h('li', { class: `flow-link${l.enabled ? ' on' : ' off'}` },
        h('span', { class: 'flow-link-name' }, h('b', null, isBot ? k.name : b.name), h('span', { class: 'mono' }, isBot ? k.folder : b.id)),
        h('button', { type: 'button', class: 'flow-switch', role: 'switch', 'aria-checked': String(l.enabled), disabled: !ed, 'data-fk': `tg:${b.id}:${k.id}`,
          'aria-label': `${k.name} feeding ${b.name}`, onclick: () => toggle(b.id, k.id) },
          h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })), h('span', null, l.enabled ? 'on' : 'off')),
        ed ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': `ul:${b.id}:${k.id}`, 'aria-label': `Unlink ${k.name} from ${b.name}`, onclick: () => unlink(b.id, k.id) }, 'Unlink') : null)))
        : h('p', { class: 'note' }, isBot ? 'No buckets linked — this bot answers “I don’t know” to everything.' : 'Not linked to any bot yet.'),
      ed && others.length ? h('form', { class: 'flow-link-add', onsubmit: (ev) => { ev.preventDefault(); if (isBot) link(I.id, sel.value); else link(sel.value, I.id); } },
        sel, h('button', { type: 'submit', class: 'btn btn-sm', 'data-fk': 'link-add' }, isBot ? 'Link bucket' : 'Link to bot')) : null));
    if (isBot) paintScope();
  }
  function paintScope() {
    const el = $('#flow-scope'), b = bot(I.id);
    if (!el || !b) return;
    const on = b.buckets.filter((l) => l.enabled).map((l) => bucket(l.id)).filter(Boolean);
    rc(el, on.length
      ? h('p', { class: 'inst-scope' }, h('span', null, 'Answers come only from ', on.map((k, i) => [i ? ', ' : '', h('b', { class: 'mono' }, k.folder)]), ' — nothing outside these folders is searched or cited.'))
      : h('p', { class: 'inst-scope warn' }, h('span', null, 'No enabled buckets: this bot searches nothing and answers “I don’t know” to every question.')));
  }

  function field(label, input, help, id) {
    return h('div', { class: 'inst-field' }, h('label', { for: id }, label), input, help ? h('span', { class: 'inst-help', id: `${id}-help` }, help) : null);
  }
  const errBox = () => h('div', { class: 'inst-alert bad', role: 'alert', hidden: true, tabindex: -1 });
  function fail(err, msg, focus) { rc(err, msg); err.hidden = false; (focus || err).focus(); }

  function bucketForm() {
    const err = errBox();
    const idNote = h('span', { class: 'inst-help mono', id: 'bf-name-help' });
    const name = h('input', { id: 'bf-name', required: true, maxlength: 80, autocomplete: 'off', 'aria-describedby': 'bf-name-help', 'data-autofocus': true });
    const folder = h('input', { id: 'bf-folder', maxlength: 300, autocomplete: 'off', spellcheck: 'false', class: 'mono', 'aria-describedby': 'bf-folder-help' });
    const sync = () => { const s = slugify(name.value); folder.placeholder = `knowbot/${s || '<id>'}/`; rc(idNote, s ? `id ${s}` : 'id is derived from the name'); };
    name.addEventListener('input', sync); sync();
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create bucket');
    const onSubmit = async (ev) => {
      ev.preventDefault(); err.hidden = true;
      const nm = name.value.trim();
      if (!nm) return fail(err, 'Name is required.', name);
      const body = { name: nm }; if (folder.value.trim()) body.folder = folder.value.trim();
      save.disabled = true; rc(save, 'Creating…');
      try {
        const r = normBucket(await api('/api/buckets', { method: 'POST', json: body }));
        announce(`Created bucket ${r.name} for ${r.folder}`);
        await load(); go('bucket', r.id);
      } catch (e) { save.disabled = false; rc(save, 'Create bucket'); fail(err, e.message); }
    };
    return h('div', { class: 'flow-view' }, back(), kicker('New bucket'), h('h3', { class: 'display inst-h' }, 'Create a bucket'),
      h('form', { class: 'inst-form', novalidate: true, onsubmit: onSubmit },
        field('Name', name, null, 'bf-name'), idNote,
        field('Folder', folder, 'Optional. The knowDrive folder that holds this bucket’s files.', 'bf-folder'),
        err, h('div', { class: 'inst-actions' }, save, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => go('overview') }, 'Cancel'))));
  }

  function bucketView(k) {
    const ed = editable();
    const n = feeds(k.id).length;
    const kids = [back(),
      kicker('Bucket', k.builtin ? h('span', { class: 'flag flag-inst' }, 'built-in') : null),
      h('h3', { class: 'display inst-h', tabindex: -1, 'data-autofocus': true }, k.name),
      h('div', { class: 'inst-card-meta mono' }, h('span', null, `id ${k.id}`), h('span', null, `feeds ${plural(n, 'bot')}`), k.updatedAt ? h('span', null, `updated ${ago(k.updatedAt)}`) : null),
      h('p', { class: 'inst-scope' }, h('span', null, 'Files in ', h('b', { class: 'mono' }, k.folder), '. Bots cite them only while their link to this bucket is on.')),
      h('section', { id: 'flow-links', class: 'flow-sec' })];
    if (k.builtin) {
      kids.push(h('div', { class: 'inst-alert' }, 'The built-in bucket is read-only: its files are managed by the corpus sync script. You can still link it to bots, or turn it off for them.'));
      return h('div', { class: 'flow-view' }, kids);
    }
    if (ed) {
      const nm = h('input', { id: 'bk-name', maxlength: 80, autocomplete: 'off', 'data-fk': 'rename' }); nm.value = k.name;
      const err = errBox();
      kids.push(h('form', { class: 'flow-rename', onsubmit: async (ev) => {
        ev.preventDefault(); err.hidden = true;
        const v = nm.value.trim(); if (!v) return fail(err, 'Name is required.', nm);
        if (v === k.name) return;
        try { await api(`/api/buckets/${encodeURIComponent(k.id)}`, { method: 'PATCH', json: { name: v } }); toast(`Renamed to ${v}`); await load(); render(); }
        catch (e) { fail(err, e.message); }
      } }, field('Bucket name', nm, null, 'bk-name'), h('button', { type: 'submit', class: 'btn btn-sm' }, 'Rename'), err));
    }
    if (!G.canManage) { kids.push(h('div', { class: 'inst-alert' }, hint())); return h('div', { class: 'flow-view' }, kids); }
    if (ed) kids.push(dropZone(k), h('div', { id: 'inst-queue' }));
    kids.push(h('section', { class: 'inst-files', 'aria-labelledby': 'inst-files-h' },
      h('div', { class: 'inst-files-head' }, h('h4', { id: 'inst-files-h', class: 'inst-sub', tabindex: -1 }, 'Files'), h('span', { class: 'panel-count mono', id: 'inst-files-count' }),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'refresh', onclick: () => loadFiles() }, 'Refresh')),
      h('div', { id: 'inst-files' })));
    if (ed) kids.push(h('div', { class: 'flow-danger' }, h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => deleteBucket(k) }, 'Delete bucket')));
    const view = h('div', { class: 'flow-view' }, kids);
    queueMicrotask(() => { paintLinks(); paintFiles(); paintQueue(); });
    return view;
  }

  function dropZone(k) {
    const files = h('input', { type: 'file', multiple: true, class: 'sr-only', tabindex: -1, 'aria-hidden': 'true' });
    const dir = h('input', { type: 'file', multiple: true, webkitdirectory: true, class: 'sr-only', tabindex: -1, 'aria-hidden': 'true' });
    files.addEventListener('change', () => { enqueue(picked(files)); files.value = ''; });
    dir.addEventListener('change', () => { enqueue(picked(dir)); dir.value = ''; });
    const zone = h('div', { class: 'inst-drop', role: 'group', 'aria-label': `Upload files into ${k.folder}` },
      h('div', { class: 'inst-drop-title' }, 'Drop files or folders here'),
      h('div', { class: 'inst-help' }, `Any type knowDrive accepts — documents, PDFs, slides, sheets, images, audio — up to 95 MB each. Sub-folders are kept under ${k.folder}`),
      h('div', { class: 'inst-actions' },
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-fk': 'pick-files', onclick: () => files.click() }, 'Choose files'),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-fk': 'pick-dir', onclick: () => dir.click() }, 'Choose folder')),
      files, dir);
    let depth = 0;
    zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('over'); });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } });
    zone.addEventListener('drop', async (e) => { e.preventDefault(); depth = 0; zone.classList.remove('over'); if (e.dataTransfer) enqueue(await dropped(e.dataTransfer)); });
    return zone;
  }

  const Q_BADGE = { queued: '', uploading: 'badge-accent', processing: 'badge-warn', ready: 'badge-good', failed: 'badge-bad' };
  function paintQueue() {
    const el = I.open && $('#inst-queue');
    if (!el) return;
    const rows = I.queue.filter((q) => q.bucket === I.id);
    if (!rows.length) { rc(el); return; }
    const done = rows.filter((q) => q.state === 'ready' || q.state === 'failed').length;
    keepFocus(el, () => rc(el, h('section', { class: 'inst-queue', 'aria-label': 'Uploads' },
      h('div', { class: 'inst-files-head' }, h('h4', { class: 'inst-sub' }, 'Uploads'), h('span', { class: 'panel-count mono' }, `${done}/${rows.length} done`),
        done ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'clear', onclick: () => { I.queue = I.queue.filter((q) => q.bucket !== I.id || !(q.state === 'ready' || q.state === 'failed')); paintQueue(); } }, 'Clear finished') : null),
      h('ul', { class: 'inst-q' }, rows.map((q) => h('li', { class: `inst-q-row q-${q.state}` },
        h('span', { class: 'inst-q-path mono' }, q.rel),
        h('span', { class: 'inst-q-meta' },
          h('span', { class: `badge ${Q_BADGE[q.state]}` }, q.state === 'uploading' ? `uploading ${Math.round(q.pct * 100)}%` : q.state),
          h('span', { class: 'mono' }, fmtBytes(q.file.size))),
        q.state === 'uploading' ? h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round(q.pct * 100)}%` } })) : null,
        q.msg ? h('span', { class: 'err inst-q-msg' }, q.msg) : null))))));
  }

  const F_BADGE = { ready: 'badge-good', processing: 'badge-warn', failed: 'badge-bad' };
  function paintFiles() {
    const el = I.open && $('#inst-files');
    if (!el) return;
    const count = $('#inst-files-count');
    if (I.filesError) { rc(count); rc(el, h('div', { class: 'inst-alert bad', role: 'alert' }, I.filesError)); return; }
    if (!I.files) { rc(count); rc(el, h('p', { class: 'pending' }, h('span', { class: 'spinner' }), 'Loading files…')); return; }
    const proc = I.files.filter((f) => f.state === 'processing').length;
    rc(count, `${plural(I.files.length, 'file')}${proc ? ` · ${proc} processing` : ''}`);
    if (!I.files.length) { rc(el, h('p', { class: 'note' }, 'No files yet — bots linked to this bucket find nothing in it.')); return; }
    const ed = editable();
    keepFocus(el, () => rc(el, h('ul', { class: 'inst-ftable', 'aria-label': 'Files' }, I.files.map((f) => h('li', { class: 'inst-frow' },
      h('span', { class: 'inst-f-path mono', title: f.path }, f.path),
      h('span', { class: 'inst-f-meta' },
        h('span', { class: `badge ${F_BADGE[f.state]}`, title: [f.status, f.phase].filter(Boolean).join(' · ') }, f.state === 'processing' ? (f.phase || f.status || 'processing') : f.state),
        h('span', { class: 'mono' }, fmtBytes(f.bytes)),
        f.mime ? h('span', { class: 'mono inst-f-mime' }, f.mime) : null,
        f.atoms != null && f.state === 'ready' ? h('span', { class: 'mono' }, plural(f.atoms, 'atom')) : null),
      ed ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm inst-f-del', 'data-fk': `del:${f.id}`, 'aria-label': `Delete ${f.path}`, onclick: () => deleteFile(f) }, 'Delete') : null,
      f.error ? h('span', { class: 'err inst-q-msg' }, f.error) : null)))));
  }

  function botForm(b) {
    const edit = !!b, ro = !!(b && b.builtin) || !editable();
    const v = b || { name: '', org: '', botName: '', greeting: '', starters: [], guards: 'general', minSimilarity: null };
    const err = errBox();
    const idNote = h('span', { class: 'inst-help mono', id: 'if-name-help' });
    const name = h('input', { id: 'if-name', required: true, maxlength: 80, autocomplete: 'off', 'aria-describedby': 'if-name-help', 'data-autofocus': !edit || null });
    name.value = v.name;
    const sync = () => { const s = slugify(name.value); rc(idNote, edit ? `id ${b.id} (fixed)` : s ? `id ${s} · chat link ?instance=${s}` : 'id is derived from the name'); };
    name.addEventListener('input', sync); sync();
    const org = h('input', { id: 'if-org', maxlength: 80, autocomplete: 'organization' }); org.value = v.org || '';
    const bn = h('input', { id: 'if-bot', maxlength: 80, autocomplete: 'off', placeholder: 'KnowBot' }); bn.value = v.botName || '';
    const greet = h('textarea', { id: 'if-greet', rows: 2, maxlength: 300, placeholder: 'Hi! Ask me anything about …' }); greet.value = v.greeting || '';
    const starters = [0, 1, 2, 3, 4, 5].map((i) => { const x = h('input', { maxlength: 120, autocomplete: 'off', 'aria-label': `Starter question ${i + 1}`, placeholder: `Starter question ${i + 1}` }); x.value = v.starters[i] || ''; return x; });
    const floor = h('input', { id: 'if-floor', type: 'number', min: 0, max: 0.99, step: 0.01, inputmode: 'decimal', placeholder: '0.70', 'aria-describedby': 'if-floor-help' });
    if (v.minSimilarity != null) floor.value = String(v.minSimilarity);
    const guards = h('select', { id: 'if-guards', 'aria-describedby': 'if-guards-help' }, h('option', { value: 'general' }, 'General'), h('option', { value: 'store' }, 'Retail store'));
    guards.value = v.guards;
    // A new bot can be wired to buckets right away (each link starts on).
    const picks = edit ? [] : G.buckets.map((k) => ({ k, cb: h('input', { type: 'checkbox', value: k.id }) }));
    const save = h('button', { type: 'submit', class: 'btn btn-primary', hidden: ro }, edit ? 'Save settings' : 'Create bot');
    const all = [name, org, bn, greet, ...starters, floor, guards];
    if (ro) all.forEach((x) => { x.disabled = true; });
    const onSubmit = async (ev) => {
      ev.preventDefault(); err.hidden = true;
      if (ro) return;
      const nm = name.value.trim();
      if (!nm) return fail(err, 'Name is required.', name);
      const fl = floor.value.trim();
      if (fl && !(Number(fl) >= 0 && Number(fl) < 1)) return fail(err, 'Relevance floor must be a number from 0 to 0.99.', floor);
      const body = { name: nm, org: org.value.trim(), botName: bn.value.trim(), greeting: greet.value.trim(), starters: starters.map((x) => x.value.trim()).filter(Boolean), guards: guards.value };
      if (fl) body.minSimilarity = Number(fl);
      if (!edit) { for (const k of ['org', 'botName', 'greeting']) if (!body[k]) delete body[k]; body.buckets = picks.filter((p) => p.cb.checked).map((p) => ({ id: p.k.id, enabled: true })); }
      save.disabled = true; rc(save, edit ? 'Saving…' : 'Creating…');
      try {
        const r = normBot(await api(edit ? `/api/instances/${encodeURIComponent(b.id)}` : '/api/instances', { method: edit ? 'PATCH' : 'POST', json: body }));
        announce(edit ? `Saved ${r.name}` : `Created bot ${r.name}`);
        await load();
        if (edit) { toast(`Saved ${r.name}`); save.disabled = false; rc(save, 'Save settings'); const hd = side.querySelector('.inst-h'); if (hd) rc(hd, r.name); }
        else go('bot', r.id);
      } catch (e) { save.disabled = false; rc(save, edit ? 'Save settings' : 'Create bot'); fail(err, e.message); }
    };
    return h('form', { class: 'inst-form', novalidate: true, onsubmit: onSubmit, 'aria-label': 'Bot settings' },
      b && b.builtin ? h('p', { class: 'note' }, 'The built-in bot’s settings come from the server; only its bucket links can change here.') : null,
      field('Name', name, null, 'if-name'), idNote,
      h('div', { class: 'inst-row2' }, field('Organisation / brand name', org, null, 'if-org'), field('Bot name', bn, null, 'if-bot')),
      field('Greeting', greet, null, 'if-greet'),
      h('fieldset', { class: 'inst-field inst-starters' }, h('legend', null, 'Starter questions ', h('span', { class: 'inst-help' }, 'up to 6')), h('div', { class: 'inst-starter-grid' }, starters)),
      h('div', { class: 'inst-row2' },
        field('Relevance floor', floor, 'Higher = refuses more, lower = answers more loosely. Blank = server default (0.70).', 'if-floor'),
        field('Guards', guards, 'Retail store adds shopping-specific refusals (prices, orders, stock).', 'if-guards')),
      picks.length ? h('fieldset', { class: 'inst-field flow-picks' }, h('legend', null, 'Answer from these buckets ', h('span', { class: 'inst-help' }, 'change any time on the canvas')),
        picks.map(({ k, cb }) => h('label', { class: 'flow-pick' }, cb, h('span', null, k.name), h('span', { class: 'mono inst-help' }, k.folder)))) : null,
      err, ro ? null : h('div', { class: 'inst-actions' }, save, edit ? null : h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => go('overview') }, 'Cancel')));
  }

  function botView(b) {
    const copyBtn = h('button', { type: 'button', class: 'btn btn-sm', 'data-fk': 'copy' }, 'Copy embed code');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(embedCode(b.id));
      rc(copyBtn, ok ? 'Copied ✓' : 'Copy failed — select the code below');
      announce(ok ? 'Embed code copied' : 'Copy failed');
      setTimeout(() => { if (copyBtn.isConnected) rc(copyBtn, 'Copy embed code'); }, 2000);
    });
    const view = h('div', { class: 'flow-view' }, back(),
      kicker('Bot', b.builtin ? h('span', { class: 'flag flag-inst' }, 'built-in') : null),
      h('h3', { class: 'display inst-h', tabindex: -1, 'data-autofocus': true }, b.name),
      h('div', { class: 'inst-card-meta mono' }, h('span', null, `id ${b.id}`), h('span', null, b.guards === 'store' ? 'retail guards' : 'general guards'),
        h('span', null, `floor ${b.minSimilarity != null ? b.minSimilarity.toFixed(2) : 'default'}`), b.updatedAt ? h('span', null, `updated ${ago(b.updatedAt)}`) : null),
      h('div', { id: 'flow-scope' }),
      h('div', { class: 'inst-links' },
        h('a', { class: 'btn btn-sm btn-primary', href: chatUrl(b.id), target: '_blank', rel: 'noopener', 'data-fk': 'chat', 'aria-label': `Open chat with ${b.name} in a new tab` }, 'Open chat ↗'), copyBtn),
      h('details', { class: 'inst-embed' }, h('summary', null, 'Embed code'), h('code', { class: 'mono' }, embedCode(b.id))),
      h('section', { id: 'flow-links', class: 'flow-sec' }),
      h('details', { class: 'flow-settings', open: !b.builtin }, h('summary', null, 'Settings'), botForm(b)),
      !b.builtin && editable() ? h('div', { class: 'flow-danger' }, h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => deleteBot(b) }, 'Delete bot')) : null);
    queueMicrotask(paintLinks);
    return view;
  }

  /* ---------------------------------------------------------------- deletes */
  async function deleteFile(f) {
    const k = bucket(I.id);
    if (!k) return;
    const n = feeds(k.id).length;
    if (!confirm(`Delete “${f.path}” from ${k.folder}?\n\nIt is removed from the knowDrive store${n ? ` and the ${plural(n, 'bot')} using this bucket can no longer cite it` : ''}.`)) return;
    try {
      await api(`/api/buckets/${encodeURIComponent(k.id)}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      announce(`Deleted ${f.path}`);
      I.files = I.files.filter((x) => x.id !== f.id); paintFiles();
      const hd = $('#inst-files-h'); if (hd) hd.focus();
      loadFiles();
    } catch (e) { toast(`Couldn’t delete ${f.path}: ${e.message}`, true); }
  }
  async function deleteBucket(k) {
    const n = feeds(k.id), c = G.counts.get(k.id);
    if (!confirm(`Delete the bucket “${k.name}”?\n\nIt is unlinked from ${n.length ? n.map((b) => b.name).join(', ') : 'every bot'}. This removes the bucket only: ${c && c.n ? `the ${plural(c.n, 'file')} in` : 'files in'} ${k.folder} stay in the knowDrive store — delete them first if you want them gone.`)) return;
    try { await api(`/api/buckets/${encodeURIComponent(k.id)}`, { method: 'DELETE' }); G.counts.delete(k.id); toast(`Deleted bucket ${k.name}`); await load(); go('overview'); }
    catch (e) { toast(`Couldn’t delete ${k.name}: ${e.message}`, true); }
  }
  async function deleteBot(b) {
    if (!confirm(`Delete the bot “${b.name}”?\n\nChats and embeds using “${b.id}” stop working. Its buckets and their files are kept.`)) return;
    try { await api(`/api/instances/${encodeURIComponent(b.id)}`, { method: 'DELETE' }); toast(`Deleted bot ${b.name}`); await load(); go('overview'); }
    catch (e) { toast(`Couldn’t delete ${b.name}: ${e.message}`, true); }
  }

  /* ---------------------------------------------------------------- wiring */
  $('#flow-btn').addEventListener('click', (e) => open(e.currentTarget));
  $('#flow-close').addEventListener('click', close);
  $('#flow-add-bucket').addEventListener('click', () => go('new-bucket'));
  $('#flow-add-bot').addEventListener('click', () => go('new-bot'));
  $('#flow-sheet-btn').addEventListener('click', () => { I.sheet = !I.sheet; syncSheet(); });
  drawer.addEventListener('keydown', onKey);
  const tok = $('#flow-token');
  tok.addEventListener('change', () => { saveToken(tok.value.trim()); I.auth = 'unknown'; paintToken(); refresh(); loadCounts(); if (I.view === 'bucket') loadFiles(); });
  tok.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tok.dispatchEvent(new Event('change')); } });
  $('#flow-token-forget').addEventListener('click', () => { saveToken(''); I.auth = 'unknown'; paintToken(); refresh(); tok.focus(); });
  // A file dropped anywhere else in the panel must not navigate the tab away.
  drawer.addEventListener('dragover', (e) => e.preventDefault());
  drawer.addEventListener('drop', (e) => e.preventDefault());
  new MutationObserver(() => refresh()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('beforeunload', (e) => { if (I.queue.some((q) => q.state === 'uploading' || q.state === 'queued')) { e.preventDefault(); e.returnValue = ''; } });

  return { load, open, close, bot, builtinId, get bots() { return G.bots; } };
}

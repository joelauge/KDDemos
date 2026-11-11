// KnowBot Studio: ingest + atomization (owner D; SPEC 2.4, 2.5, 6.3, 1.6, 1.8).
//
// What lives here:
//   - IntakePanel (#in-intake-slot): CapacityBar (100 MB, one hue segment per file), FileRows with the 6-node
//     KnowDrive FileGauge (kdw.js) driven by real server stages, stall timers, failure reasons + recovery, include toggles,
//     kebab menu (View atoms / Retry / Replace / Remove), collapse to a one-line Sources chip when all Ready.
//   - Intake: client validation, upload queue (concurrency 2, XHR progress, 1/3/9 s backoff), drop overlay,
//     paste, hidden picker. Samples attach/remove.
//   - The trial events stream (D owns the subscription): file/atoms/summary/usage → store + module events.
//   - Shatter (signature, director priority 1): real atom text → DocCard → chunk strips → atom chips → fly
//     into the map, never ahead of the real stage. Waits at a phase boundary until the stage arrives.
//   - Knowledge Map (#in-map-slot): canvas, one dot per atom (or 1 dot = k atoms above the cap), grouped by
//     file on a golden-angle spiral, retrieval / refusal playback, citation highlight, tooltip, table view,
//     hidden accessible list, ribbon mode.
//
// Truth rules: every stage, counter and dot comes from server state. Counters tween toward the last real
// value only; dots are born at the real `vectorized` delta rate; nothing is shown that did not happen.
// A counted atom that is not vectorized yet is drawn as a hollow ring in its file hue (it fills when its vector
// lands); under reduced motion every counted atom is painted as a static dot at once.
//
// Layout stability (round-1 critic): rows keep ONE height from the first stage to Ready (track and summary share a
// grid cell), skeleton rows reserve the sample rows' height on click, the map/intake hold fixed shares while files
// learn (the thread absorbs late arrivals), the band changes height in one step at ask time (never a per-frame
// height transition), and the retrieval "peek" is an overlay. No height animation anywhere in this module.
//
// CONTRACT-GAP (C, samplebot.js): the Partial banner counts failed files in its denominator forever ("1 of 3 files
//   ready"). Suggested: count ready + still-processing only and show failures separately ("1 ready · 1 failed · 1
//   still processing"). D cannot edit #st-bot-banner.
// CONTRACT-GAP (B/C): the critic asks for the thread to keep >= 50% of the pane and for the new answer's top to be
//   scrolled into view on the first answer. D now folds the intake to its chip on answer:start (inside the ask's
//   input window); the thread's min-height and its scrolling live in studio.css / samplebot.js.
// CONTRACT-GAP (A, trials.mjs): the 'atoms' preview event is sent at the atomize stage. D now also asks
//   GET /files/:id/atoms once at the chunk stage so the shatter can start on real chunk text earlier; sending the
//   preview from the server at 'chunked' would make that request unnecessary.
// CONTRACT-GAP (B, studio.css): the post-answer rule compacts any non-ribbon band to a strip unless it is pinned. D's
//   ribbon "Expand" (a look, not a pin) marks #in-map-slot[data-expanded="yes"]; ingest.css lifts the strip for it.
// CONTRACT-GAP (B, studio.css): once an answer exists the intake slot gets max 22% and the thread min 55%, so a
//   user-expanded Sources panel shows ~1 row. D marks that state with #in-intake-slot[data-open="user"].

import { mountWidget, mountRowMenu, gaugeProps } from './kdw.js?v=228872e';

const RANK = { rejected: -2, failed: -1, queued: 0, uploading: 1, uploaded: 2, extracted: 3, chunked: 4, atomized: 5, vectorizing: 6, ready: 7 };
const TERMINAL = new Set(['ready', 'failed', 'rejected']);
const SERVER_STAGES = new Set(['uploaded', 'extracted', 'chunked', 'atomized', 'vectorizing', 'ready', 'failed']);
const DOING = { uploading: 'uploading', uploaded: 'extracting', extracted: 'chunking', chunked: 'atomizing', atomized: 'encoding your knowledge', vectorizing: 'encoding your knowledge', queued: 'waiting' };

const DEFAULT_TYPES = [
  { kind: 'pdf', ext: ['pdf'] }, { kind: 'docx', ext: ['docx'] }, { kind: 'pptx', ext: ['pptx'] }, { kind: 'xlsx', ext: ['xlsx'] },
  { kind: 'html', ext: ['html', 'htm'] }, { kind: 'md', ext: ['md', 'markdown'] }, { kind: 'txt', ext: ['txt', 'csv'] },
  { kind: 'image', ext: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }, { kind: 'audio', ext: ['mp3', 'wav', 'm4a', 'ogg'] },
];
const MIME_KIND = [
  [/pdf/, 'pdf'], [/wordprocessingml|msword/, 'docx'], [/presentationml|powerpoint/, 'pptx'], [/spreadsheetml|excel/, 'xlsx'],
  [/html/, 'html'], [/markdown/, 'md'], [/^text\//, 'txt'], [/^image\//, 'image'], [/^audio\//, 'audio'],
];
const SUPPORTED_COPY = 'PDF, DOCX, PPTX, XLSX, HTML, MD, TXT, PNG/JPG, MP3/WAV/M4A';
const TYPE_CHIPS = ['PDF', 'DOCX', 'PPTX', 'XLSX', 'HTML', 'MD', 'TXT', 'Images', 'Audio'];
const QUOTA_DEFAULT = 104857600;
const FILE_DEFAULT = 99614720;
const STALL_MS = 45000;
const BACKOFF = [1000, 3000, 9000];
const MAX_DOTS = 4000;
const MAX_DOTS_LOW = 1500;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
// 4 cores or fewer (most phones, throttled laptops): the map canvas renders at DPR <= 1.5 (fewer pixels per blit)
const LOWCPU = (() => { try { return (navigator.hardwareConcurrency || 8) <= 4; } catch { return false; } })();
const IDLE_DOTS = 240;
const DBG = (() => { try { return /[?&]debug=1/.test(location.search); } catch { return false; } })();

// ------------------------------------------------------------------ small helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const extOf = (name) => { const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
/** FNV-1a 32-bit. */
function hash32(s) {
  let x = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  // murmur3 finalizer: FNV alone leaves sequential keys ("f:1", "f:2"…) visibly correlated
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return x >>> 0;
}
/** "0.04" / "8.3" / "96" MB (spec copy: "0.04 MB of 100 MB", "96.1 MB left"). */
function fmtMB(bytes) {
  const mb = (Number(bytes) || 0) / 1048576;
  if (mb <= 0) return '0';
  if (mb < 0.1) return Math.max(0.01, mb).toFixed(2);
  if (mb < 10) return mb.toFixed(1);
  if (mb < 99.95) return mb.toFixed(1).replace(/\.0$/, '');
  return String(Math.round(mb));
}
function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  // one decimal from 10 MB up too, whenever it is not a whole number: a 95.4 MB file never reads "95 MB" beside a
  // "must be under 95 MB" message (round-5 critic); whole sizes stay short ("12 MB")
  const mb = b / 1048576, d1 = mb.toFixed(1);
  return `${b < 10485760 || !d1.endsWith('.0') ? d1 : mb.toFixed(0)} MB`;
}
/** A true middle ellipsis that keeps the extension WITH its dot (spec 1.2): lumen-warranty-returns.md (max 21) ->
 *  "lumen-warr…returns.md"; lumen-service-plans.html (max 16) -> "lumen-serv….html". The tail keeps the last word of
 *  the name when it fits in about half the budget. Callers put the full name in a title / tooltip / sr-only text. */
function mid(name, max = 30) {
  const s = String(name || '');
  if (s.length <= max) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
  const base = ext ? s.slice(0, dot) : s;
  const budget = Math.max(6, max - 1);
  let tail = ext;
  const sep = Math.max(base.lastIndexOf('-'), base.lastIndexOf('_'), base.lastIndexOf(' '));
  const word = sep > 0 ? base.slice(sep + 1) : '';
  if (word && word.length + ext.length <= Math.floor(budget / 2) && sep >= 4) tail = word + ext;
  let head = base.slice(0, Math.max(3, budget - tail.length)).replace(/[-_\s.]+$/, '');
  if (!head) head = base.slice(0, 3);
  return `${head}…${tail}`;
}
/** Markdown/table noise out of preview text: "| Model | Type |" -> "Model · Type", separator rows and heading/emphasis marks gone. */
function cleanText(t) {
  return String(t || '')
    .replace(/\|?(\s*:?-{3,}:?\s*\|)+\s*(:?-{3,}:?)?/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/[#*_`>]+/g, ' ')
    .replace(/(\s*·\s*){2,}/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .trim();
}
const ric = (fn, timeout = 200) => { try { if (window.requestIdleCallback) return window.requestIdleCallback(fn, { timeout }); } catch { /* ignore */ } return setTimeout(fn, 16); };
// Guarded DOM writes: an unchanged value is never written (no attribute mutation, no style invalidation)
const setDs = (el, k, v) => { if (el.dataset[k] !== v) el.dataset[k] = v; };
const setVar = (el, k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };
const setHidden = (el, v) => { if (el.hidden !== v) el.hidden = v; };
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** 1234567 -> "1,234,567" without toLocaleString (which is slow enough to show up in per-frame tickers). */
const fmtInt = (n) => { const v = Math.round(Number(n) || 0); return Math.abs(v) < 1000 ? String(v) : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// cached: isMobile() is read inside the draw loop and the layout, where matchMedia() itself is measurable
let mobileMQ = null, mobileNow = false;
try { mobileMQ = matchMedia('(max-width: 899px)'); mobileNow = mobileMQ.matches; const onMQ = () => { mobileNow = mobileMQ.matches; }; if (mobileMQ.addEventListener) mobileMQ.addEventListener('change', onMQ); else if (mobileMQ.addListener) mobileMQ.addListener(onMQ); } catch { /* ignore */ }
const isMobile = () => mobileNow;
const lowDetail = () => document.documentElement.dataset.detail === 'low';
let uidN = 0;
const uid = (p) => `${p}-${(++uidN).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function easeOut(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }
/** cubic-bezier(x1, y1, x2, y2) as a function of progress (Newton on x): the canvas chips use the same curves as CSS. */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let n = 0; n < 8; n++) {
      const e = ((ax * t + bx) * t + cx) * t - x, d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(e) < 1e-4 || Math.abs(d) < 1e-6) break;
      t = clamp(t - e / d, 0, 1);
    }
    return ((ay * t + by) * t + cy) * t;
  };
}
const EZ_SPRING = bezier(0.34, 1.4, 0.64, 1);
const EZ_STD = bezier(0.4, 0, 0.2, 1);
function easeInOut(t) { const x = clamp(t, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
function easeSpring(t) {
  const p = [[0, 0], [.12, .5], [.22, .86], [.32, 1.04], [.42, 1.02], [.55, .99], [1, 1]];
  t = clamp(t, 0, 1);
  for (let i = 1; i < p.length; i++) if (t <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (t - x0) / (x1 - x0); }
  return 1;
}

// ================================================================== mount

export function mount(ctx) {
  const { store, api, motion, icons, slots } = ctx;
  const { getState, setState, emit, on, mark, registerCard } = store;
  const say = (text, region = 'ingest') => { try { ctx.announce && ctx.announce(text, region); } catch { /* ignore */ } };
  const icon = (n, o) => (icons && icons.icon ? icons.icon(n, o) : '');
  const fileIcon = (k, o) => (icons && icons.fileIcon ? icons.fileIcon(k, o) : icon('file', o));
  // The file icon with its type label ("PDF", "MD") as HTML text over the SVG page, not an SVG <text>: SVG text is
  // re-laid out on every frame an ancestor's transform animates (row enter, FLIP), HTML text is not.
  const htmlKindIcon = (k, size) => {
    const raw = fileIcon(k, { size });
    const m = /<text[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/.exec(raw);
    if (!m) return raw;
    const fs = (Number(m[1]) * size / 24).toFixed(2);
    return `${raw.replace(/<text[\s\S]*?<\/text>/g, '')}<span class="in-ico-k" aria-hidden="true" style="font-size:${fs}px">${m[2]}</span>`;
  };
  const reduced = () => (motion && motion.reduced ? motion.reduced() : document.documentElement.getAttribute('data-motion') === 'reduce');
  const anim = (el, kf, o) => (motion && motion.animate ? motion.animate(el, kf, o) : { finished: Promise.resolve(), finish() {}, cancel() {} });

  const mapSlot = slots.map || document.getElementById('in-map-slot');
  const intakeSlot = slots.intake || document.getElementById('in-intake-slot');
  const dropSlot = slots.drop || document.getElementById('in-drop-slot');
  const botPane = slots.bot || document.getElementById('st-bot');
  const appEl = (botPane && botPane.closest && botPane.closest('.st-app')) || document.querySelector('.st-app');
  if (!mapSlot || !intakeSlot || !dropSlot) throw new Error('ingest: slots missing');

  const subs = [];
  const sub = (type, fn) => { subs.push(on(type, fn)); };
  // Text metrics come from a DETACHED canvas: setting .font on the on-screen canvas forces a document style recalc
  // (expensive right after rows were inserted); a detached context never does.
  const MONO10 = '500 10px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const MONO12 = '500 12px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  // map labels are never below 11 px (round-4 critic: 10 px mono names were hard to read)
  const MONO11 = '500 11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const SANS11 = 'italic 400 11px Inter, ui-sans-serif, system-ui, sans-serif';
  let textCtx = null;
  // measured once per (font, text): labels and chips re-use widths across layouts instead of re-measuring per frame
  const widthCache = new Map();
  let textFont = '';
  const textWidth = (text, font = MONO10) => {
    const key = `${font === MONO10 ? '' : font}|${text}`;
    const hit = widthCache.get(key);
    if (hit != null) return hit;
    let w;
    try { if (!textCtx) textCtx = document.createElement('canvas').getContext('2d'); if (textFont !== font) { textCtx.font = font; textFont = font; } w = textCtx.measureText(text).width; } catch { w = String(text).length * 6.1; }
    if (widthCache.size > 4000) widthCache.clear();
    widthCache.set(key, w);
    return w;
  };
  // widths measured before a web font finished loading are fallback-font widths: drop them once fonts land
  try { if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => { widthCache.clear(); textFont = ''; }); } catch { /* ignore */ }
  const domOff = [];
  const listen = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); domOff.push(() => el.removeEventListener(type, fn, opts)); };

  // module-local bookkeeping (not in the store)
  const byId = new Map();          // server file id -> localId
  const previews = new Map();      // server file id -> [{seq, atomId, text}]
  const atomText = new Map();      // `${fileId}:${seq}` -> {text, atomId}
  const rowMeta = new Map();       // localId -> {lastChangeAt, failedNode, retryAt, retryTimer, attempt, upload, shown...}
  const restored = new Set();      // localIds that were already terminal when first seen (no cards, no shatter)
  const summarized = new Set();    // localIds whose summary was emitted
  const readyEmitted = new Set();
  const failedEmitted = new Set();
  const waiters = new Set();       // shatter phase waits
  const lastStageSaid = new Map();   // localId -> last announced phase key
  const errorCards = new Set();      // localIds that already have a Builder ErrorCard
  // The file's real first lines while it is extracted (its own text: the local File for text types, the sample's
  // source file for samples, else the first atoms once they exist). Rows and the map show them with a scan sweep.
  const reading = new Map();         // localId -> [up to 3 lines]
  const readAsked = new Set();
  let sampleSet = 'lumen-bikes';
  let hueCounter = 0;
  let replayLabel = null;
  let events = null;
  let destroyed = false;

  const cfg = () => getState().config || {};
  const quota = () => (getState().trial && getState().trial.quota && getState().trial.quota.bytes) || (cfg().quota && cfg().quota.bytes) || QUOTA_DEFAULT;
  const fileCap = () => (getState().trial && getState().trial.quota && getState().trial.quota.fileBytes) || (cfg().quota && cfg().quota.fileBytes) || FILE_DEFAULT;
  const types = () => (Array.isArray(cfg().types) && cfg().types.length ? cfg().types : DEFAULT_TYPES);
  const listFiles = () => { const s = getState(); return (s.fileOrder || []).map((id) => s.files[id]).filter(Boolean); };
  const liveFiles = () => listFiles().filter((f) => f.phase !== 'rejected');
  /** THE status selector: the map HUD, the Sources header, the collapsed chip and the 'ingest:counts' event all
   *  read it, so they can never disagree. searchable = atoms of Ready files (B's "N of M files ready · X atoms"). */
  function fileCounts(files = liveFiles()) {
    const c = { total: files.length, ready: 0, failed: 0, learning: 0, read: 0, searchable: 0 };
    for (const f of files) {
      if (f.phase === 'failed') { c.failed++; continue; }
      const a = Number(f.atoms) || 0;
      c.read += a;
      if (f.phase === 'ready') { c.ready++; c.searchable += a; } else c.learning++;
    }
    return c;
  }
  const meta = (lid) => { let m = rowMeta.get(lid); if (!m) { m = { lastChangeAt: Date.now() }; rowMeta.set(lid, m); } return m; };
  const isEnabled = (f) => f.enabled !== false && !(f.id && (getState().spec.sources || {})[f.id] === false);

  function kindOf(name, mime) {
    const e = extOf(name);
    for (const t of types()) if ((t.ext || []).includes(e)) return t.kind;
    if (!e && mime) for (const [re, k] of MIME_KIND) if (re.test(mime)) return k;
    return null;
  }
  const acceptAttr = () => types().flatMap((t) => (t.ext || []).map((x) => `.${x}`)).join(',');

  // ---------------------------------------------------------------- store writes (D owns files, fileOrder, usage)

  function writeFile(lid, patch, reason = 'ingest:file') {
    const s = getState();
    const prev = s.files[lid];
    if (!prev) return null;
    const next = { ...prev, ...patch };
    setState({ files: { ...s.files, [lid]: next } }, reason);
    return { prev, next };
  }
  function addFileState(f, { index = null } = {}) {
    const s = getState();
    const order = s.fileOrder.slice();
    if (index != null && index >= 0 && index <= order.length) order.splice(index, 0, f.localId); else order.push(f.localId);
    setState({ files: { ...s.files, [f.localId]: f }, fileOrder: order }, 'ingest:add');
  }
  function dropFileState(lid) {
    const s = getState();
    if (!s.files[lid]) return;
    const files = { ...s.files };
    delete files[lid];
    setState({ files, fileOrder: s.fileOrder.filter((x) => x !== lid) }, 'ingest:remove');
  }
  function setUsage(u) {
    if (!u || typeof u !== 'object') return;
    const cur = getState().usage || {};
    const next = { bytes: Number(u.bytes) || 0, files: Number(u.files) || 0 };
    if (cur.bytes !== next.bytes || cur.files !== next.files) setState({ usage: next }, 'ingest:usage');
    renderCapacity();
  }

  // A file keeps its hue across reloads: the hue is remembered per trial and server file id (D's own localStorage
  // key; B's store does not persist files). New files take the first hue no live file uses.
  // CONTRACT-GAP (B, store.js): if the store ever persists files[*].hue, read it here instead of this key.
  const HUE_KEY = 'knowbot.studio.hues.v1';
  let hueMem = null;
  const hueStore = () => {
    if (hueMem) return hueMem;
    try { hueMem = JSON.parse(localStorage.getItem(HUE_KEY) || '{}') || {}; } catch { hueMem = {}; }
    return hueMem;
  };
  function storedHue(id) {
    const t = getState().trial && getState().trial.id;
    const v = t && id ? (hueStore()[t] || {})[id] : null;
    return Number.isInteger(v) && v >= 0 && v < 8 ? v : null;
  }
  function saveHue(id, hue) {
    const t = getState().trial && getState().trial.id;
    if (!t || !id || !Number.isInteger(hue)) return;
    const all = hueStore();
    if ((all[t] || {})[id] === hue) return;
    all[t] = { ...(all[t] || {}), [id]: hue, _at: Date.now() };
    // keep the 4 most recent trials only
    const keys = Object.keys(all).sort((a, b) => ((all[b] || {})._at || 0) - ((all[a] || {})._at || 0));
    for (const kk of keys.slice(4)) delete all[kk];
    try { localStorage.setItem(HUE_KEY, JSON.stringify(all)); } catch { /* private mode: hues follow file order */ }
  }
  function nextHue() {
    const used = new Set(listFiles().filter((f) => f.phase !== 'rejected').map((f) => f.hue));
    for (let i = 0; i < 8; i++) { const hv = (hueCounter + i) % 8; if (!used.has(hv)) { hueCounter = hv + 1; return hv; } }
    return (hueCounter++) % 8;
  }
  function newFileState({ name, bytes, mime, kind, sample = false, file = null, id = null }) {
    const localId = uid('f');
    const kept = storedHue(id);
    return {
      localId, id, name: name || 'file', bytes: Number(bytes) || 0, mime: mime || 'application/octet-stream', kind: kind || 'txt',
      hue: kept != null ? kept : nextHue(), sample: !!sample, enabled: true, phase: 'queued',
      sent: 0, chunks: 0, atoms: 0, vectorized: 0, pages: null, error: null, summary: null, topics: [], stageAt: {}, file,
    };
  }

  // ================================================================== DOM: intake panel

  const panelId = uid('in-panel');
  const titleId = uid('in-title');
  const panel = h('section', { class: 'in-panel', 'aria-labelledby': titleId, dataset: { state: 'empty' } });
  const head = h('div', { class: 'in-head' });
  const headTitle = h('h2', { class: 'in-title', id: titleId }, 'Sources');
  const headMeta = h('span', { class: 'in-head-meta in-num' });
  const replayPill = h('span', { class: 'in-replay', hidden: true }, h('span', { html: icon('play', { size: 11 }) }), h('span', { class: 'in-replay-t' }));
  const removeSamplesBtn = h('button', { type: 'button', class: 'btn btn-ghost in-btn in-btn-ghost in-rm-samples', hidden: true, onclick: () => removeSamples() }, 'Remove sample files');
  const addBtn = h('button', { type: 'button', class: 'btn btn-ghost in-btn in-btn-add', onclick: () => pick() }, h('span', { class: 'in-btn-ico', html: icon('plus', { size: 15 }) }), h('span', null, 'Add files'));
  const collapseBtn = h('button', { type: 'button', class: 'in-iconbtn in-collapse', 'aria-expanded': 'true', 'aria-controls': panelId, title: 'Collapse sources', 'aria-label': 'Collapse sources', onclick: () => setCollapsed(!collapsedByUser.value) }, h('span', { html: icon('chevronDown', { size: 16 }) }));
  head.append(h('div', { class: 'in-head-l' }, headTitle, headMeta, replayPill), h('div', { class: 'in-head-r' }, removeSamplesBtn, addBtn, collapseBtn));

  // capacity bar
  const capLabelId = uid('in-cap');
  const cap = h('div', { class: 'in-cap' });
  const capBar = h('div', { class: 'in-cap-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(QUOTA_DEFAULT), 'aria-valuenow': '0', 'aria-labelledby': capLabelId });
  const capSegs = h('div', { class: 'in-cap-segs' });
  capBar.append(capSegs);
  const capLabel = h('span', { class: 'in-cap-label in-num', id: capLabelId });
  const capWarnT = h('span', null, 'Close to the 100 MB limit.');
  const capWarn = h('span', { class: 'in-cap-warn', hidden: true }, h('span', { html: icon('warn', { size: 13 }) }), capWarnT);
  cap.append(capBar, h('div', { class: 'in-cap-row' }, capLabel, capWarn));

  const rowsEl = h('ul', { class: 'in-rows', id: panelId, 'aria-label': 'Files' });
  // limits come from config (quota.fileBytes / quota.bytes), the same numbers validation and the server use
  const emptyT = h('p', { class: 'in-empty-t' });
  const empty = h('div', { class: 'empty-state in-empty' },
    h('div', { class: 'in-empty-art', 'aria-hidden': 'true', html: icon('upload', { size: 20 }) }),
    h('div', { class: 'in-empty-copy' },
      emptyT,
      h('p', { class: 'in-types' }, h('span', { class: 'in-sr' }, 'Supported types: '), TYPE_CHIPS.map((t) => h('span', { class: 'in-type' }, t)))),
    // secondary (outline) until the visitor picks the upload path: the landing has one filled primary, the Builder's
    h('button', { type: 'button', class: 'btn btn-ghost in-btn in-choose', onclick: () => pick() }, h('span', { html: icon('upload', { size: 15 }) }), 'Choose files'));
  // Collapsed one-line Sources chip. Its accessible name IS its visible text (no aria-label to drift from it);
  // the state and the action live in aria-describedby.
  const chipDescId = uid('in-chipd');
  const chipDesc = h('span', { class: 'in-sr', id: chipDescId });
  const chip = h('button', { type: 'button', class: 'in-chip', hidden: true, 'aria-expanded': 'false', 'aria-controls': panelId, 'aria-describedby': chipDescId, onclick: () => setCollapsed(false) });
  // Progress tracker: while files learn, one bar for the whole batch and knowDrive's own estimate of the time left
  const etaFill = h('span', { class: 'in-eta-fill' });
  const etaBar = h('div', { class: 'in-eta-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Learning progress' }, etaFill);
  const etaCount = h('span', { class: 'in-eta-count in-num' });
  const etaTime = h('span', { class: 'in-eta-time', role: 'status' });
  const tracker = h('div', { class: 'in-eta', hidden: true }, h('div', { class: 'in-eta-row' }, etaCount, etaTime), etaBar);
  const body = h('div', { class: 'in-body' }, cap, rowsEl);
  panel.append(head, tracker, body, empty, chip, chipDesc);
  intakeSlot.innerHTML = '';
  intakeSlot.append(panel);

  const input = h('input', { type: 'file', multiple: true, hidden: true, accept: acceptAttr(), tabindex: '-1', 'aria-hidden': 'true', class: 'in-input' });
  const replaceInput = h('input', { type: 'file', hidden: true, accept: acceptAttr(), tabindex: '-1', 'aria-hidden': 'true', class: 'in-input' });
  intakeSlot.append(input, replaceInput);
  listen(input, 'change', () => { const list = Array.from(input.files || []); input.value = ''; if (list.length) addFiles(list); });
  let replaceTarget = null;
  listen(replaceInput, 'change', () => {
    const f = (replaceInput.files || [])[0]; replaceInput.value = '';
    const target = replaceTarget; replaceTarget = null;
    if (f && target) replaceFile(target, f);
  });

  // drop overlay + row menu live in #in-drop-slot (absolute over #st-bot)
  const dropOverlay = h('div', { class: 'in-drop', hidden: true },
    h('div', { class: 'in-drop-frame' },
      h('span', { class: 'in-drop-ico', html: icon('upload', { size: 26 }) }),
      h('p', { class: 'in-drop-t' }), h('p', { class: 'in-drop-s' })));
  dropSlot.innerHTML = '';
  dropSlot.append(dropOverlay);

  const collapsedByUser = { value: false, auto: true };

  // ================================================================== DOM: map band

  const band = h('section', { class: 'map-band', 'aria-label': 'Knowledge map', dataset: { mode: 'full', state: 'empty' } });
  const stage = h('div', { class: 'map-stage' });
  const canvas = h('canvas', { class: 'map-canvas', 'aria-hidden': 'true' });
  const hud = h('div', { class: 'map-hud' });
  const hudTitle = h('span', { class: 'map-title' }, 'Knowledge map');
  const hudCount = h('span', { class: 'map-count in-num', dataset: { value: '0' } }, '0');
  // One truth with the Builder and the Sources header: "searchable" = atoms of Ready files (what an answer can
  // quote); "read" = every atom counted so far. Equal → plain "88 atoms".
  const hudUnit = h('span', { class: 'map-unit' }, ' atoms');
  const hudRead = h('span', { class: 'map-read in-num', hidden: true });
  const hudCountWrap = h('span', { class: 'map-countwrap', hidden: true }, h('span', { class: 'map-sep', 'aria-hidden': 'true' }, '·'), hudCount, hudUnit, hudRead);
  const hudEmpty = h('span', { class: 'map-emptyl' }, h('span', { class: 'map-sep', 'aria-hidden': 'true' }, '·'), ' empty');
  const hudScale = h('span', { class: 'map-scale in-num', hidden: true });
  const tableBtn = h('button', { type: 'button', class: 'btn btn-ghost map-btn', 'aria-pressed': 'false', onclick: () => toggleTable() }, h('span', { html: icon('table', { size: 14 }) }), h('span', { class: 'map-btn-l' }, 'Table view'));
  const pinBtn = h('button', { type: 'button', class: 'btn btn-ghost map-btn map-pin', 'aria-pressed': 'false', onclick: () => togglePin() }, h('span', { html: icon('pin', { size: 14 }) }), h('span', { class: 'map-btn-l' }, 'Pin'));
  // ribbon -> tap / Expand opens the band for a look (not persisted); Collapse folds it back. Pin keeps it open.
  const foldBtn = h('button', { type: 'button', class: 'btn btn-ghost map-btn map-fold', hidden: true, 'aria-expanded': 'true', onclick: () => setExpanded(false) }, h('span', { html: icon('chevronDown', { size: 14 }) }), h('span', { class: 'map-btn-l' }, 'Collapse'));
  const expandBtn = h('button', { type: 'button', class: 'btn btn-ghost map-btn map-expand', hidden: true, 'aria-expanded': 'false', onclick: () => setExpanded(true) }, h('span', { html: icon('chevronDown', { size: 14 }) }), h('span', { class: 'map-btn-l' }, 'Expand'));
  // before the first atom exists the HUD tells the truth about what is happening ("chunking · 6 chunks"), never "0 atoms"
  // the separator is its own node: phones drop it with the title, so the HUD never starts with a stray "·"
  const hudStageT = h('span', { class: 'map-stagel-t' });
  const hudStage = h('span', { class: 'map-stagel in-num', hidden: true }, h('span', { class: 'map-sep', 'aria-hidden': 'true' }, '·'), hudStageT);
  const hudL = h('div', { class: 'map-hud-l' }, h('span', { class: 'map-glyph', html: icon('atom', { size: 14 }) }), hudTitle, hudCountWrap, hudStage, hudEmpty, hudScale);
  const hudR = h('div', { class: 'map-hud-r' }, tableBtn, expandBtn, foldBtn, pinBtn);
  hud.append(hudL, hudR);
  const legend = h('div', { class: 'map-legend' });
  const legendNote = h('span', { class: 'map-note' }, 'Each dot is one atom, grouped by file');
  // scrolls sideways (fade mask at the ends) instead of clipping at the pane edge; full names in title + aria
  const legendChips = h('span', { class: 'map-chips', role: 'list', tabindex: '0', 'aria-label': 'Files on the map' });
  legend.append(legendNote, legendChips);
  const tip = h('div', { class: 'map-tip', role: 'tooltip', hidden: true });
  // empty state: no placeholder dots (nothing is drawn that is not a real file or atom), just the promise
  const emptyCap = h('p', { class: 'map-empty' }, h('span', { class: 'map-empty-ico', 'aria-hidden': 'true', html: icon('atom', { size: 16 }) }), 'Atoms appear here as your files are read');
  const srHead = h('h2', { class: 'in-sr' }, 'Top matches for the last question');
  const srList = h('ol', { class: 'in-sr map-sr' }, h('li', null, 'No question asked yet.'));
  const table = h('div', { class: 'map-table', hidden: true, tabindex: '0', role: 'region', 'aria-label': 'Knowledge map as a table' });
  // shatter layer lives inside the map stage: it moves with the band and is clipped to it
  const mapFx = h('div', { class: 'map-fx', 'aria-hidden': 'true' });
  stage.append(emptyCap, canvas, mapFx, table, tip);
  band.append(stage, hud, legend, srHead, srList);
  mapSlot.innerHTML = '';
  mapSlot.dataset.mode = 'full';
  mapSlot.append(band);

  // ================================================================== Knowledge Map (canvas)

  const map = createMap();

  function createMap() {
    const c2d = canvas.getContext('2d', { alpha: true });
    let W = 0, H = 0, DPR = 1;
    let cap = MAX_DOTS;
    let N = 0, CAPN = 0;
    let X, Y, TX, TY, VX, VY, GLOW, ALPHA, BORN, SEQ, FI, R0;
    let BAND = new Float32Array(0);   // per-dot target alpha multiplier (scope)
    // INL[i] = 1: dot i has settled on its target and is painted into its file's static layer (an offscreen canvas,
    // blitted once per frame). Frames then touch only the dots that still move: a settled corpus of 4,000 atoms costs
    // one drawImage per FILE, not one per atom (round-4 4x-throttle trace: per-dot drawImage was the top cost).
    let INL = new Uint8Array(0);
    function grow(n) {
      if (n <= CAPN) return;
      const nc = Math.max(n, CAPN * 2, 512);
      const fa = (old) => { const a = new Float32Array(nc); if (old) a.set(old.subarray(0, N)); return a; };
      X = fa(X); Y = fa(Y); TX = fa(TX); TY = fa(TY); VX = fa(VX); VY = fa(VY); GLOW = fa(GLOW); ALPHA = fa(ALPHA); BORN = fa(BORN); R0 = fa(R0); BAND = fa(BAND);
      const s = new Int32Array(nc); if (SEQ) s.set(SEQ.subarray(0, N)); SEQ = s;
      const f = new Uint16Array(nc); if (FI) f.set(FI.subarray(0, N)); FI = f;
      const il = new Uint8Array(nc); il.set(INL.subarray(0, N)); INL = il;
      CAPN = nc;
    }
    grow(512);

    const recs = [];                 // file records in file order
    const recByKey = new Map();
    let k = 1;                       // atoms per dot
    let mode = 'full';
    let colors = { f: [], muted: '#64748b', dim: '#94a3b8', accent: '#6366f1', accent2: '#4f46e5', floor: '#9a4508', panel: '#fff', strong: '#0f172a', line: '#cbd5e1' };
    let sprites = [];
    let retrieval = null;
    let highlight = null;
    let hover = -1;
    let visible = true;
    let dirty = true;
    let lastDraw = 0;
    let skipOdd = false;
    let removeLoop = null;
    let red = reduced();
    let peek = false;                // ribbon temporarily expanded (as an overlay) while a retrieval plays
    let strip = false;               // clusters laid out left→right (ribbon, peek, or a short band)
    let area = { x0: 0, y0: 0, x1: 0, y1: 0 };   // where dots may be drawn (never under the HUD or the legend)
    let chrome = { hudBottom: 36, hudRight: 180, hudRLeft: 0, legendTop: 0, legendRight: 0 };
    let chromeStale = true;          // the HUD / legend moved (mode change): re-measure at the next clean-layout moment
    let chromeFor = '';              // fixer M r1: "WxH" the chrome was last measured for inside a ResizeObserver callback
    let onRetrievalEnd = null;
    // Rects the shatter currently covers (stage coords): cluster labels keep clear of them, so a DocCard, a chunk
    // strip or an atom chip never sits on a "name · stage" label.
    const occl = new Map();
    // Shatter overlays (veil + atom chips) paint INTO this canvas, after the dots and labels: one canvas commits per
    // frame instead of three (round-7 4x-throttle trace: each extra full-band chip canvas cost a commit per frame)
    const overlays = new Map();
    // Shatter lanes (stage px): while files are learning, the DocCards and chips play in reserved lanes at the band
    // edges (desktop: left / right; phones: a top lane), and the clusters lay out between them, so a card never sits
    // on a cluster or its label. When the last file lands the lanes close and the clusters glide out (FLIP).
    let lanes = { l: 0, r: 0, t: 0 };
    let labelArgs = null;            // [hudB, legT] of the last layout (labels can be re-placed without a full layout)
    let frameMs = 16;                // smoothed frame time (the shatter drops to 16 chips when frames run long)
    let lastBaseR = 0;               // dot radius the static layers were painted with
    let idleField = null;            // cached bitmap of the idle field
    let ambA = 1;                    // idle field opacity (240 grey dots behind the empty-state pill; fades out on first file)
    // the idle field: 240 grey dots in stable, hashed positions (unit square), drifting +/-0.3 px (static under reduce)
    const AMB = new Float32Array(IDLE_DOTS * 3);
    for (let i = 0; i < IDLE_DOTS; i++) {
      const hh = hash32(`idle:${i}`);
      // denser toward the middle (where clusters will form), never a uniform rectangle of noise
      const a = ((hh & 0xffff) / 65536) * Math.PI * 2, rr = Math.pow(((hh >>> 16) & 0xffff) / 65536, 0.7);
      AMB[i * 3] = 0.5 + Math.cos(a) * rr * 0.47; AMB[i * 3 + 1] = 0.55 + Math.sin(a) * rr * 0.42; AMB[i * 3 + 2] = (hh % 997) / 97;
    }

    function readColors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
      colors = {
        f: Array.from({ length: 8 }, (_, i) => v(`--f${i}`, '#6366f1')),
        muted: v('--muted', '#475569'), dim: v('--dim', '#94a3b8'), accent: v('--accent', '#6366f1'), accent2: v('--accent-2', '#4f46e5'),
        floor: v('--warn', '#9a4508'), panel: v('--panel', '#ffffff'), strong: v('--strong', '#0f172a'), line: v('--line-2', '#cbd5e1'),
      };
      // dark theme: the reading rings get more ink (a dark disc on a near-black band read as a hole)
      colors.dark = (() => { const p0 = colors.panel; let rgb = null;
        if (/^#([0-9a-f]{6})$/i.test(p0)) rgb = [1, 3, 5].map((o) => parseInt(p0.slice(o, o + 2), 16));
        else { const m0 = p0.match(/[\d.]+/g); if (m0 && m0.length >= 3) rgb = m0.slice(0, 3).map(Number); }
        return rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) < 90 : false; })();
      sprites = colors.f.map((col) => makeSprite(col));
      if (typeof labelCache !== 'undefined') labelCache.clear();
      sprites.ring = colors.f.map((col) => makeRing(col));
      sprites.idle = makeSprite(colors.dim);
      // the static layers were painted in the old theme's hues: repaint them (dots do not move)
      for (const r of recs) lyStart(r, false);
      dirty = true;
    }
    // a counted atom that is not vectorized yet: a hollow ring in its file hue (fills when its vector lands)
    function makeRing(col) {
      const s = document.createElement('canvas');
      const R = 16; s.width = s.height = R * 2;
      const g = s.getContext('2d');
      g.globalAlpha = 0.16; g.fillStyle = col; g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 5; g.beginPath(); g.arc(R, R, R - 3, 0, Math.PI * 2); g.stroke();
      return s;
    }
    /** Where the HUD and the legend sit (stage coordinates). Read on resize / mode change only, never per frame. */
    function measureChrome() {
      try {
        const sr = stage.getBoundingClientRect();
        const hl = hudL.getBoundingClientRect(), hr = hudR.getBoundingClientRect(), lg = legend.getBoundingClientRect();
        let lr = 0;
        const last = legendChips.lastElementChild;
        if (last) { const cr = legendChips.getBoundingClientRect(), lc = last.getBoundingClientRect(); lr = Math.min(cr.right, lc.right) - sr.left; }
        else if (!legendNote.hidden && legendNote.offsetParent) lr = legendNote.getBoundingClientRect().right - sr.left;
        chromeStale = false;
        chrome = {
          measured: true,
          hudBottom: Math.max(0, hl.bottom - sr.top), hudRight: Math.max(0, hl.right - sr.left), hudRLeft: hr.width ? hr.left - sr.left : sr.width,
          hudRBottom: hr.height ? Math.max(0, hr.bottom - sr.top) : 0,
          legendTop: lg.height ? Math.max(0, lg.top - sr.top + 4) : sr.height, legendRight: Math.max(0, lr),
        };
      } catch { /* keep the last measure */ }
    }
    function makeSprite(col) {
      const s = document.createElement('canvas');
      const R = 16; s.width = s.height = R * 2;
      const g = s.getContext('2d');
      g.fillStyle = col; g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.fill();
      return s;
    }

    function resize(box, { known = false } = {}) {
      // ResizeObserver hands us the size after layout (no forced reflow); other callers read it once.
      // known: the caller computed the new size itself (peek): no layout read at all, the bottom-anchored legend
      // simply moves with the bottom edge.
      const r = box && box.width ? box : stage.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
      const dpr0 = DPR;
      // capped at 1.5: the map is soft dots, and 2x backing stores doubled every clear and blit (round-5 profile:
      // drawImage was the top CPU cost under 4x throttle)
      DPR = Math.min(1.5, window.devicePixelRatio || 1);
      if (w === W && hh === H && canvas.width === Math.round(w * DPR)) return;
      if (dpr0 !== DPR) for (const r of recs) lyStart(r, false);
      const dH = hh - H;
      // only the height changed and the chrome is known: the HUD is top-anchored and the legend bottom-anchored, so
      // no layout read is needed (reads here would force a layout other modules' DOM writes just invalidated)
      if (w === W && chrome.measured && !chromeStale) known = true;
      // fixer M r1: the ResizeObserver measured the chrome for this exact box already (clean layout, no forced read)
      const fresh = chromeFor === `${w}x${hh}`;
      W = w; H = hh;
      // a short band (B's post-answer strip): the "Each dot is…" caption steps aside so it never sits on the HUD
      setDs(band, 'short', hh < 132 ? 'yes' : '');
      canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);   // CSS sizes the element (100%)
      try { c2d.direction = 'ltr'; c2d.font = MONO10; } catch { /* ignore */ }
      if (fresh) { /* measured at this size in the observer callback */ }
      else if (known && chrome.legendTop) chrome = { ...chrome, legendTop: chrome.legendTop + dH };
      else measureChrome();
      chromeFor = '';
      relayout(true);
      if (red) snapAll();
      dirty = true;
      kick();
    }

    // ---- layout: per-file clusters on a golden-angle spiral, relaxed apart, fitted to the stage.
    // A short band (the 56 px ribbon, its retrieval peek, or a band squeezed under ~170 px) lays the clusters out
    // left → right across the whole free width instead, so they never stack into one clump.
    function layout() {
      // every file in flight gets a place from second 1 (a progress node until its first atoms are counted)
      const live = recs.filter((r) => r.atoms > 0 || r.dots.length || !r.failed);
      if (!W || !H) return;
      const mob = isMobile();
      const hudB = Math.min(H * 0.5, chrome.hudBottom || 36);
      const legT = clamp(chrome.legendTop || H, hudB + 20, H);
      // phones keep the left → right strip in their (taller, while learning) band: names live in the legend row
      strip = mode === 'ribbon' || H < 170 || (mob && H < 240);
      if (strip) {
        let x0, x1, y0, y1;
        if (mode === 'ribbon' && !peek) {
          // dots live to the right of the HUD text and the compact legend, left of the buttons
          x0 = Math.max(chrome.hudRight || 0, chrome.legendRight || 0) + 16;
          x1 = (chrome.hudRLeft || W) - 14;
          // inset by the dot radius plus its halo: no dot is ever cut by the ribbon's top or bottom edge
          y0 = 13; y1 = H - 12;
          if (x1 - x0 < 60) { x0 = Math.max(8, x1 - 60); }
        } else {
          x0 = mob ? 12 : 20; x1 = W - (mob ? 12 : 20);
          y0 = hudB + 8; y1 = legT - (mode === 'full' && legT - hudB > 74 ? 22 : 6);
          if (y1 - y0 < 16) { y0 = Math.max(4, hudB); y1 = Math.max(y0 + 16, legT - 2); }
          if (lanes.t && y1 - lanes.t >= 22) y0 = Math.max(y0, lanes.t);
        }
        area = { x0, y0, x1, y1 };
        const tot = live.reduce((acc, r) => acc + Math.sqrt(Math.max(r.atoms, 8)), 0) || 1;
        const gap = live.length > 1 ? Math.min(18, (x1 - x0) * 0.04) : 0;
        const span = Math.max(20, x1 - x0 - gap * Math.max(0, live.length - 1));
        // a cluster never stretches into a thin streak: cap its width by its height, centre the group
        const maxW = Math.max(120, (y1 - y0) * 6);
        const widths = live.map((r) => Math.min(maxW, Math.max(16, span * Math.sqrt(Math.max(r.atoms, 8)) / tot)));
        const used = widths.reduce((acc, v) => acc + v, 0) + gap * Math.max(0, live.length - 1);
        let x = x0 + Math.max(0, (x1 - x0 - used) / 2);
        for (const [n, r] of live.entries()) {
          const w = widths[n];
          r.seg = { x, y: y0, w, h: y1 - y0 };
          r.cx = x + w / 2; r.cy = (y0 + y1) / 2; r.rad = Math.min(w, y1 - y0) / 2;
          x += w + gap;
        }
      } else {
        const padT = Math.max(hudB + 10, lanes.t ? lanes.t + 6 : 0), padB = H - legT + 22, padX = mob ? 18 : 26;
        const padXL = padX + lanes.l, padXR = padX + lanes.r;
        area = { x0: 4, y0: hudB + 2, x1: W - 4, y1: legT - 2 };
        // abstract units: radius = sqrt(atoms)
        // a floor on cluster size: next to a 20k-atom file a 2-atom file is still a visible cluster, not a speck
        const minRad = Math.sqrt(Math.max(6, live.reduce((acc, q) => acc + Math.max(0, q.atoms), 0))) * 0.17;
        const P = live.map((r, i) => {
          const rad = Math.max(Math.sqrt(Math.max(r.atoms, 6)), minRad);
          const ang = i * GOLDEN;
          const d = i === 0 ? 0 : 1.15 * Math.sqrt(i) * (rad + 6);
          return { r, rad, x: Math.cos(ang) * d * 1.9, y: Math.sin(ang) * d * 0.9 };
        });
        for (let it = 0; it < 80; it++) {
          let moved = false;
          for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) {
            const A = P[a], B = P[b];
            let dx = B.x - A.x, dy = B.y - A.y;
            const d = Math.hypot(dx, dy) || 0.01;
            const min = A.rad + B.rad + 8;
            if (d < min) { const push = (min - d) / 2; dx /= d; dy /= d; A.x -= dx * push; A.y -= dy * push; B.x += dx * push; B.y += dy * push; moved = true; }
          }
          for (const p of P) { p.x *= 0.99; p.y *= 0.975; }
          if (!moved && it > 10) break;
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of P) { minX = Math.min(minX, p.x - p.rad); maxX = Math.max(maxX, p.x + p.rad); minY = Math.min(minY, p.y - p.rad); maxY = Math.max(maxY, p.y + p.rad); }
        const aw = Math.max(40, W - padXL - padXR), ah = Math.max(30, H - padT - padB);
        const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        // small corpora get generous clusters (a 16-atom file still reads as a cluster, not a speck)
        const maxScale = (mob ? 6.2 : 11.5) / Math.sqrt(k);
        const sc = P.length ? Math.min(aw / bw, ah / bh, maxScale) : 1;
        const cx0 = padXL + aw / 2 - ((minX + maxX) / 2) * sc, cy0 = padT + ah / 2 - ((minY + maxY) / 2) * sc;
        for (const p of P) { p.r.cx = cx0 + p.x * sc; p.r.cy = cy0 + p.y * sc; p.r.rad = p.rad * sc; p.r.seg = null; }
      }
      for (const r of recs) {
        // a big file reads as structure, not noise: its atoms sit in sequence-order sections (sub-clusters)
        const nd = Math.ceil(Math.max(0, r.atoms) / k);
        r.S = (!strip && nd >= 240) ? clamp(Math.round(nd / 180), 3, 8) : 0;
        r.sec = r.S ? sectionGeo(r.S) : null;
        r.secPhase = (hash32(`p:${r.key}`) % 628) / 100;
        for (const i of r.dots) { const t = targetOf(r, SEQ[i]); TX[i] = t.x; TY[i] = t.y; }
        // ring slots for counted atoms (cached: draw never hashes)
        const nj = Math.ceil(Math.max(0, r.atoms) / k);
        if (!r.ring || r.ring.length < nj * 2) r.ring = new Float32Array(Math.max(nj * 2, 16));
        const njChanged = r.nj !== nj;
        r.nj = nj;
        for (let j = 0; j < nj; j++) { const t = targetOf(r, j * k); r.ring[j * 2] = t.x; r.ring[j * 2 + 1] = t.y; }
        // the file's static layer follows its geometry: moved targets repaint it (hard), new rings extend it (soft)
        const sg = r.seg ? `${Math.round(r.seg.x * 4)},${Math.round(r.seg.y * 4)},${Math.round(r.seg.w * 4)},${Math.round(r.seg.h * 4)}` : '';
        const sig = `${Math.round((r.cx || 0) * 4)}|${Math.round((r.cy || 0) * 4)}|${Math.round((r.rad || 0) * 4)}|${sg}|${r.S}|${k}|${r.S ? r.atoms : 0}|${r.secPhase}`;
        if (sig !== r.lySig) { r.lySig = sig; lyStart(r, true); } else if (njChanged) lyStart(r, false);
      }
      placeLabels(live, hudB, legT);
      dirty = true;
    }
    // Cluster labels (11 px, on a contrast backdrop): biggest clusters first; each tries below / above / right / left
    // (then the diagonals) of its cluster, each nudged up / down by a line height when the first spot is taken. A
    // label must stay between the HUD and the legend row, clear of every other label, of every cluster's dot disc
    // (a label never sits on dots) and of a running shatter. A label that fits nowhere is hidden (the rows and the
    // legend still name the file). Phones put names in the legend row only (no floating labels on a 140 px map).
    // A file still being read gets a second line: its real first lines of text, cycling, with a scan sweep.
    function placeLabels(live, hudB, legT) {
      labelArgs = [hudB, legT];
      const placed = [];
      for (const r of recs) { r.lab = null; r.secLabs = null; }
      if ((mode === 'ribbon' && !peek) || isMobile()) return;
      const occ = [...occl.values()];
      if (lanes.l) occ.push({ x: -4, y: 0, w: lanes.l + 4, h: H });
      if (lanes.r) occ.push({ x: W - lanes.r, y: 0, w: lanes.r + 4, h: H });
      if (lanes.t) occ.push({ x: 0, y: 0, w: W, h: lanes.t });
      const G = 3;
      const hit = (a, b) => a.x < b.x + b.w + G && a.x + a.w + G > b.x && a.y < b.y + b.h + G && a.y + a.h + G > b.y;
      const hitsOcc = (b) => occ.some((o) => hit(b, o));
      const hitsLabel = (b) => placed.some((p) => hit(b, p));
      // fixer M r1 (D4/D7): a wider keep-out (+7 px) so a label never sits on a neighbour cluster's outer dots
      const discs = live.map((q) => ({ x: q.cx, y: q.cy, r: (q.seg ? Math.min(q.seg.w, q.seg.h) / 2 : isPre(q) ? preR(q) : q.rad) + 7 }));
      const hitsDisc = (b) => discs.some((d) => {
        const nx = clamp(d.x, b.x, b.x + b.w), ny = clamp(d.y, b.y, b.y + b.h);
        return (nx - d.x) ** 2 + (ny - d.y) ** 2 < d.r * d.r;
      });
      const top = hudB + 4, bot = legT - 2;
      const order = live.slice().sort((a, b) => b.atoms - a.atoms || a.order - b.order);
      const textFor = (r, name) => (isPre(r) ? `${name} · ${DOING[r.phase] || 'reading'}` : `${name} · ${fmtInt(Math.max(r.atoms, 0))}`);
      for (const r of order) {
        let name = mid(r.name, 30);
        let text = textFor(r, name);
        let w = Math.ceil(textWidth(text, MONO11)) + 12;
        if (strip && r.seg) {
          // one label row under the strip; shorten the name to the segment width
          for (let n = name.length; w > r.seg.w + 6 && n > 8; n -= 2) { name = mid(r.name, n); text = textFor(r, name); w = Math.ceil(textWidth(text, MONO11)) + 12; }
          if (w > r.seg.w + 6) { text = isPre(r) ? (DOING[r.phase] || '') : fmtInt(r.atoms); w = Math.ceil(textWidth(text, MONO11)) + 12; }
          const b = { x: clamp(r.cx - w / 2, 4, Math.max(4, W - w - 4)), y: r.seg.y + r.seg.h + 2, w, h: 16 };
          if (b.y + b.h <= bot + 3 && !hitsLabel(b) && !hitsOcc(b)) { r.lab = { ...b, text }; placed.push(b); }
          continue;
        }
        const lines = isPre(r) && r.readLines && r.readLines.length ? r.readLines : null;
        let lw = 0;
        if (lines) lw = Math.min(236, Math.ceil(Math.max(...lines.map((l) => textWidth(l, SANS11)))) + 14);
        w = Math.max(w, lw);
        const hh = lines ? 32 : 16;
        const R = (isPre(r) ? preR(r) : r.rad) + 6;
        const cands = [
          [r.cx - w / 2, r.cy + R], [r.cx - w / 2, r.cy - R - hh],
          [r.cx + R, r.cy - hh / 2], [r.cx - R - w, r.cy - hh / 2],
          [r.cx + R * 0.72, r.cy + R * 0.72], [r.cx - R * 0.72 - w, r.cy + R * 0.72],
          [r.cx + R * 0.72, r.cy - R * 0.72 - hh], [r.cx - R * 0.72 - w, r.cy - R * 0.72 - hh],
        ];
        const nudges = [0, 18, -18, 36, -36];
        let done = false;
        for (const dy of nudges) {
          for (const [cx, cy] of cands) {
            const b = { x: clamp(cx, 4, Math.max(4, W - w - 4)), y: cy + dy, w, h: hh };
            if (b.y < top || b.y + b.h > bot) continue;
            if (hitsLabel(b) || hitsDisc(b) || hitsOcc(b)) continue;
            r.lab = { ...b, text, lines };
            placed.push(b); done = true;
            break;
          }
          if (done) break;
        }
        // no room for the reading line: the plain one-line label alone, anywhere it fits
        if (!done && lines) {
          for (const dy of nudges) {
            for (const [cx, cy] of cands) {
              const w1 = Math.ceil(textWidth(text, MONO11)) + 12;
              const b = { x: clamp(cx, 4, Math.max(4, W - w1 - 4)), y: cy + dy, w: w1, h: 16 };
              if (b.y < top || b.y + b.h > bot || hitsLabel(b) || hitsDisc(b) || hitsOcc(b)) continue;
              r.lab = { ...b, text, lines: null }; placed.push(b); done = true; break;
            }
            if (done) break;
          }
        }
        // still nowhere: only a running shatter is in the way -> the label stays, faded to 40% under it (round-5
        // critic: a hidden label read as a file gone missing), never on dots or on another label
        if (!done && occl.size && !lanes.l && !lanes.r && !lanes.t) {
          const w1 = Math.ceil(textWidth(text, MONO11)) + 12;
          for (const dy of nudges) {
            for (const [cx, cy] of cands) {
              const b = { x: clamp(cx, 4, Math.max(4, W - w1 - 4)), y: cy + dy, w: w1, h: 16 };
              if (b.y < top || b.y + b.h > bot || hitsLabel(b) || hitsDisc(b)) continue;
              r.lab = { ...b, text, lines: null, under: true }; placed.push(b); done = true; break;
            }
            if (done) break;
          }
        }
      }
      // section labels: the 3 named sections of each big cluster (first, middle, last in reading order), on a
      // backdrop just under their sub-cluster; dropped when they would collide with any other label
      for (const r of order) {
        if (!r.S || !r.secNames || !r.secNames.length || (r.rad || 0) < 46) continue;
        const out = [];
        for (const sn of r.secNames) {
          if (out.length >= 3) break;
          const sct = Math.min(r.S - 1, Math.floor((sn.seq / Math.max(1, r.atoms)) * r.S));
          if (out.some((o) => o.s === sct)) continue;
          const c = secCenter(r, sct);
          const text = `§ ${sn.text}`;
          // one label per distinct heading (a 20k-atom file's sections often share one)
          if (out.some((o) => o.text === text)) continue;
          const w = Math.ceil(textWidth(text, MONO11)) + 12;
          // outside the cluster's hull, out along the line from its centre through the section (never on its dots)
          let th = Math.atan2(c.y - r.cy, c.x - r.cx);
          if (Math.hypot(c.y - r.cy, c.x - r.cx) < 2) th = -Math.PI / 2;
          const cands = [];
          for (const dth of [0, 0.35, -0.35, 0.7, -0.7]) {
            const ca = Math.cos(th + dth), sa = Math.sin(th + dth), rd = (r.rad || 0) + 8;
            const px = r.cx + ca * rd, py = r.cy + sa * rd;
            cands.push([ca >= 0.3 ? px : ca <= -0.3 ? px - w : px - w / 2, sa >= 0.3 ? py : sa <= -0.3 ? py - 16 : py - 8]);
          }
          for (const [xx, yy] of cands) {
            const b = { x: clamp(xx, 4, Math.max(4, W - w - 4)), y: yy, w, h: 16 };
            if (b.y < top || b.y + b.h > bot || hitsLabel(b) || hitsOcc(b) || hitsDisc(b)) continue;
            out.push({ s: sct, ...b, text }); placed.push(b);
            break;
          }
        }
        r.secLabs = out.length ? out : null;
      }
    }
    function relabel() { if (labelArgs) { placeLabels(recs.filter((r) => r.atoms > 0 || r.dots.length || !r.failed), labelArgs[0], labelArgs[1]); dirty = true; kick(); } }
    // Vogel-spiral sub-cluster centres in the unit disc, scaled so every sub-disc stays inside it (cached per S)
    const secCache = new Map();
    function sectionGeo(S) {
      let g = secCache.get(S);
      if (g) return g;
      const P = Array.from({ length: S }, (_, s) => { const rr = Math.sqrt((s + 0.5) / S), a = s * GOLDEN; return { x: Math.cos(a) * rr, y: Math.sin(a) * rr }; });
      let nn = Infinity;
      for (let a = 0; a < S; a++) for (let b = a + 1; b < S; b++) nn = Math.min(nn, Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y));
      // sub-clusters keep a visible gutter between them: a big file reads as several dense topics, not one oval
      const rs = nn * 0.46;
      const outer = Math.max(...P.map((p) => Math.hypot(p.x, p.y))) + rs;
      g = { c: P.map((p) => ({ x: p.x / outer, y: p.y / outer })), rs: rs / outer };
      secCache.set(S, g);
      return g;
    }
    function unitToStage(r, ux, uy) {
      if (r.seg) return { x: r.seg.x + r.seg.w / 2 + ux * (r.seg.w / 2 - 2), y: r.seg.y + r.seg.h / 2 + uy * (r.seg.h / 2 - 2) };
      const R = r.rad || 10;
      return { x: (r.cx || W / 2) + ux * R, y: (r.cy || H / 2) + uy * R };
    }
    function secCenter(r, s) {
      const g = r.sec, c = g.c[s], ph = r.secPhase || 0;
      const ux = c.x * Math.cos(ph) - c.y * Math.sin(ph), uy = c.x * Math.sin(ph) + c.y * Math.cos(ph);
      const p = unitToStage(r, ux, uy);
      return { x: p.x, y: p.y, rs: g.rs * (r.rad || 10) };
    }
    // the per-atom hash only depends on (file, seq): cached, so a relayout is arithmetic, never string hashing
    function hashOf(r, seq) {
      let hc = r.hc;
      if (!hc || seq >= hc.length) {
        const n = Math.max(64, seq + 1, hc ? hc.length * 2 : 0);
        const nh = new Float64Array(n).fill(-1);
        if (hc) nh.set(hc);
        r.hc = hc = nh;
      }
      let v = hc[seq];
      if (v < 0) { v = hash32(`${r.key}:${seq}`); hc[seq] = v; }
      return v;
    }
    function targetOf(r, seq) {
      const hsh = hashOf(r, seq);
      const u = (hsh & 0xffff) / 65536, v = ((hsh >>> 16) & 0xffff) / 65536;
      const a = u * Math.PI * 2;
      let ux, uy;
      if (r.sec && r.atoms > 0) {
        // sequence order: atom #seq lives in section floor(seq / atoms · S), jittered inside that sub-disc
        const s = Math.min(r.S - 1, Math.floor((seq / r.atoms) * r.S));
        const g = r.sec, c = g.c[s], ph = r.secPhase || 0;
        const cx = c.x * Math.cos(ph) - c.y * Math.sin(ph), cy = c.x * Math.sin(ph) + c.y * Math.cos(ph);
        // a dense core with a soft edge (radius ~ v^0.68, not the area-uniform v^0.5)
        const rr = Math.pow(v, 0.68) * g.rs;
        ux = cx + Math.cos(a) * rr; uy = cy + Math.sin(a) * rr;
      } else {
        // an (elliptical, in a strip segment) density blob: denser core, soft edge, never a uniform disc
        const rr = Math.pow(v, 0.62);
        ux = Math.cos(a) * rr; uy = Math.sin(a) * rr;
      }
      return unitToStage(r, ux, uy);
    }
    function setLanes(l = 0, r = 0, t = 0) {
      l = Math.round(l); r = Math.round(r); t = Math.round(t);
      if (lanes.l === l && lanes.r === r && lanes.t === t) return;
      lanes = { l, r, t };
      relayout(true);
      if (red) snapAll();
      kick();
    }
    function getLanes() { return { ...lanes }; }
    // live(): true while the overlay moves (the map redraws every frame); a still overlay is repainted only when the
    // map redraws anyway (packed chips waiting for the next real stage cost nothing per frame)
    function setOverlay(id, fn, live = () => true) { if (fn) overlays.set(id, { fn, live }); else if (!overlays.delete(id)) return; dirty = true; kick(); }
    function overlayLive() { for (const o of overlays.values()) if (o.live()) return true; return false; }
    function setOccluder(id, rect) {
      if (rect) occl.set(id, rect); else if (!occl.delete(id)) return;
      relabel();
    }
    function muteLabel(key, on) { const r = recByKey.get(key); if (r && r.muted !== !!on) { r.muted = !!on; r.mutedT = performance.now(); dirty = true; kick(); } }
    function setSectionNames(key, names) { const r = recByKey.get(key); if (r) { r.secNames = names; relabel(); } }
    /** The file's real first lines (from its own text), shown under its ring while it is extracted. */
    function setReading(key, lines) { const r = recByKey.get(key); if (r && (r.readLines || []).join('\n') !== (lines || []).join('\n')) { r.readLines = lines && lines.length ? lines.slice(0, 3) : null; relabel(); } }
    /** Dot mass on the left / right half of the map (where a shatter's chips would cover the fewest dots). */
    function halfMass() {
      let l = 0, rr = 0;
      for (const r of recs) { if (!r.cx) continue; const m = Math.max(8, r.atoms) * (r.dots.length || isPre(r) ? 1 : 0.3); if (r.cx < W / 2) l += m; else rr += m; }
      return { left: l, right: rr };
    }
    function sectionSeqs(key) {
      const r = recByKey.get(key);
      if (!r || !r.S || !r.atoms) return null;
      const S = r.S, pick = S >= 3 ? [0, Math.floor((S - 1) / 2), S - 1] : [0];
      return pick.map((s) => Math.min(r.atoms - 1, Math.ceil((s * r.atoms) / S)));
    }
    // ---- file sync (atoms, vectorized, enabled) → births at the real rate
    function sync(files) {
      let total = 0;
      let readChanged = false;
      const seen = new Set();
      files.forEach((f, idx) => {
        const key = f.id || f.localId;
        seen.add(key);
        let r = recByKey.get(key);
        if (!r) {
          r = { key, localId: f.localId, fileId: f.id, idx: recs.length, hue: f.hue || 0, name: f.name, atoms: 0, want: 0, dots: [], bySeq: new Map(),
            pending: 0, rate: 0, acc: 0, hold: false, reserved: new Set(), cx: 0, cy: 0, rad: 10, label: 0, labelT: 0, halo: 0, enabled: true, ready: false, failed: false, instant: false };
          recs.push(r); recByKey.set(key, r);
          if (f.localId) recByKey.set(f.localId, r);
        }
        if (f.id && r.fileId !== f.id) { r.fileId = f.id; recByKey.set(f.id, r); }
        r.order = idx; r.name = f.name; r.hue = f.hue || 0;
        const prevAtoms = r.atoms;
        // a failed file holds no dots and no ring: its partial atoms are not searchable, so the map never shows them
        r.atoms = f.phase === 'failed' ? 0 : Math.max(0, Number(f.atoms) || 0);
        if (f.phase === 'failed' && (r.dots.length || r.pending)) { dropDots(r); dirty = true; }
        const wasReady = r.ready;
        r.ready = f.phase === 'ready';
        if (r.ready && !wasReady) {
          // Ready: the cluster label fades in (instant for restored files and under reduced motion); one halo pulse
          const now = performance.now();
          if (!r.labelT) r.labelT = (red || restored.has(f.localId)) ? -1e9 : now + 200;
          if (!red && !restored.has(f.localId) && !r.halo) r.halo = now + 150;
        }
        r.failed = f.phase === 'failed';
        r.phase = f.phase;
        // real progress for the pre-atom node: upload bytes, then the stages that really happened
        r.prog = fileProgress(f);
        r.enabled = isEnabled(f);
        r.instant = r.instant || restored.has(f.localId);
        const rl = reading.get(f.localId) || null;
        if (rl !== r.readSrc) { r.readSrc = rl; r.readLines = rl ? rl.slice(0, 3) : null; readChanged = true; }
        // Born dots follow the real vectorized count. Under reduced motion every counted atom is painted at once
        // (static), so the map never says less than the HUD and the rows.
        const real = r.ready ? r.atoms : (red && RANK[f.phase] >= RANK.atomized) ? r.atoms : (f.phase === 'vectorizing' || f.phase === 'atomized') ? Math.min(Number(f.vectorized) || 0, r.atoms) : 0;
        r.real = real;
        if (prevAtoms !== r.atoms) dirty = true;
        total += r.atoms;
      });
      // files that disappeared (removed): drop their dots
      for (const r of recs.slice()) if (!seen.has(r.key)) removeRec(r);
      wantTotal = recs.reduce((acc, r) => acc + Math.ceil(Math.max(0, r.atoms) / k), 0);
      recs.sort((a, b) => a.order - b.order);
      recs.forEach((r, i) => { r.idx = i; });
      for (let i = 0; i < N; i++) { const r = recByKey.get(fiKey[FI[i]]); if (r) FI[i] = r.idx; }
      refreshFiKeys();
      // dot scale: above the cap one dot stands for k atoms
      const capNow = (isMobile() || lowDetail()) ? MAX_DOTS_LOW : cap;
      const nk = Math.max(1, Math.ceil(total / capNow));
      if (nk !== k) { k = nk; rebuildAll(); }
      for (const r of recs) {
        const want = Math.ceil(r.real / k);
        r.wantDots = want;
        const queued = r.dots.length + r.pending;
        if (want > queued) {
          const delta = want - queued;
          if (r.instant || red) birthNow(r, delta);
          else { r.pending += delta; r.rate = Math.max(r.rate * 0.5, r.pending / 1.5); }
        }
      }
      relayout();
      if (readChanged) relabel();
      for (let i = 0; i < N; i++) { const r = recs[FI[i]]; BAND[i] = r && r.enabled ? 1 : 0.05; }
      // dev check (?debug=1): dotCount never exceeds the atoms the file really has; a failed file holds none
      if (DBG) { const bad = dotCheck(); if (bad) console.warn('[ingest] dot check failed', JSON.stringify(bad)); }
      dirty = true;
      kick();
      return total;
    }
    // Layout only when something it depends on changed (an event that only moves `vectorized` costs nothing).
    // Structural changes (size, mode, a new file, a file's first atoms) lay out now; a count that merely grew is
    // laid out once per batch in an idle callback, never inside the frame loop.
    let layoutSig = '', shapeSig = '', idleLayout = 0;
    let wantTotal = 0;
    function relayout(force = false) {
      const shape = `${W}x${H}|${mode}|${peek}|${k}|${lanes.l},${lanes.r},${lanes.t}|${recs.map((r) => `${r.key}:${r.atoms > 0 || r.dots.length ? 1 : 0}:${r.failed ? 'x' : isPre(r) ? r.phase : ''}`).join(',')}`;
      const sig = `${shape}|${recs.map((r) => r.atoms).join(',')}`;
      if (!force && sig === layoutSig) return;
      if (!force && shape === shapeSig) {
        if (!idleLayout) idleLayout = ric(() => { idleLayout = 0; if (!destroyed) relayout(true); }, 180);
        return;
      }
      layoutSig = `${shape}|${recs.map((r) => r.atoms).join(',')}`; shapeSig = shape;
      layout();
    }
    let fiKey = [];
    function refreshFiKeys() { fiKey = recs.map((r) => r.key); }
    function removeRec(r) {
      const keep = [];
      for (let i = 0; i < N; i++) if (recs[FI[i]] !== r) keep.push(i);
      compact(keep);
      recs.splice(recs.indexOf(r), 1);
      for (const [kk, v] of [...recByKey]) if (v === r) recByKey.delete(kk);
      if (highlight && highlight.r === r) highlight = null;
      if (retrieval) endRetrieval();
    }
    function dropDots(r) {
      const keep = [];
      for (let i = 0; i < N; i++) if (recs[FI[i]] !== r) keep.push(i);
      compact(keep);
      r.pending = 0; r.acc = 0; r.reserved.clear(); r.cursor = 0;
      if (highlight && highlight.r === r) highlight = null;
      if (r.ly) lyStart(r, true);
      if (retrieval) endRetrieval();
    }
    function compact(keep) {
      const fields = [X, Y, TX, TY, VX, VY, GLOW, ALPHA, BORN, R0, BAND, SEQ, FI, INL];
      keep.forEach((src, dst) => { if (src !== dst) for (const a of fields) a[dst] = a[src]; });
      N = keep.length;
      for (const r of recs) { r.dots = []; r.bySeq.clear(); }
      for (let i = 0; i < N; i++) { const r = recs[FI[i]]; if (r) { r.dots.push(i); r.bySeq.set(SEQ[i], i); } }
      hover = -1;
    }
    function rebuildAll() {
      // dot scale changed: re-seed every file from its current count (positions re-spring from their centers)
      for (const r of recs) { r.prevBorn = r.dots.length * (r.k || 1); r.dots = []; r.bySeq.clear(); r.pending = 0; r.k = k; }
      N = 0;
      for (const r of recs) { const n = Math.ceil(Math.min(r.prevBorn, r.real) / k); birthNow(r, n, true); }
      for (const r of recs) lyStart(r, true);
      hudScale.hidden = k <= 1;
      hudScale.textContent = k > 1 ? `· 1 dot = ${k} atoms` : '';
    }
    function nextSeqDot(r) {
      // lowest dot index not yet born and not reserved by a running shatter
      let j = r.cursor || 0;
      while (r.bySeq.has(j * k) || r.reserved.has(j)) j++;
      r.cursor = j;
      return j;
    }
    function birth(r, j, x, y, { big = false, still = false } = {}) {
      const seq = j * k;
      if (r.bySeq.has(seq)) return r.bySeq.get(seq);
      // one dot per atom (k atoms per dot above the cap), never more: a seq past the file's count is refused
      const nj0 = Math.ceil(Math.max(r.atoms, r.real) / k);
      if (r.failed || (nj0 && (j >= nj0 || r.dots.length >= nj0))) return -1;
      grow(N + 1);
      const i = N++;
      const t = targetOf(r, seq);
      X[i] = x ?? r.cx; Y[i] = y ?? r.cy; TX[i] = t.x; TY[i] = t.y;
      const a = (hash32(`v:${r.key}:${seq}`) & 0xffff) / 65536 * Math.PI * 2;
      VX[i] = still ? 0 : Math.cos(a) * 60; VY[i] = still ? 0 : Math.sin(a) * 60;
      GLOW[i] = 0; ALPHA[i] = 1; BORN[i] = still ? -1e9 : performance.now(); R0[i] = big ? 3 : 0; SEQ[i] = seq; FI[i] = r.idx; INL[i] = 0;
      BAND[i] = r.enabled ? 1 : 0.05;
      if (red || still) { X[i] = TX[i]; Y[i] = TY[i]; VX[i] = VY[i] = 0; }
      r.dots.push(i); r.bySeq.set(seq, i);
      dirty = true;
      return i;
    }
    // the lowest free dot slot, or -1 when every slot of the file is born or reserved by a running shatter (the
    // reserved ones land with their chips: a rate birth must never take a slot past the file's count instead)
    function freeSlot(r) {
      const j = nextSeqDot(r);
      const nj0 = Math.ceil(Math.max(r.atoms, r.real) / k);
      return nj0 && j >= nj0 ? -1 : j;
    }
    function birthNow(r, n, still = false) {
      for (let c = 0; c < n; c++) {
        if (r.hold) { r.pending++; continue; }
        const j = freeSlot(r);
        if (j < 0 || birth(r, j, null, null, { still: still || r.instant || red }) < 0) { if (r.reserved.size) r.pending++; continue; }
      }
    }

    // ---- public API used by shatter
    function targetFor(key, seq) {
      const r = recByKey.get(key);
      if (!r) return null;
      const j = Math.floor((Number(seq) || 0) / k);
      const t = targetOf(r, j * k);
      return { x: t.x, y: t.y };
    }
    function spawn(key, seq, x, y) {
      const r = recByKey.get(key);
      if (!r) return -1;
      const j = Math.floor((Number(seq) || 0) / k);
      r.reserved.delete(j);
      const i = birth(r, j, x, y, { big: true });
      if (i >= 0) { VX[i] = 0; VY[i] = 0; if (r.pending > 0) r.pending--; }
      kick();
      return i;
    }
    function hold(key, on) { const r = recByKey.get(key); if (r) { r.hold = !!on; kick(); } }
    function reserve(key, seqs) { const r = recByKey.get(key); if (!r) return; for (const s of seqs) { const j = Math.floor(s / k); if (!r.bySeq.has(j * k)) r.reserved.add(j); } }
    function release(key, instant = false) {
      const r = recByKey.get(key);
      if (!r) return;
      r.reserved.clear(); r.hold = false; r.cursor = 0;
      const missing = Math.max(0, (r.wantDots || 0) - r.dots.length - r.pending);
      if (instant || red) { const n = r.pending + missing; r.pending = 0; birthNow(r, n); }
      else if (missing) { r.pending += missing; r.rate = Math.max(r.rate, r.pending / 1.5); }
      kick();
    }
    function halo(key) { const r = recByKey.get(key); if (r) { r.halo = performance.now(); r.labelT = performance.now(); kick(); } }
    function showLabel(key) { const r = recByKey.get(key); if (r && !r.labelT) { r.labelT = red ? -1e9 : performance.now(); kick(); } }
    function stageOffset() { return { x: 0, y: 0 }; }

    // ---- retrieval playback (runs inside C's 'retrieval' signature slot; D never claims a second slot)
    function playRetrieval(d) {
      if (!d || !Array.isArray(d.hits)) return;
      let floor = Number(d.floor); if (!Number.isFinite(floor)) floor = (getState().spec.floor || 0.7); if (floor > 1) floor /= 100;
      const hits = [];
      d.hits.forEach((hh, rank) => {
        const r = recByKey.get(hh.fileId);
        if (!r) return;
        let i = -1;
        if (hh.seq != null && Number.isFinite(Number(hh.seq))) i = r.bySeq.get(Math.floor(Number(hh.seq) / k) * k) ?? -1;
        if (i < 0 && hh.atomId) { const j = Math.floor((hash32(hh.atomId) % Math.max(1, r.dots.length))); i = r.dots[j] ?? -1; }
        if (i < 0) return;
        let sim = hh.similarity == null ? null : Number(hh.similarity); if (sim != null && sim > 1) sim /= 100;
        hits.push({ i, sim, kept: !!hh.kept, cited: !!hh.cited, rank });
      });
      const same = retrieval && retrieval.answerId === d.answerId;
      if (same) {
        // final for the same answer: refresh cited/kept, play the refusal dim if it refused
        retrieval.hits = hits.length ? hits : retrieval.hits;
        if (d.refused && !retrieval.refused) { retrieval.refused = true; retrieval.dimT = performance.now(); }
        dirty = true; kick();
        return;
      }
      const kept = hits.filter((x) => x.kept);
      const refused = !!d.refused || !kept.length;
      let px = W / 2, py = H / 2;
      const src = kept.length ? kept : hits;
      if (src.length) {
        let sw = 0, sx = 0, sy = 0;
        // targets, not current positions: a peek may have just re-laid the clusters out and the dots are springing there
        for (const x of src) { const w = Math.max(0.05, x.sim ?? 0.5); sw += w; sx += TX[x.i] * w; sy += TY[x.i] * w; }
        px = sx / sw; py = sy / sw;
      }
      let far = 40;
      for (const x of hits) far = Math.max(far, Math.hypot(TX[x.i] - px, TY[x.i] - py));
      if (refused) far = Math.max(far, Math.min(W, H) * 0.45);
      retrieval = { answerId: d.answerId, t0: performance.now(), px, py, R: far * 1.6, hits, floor, refused, dimT: refused ? performance.now() : 0, relaxT: 0 };
      hideTip();
      dirty = true; kick();
    }
    function relax() { if (retrieval && !retrieval.relaxT) { retrieval.relaxT = performance.now(); kick(); } }
    // the peek's DOM work runs in a task after the frame, never inside the map's rAF callback
    function endRetrieval() { retrieval = null; if (onRetrievalEnd) { const fn = onRetrievalEnd; setTimeout(() => fn(), 0); } }
    function isRetrieving() { return !!retrieval; }
    function fastForward() { if (retrieval) { retrieval.t0 -= 3000; retrieval.ff = true; dirty = true; kick(); } }
    function setHighlight(d) {
      if (!d) { highlight = null; dirty = true; kick(); return; }
      const r = recByKey.get(d.fileId);
      if (!r) { highlight = null; return; }
      let i = d.seq != null ? (r.bySeq.get(Math.floor(Number(d.seq) / k) * k) ?? -1) : -1;
      if (i < 0 && d.atomId && r.dots.length) i = r.dots[hash32(d.atomId) % r.dots.length];
      let ex = null, ey = null;
      if (i >= 0 && d.rect) {
        // one layout read here, never per frame
        const sr = canvas.getBoundingClientRect();
        ex = clamp(d.rect.left + d.rect.width / 2 - sr.left, 2, W - 2); ey = clamp(d.rect.top + d.rect.height / 2 - sr.top, 2, H - 2);
      }
      highlight = i >= 0 ? { i, r, ex, ey, t0: performance.now() } : null;
      dirty = true; kick();
    }

    // ---- static layers (one offscreen canvas per file): settled dots + not-yet-vectorized rings, painted once
    function lyBox(r) {
      const pad = (lastBaseR || 2.7) + 7;
      if (r.seg) return { x0: Math.floor(r.seg.x - pad), y0: Math.floor(r.seg.y - pad), w: Math.ceil(r.seg.w + pad * 2), h: Math.ceil(r.seg.h + pad * 2) };
      const R = (r.rad || 10) + pad;
      return { x0: Math.floor((r.cx || 0) - R), y0: Math.floor((r.cy || 0) - R), w: Math.ceil(R * 2), h: Math.ceil(R * 2) };
    }
    function lyCanvas(L, n, box) {
      let c = L.c[n];
      if (!c) { c = L.c[n] = document.createElement('canvas'); L.g[n] = c.getContext('2d'); }
      const pw = Math.max(1, Math.ceil(box.w * DPR)), ph = Math.max(1, Math.ceil(box.h * DPR));
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; } else L.g[n].clearRect(0, 0, pw, ph);
      L.g[n].setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    /** (Re)build a file's layer. hard: clear what is on screen now (targets moved: every dot springs live until it
     *  settles again); soft: keep showing the current layer and swap when the new one is complete (theme, ring
     *  cleanup). The build itself is time-sliced (lyBuild) so it never makes one long frame. */
    function lyStart(r, hard) {
      if (!W || !H || !r) { if (r) r.ly = null; return; }
      const box = lyBox(r);
      let L = r.ly;
      if (!L) L = r.ly = { c: [null, null], g: [null, null], f: 0, x0: 0, y0: 0, w: 0, h: 0, dpr: 0, bj: 0, building: false, rings: false, drewRing: false };
      const moved = L.x0 !== box.x0 || L.y0 !== box.y0 || L.w !== box.w || L.h !== box.h || L.dpr !== DPR;
      if (hard || moved) {
        if (!red && L.has && L.c[L.f] && L.w && r.dots.length) {
          // FLIP the cluster, not its dots (round-5: clusters jumped when the last file landed, and a relayout sent
          // every settled dot live -> one drawImage per atom per frame). The old bitmap glides from its old box to
          // the new one (one blit per file per frame) while the new layer builds behind it; settled dots snap to
          // their new targets and stay painted.
          const now0 = performance.now();
          if (r.gh) {
            // a relayout while the cluster is still gliding: the glide re-targets from where it is on screen now
            const q = ghostRect(r, now0);
            r.gh = { c: r.gh.c, x0: q.x, y0: q.y, w: q.w, h: q.h, t0: now0 };
          } else {
            r.gh = { c: L.c[L.f], x0: L.x0, y0: L.y0, w: L.w, h: L.h, t0: now0 };
            L.c[L.f] = null; L.g[L.f] = null;
          }
          for (const i of r.dots) if (INL[i]) { X[i] = TX[i]; Y[i] = TY[i]; VX[i] = VY[i] = 0; }
        } else {
          for (const i of r.dots) INL[i] = 0;
          r.gh = null;
        }
        lyCanvas(L, L.f, box);
        L.rings = false;
      }
      L.x0 = box.x0; L.y0 = box.y0; L.w = box.w; L.h = box.h; L.dpr = DPR;
      lyCanvas(L, 1 - L.f, box);
      L.bj = -1; L.building = true; L.drewRing = false;
      dirty = true;
    }
    function lyBuild(budget) {
      const br = lastBaseR, rr = br + 0.6;
      for (const r of recs) {
        const L = r.ly;
        if (!L || !L.building) continue;
        const g = L.g[1 - L.f];
        const hue = (r.hue || 0) % 8, sp = sprites[hue], rs = sprites.ring && sprites.ring[hue];
        if (L.bj < 0) {
          L.bj = 0;
          // a big file's topics: a faint halo per sequence-order section, so 15k atoms read as dense topic clusters
          if (r.S && r.sec && !strip && (r.rad || 0) >= 40) {
            g.globalAlpha = 1; g.fillStyle = colors.f[hue]; g.strokeStyle = colors.f[hue]; g.lineWidth = 1;
            for (let sct = 0; sct < r.S; sct++) {
              const c = secCenter(r, sct), rad = c.rs + br + 3;
              g.globalAlpha = 0.05; g.beginPath(); g.arc(c.x - L.x0, c.y - L.y0, rad, 0, Math.PI * 2); g.fill();
              g.globalAlpha = 0.16; g.stroke();
            }
          } else if (!strip && (r.nj || 0) > 0 && (r.nj || 0) <= 6 && k > 1) {
            // a tiny file beside a huge one (1 dot = k atoms): a soft disc in its hue marks its cluster, so a
            // 2-atom file is a visible place on the map, not a lone speck
            const rad = clamp((r.rad || 10) + 3, 8, 22);
            g.fillStyle = colors.f[hue]; g.strokeStyle = colors.f[hue]; g.lineWidth = 1;
            g.globalAlpha = 0.12; g.beginPath(); g.arc(r.cx - L.x0, r.cy - L.y0, rad, 0, Math.PI * 2); g.fill();
            g.globalAlpha = 0.45; g.stroke();
          }
        }
        const nj = r.nj || 0, ring = r.ring;
        while (L.bj < nj && budget > 0) {
          const j = L.bj++; budget--;
          const i = r.bySeq.get(j * k);
          if (i != null) {
            // born: a settled dot is painted here; one still in flight is drawn live and painted when it lands
            if (INL[i]) { g.globalAlpha = 1; g.drawImage(sp, TX[i] - L.x0 - br, TY[i] - L.y0 - br, br * 2, br * 2); }
            continue;
          }
          if (red || !rs || !ring) continue;
          g.globalAlpha = 0.62; g.drawImage(rs, ring[j * 2] - L.x0 - rr, ring[j * 2 + 1] - L.y0 - rr, rr * 2, rr * 2);
          L.drewRing = true;
        }
        if (L.bj >= nj) { L.f = 1 - L.f; L.building = false; L.has = true; L.rings = L.drewRing; dirty = true; }
        if (budget <= 0) return 0;
      }
      return budget;
    }
    function lyPaint(r, i) {
      const L = r.ly;
      if (!L) return false;
      const br = lastBaseR, sp = sprites[(r.hue || 0) % 8];
      const x = TX[i] - L.x0 - br, y = TY[i] - L.y0 - br;
      const gf = L.g[L.f];
      gf.globalAlpha = 1; gf.drawImage(sp, x, y, br * 2, br * 2);
      if (L.building && L.bj > Math.floor(SEQ[i] / k)) { const gb = L.g[1 - L.f]; gb.globalAlpha = 1; gb.drawImage(sp, x, y, br * 2, br * 2); }
      INL[i] = 1;
      return true;
    }
    /** Where a cluster's FLIP ghost is drawn now (its old bitmap easing into the new layer box), or null. */
    function ghostRect(r, now) {
      const G = r.gh, L = r.ly;
      if (!G || !L) return null;
      const e = easeInOut(clamp((now - G.t0) / 440, 0, 1));
      return { x: G.x0 + (L.x0 - G.x0) * e, y: G.y0 + (L.y0 - G.y0) * e, w: G.w + (L.w - G.w) * e, h: G.h + (L.h - G.h) * e, e };
    }
    /** The label / halo offset that rides with a gliding cluster (0 once it has landed). */
    function ghostOff(r, now) {
      const q = r.gh ? ghostRect(r, now) : null;
      if (!q || q.e >= 1) return null;
      const L = r.ly;
      return { dx: (q.x + q.w / 2) - (L.x0 + L.w / 2), dy: (q.y + q.h / 2) - (L.y0 + L.h / 2) };
    }
    // big corpora get finer dots, so dense topic clusters keep visible texture instead of becoming solid discs
    function dotR() { if (wantTotal > 2500 && !strip) return isMobile() ? 1.05 : 1.15; return (wantTotal > 1500 && !strip ? (isMobile() ? 1.4 : 1.6) : (isMobile() ? 1.9 : 2.25)) + (wantTotal < 400 && !strip ? 0.45 : 0); }

    // ---- frame
    function step(t, dt) {
      if (destroyed) return false;
      if (!visible) return true;
      if (dt > 0 && dt < 250) frameMs = frameMs * 0.85 + dt * 0.15;
      const s = Math.min(0.05, (dt || 16) / 1000);
      const now = performance.now();
      const t0s = now;                                  // this frame's work budget starts here (<= ~6 ms of script)
      let moving = false;
      const STIFF = 92, DAMP = 14;
      const br = dotR();
      if (br !== lastBaseR) { lastBaseR = br; for (const r of recs) lyStart(r, true); }
      for (let i = 0; i < N; i++) {
        if (INL[i]) continue;                         // settled and painted: costs nothing per frame
        const dx = TX[i] - X[i], dy = TY[i] - Y[i];
        if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3 || Math.abs(VX[i]) > 3 || Math.abs(VY[i]) > 3) {
          VX[i] += (STIFF * dx - DAMP * VX[i]) * s; VY[i] += (STIFF * dy - DAMP * VY[i]) * s;
          X[i] += VX[i] * s; Y[i] += VY[i] * s;
          moving = true;
        } else { X[i] = TX[i]; Y[i] = TY[i]; VX[i] = VY[i] = 0; }
        if (R0[i] > 0) { R0[i] = Math.max(0, R0[i] - s * 3); moving = true; }
        if (X[i] === TX[i] && Y[i] === TY[i] && R0[i] === 0 && now - BORN[i] >= 260) {
          const r = recs[FI[i]];
          if (r && lyPaint(r, i)) moving = true;      // one more frame: the live copy hands over to the layer
        } else moving = true;
      }
      // per-file scope alpha (a switched-off file fades to .05 and loses hover)
      for (const r of recs) {
        const want = r.enabled ? 1 : 0.05;
        if (r.la == null) r.la = want;
        if (r.la !== want) { r.la += (want - r.la) * Math.min(1, s * 10); if (Math.abs(want - r.la) < 0.01) r.la = want; moving = true; }
        // every counted atom has its dot now: drop the hollow rings from the layer (one soft rebuild)
        const L = r.ly;
        if (L && !L.building && L.rings && r.dots.length >= (r.nj || 0) && !r.pending) lyStart(r, false);
      }
      // births at the real vectorized rate, capped per frame across all files (a huge vectorized delta is drawn in
      // over a few frames, never in one long one)
      // (round 7: at most ~50 per frame, 30 on a slow device: a Ready that lands 400 vectors at once flies in over
      // a few frames instead of one long one; each birth is a live sprite until it settles into its layer)
      let budget = frameMs > 24 ? 30 : frameMs > 18 ? 40 : 50;
      for (const r of recs) {
        if (r.pending > 0 && !r.hold) {
          r.acc += r.rate * s;
          let n = Math.min(Math.floor(r.acc), budget);
          if (n > 0) {
            r.acc -= n; n = Math.min(n, r.pending);
            let made = 0;
            for (let c = 0; c < n; c++) {
              const j = freeSlot(r);
              // the remaining slots are reserved for chips still in flight: they keep their pending count
              if (j < 0) break;
              if (birth(r, j, r.cx + (Math.random() - 0.5) * 4, r.cy + (Math.random() - 0.5) * 4) < 0) { r.pending = made; break; }
              made++;
            }
            r.pending -= Math.min(r.pending, made); budget -= made;
            if (!made && !r.reserved.size) r.pending = 0;
            moving = true;
          }
        } else r.acc = 0;
      }
      // layer builds: at most ~1,200 sprite blits per frame (a 4,000-atom file repaints over a few frames)
      // (time-boxed: when the springs and births already used ~4 ms the rebuild spills into the next frame)
      if (recs.some((r) => r.ly && r.ly.building)) { const left = 6 - (performance.now() - t0s); if (left > 1.5) lyBuild(Math.round((frameMs > 20 ? 600 : 1200) * Math.min(1, left / 6))); moving = true; }
      // the idle field fades out under the first file (and back if every file is removed)
      const ambWant = recs.length ? 0 : 1;
      if (ambA !== ambWant) { ambA += (ambWant - ambA) * Math.min(1, s * (red ? 100 : 5)); if (Math.abs(ambWant - ambA) < 0.01) ambA = ambWant; moving = true; }
      // files still being read (no atom counted yet) show a live progress node: its comet and the reading line are
      // the only things that move between real events (the shimmer rule); under reduce the node is static
      const reading = !red && recs.some(isPre);
      const busy = !!document.documentElement.dataset.signature;
      const drift = !red && !busy;
      const active = moving || dirty || (overlays.size > 0 && overlayLive()) || recs.some((r) => r.gh) || (retrieval && !retrieval.done) || recs.some((r) => (r.halo && now - r.halo < 400) || (r.labelT > 0 && now - r.labelT < 400) || (r.mutedT && now - r.mutedT < 220)) || (highlight && now - highlight.t0 < 300);
      const animating = active || reading;
      // only the reading rings' slow comet / scan line moves: ~30 fps is plenty for that ambient motion (each redraw
      // is a full-band canvas commit); births, springs, chips and beams keep the full frame rate
      if (!active && reading && now - lastDraw < 31) return true;
      // the +/-0.3 px idle drift only needs ~20 fps; nothing to animate (reduce, busy, still) -> no redraw at all
      // phones with the Builder tab in front: the pane is hidden, so nothing is drawn (state keeps advancing)
      if (isMobile() && appEl && appEl.dataset.tab === 'setup') { dirty = true; return true; }
      // the drift needs ~20 fps with dots, ~12 fps for the idle field alone; still + nothing to animate -> no redraw
      // adaptive quality: when frames run long (smoothed > 24 ms) the drift redraws at half rate
      const slow = frameMs > 24;
      // a slow device (smoothed frames > 24 ms) repaints the map at most every other frame (a beam still plays at
      // full rate): every redraw is a full-band canvas commit on the main thread
      if (slow && !retrieval && !highlight && (skipOdd = !skipOdd)) return true;
      if (animating || (drift && (N || ambA > 0) && now - lastDraw > (N ? (slow ? 100 : 50) : (slow ? 160 : 80)))) { draw(now, drift); lastDraw = now; dirty = false; }
      return true;
    }
    function kick() { if (!removeLoop && !destroyed) removeLoop = motion.loop.add((t, dt) => { const keep = step(t, dt); if (!keep) removeLoop = null; return keep; }); }

    function draw(now, drift) {
      const g = c2d;
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, W, H);
      const tt = now * 0.0011;
      // idle field (empty map): 240 grey dots drifting +/-0.3 px behind the "Atoms appear here" pill
      if (ambA > 0.01 && sprites.idle) {
        // the 240 dots are painted ONCE into a cached field (per size / theme); a frame is one blit, drifting as a whole
        const ar = 1.5, ax0 = 8, ay0 = (chrome.hudBottom || 36) + 4, aw = Math.max(1, W - 16), ah = Math.max(1, (chrome.legendTop || H) - ay0 - 4);
        const ikey = `${W}x${H}|${ay0}|${ah}|${DPR}|${colors.dim}`;
        if (!idleField || idleField.key !== ikey) {
          const c = idleField && idleField.c ? idleField.c : document.createElement('canvas');
          c.width = Math.max(1, Math.ceil(W * DPR)); c.height = Math.max(1, Math.ceil(H * DPR));
          const ig = c.getContext('2d');
          ig.setTransform(DPR, 0, 0, DPR, 0, 0); ig.clearRect(0, 0, W, H);
          for (let i = 0; i < IDLE_DOTS; i++) ig.drawImage(sprites.idle, ax0 + AMB[i * 3] * aw - ar, ay0 + AMB[i * 3 + 1] * ah - ar, ar * 2, ar * 2);
          idleField = { c, key: ikey };
        }
        g.globalAlpha = 0.5 * ambA;
        g.drawImage(idleField.c, drift ? Math.sin(tt) * 0.3 : 0, drift ? Math.cos(tt * 0.93) * 0.3 : 0, W, H);
        g.globalAlpha = 1;
      }
      // files being read: a ring per file that fills with its real progress (bytes, then stages), never ahead of it
      for (const r of recs) if (isPre(r)) drawPre(g, r, now);
      // retrieval state
      const R = retrieval;
      let dimAll = 1, relaxK = 0;
      const hitSet = R ? new Map(R.hits.map((x, n) => [x.i, { ...x, n }])) : null;
      if (R) {
        const el = now - R.t0;
        const life = red ? 6000 : 2500;
        if (!R.relaxT && el > life) R.relaxT = now;
        relaxK = R.relaxT ? clamp((now - R.relaxT) / (red ? 1 : 400), 0, 1) : 0;
        if (R.refused) {
          const de = R.dimT ? now - R.dimT : 0;
          const k2 = red ? (de < 1000 ? 1 : 0) : de < 300 ? de / 300 : de < 1000 ? 1 : 1 - clamp((de - 1000) / 400, 0, 1);
          dimAll = 1 - 0.7 * k2;
        } else {
          dimAll = 1 - 0.85 * (red ? 1 : easeOut(el / 300));
        }
        dimAll = dimAll + (1 - dimAll) * relaxK;
        if (relaxK >= 1) { R.done = true; endRetrieval(); }
      }
      const baseR = lastBaseR || dotR();
      // short bands clip the field to the dot area: nothing ever draws under the HUD text or the legend
      const clipOn = strip;
      if (clipOn) { g.save(); g.beginPath(); g.rect(area.x0 - 4, area.y0 - 4, area.x1 - area.x0 + 8, area.y1 - area.y0 + 8); g.clip(); }
      // per-file drift offset: a file's layer and its live dots move together (no seam when a dot hands over)
      const offX = (r) => (drift ? Math.sin(tt + r.idx * 1.37) * 0.3 : 0), offY = (r) => (drift ? Math.cos(tt * 0.93 + r.idx * 2.11) * 0.3 : 0);
      // static layers: settled dots + hollow rings (counted atoms whose vector has not landed yet)
      for (const r of recs) {
        const L = r.ly;
        if (!L || !L.c[L.f]) continue;
        let a = r.la ?? 1;
        if (R) a *= dimAll;
        if (a <= 0.01) continue;
        g.globalAlpha = a;
        if (r.gh) {
          const q = ghostRect(r, now);
          // the ghost hands over once it has landed AND the new layer is complete (no blank frame between them)
          if (q && (q.e < 1 || L.building || !L.has)) { g.drawImage(r.gh.c, q.x + offX(r), q.y + offY(r), q.w, q.h); continue; }
          r.gh = null;
        }
        g.drawImage(L.c[L.f], L.x0 + offX(r), L.y0 + offY(r), L.w, L.h);
      }
      // live dots (being born, springing, or waiting for their layer)
      for (let i = 0; i < N; i++) {
        if (INL[i]) continue;
        const rec = recs[FI[i]];
        if (!rec) continue;
        if (hitSet && hitSet.has(i)) continue;            // hits are drawn on top
        const sp = sprites[(rec.hue || 0) % 8];
        let a = rec.la ?? 1;
        const age = now - BORN[i];
        let rad = baseR + R0[i];
        if (age < 260) { const k3 = easeOut(age / 260); rad *= k3; a *= k3; }
        if (R) a *= dimAll;
        if (a <= 0.01) continue;
        g.globalAlpha = a;
        g.drawImage(sp, X[i] + offX(rec) - rad, Y[i] + offY(rec) - rad, rad * 2, rad * 2);
      }
      g.globalAlpha = 1;
      // retrieval overlay (inside the clip: probe lines never leave the dot area)
      if (R && !R.done) drawRetrieval(g, R, now, relaxK, hitSet, baseR);
      if (clipOn) g.restore();
      // cluster halos + labels
      {
        for (const r of recs) {
          const pre = isPre(r);
          if (!r.dots.length && !pre) continue;
          // the halo glow pass is skipped while two shatters paint over the map (their chips carry the moment)
          if (r.halo && r.dots.length && overlays.size < 2) {
            const e = (now - r.halo) / 300;
            if (e >= 0 && e <= 1.3 && !red) {
              const k4 = 1 + 0.15 * (e <= 1 ? easeOut(e) : 1);
              g.globalAlpha = (1 - clamp(e, 0, 1)) * 0.5;
              g.strokeStyle = colors.f[r.hue % 8]; g.lineWidth = 1.5;
              g.beginPath();
              // the halo hugs the cluster's real footprint (an ellipse in a strip segment, a disc otherwise)
              if (r.seg && g.ellipse) g.ellipse(r.cx, r.cy, (r.seg.w / 2 + 3) * k4, (r.seg.h / 2 + 3) * k4, 0, 0, Math.PI * 2);
              else g.arc(r.cx, r.cy, (r.rad + 3) * k4, 0, Math.PI * 2);
              g.stroke();
            }
          }
          if ((r.labelT || pre) && r.lab && !R) {
            let la = pre || r.labelT < 0 ? 1 : clamp((now - r.labelT) / 300, 0, 1);
            // a file whose chips are in flight keeps its label out of the way (180 ms fade), then brings it back
            if (r.mutedT) { const mk = red ? 1 : clamp((now - r.mutedT) / 180, 0, 1); la *= r.muted ? 1 - mk : mk; }
            if (r.lab.under) la *= 0.4;
            if (la <= 0.01) continue;
            const { w: lw, text, lines } = r.lab;
            // a gliding cluster carries its label with it (FLIP), so the name never jumps ahead of its dots
            const go = r.gh ? ghostOff(r, now) : null;
            const lx = r.lab.x + (go ? go.dx : 0), ly = r.lab.y + (go ? go.dy : 0);
            g.globalAlpha = la;
            g.drawImage(labelSprite('c', text, lw, 16, !!lines), lx, ly, lw, lines ? 32 : 16);
            if (lines && pre) {
              // the file's real first lines, one at a time (1.6 s each), with a scan sweep across the line being read
              const n = lines.length, li = red ? 0 : Math.floor(now / 1600) % n;
              const ph = red ? 1 : (now % 1600) / 1600;
              const fade = red ? 1 : clamp(ph / 0.12, 0, 1) * clamp((1 - ph) / 0.1, 0, 1);
              g.globalAlpha = la * fade;
              g.drawImage(labelSprite('x', lines[li], lw, 15), lx, ly + 16, lw, 15);
              if (!red) {
                const sx = lx - 46 + ph * (lw + 46);
                g.save(); g.beginPath(); g.rect(sx, ly + 16, 46, 15); g.clip();
                g.globalAlpha = la * fade;
                g.drawImage(labelSprite('xh', lines[li], lw, 15), lx, ly + 16, lw, 15);
                g.restore();
              }
            }
            g.globalAlpha = la;
            if (r.secLabs && r.ready) for (const sl of r.secLabs) g.drawImage(labelSprite('s', sl.text, sl.w, 16), sl.x, sl.y, sl.w, 16);
          }
        }
      }
      g.globalAlpha = 1;
      if (overlays.size) {
        for (const o of overlays.values()) {
          g.save();
          try { o.fn(g, DPR, now); } catch (err) { console.error('[ingest] overlay', err); }
          g.restore();
        }
        g.setTransform(DPR, 0, 0, DPR, 0, 0); g.globalAlpha = 1;
      }
      // citation highlight
      if (highlight && highlight.i < N) {
        const i = highlight.i;
        const k5 = red ? 1 : easeOut((now - highlight.t0) / 220);
        g.globalAlpha = 1;
        g.strokeStyle = colors.accent; g.lineWidth = 2;
        g.beginPath(); g.arc(X[i], Y[i], 4 + 4 * k5, 0, Math.PI * 2); g.stroke();
        g.fillStyle = colors.f[(recs[FI[i]]?.hue || 0) % 8];
        g.beginPath(); g.arc(X[i], Y[i], 3.5, 0, Math.PI * 2); g.fill();
        if (highlight.ex != null) {
          const ex = highlight.ex, ey = highlight.ey;
          g.globalAlpha = 0.85 * k5; g.lineWidth = 1; g.strokeStyle = colors.accent;
          g.setLineDash([3, 3]);
          g.beginPath(); g.moveTo(X[i], Y[i]); g.lineTo(X[i] + (ex - X[i]) * k5, Y[i] + (ey - Y[i]) * k5); g.stroke();
          g.setLineDash([]);
        }
      }
      // hover ring
      if (hover >= 0 && hover < N) {
        g.globalAlpha = 1; g.strokeStyle = colors.strong; g.lineWidth = 1.25;
        g.beginPath(); g.arc(X[hover], Y[hover], 5.5, 0, Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 1;
    }
    function drawRetrieval(g, R, now, relaxK, hitSet, baseR) {
      const el = now - R.t0;
      const fade = 1 - relaxK;
      const floor = R.floor;
      const lineOk = !lowDetail();
      // probe + ripple
      if (!red) {
        const pa = clamp(el / 120, 0, 1) * fade;
        const rp = el / 520;
        if (rp <= 1) {
          g.globalAlpha = (1 - rp) * 0.7 * fade; g.strokeStyle = R.refused ? colors.muted : colors.accent; g.lineWidth = 1.5;
          g.beginPath(); g.arc(R.px, R.py, Math.max(1, easeOut(rp) * R.R), 0, Math.PI * 2); g.stroke();
        }
        if (!R.refused) {
          g.globalAlpha = pa; g.fillStyle = colors.accent;
          g.beginPath(); g.arc(R.px, R.py, 4, 0, Math.PI * 2); g.fill();
          g.globalAlpha = pa * 0.25; g.beginPath(); g.arc(R.px, R.py, 9, 0, Math.PI * 2); g.fill();
        }
      }
      // lines (probe → kept hits): alpha = similarity, width = 0.5 + 2·(sim − floor)/(1 − floor)
      if (!R.refused && !red && lineOk) {
        g.save(); g.globalCompositeOperation = 'lighter';
        R.hits.forEach((x, n) => {
          if (!x.kept) return;
          const st = 160 + n * 40;
          const lk = clamp((el - st) / 200, 0, 1);
          if (lk <= 0) return;
          const sim = x.sim ?? 0.5;
          g.globalAlpha = clamp(sim, 0.15, 1) * fade * 0.9;
          g.strokeStyle = colors.f[(recs[FI[x.i]]?.hue || 0) % 8];
          g.lineWidth = 0.5 + 2 * clamp((sim - floor) / Math.max(0.01, 1 - floor), 0, 1);
          g.beginPath(); g.moveTo(R.px, R.py); g.lineTo(R.px + (X[x.i] - R.px) * lk, R.py + (Y[x.i] - R.py) * lk); g.stroke();
        });
        g.restore();
      }
      // hits: ignite in rank order (40 ms stagger), radius 2.5 → 6, mono labels; below floor: hollow floor rings
      // (the context font is set once per canvas resize; assigning it per frame forces a style resolve)
      const labRects = [];
      let labeled = 0;
      // score labels: none in a narrow strip (the dots alone carry the beam there; the expanded map and the proof
      // card show the numbers), top 3 on phones, 6 otherwise. A label never covers a hit dot, never sits within
      // 12 px of a higher-ranked labelled hit, and takes a short leader line when it has to stand off its dot.
      const maxLab = strip && W < 600 ? 0 : isMobile() ? 3 : strip ? 4 : 6;
      const keptPts = R.refused ? [] : R.hits.filter((x) => x.kept).map((x) => ({ i: x.i, x: X[x.i], y: Y[x.i] }));
      const labDots = [];
      const coversDot = (lx, ly, w, self) => keptPts.some((p) => {
        if (p.i === self) return false;
        const nx = clamp(p.x, lx - 4, lx + w + 4), ny = clamp(p.y, ly - 10, ly + 4);
        return (nx - p.x) ** 2 + (ny - p.y) ** 2 < 49;
      });
      const coversCluster = (lx, ly, w) => recs.some((q) => {
        if (!q.dots.length || q.seg) return false;
        const nx = clamp(q.cx, lx - 4, lx + w + 4), ny = clamp(q.cy, ly - 10, ly + 4), rr = (q.rad || 0) + baseR;
        return (nx - q.cx) ** 2 + (ny - q.cy) ** 2 < rr * rr;
      });
      R.hits.forEach((x, n) => {
        const i = x.i; const rec = recs[FI[i]];
        const col = colors.f[(rec?.hue || 0) % 8];
        const st = red ? 0 : 160 + n * 40;
        const ik = red ? 1 : easeSpring(clamp((el - st) / 220, 0, 1));
        const keptHit = x.kept && !R.refused;
        if (keptHit) {
          const rad = (2.5 + 3.5 * ik) * (1 - relaxK) + baseR * relaxK;
          g.globalAlpha = 1;
          if (!red && lineOk) { g.globalAlpha = 0.22 * ik * fade; g.fillStyle = col; g.beginPath(); g.arc(X[i], Y[i], rad + 5, 0, Math.PI * 2); g.fill(); }
          g.globalAlpha = 1; g.fillStyle = col; g.beginPath(); g.arc(X[i], Y[i], rad, 0, Math.PI * 2); g.fill();
          if (red || x.cited) { g.strokeStyle = colors.strong; g.lineWidth = 1.25; g.beginPath(); g.arc(X[i], Y[i], rad + 2, 0, Math.PI * 2); g.stroke(); }
          const label = x.sim != null ? String(Math.round(x.sim * 100)) : '';
          if (label && labeled < maxLab && ik > 0.4 && fade > 0 && !labDots.some((p) => Math.hypot(p.x - X[i], p.y - Y[i]) < 12)) {
            // Callouts: a pill just outside the hit's own cluster, out along the line from the cluster's centre through
            // the dot (then +/-0.4, +/-0.8 rad around it), joined to the dot by a leader. It never sits on dots: not on
            // any cluster's disc, any other hit, or another pill. Then the old hugging spots as a fallback. No free spot:
            // dropped (lower ranks lose: hits arrive in rank order).
            const tw = textWidth(label, MONO11);
            const cands = [];
            if (rec && !strip && rec.rad) {
              let th = Math.atan2(Y[i] - rec.cy, X[i] - rec.cx);
              if (Math.hypot(Y[i] - rec.cy, X[i] - rec.cx) < 2) th = Math.atan2(rec.cy - R.py, rec.cx - R.px);
              const rimD = rec.rad + 12;
              for (const dth of [0, 0.4, -0.4, 0.8, -0.8]) {
                const px = rec.cx + Math.cos(th + dth) * rimD, py = rec.cy + Math.sin(th + dth) * rimD;
                const c = Math.cos(th + dth), sn = Math.sin(th + dth);
                const lx = c >= 0.3 ? px : c <= -0.3 ? px - tw : px - tw / 2;
                const ly = sn >= 0.3 ? py + 10 : sn <= -0.3 ? py : py + 5;
                cands.push([lx, ly, true]);
              }
            }
            cands.push([X[i] + rad + 3, Y[i] - rad - 2, false], [X[i] + rad + 3, Y[i] + rad + 11, false], [X[i] - rad - 3 - tw, Y[i] - rad - 2, false], [X[i] - rad - 3 - tw, Y[i] + rad + 11, false],
              [X[i] + rad + 14, Y[i] - rad - 12, true], [X[i] + rad + 14, Y[i] + rad + 21, true], [X[i] - rad - 14 - tw, Y[i] - rad - 12, true], [X[i] - rad - 14 - tw, Y[i] + rad + 21, true]);
            for (const [lx, ly, lead] of cands) {
              if (lx - 4 < area.x0 - 4 || lx + tw + 4 > area.x1 + 4 || ly - 10 < area.y0 - 4 || ly + 4 > area.y1 + 4) continue;
              if (labRects.some((p) => lx - 4 < p.x + p.w + 2 && lx + tw + 6 > p.x && ly - 10 < p.y + 6 && ly + 6 > p.y - 10)) continue;
              if (coversDot(lx, ly, tw, i)) continue;
              if (lead && coversCluster(lx, ly, tw)) continue;
              labeled++;
              labDots.push({ x: X[i], y: Y[i] });
              labRects.push({ x: lx - 4, y: ly, w: tw + 8, label, lx, a: clamp((ik - 0.4) / 0.6, 0, 1) * fade, lead: lead ? { x: X[i], y: Y[i], tx: clamp(X[i], lx - 4, lx + tw + 4), ty: clamp(Y[i], ly - 10, ly + 4), r: rad + 1 } : null });
              break;
            }
          }
        } else {
          // candidate below the floor (or any candidate of a refusal): hollow ring in the floor color
          const rad = baseR + 2.5;
          g.globalAlpha = (red ? 1 : clamp((el - st) / 220, 0, 1)) * fade;
          g.strokeStyle = colors.floor; g.lineWidth = 1.25;
          g.beginPath(); g.arc(X[i], Y[i], rad, 0, Math.PI * 2); g.stroke();
          g.globalAlpha *= 0.5; g.fillStyle = col; g.beginPath(); g.arc(X[i], Y[i], baseR * 0.9, 0, Math.PI * 2); g.fill();
        }
      });
      // match labels last, so no dot ever covers a number
      for (const p of labRects) {
        if (p.lead) {
          const L = p.lead, d = Math.hypot(L.tx - L.x, L.ty - L.y) || 1;
          g.globalAlpha = p.a * 0.7; g.strokeStyle = colors.muted; g.lineWidth = 1;
          g.beginPath(); g.moveTo(L.x + (L.tx - L.x) / d * L.r, L.y + (L.ty - L.y) / d * L.r); g.lineTo(L.tx, L.ty); g.stroke();
        }
        g.globalAlpha = p.a;
        g.drawImage(labelSprite('m', p.label, p.w, 15), p.x, p.y - 11, p.w, 15);
      }
      g.globalAlpha = 1;
    }
    // Text is rasterized once per (label, theme, DPR) into a small sprite; frames only blit it. fillText with a web
    // font every frame was the single biggest cost of a learning map on a throttled CPU.
    const labelCache = new Map();
    function labelSprite(kind, text, w, hh, tall = false) {
      const key = `${kind}|${text}|${Math.round(w)}|${DPR}|${tall ? 1 : 0}`;
      let c = labelCache.get(key);
      if (c) return c;
      c = document.createElement('canvas');
      const H2 = kind === 'c' && tall ? 32 : hh;
      c.width = Math.max(1, Math.ceil(w * DPR)); c.height = Math.ceil(H2 * DPR);
      const x = c.getContext('2d');
      x.scale(DPR, DPR);
      if (kind === 'c' || kind === 's') {
        // an opaque backdrop with a hairline: the 11 px text keeps its contrast over any dot, ring or beam
        x.globalAlpha = 0.95; x.fillStyle = colors.panel; roundRect(x, 0.5, 0.5, w - 1, H2 - 1, 6); x.fill();
        x.globalAlpha = 0.9; x.strokeStyle = colors.line; x.lineWidth = 0.75; x.stroke();
        x.globalAlpha = 1; x.font = MONO11; x.fillStyle = kind === 's' ? colors.muted : colors.strong; x.fillText(text, 6, 11.5);
      } else if (kind === 'x' || kind === 'xh') {
        // the reading line (no backdrop of its own: it sits inside the tall 'c' backdrop)
        x.font = SANS11; x.fillStyle = kind === 'xh' ? colors.accent2 : colors.muted;
        x.fillText(fitText(text, w - 12, SANS11), 6, 10.5);
      } else {
        x.fillStyle = colors.panel; roundRect(x, 0.5, 0.5, w - 1, hh - 1, 4); x.fill();
        x.strokeStyle = colors.line; x.lineWidth = 0.75; x.stroke();
        x.font = MONO11; x.fillStyle = colors.strong; x.fillText(text, 4, hh - 4);
      }
      if (labelCache.size > 300) labelCache.clear();
      labelCache.set(key, c);
      return c;
    }
    function fitText(t, maxW, font) {
      if (textWidth(t, font) <= maxW) return t;
      let n = t.length;
      while (n > 4 && textWidth(`${t.slice(0, n).trimEnd()}…`, font) > maxW) n -= Math.max(1, Math.floor((n * 0.08)));
      return `${t.slice(0, n).trimEnd()}…`;
    }
    function isPre(r) { return !r.failed && !(r.atoms > 0) && !r.dots.length && r.phase !== 'ready'; }
    function preR(r) { return clamp(r.seg ? Math.min(r.seg.w, r.seg.h) / 2 - 2 : (r.rad || 10) * 0.72, 7, strip ? 14 : 26); }
    function drawPre(g, r, now) {
      const col = colors.f[(r.hue || 0) % 8];
      const R = preR(r);
      const a0 = -Math.PI / 2;
      const p = clamp(r.prog || 0, 0, 1);
      g.globalAlpha = r.enabled ? 1 : 0.15;
      g.lineCap = 'round';
      g.strokeStyle = col; g.lineWidth = strip ? 2 : 2.5;
      g.save(); g.globalAlpha *= colors.dark ? 0.42 : 0.2; g.beginPath(); g.arc(r.cx, r.cy, R, 0, Math.PI * 2); g.stroke(); g.restore();
      if (p > 0.005) { g.beginPath(); g.arc(r.cx, r.cy, R, a0, a0 + p * Math.PI * 2); g.stroke(); }
      // soft core in the file hue: where this file's atoms will land
      g.save(); g.globalAlpha *= colors.dark ? 0.36 : 0.12; g.fillStyle = col; g.beginPath(); g.arc(r.cx, r.cy, R - 3, 0, Math.PI * 2); g.fill();
      if (colors.dark) { g.globalAlpha = r.enabled ? 1 : 0.15; g.lineWidth = 1; g.beginPath(); g.arc(r.cx, r.cy, R + (strip ? 2 : 2.5), 0, Math.PI * 2); g.stroke(); }
      g.restore();
      if (!red && r.phase !== 'queued') {
        // the comet sweeps the unfilled part of the ring only (it never paints progress that did not happen)
        const span = Math.PI * 2 * (1 - p);
        if (span > 0.3) {
          const t = (now * 0.0011) % 1;
          const ang = a0 + p * Math.PI * 2 + t * span;
          g.save(); g.globalAlpha *= 0.55 * Math.sin(Math.PI * t); g.fillStyle = col;
          g.beginPath(); g.arc(r.cx + Math.cos(ang) * R, r.cy + Math.sin(ang) * R, strip ? 1.8 : 2.4, 0, Math.PI * 2); g.fill(); g.restore();
        }
      }
      g.globalAlpha = 1; g.lineCap = 'butt';
    }
    function roundRect(g, x, y, w, hh, r) {
      g.beginPath();
      if (g.roundRect) { g.roundRect(x, y, w, hh, r); return; }
      g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    }
    function snapAll() { for (let i = 0; i < N; i++) { X[i] = TX[i]; Y[i] = TY[i]; VX[i] = VY[i] = 0; R0[i] = 0; BORN[i] = -1e9; } dirty = true; }

    // ---- hover / click
    function pick(px, py) {
      let best = -1, bd = 81;
      for (let i = 0; i < N; i++) {
        if (BAND[i] < 0.5) continue;              // scoped-off files lose hover
        const dx = X[i] - px, dy = Y[i] - py, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    function infoOf(i) {
      const r = recs[FI[i]];
      if (!r) return null;
      return { key: r.key, fileId: r.fileId, localId: r.localId, name: r.name, seq: SEQ[i], k, x: X[i], y: Y[i], hue: r.hue };
    }
    function setHover(i) { if (i !== hover) { hover = i; dirty = true; kick(); } }

    function setMode(m) {
      if (m === mode) return;
      mode = m;
      // The slot's new height lands with the mode: the stage's ResizeObserver re-measures the chrome then (layout is
      // clean inside its callback, so the reads are free). A mode change without a size change is caught after the
      // frame instead, never by a read inside a rAF callback right after other modules' writes.
      chromeStale = true;
      setTimeout(() => { if (destroyed || !chromeStale) return; measureChrome(); relayout(true); if (red) snapAll(); kick(); }, 140);
    }
    // opening the peek snaps the dots onto the taller layout (hidden by the clip-path reveal), so the beam's
    // geometry is right from its first frame; closing it lets them spring back
    function setPeek(v, hh) {
      if (peek === !!v) return;
      peek = !!v;
      if (hh && W) resize({ width: W, height: hh }, { known: true }); else resizeNow();
      if (peek) snapAll();
    }
    function size() { return { W, H }; }
    function resizeNow() { W = 0; resize(); }
    function remeasure() { measureChrome(); relayout(true); kick(); }
    // fixer M r1 (D6): observer callbacks only READ (layout is clean there); the canvas re-allocation, the cluster
    // re-layout and the redraw run in the next frame, one per frame however many observers fired.
    function premeasure(box) {
      const w = Math.max(1, Math.round(box.width)), hh = Math.max(1, Math.round(box.height));
      if (w === W && hh === H) return;
      measureChrome(); chromeFor = `${w}x${hh}`;
    }
    let remRaf = 0;
    function remeasureSoon() {
      measureChrome();
      if (remRaf) return;
      remRaf = requestAnimationFrame(() => { remRaf = 0; if (!destroyed) { relayout(true); kick(); } });
    }
    function setReduced(v) { red = v; if (v) snapAll(); dirty = true; kick(); }
    function setVisible(v) { visible = v; if (v) { dirty = true; kick(); } }
    function clusterOf(key) { const r = recByKey.get(key); return r ? { x: r.cx, y: r.cy, rad: r.rad } : null; }
    function bornCount() { return N; }
    /** Dev check (one dot per atom, honestly labelled): no file ever holds more dots than ceil(atoms / k), a failed or
     *  removed file holds none, and every dot belongs to a live file. Returns null when it holds, else the offenders. */
    function dotCheck() {
      const bad = [];
      let sum = 0;
      for (const r of recs) {
        const cap0 = r.failed ? 0 : Math.ceil(Math.max(0, r.atoms) / k);
        sum += r.dots.length;
        if (r.dots.length > cap0) bad.push({ name: r.name, dots: r.dots.length, atoms: r.atoms, failed: r.failed });
      }
      if (sum !== N) bad.push({ orphanDots: N - sum });
      return bad.length ? bad : null;
    }

    readColors();
    try { if (/[?&]debug=1/.test(location.search)) window.__inMapDbg = () => ({ W, H, mode, peek, strip, area, chrome, N, check: dotCheck(),
      recs: recs.map((r) => ({ name: r.name, atoms: r.atoms, real: r.real, failed: r.failed, pending: r.pending, seqs: r.dots.slice(0, 12).map((i) => SEQ[i]) })), retrieval: retrieval && { px: retrieval.px, py: retrieval.py, hits: retrieval.hits.map((x) => [Math.round(X[x.i]), Math.round(Y[x.i]), Math.round(TX[x.i]), Math.round(TY[x.i])]) } }); } catch { /* ignore */ }
    return { resize, sync, targetFor, spawn, hold, reserve, release, halo, showLabel, playRetrieval, relax, fastForward, setHighlight,
      pick, infoOf, setHover, setMode, setPeek, remeasure, remeasureSoon, premeasure, size, setReduced, setVisible, readColors, clusterOf, bornCount, stageOffset, kick, isRetrieving,
      setOccluder, setLanes, getLanes, setOverlay, muteLabel, setSectionNames, sectionSeqs, setReading, halfMass,
      get frameMs() { return frameMs; }, get colors() { return colors; },
      set onRetrievalEnd(fn) { onRetrievalEnd = fn; }, get area() { return area; }, get chrome() { return chrome; }, get k() { return k; } };
  }

  // ---- map host wiring
  let ro = null;
  let resizeRaf = 0, pendingBox = null;
  try {
    // resize inside the observer callback: layout is clean there, so the reads cost nothing and nothing is forced later
    ro = new ResizeObserver((ents) => {
      const e = ents[ents.length - 1]; const cr = e && e.contentRect;
      // the band got shorter under a running shatter (the intake folded, an answer arrived): its card and strips were
      // placed for the old height and would be cut at the band's top edge. It ends now; its atoms land on the canvas.
      const H0 = map.size().H;
      if (cr && cr.height && H0 && cr.height < H0 - 24 && (shatterJobs.size || mapFx.childElementCount)) abortAllShatters();
      // fixer M r1 (D6): read here (clean layout), resize + redraw in the next frame (one rAF however many fire)
      if (cr && cr.width) { pendingBox = { width: cr.width, height: cr.height }; map.premeasure(pendingBox); }
      if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; const b = pendingBox; pendingBox = null; if (!destroyed) map.resize(b || undefined); });
    });
    ro.observe(stage);
  } catch { listen(window, 'resize', () => map.resize()); }
  // The HUD and the legend change size (counts, legend chips, a mode's padding): re-measure inside a ResizeObserver
  // callback, where layout is already clean, instead of reading rects in a rAF callback after fresh DOM writes.
  let chromeRO = null;
  try { chromeRO = new ResizeObserver(() => { if (!destroyed) map.remeasureSoon(); }); for (const el of [hudL, hudR, legend, legendChips]) chromeRO.observe(el); } catch { chromeRO = null; }
  let io = null;
  try { io = new IntersectionObserver((ents) => { for (const e of ents) map.setVisible(e.isIntersecting); }); io.observe(stage); } catch { /* always visible */ }
  const mo = new MutationObserver((recsM) => {
    for (const m of recsM) {
      if (m.attributeName === 'data-theme') { map.readColors(); }
      if (m.attributeName === 'data-motion') { map.setReduced(reduced()); if (reduced()) skipAllShatters(); syncMap(); }
      if (m.attributeName === 'data-detail') syncMap();
    }
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion', 'data-detail'] });
  requestAnimationFrame(() => map.resize());

  let tipFor = null;
  let tipTimer = 0;
  function hideTip() { tip.hidden = true; tipFor = null; map.setHover(-1); canvas.style.cursor = ''; }
  listen(canvas, 'pointermove', (e) => {
    if (e.pointerType === 'touch' || band.dataset.mode === 'ribbon') return;
    const r = canvas.getBoundingClientRect();
    const i = map.pick(e.clientX - r.left, e.clientY - r.top);
    if (i < 0) { hideTip(); return; }
    map.setHover(i);
    canvas.style.cursor = 'pointer';
    const info = map.infoOf(i);
    if (!info) return;
    const keyStr = `${info.key}:${info.seq}`;
    positionTip(info);
    if (tipFor === keyStr) return;
    tipFor = keyStr;
    renderTip(info, null);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => loadAtom(info).then((a) => { if (tipFor === keyStr) renderTip(info, a); }), 140);
  });
  listen(canvas, 'pointerleave', hideTip);
  listen(canvas, 'click', async (e) => {
    if (band.dataset.mode === 'ribbon') return;          // the ribbon's tap opens the band (below)
    const r = canvas.getBoundingClientRect();
    const i = map.pick(e.clientX - r.left, e.clientY - r.top);
    map.relax();
    if (i < 0) return;
    const info = map.infoOf(i);
    if (!info || !info.fileId) return;
    const a = await loadAtom(info).catch(() => null);
    emit('drawer:open', { fileId: info.fileId, atomId: a?.atomId ?? null, seq: info.seq });
  });
  listen(band, 'pointerdown', () => map.relax());
  listen(band, 'click', (e) => { if (band.dataset.mode === 'ribbon' && !(e.target.closest && e.target.closest('button'))) setExpanded(true); });

  function positionTip(info) {
    const x = info.x, y = info.y;
    const sw = stage.clientWidth;
    tip.style.left = `${clamp(x + 12, 8, Math.max(8, sw - 260))}px`;
    tip.style.top = `${Math.max(6, y - 14)}px`;
    tip.style.transform = y > stage.clientHeight * 0.6 ? 'translateY(-100%)' : 'none';
  }
  function renderTip(info, a) {
    tip.hidden = false;
    tip.innerHTML = '';
    const total = (getState().files[info.localId] || {}).atoms || 0;
    const snippet = a && a.text ? (a.text.length > 90 ? `${a.text.slice(0, 89).trimEnd()}…` : a.text) : null;
    tip.append(
      h('p', { class: 'map-tip-q' }, snippet ? `“${snippet}”` : h('span', { class: 'map-tip-load' }, 'Loading atom text…')),
      h('p', { class: 'map-tip-m in-num' }, h('i', { style: { '--hue': `var(--f${info.hue % 8})` } }), `${mid(info.name, 28)} · atom #${info.seq + 1}${total ? ` of ${total}` : ''}${info.k > 1 ? ` (+${info.k - 1})` : ''}`));
  }
  async function loadAtom(info) {
    const key = `${info.fileId}:${info.seq}`;
    if (atomText.has(key)) return atomText.get(key);
    const pv = info.fileId && previews.get(info.fileId);
    const hit = pv && pv.find((x) => Number(x.seq) === Number(info.seq));
    if (hit) { const v = { text: hit.text, atomId: hit.atomId }; atomText.set(key, v); return v; }
    if (!info.fileId || !api.fileAtoms) return null;
    try {
      const r = await api.fileAtoms(info.fileId, { limit: 3, around: info.seq, span: 0 });
      for (const it of (r && r.items) || []) atomText.set(`${info.fileId}:${it.seq}`, { text: String(it.text || '').replace(/\s+/g, ' ').trim(), atomId: it.atomId });
      return atomText.get(key) || null;
    } catch { return null; }
  }

  // ---- band mode (46 % while learning / before 2 answers; 56 px ribbon after; pinned keeps it open)
  let lateIngest = false;
  let lateTimer = 0;
  let tableOn = false;
  let expanded = false;          // a ribbon the visitor opened for a look (tap / Expand); folds again on the next ask
  const answerCount = () => (getState().thread || []).filter((a) => a && a.by !== 'proof').length;
  // The 56 px in-flow ribbon once the thread has 2 answers (phones: from the first answer), at every width,
  // unless pinned or opened for a look. A late upload re-opens the full band while it learns.
  function autoMode() {
    const s = getState();
    if (s.ui && s.ui.mapPinned) return 'full';
    if (answerCount() >= (isMobile() ? 1 : 2) && !lateIngest) return 'ribbon';
    return 'full';
  }
  function bandMode() { const m = autoMode(); return m === 'ribbon' && expanded ? 'full' : m; }
  function setExpanded(v) {
    v = !!v;
    if (expanded === v) return;
    const hadFocus = band.contains(document.activeElement);
    expanded = v;
    updateBand();
    if (hadFocus) (v ? foldBtn : expandBtn).focus({ preventScroll: true });
  }
  // The slot height changes in one step (no height transition: that would shift the thread on every frame).
  // The band then reveals itself with compositor-only motion (clip-path / transform / opacity).
  function updateBand() {
    const m = bandMode();
    const s = getState();
    if (band.dataset.mode !== m) {
      const from = band.dataset.mode;
      band.dataset.mode = m;
      mapSlot.dataset.mode = m;
      setPeek(false);
      // no layout read here: the ResizeObserver re-fits the canvas once the slot has its new height
      map.setMode(m);
      if (m === 'ribbon') hideTip();
      if (from && !reduced()) {
        if (m === 'ribbon') anim(band, [{ opacity: 0.4, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'out', essential: false });
        else anim(band, [{ clipPath: 'inset(0 0 calc(100% - 56px) 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 360, easing: 'out', essential: false });
      }
    }
    const pinned = !!(s.ui && s.ui.mapPinned);
    const isExp = m === 'full' && expanded && autoMode() === 'ribbon';
    setDs(mapSlot, 'expanded', isExp ? 'yes' : '');
    if (pinBtn.getAttribute('aria-pressed') !== String(pinned)) pinBtn.setAttribute('aria-pressed', String(pinned));
    setText(pinBtn.querySelector('.map-btn-l'), pinned ? 'Pinned' : 'Pin');
    { const t = pinned ? 'Unpin: let the map fold to a ribbon once you have answers' : 'Keep the map open'; if (pinBtn.title !== t) pinBtn.title = t; }
    setHidden(pinBtn, m === 'ribbon');
    setHidden(expandBtn, m !== 'ribbon');
    setHidden(foldBtn, !isExp);
    const collapsed = m === 'ribbon';
    if (s.ui && s.ui.mapCollapsed !== collapsed) {
      // CONTRACT-GAP: ui is B's key, but mapCollapsed/mapPinned describe D's band; written like ui.drawer (C) / ui.sheet (E).
      setState({ ui: { ...s.ui, mapCollapsed: collapsed } }, 'map:collapse');
    }
  }
  // Ribbon (or a band squeezed under 170 px) + retrieval: the band grows to ~168 px as an overlay (absolutely
  // positioned, so nothing below moves), plays the beam where it can be read, then folds back when it relaxes.
  const PEEK_H = 168;
  let peekOn = false;
  let peekAnim = null;
  let peekFrom = 56;
  function setPeek(on) {
    if (on && !peekOn) { peekFrom = map.size().H || 56; }
    // Only the desktop compact strip of the FIRST answer peeks (an overlay, for 2.5 s). The ribbon stays a 56 px
    // in-flow ribbon and never covers the thread; phones never peek.
    on = !!on && !tableOn && band.dataset.mode !== 'ribbon' && peekFrom < 170 && !isMobile() && answerCount() < 2;
    if (on === peekOn) return;
    peekOn = on;
    try { peekAnim && peekAnim.cancel(); } catch { /* ignore */ }
    const shut = `inset(0 0 ${Math.max(0, PEEK_H - peekFrom)}px 0 round 0 0 14px 14px)`, open = 'inset(0 0 0 0 round 0 0 14px 14px)';
    if (on) {
      band.dataset.peek = 'yes';
      map.setPeek(true, PEEK_H);
      if (!reduced()) peekAnim = anim(band, [{ clipPath: shut }, { clipPath: open }], { duration: 300, easing: 'out', essential: false });
    } else {
      const a = reduced() ? null
        : anim(band, [{ clipPath: open }, { clipPath: shut }], { duration: 260, easing: 'out', fill: 'forwards', essential: false });
      peekAnim = a;
      const done = () => { if (peekOn) return; delete band.dataset.peek; map.setPeek(false, peekFrom); if (a) { try { a.cancel(); } catch { /* ignore */ } } };
      if (!a) { done(); return; }
      Promise.resolve(a.finished).then(done, done);
    }
  }
  map.onRetrievalEnd = () => setPeek(false);

  function togglePin() {
    const s = getState();
    const pinned = !(s.ui && s.ui.mapPinned);
    setState({ ui: { ...s.ui, mapPinned: pinned } }, 'map:pin');
    try { store.persist && store.persist(); } catch { /* ignore */ }
    updateBand();
  }
  function toggleTable() {
    tableOn = !tableOn;
    tableBtn.setAttribute('aria-pressed', String(tableOn));
    table.hidden = !tableOn;
    canvas.style.visibility = tableOn ? 'hidden' : '';
    band.dataset.table = tableOn ? 'on' : '';
    if (tableOn) renderTable();
  }
  let tableGauges = [];
  const tableGauge = (f) => { const g = h('span', { class: 'map-tbl-gauge' }); tableGauges.push(mountWidget(g, 'FileGauge', gaugeProps(f, { failNode: f.phase === 'failed' ? (meta(f.localId).failedNode ?? failNodeOf(f)) : null }))); return g; };
  function renderTable() {
    for (const g of tableGauges.splice(0)) g.unmount();
    if (!tableOn) return;
    const files = liveFiles();
    // KnowDrive's .data-table (is-static: its rows do nothing on click); the Stage cell carries the file's gauge
    const t = h('table', { class: 'data-table is-static map-tbl' },
      h('caption', { class: 'in-sr' }, 'Files and atoms in your bot’s knowledge'),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'File'), h('th', { scope: 'col' }, 'Stage'), h('th', { scope: 'col', class: 'is-num' }, 'Atoms'), h('th', { scope: 'col', class: 'is-num' }, 'Vectors'), h('th', { scope: 'col' }, 'Searched'))),
      h('tbody', null, files.length ? files.map((f) => h('tr', null,
        h('th', { scope: 'row' }, h('i', { class: 'map-tbl-dot', style: { '--hue': `var(--f${f.hue % 8})` }, 'aria-hidden': 'true' }), mid(f.name, 34)),
        h('td', null, h('span', { class: 'map-tbl-stage' }, tableGauge(f), phaseLabel(f))),
        h('td', { class: 'is-num in-num' }, fmtInt(f.atoms || 0)),
        h('td', { class: 'is-num in-num' }, `${fmtInt(f.vectorized || 0)}/${fmtInt(f.atoms || 0)}`),
        h('td', null, f.phase === 'failed' ? 'No (failed)' : f.phase !== 'ready' ? (RANK[f.phase] >= 6 ? 'Partly' : 'Not yet') : isEnabled(f) ? 'Yes' : 'Off'))) : h('tr', null, h('td', { colspan: '5' }, 'No files yet.'))));
    table.innerHTML = '';
    table.append(t);
  }
  // Legend chips are keyed (a count change rewrites one text node, never the whole row). They show only when the
  // Sources rows are folded away (chip) or in the ribbon: next to open rows they would just repeat the file list.
  const legendEls = new Map();
  const SHORT_DOING = { queued: 'queued', uploading: 'upload', uploaded: 'extract', extracted: 'chunk', chunked: 'atomize', atomized: 'encoding', vectorizing: 'encoding' };
  // the phone ribbon's fallback when the per-file chips cannot all fit with their counts
  const legendSum = h('span', { class: 'map-chip map-chip-sum', role: 'listitem' }, h('i', { 'aria-hidden': 'true' }), h('span', { class: 'map-chip-c in-num' }));
  let legendOrder = '';
  let legendRemeasure = 0;
  function renderLegend(files) {
    // phones: the legend row IS where files are named (no floating labels on the 140 px map), from the first stage
    const mob = isMobile();
    const shown = mob ? files.filter((f) => f.phase !== 'failed' || f.atoms) : files.filter((f) => f.atoms || f.phase === 'ready');
    const show = band.dataset.mode === 'ribbon' || isCollapsed || (mob && shown.length > 0);
    if (band.dataset.legend !== (show ? 'chips' : 'note')) { band.dataset.legend = show ? 'chips' : 'note'; scheduleRemeasure(); }
    const order = shown.map((f) => f.localId).join('|') + (isMobile() ? 'm' : '');
    if (order !== legendOrder) {
      legendOrder = order;
      const keep = new Set(shown.map((f) => f.localId));
      for (const [lid, el] of [...legendEls]) if (!keep.has(lid)) { el.root.remove(); legendEls.delete(lid); }
      for (const f of shown) {
        let el = legendEls.get(f.localId);
        if (!el) {
          const n = h('span', { class: 'map-chip-n' }), c = h('span', { class: 'map-chip-c in-num' });
          el = { root: h('span', { class: 'map-chip', role: 'listitem' }, h('i', { 'aria-hidden': 'true' }), n, c), n, c, sig: '' };
          legendEls.set(f.localId, el);
        }
        legendChips.append(el.root);              // re-append keeps file order
      }
      scheduleRemeasure();
    }
    // phones: every chip's count must stay visible (round-5: the 4th file's "107" was cut at the pane edge). The
    // names share what the counts leave of the row's width; too little room -> dot + count (name in title / aria).
    // phones say the stage in one short word ("extract", never a clipped "extractin"); the full phrase is in the
    // chip's title and accessible name
    const cntOf = (f) => (!f.atoms && f.phase !== 'ready' ? ((mob ? SHORT_DOING[f.phase] : DOING[f.phase]) || 'reading') : fmtInt(f.atoms || 0));
    let nameMax = mob ? 16 : 20;
    const ribbon = band.dataset.mode === 'ribbon';
    const W0 = map.size().W || 0;
    let sum = false;
    if (mob && shown.length > 1 && W0) {
      if (ribbon) {
        // the 56 px ribbon: dot + count chips in the left 46%; when even those do not fit, one "4 files" chip
        // (every count stays readable in the expanded map) instead of a row whose last count is cut off
        const need = shown.reduce((acc, f) => acc + 22 + Math.ceil(textWidth(cntOf(f), MONO10)), 0) + 2 * (shown.length - 1);
        sum = need > W0 * 0.46 - 20;
        nameMax = 0;
      } else {
        const fixed = shown.reduce((acc, f) => acc + 36 + Math.ceil(textWidth(cntOf(f), MONO11)), 0);
        const per = (W0 - 2 * 16 - 6 * (shown.length - 1) - fixed) / shown.length;
        nameMax = Math.min(16, Math.floor(per / 6.6));
        if (nameMax < 7) nameMax = 0;            // mid() keeps at least "abc….md"; the chips wrap to a 2nd row if needed
      }
    }
    setDs(band, 'legsum', sum ? 'yes' : '');
    if (sum || legendSum.isConnected) {
      if (!legendSum.isConnected || legendSum.nextSibling) legendChips.append(legendSum);
      const tot = shown.reduce((acc, f) => acc + (f.atoms || 0), 0);
      const t = `${shown.length} files`;
      if (legendSum.lastChild.textContent !== t) legendSum.lastChild.textContent = t;
      const al = `${t}, ${plural(tot, 'atom')}. Expand the map for each file`;
      if (legendSum.getAttribute('aria-label') !== al) { legendSum.setAttribute('aria-label', al); legendSum.title = al; }
    }
    for (const f of shown) {
      const el = legendEls.get(f.localId);
      const pre = !f.atoms && f.phase !== 'ready';
      const cnt = cntOf(f);
      const sig = `${f.hue}|${cnt}|${isEnabled(f) ? 1 : 0}|${f.name}|${mob ? 1 : 0}|${nameMax}`;
      if (!el || el.sig === sig) continue;
      el.sig = sig;
      el.root.style.setProperty('--hue', `var(--f${f.hue % 8})`);
      el.root.classList.toggle('is-off', !isEnabled(f));
      el.root.classList.toggle('is-pre', pre);
      el.root.title = pre ? `${f.name} · ${cnt}` : `${f.name} · ${plural(f.atoms || 0, 'atom')}`;
      el.root.setAttribute('aria-label', pre ? `${f.name}, ${cnt}` : `${f.name}, ${plural(f.atoms || 0, 'atom')}${isEnabled(f) ? '' : ', off'}`);
      const nm = nameMax ? mid(f.name, nameMax) : '';
      el.n.hidden = !nm;
      if (el.n.textContent !== nm) el.n.textContent = nm;
      if (el.c.textContent !== cnt) el.c.textContent = cnt;
    }
  }
  // the ribbon's dot field starts right of the legend: re-measure once (next frame) after the legend changed
  function scheduleRemeasure() {
    if (chromeRO || legendRemeasure) return;
    legendRemeasure = requestAnimationFrame(() => { legendRemeasure = 0; if (!destroyed) map.remeasure(); });
  }
  let lastTotal = '', hudWroteAt = 0, hudTimer = 0;
  function syncMap() {
    const files = liveFiles();
    const total = map.sync(files);
    const has = files.some((f) => f.atoms > 0);
    const bstate = has ? 'live' : files.length ? 'learning' : 'empty';
    // the legend row appears / changes with the state: labels and dots must keep clear of where it now sits
    if (band.dataset.state !== bstate) { band.dataset.state = bstate; scheduleRemeasure(); }
    emptyCap.hidden = !!files.length;
    const note = has ? (map.k > 1 ? `Each dot is ${map.k} atoms, grouped by file` : 'Each dot is one atom, grouped by file')
      : files.length ? 'Each ring is a file being read · its atoms land as dots' : 'Your files become atoms here';
    if (legendNote.textContent !== note) legendNote.textContent = note;
    // The HUD never trails the rows: the count is written in the same frame as the authoritative file state.
    // Before any atom exists it names the real stage instead of a misleading "0 atoms".
    const stageText = total > 0 ? '' : hudStageText(files);
    hudCountWrap.hidden = !files.length || (total === 0 && !!stageText);
    hudStage.hidden = !stageText;
    if (stageText && hudStageT.textContent !== stageText) hudStageT.textContent = stageText;
    hudEmpty.hidden = !!files.length;
    const c = fileCounts(files);
    const hudSig = `${c.searchable}|${c.read}|${total}`;
    // HUD count text is written at most 4 times a second (a trailing write lands the final value)
    const nowT = performance.now();
    if (hudSig !== lastTotal && nowT - hudWroteAt < 250) {
      if (!hudTimer) hudTimer = setTimeout(() => { hudTimer = 0; if (!destroyed) afterChange(null); }, 260 - (nowT - hudWroteAt));
    } else if (hudSig !== lastTotal) {
      lastTotal = hudSig; hudWroteAt = nowT;
      const split = c.searchable !== c.read;
      const v = split ? c.searchable : c.read;
      hudCount.dataset.value = String(v); hudCount.textContent = fmtInt(v);
      hudUnit.textContent = split ? ' searchable' : (v === 1 ? ' atom' : ' atoms');
      hudRead.hidden = !split;
      hudRead.textContent = split ? ` · ${fmtInt(c.read)} read` : '';
      hudCountWrap.title = split ? `${plural(c.searchable, 'atom')} in Ready files can be quoted now; ${fmtInt(c.read)} read so far` : '';
    }
    renderLegend(files);
    renderTable();
    nameSections(files);
  }
  // Big clusters are drawn as sequence-order sections; name 3 of them (first, middle, last) from the real atom
  // there: its heading breadcrumb, else its first words. One small lookup per section, once per layout.
  const secAsked = new Map();
  function nameSections(files) {
    if (!api.fileAtoms) return;
    for (const f of files) {
      if (f.phase !== 'ready' || !f.id) continue;
      const seqs = map.sectionSeqs(f.id);
      if (!seqs) continue;
      const sig = seqs.join(',');
      if (secAsked.get(f.id) === sig) continue;
      secAsked.set(f.id, sig);
      const id = f.id;
      Promise.all(seqs.map((seq) => api.fileAtoms(id, { limit: 1, around: seq, span: 0 }).then((r) => {
        const it = ((r && r.items) || []).find((x) => Number(x.seq) === seq) || ((r && r.items) || [])[0];
        if (!it) return null;
        // the section's own heading: the parent of the leaf ("Warranty > Frames part 2" → "Warranty"), else the leaf
        const parts = it.meta && it.meta.breadcrumb ? String(it.meta.breadcrumb).split(' > ').map((x) => x.trim()).filter(Boolean) : [];
        const crumb = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
        let t = cleanText(crumb || String(it.text || '').split(/\s+/).slice(0, 4).join(' ')).replace(/[.,;:]+$/, '');
        if (!t) return null;
        if (t.length > 24) t = `${t.slice(0, 23).trimEnd()}…`;
        return { seq, text: t };
      }).catch(() => null))).then((names) => {
        if (destroyed || secAsked.get(id) !== sig) return;
        map.setSectionNames(id, names.filter(Boolean));
      });
    }
  }

  function hudStageText(files) {
    const busy = files.filter((f) => !TERMINAL.has(f.phase));
    if (!busy.length) return '';
    const chunks = files.reduce((acc, f) => acc + (RANK[f.phase] >= RANK.chunked ? Number(f.chunks) || 0 : 0), 0);
    const top = busy.reduce((a, f) => (RANK[f.phase] > RANK[a.phase] ? f : a), busy[0]);
    if (chunks) return `atomizing · ${plural(chunks, 'chunk')}`;
    return { queued: 'waiting to upload', uploading: 'uploading', uploaded: 'extracting text', extracted: 'chunking' }[top.phase] || 'learning';
  }

  // ================================================================== rows

  const rowEls = new Map();  // localId -> refs

  /** ms since this file's stage last really changed, when that is a stall (>= 45 s), else 0. Uses the server's
   *  stage stamps, so a reload keeps counting from the real change instead of restarting at 0. */
  function stallElapsed(f) {
    if (!f || TERMINAL.has(f.phase) || f.phase === 'queued' || f.phase === 'uploading') return 0;
    const m = rowMeta.get(f.localId) || {};
    const now = Date.now();
    let since = m.lastChangeAt || now;
    const stamps = Object.values(f.stageAt || {}).map(Number).filter((t) => Number.isFinite(t) && t > 0 && t <= now + 1000);
    if (stamps.length) since = Math.min(since, Math.max(...stamps));
    const el = Math.max(now - since, Number(f.stalledFor) || 0);
    return el >= STALL_MS ? el : 0;
  }
  const fmtDur = (ms) => { const t = Math.floor(ms / 1000), mm = Math.floor(t / 60), ss = t % 60; return mm ? `${mm}m ${ss}s` : `${ss}s`; };
  const STAGE_WORD = { uploaded: 'Extracting', extracted: 'Chunking', chunked: 'Atomizing', atomized: 'Encoding your knowledge', vectorizing: 'Encoding your knowledge' };
  function phaseLabel(f) {
    const m = rowMeta.get(f.localId) || {};
    if (unreachable && f.id && !TERMINAL.has(f.phase) && f.phase !== 'uploading' && f.phase !== 'queued') return 'Waiting for connection';
    const st = stallElapsed(f);
    // short enough for the 25ch status cell; "no progress" lives on the note line under it, beside the timer
    if (st) return `${STAGE_WORD[f.phase] || 'Working'} · ${fmtDur(st)}`;
    switch (f.phase) {
      case 'queued': return 'Queued';
      case 'rejected': return 'Not added';
      case 'uploading': return m.retryAt ? 'Waiting to retry' : `Uploading · ${f.bytes ? Math.floor((f.sent || 0) / f.bytes * 100) : 0}%`;
      // live counts as soon as the stage events carry them: bytes in, then chunks, atoms, vectors
      case 'uploaded': return `Extracting · ${fmtSize(f.bytes)}`;
      case 'extracted': return f.pages ? `Chunking · ${plural(f.pages, 'page')}` : `Chunking · ${fmtSize(f.bytes)}`;
      case 'chunked': return f.chunks ? `Atomizing · chunks ${fmtInt(f.chunks)}` : 'Atomizing…';
      case 'atomized': return f.chunks ? `chunks ${fmtInt(f.chunks)} · atoms ${fmtInt(f.atoms || 0)}` : `Atomized · ${plural(f.atoms || 0, 'atom')}`;
      case 'vectorizing': {
        const t = `atoms ${fmtInt(f.atoms || 0)} · encoded ${fmtInt(f.vectorized || 0)}/${fmtInt(f.atoms || 0)}`;
        return t.length <= 25 ? t : `encoded ${fmtInt(f.vectorized || 0)}/${fmtInt(f.atoms || 0)}`;
      }
      case 'ready': return `Ready · ${plural(f.atoms || 0, 'atom')}`;
      case 'failed': return 'Failed';
      default: return f.phase || '';
    }
  }

  function buildRow(f) {
    const nameId = uid('in-name');
    const li = h('li', { class: 'in-row', dataset: { local: f.localId, phase: f.phase }, style: { '--hue': `var(--f${f.hue % 8})` } });
    const inc = h('input', { type: 'checkbox', class: 'in-inc-box', checked: true });
    const incLabel = h('label', { class: 'in-inc', title: 'Include in answers' }, inc, h('span', { class: 'in-inc-ui', 'aria-hidden': 'true', html: icon('check', { size: 12 }) }), h('span', { class: 'in-sr' }, `Search ${f.name} when answering`));
    listen(inc, 'change', () => {
      const cur = getState().files[f.localId];
      if (!cur || !cur.id) return;
      emit('spec:request', { patch: { sources: { ...(getState().spec.sources || {}), [cur.id]: inc.checked } }, by: 'scope' });
      writeFile(f.localId, { enabled: inc.checked }, 'ingest:scope');
      afterChange(f.localId);
    });
    const ico = h('span', { class: 'in-ico', html: htmlKindIcon(f.kind, 18) });
    const name = h('span', { class: 'in-name', id: nameId, title: f.name }, h('span', { 'aria-hidden': 'true', class: 'in-name-v' }, mid(f.name, isMobile() ? 24 : 38)), h('span', { class: 'in-sr' }, f.name));
    const tag = h('span', { class: 'chip violet is-label in-tag', hidden: !f.sample }, 'Sample');
    const size = h('span', { class: 'in-size in-num' }, fmtSize(f.bytes));
    // the file's real first line while it is being extracted, with a scan sweep (decorative: the status says it)
    const readT = h('span', { class: 'in-read-t' });
    const read = h('span', { class: 'in-read', hidden: true, 'aria-hidden': 'true' }, readT);
    const status = h('span', { class: 'in-status in-num' });
    // per-file actions: KnowDrive's <RowActionMenu> (kdw.js adds the menu keyboard and fixed placement)
    const kebab = h('span', { class: 'in-kebab' });
    const rowMenu = mountRowMenu(kebab, rowMenuProps(f));
    const main = h('div', { class: 'in-row-main' }, incLabel, ico, h('div', { class: 'in-namewrap' }, name, tag, size, read), status, kebab);

    // the file's processing state: KnowDrive's FileGauge (four stage pips + F/V search badges, a report card on hover,
    // focus or tap), mounted as a React island by kdw.js from the file's real counts (gaugeProps)
    const track = h('div', { class: 'in-gauge' });
    const gauge = mountWidget(track, 'FileGauge', gaugeProps(f, { failNode: f.phase === 'failed' ? failNodeOf(f) : null }));
    const note = h('p', { class: 'in-note' });
    const actions = h('div', { class: 'in-actions' });
    const detailInner = h('div', { class: 'in-detail-in' }, track, note, actions);
    // The track and the Ready summary share one grid cell, so a row keeps the same height from the first stage to
    // Ready (no collapse that would shift everything below it); Ready cross-fades the track out, the summary in.
    const summary = h('div', { class: 'in-sum', hidden: true });
    const detail = h('div', { class: 'in-detail' }, detailInner, summary);
    li.append(main, detail);
    const refs = { li, inc, incLabel, ico, name, tag, size, read, readT, status, kebab, track, gauge, gaugeKey: '', rowMenu, menuKey: '', note, actions, detail, summary, lastPhase: null, actionsKey: '', summaryKey: '', readKey: '' };
    rowEls.set(f.localId, refs);
    return refs;
  }

  function failNodeOf(f) {
    // the node after the last stage that really happened
    const at = f.stageAt || {};
    const order = ['uploaded', 'extracted', 'chunked', 'atomized', 'vectorizing'];
    let last = -1;
    order.forEach((s, i) => { if (at[s]) last = i; });
    const m = rowMeta.get(f.localId);
    if (m && m.lastGood) last = Math.max(last, order.indexOf(m.lastGood));
    if (f.id == null) return 0;                 // never uploaded: the upload failed
    return clamp(last + 1, 1, 5);
  }

  // New rows are built at most 2 per frame: a batch of 4 sample rows (or a 20-file drop) never becomes one long task.
  // A deferred row's place is held by its skeleton, so nothing below moves while the batch lands.
  // one new row per frame (round-7 4x-throttle trace: two fresh rows + the map's first layout in one frame was a
  // 150 ms frame); the skeletons hold the batch's height meanwhile
  let freshBudget = 1, budgetRaf = 0, builtAt = -1;
  const pendingRows = new Set();
  function takeFresh(lid) {
    if (!budgetRaf) {
      budgetRaf = requestAnimationFrame(() => {
        budgetRaf = 0; freshBudget = 1;
        const list = [...pendingRows]; pendingRows.clear();
        for (const x of list) renderRow(x);
        if (!pendingRows.size && !samplesBusy) { clearSkeletons(); }
        afterChange(null);
      });
    }
    if (freshBudget > 0) { freshBudget--; builtAt = 1; return true; }
    pendingRows.add(lid);
    return false;
  }
  function renderRow(lid) {
    const f = getState().files[lid];
    if (!f) return;
    let r = rowEls.get(lid);
    let fresh = false;
    if (!r) {
      if (pendingRows.has(lid) || !takeFresh(lid)) return;
      r = buildRow(f); fresh = true; placeRow(lid, r.li);
    }
    const m = meta(lid);
    const phaseChanged = r.lastPhase !== f.phase;
    // every write below is skipped when the value is unchanged: a row re-render per stage event must not dirty
    // style / layout for the whole intake (round-5 trace: row renders were the long frames' layout source)
    setDs(r.li, 'phase', f.phase);
    setVar(r.li, '--hue', `var(--f${f.hue % 8})`);
    setDs(r.li, 'off', isEnabled(f) ? '' : 'off');
    r.li.classList.toggle('st-working', !TERMINAL.has(f.phase) && f.phase !== 'queued' && !(meta(lid).retryAt));
    setHidden(r.tag, !f.sample);
    setText(r.size, fmtSize(f.bytes));
    // include toggle only once the file exists on the server and can be searched
    const canScope = !!f.id && f.phase !== 'failed' && f.phase !== 'rejected';
    setHidden(r.incLabel, !canScope);
    if (r.inc.checked !== isEnabled(f)) r.inc.checked = isEnabled(f);
    if (r.inc.disabled !== !canScope) r.inc.disabled = !canScope;
    { const t = phaseLabel(f); if (r.status.textContent !== t) r.status.textContent = t; }
    setHidden(r.kebab, f.phase === 'queued');
    { const mk = menuKeyOf(f); if (mk !== r.menuKey) { r.menuKey = mk; r.rowMenu.update(rowMenuProps(f)); } }
    // reading line: from upload until the atoms exist (then the map's shatter shows the real chunks)
    const rl = reading.get(lid);
    // the quoted first line stays on the row after the atoms exist (Ready included), truncated and without the scan
    const showRead = !!(rl && rl.length && RANK[f.phase] >= RANK.uploading && f.phase !== 'failed' && f.phase !== 'rejected');
    const readState = !showRead ? '' : RANK[f.phase] <= RANK.chunked ? 'yes' : 'done';
    const rk = showRead ? `${readState}|${rl[0]}` : '';
    if (rk !== r.readKey) {
      r.readKey = rk;
      r.read.hidden = !showRead;
      r.li.dataset.reading = readState;
      if (showRead) { r.readT.textContent = `“${rl[0]}”`; r.read.title = rl.join(' / '); }
    }

    // the gauge: re-rendered only when what it shows changed (React diffs the rest)
    {
      const gp = gaugeProps(f, { failNode: f.phase === 'failed' ? (m.failedNode ?? failNodeOf(f)) : null });
      const gk = JSON.stringify(gp);
      if (gk !== r.gaugeKey) { r.gaugeKey = gk; r.gauge.update(gp); }
    }

    // note + actions per state
    renderNote(f, r, m);
    renderActions(f, r, m);
    renderSummary(f, r);

    if (phaseChanged) {
      if (!fresh && f.phase === 'ready') readyMorph(r);
      if (!fresh && f.phase === 'failed') failMotion(r);
      r.lastPhase = f.phase;
    }
    if (fresh) enterRow(r.li);
  }

  function renderNote(f, r, m) {
    let text = '';
    let kind = '';
    let stall = '';
    if (f.phase === 'rejected' || f.phase === 'failed') { text = (f.error && f.error.message) || 'Something went wrong with this file.'; kind = 'bad'; }
    else if (f.phase === 'uploading' && m.retryAt) {
      const s = Math.max(0, Math.ceil((m.retryAt - Date.now()) / 1000));
      text = m.retryKind === 'busy' ? `Studio is busy, retrying in ${s}s…` : `Connection lost at ${m.lostPct ?? 0}%. Retrying in ${s}s… (retry ${m.attempt} of 3)`;
      kind = 'warn';
    } else if (unreachable && f.id && !TERMINAL.has(f.phase) && f.phase !== 'uploading' && f.phase !== 'queued') {
      text = "Can't reach Studio right now. The file keeps processing on the server; retrying every few seconds.";
      kind = 'warn';
    } else if (!TERMINAL.has(f.phase) && f.phase !== 'queued') {
      // owner: a long step is not "no progress". Only the server's stalledFor (10 min allowance while vectorizing,
      // knowDrive reports vectors in one batch at the end) earns a warning; otherwise a calm "still working" line.
      if (Number(f.stalledFor) > 0) {
        stall = 'yes';
        text = `Taking longer than usual · still ${DOING[f.phase] || 'working'} after ${mmss(Number(f.stalledFor))} · you can ask about ready files meanwhile`;
        kind = 'stall';
      } else if (f.phase === 'vectorizing' && stallElapsed(f)) {
        text = `Still ${DOING[f.phase] || 'working'} · ${mmss(stallElapsed(f))} so far · the count updates when the batch finishes`;
        kind = 'muted';
      }
    } else if (f.phase === 'queued') { text = 'Waiting for an upload slot…'; kind = 'muted'; }
    setDs(r.li, 'stall', stall);
    setText(r.note, text);
    setDs(r.note, 'kind', kind);
    // failures, retries and stalls are KnowDrive inline alerts; the calm "still working" line stays plain text
    { const cls = `in-note${kind === 'bad' ? ' alert alert-danger' : kind === 'warn' || kind === 'stall' ? ' alert alert-warn' : ''}`; if (r.note.className !== cls) r.note.className = cls; }
    setHidden(r.note, !text);
    // rows with something to say (stall, retry, failure) never fold into the compact one-line form
    setDs(r.li, 'note', text && kind !== 'muted' ? 'yes' : '');
  }

  function actionList(f, m) {
    if (f.phase === 'rejected') {
      const a = ['remove'];
      if (f.error && f.error.code === 'quota') a.push('files');
      return a;
    }
    if (f.phase === 'failed') {
      const acts = (f.error && Array.isArray(f.error.actions) && f.error.actions.length) ? f.error.actions.slice() : ['retry', 'replace', 'remove'];
      return acts;
    }
    if (f.phase === 'uploading' && m.retryAt) return ['retrynow', 'remove'];
    if (unreachable && f.id && !TERMINAL.has(f.phase) && f.phase !== 'queued') return ['reconnect'];
    return [];
  }
  const ACTION_LABEL = { reconnect: 'Retry now', retry: 'Retry', retrynow: 'Retry now', replace: 'Replace', remove: 'Remove', files: 'Show my files' };
  function renderActions(f, r, m) {
    const acts = actionList(f, m);
    const key = acts.join(',');
    if (key === r.actionsKey) return;
    const had = !!r.actionsKey;
    r.actionsKey = key;
    r.actions.innerHTML = '';
    r.actions.hidden = !acts.length;
    acts.forEach((a, i) => {
      const b = h('button', { type: 'button', class: `btn ${i === 0 && a !== 'remove' ? 'btn-primary' : 'btn-ghost'} in-btn${i === 0 && a !== 'remove' ? ' in-btn-primary' : ''} in-act-${a}`, onclick: () => doAction(f.localId, a) },
        a === 'retry' || a === 'retrynow' || a === 'reconnect' ? h('span', { html: icon('refresh', { size: 14 }) }) : a === 'replace' ? h('span', { html: icon('upload', { size: 14 }) }) : a === 'remove' ? h('span', { html: icon('x', { size: 14 }) }) : null,
        ACTION_LABEL[a] || a);
      b.setAttribute('aria-describedby', r.name.id);
      r.actions.append(b);
    });
    if (acts.length && !had && !reduced()) {
      motion.stagger ? motion.stagger(r.actions.children, [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' }, 40) : null;
    }
  }
  function renderSummary(f, r) {
    const s = f.summary && (f.summary.oneLine || (f.topics && f.topics.length)) ? f.summary : null;
    const key = f.phase === 'ready' && s ? `${s.oneLine}|${(f.topics || []).join('|')}` : '';
    if (key === r.summaryKey) return;
    r.summaryKey = key;
    r.summary.innerHTML = '';
    r.summary.hidden = !key;
    r.li.dataset.sum = key ? 'yes' : '';
    if (!key) return;
    const line = h('p', { class: 'in-sum-l', title: s.oneLine || '' }, s.oneLine || '');
    const tops = h('div', { class: 'in-topics' }, (f.topics || []).slice(0, 3).map((t) => h('span', { class: 'chip gray is-label no-dot in-topic' }, t)));
    r.summary.append(line, tops);
    if (!reduced() && r.lastPhase === 'ready') {
      anim(line, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out', delay: 120 });
      motion.stagger && motion.stagger(tops.children, [{ opacity: 0, transform: 'translateY(4px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'spring', delay: 200 }, 60);
    }
  }
  function readyMorph(r) {
    anim(r.track, [{ transform: 'scale(.92)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'spring', essential: false });
    anim(r.status, [{ opacity: 0.2, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' });
  }
  function failMotion(r) {
    anim(r.li, [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }], { duration: 240, easing: 'out', essential: false });
  }
  function placeRow(lid, li) {
    const order = getState().fileOrder;
    const idx = order.indexOf(lid);
    let before = null;
    for (let i = idx + 1; i < order.length; i++) { const r = rowEls.get(order[i]); if (r && r.li.isConnected) { before = r.li; break; } }
    // a skeleton holds this row's place: swap it in (same height, so nothing below moves)
    if (!before && skelEls.length) { const sk = skelEls.shift(); if (sk.isConnected) { rowsEl.replaceChild(li, sk); return; } }
    rowsEl.insertBefore(li, before);
  }
  let enterBatch = 0;
  function enterRow(li) {
    if (reduced()) return;
    // fixer M r1 (D4): a row is fully opaque the moment it mounts (a long import's later rows used to sit at opacity 0
    // through a stacked delay and read as disabled); the entrance is a short transform-only settle, staggered at most
    // 180 ms. Progress lives in the stage pill, never in the row's opacity.
    const d = Math.min(180, (enterBatch++) * 45);
    setTimeout(() => { enterBatch = Math.max(0, enterBatch - 1); }, d + 30);
    anim(li, [{ transform: 'translateY(6px)' }, { transform: 'none' }], { duration: 240, delay: d, easing: 'out', essential: false });
  }
  function removeRowEl(lid) {
    const r = rowEls.get(lid);
    rowEls.delete(lid);
    if (!r) return;
    r.gauge.unmount();
    r.rowMenu.unmount();
    const go = () => {
      const sibs = () => [...rowsEl.children].filter((x) => x !== r.li);
      if (motion.flip && !reduced()) motion.flip(sibs, () => r.li.remove(), { duration: 380 });
      else r.li.remove();
    };
    if (reduced()) { go(); return; }
    anim(r.li, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(12px)' }], { duration: 220, easing: 'out' }).finished.then(go);
  }

  // ---------------------------------------------------------------- header, capacity, collapse

  // Status badges (header + collapsed chip): they wrap instead of truncating; below 480 px the words fold into
  // icons (the words stay for screen readers), so "1 failed" can never be clipped to "1 fai".
  function badges(c, learnAlways = false) {
    const out = [
      h('span', { class: 'chip gray is-label no-dot in-bd' }, h('b', { class: 'in-num' }, fmtInt(c.total)), h('span', { class: 'in-bd-w' }, c.total === 1 ? ' file' : ' files')),
      h('span', { class: 'chip gray is-label no-dot in-bd' }, h('b', { class: 'in-num' }, fmtInt(c.read)), h('span', { class: 'in-bd-w' }, c.read === 1 ? ' atom' : ' atoms')),
    ];
    if (c.learning && (learnAlways || c.ready + c.failed)) out.push(h('span', { class: 'chip violet is-label no-dot in-bd is-learn', title: `${c.learning} still learning` }, h('span', { class: 'in-bd-i', 'aria-hidden': 'true', html: icon('refresh', { size: 11 }) }), h('b', { class: 'in-num' }, String(c.learning)), h('span', { class: 'in-bd-w' }, ' learning')));
    if (c.failed) out.push(h('span', { class: 'chip amber is-label no-dot in-bd is-warn', title: `${c.failed} failed` }, h('span', { class: 'in-bd-i', 'aria-hidden': 'true', html: icon('warn', { size: 11 }) }), h('b', { class: 'in-num' }, String(c.failed)), h('span', { class: 'in-bd-w' }, ' failed')));
    if (allReadyUntil > Date.now() && !c.learning) out.push(h('span', { class: 'chip green is-label no-dot in-bd is-done' }, h('span', { class: 'in-bd-i', 'aria-hidden': 'true', html: icon('check', { size: 11 }) }), c.total === 1 ? 'Ready' : `All ${c.ready} ready`));
    return out;
  }
  // When the last file lands: one "All N ready" badge (head + chip) that fades out after 4 s
  let allReadyUntil = 0, allReadyTimer = 0, lastCountsSig = '', prevLearning = 0;
  function publishCounts(c) {
    if (prevLearning > 0 && c.learning === 0 && c.ready > 0) {
      allReadyUntil = Date.now() + 4000;
      clearTimeout(allReadyTimer);
      allReadyTimer = setTimeout(() => { allReadyUntil = 0; headMeta.dataset.sig = ''; chipSig = ''; renderHead(); }, 4100);
    }
    prevLearning = c.learning;
    const sig = `${c.total}|${c.ready}|${c.failed}|${c.learning}|${c.read}|${c.searchable}`;
    if (sig === lastCountsSig) return;
    lastCountsSig = sig;
    // CONTRACT-GAP (C, samplebot.js #st-bot-banner; B, app.js learning copy): bind the Partial pill and the
    // Builder's "N of M files ready" line to this event (or to the same rule: ready / failed / everything else),
    // and on learning === 0 swap the pill to "All N files ready" and fade it out. D cannot edit #st-bot-banner.
    emit('ingest:counts', { ...c });
  }
  // Keyed head badges: a count change rewrites the badge's text in place (no remove + insert of the whole row,
  // which re-laid out the document on every stage event); only a badge that appears or goes is inserted / removed.
  const headBadgeEls = new Map();
  function syncHeadBadges(list) {
    const want = new Set();
    let prev = null;
    const seen = {};
    for (const el of list) {
      // files / atoms share a class: key by class + its occurrence
      const key = `${el.className}#${(seen[el.className] = (seen[el.className] || 0) + 1)}`;
      want.add(key);
      let cur = headBadgeEls.get(key);
      if (cur && cur.isConnected) {
        // same badge: copy the new text into the existing nodes (the counts and words)
        const nb = el.querySelectorAll('b, .in-bd-w'), ob = cur.querySelectorAll('b, .in-bd-w');
        if (nb.length === ob.length && (key.includes('is-done') ? cur.textContent === el.textContent : true)) {
          nb.forEach((n, i) => { if (ob[i].textContent !== n.textContent) ob[i].textContent = n.textContent; });
          if (cur.title !== el.title) cur.title = el.title;
        } else { cur.replaceWith(el); cur = el; headBadgeEls.set(key, el); }
      } else { cur = el; headBadgeEls.set(key, el); }
      const next = prev ? prev.nextSibling : headMeta.firstChild;
      if (next !== cur) headMeta.insertBefore(cur, next);
      prev = cur;
    }
    for (const [key, el] of [...headBadgeEls]) if (!want.has(key)) { el.remove(); headBadgeEls.delete(key); }
  }
  // ---- time left: the server relays knowDrive's drain estimate for the store ('eta' event / hello.eta)
  let etaInfo = null;
  function etaWords(e, files) {
    if (files.some((f) => f.phase === 'queued' || f.phase === 'uploading')) return 'Uploading…';
    if (!e || e.state === 'estimating') return 'Estimating time left…';
    if (e.state === 'stalled') return 'Taking longer than usual…';
    const lo = e.low ?? e.seconds, hi = e.high ?? e.seconds;
    if (e.state === 'drained' || hi == null || hi <= 20) return 'Almost done';
    if (hi < 60) return 'Under a minute left';
    const hours = hi >= 5400, unit = hours ? 3600 : 60, u = hours ? 'h' : 'min';
    const a = Math.max(1, Math.round(Math.max(lo ?? hi, 30) / unit)), b = Math.max(a, hours ? Math.round(hi / unit) : Math.ceil(hi / unit));
    return a === b ? `About ${b} ${u} left` : `About ${a}–${b} ${u} left`;
  }
  function renderTracker(files) {
    const c = fileCounts(files);
    const on = c.learning > 0;
    setHidden(tracker, !on);
    if (!on) return;
    const counted = files.filter((f) => f.phase !== 'failed');
    const pct = Math.round(100 * counted.reduce((n, f) => n + fileProgress(f), 0) / Math.max(1, counted.length));
    etaFill.style.width = `${pct}%`;
    if (etaBar.getAttribute('aria-valuenow') !== String(pct)) etaBar.setAttribute('aria-valuenow', String(pct));
    setText(etaCount, `${fmtInt(c.ready)} of ${plural(c.total - c.failed, 'file')} ready · ${pct}%`);
    setText(etaTime, etaWords(etaInfo, files));
  }
  function renderHead() {
    const files = liveFiles();
    const all = listFiles();
    const skel = skelEls.length;
    const c = fileCounts(files);
    const atoms = c.read;
    publishCounts(c);
    renderTracker(files);
    // rebuilt from the files' real phases every time (also right after a reload restores them)
    const metaSig = `${c.total}|${c.read}|${c.learning}|${c.ready}|${c.failed}|${allReadyUntil > Date.now() ? 1 : 0}`;
    if (headMeta.dataset.sig !== metaSig) {
      headMeta.dataset.sig = metaSig;
      syncHeadBadges(files.length ? badges(c) : []);
    }
    // three or more rows: one line each (name, stage dots, count) so the whole batch stays in view while it learns
    // guarded writes: these attributes feed :has() and container rules, so a same-value write still costs a
    // document-wide style invalidation
    setDs(panel, 'compact', all.length + skel >= 3 ? 'yes' : '');
    setDs(panel, 'state', all.length || skel ? 'files' : 'empty');
    // mirrored on the slot: the slot's sizing rules read these instead of a :has() over the panel (a :has() made
    // every stage-dot attribute change re-match the whole intake slot)
    setDs(intakeSlot, 'pstate', panel.dataset.state || '');
    setHidden(empty, !!(all.length || skel));
    setHidden(body, !(all.length || skel));
    setHidden(removeSamplesBtn, !files.some((f) => f.sample));
    setHidden(replayPill, !replayLabel || !files.some((f) => f.sample));
    setText(replayPill.querySelector('.in-replay-t'), replayLabel || '');
    // Collapse to the one-line chip when everything is Ready, or as soon as a question is asked (the answer needs
    // the room more than the rows do; the chip keeps live per-file progress). New files re-open the rows.
    const allReady = files.length > 0 && all.every((f) => f.phase === 'ready');
    // skeleton rows count as busy: the pane takes its learning layout inside the click's input window
    setDs(intakeSlot, 'busy', skel || all.some((f) => f.phase !== 'ready') ? 'yes' : '');
    setDs(mapSlot, 'busy', skel || all.some((f) => !TERMINAL.has(f.phase)) ? 'yes' : '');
    setDs(mapSlot, 'files', all.length || skel ? 'yes' : '');
    // fixer M r1 (D6/D10/D4 CLS): never auto-fold on "all ready" before the first question: the fold would move the
    // thread with no input (mobile CLS 0.155) and leave the pane empty. It folds inside the ask's input window instead
    // (answer:start), or on a reload that already has answers.
    const hasAnswers = (getState().thread || []).some((a) => a && a.by !== 'proof' && a.final);
    const wantCollapsed = collapsedByUser.auto ? ((allReady && hasAnswers) || (askedCollapse && files.length > 0)) : collapsedByUser.value;
    applyCollapsed(wantCollapsed && all.length > 0 && !skel, files, atoms);
  }
  let isCollapsed = false;
  let askedCollapse = false;
  let chipSig = '';
  function fileProgress(f) {
    if (f.phase === 'ready') return 1;
    if (f.phase === 'failed' || f.phase === 'rejected') return 0;
    const r = RANK[f.phase] || 0;
    if (f.phase === 'uploading') return 0.12 * clamp((f.sent || 0) / Math.max(1, f.bytes), 0, 1);
    if (f.phase === 'vectorizing' || f.phase === 'atomized') return 0.62 + 0.36 * (f.atoms ? clamp((f.vectorized || 0) / f.atoms, 0, 1) : 0);
    return clamp((r - 1) / 6, 0.05, 0.6);
  }
  function applyCollapsed(c, files, atoms) {
    if (c) {
      const cc = fileCounts(files);
      const ready = cc.ready, failed = cc.failed, learning = cc.learning;
      const sig = `${files.length}|${atoms}|${ready}|${failed}|${allReadyUntil > Date.now() ? 1 : 0}|${isMobile() ? 'm' : ''}|${files.slice(0, 8).map((f) => `${f.localId}:${f.phase}:${Math.round(fileProgress(f) * 20)}:${isEnabled(f) ? 1 : 0}`).join(',')}`;
      if (sig !== chipSig) {
        chipSig = sig;
        chip.innerHTML = '';
        chip.append(h('span', { class: 'in-chip-t' }, 'Sources'),
          h('span', { class: 'in-chip-m' }, badges({ ...cc, read: atoms }, true)),
          h('span', { class: 'in-chip-dots' }, files.slice(0, 8).map((f) => h('span', {
            class: `in-chip-f${isEnabled(f) ? '' : ' is-off'}`, dataset: { phase: f.phase },
            style: { '--hue': `var(--f${f.hue % 8})`, '--p': fileProgress(f).toFixed(3) },
          }, h('i', { 'aria-hidden': 'true' }), h('span', { class: 'in-chip-fn' }, mid(f.name, isMobile() ? 12 : 40))))),
          h('span', { class: 'in-chip-more', 'aria-hidden': 'true' }, files.length > 6 ? `+${files.length - 6}` : ''),
          h('span', { class: 'in-chip-ico', 'aria-hidden': 'true', html: icon('chevronDown', { size: 15 }) }));
        chipDesc.textContent = learning || failed
          ? `${ready} of ${plural(files.length, 'file')} ready${learning ? `, ${learning} still learning` : ''}${failed ? `, ${failed} failed` : ''}. Show files.`
          : 'All files ready. Show files.';
      }
    }
    if (c === isCollapsed) return;
    const wasFocusIn = panel.contains(document.activeElement) && document.activeElement !== chip;
    isCollapsed = c;
    panel.dataset.collapsed = c ? 'yes' : '';
    setDs(intakeSlot, 'pcollapsed', c ? 'yes' : '');
    renderLegend(liveFiles());
    chip.hidden = !c;
    collapseBtn.setAttribute('aria-expanded', String(!c));
    if (c) {
      if (!reduced()) anim(chip, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'spring' });
      if (wasFocusIn) chip.focus({ preventScroll: true });
    } else if (!reduced()) anim(body, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'out' });
  }

  // ---- skeleton rows: reserve the final height the moment the visitor asks for samples (no shift when they land)
  const skelEls = [];
  function showSkeletons(n) {
    if (skelEls.length || listFiles().length) return;
    for (let i = 0; i < n; i++) {
      const li = h('li', { class: 'in-row is-skel', 'aria-hidden': 'true', dataset: { phase: 'queued' }, style: { '--hue': `var(--f${i % 8})` } },
        h('div', { class: 'in-row-main' }, h('span', { class: 'in-inc' }), h('span', { class: 'in-ico in-skel-b', style: { width: '18px' } }),
          h('div', { class: 'in-namewrap' }, h('span', { class: 'in-skel-b', style: { width: `${44 + ((i * 37) % 30)}%` } })), h('span', { class: 'in-status in-num' }, 'Queued'), h('span', { class: 'in-iconbtn in-kebab' })),
        h('div', { class: 'in-detail' }, h('div', { class: 'in-detail-in' },
          h('div', { class: 'in-gauge' }, h('span', { class: 'in-gauge-skel' })))));
      rowsEl.append(li);
      skelEls.push(li);
    }
    renderHead();
  }
  function clearSkeletons() {
    if (!skelEls.length) return;
    for (const li of skelEls.splice(0)) li.remove();
  }
  function setCollapsed(v) {
    const fromChip = document.activeElement === chip;
    const fromBtn = document.activeElement === collapseBtn;
    collapsedByUser.auto = false;
    collapsedByUser.value = v;
    if (v) delete intakeSlot.dataset.open; else intakeSlot.dataset.open = 'user';
    renderHead();
    if (!v && fromChip) collapseBtn.focus({ preventScroll: true });
    if (v && fromBtn) chip.focus({ preventScroll: true });
  }

  const capSegEls = new Map();
  function usedBytes() {
    const files = listFiles().filter((f) => f.phase !== 'rejected');
    const local = files.reduce((s, f) => s + (f.bytes || 0), 0);
    return { local, shown: Math.max(local, (getState().usage && getState().usage.bytes) || 0), files };
  }
  function renderCapacity() {
    const q = quota();
    const { shown, files } = usedBytes();
    const warn = shown >= q * 0.8;
    const capSig = `${q}|${shown}`;
    if (cap._sig !== capSig) {
      cap._sig = capSig;
      capBar.setAttribute('aria-valuemax', String(q));
      const setA = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
      setA(capBar, 'aria-valuenow', String(Math.min(q, shown)));
      setA(capBar, 'aria-valuetext', `${fmtMB(shown)} MB of ${fmtMB(q)} MB used`);
      setText(capLabel, `${fmtMB(shown)} MB of ${fmtMB(q)} MB`);
      setDs(cap, 'warn', warn ? 'yes' : '');
      setHidden(capWarn, !warn);
    }
    const seen = new Set();
    for (const f of files) {
      seen.add(f.localId);
      let s = capSegEls.get(f.localId);
      if (!s) {
        s = h('span', { class: 'in-seg', title: `${f.name} · ${fmtSize(f.bytes)}` }, h('i'));
        capSegEls.set(f.localId, s);
        const order = getState().fileOrder;
        let before = null;
        for (let i = order.indexOf(f.localId) + 1; i < order.length; i++) { const x = capSegEls.get(order[i]); if (x && x.isConnected) { before = x; break; } }
        capSegs.insertBefore(s, before);
        if (!reduced()) anim(s, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 600, easing: 'out', essential: false });
      }
      const pending = f.phase === 'queued' || f.phase === 'uploading';
      const sent = pending ? clamp((f.sent || 0) / Math.max(1, f.bytes), 0, 1).toFixed(3) : '1';
      const segSig = `${f.hue}|${f.bytes}|${q}|${pending ? 1 : 0}|${sent}|${f.phase === 'failed' ? 1 : 0}`;
      if (s._sig === segSig) continue;               // no style write (and no style recalc) when nothing changed
      s._sig = segSig;
      s.style.setProperty('--hue', `var(--f${f.hue % 8})`);
      s.style.flexBasis = `max(3px, ${(100 * (f.bytes || 0) / q).toFixed(4)}%)`;
      s.dataset.pending = pending ? 'yes' : '';
      s.style.setProperty('--sent', sent);
      s.dataset.state = f.phase === 'failed' ? 'failed' : '';
    }
    for (const [lid, s] of [...capSegEls]) if (!seen.has(lid)) { capSegEls.delete(lid); s.remove(); }
    setText(dropOverlay.querySelector('.in-drop-t'), `Drop to add · ${fmtMB(Math.max(0, q - shown))} MB left`);
    const each = `${Math.floor(fileCap() / 1048576)} MB`, tot = `${fmtMB(q)} MB`;
    const et = isMobile() ? `Add files · up to ${each} each, ${tot} total` : `Drop files anywhere here · up to ${each} each, ${tot} total`;
    if (emptyT.textContent !== et) emptyT.textContent = et;
    const ds = `${SUPPORTED_COPY} · up to ${each} each`;
    const dsEl = dropOverlay.querySelector('.in-drop-s');
    if (dsEl.textContent !== ds) dsEl.textContent = ds;
    const cw = `Close to the ${tot} limit.`;
    if (capWarnT.textContent !== cw) capWarnT.textContent = cw;
  }
  function shakeCapacity() {
    if (reduced()) {
      cap.dataset.flash = 'yes';
      setTimeout(() => { cap.dataset.flash = ''; }, 700);
      return;
    }
    anim(capBar, [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 240, easing: 'linear', essential: false });
    cap.dataset.flash = 'yes';
    setTimeout(() => { cap.dataset.flash = ''; }, 700);
  }

  // One place that re-renders everything a file change touches, at most once per frame: a burst of stage events
  // (4 files x 6 stages) re-renders each touched row once, then the header, the capacity bar and the map.
  let headRaf = 0;
  const dirtyRows = new Set();
  function afterChange(lid) {
    if (lid) dirtyRows.add(lid);
    if (headRaf) return;
    headRaf = requestAnimationFrame(() => {
      headRaf = 0;
      const rows = [...dirtyRows]; dirtyRows.clear();
      // a frame that builds a row leaves the map's (re)layout to the next frame: never both in one long frame
      builtAt = -1;
      for (const x of rows) renderRow(x);
      if (builtAt >= 0) { builtAt = -1; renderHead(); renderCapacity(); afterChange(null); return; }
      renderHead(); renderCapacity(); syncMap(); updateLate(); updateBand(); syncLanes();
    });
  }
  function rerenderAll() {
    const ids = new Set(getState().fileOrder);
    for (const lid of [...rowEls.keys()]) if (!ids.has(lid)) removeRowEl(lid);
    for (const lid of ids) renderRow(lid);
    afterChange(null);
  }

  // stall + retry countdown clock (1 s, only while something is in flight)
  // Safety net against a silent stream: while a server-side file is still learning and no event arrived for 8 s,
  // re-read the file list once (every 8 s at most), so a missed 'ready' can never leave a stale "1 learning".
  let lastEventAt = Date.now(), lastPollAt = 0, polling = false;
  // Reachability: while the stream is down (api says reconnecting / polling) this module probes the file list
  // itself every 4 s. Two failed probes in a row = Studio can't be reached: the in-flight rows stop counting a
  // stall and say "Waiting for connection" with [Retry now], and the header pill says so. One good probe clears it.
  let streamState = 'live', probeFails = 0, unreachable = false;
  function setUnreachable(v) {
    if (unreachable === v) return;
    unreachable = v;
    for (const f of listFiles()) if (f.id && !TERMINAL.has(f.phase)) { const m = meta(f.localId); if (!v) m.lastChangeAt = Date.now(); dirtyRows.add(f.localId); }
    // CONTRACT-GAP: the header net pill (app.js) only listens to 'sse:status'; there is no "server unreachable"
    // state in the contract. 'reconnecting' is the closest it shows; when the server answers again the api's own
    // status is replayed (app.js settles the pill on 'polling' / 'live').
    emit('sse:status', { status: v ? 'reconnecting' : streamState, from: 'ingest', unreachable: v });
    if (v) say("Can't reach Studio. Your files keep processing on the server; retrying.", 'ingest');
    else say('Connection back. Updating your files.', 'ingest');
    afterChange(null);
  }
  sub('sse:status', (d) => {
    if (!d || d.from === 'ingest') return;
    streamState = d.status || 'live';
    if (streamState === 'live') { probeFails = 0; setUnreachable(false); }
  });
  function pollIfSilent(force = false) {
    if (polling || !api.listFiles || !getState().trial.id || getState().trial.status === 'expired') return;
    const now = Date.now();
    const down = streamState !== 'live' || unreachable;
    const every = down ? 4000 : 8000;
    if (!force && ((!down && now - lastEventAt < 8000) || now - lastPollAt < every)) return;
    if (!force && !listFiles().some((f) => f.id && !TERMINAL.has(f.phase))) return;
    polling = true; lastPollAt = now;
    api.listFiles().then((r) => {
      if (destroyed || !r) return;
      probeFails = 0; setUnreachable(false);
      for (const row of (Array.isArray(r.files) ? r.files : [])) if (byId.has(row.id)) applyRow(row, { source: 'poll' });
      if (r.usage) setUsage(r.usage);
    }).catch((err) => {
      if (err && (err.status === 401 || err.code === 'expired')) return;
      // one failure is a blip; two in a row (8 s+) while the stream is down too is a lost connection
      if (++probeFails >= 2 && (streamState !== 'live' || now - lastEventAt > 12000)) setUnreachable(true);
    }).finally(() => { polling = false; });
  }
  function reconnectNow() { lastPollAt = 0; pollIfSilent(true); say('Trying to reach Studio…', 'ingest'); }
  const clock = setInterval(() => {
    pollIfSilent();
    for (const f of listFiles()) {
      if (TERMINAL.has(f.phase)) continue;
      const r = rowEls.get(f.localId);
      if (r) { renderNote(f, r, meta(f.localId)); renderActions(f, r, meta(f.localId)); const t = phaseLabel(f); if (r.status.textContent !== t) r.status.textContent = t; }
    }
  }, 1000);

  // ================================================================== state transitions (one funnel)

  /** Apply a patch from any source; runs the side effects (events, cards, announcements) exactly once. */
  function update(lid, patch, reason) {
    const res = writeFile(lid, patch, reason);
    if (!res) return;
    const { prev, next } = res;
    const m = meta(lid);
    if (prev.phase !== next.phase) {
      m.lastChangeAt = Date.now();
      if (RANK[next.phase] >= 2 && next.phase !== 'ready') m.lastGood = next.phase === 'uploaded' ? 'uploaded' : next.phase;
      if (next.phase === 'failed' && m.failedNode == null) m.failedNode = failNodeOf({ ...next, stageAt: { ...(prev.stageAt || {}), ...(next.stageAt || {}) } });
      if (next.phase !== 'failed') m.failedNode = null;
      emit('file:stage', { localId: lid, phase: next.phase, prev: prev.phase, file: next });
      stageAnnounce(next);
      if (RANK[next.phase] >= RANK.chunked && next.phase !== 'ready') fetchEarlyPreview(lid);
      if (next.phase === 'ready' && !readyEmitted.has(lid)) {
        readyEmitted.add(lid);
        if (mark) mark('firstReady');
        emit('file:ready', { localId: lid, file: next });
        emit('setup:event', { type: 'file_ready', data: { files: [{ localId: lid, id: next.id, name: next.name, atoms: next.atoms || 0 }] } });
        if (next.atoms === 0 && !next.error) { /* server maps this to failed/no_text; nothing to do */ }
      }
      if (next.phase === 'failed' && !failedEmitted.has(lid)) {
        failedEmitted.add(lid);
        emit('file:failed', { localId: lid, error: next.error });
        say(`${next.name}: ${(next.error && next.error.message) || 'processing failed'}`, 'assert');
        // one ErrorCard per file: it follows the file's later state (retrying, fixed, failed again, removed)
        if (!restored.has(lid) && !errorCards.has(lid)) { errorCards.add(lid); emit('setup:post', { role: 'assistant', card: { type: 'file-error', data: { localId: lid, name: next.name, error: next.error } } }); }
      }
      if (next.phase !== 'failed') failedEmitted.delete(lid);
      checkWaiters(lid);
    } else if (patch.stalledFor != null && (patch.stalledFor >= STALL_MS) && !(prev.stalledFor >= STALL_MS)) {
      // B says the stall line once; it reads stalledFor from file:stage
      m.lastChangeAt = Math.min(m.lastChangeAt || Date.now(), Date.now() - patch.stalledFor);
      emit('file:stage', { localId: lid, phase: next.phase, prev: prev.phase, file: next });
    }
    if (prev.vectorized !== next.vectorized || prev.atoms !== next.atoms) checkWaiters(lid);
    // the file's own first lines, from the moment it is on its way (rows created at 'uploaded' included)
    if (RANK[next.phase] >= RANK.uploading && RANK[next.phase] <= RANK.chunked && !readAsked.has(lid)) fetchReading(lid);
    afterChange(lid);
    maybeShatter(lid);
  }
  // The 'atoms' preview event arrives at the atomize stage. The chunks' text already exists at the chunk stage, so
  // ask for it once then: the shatter starts on real text as soon as there is any (an empty answer changes nothing).
  const earlyAsked = new Set();
  function fetchEarlyPreview(lid) {
    const f = getState().files[lid];
    if (!f || !f.id || restored.has(lid) || previews.has(f.id) || earlyAsked.has(f.id) || !api.fileAtoms || reduced()) return;
    earlyAsked.add(f.id);
    const id = f.id;
    api.fileAtoms(id, { limit: 12 }).then((r) => {
      const items = ((r && r.items) || []).filter((x) => x && x.text);
      if (!items.length || previews.has(id) || destroyed) return;
      onEvent('atoms', { fileId: id, items: items.map((x) => ({ seq: x.seq, atomId: x.atomId, text: String(x.text).slice(0, 200) })) });
    }).catch(() => { /* the atoms event will bring it */ });
  }
  function linesFrom(text, kind) {
    let t = String(text || '');
    if (kind === 'html' || /<[a-z][^>]*>/i.test(t.slice(0, 600))) {
      t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|title|section)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
    }
    const out = [];
    for (const raw of t.split(/\r?\n/)) {
      const l = cleanText(raw);
      if (l.length < 4 || /^[-=_*·|\s]+$/.test(l)) continue;
      out.push(l.length > 90 ? `${l.slice(0, 89).trimEnd()}…` : l);
      if (out.length >= 3) break;
    }
    return out;
  }
  function setReadingLines(lid, lines) {
    if (destroyed || !lines || !lines.length || reading.has(lid)) return;
    const f = getState().files[lid];
    if (!f || TERMINAL.has(f.phase)) return;
    reading.set(lid, lines);
    afterChange(lid);
    maybeShatter(lid);
  }
  function fetchReading(lid) {
    const f = getState().files[lid];
    if (!f || readAsked.has(lid) || restored.has(lid)) return;
    readAsked.add(lid);
    try {
      if (f.file && f.file.slice && ['txt', 'md', 'html'].includes(f.kind)) {
        f.file.slice(0, 6144).text().then((t) => setReadingLines(lid, linesFrom(t, f.kind))).catch(() => { /* no excerpt: the scan bar alone */ });
        return;
      }
      if (f.sample) {
        const base = String(f.name || '').split('/').pop();
        if (!/^[a-z0-9][\w.-]*$/i.test(base) || !/^[a-z0-9-]+$/i.test(sampleSet)) return;
        fetch(new URL(`./samples/${sampleSet}/${base}`, import.meta.url), { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.text() : '')).then((t) => setReadingLines(lid, linesFrom(String(t).slice(0, 6144), f.kind))).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
  }
  function stageAnnounce(f) {
    const key = `${f.localId}:${f.phase}`;
    if (lastStageSaid.get(f.localId) === key) return;
    lastStageSaid.set(f.localId, key);
    const word = { uploading: 'uploading', uploaded: 'uploaded, extracting', extracted: 'extracted, chunking', chunked: 'chunked, atomizing', atomized: `${plural(f.atoms || 0, 'atom')}, encoding your knowledge`, vectorizing: 'encoding your knowledge', ready: `ready, ${plural(f.atoms || 0, 'atom')}`, rejected: 'not added' }[f.phase];
    if (word && f.phase !== 'failed') say(`${f.name} ${word}`, 'ingest');
  }

  /** Server FileRow (upload response, samples, hello, file event, polling) → FileState. */
  function applyRow(row, { source = 'event' } = {}) {
    if (!row || !row.id) return null;
    let lid = byId.get(row.id);
    if (!lid) lid = matchInflight(row);
    const s = getState();
    if (!lid || !s.files[lid]) {
      const f = newFileState({ name: row.name, bytes: row.bytes, mime: row.mime, kind: row.kind || kindOf(row.name, row.mime) || 'txt', sample: !!row.sample, id: row.id });
      lid = f.localId;
      const quiet = source === 'restore' || (source === 'hello' && TERMINAL.has(row.stage));
      f.phase = 'uploaded';
      if (quiet) {
        // already there before this page load: no stage replay, no announcements, no cards, no shatter
        restored.add(lid);
        f.phase = SERVER_STAGES.has(row.stage) ? row.stage : 'uploaded';
        if (f.phase === 'failed') failedEmitted.add(lid);
        if (row.stage === 'ready') summarized.add(lid);
        lastStageSaid.set(lid, `${lid}:${f.phase}`);
      }
      byId.set(row.id, lid);
      addFileState(f);
      if (row.sample) mark && mark('firstFile');
      emit('files:added', { localIds: [lid] });
      if (quiet && f.phase === 'ready') {
        readyEmitted.add(lid);
        mark && mark('firstReady');
        queueMicrotask(() => { const cur = getState().files[lid]; if (cur) emit('file:ready', { localId: lid, file: cur, restored: true }); });
      }
    }
    byId.set(row.id, lid);
    const prev = getState().files[lid];
    let phase = SERVER_STAGES.has(row.stage) ? row.stage : prev.phase;
    // never step backwards (a late upload response after an SSE event), except into failed or out of failed on retry
    if (phase !== 'failed' && prev.phase !== 'failed' && RANK[phase] < RANK[prev.phase]) phase = prev.phase;
    const patch = {
      id: row.id, name: row.name || prev.name, bytes: Number(row.bytes ?? prev.bytes) || 0, mime: row.mime || prev.mime,
      kind: row.kind || prev.kind, sample: row.sample != null ? !!row.sample : prev.sample, enabled: row.enabled !== false,
      phase, chunks: Number(row.chunks ?? prev.chunks) || 0, atoms: Number(row.atoms ?? prev.atoms) || 0,
      vectorized: Number(row.vectorized ?? prev.vectorized) || 0, pages: row.pages ?? prev.pages ?? null,
      stageAt: row.stageAt || prev.stageAt || {}, key: row.key || prev.key || null,
      stalledFor: Number(row.stalledFor) || 0, replay: !!row.replay || !!prev.replay,
    };
    if (phase === 'failed') patch.error = { code: (row.error && row.error.code) || 'upstream', message: (row.error && row.error.message) || 'Processing failed on our side. Try again.', raw: row.error && row.error.raw, actions: ['retry', 'replace', 'remove'] };
    else if (prev.phase === 'failed' && phase !== 'failed') patch.error = null;
    else if (RANK[phase] >= 2) patch.error = null;
    if (row.summary && (row.summary.oneLine || (row.summary.topics || []).length)) {
      patch.summary = { oneLine: row.summary.oneLine || '', topics: row.summary.topics || [] };
      patch.topics = (row.summary.topics || []).slice(0, 3);
    }
    if (patch.stalledFor >= STALL_MS) { const m = meta(lid); m.lastChangeAt = Math.min(m.lastChangeAt || Date.now(), Date.now() - patch.stalledFor); }
    update(lid, patch, `ingest:${source}`);
    { const cur = getState().files[lid]; if (cur) saveHue(row.id, cur.hue); }
    if (patch.summary && phase === 'ready' && !summarized.has(lid)) applySummary({ fileId: row.id, oneLine: patch.summary.oneLine, topics: patch.summary.topics, starters: [] }, { fromRow: true });
    return lid;
  }

  /** An SSE row can arrive before its upload's 201: attach it to the in-flight upload with the same name/bytes. */
  function matchInflight(row) {
    const base = String(row.name || '').split('/').pop().replace(/ \(\d+\)(\.[a-z0-9]+)?$/i, '$1').toLowerCase();
    for (const f of listFiles()) {
      if (f.id || (f.phase !== 'uploading' && f.phase !== 'queued')) continue;
      if (Number(f.bytes) !== Number(row.bytes)) continue;
      if (String(f.name).toLowerCase() === base || base.endsWith(String(f.name).toLowerCase())) { byId.set(row.id, f.localId); return f.localId; }
    }
    return null;
  }

  // ---- summaries → FileSummaryCard (grouped: one Builder card per 1.5 s window)
  let sumBucket = [];
  let sumTimer = 0;
  function applySummary(d, { fromRow = false } = {}) {
    if (!d || !d.fileId) return;
    const lid = byId.get(d.fileId);
    if (!lid) return;
    const f = getState().files[lid];
    if (!f) return;
    const topics = (Array.isArray(d.topics) ? d.topics : []).slice(0, 3);
    const changed = !f.summary || f.summary.oneLine !== (d.oneLine || '') || JSON.stringify(f.topics || []) !== JSON.stringify(topics);
    if (changed) { writeFile(lid, { summary: { oneLine: d.oneLine || '', topics }, topics }, 'ingest:summary'); renderRow(lid); }
    const hasStarters = Array.isArray(d.starters) && d.starters.length;
    if (summarized.has(lid) && !(hasStarters && !fromRow)) return;
    const first = !summarized.has(lid);
    summarized.add(lid);
    emit('file:summary', { localId: lid, oneLine: d.oneLine || '', topics, starters: d.starters || [] });
    if (!first || restored.has(lid)) return;
    if (fromRow) {
      // the 'summary' event (with starters) normally follows the row; give it a moment, then post anyway
      sumPendingRow.set(lid, setTimeout(() => queueCard(lid, d), 1600));
      summarized.delete(lid);
      return;
    }
    queueCard(lid, d);
  }
  const sumPendingRow = new Map();
  function queueCard(lid, d) {
    clearTimeout(sumPendingRow.get(lid)); sumPendingRow.delete(lid);
    summarized.add(lid);
    if (sumBucket.some((x) => x.localId === lid)) return;
    const f = getState().files[lid];
    if (!f) return;
    sumBucket.push({ localId: lid, fileId: f.id, name: f.name, atoms: f.atoms || 0, hue: f.hue, kind: f.kind, sample: !!f.sample, oneLine: d.oneLine || '', topics: (d.topics || []).slice(0, 3), starters: (d.starters || []).slice(0, 2) });
    clearTimeout(sumTimer);
    sumTimer = setTimeout(() => {
      const files = sumBucket; sumBucket = [];
      if (!files.length) return;
      const first = files[0];
      emit('setup:post', { role: 'assistant', card: { type: 'file-summary', data: { ...first, files } } });
    }, 1500);
  }

  // ================================================================== intake: picker, validation, uploads

  function pick() {
    try { input.accept = acceptAttr(); input.click(); } catch (err) { console.error('[ingest] picker', err); }
  }

  function validate(file) {
    const name = file.name || 'file';
    const e = extOf(name);
    const kind = kindOf(name, file.type);
    if (!kind) return { code: 'type', message: `${e ? `.${e}` : 'This file'} isn't a type I can read. Supported: ${SUPPORTED_COPY}.` };
    if (!file.size) return { code: 'empty', message: `${name} is empty.` };
    if (file.size > fileCap()) return { code: 'file_too_large', message: `${name} is ${fmtMB(file.size)} MB. Files must be under ${Math.floor(fileCap() / 1048576)} MB each. Split it, or export a smaller version.` };
    const q = quota();
    // files accepted earlier in this batch are already in the store, so they are counted once here
    const used = usedBytes().shown;
    if (used + file.size > q) return { code: 'quota', message: `Adding this would bring you to ${fmtMB(used + file.size)} MB. You have ${fmtMB(Math.max(0, q - used))} MB left.` };
    return null;
  }

  function addFiles(list, { replaceAt = null } = {}) {
    const files = Array.from(list || []).filter((f) => f && typeof f === 'object' && 'size' in f);
    if (!files.length) return [];
    if (getState().trial.status === 'expired') { emit('toast', { kind: 'warn', text: 'This trial expired. Start a new bot to add files.' }); return []; }
    const ids = [];
    let accepted = 0, acceptedBytes = 0, overflow = false;
    files.forEach((file, i) => {
      const err = validate(file);
      // an unsupported type keeps a generic file icon (never a TXT badge on setup.exe)
      const f = newFileState({ name: file.name, bytes: file.size, mime: file.type, kind: kindOf(file.name, file.type) || 'file', file });
      if (err) {
        f.phase = 'rejected';
        f.error = { ...err, actions: err.code === 'quota' ? ['remove', 'files'] : ['remove'] };
        if (err.code === 'quota') overflow = true;
      } else { accepted++; acceptedBytes += file.size; }
      addFileState(f, { index: replaceAt != null ? replaceAt + i : null });
      ids.push(f.localId);
      renderRow(f.localId);
      if (err) { say(`${f.name}: ${err.message}`, 'assert'); }
      else enqueue(f.localId);
    });
    if (overflow) shakeCapacity();
    collapsedByUser.auto = true;
    askedCollapse = false;
    afterChange(null);
    emit('files:added', { localIds: ids });
    if (accepted) {
      const s = getState();
      const nonSample = ids.map((x) => s.files[x]).filter((f) => f && f.phase !== 'rejected');
      emit('setup:event', { type: 'files_queued', data: { n: accepted, mb: fmtMB(acceptedBytes), total: fmtMB(usedBytes().shown), names: nonSample.map((f) => f.name).slice(0, 6) } });
      if (getState().thread && getState().thread.filter((a) => a && a.by !== 'proof').length >= 2) { lateIngest = true; updateBand(); }
    }
    return ids;
  }

  const uploadQ = [];
  let activeUploads = 0;
  function enqueue(lid) { uploadQ.push(lid); pumpUploads(); }
  function pumpUploads() {
    while (activeUploads < 2 && uploadQ.length) {
      const lid = uploadQ.shift();
      const f = getState().files[lid];
      if (!f || f.phase !== 'queued') continue;
      startUpload(lid);
    }
  }
  function startUpload(lid) {
    const f = getState().files[lid];
    if (!f || !f.file) return;
    if (!getState().trial.id) { whenTrial(() => startUpload(lid)); return; }
    activeUploads++;
    const m = meta(lid);
    m.retryAt = 0;
    const ctrl = new AbortController();
    m.upload = ctrl;
    update(lid, { phase: 'uploading', sent: 0, error: null }, 'ingest:upload');
    let lastPatch = 0;
    const onProgress = (p) => {
      const now = performance.now();
      if (now - lastPatch < 90 && p.loaded < p.total) return;
      lastPatch = now;
      const cur = getState().files[lid];
      if (!cur || cur.phase !== 'uploading') return;
      writeFile(lid, { sent: Math.min(cur.bytes || p.loaded, p.loaded) }, 'ingest:progress');
      renderRow(lid);
      renderCapacity();
    };
    api.uploadFile(f.file, { onProgress, signal: ctrl.signal }).then((row) => {
      activeUploads--; m.upload = null; m.attempt = 0; pumpUploads();
      const cur = getState().files[lid];
      if (!cur) { if (row && row.id) api.deleteFile(row.id).catch(() => {}); return; }
      writeFile(lid, { sent: cur.bytes }, 'ingest:sent');
      m.uploadedAt = Date.now();
      if (row && row.id) {
        byId.set(row.id, lid);
        if (!row.stage) row.stage = 'uploaded';
        applyRow(row, { source: 'upload' });
      }
      if (row && row.usage) setUsage(row.usage);
      mark && mark('firstFile');
      if (!cur.sample) mark && mark('ownFile');
    }).catch((err) => {
      activeUploads--; m.upload = null; pumpUploads();
      onUploadError(lid, err);
    });
  }
  function onUploadError(lid, err) {
    const f = getState().files[lid];
    if (!f) return;
    const m = meta(lid);
    if (err && err.code === 'aborted') return;
    const st = err && err.status;
    const code = err && err.code;
    const transient = st === 0 || code === 'network' || code === 'busy' || (st === 429 && code !== 'rate_limited') || st === 503 || (st === 429);
    if (transient && (m.attempt || 0) < 3) {
      const attempt = m.attempt || 0;
      const ra = err && Number.isFinite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter * 1000 : BACKOFF[attempt];
      m.attempt = attempt + 1;
      m.retryKind = st === 429 || code === 'busy' ? 'busy' : 'network';
      m.lostPct = f.bytes ? Math.floor((f.sent || 0) / f.bytes * 100) : 0;
      m.retryAt = Date.now() + ra;
      clearTimeout(m.retryTimer);
      m.retryTimer = setTimeout(() => retryUpload(lid), ra);
      update(lid, { phase: 'uploading', error: null }, 'ingest:retry-wait');
      if (m.retryKind === 'network') say(`${f.name}: connection lost at ${m.lostPct}%. Retrying in ${Math.round(ra / 1000)} seconds.`, 'assert');
      return;
    }
    m.retryAt = 0;
    let error;
    let phase = 'failed';
    if (code === 'quota') {
      const d = (err && err.detail) || {};
      const used = Number(d.usedBytes) || usedBytes().shown - (f.bytes || 0);
      const left = Number.isFinite(Number(d.remaining)) ? Number(d.remaining) : Math.max(0, quota() - used);
      error = { code, message: `Adding this would bring you to ${fmtMB(used + (f.bytes || 0))} MB. You have ${fmtMB(left)} MB left.`, actions: ['remove', 'files'] };
      phase = 'rejected';
      shakeCapacity();
    } else if (code === 'file_too_large') { error = { code, message: `${f.name} is ${fmtMB(f.bytes)} MB. Files must be under ${Math.floor(fileCap() / 1048576)} MB each. Split it, or export a smaller version.`, actions: ['remove'] }; phase = 'rejected'; }
    else if (code === 'type') { error = { code, message: `${f.name} doesn't look like a ${(extOf(f.name) || 'supported').toUpperCase()} file I can read. Supported: ${SUPPORTED_COPY}.`, actions: ['replace', 'remove'] }; phase = 'rejected'; }
    else if (code === 'empty') { error = { code, message: `${f.name} is empty.`, actions: ['remove'] }; phase = 'rejected'; }
    else if (code === 'expired' || st === 401) { error = { code: 'expired', message: 'This trial expired, so the file wasn’t added.', actions: ['remove'] }; phase = 'rejected'; }
    else if (code === 'rate_limited') { error = { code, message: `That's a lot of uploads at once. Try again in ${Math.max(1, Math.round(err.retryAfter || 30))}s.`, actions: ['retry', 'remove'] }; }
    else if (transient) { error = { code: 'network', message: `Connection lost at ${m.lostPct ?? 0}%. Check your connection, then retry.`, actions: ['retry', 'remove'] }; }
    else error = { code: 'upstream', message: 'Upload failed on our side. Your other files are fine. Try again.', actions: ['retry', 'remove'] };
    m.attempt = 0;
    update(lid, { phase, error }, 'ingest:upload-failed');
    if (phase === 'rejected') say(`${f.name}: ${error.message}`, 'assert');
  }
  function retryUpload(lid) {
    const m = meta(lid);
    clearTimeout(m.retryTimer);
    m.retryAt = 0;
    const f = getState().files[lid];
    if (!f || !f.file) return;
    writeFile(lid, { phase: 'queued', error: null, sent: 0 }, 'ingest:requeue');
    renderRow(lid);
    enqueue(lid);
  }

  // ---------------------------------------------------------------- row actions

  async function doAction(lid, a) {
    const f = getState().files[lid];
    if (!f) return;
    if (a === 'remove') {
      // a file the visitor uploaded is confirmed first (samples and rejected rows, which never reached the bot, are not)
      if (f.id && !f.sample && f.phase !== 'rejected' && store.listenerCount('confirm:ask')) {
        const ok = await new Promise((done) => emit('confirm:ask', { title: `Remove ${f.name}?`,
          body: 'Your bot will stop answering from it. You can upload it again any time.', confirm: 'Remove file', done }));
        if (!ok || !getState().files[lid]) return;
      }
      return removeFile(lid);
    }
    if (a === 'files') { setCollapsed(false); const first = rowsEl.querySelector('.in-row:not([data-phase="rejected"])'); if (first) first.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); return; }
    if (a === 'retrynow') return retryUpload(lid);
    if (a === 'reconnect') return reconnectNow();
    if (a === 'replace') { replaceTarget = lid; replaceInput.accept = acceptAttr(); replaceInput.click(); return; }
    if (a === 'retry') {
      if (f.file) {
        const m = meta(lid); m.attempt = 0; m.failedNode = null;
        const oldId = f.id;
        if (oldId) { byId.delete(oldId); previews.delete(oldId); api.deleteFile(oldId).catch(() => {}); }
        failedEmitted.delete(lid); readyEmitted.delete(lid); summarized.delete(lid); shattered.delete(lid);
        writeFile(lid, { id: null, phase: 'queued', error: null, sent: 0, chunks: 0, atoms: 0, vectorized: 0, stageAt: {}, stalledFor: 0, summary: null, topics: [] }, 'ingest:retry');
        renderRow(lid); afterChange(null);
        if (oldId) emit('file:removed', { localId: lid, id: oldId });
        enqueue(lid);
        say(`Retrying ${f.name}.`, 'ingest');
        return;
      }
      // no local copy (restored or sample): choosing the file again is the honest retry
      replaceTarget = lid; replaceInput.accept = acceptAttr(); replaceInput.click();
    }
  }
  async function removeFile(lid, { quiet = false } = {}) {
    const f = getState().files[lid];
    if (!f) return;
    const m = meta(lid);
    clearTimeout(m.retryTimer);
    if (m.upload) { try { m.upload.abort(); } catch { /* ignore */ } }
    const qi = uploadQ.indexOf(lid); if (qi >= 0) uploadQ.splice(qi, 1);
    if (f.id) byId.delete(f.id);
    skipShatter(lid);
    removeRowEl(lid);
    const idx = getState().fileOrder.indexOf(lid);
    dropFileState(lid);
    rowMeta.delete(lid);
    resolveWaiters(lid, 'removed');
    afterChange(null);
    if (f.id) {
      emit('file:removed', { localId: lid, id: f.id });
      try { await api.deleteFile(f.id); }
      catch (err) {
        if (err && (err.status === 404)) return;
        emit('toast', { kind: 'error', text: `Couldn't remove ${f.name}. It's back in your list.` });
        // put it back so nothing silently disappears
        const s = getState();
        const order = s.fileOrder.slice(); order.splice(Math.min(idx, order.length), 0, lid);
        setState({ files: { ...s.files, [lid]: f }, fileOrder: order }, 'ingest:restore');
        byId.set(f.id, lid);
        renderRow(lid); afterChange(null);
        return;
      }
    } else emit('file:removed', { localId: lid, id: null });
    if (!quiet) say(`${f.name} removed`, 'ingest');
    // focus lands somewhere sensible
    if (!panel.contains(document.activeElement)) { const next = rowsEl.querySelector('.row-actions-trigger, button'); if (next && document.activeElement === document.body) next.focus({ preventScroll: true }); }
  }
  function replaceFile(lid, file) {
    const idx = getState().fileOrder.indexOf(lid);
    removeFile(lid, { quiet: true });
    addFiles([file], { replaceAt: Math.max(0, idx) });
  }

  // ---------------------------------------------------------------- kebab menu

  function menuItemsOf(f) {
    const items = [];
    if (f.id && RANK[f.phase] >= 5) items.push({ id: 'atoms', label: 'View atoms', ico: 'atom' });
    if (f.phase === 'failed') items.push({ id: 'retry', label: 'Retry', ico: 'refresh' });
    if (f.phase !== 'queued') items.push({ id: 'replace', label: 'Replace', ico: 'upload' });
    items.push({ id: 'remove', label: 'Remove', ico: 'x', danger: true });
    if (f.sample) items.push({ id: 'samples', label: 'Remove all sample files', ico: 'x', danger: true });
    return items;
  }
  const menuKeyOf = (f) => `${f.name}|${menuItemsOf(f).map((x) => x.id).join(',')}`;
  function rowMenuProps(f) {
    const lid = f.localId;
    return {
      label: `Actions for ${f.name}`,
      actions: menuItemsOf(f).map((it) => ({
        label: [h('span', { class: 'in-mi-ico', 'aria-hidden': 'true', html: icon(it.ico, { size: 15 }) }), it.label],
        tone: it.danger ? 'danger' : undefined,
        onSelect: () => menuAction(lid, it.id),
      })),
    };
  }
  async function menuAction(lid, id) {
    const f = getState().files[lid];
    if (!f) return;
    if (id === 'atoms') {
      let items = previews.get(f.id);
      if (!items || !items.length) { try { const r = await api.fileAtoms(f.id, { limit: 1 }); items = (r && r.items) || []; } catch { items = []; } }
      const first = items[0];
      emit('drawer:open', { fileId: f.id, atomId: first ? first.atomId : null, seq: first ? first.seq : 0 });
      return;
    }
    if (id === 'samples') { removeSamples(); return; }
    doAction(lid, id);
  }

  // ---------------------------------------------------------------- drop overlay + paste

  let dragDepth = 0;
  const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
  if (botPane) {
    listen(botPane, 'dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      if (dragDepth === 1) showDrop(true);
    });
    listen(botPane, 'dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch { /* ignore */ } });
    listen(botPane, 'dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
    listen(botPane, 'drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0; showDrop(false);
      const list = e.dataTransfer.files;
      if (list && list.length) addFiles(list);
    });
  }
  function showDrop(on) {
    renderCapacity();
    if (on) {
      dropOverlay.hidden = false;
      if (!reduced()) anim(dropOverlay, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'out' });
    } else if (!dropOverlay.hidden) {
      if (reduced()) dropOverlay.hidden = true;
      else anim(dropOverlay, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'out' }).finished.then(() => { if (!dragDepth) dropOverlay.hidden = true; });
    }
  }
  listen(window, 'dragend', () => { dragDepth = 0; showDrop(false); });
  listen(document, 'paste', (e) => {
    const list = e.clipboardData && e.clipboardData.files;
    if (!list || !list.length) return;
    e.preventDefault();
    addFiles(list);
    emit('intake:open', {});
  });

  // ================================================================== Shatter (signature, director priority 1)

  const shattered = new Set();     // localIds that already played (or skipped) the shatter
  const shatterJobs = new Map();   // localId -> {abort()}
  const slotsUsed = new Set();
  let firstShatter = true;

  function phaseRank(lid) { const f = getState().files[lid]; return f ? RANK[f.phase] : -9; }
  function waitPhase(lid, rank, signal) {
    return new Promise((resolve) => {
      const f = getState().files[lid];
      if (!f) { resolve('removed'); return; }
      if (f.phase === 'failed') { resolve('failed'); return; }
      if (RANK[f.phase] >= rank) { resolve('ok'); return; }
      const w = { lid, rank, resolve };
      waiters.add(w);
      if (signal) signal.addEventListener('abort', () => { waiters.delete(w); resolve('aborted'); }, { once: true });
    });
  }
  function checkWaiters(lid) {
    for (const w of [...waiters]) {
      if (w.lid !== lid) continue;
      const f = getState().files[lid];
      if (!f) { waiters.delete(w); w.resolve('removed'); continue; }
      if (f.phase === 'failed') { waiters.delete(w); w.resolve('failed'); continue; }
      if (RANK[f.phase] >= w.rank) { waiters.delete(w); w.resolve('ok'); }
    }
  }
  function resolveWaiters(lid, why) { for (const w of [...waiters]) if (w.lid === lid) { waiters.delete(w); w.resolve(why); } }

  // Shatter lanes: open while any file still has its shatter ahead (or one is playing), closed once all have landed.
  // Desktop: one lane per band edge (two side by side shatters); phones: a top lane for the one reading card.
  const MOB_CARD_H = 44;
  function syncLanes() {
    const { W } = map.size();
    if (!W || destroyed || map.isRetrieving()) return;
    const learning = shatterJobs.size > 0 || liveFiles().some((f) => !TERMINAL.has(f.phase) && !shattered.has(f.localId) && !restored.has(f.localId));
    if (!learning || !roomForShatter()) { map.setLanes(0, 0, 0); return; }
    if (isMobile()) { const ch = map.chrome || {}; map.setLanes(0, 0, (ch.hudBottom || 44) + 4 + MOB_CARD_H + 6); return; }
    const lw = clamp(W * 0.33, 230, 360);
    map.setLanes(lw, W >= 700 ? lw : 0, 0);
  }
  // Is there room for the choreography? Read from the map's cached size (ResizeObserver), never from layout.
  function roomForShatter() {
    const { H } = map.size();
    // phones: the 140 px band still plays one (smaller) shatter at a time; desktop needs a real band
    return !(reduced() || band.dataset.mode === 'ribbon' || tableOn || document.hidden || (H && H < (isMobile() ? 118 : 170)) || map.isRetrieving());
  }
  function maybeShatter(lid) {
    if (shattered.has(lid) || shatterJobs.has(lid)) return;
    const f = getState().files[lid];
    if (!f || !f.id) return;
    if (restored.has(lid)) { shattered.add(lid); return; }
    if (f.phase === 'failed') { shattered.add(lid); return; }
    const items = previews.get(f.id);
    const lines = reading.get(lid);
    // no real text yet: nothing to shatter (the map's reading node shows the file being read meanwhile)
    if ((!items || !items.length) && (!lines || !lines.length)) return;
    // Phase A (DocCard) starts once the text is extracted (spec 2.4): with the file's own first lines, so the card is
    // on screen while it is chunked, and two files past extract play side by side on desktop (director capacity 2)
    if (RANK[f.phase] < RANK.extracted) return;
    // no room for the choreography (ribbon, a band compacted under an answer, table view, hidden tab, a beam
    // playing): dots land directly at their real rate
    if (!roomForShatter()) { shattered.add(lid); return; }
    shattered.add(lid);
    const key = f.id;
    // no hold while queued: a file waiting for a shatter slot keeps landing real dots at its vectorized rate
    const job = { started: false, cancelled: false, ctrl: null, key };
    shatterJobs.set(lid, job);
    const run = (signal) => {
      if (job.cancelled || !roomForShatter()) return Promise.resolve();
      syncLanes();
      // every lane is taken (a narrow desktop band has one): this file's atoms land straight on the canvas
      const ln = map.getLanes();
      const lanesN = isMobile() ? 1 : (ln.l ? 1 : 0) + (ln.r ? 1 : 0);
      if (!lanesN || slotsUsed.size >= lanesN) return Promise.resolve();
      return runShatter(lid, key, signal).catch((err) => { console.error('[ingest] shatter', err); });
    };
    const done = () => { map.release(key, job.cancelled); shatterJobs.delete(lid); afterChange(null); };
    const p = motion.director && motion.director.request
      ? motion.director.request('shatter', 1, run, { region: mapSlot, maxMs: 25000 })
      : run(new AbortController().signal);
    Promise.resolve(p).then(done, done);
  }
  function skipShatter(lid) { const j = shatterJobs.get(lid); if (j) { j.cancelled = true; if (j.ctrl) j.ctrl.abort(); } shattered.add(lid); }
  function skipAllShatters() { if (motion.director && motion.director.busy() === 'shatter') motion.director.skip(); }
  /** A beam is about to play (or a question pre-empts): every shatter, running or queued, ends NOW. Its DOM goes in
   *  this same task (no fade), its atoms land straight on the canvas. One signature at a time, always. */
  function abortAllShatters() {
    for (const j of shatterJobs.values()) { j.cancelled = true; if (j.ctrl) j.ctrl.abort(); map.release(j.key, true); }
    for (const el of [...mapFx.children]) el.remove();
    skipAllShatters();
  }

  // The shatter's veil, painted into the map canvas: an elliptical panel-coloured field (72% at the core, clear at
  // the rim), the canvas twin of the old .in-veil radial-gradient element. The gradient is built once per theme.
  let veilGrad = null, veilKey = '';
  function paintVeil(g, dpr, b, a) {
    const panel = (map.colors && map.colors.panel) || '#ffffff';
    if (veilKey !== panel || !veilGrad) {
      let rgb = [255, 255, 255];
      try {
        const t = document.createElement('canvas').getContext('2d');
        t.fillStyle = '#fff'; t.fillStyle = panel;
        const n = String(t.fillStyle);
        if (/^#[0-9a-f]{6}$/i.test(n)) rgb = [1, 3, 5].map((o) => parseInt(n.slice(o, o + 2), 16));
        else { const m = n.match(/[\d.]+/g); if (m && m.length >= 3) rgb = m.slice(0, 3).map(Number); }
      } catch { /* white */ }
      const c = rgb.join(',');
      veilGrad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      veilGrad.addColorStop(0, `rgba(${c},0.72)`); veilGrad.addColorStop(0.62, `rgba(${c},0.72)`); veilGrad.addColorStop(1, `rgba(${c},0)`);
      veilKey = panel;
    }
    g.globalAlpha = clamp(a, 0, 1);
    g.setTransform(dpr * b.w / 2, 0, 0, dpr * b.h / 2, dpr * (b.x + b.w / 2), dpr * (b.y + b.h / 2));
    g.fillStyle = veilGrad;
    g.fillRect(-1, -1, 2, 2);
  }

  // Chip texts + widths for a file's preview: computed once (idle time when possible), never during the choreography.
  const chipCache = new Map();     // fileId -> {chips:[{text, w, seq, atomId, ai}], atoms, cardText}
  function prepChips(fileId, items) {
    const hit = chipCache.get(fileId);
    if (hit && hit.items === items) return hit;
    const cap = 32;
    const groups = items.map((it) => {
      const words = cleanText(it.text).split(/\s+/).filter((w) => w && w !== '·');
      const out = [];
      let i = 0, g = 0;
      while (i < words.length && out.length < 8) {
        const n = 3 + (hash32(`${it.atomId || it.seq}:${g}`) % 4);
        out.push(words.slice(i, i + n).join(' '));
        i += n; g++;
      }
      return { it, out };
    }).filter((x) => x.out.length);
    const chips = [];
    for (let round = 0; chips.length < cap; round++) {
      let any = false;
      groups.forEach((g, gi) => {
        if (round < g.out.length && chips.length < cap) {
          const text = g.out[round].length > 44 ? `${g.out[round].slice(0, 43)}…` : g.out[round];
          chips.push({ text, w: Math.ceil(textWidth(text)) + 14, seq: Number(g.it.seq) || 0, atomId: g.it.atomId, ai: gi });
          any = true;
        }
      });
      if (!any) break;
    }
    const cardText = items.map((x) => cleanText(x.text)).join(' ').slice(0, 340);
    const v = { items, chips, atoms: groups.length, cardText };
    chipCache.set(fileId, v);
    return v;
  }

  // DOM turns: the shatters' DOM batches (a DocCard, a set of strips) are serialized, one per frame, so two files
  // passing a stage together never build their DOM in the same long frame.
  let domGate = Promise.resolve();
  function domTurn() {
    let release;
    const mine = new Promise((r) => { release = r; });
    const prev = domGate;
    domGate = prev.then(() => mine);
    let freed = false;
    const free = () => { if (freed) return; freed = true; requestAnimationFrame(() => release()); setTimeout(release, 80); };
    // granted in a task right after a frame (never inside a frame callback)
    return prev.then(() => nextSlice()).then(() => free);
  }
  // The choreography's DOM work runs AFTER a frame (rAF → task), never inside a FrameRequestCallback, and in
  // slices of at most ~4 ms: a long batch of chips is spread over several frames instead of one long one.
  const nextSlice = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 50); });
  // Native WAAPI for the choreography (transform / opacity only). motion.animate() adds and removes will-change on
  // every element it touches, which would promote and drop a compositor layer per chip per phase.
  let springOk = null;
  const EZ = { out: 'cubic-bezier(.2,.8,.2,1)', spring: 'cubic-bezier(.34,1.4,.64,1)', linear: 'linear' };
  function ez(n) {
    const v = (motion.EASE && motion.EASE[n]) || EZ[n] || n || EZ.out;
    if (String(v).startsWith('linear(')) {
      if (springOk === null) { try { springOk = typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', v); } catch { springOk = false; } }
      if (!springOk) return EZ.spring;
    }
    return v;
  }

  /** Resolves with the file's real atom preview once it exists (the 'atoms' event or the early fetch), else null. */
  function waitPreview(key, signal, ms) {
    return new Promise((resolve) => {
      const have = previews.get(key);
      if (have && have.length) { resolve(have); return; }
      const t0 = performance.now();
      const iv = setInterval(() => {
        const p = previews.get(key);
        if (p && p.length) { clearInterval(iv); resolve(p); }
        else if (signal.aborted || performance.now() - t0 > ms) { clearInterval(iv); resolve(null); }
      }, 120);
    });
  }

  async function runShatter(lid, key, signal) {
    const job = shatterJobs.get(lid) || {};
    job.started = true;
    const f0 = getState().files[lid];
    if (!f0 || signal.aborted || job.cancelled) return;
    if (firstShatter) { firstShatter = false; try { motion.fpsProbe && motion.fpsProbe(3000); } catch { /* ignore */ } }
    const fast = f0.phase === 'ready';                    // Ready before we started: compressed replay (900 ms total)
    const T = fast ? { a: 160, b: 200, c: 250, d: 330, e: 200, st: 0.35 } : { a: 380, b: 600, c: 700, d: 480, e: 300, st: 1 };
    const mob = isMobile();
    const hue = `var(--f${f0.hue % 8})`;
    const anims = [];
    const localAbort = new AbortController();
    const aborted = () => signal.aborted || localAbort.signal.aborted;
    const fx = (el, kf, o = {}) => {
      let a = null;
      try { a = el.animate(kf, { duration: o.duration ?? 300, delay: Math.max(0, o.delay || 0), easing: ez(o.easing || 'out'), fill: o.fill || 'none' }); } catch { /* ignore */ }
      if (!a) return { finished: Promise.resolve(), finish() {} };
      anims.push(a);
      if (aborted()) { try { a.finish(); } catch { /* ignore */ } }
      return a;
    };
    const finishAll = () => { for (const x of anims) { try { x.finish(); } catch { /* ignore */ } } };
    signal.addEventListener('abort', finishAll, { once: true });
    // Which half of the map: the one with fewer dots under it (chips never sit on a dense cluster), unless the other
    // running shatter already holds it. Phones have one region.
    // Lanes: slot 0 plays in the left lane, slot 1 in the right one (phones: the top lane). The clusters were laid out
    // between them, so the card and its chips never cover a cluster or its label.
    const ln = map.getLanes();
    const regions = mob ? 1 : (ln.r ? 2 : 1);
    let slot = 0;
    while (slotsUsed.has(slot)) slot++;
    if (slot >= regions) return;
    slotsUsed.add(slot);
    const occId = `shatter-${slot}`;
    // everything this shatter draws lives in one host: cleanup is one element, removed in the same task on abort
    const host = h('div', { class: 'in-shatter', style: { '--hue': hue } });
    // the canvas side of this shatter (veil + chips), painted by the map: ov.paint draws the current phase
    const ov = { veil: { from: 0, to: 0, t0: 0, ms: 1 }, paint: null, playing: false };
    const veilNow = (now) => { const v = ov.veil; return v.from + (v.to - v.from) * easeOut((now - v.t0) / v.ms); };
    const veilTo = (to, ms) => { const now = performance.now(); ov.veil = { from: veilNow(now), to, t0: now, ms }; };
    job.ctrl = { abort: () => { localAbort.abort(); finishAll(); host.remove(); ov.paint = null; map.setOverlay(occId, null); map.setOccluder(occId, null); map.muteLabel(key, false); } };
    const cleanup = () => {
      slotsUsed.delete(slot);
      finishAll();
      map.setOccluder(occId, null);
      map.muteLabel(key, false);
      ov.paint = null;
      if (!host.isConnected) { map.setOverlay(occId, null); return; }
      if (!reduced() && !aborted() && host.animate) {
        veilTo(0, 140);
        const a2 = host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' });
        const end = () => { host.remove(); map.setOverlay(occId, null); };
        a2.finished.then(end, end);
      } else { host.remove(); map.setOverlay(occId, null); }
    };
    try {
      // ---- geometry: the map's cached size and chrome (no layout read anywhere in the choreography)
      const { W: sw, H: sh } = map.size();
      if (!sw || !sh) return;
      const ch0 = map.chrome || {};
      // below the HUD row on its side (the right lane clears the Table view / Pin buttons too): nothing this shatter
      // draws ever sits on the "Knowledge map" label or the buttons
      const top = mob ? (ch0.hudBottom || 44) + 4 : Math.max(44, (ch0.hudBottom || 0) + 6, slot === 1 ? (ch0.hudRBottom || 0) + 6 : 0);
      const bottom = Math.max(mob ? 8 : 34, sh - (ch0.legendTop || sh) + 6);
      const availH = Math.max(40, sh - top - bottom);
      // phones: a full-width reading card (12 px text, unscaled) in the top lane; desktop: the paper card in its lane
      // the chunk strips spread up to 14 px (scaled) above and below the card: that room is kept inside the band, so
      // the top strip never rises into the HUD row and the bottom one never sinks under the legend
      const cardScale = mob ? 1 : clamp((availH - 28) / 200, 0.5, 1);
      const lift = mob ? 4 : 14 * cardScale;
      const laneW = slot === 0 ? (ln.l || (sw - 24) / 2) : (ln.r || (sw - 24) / 2);
      const regW = mob ? sw - 24 : laneW - 12;
      const regX = mob ? 12 : slot === 0 ? 12 : sw - laneW;
      const cw = mob ? regW : 160 * cardScale, ch = mob ? MOB_CARD_H : 200 * cardScale;
      const cx = mob ? regX : regX + 4;
      const cy = mob ? top + lift : top + Math.max(lift, (availH - ch) / 2);
      // the card rises from the intake below the map
      const fromX = cx, fromY = sh + 24;
      const hgt = mob ? 20 : 18, lineH = mob ? 22 : 24, gapX = 6;
      const chipFont = mob ? MONO12 : MONO11;   // fixer M r1 (D4): never under 11 px
      const occH = mob ? ch + 8 : Math.max(ch + 36, availH + 10);

      // ---- A. DocCard: the file's real text (its first atoms when they exist, else its own first lines), with a
      // scan line sweeping down it while the server chunks it (the only motion while we wait for the real stage)
      const lines = reading.get(lid) || [];
      const pv0 = previews.get(key);
      const cardText = pv0 && pv0.length ? prepChips(key, pv0).cardText : lines.join(' ').slice(0, 340);
      // two shatters never write their DOM in the same frame: this one waits its turn (a frame after the other's)
      let rel = await domTurn(); if (aborted()) { rel(); return; }
      const scan = h('i', { class: 'in-doc-scan', 'aria-hidden': 'true' });
      const card = mob
        ? h('div', { class: 'in-doc in-doc-m', style: { left: `${cx}px`, top: `${cy}px`, width: `${cw}px`, height: `${ch}px` } },
          h('p', { class: 'in-doc-t' }, h('span', { class: 'in-doc-mn' }, `Reading ${mid(f0.name, 24)}`), ' ', cardText), scan)
        : h('div', { class: 'in-doc', style: { left: `${cx}px`, top: `${cy}px`, width: '160px', height: '200px', transform: `scale(${cardScale})` } },
          h('div', { class: 'in-doc-h' }, h('span', { html: fileIcon(f0.kind, { size: 11 }).replace(/<text[\s\S]*?<\/text>/g, '') }), h('span', { class: 'in-doc-n' }, mid(f0.name, 22))),
          h('p', { class: 'in-doc-t' }, cardText), scan);
      // a soft panel-coloured field under this shatter's lane (the chips read cleanly), painted by the map canvas
      // itself under the card, together with the chips: one canvas commit per frame, not three
      const vbox = { x: regX - 6, y: (mob ? cy : top) - 10, w: regW + 12, h: occH + 12 };
      host.append(card);
      mapFx.append(host);
      // perf (M): the card text's box is read inside a ResizeObserver callback (layout is clean there), never right
      // after a text write in phase B (that read forced a 17 ms reflow under 4x CPU throttle)
      const tGeo = { top: 0, h: 0 };
      let tRO = null;
      try { const tE = card.querySelector('.in-doc-t'); if (tE) { tRO = new ResizeObserver(() => { tGeo.top = tE.offsetTop; tGeo.h = tE.offsetHeight; }); tRO.observe(tE); } } catch { tRO = null; }
      rel();
      veilTo(1, 260);
      map.setOverlay(occId, (g, dpr, now) => {
        const va = veilNow(now);
        if (va > 0.01) paintVeil(g, dpr, vbox, va);
        if (ov.paint) ov.paint(g, dpr, now);
      }, () => ov.playing || performance.now() < ov.veil.t0 + ov.veil.ms + 20);
      // cluster labels step out of this shatter's region while it plays (re-placed, or hidden if nowhere fits)
      map.setOccluder(occId, { x: regX, y: (mob ? cy : top) - 8, w: regW, h: occH });
      // keep the row that is shattering in view in the intake: an IntersectionObserver reports where it is without
      // forcing a layout; only a row that is (partly) out of view scrolls, by exactly the missing amount
      try {
        const rr = rowEls.get(lid);
        if (rr && rr.li.isConnected && !body.hidden) {
          const vis = new IntersectionObserver((ents) => {
            vis.disconnect();
            const e = ents[ents.length - 1];
            if (!e || !e.rootBounds || e.intersectionRatio >= 0.98 || aborted()) return;
            const b0 = e.boundingClientRect, rb = e.rootBounds;
            const dy = b0.top < rb.top ? b0.top - rb.top - 6 : b0.bottom > rb.bottom ? b0.bottom - rb.bottom + 6 : 0;
            if (dy) body.scrollBy({ top: dy, behavior: reduced() ? 'auto' : 'smooth' });
          }, { root: body, threshold: [0, 0.98] });
          vis.observe(rr.li);
        }
      } catch { /* no IntersectionObserver: the row stays where the visitor left it */ }
      await fx(card, [
        { opacity: 0, transform: `translate(${fromX - cx}px, ${fromY - cy}px) scale(${cardScale * 0.42})` },
        { opacity: 1, transform: `translate(0, 0) scale(${cardScale})` },
      ], { duration: T.a, easing: 'out' }).finished;
      if (aborted()) return;

      // ---- B. Chunk: N = min(chunks, 6) horizontal strips (clip-path clones), #n badges in the card's left gutter
      let w = await waitPhase(lid, RANK.chunked, signal); if (w !== 'ok') return finishEarly(w);
      scan.remove();
      // the real chunk text, when it arrived while the card waited
      let swapped = '';
      { const pv = previews.get(key); if (pv && pv.length && pv !== pv0) { const tEl = card.querySelector('.in-doc-t'); if (tEl) { const nm = tEl.querySelector('.in-doc-mn'); swapped = prepChips(key, pv).cardText; tEl.textContent = swapped; if (nm) tEl.prepend(nm, ' '); } } }
      if (tRO) { tRO.disconnect(); tRO = null; }
      const fB = getState().files[lid];
      let N = clamp(Number(fB.chunks) || Math.ceil((fB.atoms || 6) / 3), 1, mob ? 2 : 6);
      // strip edges fall BETWEEN text lines (never through one): desktop 10 lines of 15 px under a ~31 px header,
      // phones 2 lines of 16 px. A separating strip carries whole lines, so no glyph is ever cut or doubled.
      // LN: the lines the card really shows (~27 chars a line at 9 px), so no strip is an empty slice of paper
      // one layout read (the card has been on screen for a phase already), before any strip is written
      const tEl0 = card.querySelector('.in-doc-t');
      const LH = mob ? 16 : 15, CH0 = mob ? MOB_CARD_H : 200;
      // cached box (ResizeObserver); a text swapped in just now is estimated from its length (~27 chars a line on
      // desktop, ~44 on phones) instead of measured, so no reflow is forced here
      const LH0 = tGeo.top > 0 ? tGeo.top : (mob ? 7 : 34);
      const LN = clamp(swapped ? Math.ceil(swapped.length / (mob ? 44 : 27))
        : tEl0 && tGeo.h > 0 ? Math.round(tGeo.h / LH) : (mob ? 2 : 10), 1, mob ? 2 : 10);
      N = Math.min(N, LN);
      const edge = (i) => (i <= 0 ? 0 : i >= N ? CH0 : LH0 + Math.round((i * LN) / N) * LH);
      rel = await domTurn(); if (aborted()) { rel(); return; }
      const strips = [];
      const frag = document.createDocumentFragment();
      for (let i = 0; i < N; i++) {
        const t0 = edge(i), b0 = CH0 - edge(i + 1);
        const st = card.cloneNode(true);
        st.classList.add('in-strip');
        st.style.clipPath = `inset(${t0}px 0 ${b0}px 0)`;
        st.append(h('span', { class: 'in-strip-l in-num', style: { top: `${(edge(i) + edge(i + 1)) / 2}px` } }, `#${i + 1}`));
        frag.append(st); strips.push(st);
      }
      host.append(frag);
      rel();
      card.style.visibility = 'hidden';
      const midN = (N - 1) / 2;
      await Promise.all(strips.map((st, i) => {
        const dir = i < midN ? -1 : i > midN ? 1 : 0;
        const dist = (mob ? 4 : 6 + (8 * Math.abs(i - midN)) / Math.max(1, midN)) * dir;
        st._dy = dist;
        return fx(st, [{ transform: `scale(${cardScale}) translateY(0)` }, { transform: `scale(${cardScale}) translateY(${dist}px)` }], { duration: T.b, delay: i * 40 * T.st, easing: 'spring', fill: 'forwards' }).finished;
      }));
      if (aborted()) return;

      // ---- C. Atomize: strips become chips of 3–6 real words (≤32 desktop, ≤16 mobile, 16 when frames run long;
      // halved on low detail). Chips need the real atom text: wait for it (never invent words); none in time → the
      // strips dissolve and the atoms simply land on the canvas at their real rate.
      w = await waitPhase(lid, RANK.atomized, signal); if (w !== 'ok') return finishEarly(w);
      const items = await waitPreview(key, signal, 3000);
      if (aborted()) return;
      if (!items) { strips.forEach((st) => fx(st, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'out', fill: 'forwards' })); await sleep(240); return; }
      const prep = prepChips(key, items);
      let capN = mob ? 5 : (map.frameMs > 20 || LOWCPU) ? 16 : 32; if (lowDetail()) capN = Math.max(3, Math.floor(capN / 2));
      // widths measured NOW with a fresh context, in the font the sprites are drawn with (round-5: widths cached
      // before JetBrains Mono loaded were narrower than the drawn words, so packed chips overlapped)
      try { if (document.fonts && document.fonts.load) await Promise.race([document.fonts.load(chipFont), sleep(250)]); } catch { /* fallback font */ }
      if (aborted()) return;
      const mctx = document.createElement('canvas').getContext('2d');
      mctx.font = chipFont;
      const mw = (t) => { try { return mctx.measureText(t).width; } catch { return t.length * 6.1; } };
      const areaX = mob ? regX : cx + cw + 14;
      const areaW = Math.max(70, mob ? regW : regX + regW - 6 - areaX);
      // phones: two rows of three 12 px chips in the reading card's place (5 real chips + the "+N atoms" badge)
      const chipMax = mob ? Math.floor((areaW - gapX * 2) / 3) : areaW;
      const pool = prep.chips.slice(0, capN).map((c) => ({ ...c, w: Math.min(chipMax, Math.ceil(mw(c.text)) + 14) }));
      const maxY = mob ? cy + ch - hgt + 2 : sh - bottom - hgt;
      const moreW = Math.min(chipMax, Math.ceil(mw('+00,000 atoms')) + 14);
      const flow = (n, extra) => {
        let x = 0, y = 0;
        const out = [];
        const ws = pool.slice(0, n).map((c) => Math.min(c.w, areaW));
        if (extra) ws.push(Math.min(moreW, areaW));
        for (let i = 0; i < ws.length; i++) {
          if (x + ws[i] > areaW && x > 0) { x = 0; y += lineH; }
          const py = (mob ? cy : top) + 2 + y;
          if (py > maxY) return null;
          out.push({ w: ws[i], x: areaX + x, y: py });
          x += ws[i] + gapX;
        }
        return out;
      };
      let n = pool.length, slots = null;
      while (n > 0 && !(slots = flow(n, true))) n--;
      if (!slots || !n) { strips.forEach((st) => fx(st, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'out', fill: 'forwards' })); await sleep(240); return; }
      const placed = slots.slice(0, n).map((p, i) => ({ ...p, c: pool[i] }));
      const moreSlot = slots[n];
      // ---- C/D on ONE canvas (round-5 critic: 33 DOM chips meant ~100 compositor layers, and the shatter's long
      // frames). Each chip is pre-rendered once into a small sprite (pill + its real words, ellipsized to the packed
      // width, so chips never overlap each other or the "+N atoms" badge, which has its own reserved slot). The
      // choreography then costs a few drawImage calls per frame; between phases nothing is drawn at all.
      const cdpr = Math.min(1.5, window.devicePixelRatio || 1);
      const PAD = 4;
      // colours from the map's cached theme read (no getComputedStyle on a fresh node: that forced a style recalc)
      const mc = map.colors || {};
      const hueC = (mc.f && mc.f[f0.hue % 8]) || '#6366f1', panelC = mc.panel || '#ffffff', strongC = mc.strong || '#0f172a', mutedC = mc.muted || '#64748b';
      const fit = (t, max) => {
        if (mw(t) <= max) return t;
        let n = t.length;
        while (n > 1 && mw(`${t.slice(0, n)}…`) > max) n--;
        return `${t.slice(0, n).trimEnd()}…`;
      };
      const pillPath = (g, w) => {
        const x = 0.5, y = 0.5, ww = w - 1, hh = hgt - 1, rr = 6;
        g.beginPath(); g.moveTo(x + rr, y); g.arcTo(x + ww, y, x + ww, y + hh, rr); g.arcTo(x + ww, y + hh, x, y + hh, rr);
        g.arcTo(x, y + hh, x, y, rr); g.arcTo(x, y, x + ww, y, rr); g.closePath();
      };
      const mkPill = (text, w, more) => {
        const c = document.createElement('canvas');
        c.width = Math.ceil((w + PAD * 2) * cdpr); c.height = Math.ceil((hgt + PAD * 2) * cdpr);
        const g = c.getContext('2d');
        g.setTransform(cdpr, 0, 0, cdpr, PAD * cdpr, PAD * cdpr);
        pillPath(g, w);
        g.shadowColor = 'rgba(15, 23, 42, .22)'; g.shadowBlur = 5; g.shadowOffsetY = 2;
        g.fillStyle = panelC; g.fill();
        g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
        if (!more) { g.globalAlpha = 0.13; g.fillStyle = hueC; g.fill(); }
        g.globalAlpha = more ? 0.6 : 0.42; g.lineWidth = 1; g.strokeStyle = hueC;
        if (more) g.setLineDash([3, 2]);
        g.stroke(); g.setLineDash([]);
        g.globalAlpha = 1; g.font = chipFont; g.textBaseline = 'middle'; g.fillStyle = more ? mutedC : strongC;
        const t = fit(text, w - 12);
        if (more) { g.textAlign = 'center'; g.fillText(t, w / 2, hgt / 2 + 0.5); } else { g.textAlign = 'left'; g.fillText(t, 6, hgt / 2 + 0.5); }
        return c;
      };
      const dotSp = (() => {
        const c = document.createElement('canvas');
        c.width = c.height = Math.ceil(12 * cdpr);
        const g = c.getContext('2d');
        g.setTransform(cdpr, 0, 0, cdpr, 0, 0);
        g.fillStyle = hueC; g.globalAlpha = 0.22; g.beginPath(); g.arc(6, 6, 6, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1; g.beginPath(); g.arc(6, 6, 3, 0, Math.PI * 2); g.fill();
        return c;
      })();
      const fC = getState().files[lid] || fB;
      const rest = Math.max(0, (Number(fC.atoms) || 0) - placed.length);
      // sprites in slices of ~4 ms (a 32-chip batch never becomes one long task)
      const CH = [];
      {
        let ts = performance.now();
        for (let i = 0; i < placed.length; i++) {
          const p = placed[i];
          CH.push({ x: p.x, y: p.y, w: p.w, seq: p.c.seq, ai: p.c.ai, sp: mkPill(p.c.text, p.w, false) });
          if (performance.now() - ts > 4) { await nextSlice(); if (aborted()) return; ts = performance.now(); }
        }
        if (rest > 0) CH.push({ x: moreSlot.x, y: moreSlot.y, w: moreSlot.w, more: true, ai: Math.max(0, prep.atoms - 1), sp: mkPill(`+${fmtInt(rest)} atoms`, moreSlot.w, true) });
      }
      if (aborted()) return;
      // the map's own context, handed to the overlay on each redraw (the chips are painted into the map canvas)
      let lg = null, ldpr = 1;
      // this file's own cluster label stays out of the way while its chips are in flight
      map.muteLabel(key, true);
      const atomsN = prep.atoms;
      strips.forEach((st) => fx(st, [{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(300, T.c * 0.45), easing: 'out', fill: 'forwards' }));
      // one frame callback on the shared loop per phase; it resolves when the phase's last chip has arrived
      // one phase = the map paints it on each of its frames (time-based); the phase ends on a timer, so it never
      // waits on a map that is not drawing (a hidden pane). keep: the last frame stays painted until the next phase.
      const playPhase = (totalMs, paint, keep) => new Promise((resolve) => {
        const t0 = performance.now();
        let done = false;
        const fin = () => {
          if (done) return;
          done = true; ov.playing = false; clearTimeout(tm);
          ov.paint = keep && !aborted() ? (g, dpr) => { lg = g; ldpr = dpr; paint(totalMs); } : null;
          map.kick();
          resolve();
        };
        ov.playing = true;
        ov.paint = (g, dpr, now) => { lg = g; ldpr = dpr; const el = now - t0; paint(Math.max(0, Math.min(el, totalMs))); if (el >= totalMs) queueMicrotask(fin); };
        const tm = setTimeout(fin, totalMs + 60);
        signal.addEventListener('abort', fin, { once: true });
        localAbort.signal.addEventListener('abort', fin, { once: true });
        map.kick();
      });
      const blit = (sp, cx0, cy0, w, s, a) => {
        if (a <= 0.01 || s <= 0.01) return;
        lg.globalAlpha = Math.min(1, a);
        lg.setTransform(ldpr * s, 0, 0, ldpr * s, ldpr * cx0, ldpr * cy0);
        lg.drawImage(sp, -(w / 2 + PAD), -(hgt / 2 + PAD), w + PAD * 2, hgt + PAD * 2);
      };
      // landings are applied after the map's frame (never inside its draw pass)
      const landQ = [];
      const land = (c, q) => {
        q.landed = true; landQ.push([c.seq, q.x, q.y]);
        if (landQ.length === 1) queueMicrotask(() => { for (const [sq, x, y] of landQ.splice(0)) map.spawn(key, sq, x, y); if (!haloed) { haloed = true; map.halo(key); } });
      };
      let haloed = false;
      // C. chips leave their strip and pack into rows (position eases out, scale springs: no overshoot into a neighbour)
      const durC = T.c * 0.75;
      const fromC = CH.map((c, i) => {
        const si = clamp(Math.floor((c.ai / Math.max(1, atomsN)) * N), 0, N - 1);
        // rows land top to bottom (a chip never glides across a row that is still filling)
        const row = Math.max(0, Math.round((c.y - (mob ? cy : top)) / lineH));
        const sx0 = mob ? cx + (i % 3) * (cw / 3) + 8 : cx + cw * 0.2 + ((i * 37) % Math.max(1, cw * 0.55));
        return { x: sx0, y: cy + ch * ((si + 0.5) / N) + (strips[si]?._dy || 0), d: (row * 70 + (i % 3) * 18) * T.st };
      });
      const totC = durC + Math.max(0, ...fromC.map((q) => q.d));
      await playPhase(totC, (el) => {
        // two passes: chips still in the air first, packed chips on top, so a chip gliding to the end of its row
        // passes UNDER the ones already in place instead of covering their words
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < CH.length; i++) {
            const c = CH[i], q = fromC[i];
            const p = clamp((el - q.d) / durC, 0, 1);
            if (p <= 0 || (pass === 0) === (p >= 0.92)) continue;
            const e = easeOut(p), sp = EZ_SPRING(p);
            const x = q.x + (c.x - q.x) * e, y = q.y + (c.y - q.y) * e;
            // faint while in the air, full ink only as it settles: two gliding chips never read as one run-on string
            blit(c.sp, x + c.w / 2, y + hgt / 2, c.w, 0.8 + 0.2 * sp, p < 0.55 ? (p / 0.55) * 0.3 : 0.3 + 0.7 * ((p - 0.55) / 0.45));
          }
        }
      }, true);
      if (aborted()) return;

      // ---- D. Fly: chips become 6 px dots and land on their real map coordinates; the canvas takes over
      w = await waitPhase(lid, RANK.vectorizing, signal); if (w !== 'ok') return finishEarly(w);
      // the veil lifts as the chips leave: the dots they become land in plain view
      veilTo(0, 320);
      // the chips' own seqs are reserved for the hand-off; every other atom keeps streaming in at the real rate
      map.reserve(key, placed.map((p) => p.c.seq));
      const dur = T.d + 240 * T.st;
      const clu = map.clusterOf(key);
      const toD = CH.map((c, i) => {
        const t = c.more ? clu : map.targetFor(key, c.seq);
        return t ? { x: t.x, y: t.y, d: (i % 8) * 12 * T.st, landed: false } : null;
      });
      const totD = dur + Math.max(0, ...toD.map((q) => (q ? q.d : 0)));
      await playPhase(totD, (el) => {
        for (let i = 0; i < CH.length; i++) {
          const c = CH[i], q = toD[i];
          if (!q) continue;
          const p = clamp((el - q.d) / dur, 0, 1);
          const sx = c.x + c.w / 2, sy = c.y + hgt / 2;
          if (c.more) {
            // "+N atoms" heads for the cluster and dissolves: the rest stream in on the canvas at the real rate
            const e = easeOut(p);
            // fixer M r1 (D4): it keeps its full 11 px size while it travels (it used to shrink to ~6 px), and fades
            blit(c.sp, sx + (q.x - sx) * e, sy + (q.y - sy) * e, c.w, 1, 1 - e * e);
            continue;
          }
          if (p >= 1) {
            if (!q.landed) land(c, q);
            continue;
          }
          // a short lift (30%), then the long glide onto the real coordinate
          const k = p <= 0.3 ? EZ_STD(p / 0.3) * 0.06 : 0.06 + 0.94 * easeOut((p - 0.3) / 0.7);
          const x = sx + (q.x - sx) * k, y = sy + (q.y - sy) * k;
          const pf = easeOut(clamp(p / 0.34, 0, 1));
          blit(c.sp, x, y, c.w, 1 - 0.75 * pf, 1 - pf);
          const da = p < 0.3 ? p / 0.3 : 1;
          if (da > 0.01) { lg.globalAlpha = da; lg.setTransform(ldpr, 0, 0, ldpr, ldpr * (x - 6), ldpr * (y - 6)); lg.drawImage(dotSp, 0, 0, 12, 12); }
        }
      });
      // anything still in the air when the phase ended (a slow frame) lands now
      for (let i = 0; i < CH.length; i++) { const c = CH[i], q = toD[i]; if (q && !c.more && !q.landed) { q.landed = true; map.spawn(key, c.seq, q.x, q.y); } }
      for (const [sq, x, y] of landQ.splice(0)) map.spawn(key, sq, x, y);
      map.setOccluder(occId, null);
      map.muteLabel(key, false);
      if (aborted()) return;

      // ---- E. Ready: halo pulse, label, HUD lands
      w = await waitPhase(lid, RANK.ready, signal); if (w !== 'ok') return finishEarly(w);
      map.halo(key);
      await sleep(T.e);
    } finally {
      map.release(key, aborted());
      cleanup();
    }

    function finishEarly(why) {
      if (why === 'failed' && !reduced() && host.animate) {
        // the stage that broke is shown on the row; the pieces fall away instead of flying in
        host.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(12px)' }], { duration: 220, fill: 'forwards' });
      }
      return undefined;
    }
  }

  // ================================================================== events stream (D owns it)

  // SSE file rows are coalesced per frame (latest row per file wins; rows are full snapshots and stages never step
  // back), so a burst of events costs one store write per file per frame instead of one per event.
  const rowQ = new Map();
  let rowRaf = 0;
  let rowTask = 0;
  function flushRows(budgetMs = Infinity) {
    if (rowRaf) { cancelAnimationFrame(rowRaf); rowRaf = 0; }
    if (rowTask) { clearTimeout(rowTask); rowTask = 0; }
    if (!rowQ.size || destroyed) return;
    // time-boxed: a burst of rows (4 files x several stages) is applied over a few tasks, never one long frame
    const t0 = performance.now();
    for (const [id, r] of [...rowQ]) {
      rowQ.delete(id);
      applyRow(r, { source: 'event' });
      if (rowQ.size && performance.now() - t0 > budgetMs) { rowTask = setTimeout(() => { rowTask = 0; flushRows(5); }, 0); return; }
    }
  }
  let lastTermAt = -1e9;
  function onEvent(type, data) {
    if (destroyed) return;
    lastEventAt = Date.now();
    if (type === 'file' && data && data.id) {
      // a terminal row (ready / failed) is applied at once: cards, announcements and the first-ready mark never wait
      // (one per frame: four files landing Ready in one SSE burst would otherwise be one long frame of cards)
      const term = data.stage === 'ready' || data.stage === 'failed';
      if ((term || !byId.has(data.id)) && performance.now() - lastTermAt > 24) { rowQ.delete(data.id); lastTermAt = performance.now(); applyRow(data, { source: 'event' }); return; }
      rowQ.set(data.id, data);
      // coalesced per frame, applied in a task right after it (the stage's side effects stay out of the frame)
      if (!rowRaf && !rowTask) rowRaf = requestAnimationFrame(() => { rowRaf = 0; rowTask = setTimeout(() => { rowTask = 0; flushRows(5); }, 0); });
      return;
    }
    // anything else may depend on the file rows (byId, phases): apply the queued rows first, in order
    flushRows();
    switch (type) {
      case 'hello': {
        if (data && 'eta' in data) etaInfo = data.eta || null;
        const rows = Array.isArray(data && data.files) ? data.files : null;
        if (rows) {
          const ids = new Set(rows.map((r) => r.id));
          for (const r of rows) applyRow(r, { source: 'hello' });
          if (data.reset) {
            for (const f of listFiles()) {
              const fresh = Date.now() - (meta(f.localId).uploadedAt || 0) < 15000;
              if (f.id && !fresh && !ids.has(f.id) && !['queued', 'uploading', 'rejected'].includes(f.phase)) { byId.delete(f.id); removeRowEl(f.localId); dropFileState(f.localId); emit('file:removed', { localId: f.localId, id: f.id }); }
            }
          }
        }
        if (data && data.usage) setUsage(data.usage);
        break;
      }
      case 'file': applyRow(data, { source: 'event' }); break;
      case 'atoms': {
        if (!data || !data.fileId || !Array.isArray(data.items)) break;
        const items = data.items.filter((x) => x && x.text).map((x) => ({ seq: Number(x.seq) || 0, atomId: x.atomId || null, text: String(x.text) }));
        if (!items.length) break;
        previews.set(data.fileId, items);
        for (const it of items) atomText.set(`${data.fileId}:${it.seq}`, { text: it.text.replace(/\s+/g, ' ').trim(), atomId: it.atomId });
        const lid = byId.get(data.fileId);
        if (lid && !reading.has(lid)) setReadingLines(lid, items.slice(0, 3).map((x) => cleanText(x.text)).filter((x) => x.length >= 4).map((x) => (x.length > 90 ? `${x.slice(0, 89).trimEnd()}…` : x)));
        if (lid) maybeShatter(lid);
        // chip words + widths for the choreography, measured while the browser is idle (not inside it)
        ric(() => { if (!destroyed && previews.get(data.fileId) === items) prepChips(data.fileId, items); }, 400);
        break;
      }
      case 'summary': applySummary(data); break;
      case 'usage': setUsage(data); break;
      case 'eta': etaInfo = data || null; renderTracker(liveFiles()); break;
      default: break;
    }
  }
  function openStream() {
    if (events) { try { events.close(); } catch { /* ignore */ } }
    if (!api.openEvents) return;
    events = api.openEvents({ onEvent });
  }

  let trialWaiters = [];
  function whenTrial(fn) { if (getState().trial.id && getState().trial.status !== 'expired') fn(); else trialWaiters.push(fn); }

  sub('trial:ready', (d) => {
    const rows = (d && Array.isArray(d.files)) ? d.files : [];
    for (const r of rows) applyRow(r, { source: 'restore' });
    if (d && d.usage) setUsage(d.usage);
    openStream();
    const q = trialWaiters; trialWaiters = [];
    for (const fn of q) { try { fn(); } catch (err) { console.error(err); } }
    rerenderAll();
  });
  sub('trial:expired', () => { if (events) { try { events.close(); } catch { /* ignore */ } events = null; } });

  // ---------------------------------------------------------------- samples

  let samplesBusy = false;
  async function attachSamples(set = 'lumen-bikes') {
    if (samplesBusy) return;
    if (/^[a-z0-9-]+$/i.test(String(set))) sampleSet = String(set);
    // reserve the rows' final height now (inside the click's input window), so nothing below moves when they land
    if (!listFiles().some((f) => f.sample)) {
      const info = (Array.isArray(cfg().samples) ? cfg().samples : []).find((x) => x && x.id === set);
      showSkeletons(clamp(Number(info && info.files) || 4, 1, 8));
    }
    askedCollapse = false;
    if (!getState().trial.id) { whenTrial(() => attachSamples(set)); return; }
    samplesBusy = true;
    try {
      const r = await api.attachSamples(set);
      if (r && r.replay && r.replay.label) replayLabel = r.replay.label;
      const ids = [];
      for (const row of (r && r.files) || []) { const lid = applyRow({ ...row, sample: true }, { source: 'samples' }); if (lid) ids.push(lid); }
      if (r && r.usage) setUsage(r.usage);
      if (ids.length) { mark && mark('firstFile'); emit('files:added', { localIds: ids }); }
      collapsedByUser.auto = true;
      // rows replace their skeletons one by one (2 per frame); any skeleton left over (fewer files) goes after them
      if (!pendingRows.size) clearSkeletons();
      afterChange(null);
    } catch (err) {
      clearSkeletons(); renderHead();
      const quotaErr = err && err.code === 'quota';
      if (quotaErr) shakeCapacity();
      emit('toast', { kind: 'error', text: quotaErr ? 'Not enough room left for the sample files.' : "Couldn't load the sample files. Try again.", action: quotaErr ? null : { label: 'Try again', event: 'samples:attach', detail: { set } } });
    } finally { samplesBusy = false; }
  }
  async function removeSamples() {
    const samples = listFiles().filter((f) => f.sample);
    if (!samples.length) return;
    for (const f of samples) { if (f.id) byId.delete(f.id); skipShatter(f.localId); removeRowEl(f.localId); dropFileState(f.localId); resolveWaiters(f.localId, 'removed'); emit('file:removed', { localId: f.localId, id: f.id }); }
    replayLabel = null;
    afterChange(null);
    say('Sample files removed', 'ingest');
    try { await api.removeSamples(); }
    catch { emit('toast', { kind: 'error', text: "Couldn't remove the sample files on the server. They'll be cleaned up when the trial ends." }); }
  }
  sub('samples:attach', (d) => attachSamples((d && d.set) || 'lumen-bikes'));
  sub('samples:remove', () => removeSamples());

  // ---------------------------------------------------------------- other module events

  sub('intake:pick', () => pick());
  sub('intake:open', () => {
    collapsedByUser.auto = false; collapsedByUser.value = false;
    renderHead();
    try { panel.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch { /* ignore */ }
    panel.dataset.flash = 'yes';
    setTimeout(() => { panel.dataset.flash = ''; }, 900);
  });
  sub('map:retrieval', (d) => {
    // one signature at a time: any shatter still on screen ends in this task, before the beam's first frame
    if (shatterJobs.size || mapFx.childElementCount) abortAllShatters();
    renderSrHits(d);
    // in the ribbon the beam gets room to be read: a temporary overlay peek (never a layout change)
    if (d && Array.isArray(d.hits) && !peekOn) setPeek(true);
    map.playRetrieval(d);
  });
  sub('map:highlight', (d) => map.setHighlight(d));
  // A question pre-empts: the map relaxes, any running shatter fast-forwards (its chips land at once, cheaply) and
  // the intake folds to its one-line chip so the answer gets the room. All of it inside the ask's input window.
  sub('answer:start', () => {
    map.relax();
    expanded = false;
    if (shatterJobs.size || mapFx.childElementCount) abortAllShatters();
    if (!askedCollapse && liveFiles().length) { askedCollapse = true; collapsedByUser.auto = true; renderHead(); }
  });
  sub('motion:skip', () => map.fastForward());
  sub('change:thread', () => updateBand());
  sub('change:ui', ({ value, prev } = {}) => { if (!prev || !value || value.mapPinned !== prev.mapPinned) updateBand(); });
  sub('change:spec', ({ value, prev } = {}) => {
    if (!value || !prev || JSON.stringify(value.sources || {}) === JSON.stringify(prev.sources || {})) return;
    // Integrator: a missing key means "on" (the server drops true entries, so switching a file back on yields {})
    for (const f of listFiles()) { const want = (value.sources || {})[f.id] !== false; if (f.id && want !== (f.enabled !== false)) writeFile(f.localId, { enabled: want }, 'ingest:scope'); }
    rerenderAll();
  });
  sub('change:files', ({ reason } = {}) => {
    if (reason === 'reset') {
      for (const lid of [...rowEls.keys()]) removeRowEl(lid);
      byId.clear(); previews.clear(); rowMeta.clear(); reading.clear(); readAsked.clear(); restored.clear(); summarized.clear(); readyEmitted.clear(); failedEmitted.clear(); shattered.clear();
      pendingRows.clear(); chipCache.clear(); earlyAsked.clear(); secAsked.clear();
      if (shatterJobs.size || mapFx.childElementCount) abortAllShatters();
      hueCounter = 0; replayLabel = null;
      if (events) { try { events.close(); } catch { /* ignore */ } events = null; }
      afterChange(null);
    }
  });
  sub('change:config', () => { input.accept = acceptAttr(); replaceInput.accept = acceptAttr(); renderCapacity(); });
  sub('change:usage', () => renderCapacity());

  function renderSrHits(d) {
    srList.innerHTML = '';
    const hits = (d && d.hits) || [];
    if (!hits.length) { srList.append(h('li', null, d && d.refused ? 'No atom scored above the floor.' : 'No matches.')); return; }
    hits.slice(0, 8).forEach((x) => {
      const f = listFiles().find((y) => y.id === x.fileId);
      let sim = x.similarity == null ? null : Number(x.similarity); if (sim != null && sim <= 1) sim *= 100;
      srList.append(h('li', null, `${f ? f.name : 'file'}, atom ${(Number(x.seq) || 0) + 1}, ${sim == null ? 'keyword match' : `match ${Math.round(sim)}`}, ${x.kept ? (x.cited ? 'cited' : 'used') : 'below floor, not used'}`));
    });
  }

  function updateLate() {
    if (!lateIngest) return;
    const busy = listFiles().some((f) => !TERMINAL.has(f.phase));
    if (!busy && !lateTimer) lateTimer = setTimeout(() => { lateTimer = 0; lateIngest = false; updateBand(); }, 1500);
    if (busy && lateTimer) { clearTimeout(lateTimer); lateTimer = 0; }
  }

  // ================================================================== Builder cards (registered by D)

  registerCard('file-summary', (data, el) => {
    let gauges = [];
    const gaugeFor = (cur, f) => {
      const host = h('span', { class: 'in-card-gauge' });
      // the card lists files that just became Ready; the gauge reads the live state when there is one
      gauges.push(mountWidget(host, 'FileGauge', gaugeProps(cur.phase ? cur : { name: f.name, phase: 'ready', atoms: Number(f.atoms) || 0, vectorized: Number(f.atoms) || 0 })));
      return host;
    };
    const render = (d) => {
      const files = Array.isArray(d.files) && d.files.length ? d.files : [d];
      for (const g of gauges) g.unmount();
      gauges = [];
      el.innerHTML = '';
      const atoms = files.reduce((s, f) => s + (Number(f.atoms) || 0), 0);
      const card = h('div', { class: 'card in-card in-card-sum' },
        h('p', { class: 'in-card-h' }, h('span', { class: 'in-card-ico', html: icon('checkCircle', { size: 15 }) }),
          files.length === 1 ? 'Learned 1 file' : `Learned ${files.length} files`, h('span', { class: 'in-card-m in-num' }, ` · ${plural(atoms, 'atom')}`)),
        h('ul', { class: 'in-card-files' }, files.map((f) => {
          const cur = (f.localId && getState().files[f.localId]) || {};
          const hue = Number.isFinite(cur.hue) ? cur.hue : (Number(f.hue) || 0);
          const starters = (f.starters || []).map((s) => (typeof s === 'string' ? s : s && s.q)).filter(Boolean).slice(0, 1);
          return h('li', { class: 'in-card-f', style: { '--hue': `var(--f${hue % 8})` } },
            h('span', { class: 'in-card-fico', html: htmlKindIcon(cur.kind || f.kind || 'txt', 16) }),
            h('div', { class: 'in-card-fb' },
              h('p', { class: 'in-card-fn' }, h('span', { class: 'in-card-name', title: f.name }, mid(f.name, 34)), gaugeFor(cur, f), h('span', { class: 'in-card-fa in-num' }, ` Ready · ${plural(Number(f.atoms) || 0, 'atom')}`)),
              f.oneLine ? h('p', { class: 'in-card-fl' }, f.oneLine) : null,
              (f.topics || []).length ? h('div', { class: 'in-topics' }, f.topics.slice(0, 3).map((t) => h('span', { class: 'chip gray is-label no-dot in-topic' }, t))) : null,
              starters.length ? h('div', { class: 'in-card-ask' }, starters.map((q) => h('button', { type: 'button', class: 'btn btn-ghost in-btn in-btn-ghost in-ask', onclick: () => { emit('samplebot:ask', { question: q, by: 'chip' }); emit('tab:show', { tab: 'bot' }); } }, h('span', { html: icon('arrowRight', { size: 13 }) }), `Ask: “${q}”`))) : null));
        })));
      el.append(card);
      if (!reduced()) motion.stagger && motion.stagger(card.querySelectorAll('.in-card-f'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' }, 60);
    };
    render(data || {});
    return { update: (d) => render(d || {}), destroy() { for (const g of gauges) g.unmount(); gauges = []; el.innerHTML = ''; } };
  });

  registerCard('file-error', (data, el) => {
    const lid = data && data.localId;
    let un = null;
    let gauge = null;
    const render = () => {
      const f = lid ? getState().files[lid] : null;
      if (gauge) { gauge.unmount(); gauge = null; }
      el.innerHTML = '';
      const name = (f && f.name) || (data && data.name) || 'This file';
      const err = (f && f.error) || (data && data.error) || {};
      let body;
      if (!f) body = h('p', { class: 'in-card-l' }, 'Removed from your sources.');
      else if (f.phase !== 'failed') body = h('p', { class: 'in-card-l in-card-ok' }, f.phase === 'ready' ? `Fixed: ${plural(f.atoms || 0, 'atom')} ready.` : 'Retrying now…');
      else {
        const acts = (err.actions && err.actions.length ? err.actions : ['retry', 'replace', 'remove']).filter((a) => ACTION_LABEL[a]);
        body = h('div', null,
          h('p', { class: 'in-card-l' }, err.message || 'Processing failed on our side. Try again.'),
          h('div', { class: 'in-actions' }, acts.map((a, i) => h('button', { type: 'button', class: `btn ${i === 0 ? 'btn-primary' : 'btn-ghost'} in-btn${i === 0 ? ' in-btn-primary' : ''}`, onclick: () => doAction(lid, a) }, ACTION_LABEL[a]))));
      }
      el.append(h('div', { class: `card in-card in-card-err${f && f.phase === 'failed' ? '' : ' is-resolved'}` },
        h('p', { class: 'in-card-h' }, h('span', { class: 'in-card-ico', html: icon(f && f.phase !== 'failed' ? 'refresh' : 'warn', { size: 15 }) }), h('span', { class: 'in-card-name', title: name }, mid(name, 34)), f && f.phase === 'failed' ? ' couldn’t be read' : '',
          f ? (() => { const host = h('span', { class: 'in-card-gauge' }); gauge = mountWidget(host, 'FileGauge', gaugeProps(f, { failNode: f.phase === 'failed' ? (meta(lid).failedNode ?? failNodeOf(f)) : null })); return host; })() : null),
        body));
    };
    render();
    let sig = '';
    const sigOf = () => { const f = lid ? getState().files[lid] : null; return f ? `${f.phase}|${f.error && f.error.message}|${f.atoms}` : 'gone'; };
    sig = sigOf();
    if (lid) un = on('change:files', () => { const s2 = sigOf(); if (s2 !== sig) { sig = s2; render(); } });
    return { update: () => render(), destroy() { if (un) un(); if (gauge) gauge.unmount(); el.innerHTML = ''; } };
  });

  // ================================================================== boot

  // A trial that already exists when D mounts (B emits trial:ready after modules resolve; this is only a safety net)
  renderHead();
  renderCapacity();
  syncMap();
  updateBand();
  setTimeout(() => { if (!destroyed && !getState().fileOrder.length) empty.classList.add('is-in'); }, reduced() ? 0 : 1200);
  if (getState().fileOrder.length) rerenderAll();

  function destroy() {
    destroyed = true;
    for (const u of subs) { try { u(); } catch { /* ignore */ } }
    for (const off of domOff) { try { off(); } catch { /* ignore */ } }
    if (events) { try { events.close(); } catch { /* ignore */ } }
    for (const m of rowMeta.values()) { clearTimeout(m.retryTimer); if (m.upload) { try { m.upload.abort(); } catch { /* ignore */ } } }
    clearInterval(clock);
    for (const r of rowEls.values()) { r.gauge.unmount(); r.rowMenu.unmount(); }
    try { ro && ro.disconnect(); chromeRO && chromeRO.disconnect(); io && io.disconnect(); mo.disconnect(); } catch { /* ignore */ }
    mapSlot.innerHTML = ''; intakeSlot.innerHTML = ''; dropSlot.innerHTML = '';
  }

  // debugging hook (read-only use; mirrors window.__studio from B)
  const api2 = { pick, addFiles, destroy, map, _state: { byId, previews, shattered } };
  return api2;
}

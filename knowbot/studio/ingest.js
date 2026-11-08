// KnowBot Studio: ingest + atomization (owner D; SPEC 2.4, 2.5, 6.3, 1.6, 1.8).
//
// What lives here:
//   - IntakePanel (#in-intake-slot): CapacityBar (100 MB, one hue segment per file), FileRows with the 6-node
//     StageTrack driven by real server stages, stall timers, failure reasons + recovery, include toggles,
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
// CONTRACT-GAP (B, studio.css): once an answer exists the intake slot gets max 22% and the thread min 55%, so a
//   user-expanded Sources panel shows ~1 row. D marks that state with #in-intake-slot[data-open="user"].

const STAGES = [
  { key: 'upload', label: 'Upload' },
  { key: 'extract', label: 'Extract' },
  { key: 'chunk', label: 'Chunk' },
  { key: 'atomize', label: 'Atomize' },
  { key: 'vectorize', label: 'Vectorize' },
  { key: 'ready', label: 'Ready' },
];
const RANK = { rejected: -2, failed: -1, queued: 0, uploading: 1, uploaded: 2, extracted: 3, chunked: 4, atomized: 5, vectorizing: 6, ready: 7 };
const TERMINAL = new Set(['ready', 'failed', 'rejected']);
const SERVER_STAGES = new Set(['uploaded', 'extracted', 'chunked', 'atomized', 'vectorizing', 'ready', 'failed']);
// Which StageTrack node is "in progress" for each phase (index into STAGES).
const ACTIVE_NODE = { queued: -1, uploading: 0, uploaded: 1, extracted: 2, chunked: 3, atomized: 4, vectorizing: 4, ready: 6 };
const DOING = { uploading: 'uploading', uploaded: 'extracting', extracted: 'chunking', chunked: 'atomizing', atomized: 'vectorizing', vectorizing: 'vectorizing', queued: 'waiting' };

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
  return `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
}
/** lumen-warranty-returns.md -> lumen-warr…returns.md (keeps the extension). */
function mid(name, max = 30) {
  const s = String(name || '');
  if (s.length <= max) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
  const base = ext ? s.slice(0, dot) : s;
  const keep = Math.max(4, max - ext.length - 1);
  const head = Math.ceil(keep * 0.5), tail = keep - head;
  return `${base.slice(0, head)}…${base.slice(base.length - tail)}${ext}`;
}
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
  const reduced = () => (motion && motion.reduced ? motion.reduced() : document.documentElement.getAttribute('data-motion') === 'reduce');
  const anim = (el, kf, o) => (motion && motion.animate ? motion.animate(el, kf, o) : { finished: Promise.resolve(), finish() {}, cancel() {} });

  const mapSlot = slots.map || document.getElementById('in-map-slot');
  const intakeSlot = slots.intake || document.getElementById('in-intake-slot');
  const dropSlot = slots.drop || document.getElementById('in-drop-slot');
  const botPane = slots.bot || document.getElementById('st-bot');
  if (!mapSlot || !intakeSlot || !dropSlot) throw new Error('ingest: slots missing');

  const subs = [];
  const sub = (type, fn) => { subs.push(on(type, fn)); };
  // Text metrics come from a DETACHED canvas: setting .font on the on-screen canvas forces a document style recalc
  // (expensive right after rows were inserted); a detached context never does.
  const MONO10 = '500 10px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  let textCtx = null;
  const textWidth = (text, font = MONO10) => {
    try { if (!textCtx) textCtx = document.createElement('canvas').getContext('2d'); if (textCtx.font !== font) textCtx.font = font; return textCtx.measureText(text).width; } catch { return String(text).length * 6.1; }
  };
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

  function newFileState({ name, bytes, mime, kind, sample = false, file = null, id = null }) {
    const localId = uid('f');
    return {
      localId, id, name: name || 'file', bytes: Number(bytes) || 0, mime: mime || 'application/octet-stream', kind: kind || 'txt',
      hue: (hueCounter++) % 8, sample: !!sample, enabled: true, phase: 'queued',
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
  const removeSamplesBtn = h('button', { type: 'button', class: 'in-btn in-btn-ghost in-rm-samples', hidden: true, onclick: () => removeSamples() }, 'Remove sample files');
  const addBtn = h('button', { type: 'button', class: 'in-btn in-btn-add', onclick: () => pick() }, h('span', { class: 'in-btn-ico', html: icon('plus', { size: 15 }) }), h('span', null, 'Add files'));
  const collapseBtn = h('button', { type: 'button', class: 'in-iconbtn in-collapse', 'aria-expanded': 'true', 'aria-controls': panelId, title: 'Collapse sources', 'aria-label': 'Collapse sources', onclick: () => setCollapsed(!collapsedByUser.value) }, h('span', { html: icon('chevronDown', { size: 16 }) }));
  head.append(h('div', { class: 'in-head-l' }, headTitle, headMeta, replayPill), h('div', { class: 'in-head-r' }, removeSamplesBtn, addBtn, collapseBtn));

  // capacity bar
  const capLabelId = uid('in-cap');
  const cap = h('div', { class: 'in-cap' });
  const capBar = h('div', { class: 'in-cap-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(QUOTA_DEFAULT), 'aria-valuenow': '0', 'aria-labelledby': capLabelId });
  const capSegs = h('div', { class: 'in-cap-segs' });
  capBar.append(capSegs);
  const capLabel = h('span', { class: 'in-cap-label in-num', id: capLabelId });
  const capWarn = h('span', { class: 'in-cap-warn', hidden: true }, h('span', { html: icon('warn', { size: 13 }) }), 'Close to the 100 MB limit.');
  cap.append(capBar, h('div', { class: 'in-cap-row' }, capLabel, capWarn));

  const rowsEl = h('ul', { class: 'in-rows', id: panelId, 'aria-label': 'Files' });
  const empty = h('div', { class: 'in-empty' },
    h('div', { class: 'in-empty-art', 'aria-hidden': 'true', html: icon('upload', { size: 20 }) }),
    h('div', { class: 'in-empty-copy' },
      h('p', { class: 'in-empty-t' }, isMobile() ? 'Add files · up to 100 MB' : 'Drop files anywhere here · up to 100 MB'),
      h('p', { class: 'in-types' }, h('span', { class: 'in-sr' }, 'Supported types: '), TYPE_CHIPS.map((t) => h('span', { class: 'in-type' }, t)))),
    // secondary (outline) until the visitor picks the upload path: the landing has one filled primary, the Builder's
    h('button', { type: 'button', class: 'in-btn in-choose', onclick: () => pick() }, h('span', { html: icon('upload', { size: 15 }) }), 'Choose files'));
  // Collapsed one-line Sources chip. Its accessible name IS its visible text (no aria-label to drift from it);
  // the state and the action live in aria-describedby.
  const chipDescId = uid('in-chipd');
  const chipDesc = h('span', { class: 'in-sr', id: chipDescId });
  const chip = h('button', { type: 'button', class: 'in-chip', hidden: true, 'aria-expanded': 'false', 'aria-controls': panelId, 'aria-describedby': chipDescId, onclick: () => setCollapsed(false) });
  const body = h('div', { class: 'in-body' }, cap, rowsEl);
  panel.append(head, body, empty, chip, chipDesc);
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
      h('p', { class: 'in-drop-t' }), h('p', { class: 'in-drop-s' }, `${SUPPORTED_COPY} · under 95 MB each`)));
  const menu = h('div', { class: 'in-menu', role: 'menu', hidden: true, tabindex: '-1' });
  dropSlot.innerHTML = '';
  dropSlot.append(dropOverlay, menu);

  const collapsedByUser = { value: false, auto: true };

  // ================================================================== DOM: map band

  const band = h('section', { class: 'map-band', 'aria-label': 'Knowledge map', dataset: { mode: 'full', state: 'empty' } });
  const stage = h('div', { class: 'map-stage' });
  const canvas = h('canvas', { class: 'map-canvas', 'aria-hidden': 'true' });
  const hud = h('div', { class: 'map-hud' });
  const hudTitle = h('span', { class: 'map-title' }, 'Knowledge map');
  const hudCount = h('span', { class: 'map-count in-num', dataset: { value: '0' } }, '0');
  const hudCountWrap = h('span', { class: 'map-countwrap', hidden: true }, h('span', { class: 'map-sep', 'aria-hidden': 'true' }, '·'), hudCount, h('span', { class: 'map-unit' }, ' atoms'));
  const hudEmpty = h('span', { class: 'map-emptyl' }, h('span', { class: 'map-sep', 'aria-hidden': 'true' }, '·'), ' empty');
  const hudScale = h('span', { class: 'map-scale in-num', hidden: true });
  const tableBtn = h('button', { type: 'button', class: 'map-btn', 'aria-pressed': 'false', onclick: () => toggleTable() }, h('span', { html: icon('table', { size: 14 }) }), h('span', { class: 'map-btn-l' }, 'Table view'));
  const pinBtn = h('button', { type: 'button', class: 'map-btn map-pin', 'aria-pressed': 'false', onclick: () => togglePin() }, h('span', { html: icon('pin', { size: 14 }) }), h('span', { class: 'map-btn-l' }, 'Pin'));
  // before the first atom exists the HUD tells the truth about what is happening ("chunking · 6 chunks"), never "0 atoms"
  const hudStage = h('span', { class: 'map-stagel in-num', hidden: true });
  const hudL = h('div', { class: 'map-hud-l' }, h('span', { class: 'map-glyph', html: icon('atom', { size: 14 }) }), hudTitle, hudCountWrap, hudStage, hudEmpty, hudScale);
  const hudR = h('div', { class: 'map-hud-r' }, tableBtn, pinBtn);
  hud.append(hudL, hudR);
  const legend = h('div', { class: 'map-legend' });
  const legendNote = h('span', { class: 'map-note' }, 'Each dot is one atom, grouped by file');
  const legendChips = h('span', { class: 'map-chips' });
  legend.append(legendNote, legendChips);
  const tip = h('div', { class: 'map-tip', role: 'tooltip', hidden: true });
  const srHead = h('h3', { class: 'in-sr' }, 'Top matches for the last question');
  const srList = h('ol', { class: 'in-sr map-sr' }, h('li', null, 'No question asked yet.'));
  const table = h('div', { class: 'map-table', hidden: true, tabindex: '0', role: 'region', 'aria-label': 'Knowledge map as a table' });
  // shatter layer lives inside the map stage: it moves with the band and is clipped to it
  const mapFx = h('div', { class: 'map-fx', 'aria-hidden': 'true' });
  stage.append(canvas, mapFx, table, tip);
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
    function grow(n) {
      if (n <= CAPN) return;
      const nc = Math.max(n, CAPN * 2, 512);
      const fa = (old) => { const a = new Float32Array(nc); if (old) a.set(old.subarray(0, N)); return a; };
      X = fa(X); Y = fa(Y); TX = fa(TX); TY = fa(TY); VX = fa(VX); VY = fa(VY); GLOW = fa(GLOW); ALPHA = fa(ALPHA); BORN = fa(BORN); R0 = fa(R0); BAND = fa(BAND);
      const s = new Int32Array(nc); if (SEQ) s.set(SEQ.subarray(0, N)); SEQ = s;
      const f = new Uint16Array(nc); if (FI) f.set(FI.subarray(0, N)); FI = f;
      CAPN = nc;
    }
    grow(512);

    const recs = [];                 // file records in file order
    const recByKey = new Map();
    let k = 1;                       // atoms per dot
    let mode = 'full';
    let colors = { f: [], muted: '#64748b', dim: '#94a3b8', accent: '#6366f1', accent2: '#4f46e5', floor: '#9a4508', panel: '#fff', strong: '#0f172a', line: '#cbd5e1' };
    let sprites = [];
    let ghosts = null;               // idle ghost dots
    let ghostAlpha = 1;
    let retrieval = null;
    let highlight = null;
    let hover = -1;
    let visible = true;
    let dirty = true;
    let lastDraw = 0;
    let removeLoop = null;
    let red = reduced();
    let peek = false;                // ribbon temporarily expanded (as an overlay) while a retrieval plays
    let strip = false;               // clusters laid out left→right (ribbon, peek, or a short band)
    let area = { x0: 0, y0: 0, x1: 0, y1: 0 };   // where dots may be drawn (never under the HUD or the legend)
    let chrome = { hudBottom: 36, hudRight: 180, hudRLeft: 0, legendTop: 0, legendRight: 0 };
    let onRetrievalEnd = null;

    function readColors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
      colors = {
        f: Array.from({ length: 8 }, (_, i) => v(`--f${i}`, '#6366f1')),
        muted: v('--muted', '#475569'), dim: v('--dim', '#94a3b8'), accent: v('--accent', '#6366f1'), accent2: v('--accent-2', '#4f46e5'),
        floor: v('--warn', '#9a4508'), panel: v('--panel', '#ffffff'), strong: v('--strong', '#0f172a'), line: v('--line-2', '#cbd5e1'),
        ghost: document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(148,163,184,.55)' : 'rgba(100,116,139,.5)',
      };
      sprites = colors.f.map((col) => makeSprite(col));
      sprites.ghost = makeSprite(colors.ghost);
      sprites.ring = colors.f.map((col) => makeRing(col));
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
        chrome = {
          hudBottom: Math.max(0, hl.bottom - sr.top), hudRight: Math.max(0, hl.right - sr.left), hudRLeft: hr.width ? hr.left - sr.left : sr.width,
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

    function resize(box) {
      // ResizeObserver hands us the size after layout (no forced reflow); other callers read it once
      const r = box && box.width ? box : stage.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
      DPR = Math.min(2, window.devicePixelRatio || 1);
      if (w === W && hh === H && canvas.width === Math.round(w * DPR)) return;
      W = w; H = hh;
      canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);   // CSS sizes the element (100%)
      try { c2d.direction = 'ltr'; c2d.font = MONO10; } catch { /* ignore */ }
      measureChrome();
      relayout(true);
      if (red) snapAll();
      dirty = true;
      kick();
    }

    // ---- layout: per-file clusters on a golden-angle spiral, relaxed apart, fitted to the stage.
    // A short band (the 56 px ribbon, its retrieval peek, or a band squeezed under ~170 px) lays the clusters out
    // left → right across the whole free width instead, so they never stack into one clump.
    function layout() {
      const live = recs.filter((r) => r.atoms > 0 || r.dots.length);
      if (!W || !H) return;
      const mob = isMobile();
      const hudB = Math.min(H * 0.5, chrome.hudBottom || 36);
      const legT = clamp(chrome.legendTop || H, hudB + 20, H);
      strip = mode === 'ribbon' || H < 170;
      if (strip) {
        let x0, x1, y0, y1;
        if (mode === 'ribbon' && !peek) {
          // dots live to the right of the HUD text and the compact legend, left of the buttons
          x0 = Math.max(chrome.hudRight || 0, chrome.legendRight || 0) + 16;
          x1 = (chrome.hudRLeft || W) - 14;
          y0 = 9; y1 = H - 9;
          if (x1 - x0 < 60) { x0 = Math.max(8, x1 - 60); }
        } else {
          x0 = mob ? 12 : 20; x1 = W - (mob ? 12 : 20);
          y0 = hudB + 8; y1 = legT - (mode === 'full' && legT - hudB > 74 ? 22 : 6);
          if (y1 - y0 < 16) { y0 = Math.max(4, hudB); y1 = Math.max(y0 + 16, legT - 2); }
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
        const padT = hudB + 10, padB = H - legT + 22, padX = mob ? 18 : 26;
        area = { x0: 4, y0: hudB + 2, x1: W - 4, y1: legT - 2 };
        // abstract units: radius = sqrt(atoms)
        const P = live.map((r, i) => {
          const rad = Math.sqrt(Math.max(r.atoms, 6));
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
        const aw = Math.max(40, W - padX * 2), ah = Math.max(30, H - padT - padB);
        const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        // small corpora get generous clusters (a 16-atom file still reads as a cluster, not a speck)
        const maxScale = (mob ? 6.2 : 11.5) / Math.sqrt(k);
        const sc = P.length ? Math.min(aw / bw, ah / bh, maxScale) : 1;
        const cx0 = padX + aw / 2 - ((minX + maxX) / 2) * sc, cy0 = padT + ah / 2 - ((minY + maxY) / 2) * sc;
        for (const p of P) { p.r.cx = cx0 + p.x * sc; p.r.cy = cy0 + p.y * sc; p.r.rad = p.rad * sc; p.r.seg = null; }
      }
      for (const r of recs) {
        for (const i of r.dots) { const t = targetOf(r, SEQ[i]); TX[i] = t.x; TY[i] = t.y; }
        // ring slots for counted atoms (cached: draw never hashes)
        const nj = Math.ceil(Math.max(0, r.atoms) / k);
        if (!r.ring || r.ring.length < nj * 2) r.ring = new Float32Array(Math.max(nj * 2, 16));
        r.nj = nj;
        for (let j = 0; j < nj; j++) { const t = targetOf(r, j * k); r.ring[j * 2] = t.x; r.ring[j * 2 + 1] = t.y; }
      }
      placeLabels(live, hudB, legT);
      layoutGhosts();
      dirty = true;
    }
    // Cluster labels: biggest clusters first; each tries below / above / right / left of its cluster and must stay
    // between the HUD and the legend row and clear of every other label. A label that fits nowhere is hidden
    // (the legend still names every file).
    function placeLabels(live, hudB, legT) {
      const placed = [];
      for (const r of recs) r.lab = null;
      if (mode === 'ribbon' && !peek) return;
      const order = live.slice().sort((a, b) => b.atoms - a.atoms);
      const top = hudB + 14, bot = legT - 4;
      const overlaps = (x, y, w) => placed.some((p) => x < p.x + p.w + 4 && x + w + 4 > p.x && y - 11 < p.y + 5 && y + 5 > p.y - 11);
      for (const r of order) {
        let name = mid(r.name, isMobile() ? 16 : 22);
        let text = `${name} · ${fmtInt(Math.max(r.atoms, 0))}`;
        let w = textWidth(text) + 10;
        if (strip && r.seg) {
          // one label row under the strip; shorten the name to the segment width
          for (let n = name.length; w > r.seg.w + 6 && n > 6; n -= 3) { name = mid(r.name, n); text = `${name} · ${r.atoms}`; w = textWidth(text) + 10; }
          if (w > r.seg.w + 6) { text = String(r.atoms); w = textWidth(text) + 10; }
          const x = clamp(r.cx - w / 2, 4, Math.max(4, W - w - 4)), y = r.seg.y + r.seg.h + 13;
          if (y <= bot + 1 && !overlaps(x, y, w)) { r.lab = { x, y, w, text }; placed.push({ x, y, w }); }
          continue;
        }
        const cands = [
          [r.cx - w / 2, r.cy + r.rad + 15], [r.cx - w / 2, r.cy - r.rad - 7],
          [r.cx + r.rad + 6, r.cy + 4], [r.cx - r.rad - 6 - w, r.cy + 4],
        ];
        for (const [cx, cy] of cands) {
          const x = clamp(cx, 4, Math.max(4, W - w - 4));
          const y = cy;
          if (y < top || y > bot) continue;
          if (overlaps(x, y, w)) continue;
          r.lab = { x, y, w, text }; placed.push({ x, y, w });
          break;
        }
      }
    }
    function targetOf(r, seq) {
      const hsh = hash32(`${r.key}:${seq}`);
      const u = (hsh & 0xffff) / 65536, v = ((hsh >>> 16) & 0xffff) / 65536;
      if (r.seg) {
        // an elliptical blob inscribed in the file's segment (reads as a cluster, not a rectangle of noise)
        const a = u * Math.PI * 2, rr = Math.sqrt(v);
        return { x: r.seg.x + r.seg.w / 2 + Math.cos(a) * rr * (r.seg.w / 2 - 2), y: r.seg.y + r.seg.h / 2 + Math.sin(a) * rr * (r.seg.h / 2 - 2) };
      }
      const a = u * Math.PI * 2, rr = Math.sqrt(v) * (r.rad || 10);
      return { x: (r.cx || W / 2) + Math.cos(a) * rr, y: (r.cy || H / 2) + Math.sin(a) * rr };
    }
    function layoutGhosts() {
      if (!ghosts) {
        const n = 240;
        ghosts = { n, x: new Float32Array(n), y: new Float32Array(n), u: new Float32Array(n), v: new Float32Array(n) };
        for (let i = 0; i < n; i++) { const hh = hash32(`ghost:${i}`); ghosts.u[i] = (hh & 0xffff) / 65536; ghosts.v[i] = ((hh >>> 16) & 0xffff) / 65536; }
      }
      for (let i = 0; i < ghosts.n; i++) {
        const a = ghosts.u[i] * Math.PI * 2, rr = Math.sqrt(ghosts.v[i]);
        const cl = i % 5, ca = cl * GOLDEN, cd = cl ? Math.sqrt(cl) * 0.22 : 0;
        ghosts.x[i] = W / 2 + (Math.cos(ca) * cd * 1.6 + Math.cos(a) * rr * 0.16) * Math.min(W, H * 1.8) * 0.6;
        ghosts.y[i] = H * 0.54 + (Math.sin(ca) * cd + Math.sin(a) * rr * 0.16) * Math.min(W / 1.8, H) * 0.95;
      }
    }

    // ---- file sync (atoms, vectorized, enabled) → births at the real rate
    function sync(files) {
      let total = 0;
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
        r.atoms = f.phase === 'failed' ? r.dots.length * k : Math.max(0, Number(f.atoms) || 0);
        const wasReady = r.ready;
        r.ready = f.phase === 'ready';
        if (r.ready && !wasReady) {
          // Ready: the cluster label fades in (instant for restored files and under reduced motion); one halo pulse
          const now = performance.now();
          if (!r.labelT) r.labelT = (red || restored.has(f.localId)) ? -1e9 : now + 200;
          if (!red && !restored.has(f.localId) && !r.halo) r.halo = now + 150;
        }
        r.failed = f.phase === 'failed';
        r.enabled = isEnabled(f);
        r.instant = r.instant || restored.has(f.localId);
        // Born dots follow the real vectorized count. Under reduced motion every counted atom is painted at once
        // (static), so the map never says less than the HUD and the rows.
        const real = r.ready ? r.atoms : (red && RANK[f.phase] >= RANK.atomized) ? r.atoms : (f.phase === 'vectorizing' || f.phase === 'atomized') ? Math.min(Number(f.vectorized) || 0, r.atoms) : 0;
        r.real = real;
        if (prevAtoms !== r.atoms) dirty = true;
        total += r.atoms;
      });
      // files that disappeared (removed): drop their dots
      for (const r of recs.slice()) if (!seen.has(r.key)) removeRec(r);
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
      for (let i = 0; i < N; i++) { const r = recs[FI[i]]; BAND[i] = r && r.enabled ? 1 : 0.05; }
      dirty = true;
      kick();
      return total;
    }
    // layout only when something it depends on changed (an event that only moves `vectorized` costs nothing)
    let layoutSig = '';
    function relayout(force = false) {
      const sig = `${W}x${H}|${mode}|${peek}|${k}|${recs.map((r) => `${r.key}:${r.atoms}:${r.dots.length ? 1 : 0}`).join(',')}`;
      if (!force && sig === layoutSig) return;
      layoutSig = sig;
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
    function compact(keep) {
      const fields = [X, Y, TX, TY, VX, VY, GLOW, ALPHA, BORN, R0, BAND, SEQ, FI];
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
      hudScale.hidden = k <= 1;
      hudScale.textContent = k > 1 ? `· 1 dot = ${k} atoms` : '';
      legendNote.textContent = k > 1 ? `Each dot is ${k} atoms, grouped by file` : 'Each dot is one atom, grouped by file';
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
      if (Math.ceil(r.atoms / k) && j >= Math.ceil(Math.max(r.atoms, r.real) / k) + 2) return -1;
      grow(N + 1);
      const i = N++;
      const t = targetOf(r, seq);
      X[i] = x ?? r.cx; Y[i] = y ?? r.cy; TX[i] = t.x; TY[i] = t.y;
      const a = (hash32(`v:${r.key}:${seq}`) & 0xffff) / 65536 * Math.PI * 2;
      VX[i] = still ? 0 : Math.cos(a) * 60; VY[i] = still ? 0 : Math.sin(a) * 60;
      GLOW[i] = 0; ALPHA[i] = 1; BORN[i] = still ? -1e9 : performance.now(); R0[i] = big ? 3 : 0; SEQ[i] = seq; FI[i] = r.idx;
      BAND[i] = r.enabled ? 1 : 0.05;
      if (red || still) { X[i] = TX[i]; Y[i] = TY[i]; VX[i] = VY[i] = 0; }
      r.dots.push(i); r.bySeq.set(seq, i);
      dirty = true;
      return i;
    }
    function birthNow(r, n, still = false) {
      for (let c = 0; c < n; c++) { if (r.hold) { r.pending++; continue; } const j = nextSeqDot(r); birth(r, j, null, null, { still: still || r.instant || red }); }
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
    function endRetrieval() { retrieval = null; if (onRetrievalEnd) { const fn = onRetrievalEnd; queueMicrotask(() => fn()); } }
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

    // ---- frame
    function step(t, dt) {
      if (destroyed) return false;
      if (!visible) return true;
      const s = Math.min(0.05, (dt || 16) / 1000);
      let moving = false;
      const STIFF = 92, DAMP = 14;
      for (let i = 0; i < N; i++) {
        const dx = TX[i] - X[i], dy = TY[i] - Y[i];
        if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || Math.abs(VX[i]) > 0.5 || Math.abs(VY[i]) > 0.5) {
          VX[i] += (STIFF * dx - DAMP * VX[i]) * s; VY[i] += (STIFF * dy - DAMP * VY[i]) * s;
          X[i] += VX[i] * s; Y[i] += VY[i] * s;
          moving = true;
        } else { X[i] = TX[i]; Y[i] = TY[i]; VX[i] = VY[i] = 0; }
        if (R0[i] > 0) { R0[i] = Math.max(0, R0[i] - s * 3); moving = true; }
        const target = BAND[i];
        if (ALPHA[i] !== target) { ALPHA[i] += (target - ALPHA[i]) * Math.min(1, s * 10); if (Math.abs(target - ALPHA[i]) < 0.01) ALPHA[i] = target; moving = true; }
      }
      // births at the real vectorized rate
      for (const r of recs) {
        if (r.pending > 0 && !r.hold) {
          r.acc += r.rate * s;
          let n = Math.floor(r.acc);
          if (n > 0) { r.acc -= n; n = Math.min(n, r.pending); r.pending -= n; for (let c = 0; c < n; c++) birth(r, nextSeqDot(r), r.cx + (Math.random() - 0.5) * 4, r.cy + (Math.random() - 0.5) * 4); moving = true; }
        } else r.acc = 0;
      }
      // the idle placeholder cloud leaves as soon as the first real atom is counted (rings/dots take its place)
      const hasRecs = recs.some((r) => r.atoms > 0 || r.dots.length);
      if (red) { const ga = hasRecs ? 0 : 1; if (ga !== ghostAlpha) { ghostAlpha = ga; moving = true; } }
      else if (hasRecs && ghostAlpha > 0) { ghostAlpha = Math.max(0, ghostAlpha - s * 3.2); moving = true; }
      else if (!hasRecs && ghostAlpha < 1) { ghostAlpha = Math.min(1, ghostAlpha + s * 2.5); moving = true; }
      const now = performance.now();
      const busy = !!document.documentElement.dataset.signature;
      const drift = !red && !busy;
      const animating = moving || dirty || (retrieval && !retrieval.done) || recs.some((r) => (r.halo && now - r.halo < 400) || (r.labelT > 0 && now - r.labelT < 400)) || (highlight && now - highlight.t0 < 300);
      // idle drift redraws at ~30 fps; nothing to animate (reduce, busy, still) → no redraw at all
      // the ±0.3 px idle drift only needs ~20 fps; nothing to animate (reduce, busy, still) → no redraw at all
      if (animating || (drift && now - lastDraw > 50)) { draw(now, drift); lastDraw = now; dirty = false; }
      return true;
    }
    function kick() { if (!removeLoop && !destroyed) removeLoop = motion.loop.add((t, dt) => { const keep = step(t, dt); if (!keep) removeLoop = null; return keep; }); }

    function draw(now, drift) {
      const g = c2d;
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, W, H);
      const tt = now * 0.0011;
      // ghost field (empty state)
      if (ghostAlpha > 0 && ghosts) {
        g.globalAlpha = 0.55 * ghostAlpha;
        const gs = sprites.ghost;
        for (let i = 0; i < ghosts.n; i++) {
          const ox = drift ? Math.sin(tt + i * 1.7) * 0.3 : 0, oy = drift ? Math.cos(tt * 0.9 + i * 2.3) * 0.3 : 0;
          g.drawImage(gs, ghosts.x[i] + ox - 1.6, ghosts.y[i] + oy - 1.6, 3.2, 3.2);
        }
      }
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
      const baseR = (isMobile() ? 1.9 : 2.25) + (N < 400 && !strip ? 0.45 : 0);
      // short bands clip the field to the dot area: nothing ever draws under the HUD text or the legend
      const clipOn = strip;
      if (clipOn) { g.save(); g.beginPath(); g.rect(area.x0 - 4, area.y0 - 4, area.x1 - area.x0 + 8, area.y1 - area.y0 + 8); g.clip(); }
      // counted-but-not-yet-vectorized atoms: hollow rings in the file hue (the truth between "atoms 16" and "vectors 0/16")
      if (!red && sprites.ring) {
        const rr = baseR + 0.6;
        for (const rec of recs) {
          if (!rec.nj || !rec.ring) continue;
          const born = rec.dots.length;
          if (born >= rec.nj) continue;
          const sp = sprites.ring[(rec.hue || 0) % 8];
          let a = 0.62 * (rec.enabled ? 1 : 0.08);
          if (R) a *= dimAll;
          if (a <= 0.01) continue;
          g.globalAlpha = a;
          const ring = rec.ring;
          for (let j = 0; j < rec.nj; j++) {
            if (rec.bySeq.has(j * k)) continue;
            g.drawImage(sp, ring[j * 2] - rr, ring[j * 2 + 1] - rr, rr * 2, rr * 2);
          }
        }
      }
      // dots
      for (let i = 0; i < N; i++) {
        const f = FI[i];
        const rec = recs[f];
        if (!rec) continue;
        const sp = sprites[(rec.hue || 0) % 8];
        let a = ALPHA[i];
        const age = now - BORN[i];
        let rad = baseR + R0[i];
        if (age < 260) { const k3 = easeOut(age / 260); rad *= k3; a *= k3; }
        if (hitSet && hitSet.has(i)) continue;            // hits are drawn on top
        if (R) a *= dimAll;
        const ox = drift ? Math.sin(tt + i * 1.37) * 0.3 : 0, oy = drift ? Math.cos(tt * 0.93 + i * 2.11) * 0.3 : 0;
        if (a <= 0.01) continue;
        g.globalAlpha = a;
        g.drawImage(sp, X[i] + ox - rad, Y[i] + oy - rad, rad * 2, rad * 2);
      }
      g.globalAlpha = 1;
      // retrieval overlay (inside the clip: probe lines never leave the dot area)
      if (R && !R.done) drawRetrieval(g, R, now, relaxK, hitSet, baseR);
      if (clipOn) g.restore();
      // cluster halos + labels
      {
        for (const r of recs) {
          if (!r.dots.length) continue;
          if (r.halo) {
            const e = (now - r.halo) / 300;
            if (e >= 0 && e <= 1.3 && !red) {
              const k4 = e <= 1 ? easeOut(e) : 1;
              g.globalAlpha = (1 - clamp(e, 0, 1)) * 0.5;
              g.strokeStyle = colors.f[r.hue % 8]; g.lineWidth = 1.5;
              g.beginPath(); g.arc(r.cx, r.cy, (r.rad + 4) * (1 + 0.15 * k4), 0, Math.PI * 2); g.stroke();
            }
          }
          if (r.labelT && r.lab && !R) {
            const la = r.labelT < 0 ? 1 : clamp((now - r.labelT) / 300, 0, 1);
            if (la <= 0) continue;
            g.font = MONO10;
            const { x: lx, y: ly, w: lw, text } = r.lab;
            g.globalAlpha = la * 0.88; g.fillStyle = colors.panel;
            roundRect(g, lx, ly - 10, lw, 15, 5); g.fill();
            g.globalAlpha = la; g.fillStyle = colors.muted; g.fillText(text, lx + 5, ly);
          }
        }
      }
      g.globalAlpha = 1;
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
      g.font = MONO10;
      const labRects = [];
      let labeled = 0;
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
          if (label && labeled < (strip ? 4 : 6) && ik > 0.4 && fade > 0) {
            // greedy placement: NE, SE, NW, SW of the dot, inside the dot area, clear of other score labels;
            // a label with no free spot is dropped (lower ranks lose: hits arrive in rank order)
            const tw = textWidth(label);
            const cands = [[X[i] + rad + 3, Y[i] - rad - 2], [X[i] + rad + 3, Y[i] + rad + 10], [X[i] - rad - 3 - tw, Y[i] - rad - 2], [X[i] - rad - 3 - tw, Y[i] + rad + 10]];
            for (const [cx, cy] of cands) {
              const lx = cx, ly = cy;
              if (lx - 3 < area.x0 - 4 || lx + tw + 3 > area.x1 + 4 || ly - 9 < area.y0 - 4 || ly + 4 > area.y1 + 4) continue;
              if (labRects.some((p) => lx - 3 < p.x + p.w + 2 && lx + tw + 5 > p.x && ly - 9 < p.y + 6 && ly + 6 > p.y - 9)) continue;
              labeled++;
              labRects.push({ x: lx - 3, y: ly, w: tw + 6, label, lx, a: clamp((ik - 0.4) / 0.6, 0, 1) * fade });
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
        g.globalAlpha = p.a;
        g.fillStyle = colors.panel; roundRect(g, p.x, p.y - 9, p.w, 13, 4); g.fill();
        g.strokeStyle = colors.line; g.lineWidth = 0.75; g.stroke();
        g.fillStyle = colors.strong; g.fillText(p.label, p.lx, p.y);
      }
      g.globalAlpha = 1;
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

    function setMode(m) { if (m === mode) return; mode = m; measureChrome(); relayout(true); if (red) snapAll(); kick(); }
    // opening the peek snaps the dots onto the taller layout (hidden by the clip-path reveal), so the beam's
    // geometry is right from its first frame; closing it lets them spring back
    function setPeek(v) { if (peek === !!v) return; peek = !!v; resizeNow(); if (peek) snapAll(); }
    function resizeNow() { W = 0; resize(); }
    function remeasure() { measureChrome(); relayout(true); kick(); }
    function setReduced(v) { red = v; if (v) { snapAll(); ghostAlpha = recs.some((r) => r.atoms > 0 || r.dots.length) ? 0 : 1; } dirty = true; kick(); }
    function setVisible(v) { visible = v; if (v) { dirty = true; kick(); } }
    function clusterOf(key) { const r = recByKey.get(key); return r ? { x: r.cx, y: r.cy, rad: r.rad } : null; }
    function bornCount() { return N; }

    readColors();
    try { if (/[?&]debug=1/.test(location.search)) window.__inMapDbg = () => ({ W, H, mode, peek, strip, area, N, retrieval: retrieval && { px: retrieval.px, py: retrieval.py, hits: retrieval.hits.map((x) => [Math.round(X[x.i]), Math.round(Y[x.i]), Math.round(TX[x.i]), Math.round(TY[x.i])]) } }); } catch { /* ignore */ }
    return { resize, sync, targetFor, spawn, hold, reserve, release, halo, showLabel, playRetrieval, relax, fastForward, setHighlight,
      pick, infoOf, setHover, setMode, setPeek, remeasure, setReduced, setVisible, readColors, clusterOf, bornCount, stageOffset, kick, isRetrieving,
      set onRetrievalEnd(fn) { onRetrievalEnd = fn; }, get area() { return area; }, get chrome() { return chrome; }, get k() { return k; } };
  }

  // ---- map host wiring
  let ro = null;
  let resizeRaf = 0;
  try {
    // resize inside the observer callback: layout is clean there, so the reads cost nothing and nothing is forced later
    ro = new ResizeObserver((ents) => { const e = ents[ents.length - 1]; const cr = e && e.contentRect; if (cr && cr.width) map.resize({ width: cr.width, height: cr.height }); else if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; map.resize(); }); });
    ro.observe(stage);
  } catch { listen(window, 'resize', () => map.resize()); }
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
    if (e.pointerType === 'touch') return;
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
  function bandMode() {
    const s = getState();
    if (s.ui && s.ui.mapPinned) return 'full';
    const answers = (s.thread || []).filter((a) => a && a.by !== 'proof').length;
    if (answers >= 2 && !lateIngest) return 'ribbon';
    return 'full';
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
      map.resize();
      map.setMode(m);
      if (m === 'ribbon') hideTip();
      if (from && !reduced()) {
        if (m === 'ribbon') anim(band, [{ opacity: 0.4, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'out', essential: false });
        else anim(band, [{ clipPath: 'inset(0 0 calc(100% - 56px) 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 360, easing: 'out', essential: false });
      }
    }
    const pinned = !!(s.ui && s.ui.mapPinned);
    pinBtn.setAttribute('aria-pressed', String(pinned));
    pinBtn.querySelector('.map-btn-l').textContent = pinned ? 'Pinned' : (m === 'ribbon' ? 'Expand' : 'Pin');
    pinBtn.title = pinned ? 'Unpin: let the map collapse once you have answers' : 'Keep the map open';
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
    if (on && !peekOn) { peekFrom = mapSlot.clientHeight || 56; }
    on = !!on && !tableOn && (band.dataset.mode === 'ribbon' || peekFrom < 170);
    if (on === peekOn) return;
    peekOn = on;
    try { peekAnim && peekAnim.cancel(); } catch { /* ignore */ }
    const shut = `inset(0 0 ${Math.max(0, PEEK_H - peekFrom)}px 0 round 0 0 14px 14px)`, open = 'inset(0 0 0 0 round 0 0 14px 14px)';
    if (on) {
      band.dataset.peek = 'yes';
      map.setPeek(true);
      if (!reduced()) peekAnim = anim(band, [{ clipPath: shut }, { clipPath: open }], { duration: 300, easing: 'out', essential: false });
    } else {
      const a = reduced() ? null
        : anim(band, [{ clipPath: open }, { clipPath: shut }], { duration: 260, easing: 'out', fill: 'forwards', essential: false });
      peekAnim = a;
      const done = () => { if (peekOn) return; delete band.dataset.peek; map.setPeek(false); if (a) { try { a.cancel(); } catch { /* ignore */ } } };
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
  function renderTable() {
    if (!tableOn) return;
    const files = liveFiles();
    const t = h('table', { class: 'map-tbl' },
      h('caption', { class: 'in-sr' }, 'Files and atoms in your bot’s knowledge'),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'File'), h('th', { scope: 'col' }, 'Stage'), h('th', { scope: 'col', class: 'is-num' }, 'Atoms'), h('th', { scope: 'col', class: 'is-num' }, 'Vectors'), h('th', { scope: 'col' }, 'Searched'))),
      h('tbody', null, files.length ? files.map((f) => h('tr', null,
        h('th', { scope: 'row' }, h('i', { class: 'map-tbl-dot', style: { '--hue': `var(--f${f.hue % 8})` }, 'aria-hidden': 'true' }), mid(f.name, 34)),
        h('td', null, phaseLabel(f)),
        h('td', { class: 'is-num in-num' }, fmtInt(f.atoms || 0)),
        h('td', { class: 'is-num in-num' }, `${fmtInt(f.vectorized || 0)}/${fmtInt(f.atoms || 0)}`),
        h('td', null, f.phase === 'failed' ? 'No (failed)' : f.phase !== 'ready' ? (RANK[f.phase] >= 6 ? 'Partly' : 'Not yet') : isEnabled(f) ? 'Yes' : 'Off'))) : h('tr', null, h('td', { colspan: '5' }, 'No files yet.'))));
    table.innerHTML = '';
    table.append(t);
  }
  let legendSig = '';
  function renderLegend(files) {
    const shown = files.filter((f) => f.atoms || f.phase === 'ready');
    const sig = shown.map((f) => `${f.localId}:${f.hue}:${f.atoms || 0}:${isEnabled(f) ? 1 : 0}:${f.name}`).join('|') + (isMobile() ? 'm' : '');
    if (sig === legendSig) return;
    legendSig = sig;
    legendChips.innerHTML = '';
    for (const f of shown) {
      legendChips.append(h('span', { class: `map-chip${isEnabled(f) ? '' : ' is-off'}`, style: { '--hue': `var(--f${f.hue % 8})` }, title: f.name },
        h('i', { 'aria-hidden': 'true' }), h('span', { class: 'map-chip-n' }, mid(f.name, isMobile() ? 14 : 20)), h('span', { class: 'map-chip-c in-num' }, fmtInt(f.atoms || 0))));
    }
    // the ribbon's dot field starts right of the legend: re-measure once the legend changed width
    if (band.dataset.mode === 'ribbon') map.remeasure();
  }
  let lastTotal = -1;
  function syncMap() {
    const files = liveFiles();
    const total = map.sync(files);
    const has = files.some((f) => f.atoms > 0);
    band.dataset.state = has ? 'live' : files.length ? 'learning' : 'empty';
    // The HUD never trails the rows: the count is written in the same frame as the authoritative file state.
    // Before any atom exists it names the real stage instead of a misleading "0 atoms".
    const stageText = total > 0 ? '' : hudStageText(files);
    hudCountWrap.hidden = !files.length || (total === 0 && !!stageText);
    hudStage.hidden = !stageText;
    if (stageText && hudStage.textContent !== stageText) hudStage.textContent = stageText;
    hudEmpty.hidden = !!files.length;
    if (total !== lastTotal) { lastTotal = total; hudCount.dataset.value = String(total); hudCount.textContent = fmtInt(total); }
    renderLegend(files);
    renderTable();
  }

  function hudStageText(files) {
    const busy = files.filter((f) => !TERMINAL.has(f.phase));
    if (!busy.length) return '';
    const chunks = files.reduce((acc, f) => acc + (RANK[f.phase] >= RANK.chunked ? Number(f.chunks) || 0 : 0), 0);
    const top = busy.reduce((a, f) => (RANK[f.phase] > RANK[a.phase] ? f : a), busy[0]);
    if (chunks) return `· atomizing · ${plural(chunks, 'chunk')}`;
    return { queued: '· waiting to upload', uploading: '· uploading', uploaded: '· extracting text', extracted: '· chunking' }[top.phase] || '· learning';
  }

  // ================================================================== rows

  const rowEls = new Map();  // localId -> refs

  function phaseLabel(f) {
    const m = rowMeta.get(f.localId) || {};
    switch (f.phase) {
      case 'queued': return 'Queued';
      case 'rejected': return 'Not added';
      case 'uploading': return m.retryAt ? 'Waiting to retry' : `Uploading · ${f.bytes ? Math.floor((f.sent || 0) / f.bytes * 100) : 0}%`;
      case 'uploaded': return 'Extracting…';
      case 'extracted': return 'Chunking…';
      case 'chunked': return 'Atomizing…';
      case 'atomized': return `Atomized · ${plural(f.atoms || 0, 'atom')}`;
      case 'vectorizing': return `Vectorizing · ${fmtInt(f.vectorized || 0)}/${fmtInt(f.atoms || 0)}`;
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
    const ico = h('span', { class: 'in-ico', html: fileIcon(f.kind, { size: 18 }) });
    const name = h('span', { class: 'in-name', id: nameId, title: f.name }, h('span', { 'aria-hidden': 'true', class: 'in-name-v' }, mid(f.name, isMobile() ? 24 : 38)), h('span', { class: 'in-sr' }, f.name));
    const tag = h('span', { class: 'in-tag', hidden: !f.sample }, 'Sample');
    const size = h('span', { class: 'in-size in-num' }, fmtSize(f.bytes));
    const status = h('span', { class: 'in-status in-num' });
    const kebab = h('button', { type: 'button', class: 'in-iconbtn in-kebab', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Actions for ${f.name}`, html: icon('more', { size: 16 }) });
    listen(kebab, 'click', (e) => { e.stopPropagation(); openMenu(f.localId, kebab); });
    const main = h('div', { class: 'in-row-main' }, incLabel, ico, h('div', { class: 'in-namewrap' }, name, tag, size), status, kebab);

    // stage track
    const track = h('ol', { class: 'in-track', 'aria-label': `Processing stages for ${f.name}` });
    const nodes = STAGES.map((s, i) => {
      const conn = i ? h('span', { class: 'in-conn', 'aria-hidden': 'true' }, h('i')) : null;
      const check = h('span', { class: 'in-dot', 'aria-hidden': 'true', html: '<svg viewBox="0 0 12 12" width="10" height="10"><path class="in-ck" d="M2.6 6.3 5 8.6l4.4-5" pathLength="1"/><path class="in-x" d="M3.4 3.4l5.2 5.2M8.6 3.4 3.4 8.6"/></svg>' });
      const label = h('span', { class: 'in-node-l' }, s.label);
      const count = h('span', { class: 'in-node-c in-num' });
      const stateSr = h('span', { class: 'in-sr' });
      const li2 = h('li', { class: 'in-node', dataset: { node: s.key, state: 'todo' } }, conn, check, label, count, stateSr);
      track.append(li2);
      return { li: li2, conn, label, count, stateSr, state: 'todo' };
    });
    const note = h('p', { class: 'in-note' });
    const actions = h('div', { class: 'in-actions' });
    const detailInner = h('div', { class: 'in-detail-in' }, track, note, actions);
    // The track and the Ready summary share one grid cell, so a row keeps the same height from the first stage to
    // Ready (no collapse that would shift everything below it); Ready cross-fades the track out, the summary in.
    const summary = h('div', { class: 'in-sum', hidden: true });
    const detail = h('div', { class: 'in-detail' }, detailInner, summary);
    li.append(main, detail);
    const refs = { li, inc, incLabel, ico, name, tag, size, status, kebab, track, nodes, note, actions, detail, summary, lastPhase: null, actionsKey: '', summaryKey: '' };
    rowEls.set(f.localId, refs);
    return refs;
  }

  function nodeStates(f) {
    const m = rowMeta.get(f.localId) || {};
    const st = new Array(6).fill('todo');
    if (f.phase === 'rejected') return st;
    if (f.phase === 'failed') {
      const fn = m.failedNode ?? failNodeOf(f);
      for (let i = 0; i < 6; i++) st[i] = i < fn ? 'done' : i === fn ? 'failed' : 'todo';
      return st;
    }
    const a = ACTIVE_NODE[f.phase] ?? -1;
    for (let i = 0; i < 6; i++) st[i] = i < a ? 'done' : i === a ? 'active' : 'todo';
    if (f.phase === 'ready') st.fill('done');
    return st;
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

  function renderRow(lid) {
    const f = getState().files[lid];
    if (!f) return;
    let r = rowEls.get(lid);
    let fresh = false;
    if (!r) { r = buildRow(f); fresh = true; placeRow(lid, r.li); }
    const m = meta(lid);
    const phaseChanged = r.lastPhase !== f.phase;
    r.li.dataset.phase = f.phase;
    r.li.style.setProperty('--hue', `var(--f${f.hue % 8})`);
    r.li.dataset.stall = '';
    r.li.dataset.off = isEnabled(f) ? '' : 'off';
    r.li.classList.toggle('st-working', !TERMINAL.has(f.phase) && f.phase !== 'queued' && !(meta(lid).retryAt));
    r.tag.hidden = !f.sample;
    r.size.textContent = fmtSize(f.bytes);
    // include toggle only once the file exists on the server and can be searched
    const canScope = !!f.id && f.phase !== 'failed' && f.phase !== 'rejected';
    r.incLabel.hidden = !canScope;
    r.inc.checked = isEnabled(f);
    r.inc.disabled = !canScope;
    r.status.textContent = phaseLabel(f);
    r.kebab.hidden = f.phase === 'queued';

    // track nodes
    const st = nodeStates(f);
    st.forEach((s, i) => {
      const n = r.nodes[i];
      if (n.state !== s) {
        const was = n.state;
        n.state = s;
        n.li.dataset.state = s;
        if (s === 'active') n.li.setAttribute('aria-current', 'step'); else n.li.removeAttribute('aria-current');
        n.stateSr.textContent = s === 'done' ? ', done' : s === 'active' ? ', in progress' : s === 'failed' ? ', failed' : '';
        if (s === 'done' && was !== 'done' && !fresh) {
          const p = n.li.querySelector('.in-ck');
          if (p && motion.drawPath) motion.drawPath(p, 220);
        }
      }
    });
    // connectors: upload connector carries byte %, vectorize connector carries v/n
    // connector i runs from node i-1 to node i and carries node i-1's real progress:
    // Upload → byte %, Vectorize → v/n; stages without a measurable ratio stay empty and shimmer while active.
    for (let i = 1; i < 6; i++) {
      const n = r.nodes[i];
      if (!n.conn) continue;
      const from = st[i - 1];
      let p = 0;
      let known = false;
      if (from === 'done') { p = 1; known = true; }
      else if (from === 'active') {
        if (i === 1) { p = clamp((f.sent || 0) / Math.max(1, f.bytes), 0, 1); known = true; }
        if (i === 5) { p = f.atoms ? clamp((f.vectorized || 0) / f.atoms, 0, 1) : 0; known = true; }
      }
      n.conn.style.setProperty('--pf', String(p));
      n.conn.dataset.work = from === 'active' ? (known ? 'measured' : 'busy') : '';
    }
    // counters (tween toward the last real value only)
    const tick = (el, v, fmt) => { if (motion.ticker && !fresh) motion.ticker(el, v, { ms: 600, format: fmt }); else { el.dataset.value = String(v); el.textContent = fmt(v); } };
    const fmtN = (n) => fmtInt(n);
    if (f.phase === 'uploading') r.nodes[0].count.textContent = `${f.bytes ? Math.floor((f.sent || 0) / f.bytes * 100) : 0}%`;
    else r.nodes[0].count.textContent = RANK[f.phase] >= 2 || (f.phase === 'failed' && f.id) ? fmtSize(f.bytes) : '';
    r.nodes[1].count.textContent = f.pages ? `${f.pages} pages` : '';
    if (f.chunks && RANK[f.phase] >= 4 || (f.phase === 'failed' && f.chunks)) { r.nodes[2].count.hidden = false; r.nodes[2].count.textContent = `chunks ${fmtN(f.chunks || 0)}`; } else r.nodes[2].count.textContent = '';
    if (f.atoms) { tick(r.nodes[3].count, f.atoms, (n) => `atoms ${fmtN(n)}`); } else { r.nodes[3].count.textContent = ''; r.nodes[3].count.dataset.value = '0'; }
    if (f.atoms && RANK[f.phase] >= 5) tick(r.nodes[4].count, f.vectorized || 0, (n) => `vectors ${fmtN(n)}/${fmtN(f.atoms)}`); else { r.nodes[4].count.textContent = ''; r.nodes[4].count.dataset.value = '0'; }
    r.nodes[5].count.textContent = '';

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
    if (f.phase === 'rejected' || f.phase === 'failed') { text = (f.error && f.error.message) || 'Something went wrong with this file.'; kind = 'bad'; }
    else if (f.phase === 'uploading' && m.retryAt) {
      const s = Math.max(0, Math.ceil((m.retryAt - Date.now()) / 1000));
      text = m.retryKind === 'busy' ? `Studio is busy, retrying in ${s}s…` : `Connection lost at ${m.lostPct ?? 0}%. Retrying in ${s}s… (retry ${m.attempt} of 3)`;
      kind = 'warn';
    } else if (!TERMINAL.has(f.phase) && f.phase !== 'queued') {
      const since = m.lastChangeAt || Date.now();
      const el = Math.max(Date.now() - since, f.stalledFor || 0);
      if (el >= STALL_MS) {
        r.li.dataset.stall = 'yes';
        text = `Still ${DOING[f.phase] || 'working'} · large files can take a few minutes · ${mmss(el)}`;
        kind = 'stall';
      }
    } else if (f.phase === 'queued') { text = 'Waiting for an upload slot…'; kind = 'muted'; }
    if (r.note.textContent !== text) r.note.textContent = text;
    r.note.dataset.kind = kind;
    r.note.hidden = !text;
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
    return [];
  }
  const ACTION_LABEL = { retry: 'Retry', retrynow: 'Retry now', replace: 'Replace', remove: 'Remove', files: 'Show my files' };
  function renderActions(f, r, m) {
    const acts = actionList(f, m);
    const key = acts.join(',');
    if (key === r.actionsKey) return;
    const had = !!r.actionsKey;
    r.actionsKey = key;
    r.actions.innerHTML = '';
    r.actions.hidden = !acts.length;
    acts.forEach((a, i) => {
      const b = h('button', { type: 'button', class: `in-btn${i === 0 && a !== 'remove' ? ' in-btn-primary' : ''} in-act-${a}`, onclick: () => doAction(f.localId, a) },
        a === 'retry' || a === 'retrynow' ? h('span', { html: icon('refresh', { size: 14 }) }) : a === 'replace' ? h('span', { html: icon('upload', { size: 14 }) }) : a === 'remove' ? h('span', { html: icon('x', { size: 14 }) }) : null,
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
    const tops = h('div', { class: 'in-topics' }, (f.topics || []).slice(0, 3).map((t) => h('span', { class: 'in-topic' }, t)));
    r.summary.append(line, tops);
    if (!reduced() && r.lastPhase === 'ready') {
      anim(line, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out', delay: 120 });
      motion.stagger && motion.stagger(tops.children, [{ opacity: 0, transform: 'translateY(4px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'spring', delay: 200 }, 60);
    }
  }
  function readyMorph(r) {
    const n = r.nodes[5];
    anim(n.li.querySelector('.in-dot'), [{ transform: 'scale(.6)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'spring', essential: false });
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
    rowsEl.insertBefore(li, before);
  }
  let enterBatch = 0;
  function enterRow(li) {
    if (reduced()) return;
    const d = (enterBatch++) * 60;
    setTimeout(() => { enterBatch = Math.max(0, enterBatch - 1); }, d + 30);
    anim(li, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 380, delay: d, easing: 'out' });
  }
  function removeRowEl(lid) {
    const r = rowEls.get(lid);
    rowEls.delete(lid);
    if (!r) return;
    const go = () => {
      const sibs = () => [...rowsEl.children].filter((x) => x !== r.li);
      if (motion.flip && !reduced()) motion.flip(sibs, () => r.li.remove(), { duration: 380 });
      else r.li.remove();
    };
    if (reduced()) { go(); return; }
    anim(r.li, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(12px)' }], { duration: 220, easing: 'out' }).finished.then(go);
  }

  // ---------------------------------------------------------------- header, capacity, collapse

  function renderHead() {
    const files = liveFiles();
    const all = listFiles();
    const skel = skelEls.length;
    const atoms = files.reduce((acc, f) => acc + (f.phase === 'failed' ? 0 : f.atoms || 0), 0);
    headMeta.textContent = files.length ? `· ${plural(files.length, 'file')} · ${plural(atoms, 'atom')}` : '';
    panel.dataset.state = all.length || skel ? 'files' : 'empty';
    empty.hidden = !!(all.length || skel);
    body.hidden = !(all.length || skel);
    removeSamplesBtn.hidden = !files.some((f) => f.sample);
    replayPill.hidden = !replayLabel || !files.some((f) => f.sample);
    replayPill.querySelector('.in-replay-t').textContent = replayLabel || '';
    // Collapse to the one-line chip when everything is Ready, or as soon as a question is asked (the answer needs
    // the room more than the rows do; the chip keeps live per-file progress). New files re-open the rows.
    const allReady = files.length > 0 && all.every((f) => f.phase === 'ready');
    // skeleton rows count as busy: the pane takes its learning layout inside the click's input window
    intakeSlot.dataset.busy = skel || all.some((f) => f.phase !== 'ready') ? 'yes' : '';
    mapSlot.dataset.busy = skel || all.some((f) => !TERMINAL.has(f.phase)) ? 'yes' : '';
    const wantCollapsed = collapsedByUser.auto ? (allReady || (askedCollapse && files.length > 0)) : collapsedByUser.value;
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
      const ready = files.filter((f) => f.phase === 'ready').length;
      const failed = files.filter((f) => f.phase === 'failed').length;
      const learning = files.length - ready - failed;
      const sig = `${files.length}|${atoms}|${ready}|${failed}|${isMobile() ? 'm' : ''}|${files.slice(0, 8).map((f) => `${f.localId}:${f.phase}:${Math.round(fileProgress(f) * 20)}:${isEnabled(f) ? 1 : 0}`).join(',')}`;
      if (sig !== chipSig) {
        chipSig = sig;
        const extra = [learning ? `${learning} learning` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
        chip.innerHTML = '';
        chip.append(h('span', { class: 'in-chip-t' }, 'Sources'),
          h('span', { class: 'in-chip-m in-num' }, ` · ${plural(files.length, 'file')} · ${plural(atoms, 'atom')}`, extra ? h('span', { class: `in-chip-x${failed ? ' is-warn' : ''}` }, ` · ${extra}`) : null),
          h('span', { class: 'in-chip-dots' }, files.slice(0, 8).map((f) => h('span', {
            class: `in-chip-f${isEnabled(f) ? '' : ' is-off'}`, dataset: { phase: f.phase },
            style: { '--hue': `var(--f${f.hue % 8})`, '--p': fileProgress(f).toFixed(3) },
          }, h('i', { 'aria-hidden': 'true' }), mid(f.name, isMobile() ? 12 : 18)))),
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
          h('ol', { class: 'in-track' }, STAGES.map((st, j) => h('li', { class: 'in-node', dataset: { state: 'todo' } }, j ? h('span', { class: 'in-conn' }, h('i')) : null, h('span', { class: 'in-dot' }), h('span', { class: 'in-node-l' }, st.label), h('span', { class: 'in-node-c' })))))));
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
    capBar.setAttribute('aria-valuemax', String(q));
    capBar.setAttribute('aria-valuenow', String(Math.min(q, shown)));
    capBar.setAttribute('aria-valuetext', `${fmtMB(shown)} MB of ${fmtMB(q)} MB used`);
    capLabel.textContent = `${fmtMB(shown)} MB of ${fmtMB(q)} MB`;
    const warn = shown >= q * 0.8;
    cap.dataset.warn = warn ? 'yes' : '';
    capWarn.hidden = !warn;
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
      s.style.setProperty('--hue', `var(--f${f.hue % 8})`);
      s.style.flexBasis = `max(3px, ${(100 * (f.bytes || 0) / q).toFixed(4)}%)`;
      const pending = f.phase === 'queued' || f.phase === 'uploading';
      s.dataset.pending = pending ? 'yes' : '';
      s.style.setProperty('--sent', String(pending ? clamp((f.sent || 0) / Math.max(1, f.bytes), 0, 1) : 1));
      s.dataset.state = f.phase === 'failed' ? 'failed' : '';
    }
    for (const [lid, s] of [...capSegEls]) if (!seen.has(lid)) { capSegEls.delete(lid); s.remove(); }
    dropOverlay.querySelector('.in-drop-t').textContent = `Drop to add · ${fmtMB(Math.max(0, q - shown))} MB left`;
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

  // one place that re-renders everything a file change touches
  let headRaf = 0;
  function afterChange(lid) {
    if (lid) renderRow(lid);
    if (headRaf) return;
    headRaf = requestAnimationFrame(() => { headRaf = 0; renderHead(); renderCapacity(); syncMap(); updateLate(); updateBand(); });
  }
  function rerenderAll() {
    const ids = new Set(getState().fileOrder);
    for (const lid of [...rowEls.keys()]) if (!ids.has(lid)) removeRowEl(lid);
    for (const lid of ids) renderRow(lid);
    afterChange(null);
  }

  // stall + retry countdown clock (1 s, only while something is in flight)
  const clock = setInterval(() => {
    for (const f of listFiles()) {
      if (TERMINAL.has(f.phase)) continue;
      const r = rowEls.get(f.localId);
      if (r) { renderNote(f, r, meta(f.localId)); renderActions(f, r, meta(f.localId)); }
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
    afterChange(lid);
    maybeShatter(lid);
  }
  function stageAnnounce(f) {
    const key = `${f.localId}:${f.phase}`;
    if (lastStageSaid.get(f.localId) === key) return;
    lastStageSaid.set(f.localId, key);
    const word = { uploading: 'uploading', uploaded: 'uploaded, extracting', extracted: 'extracted, chunking', chunked: 'chunked, atomizing', atomized: `${plural(f.atoms || 0, 'atom')}, vectorizing`, vectorizing: 'vectorizing', ready: `ready, ${plural(f.atoms || 0, 'atom')}`, rejected: 'not added' }[f.phase];
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
      const f = newFileState({ name: file.name, bytes: file.size, mime: file.type, kind: kindOf(file.name, file.type) || 'txt', file });
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
    if (a === 'remove') return removeFile(lid);
    if (a === 'files') { setCollapsed(false); const first = rowsEl.querySelector('.in-row:not([data-phase="rejected"])'); if (first) first.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); return; }
    if (a === 'retrynow') return retryUpload(lid);
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
    if (!panel.contains(document.activeElement)) { const next = rowsEl.querySelector('.in-kebab, button'); if (next && document.activeElement === document.body) next.focus({ preventScroll: true }); }
  }
  function replaceFile(lid, file) {
    const idx = getState().fileOrder.indexOf(lid);
    removeFile(lid, { quiet: true });
    addFiles([file], { replaceAt: Math.max(0, idx) });
  }

  // ---------------------------------------------------------------- kebab menu

  let menuFor = null;
  function openMenu(lid, btn) {
    if (menuFor && menuFor.lid === lid) { closeMenu(true); return; }
    closeMenu(false);
    const f = getState().files[lid];
    if (!f) return;
    const items = [];
    if (f.id && RANK[f.phase] >= 5) items.push({ id: 'atoms', label: 'View atoms', ico: 'atom' });
    if (f.phase === 'failed') items.push({ id: 'retry', label: 'Retry', ico: 'refresh' });
    if (f.phase !== 'queued') items.push({ id: 'replace', label: 'Replace', ico: 'upload' });
    items.push({ id: 'remove', label: 'Remove', ico: 'x', danger: true });
    if (f.sample) items.push({ id: 'samples', label: 'Remove all sample files', ico: 'x', danger: true });
    menu.innerHTML = '';
    menu.setAttribute('aria-label', `Actions for ${f.name}`);
    const els = items.map((it) => {
      const b = h('button', { type: 'button', role: 'menuitem', tabindex: '-1', class: `in-mi${it.danger ? ' is-danger' : ''}` }, h('span', { html: icon(it.ico, { size: 15 }) }), it.label);
      b.addEventListener('click', () => { closeMenu(true); menuAction(lid, it.id); });
      menu.append(b);
      return b;
    });
    menu.hidden = false;
    const host = dropSlot.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const mh = menu.offsetHeight, mw = menu.offsetWidth;
    let top = br.bottom - host.top + 4;
    if (top + mh > host.height - 8) top = br.top - host.top - mh - 4;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${clamp(br.right - host.left - mw, 8, host.width - mw - 8)}px`;
    btn.setAttribute('aria-expanded', 'true');
    menuFor = { lid, btn, els };
    els[0].focus();
    if (!reduced()) anim(menu, [{ opacity: 0, transform: 'translateY(-4px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'out' });
  }
  function closeMenu(focusBack) {
    if (!menuFor) return;
    const { btn } = menuFor;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    menuFor = null;
    if (focusBack && btn.isConnected) btn.focus({ preventScroll: true });
  }
  listen(menu, 'keydown', (e) => {
    if (!menuFor) return;
    const els = menuFor.els;
    const i = els.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); els[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  listen(document, 'pointerdown', (e) => { if (menuFor && !menu.contains(e.target) && e.target !== menuFor.btn && !menuFor.btn.contains(e.target)) closeMenu(false); }, true);
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

  function maybeShatter(lid) {
    if (shattered.has(lid) || shatterJobs.has(lid)) return;
    const f = getState().files[lid];
    if (!f || !f.id) return;
    if (restored.has(lid)) { shattered.add(lid); return; }
    if (f.phase === 'failed') { shattered.add(lid); return; }
    const items = previews.get(f.id);
    if (!items || !items.length) {
      // no preview yet: if the file is already Ready without one, give up on the shatter honestly (dots still land)
      return;
    }
    if (RANK[f.phase] < RANK.atomized) return;
    // no room for the choreography (ribbon, a band compacted under an answer, table view, hidden tab): dots land directly
    if (reduced() || band.dataset.mode === 'ribbon' || tableOn || document.hidden || stage.clientHeight < 170) { shattered.add(lid); return; }
    shattered.add(lid);
    const key = f.id;
    // no hold while queued: a file waiting for a shatter slot keeps landing real dots at its vectorized rate
    const job = { aborted: false };
    shatterJobs.set(lid, job);
    const run = (signal) => runShatter(lid, key, items, signal).catch((err) => { console.error('[ingest] shatter', err); }).finally(() => {
      map.release(key);
      shatterJobs.delete(lid);
    });
    const p = motion.director && motion.director.request
      ? motion.director.request('shatter', 1, run, { region: mapSlot, maxMs: 25000 })
      : run(new AbortController().signal);
    Promise.resolve(p).then(() => { map.release(key); shatterJobs.delete(lid); });
  }
  function skipShatter(lid) { const j = shatterJobs.get(lid); if (j && j.ctrl) j.ctrl.abort(); shattered.add(lid); }
  function skipAllShatters() { if (motion.director && motion.director.busy() === 'shatter') motion.director.skip(); }

  function chipsFrom(items, cap) {
    // round-robin over the atoms so every preview atom is represented; 3–6 real words per chip
    const groups = items.map((it) => {
      const words = String(it.text || '').replace(/[#*_`>|]+/g, ' ').split(/\s+/).filter(Boolean);
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
      for (const g of groups) {
        if (round < g.out.length && chips.length < cap) { chips.push({ text: g.out[round], seq: Number(g.it.seq) || 0, atomId: g.it.atomId, ai: groups.indexOf(g) }); any = true; }
      }
      if (!any) break;
    }
    return { chips, atoms: groups.length };
  }

  // chip widths come from text metrics, never from layout reads (no forced reflow in the middle of the choreography)
  function chipWidth(text) { return Math.ceil(textWidth(text)) + 14; }

  async function runShatter(lid, key, items, signal) {
    const job = shatterJobs.get(lid) || {};
    job.started = true;
    const ctrl = { abort: () => {} };
    job.ctrl = ctrl;
    const f0 = getState().files[lid];
    if (!f0 || signal.aborted) return;
    if (firstShatter) { firstShatter = false; try { motion.fpsProbe && motion.fpsProbe(3000); } catch { /* ignore */ } }
    const fast = f0.phase === 'ready';                    // Ready before we started: compressed replay (900 ms total)
    const T = fast ? { a: 160, b: 200, c: 250, d: 330, e: 200, st: 0.35 } : { a: 380, b: 600, c: 700, d: 480, e: 300, st: 1 };
    const mob = isMobile();
    const hue = `var(--f${f0.hue % 8})`;
    const anims = [];
    const A = (el, kf, o) => { const x = anim(el, kf, { ...o, signal }); anims.push(x); return x; };
    let slot = 0; while (slotsUsed.has(slot)) slot++; slotsUsed.add(slot);
    const localAbort = new AbortController();
    ctrl.abort = () => localAbort.abort();
    const aborted = () => signal.aborted || localAbort.signal.aborted;
    // everything this shatter draws lives in one host: cleanup is one fade on one element, not 40
    const host = h('div', { class: 'in-shatter', style: { '--hue': hue } });
    const cleanup = () => {
      slotsUsed.delete(slot);
      for (const x of anims) { try { x.finish(); } catch { /* ignore */ } }
      if (!host.isConnected) return;
      if (!reduced() && !aborted() && host.animate) { const a2 = host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }); a2.finished.then(() => host.remove(), () => host.remove()); }
      else host.remove();
    };
    try {
      // ---- geometry (one read of the stage, the row and the chrome; everything after is writes)
      const sw = stage.clientWidth, sh = stage.clientHeight;
      if (!sw || !sh) return;
      const ch0 = map.chrome || {};
      const top = Math.max(mob ? 34 : 44, (ch0.hudBottom || 0) + 6);
      const bottom = Math.max(mob ? 8 : 34, sh - (ch0.legendTop || sh) + 6);
      const availH = Math.max(40, sh - top - bottom);
      const cardScale = clamp(availH / 200, 0.4, 1);
      const cw = 160 * cardScale, ch = 200 * cardScale;
      // desktop: two shatters play side by side, each in its own half of the map
      const regions = mob ? 1 : 2;
      const regW = (sw - 24) / regions;
      const regX = 12 + regW * (slot % regions);
      const cx = regX + 4;
      const cy = top + Math.max(0, (availH - ch) / 2);
      // the card rises out of its own FileRow (or from below the map when the row is folded away)
      let fromX = cx, fromY = sh + 24;
      const rowEl = rowEls.get(lid);
      if (rowEl && rowEl.li.isConnected) {
        const sr = stage.getBoundingClientRect(), rr = rowEl.li.getBoundingClientRect();
        if (rr.width) { fromX = clamp(rr.left - sr.left + 36, 0, sw - 40); fromY = Math.max(sh * 0.6, rr.top - sr.top); }
      }
      mapFx.append(host);

      // ---- A. DocCard (real atom text, first lines)
      const text = items.map((x) => String(x.text || '').replace(/\s+/g, ' ').trim()).join(' ');
      const card = h('div', { class: 'in-doc', style: { left: `${cx}px`, top: `${cy}px`, width: '160px', height: '200px', transform: `scale(${cardScale})` } },
        h('div', { class: 'in-doc-h' }, h('span', { html: fileIcon(f0.kind, { size: 11 }) }), h('span', { class: 'in-doc-n' }, mid(f0.name, 22))),
        h('p', { class: 'in-doc-t' }, text.slice(0, 340)));
      host.append(card);
      await A(card, [
        { opacity: 0, transform: `translate(${fromX - cx}px, ${fromY - cy}px) scale(${cardScale * 0.42})` },
        { opacity: 1, transform: `translate(0, 0) scale(${cardScale})` },
      ], { duration: T.a, easing: 'out' }).finished;
      if (aborted()) return;

      // ---- B. Chunk: N = min(chunks, 6) horizontal strips (clip-path clones)
      let w = await waitPhase(lid, RANK.chunked, signal); if (w !== 'ok') return finishEarly(w);
      const fB = getState().files[lid];
      const N = clamp(Number(fB.chunks) || Math.ceil((fB.atoms || items.length) / 3), 1, 6);
      const strips = [];
      const frag = document.createDocumentFragment();
      for (let i = 0; i < N; i++) {
        const t0 = (i / N) * 100, b0 = 100 - ((i + 1) / N) * 100;
        const st = card.cloneNode(true);
        st.classList.add('in-strip');
        st.style.clipPath = `inset(${t0}% 0 ${b0}% 0)`;
        st.append(h('span', { class: 'in-strip-l in-num', style: { top: `${((i + 0.5) / N) * 100}%` } }, `#${i + 1}`));
        frag.append(st); strips.push(st);
      }
      host.append(frag);
      card.style.visibility = 'hidden';
      const midN = (N - 1) / 2;
      await Promise.all(strips.map((st, i) => {
        const dir = i < midN ? -1 : i > midN ? 1 : 0;
        const dist = (6 + (8 * Math.abs(i - midN)) / Math.max(1, midN)) * dir;
        st._dy = dist;
        return A(st, [{ transform: `scale(${cardScale}) translateY(0)` }, { transform: `scale(${cardScale}) translateY(${dist}px)` }], { duration: T.b, delay: i * 40 * T.st, easing: 'spring', fill: 'forwards' }).finished;
      }));
      if (aborted()) return;

      // ---- C. Atomize: strips become chips of 3–6 real words (≤32 desktop, ≤16 mobile; halved on low detail)
      w = await waitPhase(lid, RANK.atomized, signal); if (w !== 'ok') return finishEarly(w);
      let capN = mob ? 16 : 32; if (lowDetail()) capN = Math.floor(capN / 2);
      const all = chipsFrom(items, capN).chips;
      if (!all.length) return;
      // loose grid to the right of the card, inside this shatter's region; chips that don't fit are dropped
      const hgt = 18;
      const areaX = cx + cw + 14;
      const areaW = Math.max(70, regX + regW - 6 - areaX);
      const maxY = sh - bottom - hgt;
      let x = 0, y = 0;
      const placed = [];
      for (let i = 0; i < all.length; i++) {
        const wv = Math.min(chipWidth(all[i].text), areaW);
        if (x + wv > areaW && x > 0) { x = 0; y += hgt + 7; }
        const py = top + 2 + y;
        if (py > maxY) break;
        const j = hash32(`${key}:${i}`);
        placed.push({ c: all[i], w: wv, x: areaX + x + ((j & 0xff) / 255 - 0.5) * 6, y: py + (((j >>> 8) & 0xff) / 255 - 0.5) * 5, rot: (((j >>> 16) & 0xff) / 255 - 0.5) * 4 });
        x += wv + 6;
      }
      if (!placed.length) return;
      const layer = h('div', { class: 'in-chips' });
      const chipEls = placed.map((p) => {
        // face (pill + words) and dot are separate layers so the fly is transform/opacity only (compositor)
        const el = h('span', { class: 'in-atom', style: { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px` } },
          h('span', { class: 'in-atom-face' }, h('span', { class: 'in-atom-t' }, p.c.text)), h('i', { class: 'in-atom-dot' }));
        layer.append(el);
        return el;
      });
      host.append(layer);                                   // one DOM write for all chips
      const atomsN = items.length;
      strips.forEach((st) => A(st, [{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(300, T.c * 0.45), easing: 'out', fill: 'forwards' }));
      await Promise.all(chipEls.map((el, i) => {
        const p = placed[i];
        const si = clamp(Math.floor((p.c.ai / Math.max(1, atomsN)) * N), 0, N - 1);
        const fx = cx + cw * 0.15 + ((i * 37) % Math.max(1, cw * 0.6)), fy = cy + ch * ((si + 0.5) / N) + (strips[si]?._dy || 0);
        const dx = fx - p.x, dy = fy - p.y;
        return A(el, [
          { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.8)` },
          { opacity: 1, transform: `translate(0, 0) rotate(${p.rot}deg) scale(1)` },
        ], { duration: T.c * 0.75, delay: i * 12 * T.st, easing: 'spring', fill: 'forwards' }).finished;
      }));
      if (aborted()) return;

      // ---- D. Fly: chips become 6 px dots and land on their real map coordinates; the canvas takes over
      w = await waitPhase(lid, RANK.vectorizing, signal); if (w !== 'ok') return finishEarly(w);
      // the chips' own seqs are reserved for the hand-off; every other atom keeps streaming in at the real rate
      map.reserve(key, placed.map((p) => p.c.seq));
      const landed = new Set();
      let haloed = false;
      const dur = T.d + 240 * T.st;
      await Promise.all(chipEls.map((el, i) => {
        const p = placed[i];
        const t = map.targetFor(key, p.c.seq);
        if (!t) return Promise.resolve();
        const dx = t.x - (p.x + p.w / 2), dy = t.y - (p.y + hgt / 2);
        const delay = i * 12 * T.st;
        A(el.firstChild, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.25)' }], { duration: dur * 0.34, delay, easing: 'out', fill: 'forwards' });
        A(el.lastChild, [{ opacity: 0 }, { opacity: 1 }], { duration: dur * 0.3, delay, easing: 'out', fill: 'forwards' });
        return A(el, [
          { transform: `translate(0, 0) rotate(${p.rot}deg)`, offset: 0, easing: 'cubic-bezier(.4,0,.2,1)' },
          { transform: `translate(${dx * 0.06}px, ${dy * 0.06}px) rotate(0deg)`, offset: 0.3, easing: 'cubic-bezier(.2,.8,.2,1)' },
          { transform: `translate(${dx}px, ${dy}px) rotate(0deg)`, offset: 1 },
        ], { duration: dur, delay, easing: 'linear', fill: 'forwards' }).finished.then(() => {
          el.style.visibility = 'hidden';
          if (!landed.has(p.c.seq)) { landed.add(p.c.seq); map.spawn(key, p.c.seq, t.x, t.y); }
          if (!haloed) { haloed = true; map.halo(key); }
        });
      }));
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

  function onEvent(type, data) {
    if (destroyed) return;
    switch (type) {
      case 'hello': {
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
        previews.set(data.fileId, items);
        for (const it of items) atomText.set(`${data.fileId}:${it.seq}`, { text: it.text.replace(/\s+/g, ' ').trim(), atomId: it.atomId });
        const lid = byId.get(data.fileId);
        if (lid) maybeShatter(lid);
        break;
      }
      case 'summary': applySummary(data); break;
      case 'usage': setUsage(data); break;
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
      clearSkeletons();
      if (r && r.replay && r.replay.label) replayLabel = r.replay.label;
      const ids = [];
      for (const row of (r && r.files) || []) { const lid = applyRow({ ...row, sample: true }, { source: 'samples' }); if (lid) ids.push(lid); }
      if (r && r.usage) setUsage(r.usage);
      if (ids.length) { mark && mark('firstFile'); emit('files:added', { localIds: ids }); }
      collapsedByUser.auto = true;
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
    if (motion.director && motion.director.busy && motion.director.busy() === 'shatter') { try { motion.director.skip(); } catch { /* ignore */ } }
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
      byId.clear(); previews.clear(); rowMeta.clear(); restored.clear(); summarized.clear(); readyEmitted.clear(); failedEmitted.clear(); shattered.clear();
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
    const render = (d) => {
      const files = Array.isArray(d.files) && d.files.length ? d.files : [d];
      el.innerHTML = '';
      const atoms = files.reduce((s, f) => s + (Number(f.atoms) || 0), 0);
      const card = h('div', { class: 'in-card in-card-sum' },
        h('p', { class: 'in-card-h' }, h('span', { class: 'in-card-ico', html: icon('checkCircle', { size: 15 }) }),
          files.length === 1 ? 'Learned 1 file' : `Learned ${files.length} files`, h('span', { class: 'in-card-m in-num' }, ` · ${plural(atoms, 'atom')}`)),
        h('ul', { class: 'in-card-files' }, files.map((f) => {
          const cur = (f.localId && getState().files[f.localId]) || {};
          const hue = Number.isFinite(cur.hue) ? cur.hue : (Number(f.hue) || 0);
          const starters = (f.starters || []).map((s) => (typeof s === 'string' ? s : s && s.q)).filter(Boolean).slice(0, 1);
          return h('li', { class: 'in-card-f', style: { '--hue': `var(--f${hue % 8})` } },
            h('span', { class: 'in-card-fico', html: fileIcon(cur.kind || f.kind || 'txt', { size: 16 }) }),
            h('div', { class: 'in-card-fb' },
              h('p', { class: 'in-card-fn' }, h('span', { class: 'in-card-name', title: f.name }, mid(f.name, 34)), h('span', { class: 'in-card-fa in-num' }, ` · Ready · ${plural(Number(f.atoms) || 0, 'atom')}`)),
              f.oneLine ? h('p', { class: 'in-card-fl' }, f.oneLine) : null,
              (f.topics || []).length ? h('div', { class: 'in-topics' }, f.topics.slice(0, 3).map((t) => h('span', { class: 'in-topic' }, t))) : null,
              starters.length ? h('div', { class: 'in-card-ask' }, starters.map((q) => h('button', { type: 'button', class: 'in-btn in-btn-ghost in-ask', onclick: () => { emit('samplebot:ask', { question: q, by: 'chip' }); emit('tab:show', { tab: 'bot' }); } }, h('span', { html: icon('arrowRight', { size: 13 }) }), `Ask: “${q}”`))) : null));
        })));
      el.append(card);
      if (!reduced()) motion.stagger && motion.stagger(card.querySelectorAll('.in-card-f'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' }, 60);
    };
    render(data || {});
    return { update: (d) => render(d || {}), destroy() { el.innerHTML = ''; } };
  });

  registerCard('file-error', (data, el) => {
    const lid = data && data.localId;
    let un = null;
    const render = () => {
      const f = lid ? getState().files[lid] : null;
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
          h('div', { class: 'in-actions' }, acts.map((a, i) => h('button', { type: 'button', class: `in-btn${i === 0 ? ' in-btn-primary' : ''}`, onclick: () => doAction(lid, a) }, ACTION_LABEL[a]))));
      }
      el.append(h('div', { class: `in-card in-card-err${f && f.phase === 'failed' ? '' : ' is-resolved'}` },
        h('p', { class: 'in-card-h' }, h('span', { class: 'in-card-ico', html: icon(f && f.phase !== 'failed' ? 'refresh' : 'warn', { size: 15 }) }), h('span', { class: 'in-card-name', title: name }, mid(name, 34)), f && f.phase === 'failed' ? ' couldn’t be read' : ''),
        body));
    };
    render();
    let sig = '';
    const sigOf = () => { const f = lid ? getState().files[lid] : null; return f ? `${f.phase}|${f.error && f.error.message}|${f.atoms}` : 'gone'; };
    sig = sigOf();
    if (lid) un = on('change:files', () => { const s2 = sigOf(); if (s2 !== sig) { sig = s2; render(); } });
    return { update: () => render(), destroy() { if (un) un(); el.innerHTML = ''; } };
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
    try { ro && ro.disconnect(); io && io.disconnect(); mo.disconnect(); } catch { /* ignore */ }
    mapSlot.innerHTML = ''; intakeSlot.innerHTML = ''; dropSlot.innerHTML = '';
  }

  // debugging hook (read-only use; mirrors window.__studio from B)
  const api2 = { pick, addFiles, destroy, map, _state: { byId, previews, shattered } };
  return api2;
}

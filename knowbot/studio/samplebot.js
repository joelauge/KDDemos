// KnowBot Studio: SampleBot and proof (owner C). SPEC 2.6 (motion), 6.2 (this module), 1.4 B4–B8, 1.5, 1.8, 11.1.
//
// Mounts into #st-bot-banner, #sb-thread-slot, #sb-suggest-slot, #sb-composer-slot and #sb-drawer-slot.
// Everything else happens through the store (events + the card registry): no reaching into other owners' DOM.
//
//   mount(ctx) -> { ask(question, {by, label}) -> Promise<final|null>, destroy() }
//
// Honesty rules this file enforces (SPEC 0.2):
// - "match" is always the vector similarity (0–100). A hit without one says "keyword match" and shows no number.
//   The hybrid RRF score is never rendered as a number on screen; it only appears in a dim tooltip in the
//   ranked table, labelled "hybrid rank score".
// - Every [n] resolves to verbatim text: a quote, its file and a locator. The refusal sentence is shown exactly
//   as the server sent it, and nothing is ever appended to it.
// - The step ticker never advances before the server's status event; counters only interpolate toward real values.
//
// CONTRACT-GAP: there is no event that asks B to run a Builder action (e.g. "attach samples" with its narration).
//   The empty state emits 'builder:action' {type} when B listens to it, else falls back to 'samples:attach' / 'intake:pick'.
// CONTRACT-GAP: there is no event to switch the mobile tab. Scorecard rows emit 'tab:show' {tab:'bot'} when someone
//   listens; otherwise they open the answer's receipt in the ProofDrawer, which is visible from either tab.
// CONTRACT-GAP: the server's Builder already offers [Re-ask "{q}" to compare] after a material spec change, so C does
//   not post a duplicate Builder chip. C offers the same re-ask inline in the thread and posts the `compare` card
//   whenever an answer repeats an earlier question under a newer version (whoever triggered the re-ask).
// CONTRACT-GAP (B, toasts): the "Proof view on" toast is positioned by B and can cover the docked ProofDrawer footer
//   ([Expand source]) on desktop and the sheet bottom on mobile. While ui.drawer is set, B should place toasts in the
//   Builder column (desktop) or above the sheet (mobile), and auto-dismiss after 3 s. C renders no toasts itself.
// CONTRACT-GAP (D/B, a11y): the axe heading-order h3 on mobile after the first answer is not in this module (C renders
//   no h3; its only heading is the ProofDrawer h2). Candidates: D's visually hidden map heading
//   "Top matches for the last question" (ingest.js) and B's insights h3 (app.js), which follow no visible h2 on mobile.

const NOT_IN_DATA = "I can't seem to find an answer to that in any of my current data sources.";
const STEP_ORDER = ['embed', 'search', 'rank', 'select', 'quote'];
const PERSONAS = [
  { id: 'customer', label: 'Customer' },
  { id: 'employee', label: 'Employee' },
  { id: 'skeptic', label: 'Skeptic' },
];
const PROOF_AUTO_KEY = 'kb-studio-proof-auto';

export function mount(ctx) {
  const { store, api, motion } = ctx;
  const { getState, setState, on, emit, mark } = store;
  const icons = ctx.icons || {};
  const icon = (n, o) => (icons.icon ? icons.icon(n, o) : '');
  const fileIcon = (k, o) => (icons.fileIcon ? icons.fileIcon(k, o) : icon('file', o));
  const S = ctx.slots || {};
  const pick = (k, id) => S[k] || document.getElementById(id);
  const dom = {
    bot: pick('bot', 'st-bot'),
    banner: pick('banner', 'st-bot-banner'),
    thread: pick('thread', 'sb-thread-slot'),
    suggest: pick('suggest', 'sb-suggest-slot'),
    composer: pick('composer', 'sb-composer-slot'),
    drawer: pick('drawer', 'sb-drawer-slot'),
    main: S.main || document.querySelector('.st-main'),
  };
  const say = (text, region = 'polite') => { try { ctx.announce && ctx.announce(text, region); } catch { /* ignore */ } };
  const unsubs = [];
  const sub = (type, fn) => { unsubs.push(on(type, fn)); };
  const reduced = () => { try { return motion.reduced(); } catch { return false; } };
  const mq = (q) => { try { return matchMedia(q).matches; } catch { return false; } };
  const isMobile = () => mq('(max-width: 899px)');
  const isDock = () => mq('(min-width: 1440px)');
  const anim = (el, kf, opts) => motion.animate(el, kf, opts);

  // ================================================================== tiny helpers

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const svgFrag = (markup) => { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstElementChild; };
  const ico = (name, size = 14) => svgFrag(icon(name, { size })) || document.createTextNode('');
  const fico = (kind, size = 14) => svgFrag(fileIcon(kind, { size })) || document.createTextNode('');
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const pct = (sim) => (sim == null || !Number.isFinite(Number(sim)) ? null : Math.round(Number(sim) * 100));
  const matchOf = (x) => (x == null ? null : Number.isFinite(x.match) ? x.match : pct(x.similarity));
  /** Unrounded 0–100 match (similarity preferred: it carries the precision the floor check uses). */
  const rawMatch = (x) => {
    if (x == null) return null;
    if (x.similarity != null && Number.isFinite(Number(x.similarity))) return Number(x.similarity) * 100;
    return Number.isFinite(x.match) ? x.match : null;
  };
  /** The match as shown next to a floor. It never rounds across the floor: 0.697 against floor 0.70 reads "69.7",
   *  not "70", so "match 70 · below floor 70" can never appear. Far from the floor it is a whole number. */
  function fmtMatch(x, floorSim) {
    const r = typeof x === 'number' ? x * 100 : rawMatch(x);
    if (r == null || !Number.isFinite(r)) return null;
    const m = Math.round(r);
    if (floorSim == null || !Number.isFinite(Number(floorSim))) return String(m);
    const f = Number(floorSim) * 100, fShown = Math.round(f);
    if (r < f && m >= fShown) return (Math.floor(r * 10) / 10).toFixed(1);
    if (r >= f && m < fShown) return (Math.ceil(r * 10) / 10).toFixed(1);
    return String(m);
  }
  /** Points below the floor (null when above or unknown). */
  const belowBy = (x, floorSim) => { const r = typeof x === 'number' ? x * 100 : rawMatch(x); return r == null || floorSim == null ? null : r < floorSim * 100 ? floorSim * 100 - r : null; };
  const floorOfA = (A) => A?.retrieval?.floor?.min ?? A?.final?.why?.floor ?? A?.final?.proof?.floor ?? (getState().spec || {}).floor ?? 0.7;
  const fmtMs = (ms) => (ms == null ? '' : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.max(0, Math.round(ms)).toLocaleString()} ms`);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
  let uidN = 0;
  const uid = (p) => `${p}-${Date.now().toString(36)}${(++uidN).toString(36)}`;
  const shortId = (id) => { const s = String(id || ''); return s.length > 9 ? `${s.slice(0, 7)}…` : s; };
  const KIND_BY_EXT = { pdf: 'pdf', docx: 'docx', doc: 'docx', pptx: 'pptx', ppt: 'pptx', xlsx: 'xlsx', xls: 'xlsx', csv: 'xlsx', html: 'html', htm: 'html', md: 'md', markdown: 'md', txt: 'txt', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', mp3: 'audio', wav: 'audio', m4a: 'audio' };
  const kindOf = (name) => KIND_BY_EXT[String(name || '').split('.').pop().toLowerCase()] || 'txt';
  /** lumen-warranty-returns.md -> lumen-warr…returns.md (keeps the extension). */
  function mid(name, max = 26) {
    const s = String(name || '');
    if (s.length <= max) return s;
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
    const base = ext ? s.slice(0, dot) : s;
    const keep = max - ext.length - 1;
    const head = Math.ceil(keep * 0.45), tail = keep - head;
    return `${base.slice(0, head)}…${base.slice(base.length - tail)}${ext}`;
  }
  function hash(s) { let x = 0; for (const c of String(s || '')) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x); }

  /** Server file id -> {name, hue, kind, sample}. Falls back to a stable hue for files D has not listed yet. */
  function fileMeta(fileId, fallbackName = '') {
    const s = getState();
    let i = 0;
    for (const id of s.fileOrder || []) {
      const f = s.files[id];
      if (f && ((fileId && f.id === fileId) || ((!fileId || !f.id) && fallbackName && f.name === fallbackName))) {
        return { name: f.name || fallbackName, hue: Number.isFinite(f.hue) ? f.hue : i % 8, kind: f.kind || kindOf(f.name), localId: id, file: f };
      }
      i++;
    }
    return { name: fallbackName || 'file', hue: hash(fileId || fallbackName) % 8, kind: kindOf(fallbackName), localId: null, file: null };
  }
  const hueVar = (hue) => `var(--f${(Number(hue) || 0) % 8})`;

  /** Short chip title: "Warranty & Returns" from lumen-warranty-returns.md + "Lumen Bikes Warranty and Returns Policy". */
  function chipTitle(file, title) {
    const spec = getState().spec || {};
    const base = String(file || '').split('/').pop().replace(/\.[a-z0-9]{1,8}$/i, '');
    let toks = base.split(/[-_\s.]+/).filter(Boolean);
    const ctxWords = norm(`${title || ''} ${spec.name || ''} ${spec.org || ''}`);
    if (toks.length >= 3 && ctxWords.split(' ').includes(toks[0].toLowerCase())) toks = toks.slice(1);
    if (!toks.length) return clip(title || base || 'Source', 26);
    const ACR = new Set(['faq', 'pdf', 'hr', 'it', 'api', 'sla', 'tos', 'ui', 'us', 'uk', 'eu']);
    const word = (w) => (ACR.has(w.toLowerCase()) ? w.toUpperCase() : /^\d+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase());
    if (toks.length === 2 && norm(title).includes(`${toks[0].toLowerCase()} and ${toks[1].toLowerCase()}`)) return `${word(toks[0])} & ${word(toks[1])}`;
    return clip(toks.map(word).join(' '), 26);
  }

  function botSpec() { return getState().spec || { name: 'SampleBot', avatar: { initials: 'SB', hue: 0 } }; }
  function avatarEl(size = 'sm') {
    const sp = botSpec();
    const a = sp.avatar || {};
    const initials = (a.initials || String(sp.name || 'SB').slice(0, 2)).toUpperCase().slice(0, 2);
    return h('span', { class: `sb-avatar sb-avatar-${size}`, 'aria-hidden': 'true', style: { '--hue': hueVar(a.hue || 0) } }, initials);
  }

  function filesList() {
    const s = getState();
    return (s.fileOrder || []).map((id) => s.files[id]).filter((f) => f && f.phase !== 'rejected');
  }
  function readiness() {
    const list = filesList();
    const ready = list.filter((f) => f.phase === 'ready');
    const failed = list.filter((f) => f.phase === 'failed');
    const busy = list.filter((f) => f.phase !== 'ready' && f.phase !== 'failed');
    return { list, ready, failed, busy, total: list.length };
  }
  function enabledReady() {
    const src = (getState().spec || {}).sources || {};
    return readiness().ready.filter((f) => f.enabled !== false && !(f.id && src[f.id] === false));
  }
  function scrollBehavior() { return reduced() ? 'auto' : 'smooth'; }

  // ================================================================== thread scaffold

  const threadEl = h('div', { class: 'sb-thread', role: 'region', 'aria-label': 'Answers', id: 'sb-thread' });
  dom.thread.innerHTML = '';
  dom.thread.append(threadEl);
  let stick = true;
  let selfScroll = false;
  dom.thread.addEventListener('scroll', () => {
    if (selfScroll) { selfScroll = false; if (linked) scheduleThreadDraw(); return; }
    const t = dom.thread;
    stick = t.scrollHeight - t.scrollTop - t.clientHeight < 64;
    if (linked) scheduleThreadDraw();
  }, { passive: true });
  // Scroll anchoring is coalesced to one write per frame, however many lines/answers asked for it in that frame
  // (one layout read, one scrollTop write: no per-token reflow).
  let endRaf = 0;
  function scrollToEnd(force = false) {
    if (!force && !stick) return;
    if (force) stick = true;
    if (endRaf) return;
    endRaf = requestAnimationFrame(() => {
      endRaf = 0;
      if (!stick) return;
      const t = dom.thread;
      const to = t.scrollHeight - t.clientHeight;
      if (Math.abs(t.scrollTop - to) > 1) { selfScroll = true; t.scrollTop = to; }
    });
  }

  // ---------------------------------------------------------------- GhostAnswer (B0)
  // Decorative example: its words are drawn by CSS from data attributes (aria-hidden), so it never reads as content
  // and never competes for contrast; the caption under it is real text at full contrast.
  // The ghost is only for a bot with nothing yet: no file in the list (not even learning) and no history. It is
  // compact (caption first, one quoted line) so it fits above the empty state without being clipped.
  let ghostEl = null;
  function ghostAllowed() { return !answers.size && !restoredN && !readiness().total && !(getState().thread || []).length; }
  function renderGhost() {
    if (ghostEl || !ghostAllowed()) return;
    const line = (t) => h('span', { class: 'sb-ghost-t', 'data-t': t });
    ghostEl = h('div', { class: 'sb-ghost' },
      h('p', { class: 'sb-ghost-cap' }, h('span', { class: 'sb-ghost-cap-ico' }, ico('shieldCheck', 15)),
        h('span', null, 'Example: your bot answers only from your files, every line with a receipt.')),
      h('div', { class: 'sb-ghost-art', 'aria-hidden': 'true' },
        h('div', { class: 'sb-ghost-q' }, line('How long is the warranty?')),
        h('div', { class: 'sb-ghost-a' },
          h('span', { class: 'sb-ghost-av' }),
          h('div', { class: 'sb-ghost-body' },
            h('div', { class: 'sb-ghost-src' }, h('i'), line('warranty.pdf · match 86')),
            h('p', null, line('Frames carry a lifetime warranty for the original owner.'), h('b', { class: 'sb-ghost-chip' }, '1')),
            h('div', { class: 'sb-ghost-pill' }, line('Grounded · 1 quote · 100% verified'))))));
    threadEl.prepend(ghostEl);
  }
  function dropGhost() {
    const g = ghostEl; ghostEl = null;
    if (!g) return;
    g.classList.add('is-leaving');
    const gone = () => { g.classList.add('is-gone'); g.remove(); };
    if (reduced()) { gone(); return; }
    anim(g, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(.985)' }], { duration: 220, easing: 'out', fill: 'forwards' }).finished.then(gone, gone);
  }

  // ================================================================== answers

  const answers = new Map();          // id -> A (live answer record; the store gets a plain AnswerState snapshot)
  let persona = 'customer';
  let lastPartialQ = null;            // {question, at} asked while some files were still learning
  let partialOffered = false;
  let reaskEl = null;
  const closeMissSent = new Set();

  function snapshot(A) {
    return { id: A.id, question: A.question, by: A.by, label: A.label, status: A.status, steps: A.steps.slice(),
      retrieval: A.retrieval, lines: A.lines, selected: A.selected, text: A.text, final: A.final, version: A.version, startedAt: A.startedAt };
  }
  let restoredN = 0;                  // answers rebuilt from the last visit (THREAD_KEY), shown above new ones
  // Streaming events (status, delta…) commit to the store at most once per frame: every commit fans out to other
  // owners' listeners, and doing that per token caused long frames under CPU throttling.
  const commitQ = new Map();
  let commitRaf = 0;
  function commitSoon(A, reason) {
    commitQ.set(A, reason);
    if (!commitRaf) commitRaf = requestAnimationFrame(() => { commitRaf = 0; const q = [...commitQ]; commitQ.clear(); for (const [a, r] of q) commit(a, r); });
  }
  function commit(A, reason) {
    commitQ.delete(A);
    const snap = snapshot(A);
    setState((s) => {
      const t = (s.thread || []).slice();
      const i = t.findIndex((x) => x && x.id === A.id);
      if (i < 0) t.push(snap); else t[i] = snap;
      return { thread: t };
    }, reason || 'answer');
  }

  /** Public ask: returns a Promise of the final payload (null on failure). A new ask never cancels earlier answers. */
  function ask(question, opts = {}) {
    const A = startAsk(question, opts);
    return A ? A.promise : Promise.resolve(null);
  }

  function startAsk(question, { by = 'user', label = null, group = null } = {}) {
    const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!q) return null;
    const r = readiness();
    const A = {
      id: uid('ans'), question: q, by, label: label || (by === 'proof' ? 'Proof Run' : null), status: 'pending', steps: [],
      retrieval: null, lines: null, selected: null, text: '', final: null, version: (getState().spec || {}).version || 1,
      startedAt: Date.now(), t0: performance.now(), fast: by === 'proof', partial: r.busy.length > 0 && r.ready.length > 0,
      el: {}, lineEls: [], tweens: [], group, attempts: 0, persona,
    };
    let resolveP; A.promise = new Promise((res) => { resolveP = res; }); A.resolve = resolveP;
    answers.set(A.id, A);
    if (A.partial && by !== 'proof') { lastPartialQ = { question: q, at: Date.now() }; partialOffered = false; }
    else if (by !== 'proof' && lastPartialQ) {
      // any new question retires the "All files ready · Ask again" offer (it is a one-time nudge, not a fixture)
      partialOffered = true; lastPartialQ = null; renderBanner();
    }
    if (by !== 'proof') { dropGhost(); clearReask(); }
    buildAnswer(A);
    commit(A, 'answer:start');
    emit('answer:start', { answerId: A.id, question: q, by });
    if (by !== 'proof') claimSignature(A);
    run(A);
    return A;
  }

  // ---------------------------------------------------------------- signature slot (director)

  function claimSignature(A) {
    try {
      motion.director.request('retrieval', 3, (signal) => new Promise((resolve) => {
        A.signal = signal;
        A.release = resolve;
        if (A.settled) { resolve(); return; }
        signal.addEventListener('abort', () => { fastForward(A); resolve(); }, { once: true });
      }), { region: A.el.root, maxMs: 30000 });
    } catch { /* director unavailable: animations still run, unsequenced */ }
  }
  function releaseSignature(A, delay = 0) {
    A.settled = true;
    if (A.release) { const r = A.release; A.release = null; delay ? setTimeout(r, delay) : r(); }
  }
  /** Fast-forward: everything this answer is animating jumps to its end state (director pre-emption, Esc, click). */
  function fastForward(A) {
    A.fast = true;
    for (const t of A.tweens.splice(0)) { try { t.finish(); } catch { /* ignore */ } }
    A.el.root?.getAnimations?.({ subtree: true }).forEach((a) => { try { a.finish(); } catch { /* infinite: leave */ } });
  }
  const aOpts = (A, o) => ({ ...o, signal: A.signal });

  // ---------------------------------------------------------------- DOM for one answer

  function buildAnswer(A) {
    const tag = A.label && A.by !== 'proof'
      ? h('span', { class: `sb-qtag${A.by === 'setup' ? ' is-setup' : ''}` }, ico(A.by === 'setup' ? 'builder' : 'refresh', 12), A.label)
      : null;
    const q = h('div', { class: 'sb-q' },
      h('div', { class: 'sb-qbubble' }, h('span', { class: 'st-sr' }, 'You asked: '), A.question),
      tag);
    const status = h('div', { class: 'sb-status' });
    const ticker = buildTicker(A);
    status.append(ticker);
    const srcRow = h('div', { class: 'sb-srcrow', role: 'group', 'aria-label': 'Sources' });
    for (let i = 0; i < 3; i++) srcRow.append(h('span', { class: 'sb-src is-skel', 'aria-hidden': 'true' }, h('i')));
    const strip = h('div', { class: 'pf-only pf-strip', role: 'group', 'aria-label': 'Evidence' });
    for (let i = 0; i < 3; i++) strip.append(h('div', { class: 'pf-card is-skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    const body = h('div', { class: 'sb-body' });
    const caret = h('span', { class: 'sb-caret', 'aria-hidden': 'true' });
    body.append(caret);
    const extras = h('div', { class: 'sb-extras' });
    // the popover exists (hidden) from the start, so every chip's aria-controls/aria-details resolves
    const pop = h('div', { class: 'pf-pop', id: `${A.id}-pop`, role: 'group', 'aria-label': 'Citation receipt', hidden: true });
    const popHost = h('div', { class: 'pf-pophost' }, pop);
    const foot = h('div', { class: 'sb-foot', hidden: true });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pf-threads'); svg.setAttribute('aria-hidden', 'true');
    const gid = uid('g');
    svg.innerHTML = `<defs><linearGradient id="${gid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" style="stop-color:var(--accent-2)"/><stop offset="1" style="stop-color:var(--accent)"/></linearGradient></defs><path fill="none" stroke="url(#${gid})" stroke-width="1.75" stroke-linecap="round"/><circle r="3" style="fill:var(--accent)"/>`;
    const main = h('div', { class: 'sb-a-main' }, status, srcRow, strip, body, extras, popHost, foot);
    const a = h('div', { class: 'sb-a' }, avatarEl(), main);
    const root = h('article', { class: `sb-answer${A.by === 'proof' ? ' is-proof' : ''}`, id: A.id, 'aria-busy': 'true', dataset: { status: 'pending', by: A.by } }, q, a, svg);
    A.el = { root, q, status, ticker, srcRow, strip, body, caret, extras, popHost, pop, foot, svg, main };
    wirePop(A, pop);
    const host = A.group ? A.group.body : threadEl;
    host.append(root);
    if (!A.fast) anim(root, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'out' });
    if (!A.group) scrollToEnd(true);
    pruneOld();
  }

  function pruneOld() {
    const items = [...threadEl.children].filter((x) => x.classList.contains('sb-answer') || x.classList.contains('sb-prun'));
    items.forEach((x, i) => x.classList.toggle('is-old', i < items.length - 6));
  }

  // ---------------------------------------------------------------- StepTicker -> ProvenancePill

  function stepLabel(step, A) {
    const fl = A.retrieval?.floor?.min ?? (getState().spec || {}).floor ?? 0.7;
    switch (step) {
      case 'embed': return 'Embedding question';
      case 'search': {
        const files = enabledReady();
        const atoms = A.retrieval?.searched?.atoms ?? files.reduce((s, f) => s + (f.vectorized || f.atoms || 0), 0);
        const nf = A.retrieval?.searched?.files ?? files.length;
        return atoms ? `Searching ${atoms.toLocaleString()} atoms in ${plural(nf, 'file')}` : 'Searching your files';
      }
      case 'rank': return `Ranking above floor ${pct(fl)}`;
      case 'select': return 'Choosing lines';
      case 'quote': return 'Quoting verbatim';
      default: return 'Asking your bot';
    }
  }

  function buildTicker(A) {
    const dots = h('span', { class: 'sb-tick-steps', 'aria-hidden': 'true' }, STEP_ORDER.map((s) => h('i', { dataset: { step: s } })));
    const labels = h('span', { class: 'sb-tick-labels' }, h('span', { class: 'sb-tick-l is-on' }, 'Asking your bot'));
    const ms = h('span', { class: 'sb-tick-ms sb-num' }, '0 ms');
    const el = h('div', { class: 'sb-tick' }, h('span', { class: 'sb-tick-spin', 'aria-hidden': 'true' }), labels, dots, ms);
    // elapsed counter: real time since the question left, on the shared rAF loop
    let last = 0;
    const remove = motion.loop.add((t) => {
      if (A.final || A.error || !el.isConnected && A.status !== 'pending') return false;
      if (t - last < 45) return true;
      last = t;
      ms.textContent = fmtMs(performance.now() - A.t0);
      return true;
    });
    A.stopClock = remove;
    return el;
  }

  function setStep(A, step) {
    const t = A.el.ticker;
    if (!t || !t.isConnected) return;
    const idx = STEP_ORDER.indexOf(step);
    t.querySelectorAll('.sb-tick-steps i').forEach((d, i) => { d.classList.toggle('is-done', i < idx); d.classList.toggle('is-on', i === idx); });
    const wrap = t.querySelector('.sb-tick-labels');
    const old = wrap.querySelector('.sb-tick-l.is-on');
    const text = stepLabel(step, A);
    if (old && old.textContent === text) return;
    const nu = h('span', { class: 'sb-tick-l is-on' }, text);
    wrap.append(nu);
    if (old) {
      old.classList.remove('is-on');
      if (A.fast || reduced()) old.remove();
      else {
        anim(old, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 150, easing: 'out', fill: 'forwards' }).finished.then(() => old.remove());
        anim(nu, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 150, easing: 'out' });
      }
    }
    if (step === 'search' && A.by !== 'proof') {
      const atoms = enabledReady().reduce((s, f) => s + (f.vectorized || f.atoms || 0), 0);
      if (atoms) say(`Searching ${atoms.toLocaleString()} atoms`);
    }
  }

  function buildPill(A) {
    const f = A.final;
    let cls = 'sb-pill', ic = 'shieldCheck', text;
    if (f.status === 'grounded') {
      const q = (f.proof?.quotedLines || []).length || (f.citations || []).reduce((s, c) => s + (c.quotes?.length || 1), 0);
      const files = new Set((f.citations || []).map((c) => c.fileId || c.file)).size;
      const v = f.proof?.verified || {};
      const vp = v.claims ? Math.round((100 * (v.verified || 0)) / v.claims) : 100;
      text = h('span', null, h('b', null, 'Grounded'), ` · ${plural(q, 'quote')} from ${plural(files, 'file')} · ${vp}% verified · `, h('span', { class: 'sb-num' }, fmtMs(f.latencyMs?.total)));
      cls += ' is-grounded';
    } else if (f.status === 'guard') {
      cls += ' is-refused'; ic = 'shield';
      text = h('span', null, h('b', null, 'Guard'), ': off-topic request');
    } else {
      cls += ' is-refused'; ic = 'shield';
      text = h('span', null, h('b', null, 'Not in your data'), ' · canonical refusal');
    }
    return h('div', { class: cls }, ico(ic, 14), text);
  }

  /** The ticker collapses into the pill with a width morph (clip-path, so only compositor properties move). */
  function morphPill(A) {
    const old = A.el.ticker;
    const pill = buildPill(A);
    A.stopClock && A.stopClock();
    if (!old || !old.isConnected) { A.el.status.innerHTML = ''; A.el.status.append(pill); A.el.pill = pill; return; }
    const w0 = old.getBoundingClientRect().width;
    old.replaceWith(pill);
    A.el.pill = pill; A.el.ticker = null;
    if (A.fast || reduced()) return;
    const w1 = pill.getBoundingClientRect().width;
    if (w1 > w0 + 1) anim(pill, [{ clipPath: `inset(0 ${Math.round(w1 - w0)}px 0 0 round 999px)` }, { clipPath: 'inset(0 0 0 0 round 999px)' }], aOpts(A, { duration: 220, easing: 'out' }));
    else anim(pill, [{ opacity: 0.5 }, { opacity: 1 }], aOpts(A, { duration: 220 }));
  }

  // ---------------------------------------------------------------- the stream

  async function run(A) {
    A.attempts++;
    A.ctrl = new AbortController();
    const body = { question: A.question, label: A.label || null, as: A.persona || 'customer', versionTag: A.version };
    try {
      const fin = await api.ask(body, { onEvent: (type, data) => onEvent(A, type, data), signal: A.ctrl.signal });
      if (!A.final && fin) onFinal(A, fin);
      A.resolve(A.final);
    } catch (err) {
      if (A.final) { A.resolve(A.final); return; }
      if (err && err.code === 'aborted' && destroyed) return;
      onError(A, err);
    }
  }

  function onEvent(A, type, data) {
    if (destroyed) return;
    switch (type) {
      case 'status':
        if (!data || !data.step) return;
        A.steps.push({ step: data.step, ms: data.t ?? Math.round(performance.now() - A.t0) });
        setStep(A, data.step);
        commitSoon(A, 'answer:status');
        break;
      case 'retrieval':
        A.retrieval = data;
        renderRetrieval(A);
        if (A.by !== 'proof') emitMap(A, false);
        commitSoon(A, 'answer:retrieval');
        break;
      case 'lines': A.lines = data; commitSoon(A, 'answer:lines'); break;
      case 'selected': A.selected = data; commitSoon(A, 'answer:selected'); break;
      case 'delta':
        A.status = 'streaming';
        A.text = A.text ? `${A.text}\n${data?.text || ''}` : (data?.text || '');
        A.el.root.dataset.status = 'streaming';
        queueLine(A, data || {});
        commitSoon(A, 'answer:delta');
        break;
      case 'final': onFinal(A, data); break;
      default: break;
    }
  }

  function emitMap(A, final) {
    const r = A.retrieval;
    if (!r) return;
    const cited = new Set((A.final?.proof?.quotedLines || []).map((q) => q.atomId).concat((A.final?.citations || []).map((c) => c.atomId)).filter(Boolean));
    emit('map:retrieval', {
      answerId: A.id,
      hits: (r.hits || []).map((x) => ({ fileId: x.fileId, atomId: x.atomId, seq: x.seq, similarity: x.similarity, kept: !!x.kept, cited: cited.has(x.atomId) })),
      floor: r.floor?.min ?? null,
      refused: final ? !!A.final?.refused : false,
    });
  }

  // ---------------------------------------------------------------- retrieval: source chips (Bot view) + EvidenceStrip (Proof view)

  function hitsByFile(hits) {
    const m = new Map();
    for (const x of hits) { const k = x.fileId || x.file; if (!m.has(k)) m.set(k, x); }
    return [...m.values()];
  }

  function srcChip(A, hit, { n = null, dim = false } = {}) {
    const meta = fileMeta(hit.fileId, hit.file);
    const m = fmtMatch(hit, floorOfA(A));
    const b = h('button', { type: 'button', class: `sb-src${dim ? ' is-dim' : ''}`, style: { '--hue': hueVar(meta.hue) },
      title: hit.file || meta.name, dataset: { atom: hit.atomId || '', file: hit.fileId || '' },
      onclick: (e) => openDrawer({ fileId: hit.fileId, atomId: hit.atomId, seq: hit.seq, answerId: A.id, n }, e.currentTarget),
      onmouseenter: (e) => emit('map:highlight', { fileId: hit.fileId, atomId: hit.atomId, seq: hit.seq, rect: e.currentTarget.getBoundingClientRect() }),
      onmouseleave: () => emit('map:highlight', null) },
    n ? h('span', { class: 'sb-src-n sb-num' }, String(n)) : h('i', { class: 'sb-src-dot', 'aria-hidden': 'true' }),
    fico(meta.kind, 14),
    h('span', { class: 'sb-src-name' }, mid(hit.file || meta.name, isMobile() ? 18 : 26)),
    h('span', { class: 'sb-src-m sb-num' }, m == null ? 'keyword match' : `match ${m}`));
    return b;
  }

  function sourceCard(A, hit, { below = false } = {}) {
    const meta = fileMeta(hit.fileId, hit.file);
    const fl = floorOfA(A);
    const m = fmtMatch(hit, fl);
    const raw = rawMatch(hit);
    const gap = below ? belowBy(hit, fl) : null;
    const snip = h('span', { class: 'pf-card-snip' }, hit.excerpt || '');
    // The leading badge is the citation [n] (set on final), never the rank: a reader maps [n] in the answer to the
    // card with the same [n]. Rank is secondary, in small mono on the right.
    const card = h('button', { type: 'button', class: `pf-card${below ? ' is-below' : ''}`, style: { '--hue': hueVar(meta.hue) },
      dataset: { atom: hit.atomId || '', file: hit.fileId || '', rank: String(hit.rank || '') },
      onclick: (e) => openDrawer({ fileId: hit.fileId, atomId: hit.atomId, seq: hit.seq, answerId: A.id }, e.currentTarget),
      onmouseenter: (e) => emit('map:highlight', { fileId: hit.fileId, atomId: hit.atomId, seq: hit.seq, rect: e.currentTarget.getBoundingClientRect() }),
      onmouseleave: () => emit('map:highlight', null) },
    h('span', { class: 'pf-card-bar', 'aria-hidden': 'true' }),
    h('span', { class: 'pf-card-top' },
      h('span', { class: 'pf-cited sb-num', hidden: true }),
      h('span', { class: 'pf-card-ico' }, fico(meta.kind, 14)),
      h('span', { class: 'pf-card-name', title: hit.file || meta.name }, mid(hit.file || meta.name, 22)),
      hit.rank ? h('span', { class: 'pf-rank sb-num' }, `rank ${hit.rank}`) : null),
    h('span', { class: 'pf-card-loc sb-num' }, [hit.locator, hit.atomId ? `atom ${shortId(hit.atomId)}` : null].filter(Boolean).join(' · ')),
    snip,
    h('span', { class: 'pf-card-foot' },
      below ? h('span', { class: 'pf-below-l' }, gap != null && gap < 3 ? `just below floor ${pct(fl)} · not used` : 'below floor · not used') : null,
      m == null
        ? h('span', { class: 'pf-kw' }, 'keyword match')
        : h('span', { class: 'pf-meter', 'aria-hidden': 'true' }, h('i', { style: { transform: `scaleX(${Math.max(0, Math.min(1, (raw ?? 0) / 100))})` } })),
      m == null ? null : h('span', { class: 'pf-match sb-num' }, `match ${m}`)));
    card._snip = snip;
    card._hit = hit;
    return card;
  }

  function renderRetrieval(A) {
    const r = A.retrieval || {};
    const hits = (r.hits || []).slice();
    const kept = hits.filter((x) => x.kept);
    const notKept = hits.filter((x) => !x.kept);
    const floorPct = pct(r.floor?.min ?? (getState().spec || {}).floor ?? 0.7);

    // Bot view: one chip per file (best hit), kept first; with nothing kept, the closest (greyed) candidates.
    const row = A.el.srcRow;
    const chips = kept.length ? hitsByFile(kept) : hitsByFile(notKept).slice(0, 3);
    const nodes = chips.slice(0, 3).map((x) => srcChip(A, x, { dim: !kept.length }));
    if (chips.length > 3) nodes.push(h('span', { class: 'sb-src-more sb-num' }, `+${chips.length - 3}`));
    swapIn(A, row, nodes, 50);

    // Proof view: kept cards, the dashed floor divider, up to 3 below-floor cards, then "+N considered".
    const strip = A.el.strip;
    const below = notKept.filter((x) => x.similarity != null).slice(0, 3);
    const rest = hits.length - kept.length - below.length;
    const cards = kept.map((x) => sourceCard(A, x));
    const out = [...cards];
    // Integrator: with no candidates at all (e.g. the only relevant file is switched off), say so instead of a lone divider.
    if (!hits.length) out.push(h('p', { class: 'pf-empty' }, ico('shield', 14), h('span', null, `No passage in your enabled files came near the floor (${floorPct}). Nothing was invented.`)));
    else if (below.length || !kept.length) out.push(h('div', { class: 'pf-floor', role: 'separator', 'aria-label': `Floor ${floorPct}: nothing below this line is used` }, h('span', { class: 'sb-num' }, `floor ${floorPct}`)));
    for (const x of below) out.push(sourceCard(A, x, { below: true }));
    if (rest > 0) out.push(h('button', { type: 'button', class: 'pf-more', onclick: () => { emit('view:set', { view: 'proof' }); openTrace(A, true); } }, h('b', { class: 'sb-num' }, `+${rest}`), h('span', null, 'considered')));
    A.el.cards = cards;
    swapIn(A, strip, out, 50, () => {
      // match bars grow 0 -> sim over 380 ms, 100 ms after the card lands
      if (A.fast || reduced()) return;
      strip.querySelectorAll('.pf-meter i').forEach((bar, i) => {
        const to = bar.style.transform;
        anim(bar, [{ transform: 'scaleX(0)' }, { transform: to }], aOpts(A, { duration: 380, delay: 100 + i * 50, easing: 'out', essential: false }));
      });
    });
  }

  /** Skeletons cross-fade (120 ms) into real nodes, which arrive with a stagger (translateY 8 -> 0). */
  function swapIn(A, container, nodes, step = 50, after) {
    const skels = [...container.querySelectorAll('.is-skel')];
    const token = {};
    container._swap = token;
    const place = () => {
      if (container._swap !== token) return;   // superseded (e.g. the final arrived during the skeleton fade)
      container._swap = null;
      container.innerHTML = '';
      container.append(...nodes);
      if (!(A.fast || reduced())) {
        nodes.forEach((n, i) => { if (n.nodeType === 1) anim(n, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], aOpts(A, { duration: 260, delay: i * step, easing: 'out' })); });
      }
      after && after();
    };
    if (skels.length && !(A.fast || reduced())) {
      Promise.all(skels.map((s) => anim(s, [{ opacity: 1 }, { opacity: 0 }], aOpts(A, { duration: 120, fill: 'forwards' })).finished)).then(place);
    } else place();
  }

  // ---------------------------------------------------------------- deltas (rAF-batched sentence reveal)

  let lineQueue = [];
  let lineRaf = 0;
  function queueLine(A, d) {
    const idx = A.lineEls.length;
    const p = h('p', { class: 'sb-line' });
    const sent = h('span', { class: 'sb-sent' }, d.text || '');
    p.append(sent);
    const chips = [];
    for (const n of d.n || []) {
      const c = citeChip(A, n, idx);
      chips.push(c);
      p.append(' ', c);
    }
    A.lineEls.push({ p, sent, chips, n: d.n || [] });
    lineQueue.push({ A, p, sent, chips });
    if (!lineRaf) lineRaf = requestAnimationFrame(flushLines);
  }
  function flushLines() {
    lineRaf = 0;
    const q = lineQueue; lineQueue = [];
    const touched = new Set();
    for (const { A, p, sent, chips } of q) {
      const body = A.el.body;
      body.insertBefore(p, A.el.caret.isConnected ? A.el.caret : null);
      touched.add(A);
      if (A.fast || reduced()) continue;
      anim(sent, [{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0px)' }], aOpts(A, { duration: 180, easing: 'out', essential: false }));
      chips.forEach((c, i) => anim(c, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.08)', offset: 0.7 }, { opacity: 1, transform: 'scale(1)' }],
        aOpts(A, { duration: 220, delay: 120 + i * 40, easing: 'spring' })));
    }
    for (const A of touched) if (!A.group) scrollToEnd();
  }

  // ---------------------------------------------------------------- citation chips + CitePopover + thread

  function citeChip(A, n, lineIdx) {
    const popId = `${A.id}-pop`;
    const b = h('button', { type: 'button', class: 'pf-cite', 'aria-label': `Citation ${n}`, 'aria-expanded': 'false', 'aria-controls': popId, 'aria-details': popId,
      dataset: { n: String(n), line: String(lineIdx) } },
    // the ' ' text node separates number and title for the accessible-name check (WCAG 2.5.3); flex drops it visually
    h('span', { class: 'pf-cite-n sb-num' }, String(n)), ' ', h('span', { class: 'pf-cite-t' }));
    b.addEventListener('mouseenter', () => intentOpen(A, b));
    b.addEventListener('mouseleave', () => intentClose(A, b));
    b.addEventListener('focus', () => intentOpen(A, b));
    b.addEventListener('blur', (e) => { if (!A.el.pop.contains(e.relatedTarget)) intentClose(A, b, 120); });
    b.addEventListener('click', () => { const c = citeData(A, b); if (c) openDrawer({ fileId: c.fileId, atomId: c.atomId, seq: c.seq, answerId: A.id, n, line: lineIdx }, b); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Escape' && b.getAttribute('aria-expanded') === 'true') { e.stopPropagation(); closePop(A); } });
    return b;
  }

  /** The exact quote behind chip [n] on line i, with its own atom (a citation can quote several atoms of one file). */
  function citeData(A, chip) {
    const f = A.final;
    if (!f || !f.citations) return null;
    const n = Number(chip.dataset.n);
    const line = Number(chip.dataset.line);
    const cit = f.citations.find((c) => c.n === n);
    if (!cit) return null;
    const claim = f.proof?.claims?.[line];
    const qText = claim && claim.n === n && claim.quote ? claim.quote : (cit.quotes?.[0]?.text || cit.excerpt);
    const ql = (f.proof?.quotedLines || []).find((x) => x.n === n && x.text === qText) || (f.proof?.quotedLines || []).find((x) => x.n === n);
    const q = (cit.quotes || []).find((x) => x.text === qText) || cit.quotes?.[0] || null;
    const atomId = ql?.atomId || cit.atomId;
    const hit = (A.retrieval?.hits || []).find((x) => x.atomId === atomId);
    return {
      n, cit, text: qText || '', offset: q?.offset ?? ql?.offset ?? null, derived: !!q?.derived, atomId, fileId: cit.fileId, file: cit.file,
      seq: hit?.seq ?? (atomId === cit.atomId ? cit.seq : null), locator: hit?.locator || cit.locator, match: fmtMatch(hit || cit, floorOfA(A)), title: cit.title,
      hit,
    };
  }

  let popTimer = 0;
  let closeTimer = 0;
  let openChip = null;
  let linked = null;               // {A, chip, card}
  let proofAutoDone = (() => { try { return localStorage.getItem(PROOF_AUTO_KEY) === '1'; } catch { return false; } })();

  function intentOpen(A, chip) {
    clearTimeout(closeTimer);
    clearTimeout(popTimer);
    if (!A.final || A.final.refused) return;
    popTimer = setTimeout(() => openPop(A, chip), openChip === chip ? 0 : 200);
  }
  function intentClose(A, chip, delay = 160) {
    clearTimeout(popTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      const pop = A.el.pop;
      if (pop && !pop.hidden && (pop.matches(':hover') || pop.contains(document.activeElement))) return;
      if (chip === document.activeElement) return;
      closePop(A);
    }, delay);
  }

  function openPop(A, chip) {
    const c = citeData(A, chip);
    if (!c) return;
    if (openChip && openChip !== chip) { const prevA = answers.get(openChip.closest('.sb-answer')?.id); if (prevA) closePop(prevA); }
    // B5: the first chip interaction turns Proof view on for this session (B shows the toast; the choice is remembered)
    if (!proofAutoDone && getState().ui.view !== 'proof') {
      proofAutoDone = true;
      try { localStorage.setItem(PROOF_AUTO_KEY, '1'); } catch { /* ignore */ }
      emit('view:set', { view: 'proof' });
    }
    openChip = chip;
    chip.setAttribute('aria-expanded', 'true');
    chip.classList.add('is-open');
    const pop = A.el.pop;
    const wasOpen = !pop.hidden;
    pop.hidden = false;
    A.popOpen = true;
    fillPop(A, pop, c, chip);
    placePop(A, pop, chip);
    if (!wasOpen && !reduced()) anim(pop, [{ opacity: 0, transform: 'translateY(4px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' });
    const mk = pop.querySelector('mark');
    if (mk) motion.sweep(mk);
    // lift the matching card and draw the thread (Proof view), or point the map at the chip (Bot view)
    requestAnimationFrame(() => requestAnimationFrame(() => linkThread(A, chip, c)));
    // load the atom for ±1 line of real context (cached)
    loadAtom(c.fileId, c.seq).then((atom) => {
      if (openChip !== chip || !atom) return;
      fillPop(A, pop, c, chip, atom.text);
      placePop(A, pop, chip);
    });
  }

  function wirePop(A, pop) {
    pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    pop.addEventListener('mouseleave', () => intentClose(A, openChip));
    pop.addEventListener('focusout', (e) => { if (!pop.contains(e.relatedTarget) && e.relatedTarget !== openChip) intentClose(A, openChip, 80); });
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); const ch = openChip; closePop(A); ch && ch.focus(); } });
  }

  function closePop(A) {
    clearTimeout(popTimer);
    const pop = A.el.pop;
    if (openChip) { openChip.setAttribute('aria-expanded', 'false'); openChip.classList.remove('is-open'); }
    openChip = null;
    unlinkThread();
    if (!pop || pop.hidden || !A.popOpen) return;
    A.popOpen = false;
    const hide = () => { if (!A.popOpen) { pop.hidden = true; pop.innerHTML = ''; } };
    if (reduced()) hide(); else anim(pop, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 }).finished.then(hide);
  }

  /** ±1 line of context around the quote: the sentence/line before, the quote marked, the one after. */
  function contextParts(full, quote) {
    const t = String(full || '');
    const q = String(quote || '').replace(/…$/, '');
    let i = q ? t.indexOf(q) : -1;
    if (i < 0 && q) { const k = t.toLowerCase().indexOf(q.toLowerCase().slice(0, 60)); if (k >= 0) i = k; }
    if (i < 0) return { before: '', mark: q || t, after: '' };
    const end = Math.min(t.length, i + q.length);
    const pre = t.slice(0, i), post = t.slice(end);
    const prevSent = (pre.match(/(?:^|[.!?\n]\s+)([^.!?\n]*[.!?]?\s*)$/) || [])[1] || pre.slice(-140);
    const nextSent = (post.match(/^\s*([^.!?\n]*[.!?]?)/) || [])[1] || post.slice(0, 140);
    return { before: clip(prevSent.trim(), 160), mark: t.slice(i, end), after: clip(nextSent.trim(), 160) };
  }

  function fillPop(A, pop, c, chip, atomText) {
    const parts = contextParts(atomText || c.hit?.excerpt || c.cit?.excerpt || c.text, c.text);
    const metaBits = [`Quoted verbatim from ${c.file}`, c.locator, c.match == null ? 'keyword match' : `match ${c.match}`].filter(Boolean);
    pop.setAttribute('aria-label', `Citation ${c.n} receipt`);
    pop.innerHTML = '';
    pop.append(
      h('div', { class: 'pf-pop-head' }, h('span', { class: 'pf-pop-n sb-num' }, String(c.n)), h('span', { class: 'pf-pop-title' }, c.title || chipTitle(c.file, c.title)),
        c.derived ? h('span', { class: 'pf-badge is-derived' }, 'from a table row') : h('span', { class: 'pf-badge' }, ico('check', 11), 'Verbatim')),
      h('p', { class: 'pf-pop-ctx' },
        parts.before ? h('span', { class: 'pf-ctx-dim' }, `${parts.before} `) : null,
        h('mark', { class: 'pf-mark' }, parts.mark),
        parts.after ? h('span', { class: 'pf-ctx-dim' }, ` ${parts.after}`) : null),
      h('p', { class: 'pf-pop-meta sb-num' }, metaBits.join(' · ')),
      h('button', { type: 'button', class: 'pf-pop-open', onclick: () => openDrawer({ fileId: c.fileId, atomId: c.atomId, seq: c.seq, answerId: A.id, n: c.n, line: Number(chip.dataset.line) }, chip) },
        'Open receipt', ico('arrowRight', 13)));
    const mk = pop.querySelector('mark');
    if (mk) mk.style.backgroundSize = '100% 100%';
  }

  function placePop(A, pop, chip) {
    if (isMobile()) { pop.classList.add('is-inline'); pop.style.left = ''; pop.style.top = ''; return; }
    pop.classList.remove('is-inline');
    const host = A.el.root.getBoundingClientRect();
    const r = chip.getBoundingClientRect();
    const w = Math.min(380, host.width - 24);
    pop.style.width = `${w}px`;
    let left = r.left - host.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, host.width - w - 8));
    const ph = pop.offsetHeight || 140;
    const pane = dom.thread.getBoundingClientRect();
    const below = r.bottom + ph + 12 < pane.bottom || r.top - ph - 12 < pane.top;
    pop.style.left = `${left}px`;
    pop.style.top = below ? `${r.bottom - host.top + 8}px` : `${r.top - host.top - ph - 8}px`;
    pop.dataset.side = below ? 'below' : 'above';
  }

  // Thread: an SVG path from chip to card (pathLength=1 draw, 220 ms), the card lifts, the map gets the same atom.
  let threadRaf = 0;
  function linkThread(A, chip, c) {
    unlinkThread(true);
    const proof = (dom.bot?.dataset.view || getState().ui.view) === 'proof';
    const card = proof ? (A.el.cards || []).find((x) => x.dataset.atom === c.atomId) || (A.el.cards || []).find((x) => x.dataset.file === c.fileId) : null;
    linked = { A, chip, card, c };
    if (card) {
      card.classList.add('is-linked');
      const strip = A.el.strip;
      const sr = strip.getBoundingClientRect(), cr = card.getBoundingClientRect();
      if (cr.left < sr.left || cr.right > sr.right) strip.scrollTo({ left: strip.scrollLeft + (cr.left - sr.left) - 12, behavior: 'auto' });
      drawThread(true);
      strip.addEventListener('scroll', scheduleThreadDraw, { passive: true });
    }
    emit('map:highlight', { fileId: c.fileId, atomId: c.atomId, seq: c.seq, rect: (card || chip).getBoundingClientRect() });
  }
  function scheduleThreadDraw() { if (!threadRaf) threadRaf = requestAnimationFrame(() => { threadRaf = 0; drawThread(false); }); }
  function drawThread(animateIn) {
    if (!linked || !linked.card) return;
    const { A, chip, card } = linked;
    if (!chip.isConnected || !card.isConnected) return;
    const host = A.el.root.getBoundingClientRect();
    const a = chip.getBoundingClientRect(), b = card.getBoundingClientRect();
    const strip = A.el.strip.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - host.left, y1 = a.top - host.top;
    const x2 = Math.max(strip.left - host.left + 6, Math.min(strip.right - host.left - 6, b.left + b.width / 2 - host.left));
    const y2 = b.bottom - host.top;
    const my = (y1 + y2) / 2;
    const path = A.el.svg.querySelector('path'), dot = A.el.svg.querySelector('circle');
    path.setAttribute('d', `M${x1.toFixed(1)} ${y1.toFixed(1)} C${x1.toFixed(1)} ${my.toFixed(1)}, ${x2.toFixed(1)} ${my.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`);
    dot.setAttribute('cx', x2.toFixed(1)); dot.setAttribute('cy', y2.toFixed(1));
    A.el.svg.classList.add('is-on');
    if (animateIn) {
      motion.drawPath(path, 220);
      if (!reduced()) anim(dot, [{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 260 });
    }
  }
  function unlinkThread(silent) {
    if (!linked) return;
    const { A, card } = linked;
    if (card) { card.classList.remove('is-linked'); A.el.strip.removeEventListener('scroll', scheduleThreadDraw); }
    A.el.svg.classList.remove('is-on');
    linked = null;
    if (!silent) emit('map:highlight', null);
  }
  window.addEventListener('resize', () => { if (linked) scheduleThreadDraw(); if (openChip) { const A = answers.get(openChip.closest('.sb-answer')?.id); if (A?.el.pop && !A.el.pop.hidden) placePop(A, A.el.pop, openChip); } }, { passive: true });

  // ---------------------------------------------------------------- atoms cache

  const atomCache = new Map();       // `${fileId}:${seq}` -> Promise<{seq, atomId, text, meta}|null>
  const neighbourCache = new Map();  // `${fileId}:${seq}` -> Promise<items[]>
  function loadAround(fileId, seq, span = 1) {
    if (!fileId || seq == null) return Promise.resolve(null);
    const key = `${fileId}:${seq}:${span}`;
    if (!neighbourCache.has(key)) {
      neighbourCache.set(key, api.fileAtoms(fileId, { around: seq, span }).then((r) => r || null).catch((err) => { neighbourCache.delete(key); throw err; }));
    }
    return neighbourCache.get(key);
  }
  function loadAtom(fileId, seq) {
    const key = `${fileId}:${seq}`;
    if (!atomCache.has(key)) {
      atomCache.set(key, loadAround(fileId, seq, 1).then((r) => (r?.items || []).find((x) => x.seq === seq) || null).catch(() => { atomCache.delete(key); return null; }));
    }
    return atomCache.get(key);
  }

  // ---------------------------------------------------------------- final

  function onFinal(A, f, { restore = false } = {}) {
    if (!f || A.final) return;
    A.final = f;
    A.status = f.status || (f.refused ? 'refused' : 'grounded');
    A.text = f.text || A.text;
    A.el.root.dataset.status = A.status;
    A.el.root.removeAttribute('aria-busy');
    commit(A, restore ? 'answer:restore' : 'answer:final');
    if (lineRaf) { cancelAnimationFrame(lineRaf); flushLines(); }
    if (f.refused) renderRefusal(A); else renderGrounded(A);
    if (restore) { A.stopClock && A.stopClock(); A.settled = true; return; }
    if (A.by !== 'proof') emitMap(A, true);
    emit('answer:final', { answerId: A.id, final: f });
    afterFinal(A);
    if (A.by !== 'proof') saveThread();
  }

  // ---------------------------------------------------------------- refresh keeps the proof (last answers per trial)
  // The server keeps a summary of each answer, not the receipts, so C keeps the last few full answers (final +
  // retrieval) in its own localStorage key, scoped to the trial id. A reload rebuilds them without replaying motion.
  const THREAD_KEY = 'kb-studio-thread';
  const THREAD_KEEP = 4;
  let restoredFor = null;
  function saveThread() {
    const tid = getState().trial?.id;
    if (!tid) return;
    let items = [...answers.values()].filter((x) => x.by !== 'proof' && x.final && !x.error).slice(-THREAD_KEEP).map((x) => ({
      question: x.question, by: x.by, label: x.label, version: x.version, startedAt: x.startedAt, steps: x.steps,
      retrieval: x.retrieval, lines: x.lines ? { count: x.lines.count } : null, selected: x.selected, final: x.final }));
    try {
      let json = JSON.stringify({ trialId: tid, items });
      while (json.length > 350000 && items.length > 1) { items = items.slice(1); json = JSON.stringify({ trialId: tid, items }); }
      localStorage.setItem(THREAD_KEY, json);
    } catch { /* private mode or quota: the thread just won't survive a reload */ }
  }
  function restoreThread() {
    const tid = getState().trial?.id;
    if (!tid || restoredFor === tid || answers.size) return;
    restoredFor = tid;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(THREAD_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.trialId !== tid || !Array.isArray(saved.items) || !saved.items.length) return;
    dropGhost();
    for (const it of saved.items) {
      if (!it || !it.final || !it.question) continue;
      const A = {
        id: uid('ans'), question: String(it.question).slice(0, 500), by: it.by || 'user', label: it.label || null, status: 'pending', steps: Array.isArray(it.steps) ? it.steps : [],
        retrieval: null, lines: it.lines || null, selected: it.selected || null, text: '', final: null, version: it.version || 1,
        startedAt: it.startedAt || Date.now(), t0: performance.now(), fast: true, partial: false, el: {}, lineEls: [], tweens: [], group: null, attempts: 0,
        persona: 'customer', restored: true, settled: true,
      };
      A.promise = Promise.resolve(it.final); A.resolve = () => {};
      answers.set(A.id, A);
      try {
        buildAnswer(A);
        A.retrieval = it.retrieval || null;
        if (A.retrieval) renderRetrieval(A);
        onFinal(A, it.final, { restore: true });
        A.el.root.dataset.restored = 'true';
        restoredN++;
      } catch {
        answers.delete(A.id);
        A.el.root?.remove();
      }
    }
    if (!restoredN) return;
    threadEl.append(h('p', { class: 'sb-restored', role: 'note' }, ico('clock', 13),
      h('span', null, `${restoredN === 1 ? 'Your last answer' : `Your last ${restoredN} answers`}, restored with their receipts. Ask anything to continue.`)));
    scrollToEnd(true);
  }

  function renderGrounded(A) {
    const f = A.final;
    const body = A.el.body;
    A.el.caret.remove();
    // no deltas arrived (or a fast path): render the final text's lines
    if (!A.lineEls.length) {
      String(f.text || '').split('\n').filter((l) => l.trim()).forEach((l) => {
        const n = [...l.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
        queueLine(A, { text: l.replace(/^\s*-\s+/, '').replace(/\s*\[\d{1,3}\]/g, '').trim(), n });
      });
      if (lineRaf) { cancelAnimationFrame(lineRaf); flushLines(); }
    }
    // titled chips: [1 · Warranty & Returns]
    const byN = new Map((f.citations || []).map((c) => [c.n, c]));
    body.querySelectorAll('.pf-cite').forEach((chip) => {
      const c = byN.get(Number(chip.dataset.n));
      if (!c) return;
      const d = citeData(A, chip);
      const title = chipTitle(c.file, c.title);
      const t = chip.querySelector('.pf-cite-t');
      t.textContent = title;
      const loc = d?.seq != null ? `atom ${d.seq + 1}` : (d?.locator || c.locator || '');
      chip.setAttribute('aria-label', `Citation ${c.n}: ${title}${loc ? `, ${loc}` : ''}`);
      if (!(A.fast || reduced())) anim(t, [{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }], aOpts(A, { duration: 220, easing: 'out' }));
    });
    // Bot view source row: cited files first in [n] order (so source order == citation order), then the others.
    const hits = A.retrieval?.hits || [];
    const kept = hits.filter((x) => x.kept);
    const ordered = [];
    for (const c of f.citations || []) {
      const hit = hits.find((x) => x.atomId === c.atomId) || hits.find((x) => x.fileId === c.fileId) || { fileId: c.fileId, file: c.file, atomId: c.atomId, seq: c.seq, similarity: c.similarity, match: c.match, locator: c.locator };
      ordered.push(srcChip(A, hit, { n: c.n }));
    }
    const citedFiles = new Set((f.citations || []).map((c) => c.fileId));
    const others = hitsByFile(kept).filter((x) => !citedFiles.has(x.fileId));
    for (const x of others.slice(0, Math.max(0, 3 - ordered.length))) ordered.push(srcChip(A, x, { dim: true }));
    A.el.srcRow._swap = null;
    A.el.srcRow.innerHTML = ''; A.el.srcRow.append(...ordered);
    // Evidence strip: mark the quoted spans and badge the cited cards with their [n]
    const quoted = f.proof?.quotedLines || [];
    const citeN = new Map();
    for (const card of A.el.cards || []) {
      const qs = quoted.filter((q) => q.atomId === card.dataset.atom);
      const ns = [...new Set(qs.length ? qs.map((q) => q.n) : (f.citations || []).filter((c) => c.atomId && c.atomId === card.dataset.atom).map((c) => c.n))].sort((a, b) => a - b);
      if (!ns.length) continue;
      citeN.set(card, ns[0]);
      const badge = card.querySelector('.pf-cited');
      badge.hidden = false;
      badge.textContent = `[${ns.join('][')}]`;
      card.classList.add('is-cited');
      if (qs.length) markSnippet(card._snip, card._hit?.excerpt || '', qs.map((q) => q.text), A);
    }
    orderCardsByCitation(A, citeN);
    morphPill(A);
    renderLedger(A);
    renderTrace(A);
    renderFoot(A);
  }

  /** Source order == citation order: cited cards move to the front in [n] order, then the other kept cards by rank.
   *  FLIP with transforms only (one measurement before, one after), so nothing reflows per frame. */
  function orderCardsByCitation(A, citeN) {
    const cards = (A.el.cards || []).filter((c) => c.isConnected);
    if (cards.length < 2) return;
    const want = cards.slice().sort((a, b) => {
      const na = citeN.get(a) ?? Infinity, nb = citeN.get(b) ?? Infinity;
      if (na !== nb) return na - nb;
      return (Number(a.dataset.rank) || 99) - (Number(b.dataset.rank) || 99);
    });
    if (want.every((c, i) => c === cards[i])) return;
    const animate = !(A.fast || reduced());
    const before = animate ? new Map(cards.map((c) => [c, c.getBoundingClientRect().left])) : null;
    const anchor = cards[0];
    const ph = document.createComment('cards');
    anchor.before(ph);
    for (const c of want) ph.before(c);
    ph.remove();
    A.el.cards = want;
    if (!animate) return;
    for (const c of want) {
      const dx = before.get(c) - c.getBoundingClientRect().left;
      if (Math.abs(dx) > 1) anim(c, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }], aOpts(A, { duration: 320, easing: 'out', essential: false }));
    }
  }

  function markSnippet(el, excerpt, quotes, A) {
    if (!el) return;
    const text = String(excerpt || '');
    let best = null;
    for (const q of quotes) {
      const qq = String(q || '').replace(/…$/, '');
      const i = text.indexOf(qq.slice(0, Math.min(qq.length, 160)));
      if (i >= 0) { best = [i, Math.min(text.length, i + qq.length)]; break; }
    }
    if (!best) return;
    el.innerHTML = '';
    const mk = h('mark', { class: 'pf-mark' }, text.slice(best[0], best[1]));
    el.append(text.slice(0, best[0]), mk, text.slice(best[1]));
    if (A.fast || reduced()) mk.style.backgroundSize = '100% 100%';
    else setTimeout(() => motion.sweep(mk), 160);
  }

  function renderFoot(A) {
    const f = A.final;
    const foot = A.el.foot;
    foot.innerHTML = '';
    const n = (f.citations || []).length;
    foot.append(...[
      f.refused ? null : h('button', { type: 'button', class: 'sb-foot-src', onclick: () => emit('view:set', { view: (getState().ui.view === 'proof' ? 'bot' : 'proof') }) },
        ico('layers', 13), h('span', { class: 'sb-foot-bot' }, `Sources (${n})`), h('span', { class: 'sb-foot-proof' }, 'Bot view')),
      h('span', { class: 'sb-foot-hint sb-foot-bot' }, 'Your visitors see this view.'),
      h('span', { class: 'sb-foot-hint sb-foot-proof' }, 'Proof view · only you see this.'),
      A.by === 'proof' ? null : h('span', { class: 'sb-logged' }, ico('trending', 12), h('span', null, 'Logged to ', h('span', { class: 'sb-hide-m' }, 'question '), 'insights'))].filter(Boolean));
    foot.hidden = false;
    if (!(A.fast || reduced())) anim(foot, [{ opacity: 0 }, { opacity: 1 }], aOpts(A, { duration: 220, delay: 120 }));
  }

  // ---------------------------------------------------------------- refusal (B6)

  function renderRefusal(A) {
    const f = A.final;
    A.el.caret.remove();
    A.el.body.querySelectorAll('.sb-line').forEach((x) => x.remove());
    const isGuard = f.status === 'guard';
    const shield = svgFrag('<svg class="pf-shield" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2 19 6v5.4c0 4.3-2.9 7.9-7 9.4-4.1-1.5-7-5.1-7-9.4V6Z"/><path d="M9.2 12h5.6"/></svg>');
    const textEl = h('p', { class: 'pf-refusal-text' });
    const whyId = `${A.id}-why`;
    const whyBtn = h('button', { type: 'button', class: 'pf-why-btn', 'aria-expanded': 'false', 'aria-controls': whyId }, 'Why?', ico('chevronDown', 13));
    const whyPanel = h('div', { class: 'pf-why', id: whyId, hidden: true });
    whyBtn.addEventListener('click', () => toggleWhy(A, whyBtn, whyPanel));
    const block = h('div', { class: 'pf-refusal' }, h('div', { class: 'pf-refusal-row' }, h('span', { class: 'pf-refusal-ico' }, shield), textEl), h('div', { class: 'pf-refusal-actions' }, whyBtn), whyPanel);
    A.el.body.append(block);
    A.el.refusal = block;
    // the ticker stops on the real verdict while the refusal choreography plays, then becomes the pill
    if (A.el.ticker && A.el.ticker.isConnected) {
      const t = A.el.ticker;
      t.classList.add('is-stopped');
      const l = t.querySelector('.sb-tick-l.is-on');
      if (l) l.textContent = isGuard ? 'Guard caught it before search' : `Nothing above floor ${pct(f.why?.floor ?? A.retrieval?.floor?.min ?? 0.7)}`;
      const ms = t.querySelector('.sb-tick-ms');
      if (ms) ms.textContent = fmtMs(f.latencyMs?.total);
    }
    const exact = String(f.text || (isGuard ? '' : NOT_IN_DATA));
    const done = () => {
      textEl.textContent = exact;   // nothing is ever appended to the refusal sentence
      morphPill(A);
      renderTrace(A);
      renderFoot(A);
    };
    if (A.fast || reduced()) { greyCandidates(A, true); done(); return; }
    // choreography: candidates sink and grey (30 ms stagger), the shield draws (400 ms), the sentence types (12 ms/char)
    greyCandidates(A, false);
    shield.querySelectorAll('path').forEach((p) => motion.drawPath(p, 400));
    setTimeout(() => {
      if (A.fast) { done(); return; }
      const t = motion.typeText(textEl, exact, { cps: 1000 / 12, maxMs: exact.length * 12 });
      A.tweens.push(t);
      t.finished.then(done);
    }, 260);
  }

  function greyCandidates(A, instant) {
    const els = [...A.el.srcRow.querySelectorAll('.sb-src'), ...A.el.strip.querySelectorAll('.pf-card')];
    els.forEach((el, i) => {
      el.classList.add('is-grey');
      if (instant || reduced()) return;
      anim(el, [{ transform: 'none', opacity: 1 }, { transform: 'translateY(8px)', opacity: 0.8 }], aOpts(A, { duration: 300, delay: i * 30, easing: 'out', essential: false }));
    });
  }

  function toggleWhy(A, btn, panel) {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (!open) return;
    if (!panel.childElementCount) panel.append(floorChart(A));
    // the chart opens below the fold more often than not: bring it into view (nearest: no jump when it already fits)
    requestAnimationFrame(() => { stick = false; panel.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }); });
    if (!reduced()) {
      anim(panel, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' });
      panel.querySelectorAll('.pf-fc-bar').forEach((b, i) => anim(b, [{ transform: 'scaleX(0)' }, { transform: getComputedStyle(b).transform }], { duration: 380, delay: 60 + i * 50, easing: 'out', essential: false }));
    }
  }

  /** FloorChart: the 5 best candidates against a dashed floor line. Scale 0–100, honest. */
  function floorChart(A) {
    const f = A.final;
    if (f.status === 'guard' || !f.why) {
      return h('div', { class: 'pf-fc' },
        h('p', { class: 'pf-fc-cap' }, 'A safety guard answered before any search ran, so nothing from your files was used. The same guard protects every bot.'),
        f.guard ? h('p', { class: 'pf-fc-note sb-num' }, `guard: ${f.guard}`) : null);
    }
    const why = f.why;
    const flSim = why.floor ?? f.proof?.floor ?? 0.7;
    const floor = pct(flSim);
    const best = why.best == null ? '–' : fmtMatch(Number(why.best), flSim);
    const cands = (why.candidates || []).slice(0, 5);
    const mOf = (c) => fmtMatch(c, flSim);
    const rows = h('div', { class: 'pf-fc-rows', style: { '--floor': `${floor}%` } },
      h('div', { class: 'pf-fc-row pf-fc-axis', 'aria-hidden': 'true' }, h('span'), h('span', { class: 'pf-fc-track' }, h('span', { class: 'pf-fc-flabel sb-num' }, `floor ${floor}`)), h('span')),
      cands.map((c) => {
        const meta = fileMeta(null, c.file);
        const raw = rawMatch(c) ?? 0;
        return h('div', { class: 'pf-fc-row' },
          h('span', { class: 'pf-fc-name', title: c.file }, mid(c.file, 22)),
          h('span', { class: 'pf-fc-track' }, h('i', { class: 'pf-fc-bar', style: { '--hue': hueVar(meta.hue), transform: `scaleX(${Math.max(0.01, raw / 100)})` } })),
          h('span', { class: 'pf-fc-n sb-num' }, mOf(c) ?? '–'));
      }));
    const table = h('table', { class: 'st-sr' }, h('caption', null, 'Closest candidates and their match scores'),
      h('tr', null, h('th', null, 'File'), h('th', null, 'Match')), cands.map((c) => h('tr', null, h('td', null, c.file), h('td', null, mOf(c) ?? ''))));
    const closest = h('div', { class: 'pf-closest' }, h('p', { class: 'pf-closest-h' }, 'Closest atoms (not used)'),
      h('ul', null, cands.slice(0, 3).map((c) => h('li', null, h('span', { class: 'pf-closest-f sb-num' }, `${mid(c.file, 22)} · match ${mOf(c) ?? '–'}`), h('span', { class: 'pf-closest-x' }, clip(c.excerpt, 150))))));
    const reason = why.reason ? ` The closest lines didn't answer the question.` : '';
    const gap = why.best == null ? null : belowBy(Number(why.best), flSim);
    const close = gap != null && gap <= 6;
    return h('div', { class: 'pf-fc' },
      h('div', { 'aria-hidden': 'true' }, rows), table,
      // a refusal can also come from the line selector (best match above the floor, but no line answers): say so honestly
      why.best != null && Number(why.best) >= flSim
        ? h('p', { class: 'pf-fc-cap' }, h('b', { class: 'sb-num' }, `Best match ${best} ≥ floor ${floor},`), ' but no line in those atoms answers the question. Nothing was invented.')
        : h('p', { class: 'pf-fc-cap' }, h('b', { class: 'sb-num' }, `Best match ${best} < floor ${floor}.`), ` Nothing was invented.${reason}`),
      close ? h('p', { class: 'pf-fc-note' }, `Close miss: ${gap < 1 ? 'a fraction of a point' : plural(Math.round(gap), 'point')} under the floor. Rephrasing, or a file that states it directly, usually fixes it.`) : null,
      cands.length ? closest : null);
  }

  // ---------------------------------------------------------------- ClaimLedger (Proof view)

  function renderLedger(A) {
    const f = A.final;
    const claims = f.proof?.claims || [];
    if (!claims.length) return;
    const v = f.proof.verified || { claims: claims.length, verified: claims.filter((c) => c.verified).length };
    const vp = v.claims ? Math.round((100 * v.verified) / v.claims) : 100;
    const id = `${A.id}-ledger`;
    const btn = h('button', { type: 'button', class: 'pf-sum', 'aria-expanded': 'false', 'aria-controls': id },
      ico('shieldCheck', 14),
      h('span', null, 'Verified claims ', h('b', { class: 'sb-num' }, `${v.verified}/${v.claims}`), ' · ', h('b', { class: 'sb-num' }, `${vp}%`), ' · Unsupported claims ', h('b', { class: `sb-num${f.proof.unsupported ? ' is-bad' : ' is-good'}` }, String(f.proof.unsupported || 0))),
      h('span', { class: 'pf-sum-chev' }, ico('chevronDown', 14)));
    const byN = new Map((f.citations || []).map((c) => [c.n, c]));
    const panel = h('div', { class: 'pf-ledger-panel', id, hidden: true },
      h('div', { class: 'pf-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Claim ledger table' }, h('table', { class: 'pf-table' },
        h('caption', { class: 'st-sr' }, 'Claim ledger: every sentence and the exact quote it was copied from'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Claim'), h('th', { scope: 'col' }, 'Exact quote'), h('th', { scope: 'col' }, 'File · locator'), h('th', { scope: 'col' }, 'Match'), h('th', { scope: 'col' }, h('span', { class: 'st-sr' }, 'Check')))),
        h('tbody', null, claims.map((c) => {
          const cit = byN.get(c.n);
          const ql = (f.proof.quotedLines || []).find((q) => q.text === c.quote);
          const hit = (A.retrieval?.hits || []).find((x) => x.atomId === (ql?.atomId || cit?.atomId));
          const m = fmtMatch(hit || cit, floorOfA(A));
          return h('tr', null,
            h('td', null, c.n ? h('span', { class: 'pf-tn sb-num' }, `[${c.n}]`) : null, ' ', c.sentence),
            h('td', { class: 'pf-tq' }, c.quote ? h('q', null, c.quote) : h('span', { class: 'pf-dim' }, '—')),
            h('td', { class: 'sb-num pf-tf' }, [c.file, hit?.locator || c.locator].filter(Boolean).join(' · ')),
            h('td', { class: 'sb-num' }, m == null ? 'keyword' : m),
            h('td', null, c.verified ? h('span', { class: 'pf-badge' }, ico('check', 11), 'Verbatim') : h('span', { class: 'pf-badge is-warn' }, 'Unverified')));
        })))),
      h('p', { class: 'pf-foot-note' }, 'In select mode every sentence is copied from your files; the model only chooses which lines.'));
    btn.addEventListener('click', () => disclose(btn, panel));
    const box = h('div', { class: 'pf-only pf-ledger' }, btn, panel);
    A.el.extras.append(box);
    if (!(A.fast || reduced())) anim(box, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], aOpts(A, { duration: 260, delay: 80, easing: 'out' }));
  }

  function disclose(btn, panel, onOpen) {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) {
      if (!reduced()) anim(panel, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' });
      onOpen && onOpen();
    }
    return open;
  }

  // ---------------------------------------------------------------- TraceWaterfall (Proof view)

  function renderTrace(A) {
    const f = A.final, r = A.retrieval || {};
    const lat = f.latencyMs || {};
    const total = Math.max(1, lat.total || Math.round(performance.now() - A.t0));
    const t = (step) => A.steps.find((s) => s.step === step)?.ms;
    const tEmbed = t('embed') ?? 0;
    const tRet = r.ms ?? lat.retrieve ?? t('rank') ?? 0;
    const hits = r.hits || [];
    const kept = hits.filter((x) => x.kept);
    const fl = r.floor?.min ?? f.proof?.floor ?? 0.7;
    const top = r.floor?.top ?? f.why?.best ?? null;
    const atoms = r.searched?.atoms ?? 0;
    const rows = [
      { label: `Embed + search ${atoms.toLocaleString()} atoms`, start: tEmbed, dur: Math.max(0, tRet - tEmbed), ms: fmtMs(Math.max(0, tRet - tEmbed)) },
      { label: top == null ? `Floor check · floor ${pct(fl)}` : `Floor check ${fmtMatch(Number(top), fl)} ${top >= fl ? '≥' : '<'} ${pct(fl)}`, start: tRet, dur: 0, ms: top != null && top >= fl ? 'pass' : 'below', tone: top != null && top >= fl ? 'good' : 'muted' },
      { label: `Kept ${kept.length} of ${hits.length}`, start: tRet, dur: 0, ms: '', button: true },
    ];
    if (!f.refused) {
      const tSel = t('select') ?? tRet;
      const tQ = t('quote') ?? (tSel + (A.selected?.ms || lat.select || 0));
      const picked = (A.selected?.lines || f.proof?.picked || []).map((x) => `L${x}`).join(', ') || 'none';
      const model = A.selected?.model || 'model';
      rows.push({ label: `Candidate lines ${(A.lines?.count ?? f.proof?.candidates ?? 0).toLocaleString()}`, start: tSel, dur: 0, ms: '' });
      rows.push({ label: `Model picked ${picked} · ${model}`, start: tSel, dur: A.selected?.ms ?? lat.select ?? 0, ms: fmtMs(A.selected?.ms ?? lat.select ?? 0) });
      rows.push({ label: 'Quoted & cited', start: tQ, dur: Math.max(0, total - tQ), ms: fmtMs(Math.max(0, total - tQ)) });
    } else if (f.status === 'guard') {
      rows.length = 0;
      rows.push({ label: `Guard: ${f.guard || 'off-topic request'}`, start: 0, dur: total, ms: fmtMs(total) });
      rows.push({ label: 'Search skipped · nothing retrieved', start: total, dur: 0, ms: '' });
    } else {
      rows.push({ label: 'Refused · canonical sentence, no model call', start: tRet, dur: Math.max(0, total - tRet), ms: fmtMs(Math.max(0, total - tRet)), tone: 'muted' });
    }
    const id = `${A.id}-trace`;
    const btn = h('button', { type: 'button', class: 'pf-sum', 'aria-expanded': 'false', 'aria-controls': id },
      ico('chart', 14), h('span', null, 'How this answer was built · ', h('b', { class: 'sb-num' }, fmtMs(total))), h('span', { class: 'pf-sum-chev' }, ico('chevronDown', 14)));
    const tableId = `${A.id}-kept`;
    const list = h('ol', { class: 'pf-wf' }, rows.map((row) => {
      const left = Math.min(100, (100 * row.start) / total);
      const width = row.dur > 0 ? Math.max(0.8, Math.min(100 - left, (100 * row.dur) / total)) : 0;
      const label = row.button
        ? h('button', { type: 'button', class: 'pf-wf-link', 'aria-expanded': 'false', 'aria-controls': tableId, onclick: (e) => { const b = e.currentTarget; disclose(b, keptTable); } }, row.label, ico('chevronRight', 12))
        : h('span', null, row.label);
      return h('li', { class: `pf-wf-row${row.tone ? ` is-${row.tone}` : ''}` },
        h('span', { class: 'pf-wf-l' }, label),
        h('span', { class: 'pf-wf-track', 'aria-hidden': 'true' }, width ? h('i', { class: 'pf-wf-bar', style: { left: `${left}%`, width: `${width}%` } }) : h('i', { class: 'pf-wf-tick', style: { left: `${left}%` } })),
        h('span', { class: 'pf-wf-ms sb-num' }, row.ms));
    }));
    const keptTable = rankedTable(A, tableId);
    const panel = h('div', { class: 'pf-trace-panel', id, hidden: true }, list, keptTable);
    btn.addEventListener('click', () => disclose(btn, panel, () => {
      if (reduced()) return;
      panel.querySelectorAll('.pf-wf-bar, .pf-wf-tick').forEach((b, i) => anim(b, [{ transform: 'scaleX(0)', transformOrigin: 'left' }, { transform: 'scaleX(1)', transformOrigin: 'left' }], { duration: 120, delay: i * 120, easing: 'out', fill: 'backwards', essential: false }));
    }));
    const box = h('div', { class: 'pf-only pf-trace' }, btn, panel);
    A.el.trace = { btn, panel, keptTable, box };
    A.el.extras.append(box);
    if (!(A.fast || reduced())) anim(box, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], aOpts(A, { duration: 260, delay: 140, easing: 'out' }));
  }

  function rankedTable(A, id) {
    const r = A.retrieval || {};
    const fl = r.floor?.min ?? 0.7;
    const hits = r.hits || [];
    const rows = [];
    let floorDone = false;
    const sorted = hits.slice();
    sorted.forEach((x, i) => {
      if (!floorDone && !x.kept) {
        floorDone = true;
        rows.push(h('tr', { class: 'pf-floor-row' }, h('td', { colspan: '5' }, h('span', { class: 'sb-num' }, `floor ${pct(fl)}`), ' · nothing below this line is used')));
      }
      const m = fmtMatch(x, fl);
      rows.push(h('tr', { class: x.kept ? 'is-kept' : 'is-dropped' },
        h('td', { class: 'sb-num' }, String(x.rank ?? i + 1)),
        h('td', { title: x.file }, mid(x.file, 24)),
        h('td', { class: 'sb-num', title: x.atomId }, shortId(x.atomId)),
        h('td', { class: 'sb-num' }, x.seq == null ? '–' : String(x.seq)),
        h('td', { class: 'sb-num', title: x.rrf != null ? `hybrid rank score ${Number(x.rrf).toFixed(3)}` : null }, m == null ? 'keyword match' : m)));
    });
    if (!floorDone) rows.push(h('tr', { class: 'pf-floor-row' }, h('td', { colspan: '5' }, h('span', { class: 'sb-num' }, `floor ${pct(fl)}`), ' · every hit above was eligible')));
    return h('div', { class: 'pf-tablewrap pf-kept', id, hidden: true, tabindex: '0', role: 'region', 'aria-label': 'Ranked hits table' }, h('table', { class: 'pf-table pf-table-tight' },
      h('caption', { class: 'st-sr' }, 'Ranked hits with their match scores and the floor'),
      h('thead', null, h('tr', null, ['Rank', 'File', 'Atom', 'Seq', 'Match'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows)));
  }

  function openTrace(A, withTable) {
    const tr = A.el.trace;
    if (!tr) return;
    if (tr.btn.getAttribute('aria-expanded') !== 'true') tr.btn.click();
    if (withTable && tr.keptTable.hidden) { const b = tr.panel.querySelector('.pf-wf-link'); if (b) b.click(); }
    setTimeout(() => tr.box.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }), 30);
  }

  // ---------------------------------------------------------------- after final: milestones, events, compare, announce

  function afterFinal(A) {
    const f = A.final;
    const proofRun = A.by === 'proof';
    if (!proofRun) {
      if (f.status === 'grounded') {
        const files = new Set((f.citations || []).map((c) => c.fileId || c.file));
        say(`Answer grounded in ${plural(files.size, 'file')}. ${(f.text || '').replace(/^\s*-\s+/gm, '').replace(/\s*\[\d{1,3}\]/g, '').replace(/\n/g, ' ')}`);
        if (mark('firstCited')) {
          emit('setup:event', { type: 'first_answer', data: { k: (f.proof?.quotedLines || []).length || (f.citations || []).length, f: files.size, top: f.citations?.[0]?.similarity ?? A.retrieval?.floor?.top ?? null, question: A.question } });
        }
      } else {
        say(f.text || NOT_IN_DATA);
        const best = f.why?.best ?? A.retrieval?.floor?.top ?? null;
        const floor = f.why?.floor ?? A.retrieval?.floor?.min ?? (getState().spec || {}).floor ?? 0.7;
        const closeMiss = best != null && best >= floor - 0.06 && f.status !== 'guard';
        if (mark('firstRefusal')) {
          emit('setup:event', { type: 'refusal', data: { best, floor, question: A.question, closeMiss } });
        } else if (closeMiss && !closeMissSent.has(norm(A.question)) && !sugg.probes.some((p) => norm(p) === norm(A.question))) {
          // A later in-scope question that scored just under the floor is worth one Builder turn ("Close miss",
          // add a file / rephrase), once per question. Ordinary refusals after the first stay quiet.
          closeMissSent.add(norm(A.question));
          emit('setup:event', { type: 'refusal', data: { best, floor, question: A.question, closeMiss } });
        }
        renderComposerMeta();
      }
      maybeCompare(A);
    }
    // the signature slot is released once the last finishing animation has had time to play
    releaseSignature(A, A.fast || reduced() ? 0 : (f.refused ? 400 : 420));
    renderBanner();
  }

  function onError(A, err) {
    A.error = err || {};
    A.stopClock && A.stopClock();
    A.status = 'error';
    A.el.root.dataset.status = 'error';
    A.el.root.removeAttribute('aria-busy');
    A.el.caret.remove();
    commit(A, 'answer:error');
    releaseSignature(A);
    const limited = err && (err.status === 429 || err.code === 'rate_limited');
    const expired = err && (err.code === 'expired' || err.status === 401);
    const box = h('div', { class: 'sb-err', role: 'alert' });
    const retry = () => {
      box.remove();
      A.error = null; A.status = 'pending'; A.final = null; A.steps = []; A.retrieval = null; A.text = ''; A.lineEls = [];
      A.t0 = performance.now(); A.el.root.dataset.status = 'pending'; A.el.root.setAttribute('aria-busy', 'true');
      A.el.body.innerHTML = ''; A.el.body.append(A.el.caret);
      const t = buildTicker(A); A.el.status.innerHTML = ''; A.el.status.append(t); A.el.ticker = t;
      A.el.srcRow.innerHTML = ''; A.el.strip.innerHTML = '';
      for (let i = 0; i < 3; i++) { A.el.srcRow.append(h('span', { class: 'sb-src is-skel', 'aria-hidden': 'true' }, h('i'))); A.el.strip.append(h('div', { class: 'pf-card is-skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))); }
      run(A);
    };
    if (expired) {
      box.append(ico('clock', 15), h('span', null, 'This trial expired, so your bot can’t answer any more.'));
    } else if (limited) {
      let s = Math.max(1, Math.round(err.retryAfter || 10));
      const sEl = h('b', { class: 'sb-num' }, String(s));
      box.append(ico('clock', 15), h('span', null, 'That’s a lot of questions at once. Trying again in ', sEl, 's.'));
      const timer = setInterval(() => { s--; sEl.textContent = String(Math.max(0, s)); if (s <= 0) { clearInterval(timer); if (box.isConnected && !destroyed) retry(); } }, 1000);
      A.el.status.innerHTML = ''; A.el.srcRow.innerHTML = ''; A.el.strip.innerHTML = '';
      A.el.body.append(box);
      if (A.attempts < 4) return;   // the answer (and a Proof Run row waiting on it) resolves when the retry lands
      clearInterval(timer);
    } else {
      box.append(ico('warn', 15), h('span', null, 'Couldn’t reach your bot. Your question wasn’t lost.'),
        h('button', { type: 'button', class: 'sb-btn sb-btn-sm', onclick: retry }, ico('refresh', 13), 'Try again'));
    }
    A.el.status.innerHTML = '';
    A.el.srcRow.innerHTML = '';
    A.el.strip.innerHTML = '';
    A.el.body.append(box);
    if (!limited) say(expired ? 'This trial expired.' : 'Couldn’t reach your bot. Your question wasn’t lost.', 'assert');
    A.resolve(null);
  }

  // ---------------------------------------------------------------- compare (B7)

  function summary(A) {
    const f = A.final || {};
    const lines = String(f.text || '').split('\n').filter((l) => l.trim()).map((l) => ({ text: l.replace(/^\s*-\s+/, '').replace(/\s*\[\d{1,3}\]/g, '').trim(), n: [...l.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])) }));
    return { answerId: A.id, status: A.status, refused: !!f.refused, text: f.text || '', lines,
      citations: (f.citations || []).map((c) => ({ n: c.n, file: c.file, fileId: c.fileId, title: chipTitle(c.file, c.title), match: matchOf(c) })),
      best: f.why?.best ?? A.retrieval?.floor?.top ?? null, version: A.version };
  }
  function maybeCompare(A) {
    if (!A.final) return;
    const key = norm(A.question);
    const prev = [...answers.values()].filter((x) => x !== A && x.by !== 'proof' && x.final && norm(x.question) === key && x.version < A.version).pop();
    if (!prev) return;
    const before = summary(prev), after = summary(A);
    const spec = getState().spec || {};
    const off = filesList().filter((f) => f.id && spec.sources && spec.sources[f.id] === false).map((f) => f.name);
    let text;
    if (after.refused && !before.refused) text = off.length ? `Same question, ${off[0]} off: your bot refused instead of improvising.` : 'Same question, now refused: nothing above the floor, so it would not guess.';
    else if (!after.refused && before.refused) text = 'Same question, now answered: the new sources cover it, with citations.';
    else if (!after.refused && off.length && before.citations.some((c) => off.includes(c.file))) text = `Same question, ${off[0]} off: the answer now comes from the files still on, with its own citations.`;
    else if (!after.refused) text = 'Tone changes the wording around the quotes, never the facts.';
    else text = 'Still refused under the new settings. The fix is more content, not a looser floor.';
    emit('setup:post', { role: 'assistant', text, card: { type: 'compare', data: { question: A.question, before, after, vBefore: prev.version, vAfter: A.version } } });
  }

  function clearReask() { if (reaskEl) { const r = reaskEl; reaskEl = null; r.remove(); } }
  function offerReask(version) {
    const last = [...answers.values()].filter((x) => x.by !== 'proof' && x.final).pop();
    if (!last || last.version >= version) return;
    clearReask();
    const q = last.question;
    reaskEl = h('div', { class: 'sb-reask' },
      h('span', { class: 'sb-reask-v sb-num' }, `v${version} saved`),
      h('button', { type: 'button', class: 'sb-btn sb-btn-sm sb-btn-primary', onclick: () => { clearReask(); startAsk(q, { by: 'chip', label: 'Re-ask' }); } },
        ico('refresh', 13), h('span', null, `Re-ask “${clip(q, 40)}” to compare`)));
    threadEl.append(reaskEl);
    if (!reduced()) anim(reaskEl, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' });
    scrollToEnd();
  }

  store.registerCard('compare', (data, el) => {
    const side = (s, v, tagLabel) => {
      const other = s === data.after ? data.before : data.after;
      const otherWords = new Set(norm(other?.text || '').split(' '));
      const lineEl = (l) => {
        const words = l.text.split(/(\s+)/);
        const frag = words.map((w) => (/\S/.test(w) && s === data.after && !otherWords.has(norm(w)) && norm(w) ? h('mark', { class: 'pf-diff' }, w) : w));
        return h('p', { class: 'pf-cmp-line' }, frag, l.n.map((n) => h('span', { class: 'pf-cmp-n sb-num' }, `[${n}]`)));
      };
      return h('div', { class: `pf-cmp-side${s.refused ? ' is-refused' : ''}` },
        h('div', { class: 'pf-cmp-head' }, h('span', { class: 'pf-cmp-v sb-num' }, `v${v}`), h('span', { class: 'pf-cmp-tag' }, tagLabel),
          s.refused ? h('span', { class: 'pf-cmp-st is-refused' }, ico('shield', 12), 'refusal') : h('span', { class: 'pf-cmp-st' }, ico('shieldCheck', 12), plural(s.citations.length, 'citation'))),
        s.refused ? h('p', { class: 'pf-cmp-line pf-cmp-refusal' }, NOT_IN_DATA) : s.lines.map(lineEl),
        s.citations.length ? h('p', { class: 'pf-cmp-cites sb-num' }, s.citations.map((c) => `[${c.n}] ${c.title}${c.match != null ? ` · match ${c.match}` : ''}`).join('  ')) : null,
        h('button', { type: 'button', class: 'pf-cmp-open', onclick: () => focusAnswer(s.answerId) }, 'Show in thread', ico('arrowRight', 12)));
    };
    const card = h('div', { class: 'pf-cmp', role: 'group', 'aria-label': `Compare v${data.vBefore} and v${data.vAfter}` },
      h('div', { class: 'pf-cmp-title' }, ico('layers', 14), h('span', null, 'Same question, two versions'), h('q', { class: 'pf-cmp-q' }, clip(data.question, 60))),
      h('div', { class: 'pf-cmp-grid' }, side(data.before || {}, data.vBefore, 'before'), h('span', { class: 'pf-cmp-arrow', 'aria-hidden': 'true' }, ico('arrowRight', 16)), side(data.after || {}, data.vAfter, 'after')));
    el.append(card);
    if (!reduced()) card.querySelectorAll('.pf-cmp-side').forEach((s, i) => anim(s, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 80 + i * 80, easing: 'out' }));
    return { update() {}, destroy() {} };
  });

  function focusAnswer(answerId) {
    const A = answers.get(answerId);
    if (!A || !A.el.root.isConnected) return;
    const botHidden = dom.bot && getComputedStyle(dom.bot).visibility === 'hidden';
    if (botHidden) {
      if (store.listenerCount && store.listenerCount('tab:show')) emit('tab:show', { tab: 'bot' });
      else {
        const c = (A.final?.citations || [])[0];
        if (c) { openDrawer({ fileId: c.fileId, atomId: c.atomId, seq: c.seq, answerId: A.id, n: c.n }, document.activeElement); return; }
      }
    }
    if (A.group && !A.group.open) toggleGroup(A.group, true);
    requestAnimationFrame(() => {
      A.el.root.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      A.el.root.classList.remove('is-flash'); void A.el.root.offsetWidth; A.el.root.classList.add('is-flash');
      setTimeout(() => A.el.root.classList.remove('is-flash'), 1300);
    });
  }

  // ================================================================== ProofDrawer

  let drawer = null;   // {root, panel, data, invoker, inerted:[]}

  function drawerMode() { return isMobile() ? 'sheet' : isDock() ? 'dock' : 'overlay'; }

  async function openDrawer(d, invoker) {
    if (!d || !d.fileId) return;
    closePopAll();
    const A = d.answerId ? answers.get(d.answerId) : null;
    // the quote this receipt is for: an explicit [n] (and line), else whatever this answer quoted from that atom
    let quote = null;
    if (A?.final && d.n != null) {
      const chip = A.el.body.querySelector(`.pf-cite[data-n="${d.n}"]${d.line != null ? `[data-line="${d.line}"]` : ''}`) || A.el.body.querySelector(`.pf-cite[data-n="${d.n}"]`);
      quote = chip ? citeData(A, chip) : null;
    }
    if (!quote && A?.final) {
      const ql = (A.final.proof?.quotedLines || []).find((x) => x.atomId === d.atomId);
      if (ql) { const cit = (A.final.citations || []).find((c) => c.n === ql.n); const q = (cit?.quotes || []).find((x) => x.text === ql.text); quote = { n: ql.n, text: ql.text, offset: q?.offset ?? ql.offset, derived: !!q?.derived, atomId: ql.atomId, fileId: ql.fileId, file: ql.file, cit }; }
    }
    const hit = A?.retrieval?.hits?.find((x) => x.atomId === d.atomId) || null;
    const meta = fileMeta(d.fileId, hit?.file || quote?.file || '');
    const data = { ...d, A, quote, hit, file: hit?.file || quote?.file || meta.name, kind: meta.kind, hue: meta.hue,
      locator: hit?.locator || quote?.locator || (d.seq != null ? `atom #${d.seq + 1}` : ''), match: hit ? fmtMatch(hit, floorOfA(A)) : quote?.match ?? null, raw: hit ? rawMatch(hit) : quote?.hit ? rawMatch(quote.hit) : null,
      floor: A?.final?.proof?.floor ?? A?.retrieval?.floor?.min ?? (getState().spec || {}).floor ?? 0.7 };
    const reuse = drawer && drawer.root.isConnected;
    if (reuse) { drawer.data = data; fillDrawer(data); return; }
    const mode = drawerMode();
    const titleId = uid('pf-dt');
    const panel = h('section', { class: 'pf-dpanel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' });
    const scrim = h('div', { class: 'pf-scrim', 'aria-hidden': 'true', onclick: () => closeDrawer() });
    const root = h('div', { class: 'pf-drawer', dataset: { mode } }, mode === 'dock' ? null : scrim, panel);
    drawer = { root, panel, scrim, data, invoker: invoker || document.activeElement, titleId, inerted: [] };
    const name = d.answerId && d.n != null ? `proof-${d.answerId}-${d.n}`.replace(/[^a-zA-Z0-9_-]/g, '') : null;
    const chipEl = invoker && invoker.classList && invoker.classList.contains('pf-cite') ? invoker : null;
    if (name && chipEl) chipEl.style.viewTransitionName = name;
    const render = () => {
      if (chipEl) chipEl.style.viewTransitionName = '';
      dom.drawer.append(root);
      fillDrawer(data);
      const head = panel.querySelector('.pf-dhead');
      if (head && name) head.style.viewTransitionName = name;
      setState({ ui: { ...getState().ui, drawer: { fileId: d.fileId, atomId: d.atomId ?? null, seq: d.seq ?? null, answerId: d.answerId ?? null, n: d.n ?? null } } }, 'drawer:open');
      setInert(true);
      // focus moves into the dialog (its title) as soon as it exists, so keyboard users land inside
      const t = panel.querySelector(`#${titleId}`);
      (t || panel).focus({ preventScroll: true });
    };
    const head = () => panel.querySelector('.pf-dhead');
    const p = name && chipEl && mode !== 'sheet'
      ? motion.viewTransition(render, { name, el: chipEl, target: head })
      : Promise.resolve(render());
    if (mode !== 'dock' && !reduced()) {
      requestAnimationFrame(() => {
        anim(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
        anim(panel, mode === 'sheet' ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ transform: 'translateX(24px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'out' });
      });
    }
    Promise.resolve(p).then(() => { const hd = head(); if (hd) hd.style.viewTransitionName = ''; });
    requestAnimationFrame(() => { if (drawer && drawer.panel === panel && !panel.contains(document.activeElement)) { const t = panel.querySelector(`#${titleId}`); (t || panel).focus({ preventScroll: true }); } });
    panel.addEventListener('keydown', onDrawerKey);
    document.addEventListener('pointerdown', onOutside, true);
    if (mode === 'sheet') wireSheetDrag(panel);
  }

  function onOutside(e) {
    if (!drawer) return;
    const t = e.target;
    if (drawer.panel.contains(t)) return;
    if (t.closest && (t.closest('#co-modal-slot') || t.closest('#st-overlay-slot') || t.closest('.st-drawer'))) return;
    if (drawer.root.dataset.mode === 'dock') closeDrawer({ refocus: false });
  }

  function onDrawerKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const f = [...drawer.panel.querySelectorAll('button:not([disabled]), [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer.panel || !drawer.panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function setInert(on) {
    if (!drawer) return;
    if (on) {
      const ids = ['st-header', 'st-spine', 'st-setup', 'st-bot', 'st-tabs'];
      drawer.inerted = ids.map((id) => document.getElementById(id)).filter((el) => el && !el.inert);
      drawer.inerted.forEach((el) => { el.inert = true; });
    } else {
      drawer.inerted.forEach((el) => { el.inert = false; });
      drawer.inerted = [];
    }
  }

  function closeDrawer({ refocus = true } = {}) {
    if (!drawer) return;
    const dr = drawer; drawer = null;
    dr.panel.removeEventListener('keydown', onDrawerKey);
    document.removeEventListener('pointerdown', onOutside, true);
    dr.inerted.forEach((el) => { el.inert = false; });
    setState({ ui: { ...getState().ui, drawer: null } }, 'drawer:close');
    const mode = dr.root.dataset.mode;
    const finish = () => dr.root.remove();
    if (reduced() || mode === 'dock') finish();
    else {
      anim(dr.scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
      anim(dr.panel, mode === 'sheet' ? [{ transform: 'none' }, { transform: 'translateY(100%)' }] : [{ transform: 'none', opacity: 1 }, { transform: 'translateX(24px)', opacity: 0 }], { duration: 240, easing: 'inOut', fill: 'forwards' }).finished.then(finish);
    }
    if (refocus) {
      const inv = dr.invoker;
      const target = inv && inv.isConnected ? inv : (dr.data.A?.el.body.querySelector(`.pf-cite[data-n="${dr.data.n}"]`) || null);
      if (target && target.focus) setTimeout(() => target.focus({ preventScroll: false }), 0);
    }
  }

  function wireSheetDrag(panel) {
    const grip = panel.querySelector('.pf-grip');
    if (!grip) return;
    let y0 = null, dy = 0;
    grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; dy = 0; grip.setPointerCapture(e.pointerId); panel.style.transition = 'none'; });
    grip.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); panel.style.transform = `translateY(${dy}px)`; });
    const end = () => {
      if (y0 == null) return; y0 = null;
      if (dy > 120) closeDrawer();
      else { panel.style.transition = ''; panel.style.transform = ''; }
    };
    grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  }

  function fillDrawer(data) {
    if (!drawer) return;
    const panel = drawer.panel;
    const m = data.match;
    const ring = h('span', { class: 'pf-ring', style: { '--p': `${m ?? 0}%` }, 'aria-hidden': 'true' }, h('span', { class: 'sb-num' }, m == null ? 'kw' : String(m)));
    const atomLabel = data.atomId || (data.seq != null ? `#${data.seq}` : '');
    const copyBtn = h('button', { type: 'button', class: 'pf-copy', 'aria-label': 'Copy atom id', onclick: (e) => copyText(atomLabel, e.currentTarget) }, ico('copy', 13));
    const titleBits = h('div', { class: 'pf-dtitle' },
      h('h2', { id: drawer.titleId, tabindex: '-1' }, h('span', { class: 'pf-dico', style: { '--hue': hueVar(data.hue) } }, fico(data.kind, 16)), h('span', { class: 'pf-dname' }, mid(data.file, isMobile() ? 26 : 34))),
      h('p', { class: 'pf-dsub sb-num' }, [data.locator, m == null ? 'keyword match' : `match ${m}`, `floor ${pct(data.floor)}`].filter(Boolean).join(' · ')),
      atomLabel ? h('p', { class: 'pf-did sb-num' }, h('span', null, `atom ${atomLabel}`), copyBtn) : null);
    const close = h('button', { type: 'button', class: 'pf-close', 'aria-label': 'Close receipt', onclick: () => closeDrawer() }, ico('close', 18));
    const head = h('header', { class: 'pf-dhead' }, ring, titleBits, close);
    const body = h('div', { class: 'pf-dbody', tabindex: '0', role: 'region', 'aria-label': 'Passage' }, drawerSkeleton());
    const foot = h('footer', { class: 'pf-dfoot' });
    panel.innerHTML = '';
    panel.append(h('span', { class: 'pf-grip', 'aria-hidden': 'true' }), head, body, foot);
    if (m != null && !reduced()) anim(ring, [{ '--p': '0%' }, { '--p': `${m}%` }], { duration: 700, easing: 'out', essential: false });
    renderDrawerPassage(data, body, foot);
  }

  function drawerSkeleton() { return h('div', { class: 'pf-dskel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')); }

  async function renderDrawerPassage(data, body, foot) {
    const q = data.quote;
    let r = null, err = null;
    try { r = data.seq != null ? await loadAround(data.fileId, data.seq, 1) : null; } catch (e) { err = e; }
    if (!drawer || drawer.data !== data) return;
    body.innerHTML = '';
    if (q) body.append(h('p', { class: 'pf-dquote' }, h('span', { class: 'pf-pop-n sb-num' }, String(q.n)), h('span', null, 'Quoted verbatim in your bot’s answer'), q.derived ? h('span', { class: 'pf-badge is-derived' }, 'from a table row') : h('span', { class: 'pf-badge' }, ico('check', 11), 'Verbatim')));
    const items = r?.items || [];
    let span = null;
    if (!items.length) {
      if (err) body.append(h('div', { class: 'sb-err' }, ico('warn', 15), h('span', null, 'Couldn’t load this passage.'), h('button', { type: 'button', class: 'sb-btn sb-btn-sm', onclick: () => { body.innerHTML = ''; body.append(drawerSkeleton()); renderDrawerPassage(data, body, foot); } }, ico('refresh', 13), 'Retry')));
      const fallback = q?.text || data.hit?.excerpt || '';
      if (fallback) body.append(h('div', { class: 'pf-atom is-main' }, h('span', { class: 'pf-atom-seq sb-num' }, data.seq != null ? `atom #${data.seq + 1}` : 'atom'), h('p', null, h('mark', { class: 'pf-mark is-on' }, fallback))));
    } else {
      for (const it of items) {
        const main = it.seq === data.seq;
        const p = h('p', { class: 'pf-atom-text' });
        if (main && q) {
          const t = it.text || '';
          const qt = String(q.text || '').replace(/…$/, '');
          let s = null, e = null;
          if (Array.isArray(q.offset) && t.slice(q.offset[0], q.offset[1]) === qt.slice(0, q.offset[1] - q.offset[0]) && q.offset[1] <= t.length) { [s, e] = q.offset; }
          else if (qt && t.indexOf(qt) >= 0) { s = t.indexOf(qt); e = s + qt.length; }
          if (q.derived || s == null) {
            p.append(h('mark', { class: 'pf-mark' }, t));
            span = q.derived ? 'table row' : null;
          } else {
            p.append(t.slice(0, s), h('mark', { class: 'pf-mark' }, t.slice(s, e)), t.slice(e));
            span = `chars ${s}–${e} of the atom’s text`;
          }
        } else p.textContent = it.text || '';
        const crumb = it.meta?.breadcrumb ? h('span', { class: 'pf-atom-crumb' }, clip(it.meta.breadcrumb.split(' > ').slice(-1)[0], 40)) : null;
        body.append(h('div', { class: `pf-atom${main ? ' is-main' : ' is-ctx'}`, dataset: { seq: String(it.seq) } },
          h('span', { class: 'pf-atom-seq sb-num' }, `atom #${it.seq + 1}${r.atoms ? ` of ${r.atoms}` : ''}`, crumb ? ' · ' : '', crumb),
          p));
      }
      const mk = body.querySelector('.is-main mark');
      if (mk) { if (reduced()) mk.style.backgroundSize = '100% 100%'; else setTimeout(() => motion.sweep(mk), 120); }
      const mainEl = body.querySelector('.is-main');
      if (mainEl) requestAnimationFrame(() => mainEl.scrollIntoView({ block: 'center', behavior: 'auto' }));
    }
    foot.innerHTML = '';
    foot.append(
      h('p', { class: 'pf-dspan sb-num' }, span || (q ? 'quoted line' : data.seq != null ? `atom #${data.seq + 1}` : '')),
      h('div', { class: 'pf-dacts' },
        h('button', { type: 'button', class: 'sb-btn sb-btn-sm', onclick: (e) => expandSource(data, body, e.currentTarget) }, ico('file', 13), 'Expand source'),
        h('button', { type: 'button', class: 'sb-btn sb-btn-sm sb-btn-primary', onclick: () => askAboutPassage(data) }, ico('chat', 13), 'Ask about this passage')));
  }

  async function expandSource(data, body, btn) {
    btn.disabled = true;
    const seq = data.seq ?? 0;
    let r = null;
    try { r = seq < 20 ? await api.fileAtoms(data.fileId, { limit: 20 }) : await api.fileAtoms(data.fileId, { around: seq, span: 5 }); }
    catch { btn.disabled = false; toastWarn('Couldn’t load the source. Try again.'); return; }
    if (!drawer || drawer.data !== data) return;
    const list = h('ol', { class: 'pf-src-list', 'aria-label': `${data.file}: atoms` }, (r?.items || []).map((it) => h('li', { class: it.seq === data.seq ? 'is-main' : '', dataset: { seq: String(it.seq) } },
      h('span', { class: 'pf-atom-seq sb-num' }, `#${it.seq + 1}`), h('span', null, it.text || ''))));
    body.innerHTML = '';
    body.append(h('p', { class: 'pf-src-head' }, `${data.file} · ${plural(r?.atoms || (r?.items || []).length, 'atom')}${(r?.items || []).length < (r?.atoms || 0) ? ` · showing ${(r.items || []).length}` : ''}`), list);
    btn.textContent = '';
    btn.append(ico('arrowUp', 13), 'Back to the passage');
    btn.disabled = false;
    btn.onclick = () => { body.innerHTML = ''; body.append(drawerSkeleton()); renderDrawerPassage(data, body, btn.closest('.pf-dfoot')); };
    const cur = list.querySelector('.is-main');
    if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: 'center', behavior: 'auto' }));
  }

  function askAboutPassage(data) {
    const q = data.quote?.text || data.hit?.excerpt || '';
    const words = q.split(/\s+/).slice(0, 8).join(' ');
    closeDrawer({ refocus: false });
    setComposer(`Tell me more about “${words}${q.split(/\s+/).length > 8 ? '…' : ''}”`);
  }

  function closePopAll() { if (openChip) { const A = answers.get(openChip.closest('.sb-answer')?.id); if (A) closePop(A); } }

  function copyText(text, btn) {
    const done = () => { say('Copied to the clipboard.'); if (btn) { btn.classList.add('is-done'); setTimeout(() => btn.classList.remove('is-done'), 1200); } };
    try { navigator.clipboard.writeText(text).then(done, done); } catch { done(); }
  }
  function toastWarn(text) { emit('toast', { kind: 'warn', text }); }

  sub('drawer:open', (d) => openDrawer(d, document.activeElement));
  sub('change:ui', ({ value, prev }) => {
    if (value.view !== prev.view) onViewChange(value.view);
    if (!value.drawer && prev.drawer && drawer) closeDrawer({ refocus: false });
  });
  const mqDock = matchMedia('(min-width: 1440px)'), mqMob = matchMedia('(max-width: 899px)');
  const onMode = () => {
    if (drawer) {
      const mode = drawerMode();
      drawer.root.dataset.mode = mode;
      if (mode === 'dock') drawer.scrim.remove(); else if (!drawer.scrim.isConnected) drawer.root.prepend(drawer.scrim);
    }
    renderSuggestions();
    renderComposerMeta();
  };
  mqDock.addEventListener?.('change', onMode); mqMob.addEventListener?.('change', onMode);

  function onViewChange(view) {
    unlinkThread();
    if (view !== 'proof' || reduced()) return;
    // proof layers arrive with a short stagger on the answers in view
    const pane = dom.thread.getBoundingClientRect();
    const visible = [...threadEl.querySelectorAll('.sb-answer')].filter((a) => { const r = a.getBoundingClientRect(); return r.bottom > pane.top && r.top < pane.bottom; });
    let i = 0;
    for (const a of visible) for (const el of a.querySelectorAll(':scope .pf-only')) {
      anim(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: Math.min(i++, 8) * 50, easing: 'out' });
    }
    if (openChip) { const A = answers.get(openChip.closest('.sb-answer')?.id); const c = A && citeData(A, openChip); if (c) requestAnimationFrame(() => requestAnimationFrame(() => linkThread(A, openChip, c))); }
  }

  // ================================================================== Proof Run (B8)

  let prun = null;   // {id, rows, status, mini, group, inst}

  function proofScore(rows) {
    const ans = rows.filter((r) => r.expect === 'answer');
    const ref = rows.filter((r) => r.expect === 'refuse');
    const unsupported = ans.reduce((s, r) => s + (r.unsupported || 0), 0);
    const claims = ans.reduce((s, r) => s + (r.claims || 0), 0);
    const verified = ans.reduce((s, r) => s + (r.verified || 0), 0);
    return { answered: ans.filter((r) => r.status === 'pass').length, total: ans.length, refused: ref.filter((r) => r.status === 'pass').length, probes: ref.length,
      unsupported, verifiedPct: claims ? Math.round((100 * verified) / claims) : 100 };
  }
  const isDone = (r) => r.status === 'pass' || r.status === 'fail';

  async function runProof({ mini = false } = {}) {
    if (prun && prun.status === 'running') { if (prun.inst?.el) prun.inst.el.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }); return; }
    let qs = null;
    try { qs = await api.questions(); } catch { qs = null; }
    let proofQs = (qs?.proof || []).map((p) => ({ q: p.q, expect: 'answer', file: p.file }));
    let probes = (qs?.probes || []).map((p) => ({ q: p.q, expect: 'refuse', kind: p.kind }));
    if (mini) { proofQs = proofQs.slice(0, 3); probes = probes.slice(0, 1); }
    if (!proofQs.length) {
      emit('setup:post', { role: 'assistant', text: 'The Proof Run needs at least one file that has finished learning. As soon as one is Ready I can write test questions from it.', chips: [
        { id: 'pr_add', label: 'Add files', action: { type: 'request_upload' }, local: true },
        { id: 'pr_samples', label: 'Use sample files', action: { type: 'attach_samples', set: 'lumen-bikes' }, local: true },
      ] });
      return;
    }
    const rows = [...proofQs, ...probes].map((x, i) => ({ i, q: x.q, expect: x.expect, file: x.file || null, status: 'queued', answerId: null, match: null, citations: 0, unsupported: 0, claims: 0, verified: 0, best: null }));
    prun = { id: uid('prun'), rows, status: 'running', mini, startedAt: Date.now(), inst: null, group: null };
    setState({ proof: { status: 'running', rows: rows.map((r) => ({ ...r })), score: null } }, 'proof:start');
    prun.group = buildGroup(prun);
    emit('setup:post', { role: 'assistant', text: `Proof Run: ${plural(proofQs.length, 'question')} written from your files, plus ${probes.length} it should refuse. Two at a time; every row links to its receipt.`,
      card: { type: 'scorecard', data: { runId: prun.id, rows: rows.map((r) => ({ ...r })), score: null, status: 'running' } } });
    say(`Proof Run started: ${rows.length} questions.`);
    const my = prun;
    let next = 0;
    const worker = async () => {
      while (next < rows.length && my === prun) {
        const row = rows[next++];
        row.status = 'running';
        progress(my);
        const A = startAsk(row.q, { by: 'proof', label: 'Proof Run', group: my.group });
        row.answerId = A ? A.id : null;
        const fin = A ? await A.promise : null;
        evaluate(row, fin);
        progress(my);
      }
    };
    await Promise.all([worker(), worker()]);
    if (my !== prun) return;
    my.status = 'done';
    const score = proofScore(rows);
    setState({ proof: { status: 'done', rows: rows.map((r) => ({ ...r })), score } }, 'proof:done');
    progress(my, true);
    mark('proofRun');
    emit('proof:done', { score });
    const pass = score.answered === score.total && score.refused === score.probes && score.unsupported === 0;
    say(pass ? `Proof Run passed: ${score.answered} of ${score.total} answered with citations, ${score.refused} of ${score.probes} refused.` : `${score.answered + score.refused} of ${score.total + score.probes} passed.`);
  }

  function evaluate(row, fin) {
    if (!fin) { row.status = 'fail'; row.reason = 'no answer'; return; }
    if (row.expect === 'answer') {
      row.citations = (fin.citations || []).length;
      row.match = matchOf(fin.citations?.[0] || {}) ?? null;
      row.unsupported = fin.proof?.unsupported || 0;
      row.claims = fin.proof?.verified?.claims || 0;
      row.verified = fin.proof?.verified?.verified || 0;
      row.status = fin.status === 'grounded' && (fin.proof?.unsupported || 0) === 0 ? 'pass' : 'fail';
      row.reason = row.status === 'pass' ? null : fin.refused ? 'refused' : 'unsupported claim';
    } else {
      row.best = fin.why?.best ?? null;
      row.status = fin.refused === true ? 'pass' : 'fail';
      row.reason = row.status === 'pass' ? null : 'answered an off-topic question';
    }
  }

  function progress(run, final = false) {
    const rows = run.rows.map((r) => ({ ...r }));
    if (!final) setState({ proof: { ...getState().proof, rows } }, 'proof:progress');
    emit('proof:progress', { rows });
    if (run.inst) run.inst.update({ runId: run.id, rows });
    updateGroup(run);
  }

  // in-thread group: Proof Run answers stay collapsed under one row
  function buildGroup(run) {
    const bodyId = uid('prun-b');
    const dots = h('span', { class: 'sb-prun-dots', 'aria-hidden': 'true' }, run.rows.map((r) => h('i', { dataset: { expect: r.expect } })));
    const label = h('span', { class: 'sb-prun-label' }, 'Proof Run');
    const count = h('span', { class: 'sb-prun-count sb-num' }, `0/${run.rows.length}`);
    const btn = h('button', { type: 'button', class: 'sb-prun-head', 'aria-expanded': 'false', 'aria-controls': bodyId }, ico('flask', 15), label, dots, count, h('span', { class: 'pf-sum-chev' }, ico('chevronDown', 14)));
    const body = h('div', { class: 'sb-prun-body', id: bodyId, hidden: true });
    const root = h('section', { class: 'sb-prun', 'aria-label': 'Proof Run answers' }, btn, body);
    const g = { root, btn, body, dots, count, label, open: false };
    btn.addEventListener('click', () => toggleGroup(g, !g.open));
    dropGhost(); clearReask();
    threadEl.append(root);
    if (!reduced()) anim(root, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'out' });
    scrollToEnd(true);
    pruneOld();
    return g;
  }
  function toggleGroup(g, open) {
    g.open = open;
    g.btn.setAttribute('aria-expanded', String(open));
    g.body.hidden = !open;
    if (open && !reduced()) anim(g.body, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' });
  }
  function updateGroup(run) {
    const g = run.group;
    if (!g) return;
    const done = run.rows.filter(isDone).length;
    const passed = run.rows.filter((r) => r.status === 'pass').length;
    g.count.textContent = run.status === 'done' ? `${passed}/${run.rows.length} passed` : `${done}/${run.rows.length}`;
    g.label.textContent = run.status === 'done' ? 'Proof Run' : 'Proof Run · running';
    g.root.dataset.state = run.status;
    [...g.dots.children].forEach((d, i) => { d.dataset.state = run.rows[i].status; });
  }

  store.registerCard('scorecard', (data, el) => {
    const run = prun && (!data.runId || data.runId === prun.id) ? prun : null;
    const rowsOf = (d) => (run ? run.rows : (d && d.rows) || []);
    const title = h('div', { class: 'pf-sc-title' }, ico('flask', 16), h('span', null, 'Proof Run'), h('span', { class: 'pf-sc-state' }));
    const bar = h('div', { class: 'pf-sc-bar', 'aria-hidden': 'true' }, h('i'));
    const list = h('ol', { class: 'pf-sc-rows', 'aria-label': 'Proof Run questions' });
    const totals = h('dl', { class: 'pf-sc-totals' });
    const stats = {};
    const stat = (key, label, suffix) => {
      const num = h('b', { class: 'sb-num', dataset: { value: '0' } }, '0');
      const tail = h('span', { class: 'pf-sc-of sb-num' }, suffix || '');
      const box = h('div', { class: 'pf-sc-stat', dataset: { key } }, h('dt', null, label), h('dd', null, num, tail));
      stats[key] = { num, tail, box };
      totals.append(box);
    };
    stat('answered', 'Answered with citations', '/0');
    stat('refused', 'Refused off-topic', '/0');
    stat('unsupported', 'Unsupported claims', '');
    stat('verified', 'Verified claims', '%');
    const again = h('button', { type: 'button', class: 'sb-btn sb-btn-sm', hidden: true, onclick: () => runProof({ mini: run?.mini }) }, ico('refresh', 13), 'Run again');
    const card = h('div', { class: 'pf-sc', role: 'group', 'aria-label': 'Proof Run scorecard' }, title, bar, list, totals, h('div', { class: 'pf-sc-actions' }, again));
    el.append(card);
    const rowEls = new Map();
    let flashed = false;
    let lastRendered = '';
    function rowEl(r) {
      let li = rowEls.get(r.i);
      if (!li) {
        const btn = h('button', { type: 'button', class: 'pf-sc-row', onclick: () => { const rr = rowsOf()[r.i]; if (rr?.answerId) focusAnswer(rr.answerId); } },
          h('span', { class: 'pf-sc-ico', 'aria-hidden': 'true' }),
          h('span', { class: 'pf-sc-txt' }, h('span', { class: 'pf-sc-q' }, r.q), h('span', { class: 'pf-sc-meta sb-num' })),
          h('span', { class: 'pf-sc-go', 'aria-hidden': 'true' }, ico('chevronRight', 13)));
        li = h('li', { dataset: { expect: r.expect } }, btn);
        rowEls.set(r.i, li);
        list.append(li);
        if (!reduced()) anim(li, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: (r.i % 11) * 60, easing: 'out' });
      }
      return li;
    }
    function paintRow(r) {
      const li = rowEl(r);
      const btn = li.firstChild;
      const icoEl = btn.querySelector('.pf-sc-ico');
      const meta = btn.querySelector('.pf-sc-meta');
      const prev = li.dataset.state;
      li.dataset.state = r.status;
      if (prev === r.status && li.dataset.meta === JSON.stringify([r.match, r.citations, r.reason])) return;
      li.dataset.meta = JSON.stringify([r.match, r.citations, r.reason]);
      icoEl.innerHTML = '';
      if (r.status === 'running') icoEl.append(h('span', { class: 'pf-spin' }));
      else if (r.status === 'pass') icoEl.append(ico(r.expect === 'refuse' ? 'shieldCheck' : 'check', 14));
      else if (r.status === 'fail') icoEl.append(ico('x', 14));
      else icoEl.append(h('i', { class: 'pf-sc-wait' }));
      meta.innerHTML = '';
      let srText = '';
      if (r.status === 'pass' && r.expect === 'answer') { meta.append(r.match != null ? `match ${r.match}` : 'keyword match', ' · ', `[${r.citations}] ${r.citations === 1 ? 'citation' : 'citations'}`); srText = 'passed'; }
      else if (r.status === 'pass') { meta.append('refused ', ico('check', 11)); srText = 'refused as expected'; }
      else if (r.status === 'fail') { meta.append(h('span', { class: 'pf-sc-why' }, r.reason || 'failed'), ' · ', h('span', { class: 'pf-sc-open' }, 'Open')); srText = `failed: ${r.reason || ''}`; }
      else if (r.status === 'running') { meta.append(r.expect === 'refuse' ? 'should refuse' : 'asking…'); srText = 'running'; }
      else { meta.append(r.expect === 'refuse' ? 'should refuse' : 'queued'); srText = 'queued'; }
      btn.setAttribute('aria-label', `${r.q} · ${srText}`);
      if ((r.status === 'pass' || r.status === 'fail') && prev && prev !== r.status && !reduced()) {
        anim(icoEl, [{ transform: 'scale(.6)' }, { transform: 'scale(1.08)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 220, easing: 'spring' });
      }
    }
    function update(d) {
      const rows = rowsOf(d);
      const sig = JSON.stringify(rows.map((r) => [r.status, r.match, r.citations]));
      if (sig === lastRendered) return;
      lastRendered = sig;
      rows.forEach(paintRow);
      const done = rows.filter(isDone).length;
      const allDone = rows.length && done === rows.length;
      const sc = proofScore(rows);
      bar.firstChild.style.transform = `scaleX(${rows.length ? done / rows.length : 0})`;
      bar.hidden = !!allDone;
      const pass = allDone && sc.answered === sc.total && sc.refused === sc.probes && sc.unsupported === 0;
      const state = title.querySelector('.pf-sc-state');
      state.textContent = allDone ? (pass ? 'Passed' : `${sc.answered + sc.refused} of ${sc.total + sc.probes} passed`) : `Running · ${done} of ${rows.length}`;
      card.dataset.state = allDone ? (pass ? 'pass' : 'warn') : 'running';
      stats.answered.tail.textContent = `/${sc.total}`;
      stats.refused.tail.textContent = `/${sc.probes}`;
      motion.ticker(stats.answered.num, sc.answered, { ms: 700 });
      motion.ticker(stats.refused.num, sc.refused, { ms: 700 });
      motion.ticker(stats.unsupported.num, sc.unsupported, { ms: 700 });
      motion.ticker(stats.verified.num, sc.verifiedPct, { ms: 700 });
      stats.unsupported.box.classList.toggle('is-bad', sc.unsupported > 0);
      again.hidden = !allDone;
      if (allDone && !flashed && sc.unsupported === 0) {
        flashed = true;
        stats.unsupported.box.classList.add('is-good');
        if (!reduced()) anim(stats.unsupported.box, [{ boxShadow: '0 0 0 0 var(--good-soft)' }, { boxShadow: '0 0 0 6px var(--good-soft)' }, { boxShadow: '0 0 0 0 var(--good-soft)' }], { duration: 700, essential: false });
      }
    }
    update(data);
    const inst = { el: card, update, destroy() {} };
    if (run) run.inst = inst;
    return inst;
  });

  // ================================================================== banner (#st-bot-banner)

  let bannerKey = '';
  let reaskTimer = 0;
  function renderBanner() {
    const el = dom.banner;
    if (!el) return;
    const r = readiness();
    let kind = null, content = null;
    if (r.ready.length && r.busy.length) {
      kind = 'partial';
      content = [ico('layers', 14), h('span', null, h('b', null, 'Partial: '), h('span', { class: 'sb-num' }, String(r.ready.length)), ' of ', h('span', { class: 'sb-num' }, String(r.total)), ' files ready · answers improve as more finish'),
        h('span', { class: 'sb-banner-seg', 'aria-hidden': 'true' }, r.list.map((f) => h('i', { class: f.phase === 'ready' ? 'is-ready' : f.phase === 'failed' ? 'is-failed' : '', style: { '--hue': hueVar(f.hue) } })))];
    } else if (!r.busy.length && r.ready.length && lastPartialQ && !partialOffered) {
      kind = 'reask';
      const q = lastPartialQ.question;
      content = [ico('checkCircle', 14), h('span', null, `All ${plural(r.ready.length, 'file')} ready.`),
        h('button', { type: 'button', class: 'sb-btn sb-btn-sm sb-btn-primary', onclick: () => { partialOffered = true; lastPartialQ = null; renderBanner(); startAsk(q, { by: 'chip', label: 'Asked again' }); } }, ico('refresh', 13), h('span', null, `Ask again: “${clip(q, 36)}”`)),
        h('button', { type: 'button', class: 'sb-banner-x', 'aria-label': 'Dismiss', onclick: () => { partialOffered = true; renderBanner(); } }, ico('close', 14))];
    } else if (!r.busy.length && r.failed.length && r.ready.length) {
      kind = 'warn';
      content = [ico('warn', 14), h('span', null, 'Answering from ', h('span', { class: 'sb-num' }, String(r.ready.length)), ' of ', h('span', { class: 'sb-num' }, String(r.total)), ` files · ${r.failed.length} ${r.failed.length === 1 ? 'file needs' : 'files need'} attention`)];
    }
    const key = kind ? `${kind}:${r.ready.length}/${r.total}/${r.failed.length}:${lastPartialQ?.question || ''}` : '';
    if (key === bannerKey) return;
    const wasEmpty = !bannerKey;
    bannerKey = key;
    el.innerHTML = '';
    if (!kind) { el.hidden = true; return; }
    el.hidden = false;
    const bar = h('div', { class: `sb-banner is-${kind}` }, content);
    el.append(bar);
    clearTimeout(reaskTimer);
    // the re-ask offer is a one-time nudge: it retires itself after 20 s (or on the next question, see startAsk)
    if (kind === 'reask') reaskTimer = setTimeout(() => { if (lastPartialQ && !partialOffered) { partialOffered = true; lastPartialQ = null; renderBanner(); } }, 20000);
    if (wasEmpty && !reduced()) anim(bar, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'out' });
  }

  // ================================================================== suggestions (#sb-suggest-slot)

  let sugg = { starters: [], probes: [], at: 0 };
  let suggFails = 0;
  let probeIdx = 0;
  let suggTimer = 0;
  let suggSig = '';
  const asked = new Set();
  // Not a resettable debounce: frequent file-state updates must never starve the fetch. The earliest due time wins,
  // one request is in flight at a time, and a request asked for mid-flight runs once more afterwards.
  let suggDue = 0, suggInflight = false, suggAgain = false, suggEmpty = 0;
  function refreshSuggestions(delay = 500) {
    const due = Date.now() + delay;
    if (suggTimer && suggDue <= due) return;
    clearTimeout(suggTimer);
    suggDue = due;
    suggTimer = setTimeout(fetchSuggestions, delay);
  }
  async function fetchSuggestions() {
    suggTimer = 0;
    if (destroyed) return;
    if (!getState().trial?.id || !readiness().ready.length) { renderSuggestions(); return; }
    if (suggInflight) { suggAgain = true; return; }
    suggInflight = true;
    let retry = 0;
    try {
      const r = await api.questions();
      if (r) sugg = { starters: (r.starters || []).map((x) => x.q).filter(Boolean), probes: (r.probes || []).map((x) => x.q).filter(Boolean),
        proof: (r.proof || []).map((x) => x.q).filter(Boolean), at: Date.now() };
      suggFails = 0;
      // the server validates starters against Ready files; right after the first file lands it may have none yet
      if (!sugg.starters.length && readiness().ready.length && suggEmpty < 8) { suggEmpty++; retry = 2000; }
      else if (sugg.starters.length) suggEmpty = 0;
    } catch (err) {
      suggFails++;
      if (suggFails < 6) retry = Math.min(15000, err?.retryAfter ? err.retryAfter * 1000 : 1500 * 2 ** suggFails);
    } finally {
      suggInflight = false;
    }
    renderSuggestions();
    if (suggAgain) { suggAgain = false; refreshSuggestions(300); }
    else if (retry) refreshSuggestions(retry);
  }

  function renderSuggestions() {
    const el = dom.suggest;
    if (!el) return;
    const r = readiness();
    const ready = r.ready.length > 0;
    // 3 starters whenever possible: the server's starters, padded with the questions it validated per Ready file
    // (file summaries) and its Proof Run questions (also validated against Ready files). Never a skeleton chip.
    const starters = [];
    const seen = new Set();
    for (const q of [...sugg.starters, ...summaryStarters(), ...(sugg.proof || [])]) {
      const k = norm(q);
      if (!q || !k || seen.has(k)) continue;
      seen.add(k); starters.push(q);
      if (starters.length === 3) break;
    }
    const probes = sugg.probes.length ? sugg.probes : ["What's the weather in Paris today?"];
    const probe = probes[probeIdx % probes.length];
    const sig = JSON.stringify([ready, starters, sugg.probes, !!r.total, !!sugg.at]);
    if (sig === suggSig) return;
    const first = !suggSig || !el.childElementCount;
    suggSig = sig;
    el.innerHTML = '';
    if (!r.total) {
      // No files yet (states catalogue): one sentence plus the two ways forward
      el.append(h('div', { class: 'sb-empty' },
        h('p', null, 'Add a file and I’ll start learning. Your bot answers only from what you add.'),
        h('div', { class: 'sb-empty-acts' },
          h('button', { type: 'button', class: 'sb-btn sb-btn-sm', onclick: () => builderAction({ type: 'request_upload' }) }, ico('upload', 13), 'Add files'),
          h('button', { type: 'button', class: 'sb-btn sb-btn-sm sb-btn-outline', onclick: () => builderAction({ type: 'attach_samples', set: 'lumen-bikes' }) }, ico('bolt', 13), 'Use sample files'))));
      return;
    }
    if (!ready) return;
    const bar = h('div', { class: 'sb-sugg', role: 'toolbar', 'aria-label': 'Suggested questions', 'aria-orientation': 'horizontal' });
    const buttons = [];
    for (const q of starters) {
      buttons.push(h('button', { type: 'button', class: `sb-chip${asked.has(norm(q)) ? ' is-asked' : ''}`, onclick: (e) => { asked.add(norm(q)); e.currentTarget.classList.add('is-asked'); startAsk(q, { by: 'chip' }); if (e.detail) homeRow(e.currentTarget.parentElement); } }, h('span', null, q)));
    }
    buttons.push(h('button', { type: 'button', class: 'sb-chip sb-chip-probe', title: 'Asks something your files don’t cover, to show the refusal',
      onclick: (e) => {
        const q = probes[probeIdx % probes.length];
        probeIdx++;
        startAsk(q, { by: 'chip' });
        if (e.detail) homeRow(e.currentTarget.parentElement);
        const l = e.currentTarget.querySelector('.sb-probe-q');
        if (l) l.textContent = `Off-topic test: ${probes[probeIdx % probes.length]}`;
      } },
    ico('shield', 14), h('span', { class: 'sb-probe-q' }, `Off-topic test: ${probe}`)));
    bar.append(...buttons);
    rovingToolbar(bar);
    el.append(bar);
    bar.scrollLeft = 0;
    wireEdgeFade(bar);
    if (first && !reduced()) buttons.forEach((b, i) => anim(b, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: i * 40, easing: 'out' }));
  }

  const summaryQs = new Map();   // localId -> starters the server validated for that file (file:summary)
  function summaryStarters() {
    const s = getState();
    const src = (s.spec || {}).sources || {};
    const out = [];
    for (const [lid, qs] of summaryQs) {
      const f = s.files[lid];
      if (!f || f.phase !== 'ready' || f.enabled === false || (f.id && src[f.id] === false)) continue;
      out.push(...qs);
    }
    return out;
  }
  /** After a pointer click the row returns to its start, so the next starters are in view (never "e frame warranty?"). */
  function homeRow(bar) { if (bar && bar.scrollLeft > 0) bar.scrollTo({ left: 0, behavior: scrollBehavior() }); }
  /** Edge fades only on the side that has more to scroll to (mask-image; the chips themselves never move). */
  let edgeRO = null;
  function wireEdgeFade(bar) {
    let raf = 0;
    const upd = () => {
      raf = 0;
      const max = bar.scrollWidth - bar.clientWidth;
      bar.dataset.fadeL = String(max > 2 && bar.scrollLeft > 2);
      bar.dataset.fadeR = String(max > 2 && bar.scrollLeft < max - 2);
    };
    const req = () => { if (!raf) raf = requestAnimationFrame(upd); };
    bar.addEventListener('scroll', req, { passive: true });
    if (edgeRO) { edgeRO.disconnect(); edgeRO = null; }
    if (typeof ResizeObserver === 'function') { edgeRO = new ResizeObserver(req); edgeRO.observe(bar); }
    else window.addEventListener('resize', req, { passive: true });
    req();
  }

  function builderAction(a) {
    if (store.listenerCount && store.listenerCount('builder:action')) { emit('builder:action', a); return; }
    if (a.type === 'request_upload') { emit('intake:open', {}); emit('intake:pick', {}); return; }
    if (a.type === 'attach_samples') emit('samples:attach', { set: a.set || 'lumen-bikes' });
  }

  /** role=toolbar with roving tabindex and arrow keys (SPEC 1.8). */
  function rovingToolbar(bar) {
    const items = () => [...bar.querySelectorAll('button:not([disabled])')];
    items().forEach((b, i) => b.setAttribute('tabindex', i === 0 ? '0' : '-1'));
    bar.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      let j = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = list.length - 1;
      if (j == null) return;
      e.preventDefault();
      list.forEach((b, k) => b.setAttribute('tabindex', k === j ? '0' : '-1'));
      list[j].focus();
    });
    bar.addEventListener('focusin', (e) => { const list = items(); if (list.includes(e.target)) list.forEach((b) => b.setAttribute('tabindex', b === e.target ? '0' : '-1')); });
  }

  // ================================================================== composer (#sb-composer-slot)

  const inputId = 'sb-input';
  const hintId = 'sb-hint';
  const ta = h('textarea', { id: inputId, class: 'sb-input', rows: '1', 'aria-describedby': hintId, autocomplete: 'off', spellcheck: 'true', enterkeyhint: 'send' });
  const send = h('button', { type: 'submit', class: 'sb-send', 'aria-label': 'Ask' }, ico('arrowUp', 18));
  const scopeBtn = h('button', { type: 'button', class: 'sb-scope', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, ico('search', 13), h('span', { class: 'sb-scope-l' }, 'Searching: 0 files'), ico('chevronDown', 12));
  const personaPill = h('span', { class: 'sb-persona', hidden: true });
  const hint = h('span', { class: 'sb-hint', id: hintId });
  const moreBtn = h('button', { type: 'button', class: 'sb-more', 'aria-label': 'More options', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, ico('more', 16));
  const form = h('form', { class: 'sb-composer', novalidate: true },
    h('div', { class: 'sb-comp-box' }, h('label', { class: 'st-sr', for: inputId }, 'Ask your bot'), ta, send),
    h('div', { class: 'sb-comp-meta' }, scopeBtn, personaPill, hint, moreBtn));
  dom.composer.innerHTML = '';
  dom.composer.append(form);

  function setComposer(text) {
    ta.value = text;
    autoGrow();
    try { ta.focus(); ta.setSelectionRange(text.length, text.length); } catch { /* ignore */ }
  }
  function autoGrow() {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
  }
  ta.addEventListener('input', () => { autoGrow(); if (hint.dataset.kind === 'wait') renderComposerMeta(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  function submit() {
    const q = ta.value.trim();
    const r = readiness();
    if (!r.ready.length) {
      showHint(r.total ? 'Your bot can answer once a file is ready…' : 'Add a file first. Your bot answers only from what you add.', 'wait');
      say(hint.textContent);
      if (!reduced()) anim(form.querySelector('.sb-comp-box'), [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 220, essential: false });
      return;
    }
    if (!q) { ta.focus(); return; }
    ta.value = '';
    autoGrow();
    startAsk(q, { by: 'user' });
  }

  function showHint(text, kind = '') { hint.textContent = text; hint.dataset.kind = kind; }

  function renderComposerMeta() {
    const r = readiness();
    const spec = getState().spec || {};
    const name = spec.name || 'your bot';
    const m = isMobile();
    ta.placeholder = r.ready.length ? (m ? `Ask ${name}…` : `Ask ${name} anything about your files`) : r.total ? (m ? 'Answers once a file is ready…' : 'Your bot can answer once a file is ready…') : (m ? 'Add a file first…' : 'Add a file and your bot can answer from it…');
    ta.setAttribute('aria-label', `Ask ${name}`);
    form.dataset.ready = r.ready.length ? 'true' : 'false';
    const on = enabledReady().length;
    const all = r.list.filter((f) => f.phase !== 'failed').length;
    scopeBtn.querySelector('.sb-scope-l').textContent = all && on !== r.ready.length ? `Searching: ${on} of ${plural(all, 'file')}` : `Searching: ${plural(on, 'file')}`;
    scopeBtn.hidden = !r.total;
    if (!r.ready.length) { if (hint.dataset.kind !== 'wait') showHint(r.total ? 'Answers start when the first file is ready.' : '', ''); }
    else showHint('', '');
    const p = PERSONAS.find((x) => x.id === persona);
    personaPill.hidden = !getState().milestones.firstRefusal || persona === 'customer';
    personaPill.textContent = `Testing as ${p ? p.label : 'Customer'}`;
  }

  // ---- menus (scope + ⋯), role=menu with arrow keys; Esc and outside click close them

  let menu = null;
  function openMenu(btn, build) {
    closeMenu();
    const el = h('div', { class: 'sb-menu', role: 'menu' });
    build(el);
    btn.setAttribute('aria-expanded', 'true');
    form.append(el);
    const br = btn.getBoundingClientRect(), fr = form.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(br.left - fr.left, fr.width - el.offsetWidth))}px`;
    el.style.bottom = `${fr.bottom - br.top + 6}px`;
    menu = { el, btn };
    if (!reduced()) anim(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'out' });
    const items = () => [...el.querySelectorAll('[role^="menuitem"]:not([disabled])')];
    (items()[0] || el).focus();
    el.addEventListener('keydown', (e) => {
      const list = items(); const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
      if (e.key === 'Tab') { closeMenu(); return; }
      let j = null;
      if (e.key === 'ArrowDown') j = (i + 1) % list.length;
      else if (e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = list.length - 1;
      if (j != null) { e.preventDefault(); list[j].focus(); }
    });
    setTimeout(() => document.addEventListener('pointerdown', onMenuOutside, true), 0);
  }
  function onMenuOutside(e) { if (menu && !menu.el.contains(e.target) && e.target !== menu.btn && !menu.btn.contains(e.target)) closeMenu(); }
  function closeMenu(refocus) {
    if (!menu) return;
    const m = menu; menu = null;
    document.removeEventListener('pointerdown', onMenuOutside, true);
    m.btn.setAttribute('aria-expanded', 'false');
    m.el.remove();
    if (refocus) m.btn.focus();
  }
  const menuItem = (label, { role = 'menuitem', checked = null, onSelect, icoName, sub: subtext } = {}) => {
    const b = h('button', { type: 'button', class: 'sb-mi', role, tabindex: '-1', 'aria-checked': checked == null ? null : String(!!checked) },
      checked == null ? (icoName ? ico(icoName, 14) : null) : h('span', { class: 'sb-mi-check', 'aria-hidden': 'true' }, checked ? ico('check', 13) : null),
      h('span', { class: 'sb-mi-l' }, label, subtext ? h('small', null, subtext) : null));
    b.addEventListener('click', () => onSelect && onSelect(b));
    return b;
  };

  scopeBtn.addEventListener('click', () => {
    if (menu && menu.btn === scopeBtn) { closeMenu(true); return; }
    openMenu(scopeBtn, (el) => {
      el.setAttribute('aria-label', 'Files your bot searches');
      el.append(h('p', { class: 'sb-menu-h', 'aria-hidden': 'true' }, 'Files your bot searches'));
      const spec = getState().spec || {};
      for (const f of readiness().list) {
        const on = f.enabled !== false && !(f.id && spec.sources && spec.sources[f.id] === false);
        const disabled = !f.id || f.phase === 'failed';
        const it = menuItem(mid(f.name, 30), { role: 'menuitemcheckbox', checked: on, sub: f.phase === 'ready' ? `${(f.atoms || 0).toLocaleString()} atoms` : f.phase === 'failed' ? 'failed' : 'learning…',
          onSelect: (b) => {
            const now = b.getAttribute('aria-checked') !== 'true';
            b.setAttribute('aria-checked', String(now));
            b.querySelector('.sb-mi-check').innerHTML = now ? icon('check', { size: 13 }) : '';
            emit('spec:request', { patch: { sources: { ...((getState().spec || {}).sources || {}), [f.id]: now } }, by: 'scope' });
          } });
        it.style.setProperty('--hue', hueVar(f.hue));
        if (disabled) it.disabled = true;
        el.append(it);
      }
      const fid = uid('sb-mf');
      el.append(h('p', { class: 'sb-menu-foot', id: fid, 'aria-hidden': 'true' }, 'Off files are never searched. Your bot refuses instead of guessing.'));
      el.setAttribute('aria-describedby', fid);
    });
  });

  moreBtn.addEventListener('click', () => {
    if (menu && menu.btn === moreBtn) { closeMenu(true); return; }
    openMenu(moreBtn, (el) => {
      el.setAttribute('aria-label', 'More options');
      if (getState().milestones.firstRefusal) {
        el.append(h('p', { class: 'sb-menu-h', 'aria-hidden': 'true' }, 'Testing as'));
        for (const p of PERSONAS) {
          el.append(menuItem(p.label, { role: 'menuitemradio', checked: persona === p.id, onSelect: () => { persona = p.id; closeMenu(true); renderComposerMeta(); say(`Testing as ${p.label}.`); } }));
        }
        const fid = uid('sb-mf');
        el.append(h('p', { class: 'sb-menu-foot', id: fid, 'aria-hidden': 'true' }, 'Same files, same rules. Only the phrasing of greetings changes.'));
        el.setAttribute('aria-describedby', fid);
        el.append(h('hr', { role: 'separator' }));
      }
      el.append(menuItem('Run the Proof Run', { icoName: 'flask', onSelect: () => { closeMenu(); emit('proof:run', { mini: false }); } }));
      el.append(menuItem(getState().ui.view === 'proof' ? 'Switch to Bot view' : 'Show Proof view', { icoName: 'shieldCheck', onSelect: () => { closeMenu(true); emit('view:set', { view: getState().ui.view === 'proof' ? 'bot' : 'proof' }); } }));
      const last = [...answers.values()].filter((x) => x.final && x.by !== 'proof').pop();
      if (last) el.append(menuItem('Copy last answer with sources', { icoName: 'copy', onSelect: () => { closeMenu(true); copyText(answerAsText(last)); } }));
    });
  });

  function answerAsText(A) {
    const f = A.final || {};
    const cites = (f.citations || []).map((c) => `[${c.n}] ${c.file}${c.locator ? `, ${c.locator}` : ''}: “${(c.quotes?.[0]?.text || c.excerpt || '').trim()}”`).join('\n');
    return `Q: ${A.question}\nA: ${String(f.text || '').replace(/^\s*-\s+/gm, '')}${cites ? `\n\nSources:\n${cites}` : ''}`;
  }

  // ================================================================== wiring

  let destroyed = false;
  let rafPending = 0;
  function onFilesChanged() {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      if (ghostEl && !ghostAllowed()) dropGhost();   // the first file row retires the example completely
      renderBanner(); renderComposerMeta(); renderSuggestions();
      if (!sugg.at && readiness().ready.length && getState().trial?.id) refreshSuggestions(300);
    });
  }

  sub('samplebot:ask', (d) => { if (d && d.question) startAsk(d.question, { by: d.by || 'setup', label: d.label || null }); });
  sub('proof:run', (d) => { runProof({ mini: !!(d && d.mini) }); });
  sub('trial:ready', () => { restoreThread(); renderGhost(); onFilesChanged(); refreshSuggestions(200); });
  sub('change:files', onFilesChanged);
  sub('change:fileOrder', onFilesChanged);
  sub('file:ready', () => { onFilesChanged(); refreshSuggestions(400); });
  sub('file:summary', (d) => {
    if (d && d.localId && Array.isArray(d.starters)) summaryQs.set(d.localId, d.starters.map((x) => (typeof x === 'string' ? x : x && x.q)).filter(Boolean).slice(0, 3));
    renderSuggestions();
    refreshSuggestions(600);
  });
  sub('file:removed', () => { onFilesChanged(); refreshSuggestions(300); });
  sub('change:spec', ({ value, prev }) => {
    renderComposerMeta();
    if (value && prev && JSON.stringify(value.sources || {}) !== JSON.stringify(prev.sources || {})) refreshSuggestions(300);
    if (value && prev && (value.name !== prev.name || JSON.stringify(value.avatar) !== JSON.stringify(prev.avatar))) {
      threadEl.querySelectorAll('.sb-avatar').forEach((a) => a.replaceWith(avatarEl()));
    }
  });
  sub('spec:changed', (d) => { if (d && Number.isFinite(d.version) && d.prev && d.version > (d.prev.version || 0)) offerReask(d.version); });
  sub('milestone', ({ name }) => { if (name === 'firstRefusal') renderComposerMeta(); });
  sub('change:trial', ({ value, prev }) => { if (value?.id !== prev?.id && !value?.id) resetAll(); });

  function resetAll() {
    for (const A of answers.values()) { try { A.ctrl && A.ctrl.abort(); } catch { /* ignore */ } A.stopClock && A.stopClock(); }
    answers.clear();
    threadEl.innerHTML = '';
    ghostEl = null; reaskEl = null; prun = null; lastPartialQ = null; partialOffered = false;
    restoredN = 0; restoredFor = null; closeMissSent.clear();
    try { localStorage.removeItem(THREAD_KEY); } catch { /* ignore */ }
    sugg = { starters: [], probes: [], at: 0 }; suggSig = ''; bannerKey = ''; asked.clear();
    if (drawer) closeDrawer({ refocus: false });
    renderGhost(); onFilesChanged();
  }

  restoreThread();
  renderGhost();
  renderBanner();
  renderComposerMeta();
  renderSuggestions();
  if (getState().trial?.id && readiness().ready.length) refreshSuggestions(100);

  function destroy() {
    destroyed = true;
    unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
    for (const A of answers.values()) { try { A.ctrl && A.ctrl.abort(); } catch { /* ignore */ } A.stopClock && A.stopClock(); }
    if (drawer) closeDrawer({ refocus: false });
    closeMenu();
    mqDock.removeEventListener?.('change', onMode); mqMob.removeEventListener?.('change', onMode);
    dom.thread.innerHTML = ''; dom.suggest.innerHTML = ''; dom.composer.innerHTML = ''; if (dom.banner) dom.banner.innerHTML = '';
  }

  return { ask, destroy };
}

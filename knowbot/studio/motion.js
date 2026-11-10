// KnowBot Studio: motion engine (owner B; contract: SPEC 3.4, design: SPEC 2.2, 2.3).
// Web Animations API only, no animation library. One signature animation at a time via `director`.
// Everything degrades under reduced motion: information stays, movement goes.

import { getState, setState, emit, on, batch } from './store.js?v=3ab6348';

export const DUR = { 1: 120, 2: 220, 3: 380, 4: 700 };
export const EASE = {
  out: 'cubic-bezier(.2,.8,.2,1)',
  inOut: 'cubic-bezier(.65,0,.35,1)',
  spring: 'linear(0, .5 12%, .86 22%, 1.04 32%, 1.02 42%, .99 55%, 1)',
};

const root = () => document.documentElement;

/** true if data-motion="reduce" (set before paint from the OS setting or the header toggle). */
export function reduced() {
  try { return root().getAttribute('data-motion') === 'reduce'; } catch { return false; }
}

/** 'full' | 'reduce': updates the attribute + localStorage + store, emits 'motion'. */
export function setMotion(mode) {
  const m = mode === 'reduce' ? 'reduce' : 'full';
  root().setAttribute('data-motion', m);
  try { localStorage.setItem('kb-studio-motion', m); } catch { /* ignore */ }
  try { setState({ ui: { ...getState().ui, motion: m } }, 'motion'); } catch { /* store not ready */ }
  if (m === 'reduce') director.skip();
  emit('motion', { mode: m });
}

// Spring easing via linear() is only understood by newer engines; fall back to a close cubic.
let springOk = null;
function easing(e) {
  if (!e) return EASE.out;
  const v = EASE[e] || e;
  if (v.startsWith('linear(')) {
    if (springOk === null) {
      try { springOk = typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', v); } catch { springOk = false; }
    }
    if (!springOk) return 'cubic-bezier(.34,1.4,.64,1)';
  }
  return v;
}

const done = () => ({ finished: Promise.resolve(), cancel() {}, finish() {}, animation: null });

function wrap(anim, el, cleanup) {
  const finished = anim.finished.then(() => {}, () => {}).finally(() => { if (cleanup) cleanup(); });
  return {
    finished,
    animation: anim,
    cancel() { try { anim.cancel(); } catch { /* ignore */ } },
    finish() { try { anim.finish(); } catch { try { anim.cancel(); } catch { /* ignore */ } } },
  };
}

function opacityOnly(keyframes) {
  if (Array.isArray(keyframes)) {
    const out = keyframes.filter((k) => k && 'opacity' in k).map((k) => ({ opacity: k.opacity, offset: k.offset }));
    return out.length >= 2 ? out.map(({ opacity, offset }) => (offset == null ? { opacity } : { opacity, offset })) : null;
  }
  if (keyframes && Array.isArray(keyframes.opacity)) return { opacity: keyframes.opacity };
  return null;
}

function animatedProps(keyframes) {
  const props = new Set();
  const add = (k) => { for (const p of Object.keys(k || {})) if (!['offset', 'easing', 'composite'].includes(p)) props.add(p); };
  if (Array.isArray(keyframes)) keyframes.forEach(add); else add(keyframes);
  return [...props].map((p) => p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
}

/**
 * WAAPI wrapper. opts: {duration, delay, easing ('out'|'inOut'|'spring'|css), fill, essential, signal, iterations}.
 * Under reduced(): instant (no Animation unless fill holds an end state); opts.reducedFade asks for a 150 ms opacity-only fade.
 * Always returns {finished:Promise (never rejects), cancel(), finish(), animation}.
 * If opts.signal aborts (a director fast-forward), the animation jumps to its end.
 */
export function animate(el, keyframes, opts = {}) {
  if (!el || typeof el.animate !== 'function') return done();
  const o = typeof opts === 'number' ? { duration: opts } : { ...opts };
  const signal = o.signal; delete o.signal;
  const essential = o.essential !== false; delete o.essential;
  const reducedFade = o.reducedFade === true; delete o.reducedFade;
  let frames = keyframes;
  if (reduced()) {
    // r4 (D9): under reduced motion nothing animates by default, entrances included: the end state is applied at once.
    // A caller that needs a cue (opts.reducedFade) gets a 150 ms opacity-only fade, never a transform.
    const fade = essential && reducedFade ? opacityOnly(keyframes) : null;
    if (fade && (o.iterations == null || o.iterations === 1)) { frames = fade; o.duration = 150; o.delay = 0; o.easing = 'linear'; }
    else {
      const fill = o.fill || 'auto';
      if (fill !== 'forwards' && fill !== 'both') return done();   // nothing to hold: no Animation object at all
      o.duration = 0; o.delay = 0; o.iterations = 1;
    }
  }
  o.easing = easing(o.easing || 'out');
  if (o.duration == null) o.duration = DUR[2];
  if (o.iterations === Infinity && reduced()) o.iterations = 1;
  let anim;
  const props = animatedProps(frames).filter((p) => p === 'transform' || p === 'opacity' || p === 'filter' || p === 'clip-path');
  const hadWill = el.style && el.style.willChange;
  // r5 (perf): will-change only for long transform/filter moves. Short fades and pops are composited by WAAPI anyway,
  // and an inline will-change per streamed span meant a style recalc + a new layer each (Layerize/Commit dominated
  // the long frames of an answer stream).
  const wantWill = props.length && o.duration >= 400 && props.some((x) => x !== 'opacity');
  if (wantWill && el.style && !hadWill) el.style.willChange = props.join(',');
  try { anim = el.animate(frames, o); } catch (err) {
    try { anim = el.animate(frames, { ...o, easing: 'ease-out' }); } catch { return done(); }
  }
  const cleanup = () => { if (wantWill && el.style && !hadWill) el.style.willChange = ''; };
  const handle = wrap(anim, el, cleanup);
  if (signal) {
    if (signal.aborted) handle.finish();
    else signal.addEventListener('abort', () => handle.finish(), { once: true });
  }
  track(handle);
  return handle;
}

/** Same keyframes on many elements, `stepMs` apart. Returns Promise.all(finished). */
export function stagger(els, keyframes, opts = {}, stepMs = 40) {
  const list = Array.from(els || []);
  const base = (opts && opts.delay) || 0;
  const step = reduced() ? 0 : stepMs;
  return Promise.all(list.map((el, i) => animate(el, keyframes, { ...opts, delay: base + i * step }).finished));
}

/**
 * FLIP: measure all → mutate() → measure all → invert → play. Elements that are new after mutate() fade in.
 * `els` is an iterable or a function returning the elements (called before and after mutate).
 */
export function flip(els, mutate, opts = {}) {
  const get = () => Array.from(typeof els === 'function' ? els() : els || []);
  const before = new Map();
  for (const el of get()) if (el && el.isConnected) before.set(el, el.getBoundingClientRect());   // all reads first
  try { mutate && mutate(); } catch (err) { console.error('[studio] flip mutate failed', err); }
  const after = get();
  const rects = after.map((el) => (el && el.isConnected ? el.getBoundingClientRect() : null));        // then reads
  const duration = opts.duration ?? DUR[3];
  const runs = [];
  after.forEach((el, i) => {                                                                       // then writes
    const b = before.get(el); const a = rects[i];
    if (!a) return;
    if (!b) { runs.push(animate(el, [{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration, easing: opts.easing || 'out', signal: opts.signal }).finished); return; }
    const dx = b.left - a.left, dy = b.top - a.top;
    const sx = a.width ? b.width / a.width : 1, sy = a.height ? b.height / a.height : 1;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) return;
    const scale = opts.scale === false ? '' : ` scale(${sx}, ${sy})`;
    runs.push(animate(el, [
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px)${scale}` },
      { transformOrigin: 'top left', transform: 'none' },
    ], { duration, easing: opts.easing || 'out', essential: false, signal: opts.signal }).finished);
  });
  return Promise.all(runs).then(() => {});
}

// ------------------------------------------------------------------ shared rAF loop

const loopFns = new Set();
let rafId = 0, lastT = 0, cursor = 0;
const FRAME_BUDGET = 6;   // ms of loop work per frame; the rest continues next frame (no long animation frames)
// r5: after a long frame (dt > 34 ms: the CPU is behind) the next frame's budget halves, so the loop gives time back
// to rendering instead of compounding the jank.
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function frame(t) {
  rafId = 0;
  const dt = lastT ? Math.min(100, t - lastT) : 16.7;
  lastT = t;
  if (lastT && dt < 100) frameEma = frameEma * 0.9 + dt * 0.1;
  // Round-robin under a per-frame budget: when the loop work of one frame runs long (many tickers + a map tween on a
  // throttled CPU), the remaining callbacks run first on the next frame. Callbacks read `t`, so a skipped frame only
  // means a coarser step, never a wrong value.
  const fns = [...loopFns];
  const n = fns.length;
  const t0 = nowMs();
  const budget = dt > 34 ? FRAME_BUDGET / 2 : FRAME_BUDGET;
  let cut = false;
  // Store writes made by loop callbacks (tweened counters, map state) notify subscribers once per frame.
  batch(() => {
    for (let i = 0; i < n; i++) {
      const fn = fns[(cursor + i) % n];
      if (!loopFns.has(fn)) continue;
      try { if (fn(t, dt) === false) loopFns.delete(fn); } catch (err) { console.error('[studio] loop fn failed', err); loopFns.delete(fn); }
      if (i < n - 1 && nowMs() - t0 > budget) { cursor = (cursor + i + 1) % n; cut = true; return; }
    }
  });
  if (!cut) cursor = 0;
  schedule();
}
function schedule() {
  if (rafId || !loopFns.size) { if (!loopFns.size) lastT = 0; return; }
  if (typeof document !== 'undefined' && document.hidden) return;   // resumes on visibilitychange
  rafId = requestAnimationFrame(frame);
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = 0; lastT = 0; }
    else schedule();
  });
}

/** loop.add(fn(t, dt)) -> remove(). Returning false from fn removes it. Paused while the tab is hidden. */
export const loop = {
  add(fn) {
    if (typeof fn !== 'function') return () => {};
    loopFns.add(fn); schedule();
    return () => { loopFns.delete(fn); };
  },
  size() { return loopFns.size; },
};

// ------------------------------------------------------------------ tweens, tickers, text

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 6; i++) { const d = dsx(t); const e = sx(t) - x; if (Math.abs(e) < 1e-4 || !d) break; t -= e / d; }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
const EASE_FN = { out: bezier(.2, .8, .2, 1), inOut: bezier(.65, 0, .35, 1), linear: (x) => x,
  spring: (x) => { const p = [[0, 0], [.12, .5], [.22, .86], [.32, 1.04], [.42, 1.02], [.55, .99], [1, 1]];
    for (let i = 1; i < p.length; i++) if (x <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    return 1; } };

/** rAF tween on the shared loop. Returns {cancel(), finish(), finished}. Instant under reduced(). */
export function tween(from, to, ms, onUpdate, ease = 'out') {
  const f = typeof ease === 'function' ? ease : (EASE_FN[ease] || EASE_FN.out);
  let resolve; const finished = new Promise((r) => { resolve = r; });
  if (reduced() || !(ms > 0) || from === to) {
    try { onUpdate(to, 1); } catch (err) { console.error(err); }
    resolve();
    return { cancel() {}, finish() {}, finished };
  }
  let start = 0, stopped = false;
  const remove = loop.add((t) => {
    if (stopped) return false;
    if (!start) start = t;
    const k = Math.min(1, (t - start) / ms);
    try { onUpdate(from + (to - from) * f(k), k); } catch (err) { console.error(err); }
    if (k >= 1) { stopped = true; resolve(); return false; }
    return true;
  });
  return {
    cancel() { if (!stopped) { stopped = true; remove(); resolve(); } },
    finish() { if (!stopped) { stopped = true; remove(); try { onUpdate(to, 1); } catch { /* ignore */ } resolve(); } },
    finished,
  };
}

// perf r4: Number#toLocaleString builds a new NumberFormat on every call (a count-up called it every frame); one cached
// formatter does the same job. Additive export: fmtNum(n).
let nf = null;
export function fmtNum(n) {
  if (nf === null) { try { nf = new Intl.NumberFormat(); } catch { nf = false; } }
  return nf ? nf.format(n) : String(n);
}
// perf (M): measured under 4x CPU, that first NumberFormat costs 47-78 ms however it is scheduled: run from an idle
// callback it was a long animation frame of its own, and left lazy it lands mid-answer (samplebot's toLocaleString).
// It is paid once, synchronously, while the module graph evaluates: that boot task is already the page's one
// unavoidable long task, nothing is animating yet, and every later count-up and "N atoms" label is warm.
try { fmtNum(1234); (1234.5).toLocaleString(); new Date().toLocaleDateString(); } catch { /* not a browser */ }

const tickers = new WeakMap();
// r5: elements whose interpolation ticks are skipped because they are outside the viewport (IntersectionObserver: no
// layout reads on the loop)
const offscreen = new WeakSet();
let visIO = null;
function watchVisible(el) {
  if (typeof IntersectionObserver !== 'function' || !el || el._kbVis) return;
  if (!visIO) visIO = new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting) offscreen.delete(e.target); else offscreen.add(e.target); } });
  el._kbVis = true;
  visIO.observe(el);
}
/** Tabular number tween from el.dataset.value to `to`. Jumps under reduced(). */
export function ticker(el, to, { ms = 600, format = fmtNum } = {}) {
  if (!el) return { cancel() {}, finish() {}, finished: Promise.resolve() };
  const prev = tickers.get(el); if (prev) prev.cancel();
  const target = Number(to) || 0;
  const from = Number(el.dataset.value);
  const start = Number.isFinite(from) ? from : 0;
  el.dataset.value = String(target);
  // writes only when the shown text changes (a count-up repaints a few times, not every frame)
  // Off-DOM targets jump straight to the value (no per-frame work for something nobody can see).
  // r5: while the number is scrolled out of view (or its tab is hidden) the in-between values are not written at all;
  // the final value always is.
  watchVisible(el);
  const t = tween(start, target, el.isConnected ? ms : 0, (v, k) => {
    if (k < 1 && offscreen.has(el)) return;
    const s = format(Math.round(v)); if (el.textContent !== s) el.textContent = s;
  });
  tickers.set(el, t);
  t.finished.then(() => { if (tickers.get(el) === t) tickers.delete(el); });
  return t;
}

/** Marker highlight 0% → 100% (300 ms). Static under reduced(). */
export function sweep(markEl) {
  if (!markEl) return done();
  markEl.style.backgroundSize = '100% 100%';
  if (reduced()) return done();
  return animate(markEl, [{ backgroundSize: '0% 100%' }, { backgroundSize: '100% 100%' }], { duration: 300, easing: 'out', essential: false });
}

/** pathLength=1 stroke-dashoffset draw. */
export function drawPath(pathEl, ms = 220) {
  if (!pathEl) return done();
  try { pathEl.setAttribute('pathLength', '1'); } catch { /* ignore */ }
  pathEl.style.strokeDasharray = '1';
  pathEl.style.strokeDashoffset = '0';
  if (reduced()) return done();
  return animate(pathEl, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: ms, easing: 'out', essential: false });
}

/**
 * Types `text` into el (textContent). cps = characters per second; the whole run is capped at maxMs.
 * Instant under reduced(). Returns {finished, finish(), cancel()}.
 */
export function typeText(el, text, { cps = 1000 / 14, maxMs = 600 } = {}) {
  const s = String(text ?? '');
  if (!el) return { finished: Promise.resolve(), finish() {}, cancel() {} };
  if (reduced() || !s) { el.textContent = s; return { finished: Promise.resolve(), finish() {}, cancel() {} }; }
  const natural = (s.length / cps) * 1000;
  const total = Math.max(1, Math.min(natural, maxMs));
  el.classList.add('st-typing');
  el.textContent = '';
  let shown = -1;
  const t = tween(0, s.length, total, (v) => { const n = Math.round(v); if (n !== shown) { shown = n; el.textContent = s.slice(0, n); } }, 'linear');
  t.finished.then(() => { el.textContent = s; el.classList.remove('st-typing'); });
  return t;
}

// ------------------------------------------------------------------ view transitions

// Smoothed frame time of the shared loop (EMA of dt while the loop runs). A device that runs above ~22 ms per frame
// (or that the fps probe / governor marked low) takes the cheap paths below.
let frameEma = 16.7;
function slowFrames() {
  try { const r = document.documentElement; if (r.dataset.detail === 'low' || 'lite' in r.dataset) return true; } catch { /* no DOM */ }
  return frameEma > 22;
}
/** additive: the shared loop's smoothed frame time in ms (16.7 at 60 fps). Modules cap particles by it. */
export const frameTime = () => frameEma;


/**
 * SPEC 2.3. Uses document.startViewTransition when available and motion is full; otherwise a WAAPI
 * FLIP from `el`'s old rect to `target`'s new rect (target = opts.target element or function, default el);
 * under reduced motion a 150 ms opacity cross-fade. The owner sets/clears view-transition-name itself.
 */
export function viewTransition(update, { name, el, target } = {}) {
  const run = async () => { try { await batch(() => update()); } catch (err) { console.error('[studio] view transition update failed', err); } };
  const resolveTarget = () => (typeof target === 'function' ? target() : target) || el;
  if (reduced()) {
    return run().then(() => { const t = resolveTarget(); if (t) return animate(t, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'linear', reducedFade: true }).finished; });
  }
  // fixer M r1 (D6 frame budget): on a device measured slow (fpsProbe data-detail="low", or the governor tripped in
  // the last signature) a view transition costs two full-page snapshots and the FLIP fallback a layout read right
  // after the update: both were 100-200 ms frames under 4x CPU. The update runs as is; the target settles in with a
  // compositor-only rise on the NEXT frame (no rect read, no forced layout). Same information, cheaper motion.
  if (slowFrames()) {
    return run().then(() => new Promise((res) => requestAnimationFrame(() => {
      const t = resolveTarget();
      if (!t || !t.isConnected) { res(); return; }
      animate(t, [{ opacity: 0.6, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: DUR[2], easing: 'out', essential: false }).finished.then(res, res);
    })));
  }
  if (typeof document.startViewTransition === 'function' && !document.documentElement.dataset.vtBusy) {
    try {
      document.documentElement.dataset.vtBusy = name || '1';
      const vt = document.startViewTransition(run);
      const clear = () => { delete document.documentElement.dataset.vtBusy; };
      return vt.finished.then(clear, clear);
    } catch { delete document.documentElement.dataset.vtBusy; }
  }
  const r0 = el && el.isConnected ? el.getBoundingClientRect() : null;
  return run().then(() => {
    const t = resolveTarget();
    if (!t || !t.isConnected) return;
    const r1 = t.getBoundingClientRect();
    if (!r0 || !r1.width || !r1.height) return animate(t, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR[3] }).finished;
    const dx = r0.left - r1.left, dy = r0.top - r1.top, sx = r0.width / r1.width, sy = r0.height / r1.height;
    return animate(t, [
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: .6 },
      { transformOrigin: 'top left', transform: 'none', opacity: 1 },
    ], { duration: DUR[3], easing: 'out' }).finished;
  });
}

// ------------------------------------------------------------------ director (one signature at a time)

const SKIP_GRACE = 120;                           // fast-forward lands within 120 ms
const isMobile = () => { try { return matchMedia('(max-width: 899px)').matches; } catch { return false; } };
const running = new Set();                        // jobs currently running (same name; shatter may run 2)
const queue = [];                                 // waiting jobs, highest priority first
let current = null;                               // representative running job (highest priority)
const liveAnims = new Set();
let seq = 0;

function track(handle) {
  if (!running.size) return;
  liveAnims.add(handle);
  handle.finished.then(() => liveAnims.delete(handle));
}

function capacityFor(name, opts) {
  if (opts && Number.isFinite(opts.concurrent)) return Math.max(1, opts.concurrent);
  if (name === 'shatter') return isMobile() ? 1 : 2;
  return 1;
}

function setBusyAttr() {
  const r = root();
  if (running.size) r.dataset.signature = current ? current.name : [...running][0].name;
  else delete r.dataset.signature;
}

function start(job) {
  job.controller = new AbortController();
  running.add(job);
  governor.watch();
  if (!current || job.priority > current.priority) current = job;
  setBusyAttr();
  emit('director', { name: job.name, state: 'start' });
  let settled = false;
  const finish = () => {
    if (settled) return; settled = true;
    clearTimeout(job.watchdog);
    if (job.region) job.region.removeEventListener('pointerdown', job.onRegion, true);
    running.delete(job);
    if (current === job) current = [...running].sort((a, b) => b.priority - a.priority)[0] || null;
    setBusyAttr();
    if (!running.size) governor.release();
    emit('director', { name: job.name, state: 'end' });
    job.resolve();
    pump();
  };
  job.finishJob = finish;
  if (job.region) {
    job.onRegion = () => skipJob(job);
    job.region.addEventListener('pointerdown', job.onRegion, true);
  }
  job.watchdog = setTimeout(() => skipJob(job), job.maxMs);
  let p;
  try { p = Promise.resolve(job.run(job.controller.signal)); } catch (err) { console.error('[studio] signature failed', err); p = Promise.resolve(); }
  p.catch((err) => { if (!job.controller.signal.aborted) console.error(`[studio] signature "${job.name}" failed`, err); }).finally(finish);
}

function skipJob(job) {
  if (!job || !running.has(job) || job.controller.signal.aborted) return;
  job.controller.abort();
  for (const h of [...liveAnims]) h.finish();     // anything still playing jumps to its end state
  setTimeout(() => job.finishJob && job.finishJob(), SKIP_GRACE + 40);
}

function pump() {
  while (queue.length) {
    const next = queue[0];
    if (running.size) {
      const sameName = [...running].every((j) => j.name === next.name);
      if (!sameName || running.size >= next.capacity) return;
    }
    queue.shift();
    start(next);
  }
}

export const director = {
  /**
   * request(name, priority, run(signal) => Promise, opts?) -> Promise (resolves when run finished or was fast-forwarded).
   * Priorities: retrieval 3 > launch 2 > shatter 1. A higher priority (or a new retrieval) fast-forwards what runs.
   * opts (additive): {region: Element (pointerdown on it fast-forwards), concurrent: n, maxMs (watchdog, default 20 s)}.
   */
  request(name, priority = 1, run = async () => {}, opts = {}) {
    return new Promise((resolve) => {
      const job = { id: ++seq, name, priority, run, resolve, region: opts.region || null,
        capacity: capacityFor(name, opts), maxMs: opts.maxMs || 20000 };
      const pre = [...running].some((j) => priority > j.priority || (priority >= 3 && j.name === name) || j.name !== name && priority >= j.priority && priority > 1);
      if (running.size && pre) {
        // Queue first (ahead of lower priorities) so pump() starts it as soon as the slot is free.
        insert(job);
        for (const j of [...running]) skipJob(j);
        return;
      }
      insert(job);
      pump();
    });
  },
  /** Fast-forward everything that is running (Esc, a click on the animating region, reduce motion). */
  skip() { for (const j of [...running]) skipJob(j); },
  /** Current signature name or null. */
  busy() { return current ? current.name : (running.size ? [...running][0].name : null); },
};

function insert(job) {
  let i = queue.findIndex((q) => q.priority < job.priority);
  if (i < 0) i = queue.length;
  queue.splice(i, 0, job);
}

try { on('motion:skip', () => director.skip()); } catch { /* store unavailable */ }

// ------------------------------------------------------------------ frame-budget governor (r7, D6)
// While a signature runs, rAF deltas are sampled on the shared loop. Two consecutive frames over 24 ms (the device cannot
// hold the signature at full detail) put the page into "lite" for the rest of the signature: <html data-lite> (CSS stops
// the ambient loops: working rings, busy borders, the spine spinner) and 'motion:lite' {lite} is emitted so subscribers
// can thin their own work. Released 6 s after the last signature ends; after it has tripped in two signatures it stays.
// Measured (r7, 4x CPU, 3 runs each): ALSO flipping data-detail="low" mid-burst made D's map re-sync (its MutationObserver
// on data-detail calls syncMap) in the middle of the shatter and cost more long frames than it saved, so data-detail
// stays with fpsProbe. CONTRACT-GAP (D, ingest.js): subscribe to 'motion:lite' (or read motion.lite()) to halve particle
// and strip counts of the next shatter without a full map re-sync.
const LITE_MS = 24;
export const governor = (() => {
  let stopSample = null, over = 0, frames = 0, tripped = false, trips = 0, sticky = false, relTimer = 0;
  const set = (on) => {
    const r = root();
    if (on) r.dataset.lite = ''; else delete r.dataset.lite;
    try { emit('motion:lite', { lite: !!on }); } catch { /* ignore */ }
  };
  return {
    /** Starts sampling (called when a signature starts). */
    watch() {
      clearTimeout(relTimer);
      if (stopSample || sticky || reduced()) return;
      over = 0; frames = 0;
      stopSample = loop.add((t, dt) => {
        if (++frames <= 2) return true;                 // the first frames after a start carry the setup cost
        if (dt > LITE_MS) over++; else over = 0;
        if (over >= 2 && !tripped) { tripped = true; trips++; if (trips >= 2) sticky = true; set(true); }
        return !tripped;                                // once tripped, sampling stops until the next signature
      });
    },
    /** Called when the last running signature ends. */
    release() {
      if (stopSample) { stopSample(); stopSample = null; }
      clearTimeout(relTimer);
      if (!tripped || sticky) return;
      relTimer = setTimeout(() => { if (running.size) return; tripped = false; set(false); }, 6000);
    },
    /** true while the page runs at lite detail */
    lite() { return tripped; },
  };
})();
/** additive: true while the frame-budget governor holds the page at lite detail */
export const lite = () => governor.lite();

// ------------------------------------------------------------------ fps probe

let probed = null;
/** Average fps over `ms`; sets <html data-detail="low"> when below 45. Runs once; later calls share the result. */
export function fpsProbe(ms = 3000) {
  if (probed) return probed;
  probed = new Promise((resolve) => {
    let frames = 0, t0 = 0;
    loop.add((t) => {
      if (!t0) t0 = t;
      frames++;
      if (t - t0 >= ms) {
        const fps = (frames - 1) * 1000 / (t - t0);
        if (fps < 45) root().dataset.detail = 'low';
        resolve(Math.round(fps));
        return false;
      }
      return true;
    });
  });
  return probed;
}

// KnowBot Studio: KnowDrive widget islands (phase 1 of the KnowDrive design-system move).
//
// The Studio is plain JS. The KnowDrive widget package (@recourse-software/knowdrive-widgets, vendored in
// /vendor/knowdrive-widgets/) ships its stateful widgets as React components, and the design contract says to use the
// components, never to hand-build FileGauge or Tabs from their classes. This module is the one bridge: it mounts a
// component into a DOM node the plain-JS modules own, re-renders it with new props, and unmounts it.
//
//   import { mountWidget } from './kdw.js?v=b9d9901';
//   const g = mountWidget(el, 'FileGauge', { phase: 'completed', atomCount: 12, atomsVectorized: 12, name: 'a.md' });
//   g.update({ ...props });   // cheap: React diffs it
//   g.unmount();              // when the row goes away
//
// React and the widgets load on first use (dynamic import through the importmap in index.html), so the first paint
// never waits for them. Until they arrive, update() only remembers the latest props. Props may hold DOM nodes (or
// arrays of them) anywhere a React child goes, e.g. a Tabs panel's `content`: the node is moved into the React tree
// as is, so its listeners and state survive (a panel built by golive.js stays the same element).

let libs = null;      // { React, createRoot, W } once loaded
let loading = null;

/** Loads React, react-dom/client and the widget components once. Resolves to the libs (rejects if they fail). */
export function loadWidgets() {
  if (libs) return Promise.resolve(libs);
  if (!loading) {
    loading = Promise.all([import('react'), import('react-dom/client'), import('@recourse-software/knowdrive-widgets/react')])
      .then(([React, Client, W]) => { libs = { React: React.default || React, createRoot: Client.createRoot, W }; return libs; })
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}
export const widgetsLoaded = () => !!libs;

const slotCache = new WeakMap();
function slotComponent(React) {
  if (slotCache.has(React)) return slotCache.get(React);
  // Moves one existing DOM node into the React tree (display: contents, so it adds no box of its own).
  const DomSlot = ({ node }) => {
    const ref = React.useRef(null);
    React.useLayoutEffect(() => {
      const host = ref.current;
      if (host && node && node.parentNode !== host) { host.textContent = ''; host.append(node); }
    }, [node]);
    return React.createElement('span', { ref, className: 'kdw-slot' });
  };
  slotCache.set(React, DomSlot);
  return DomSlot;
}
const isNode = (v) => typeof Node !== 'undefined' && v instanceof Node;
/** Props with DOM nodes turned into React elements (one level of arrays and objects of plain props, e.g. tabs[]). */
function toReact(v, React, keyHint) {
  if (isNode(v)) return React.createElement(slotComponent(React), { node: v, key: keyHint });
  if (Array.isArray(v)) return v.map((x, i) => toReact(x, React, i));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = typeof x === 'function' ? x : toReact(x, React, k);
    return o;
  }
  return v;
}

/**
 * Mounts widget `name` (an export of @recourse-software/knowdrive-widgets/react: 'FileGauge', 'Tabs', …) into `node`.
 * Returns { update(props), unmount(), ready } where ready resolves once it has rendered (rejects if React can't load).
 */
export function mountWidget(node, name, props = {}) {
  let root = null, cur = props, dead = false;
  const render = () => {
    if (dead || !libs) return;
    const C = libs.W[name];
    if (!C) throw new Error(`kdw: no widget named ${name}`);
    if (!root) root = libs.createRoot(node);
    root.render(libs.React.createElement(C, toReact(cur, libs.React)));
  };
  const ready = loadWidgets().then(() => { render(); return true; });
  ready.catch(() => {});
  if (libs) render();
  return {
    ready,
    get props() { return cur; },
    update(p) { cur = p; if (libs) render(); },
    unmount() { dead = true; const r = root; root = null; if (r) queueMicrotask(() => { try { r.unmount(); } catch { /* already gone */ } }); },
  };
}

// ------------------------------------------------------------------ Studio file -> FileGauge

// Studio pipeline phase (ingest.js FileState.phase) -> the knowDrive phase the gauge models. The Studio splits
// knowDrive's "chunked" in two (chunked = no atoms yet, atomized = atoms counted) and adds "vectorizing" (atoms
// counted, embedding running); all three are knowDrive "chunked". Sample files replay a recorded timeline, so their
// phase walks the same stages and the gauge animates with it.
const GAUGE_PHASE = { uploaded: 'processing', extracted: 'text_extracted', chunked: 'chunked', atomized: 'chunked', vectorizing: 'chunked', ready: 'completed' };
// the Studio's failure node (upload, extract, chunk, atomize, encode, ready) -> the gauge stage that failed
const FAIL_AT = ['saved', 'text', 'fulltext', 'fulltext', 'vector', 'vector'];
const RANK = { queued: 0, uploading: 1, uploaded: 2, extracted: 3, chunked: 4, atomized: 5, vectorizing: 6, ready: 7 };

/**
 * FileGauge props for a Studio FileState. Honest by construction: a count the server has not reported is null (never
 * 0), a failure shows as a failure at the stage it happened, and an upload in flight shows its real byte progress.
 * `failNode` is ingest.js's failure node index (0..5) for failed files (omit when unknown).
 */
export function gaugeProps(f, { failNode = null } = {}) {
  const name = f.name || 'file';
  const bytes = Number(f.bytes) > 0 ? Number(f.bytes) : undefined;
  if (f.phase === 'rejected') return { phase: 'failed', failedAt: 'saved', reason: (f.error && f.error.message) || undefined, name, bytes, tabIndex: -1 };
  if (f.phase === 'failed') {
    // the failing step when the caller knows it; otherwise the gauge says the server didn't say which step
    const at = failNode == null ? undefined : FAIL_AT[failNode];
    return { phase: 'failed', failedAt: at, reason: (f.error && f.error.message) || undefined, name, bytes, tabIndex: -1 };
  }
  if (f.phase === 'queued' || f.phase === 'uploading') {
    // bytes on their way to the store (queued: none yet); "Fetching" is the gauge's word for this stage
    return { phase: 'fetching', bytesTotal: bytes, bytesFetched: f.phase === 'uploading' ? Math.min(Number(f.sent) || 0, bytes || 0) : 0, name, tabIndex: -1 };
  }
  const phase = GAUGE_PHASE[f.phase] || 'processing';
  const r = RANK[f.phase] ?? 0;
  const atoms = Number(f.atoms) || 0;
  // atoms are counted from "atomized"; before that the count is unknown, not zero
  const atomCount = r >= RANK.atomized && atoms > 0 ? atoms : undefined;
  // knowDrive reports the embedded count when its batch finishes; until then 0 means "not reported", not "none"
  const vec = Number(f.vectorized) || 0;
  const atomsVectorized = atomCount === undefined ? undefined : f.phase === 'ready' ? Math.min(vec || atoms, atoms) : vec > 0 ? Math.min(vec, atoms) : undefined;
  return { phase, atomCount, atomsVectorized, bytes, name, tabIndex: -1 };
}

// ------------------------------------------------------------------ RowActionMenu, with the keyboard of a menu

/**
 * KnowDrive's <RowActionMenu> in `host`, plus what the Studio's own row menus did and the component leaves out
 * (to raise with KnowDrive): focus moves to the first action when the menu opens, ArrowUp/ArrowDown/Home/End move
 * between actions, Escape returns focus to the trigger, and focus leaving the menu closes it. The open menu is placed
 * with position: fixed next to its trigger (flipped above when there's no room below) so a scrolling list never clips
 * it, and a scroll closes it, like the gauge's card.
 * props: { label, actions: [{ label, onSelect, tone? }] } (label may hold DOM nodes, e.g. an icon and a word).
 */
export function mountRowMenu(host, props) {
  const trigger = () => host.querySelector('.row-actions-trigger');
  // an action closes the menu: focus goes back to the trigger first (never to <body>)
  const wrap = (p) => ({ ...p, actions: (p.actions || []).map((a) => ({ ...a, onSelect: () => { trigger()?.focus({ preventScroll: true }); a.onSelect(); } })) });
  const w = mountWidget(host, 'RowActionMenu', wrap(props));
  const menuEl = () => host.querySelector('.row-actions-menu');
  const items = () => [...host.querySelectorAll('.row-actions-item')];
  const close = () => { if (menuEl()) trigger()?.click(); };
  const place = (m) => {
    const t = trigger();
    if (!t) return;
    const r = t.getBoundingClientRect();
    m.style.position = 'fixed';
    m.style.right = 'auto';
    const mw = m.offsetWidth, mh = m.offsetHeight;
    const below = r.bottom + 4 + mh <= window.innerHeight - 8;
    m.style.top = `${Math.max(8, below ? r.bottom + 4 : r.top - 4 - mh)}px`;
    m.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
  };
  // a scroll moves the menu with its trigger; once the trigger has scrolled out of view the menu closes
  const onScroll = (e) => {
    const m = menuEl(), t = trigger();
    if (!m || !t || m.contains(e.target)) return;
    const r = t.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || !r.width) close(); else place(m);
  };
  // CSS containment (contain: layout/paint) on an ancestor would trap and clip a fixed menu: lift it while open
  let lifted = [];
  const lift = () => { for (let n = host.parentElement; n && n !== document.body; n = n.parentElement) { const c = getComputedStyle(n).contain; if (c && c !== 'none') { n.setAttribute('data-kdw-uncontain', ''); lifted.push(n); } } };
  const unlift = () => { for (const n of lifted) n.removeAttribute('data-kdw-uncontain'); lifted = []; };
  const mo = new MutationObserver(() => {
    const m = menuEl();
    if (m && !m.dataset.kdwPlaced) {
      m.dataset.kdwPlaced = '1';
      lift();
      place(m);
      window.addEventListener('scroll', onScroll, true);
      items()[0]?.focus({ preventScroll: true });
    } else if (!m && lifted.length) { window.removeEventListener('scroll', onScroll, true); unlift(); }
    else if (!m) window.removeEventListener('scroll', onScroll, true);
  });
  mo.observe(host, { childList: true, subtree: true });
  const onKey = (e) => {
    const m = menuEl();
    if (!m) return;
    const list = items();
    const i = list.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); trigger()?.focus({ preventScroll: true }); return; }
    if (j != null && list.length) { e.preventDefault(); list[j].focus(); }
  };
  const onFocusOut = (e) => { if (menuEl() && !host.contains(e.relatedTarget)) close(); };
  host.addEventListener('keydown', onKey);
  host.addEventListener('focusout', onFocusOut);
  return {
    ready: w.ready,
    update: (p) => w.update(wrap(p)),
    unmount() { mo.disconnect(); unlift(); window.removeEventListener('scroll', onScroll, true); host.removeEventListener('keydown', onKey); host.removeEventListener('focusout', onFocusOut); w.unmount(); },
  };
}

/**
 * KnowDrive's <StatusCard> in `host` (tone: security | time | info | ok | neutral). children / actions may be DOM nodes
 * (a live countdown keeps ticking: the node is moved, not copied). If React can't load, the same words still show.
 */
export function mountStatusCard(host, { tone = 'neutral', title, children = null, actions = null } = {}) {
  const w = mountWidget(host, 'StatusCard', { tone, title, children, actions });
  w.ready.catch(() => {
    if (host.childElementCount) return;
    const p = document.createElement('p');
    p.textContent = title;
    host.append(p);
    for (const x of [children, actions].flat()) if (x != null) host.append(x instanceof Node ? x : document.createTextNode(String(x)));
  });
  return w;
}

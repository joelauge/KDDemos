// The Builder pane (#st-setup) on desktop: drag its right edge to resize, or hide it to a slim rail and bring it back.
// Width and hidden state are kept per browser (localStorage 'kb-studio-builder'); the pre-paint script in index.html
// applies them before first paint so the layout never jumps. Phones (< 900 px) keep their Builder | Bot tabs.

const KEY = 'kb-studio-builder';
const MIN = 300;            // narrowest Builder
const BOT_MIN = 440;        // the bot pane always keeps this much room
const SNAP = 220;           // dragging the edge below this hides the Builder
const root = document.documentElement;
const desktop = matchMedia('(min-width: 900px)');

const ICON_HIDE = '<svg class="st-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="m15.5 10-2 2 2 2"/></svg>';
const ICON_SHOW = '<svg class="st-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="m13.5 10 2 2-2 2"/></svg>';
const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘\\' : 'Ctrl+\\';

function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { return {}; } }
function write(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: this visit only */ } }

let state = read();
let mainEl, setupEl, logObs;

const isHidden = () => root.getAttribute('data-builder') === 'hidden';
function maxWidth() { return Math.max(MIN, (mainEl?.getBoundingClientRect().width || innerWidth) - BOT_MIN - (mainEl?.dataset.drawer === 'open' && innerWidth >= 1440 ? 400 : 0)); }
function currentWidth() { return Math.round(setupEl?.getBoundingClientRect().width || MIN); }

function applyWidth(w) {
  if (w == null) { root.removeAttribute('data-builder-w'); root.style.removeProperty('--st-builder-w'); return; }
  root.setAttribute('data-builder-w', '');
  root.style.setProperty('--st-builder-w', `${Math.round(w)}px`);
}

function syncAria() {
  const sep = mainEl?.querySelector(':scope > .st-split');
  if (sep) {
    sep.setAttribute('aria-valuemin', String(MIN));
    sep.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
    sep.setAttribute('aria-valuenow', String(isHidden() ? 0 : currentWidth()));
  }
  const tog = setupEl?.querySelector('.st-builder-hide');
  if (tog) tog.setAttribute('aria-expanded', String(!isHidden()));
  const rail = setupEl?.querySelector('.st-rail');
  if (rail) rail.setAttribute('aria-expanded', String(!isHidden()));
}

export function hideBuilder({ focus = true } = {}) {
  if (!desktop.matches || isHidden()) return;
  const had = setupEl?.contains(document.activeElement);
  root.setAttribute('data-builder', 'hidden');
  state = { ...state, hidden: true }; write(state);
  syncAria();
  if (focus && had) setupEl.querySelector('.st-rail')?.focus({ preventScroll: true });
}

export function showBuilder({ focus = false } = {}) {
  if (!isHidden()) return;
  root.removeAttribute('data-builder');
  setupEl?.querySelector('.st-rail')?.removeAttribute('data-unread');
  state = { ...state, hidden: false }; write(state);
  syncAria();
  if (focus) setupEl?.querySelector('#st-setup-composer')?.focus({ preventScroll: true });
  const log = setupEl?.querySelector('#st-log');
  if (log) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

export function toggleBuilder() { isHidden() ? showBuilder({ focus: true }) : hideBuilder(); }

function setWidth(w, { save = true } = {}) {
  const c = Math.max(MIN, Math.min(maxWidth(), w));
  applyWidth(c);
  if (save) { state = { ...state, w: Math.round(c) }; write(state); }
  syncAria();
}

function resetWidth() {
  applyWidth(null);
  const { w, ...rest } = state; state = rest; write(state);
  syncAria();
}

function wireSplit(sep) {
  let startX = 0, startW = 0, dragging = false, last = 0;
  sep.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !desktop.matches) return;
    e.preventDefault();
    dragging = true; startX = e.clientX; startW = isHidden() ? 0 : currentWidth(); last = startW;
    sep.setPointerCapture(e.pointerId);
    root.setAttribute('data-builder-drag', '');
  });
  sep.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = startW + (e.clientX - startX);
    last = w;
    if (w < SNAP) { if (!isHidden()) root.setAttribute('data-builder-snap', ''); return; }
    root.removeAttribute('data-builder-snap');
    if (isHidden()) showBuilder();
    setWidth(w, { save: false });
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { sep.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    root.removeAttribute('data-builder-drag'); root.removeAttribute('data-builder-snap');
    if (last < SNAP) { applyWidth(state.w ?? null); hideBuilder({ focus: false }); return; }   // reopens at its last width
    setWidth(last);
  };
  sep.addEventListener('pointerup', end);
  sep.addEventListener('pointercancel', end);
  sep.addEventListener('dblclick', () => { if (isHidden()) showBuilder(); resetWidth(); });
  sep.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const w = currentWidth();
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (w - step < MIN) hideBuilder(); else setWidth(w - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (isHidden()) showBuilder(); else setWidth(w + step); }
    else if (e.key === 'Home') { e.preventDefault(); setWidth(MIN); }
    else if (e.key === 'End') { e.preventDefault(); setWidth(maxWidth()); }
    else if (e.key === 'Enter') { e.preventDefault(); toggleBuilder(); }
  });
}

/** Adds the hide button, the resize edge and the hidden-state rail to the (re)rendered Builder pane. */
export function mountBuilderPane(setup, main) {
  setupEl = setup; mainEl = main;
  const head = setup.querySelector('.st-setup-head');
  if (head && !head.querySelector('.st-builder-hide')) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'st-iconbtn st-builder-hide';
    b.setAttribute('aria-label', 'Hide the Builder'); b.setAttribute('aria-controls', 'st-setup');
    b.title = `Hide the Builder (${SHORTCUT})`; b.innerHTML = ICON_HIDE;
    b.addEventListener('click', () => hideBuilder());
    head.append(b);
  }
  if (!setup.querySelector('.st-rail')) {
    const r = document.createElement('button');
    r.type = 'button'; r.className = 'st-rail';
    r.setAttribute('aria-label', 'Show the Builder'); r.setAttribute('aria-controls', 'st-setup');
    r.title = `Show the Builder (${SHORTCUT})`;
    r.innerHTML = `<span class="st-glyph st-glyph-kd" aria-hidden="true"><img class="st-kd-logo" src="../dashboard/logo.svg" alt="" width="16" height="11"></span>${ICON_SHOW}<span class="st-rail-label">Builder</span><i class="st-rail-dot" aria-hidden="true"></i><span class="st-sr st-rail-sr"></span>`;
    r.addEventListener('click', () => showBuilder({ focus: true }));
    setup.prepend(r);
  }
  if (main && !main.querySelector(':scope > .st-split')) {   // a grid item of .st-main: the pane's paint containment would clip it
    const s = document.createElement('div');
    s.className = 'st-split'; s.tabIndex = 0;
    s.setAttribute('role', 'separator'); s.setAttribute('aria-orientation', 'vertical'); s.setAttribute('aria-controls', 'st-setup');
    s.setAttribute('aria-label', 'Resize the Builder');
    s.title = 'Drag to resize · double-click to reset';
    wireSplit(s);
    main.append(s);
  }
  // a new Builder message while it is hidden: a dot on the rail (not a pop-open; the person chose to hide it)
  logObs?.disconnect();
  const log = setup.querySelector('#st-log');
  if (log) {
    logObs = new MutationObserver((recs) => {
      if (!isHidden()) return;
      if (recs.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && n.matches?.('.st-msg-a')))) {
        const rail = setup.querySelector('.st-rail');
        rail?.setAttribute('data-unread', '');
        const sr = rail?.querySelector('.st-rail-sr'); if (sr) sr.textContent = ' · new message';
      }
    });
    logObs.observe(log, { childList: true });
  }
  syncAria();
}

// state from the pre-paint script; clamp a stored width that no longer fits this window
if (state.w && desktop.matches) requestAnimationFrame(() => { if (mainEl && state.w > maxWidth()) setWidth(maxWidth(), { save: false }); });
addEventListener('resize', () => { if (state.w && desktop.matches && mainEl) setWidth(Math.min(state.w, maxWidth()), { save: false }); else syncAria(); }, { passive: true });
addEventListener('keydown', (e) => {
  if (e.key === '\\' && (e.metaKey || e.ctrlKey) && !e.altKey && desktop.matches) { e.preventDefault(); toggleBuilder(); }
});

// KnowBot Studio: the one shared state store and event bus (owner B; contract: SPEC 3.3).
//
// Every module reads state with getState() and writes only the keys it owns (see the state shape below).
// Cross-module effects happen only through emit()/on() and the card registry. Nothing here touches the DOM.
//
// Exports (exact, SPEC 3.3): getState, setState, on, once, emit, registerCard, renderCard, hydrate, persist,
// mark, FILE_HUES. Additive helpers (B may add; existing signatures never change): off, listenerCount,
// hasCard, setCardContext, resetTrialState, STORAGE_KEY.

export const FILE_HUES = 8;                 // hue index = order % 8 -> CSS var(--f{i})
export const STORAGE_KEY = 'kb-studio:v1';

const DEFAULT_SPEC = () => ({
  name: 'SampleBot', avatar: { initials: 'SB', hue: 0 }, org: '', purpose: '', audience: 'customers',
  tone: 'friendly', length: 'normal', greeting: '', instructions: '', starters: [], floor: 0.70,
  sources: {}, sampleSet: null, version: 1,
});

const DEFAULT_MILESTONES = () => ({
  firstFile: 0, firstReady: 0, ownFile: 0, firstCited: 0, firstRefusal: 0, proofRun: 0,
  emailOffered: 0, launchShown: 0, launched: 0,
});

function initialState() {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  return {
    config: null,                                                        // B
    trial: { id: null, token: null, expiresAt: null, status: 'idle',
             quota: { bytes: 104857600, fileBytes: 99614720 }, converted: false, email: null },   // B
    usage: { bytes: 0, files: 0 },                                       // D
    spec: DEFAULT_SPEC(),                                                // B only (others emit 'spec:request')
    files: {},                                                           // D: { [localId]: FileState }
    fileOrder: [],                                                       // D
    step: 'purpose',                                                     // B
    milestones: DEFAULT_MILESTONES(),                                    // via mark()
    thread: [],                                                          // C: AnswerState[]
    proof: { status: 'idle', rows: [], score: null },                    // C
    setup: { messages: [], busy: false, chips: [] },                     // B
    versions: [],                                                        // B
    ui: { theme: (root && root.getAttribute('data-theme')) || 'light',
          motion: (root && root.getAttribute('data-motion')) || 'full',
          view: 'bot', tab: 'setup', badges: { setup: 0, bot: 0 }, mapPinned: false,
          mapCollapsed: false, drawer: null /* C */, sheet: null /* E */, specOpen: false },  // B except drawer/sheet
  };
}

let state = Object.freeze(initialState());
const handlers = new Map();          // type -> Set<fn>
const cards = new Map();             // card type -> render
let cardCtx = null;

/** Frozen top-level snapshot. Treat nested objects as read-only too. */
export function getState() { return state; }

/**
 * Shallow-merge top-level keys. `patch` may be fn(state) -> patch.
 * Emits 'change:<key>' for each key whose value changed (by identity), then 'state' {reason, keys}.
 */
export function setState(patch, reason = '') {
  const p = typeof patch === 'function' ? patch(state) : patch;
  if (!p || typeof p !== 'object') return state;
  const prev = state;
  const keys = [];
  for (const k of Object.keys(p)) if (prev[k] !== p[k]) keys.push(k);
  if (!keys.length) return state;
  state = Object.freeze({ ...prev, ...p });
  for (const k of keys) emit('change:' + k, { value: state[k], prev: prev[k], reason });
  emit('state', { reason, keys });
  if (keys.some((k) => k === 'trial' || k === 'ui' || k === 'milestones')) persist();
  return state;
}

/** Subscribe. `type` may be '*' (handler(type, detail)). Returns unsubscribe. */
export function on(type, handler) {
  if (typeof handler !== 'function') return () => {};
  let set = handlers.get(type);
  if (!set) handlers.set(type, (set = new Set()));
  set.add(handler);
  return () => off(type, handler);
}

export function off(type, handler) {
  const set = handlers.get(type);
  if (set) set.delete(handler);
}

export function once(type, handler) {
  const un = on(type, (...args) => { un(); handler(...args); });
  return un;
}

/** Number of listeners for a type (excluding '*'). Lets B fall back when an owner module is missing. */
export function listenerCount(type) {
  const set = handlers.get(type);
  return set ? set.size : 0;
}

/** Synchronous fan-out; handler errors are caught and logged, never thrown into the emitter. */
export function emit(type, detail = {}) {
  const set = handlers.get(type);
  if (set) for (const h of [...set]) {
    try { h(detail); } catch (err) { console.error(`[studio] handler for "${type}" failed`, err); }
  }
  const all = handlers.get('*');
  if (all) for (const h of [...all]) {
    try { h(type, detail); } catch (err) { console.error('[studio] "*" handler failed', err); }
  }
}

// ------------------------------------------------------------------ card registry

/** render(data, el, ctx) -> void | {update(data), destroy()} */
export function registerCard(type, render) {
  if (typeof render !== 'function') return;
  cards.set(type, render);
  emit('card:registered', { type });   // B's chat log re-renders cards that arrived before their module loaded
}

export function hasCard(type) { return cards.has(type); }

/** B calls this once with the module context so card renderers receive ctx. */
export function setCardContext(ctx) { cardCtx = ctx; }

/** Unknown type -> renders nothing + console.warn (returns null). */
export function renderCard(type, data, el) {
  const render = cards.get(type);
  if (!render) { console.warn(`[studio] no renderer registered for card "${type}"`); return null; }
  try { return render(data || {}, el, cardCtx) || null; }
  catch (err) { console.error(`[studio] card "${type}" failed to render`, err); return null; }
}

// ------------------------------------------------------------------ persistence

let persistTimer = 0;

/** Reads localStorage 'kb-studio:v1' into trial/ui/milestones (never throws). */
export function hydrate() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const ui = { ...state.ui };
  if (root) {
    ui.theme = root.getAttribute('data-theme') || ui.theme;
    ui.motion = root.getAttribute('data-motion') || ui.motion;
  }
  const patch = { ui };
  if (saved && typeof saved === 'object') {
    const t = saved.trial || {};
    if (typeof t.id === 'string' && typeof t.token === 'string') {
      patch.trial = { ...state.trial, id: t.id, token: t.token, expiresAt: t.expiresAt || null, status: 'idle' };
    }
    if (saved.ui && typeof saved.ui === 'object') {
      if (saved.ui.view === 'proof' || saved.ui.view === 'bot') ui.view = saved.ui.view;
      ui.mapPinned = !!saved.ui.mapPinned;
    }
    if (saved.milestones && typeof saved.milestones === 'object') {
      const m = DEFAULT_MILESTONES();
      for (const k of Object.keys(m)) if (Number.isFinite(saved.milestones[k])) m[k] = saved.milestones[k];
      patch.milestones = m;
    }
  }
  // Hydration must not write back immediately (no 'trial' change yet means nothing to persist anyway).
  const prev = state;
  state = Object.freeze({ ...prev, ...patch });
  for (const k of Object.keys(patch)) if (prev[k] !== state[k]) emit('change:' + k, { value: state[k], prev: prev[k], reason: 'hydrate' });
  emit('state', { reason: 'hydrate', keys: Object.keys(patch) });
  return state;
}

/** Writes {trial:{id,token,expiresAt}, ui:{view,mapPinned}, milestones} (debounced 300 ms). */
export function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writeNow, 300);
}

function writeNow() {
  const s = state;
  const data = {
    trial: { id: s.trial.id, token: s.trial.token, expiresAt: s.trial.expiresAt },
    ui: { view: s.ui.view, mapPinned: s.ui.mapPinned },
    milestones: s.milestones,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* private mode: in-memory only */ }
}

if (typeof window !== 'undefined') {
  // Never lose the last write to the debounce on navigation (checkout redirect, reload).
  window.addEventListener('pagehide', () => { if (persistTimer) { clearTimeout(persistTimer); writeNow(); } });
}

/** Sets milestones[name] = Date.now() once; emits 'milestone' {name}. Returns true the first time. */
export function mark(milestone) {
  if (!milestone || state.milestones[milestone]) return false;
  setState({ milestones: { ...state.milestones, [milestone]: Date.now() } }, 'mark:' + milestone);
  emit('milestone', { name: milestone });
  return true;
}

/** B only: forget the trial (expired / start a new bot). Keeps config and ui preferences. */
export function resetTrialState() {
  const fresh = initialState();
  setState({
    trial: fresh.trial, usage: fresh.usage, spec: fresh.spec, files: {}, fileOrder: [], step: 'purpose',
    milestones: fresh.milestones, thread: [], proof: fresh.proof, setup: fresh.setup, versions: [],
    ui: { ...state.ui, drawer: null, sheet: null, specOpen: false, badges: { setup: 0, bot: 0 } },
  }, 'reset');
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// KnowBot Studio: the bots this browser has opened (the "Your bots" list in the header menu).
//
// There are no accounts in the Studio: a bot is reached with its bearer token, which lives only in this browser's
// localStorage. The store keeps the one bot that is open (kb-studio:v1); this registry remembers every bot the browser
// has opened so the owner can go back to one. An entry holds the same secrets as the single-bot blob (token, restore
// key), so it has the same rules: localStorage only, never in a URL, never in the DOM, never logged.
//
// The list functions are pure (a list in, a new list out) and are unit-tested (scripts/test/bots.test.mjs).
// readBots / writeBots are the only parts that touch storage, and never throw.

export const BOTS_KEY = 'kb-studio-bots:v1';
export const BOTS_MAX = 20;
const ID_RE = /^tr_[a-z2-7]{16}$/;
const MILESTONES = ['firstFile', 'firstReady', 'ownFile', 'firstCited', 'firstRefusal', 'proofRun', 'emailOffered', 'launchShown', 'launched'];

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One clean entry, or null when it cannot open a bot (no id or no token). Unknown fields are dropped. */
export function cleanBot(e) {
  if (!e || typeof e !== 'object' || !ID_RE.test(String(e.id || '')) || typeof e.token !== 'string' || !e.token) return null;
  const out = {
    id: e.id, name: str(e.name, 120), token: e.token, restoreKey: str(e.restoreKey, 400) || null,
    expiresAt: typeof e.expiresAt === 'string' && e.expiresAt ? e.expiresAt : null,
    converted: e.converted === true, seenAt: Number.isFinite(e.seenAt) && e.seenAt > 0 ? e.seenAt : 0,
  };
  const a = e.avatar;
  if (a && typeof a === 'object') out.avatar = { initials: str(a.initials, 2), hue: Number.isFinite(a.hue) ? Math.abs(Math.trunc(a.hue)) % 8 : 0 };
  if (e.milestones && typeof e.milestones === 'object') {
    out.milestones = {};
    for (const k of MILESTONES) out.milestones[k] = Number.isFinite(e.milestones[k]) && e.milestones[k] > 0 ? e.milestones[k] : 0;
  }
  return out;
}

/** A stored list made safe: bad entries dropped, one entry per bot (the most recently seen wins), capped. */
export function cleanBots(list) {
  const byId = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const e = cleanBot(raw);
    if (!e) continue;
    const had = byId.get(e.id);
    if (!had || e.seenAt >= had.seenAt) byId.set(e.id, e);
  }
  return capBots([...byId.values()]);
}

/** At most `max` entries: the least recently seen are dropped. The one in `keepId` (the open bot) is never dropped. */
export function capBots(list, max = BOTS_MAX, keepId = null) {
  if (list.length <= max) return list;
  const keep = new Set([...list].sort((a, b) => (b.id === keepId) - (a.id === keepId) || b.seenAt - a.seenAt).slice(0, Math.max(1, max)).map((e) => e.id));
  return list.filter((e) => keep.has(e.id));
}

/**
 * Add or update one bot. Fields left undefined in `patch` keep what the entry already had (a boot that knows the
 * token but not yet the name must not blank the name). Sets seenAt = now. Returns a new list.
 */
export function upsertBot(list, patch, now = Date.now()) {
  if (!patch || !ID_RE.test(String(patch.id || ''))) return list;
  const prev = list.find((e) => e.id === patch.id) || {};
  const merged = { ...prev };
  for (const k of Object.keys(patch)) if (patch[k] !== undefined) merged[k] = patch[k];
  merged.seenAt = now;
  const e = cleanBot(merged);
  if (!e) return list;
  return capBots([...list.filter((x) => x.id !== e.id), e], BOTS_MAX, e.id);
}

/** Forget one bot (deleted, expired, not found). Returns the same list when it was not there. */
export function removeBot(list, id) {
  return list.some((e) => e.id === id) ? list.filter((e) => e.id !== id) : list;
}

/** The order the menu shows: live bots first, then bots not launched; within each, most recently seen first. */
export function sortBots(list) {
  return [...list].sort((a, b) => (b.converted === true) - (a.converted === true) || b.seenAt - a.seenAt || (a.id < b.id ? -1 : 1));
}

/** The name to show for an entry. The server's placeholder name never reaches the screen. */
export function botLabel(e, current = false) {
  const n = e && e.name;
  return n && n !== 'SampleBot' ? n : current ? 'Your bot' : 'Unnamed bot';
}

/** True when the two lists would be stored the same, ignoring seenAt (so an unchanged bot does not rewrite storage on every state change). */
export function sameBots(a, b) {
  const strip = (l) => JSON.stringify(l.map((e) => ({ ...e, seenAt: 0 })));
  return a.length === b.length && strip(a) === strip(b);
}

function storageOf(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** The remembered bots (clean, capped). Never throws; an unreadable or foreign value is an empty list. */
export function readBots(storage) {
  const st = storageOf(storage);
  if (!st) return [];
  let saved = null;
  try { saved = JSON.parse(st.getItem(BOTS_KEY) || 'null'); } catch { saved = null; }
  if (!saved || typeof saved !== 'object' || saved.v !== 1) return [];
  return cleanBots(saved.bots);
}

/** Store the list. Returns false when storage is blocked (private mode): the list then lasts for this visit only. */
export function writeBots(list, storage) {
  const st = storageOf(storage);
  if (!st) return false;
  try {
    if (!list.length) st.removeItem(BOTS_KEY);
    else st.setItem(BOTS_KEY, JSON.stringify({ v: 1, bots: cleanBots(list) }));
    return true;
  } catch { return false; }
}

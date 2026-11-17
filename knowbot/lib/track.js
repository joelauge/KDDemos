// Link tags and click reporting, shared by the server (server/leads.mjs) and every chat surface in the browser
// (lib/widget.js, lib/voice-mode.js). Pure ESM, no imports, runs in Node and in a page.
// site/overlay.js is a classic script that cannot import: it carries its own small copy between its
// "track:begin" / "track:end" markers, kept in step by server/test/attribution.test.mjs (the parity test).
//
// What a tracked link looks like (the same convention as links a bot sends by text or email):
//   utm_source=knowbot  utm_medium=<webchat|homepage|voice|sms|email|…>  utm_campaign=<bot id>
//   utm_content=<product_chat|source_chat|link_chat|…>  kb_cid=<click id>
// The utm_* tags say "this visit came from the bot" to the site's own analytics and identify nobody. kb_cid is a
// random id for ONE link of ONE answer (12 characters: the answer's 10-character id + 2 characters derived from the
// link), so a click and a later order can be tied to the answer and the product. It is left out, and no click is
// reported, when the visitor's browser sends Global Privacy Control or Do Not Track.

export const UTM_SOURCE = 'knowbot';
export const CID_PARAM = 'kb_cid';
export const CLICK_ID_RE = /^[a-z0-9]{6,20}$/;
/** utm_content of a link clicked inside a chat surface, by what the link is. */
export const CHAT_CONTENT = Object.freeze({ product: 'product_chat', source: 'source_chat', link: 'link_chat' });
const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * The link with the tracking parameters appended. Only http(s) links change. The existing query string and #hash are
 * kept byte for byte (a cart permalink's `attributes%5Bcall%5D=…` is never re-encoded); utm_* are added only when the link
 * has none of its own (an owner's own campaign tags win), kb_cid only when it has none, so appending twice is a no-op.
 */
export function appendTracking(url, { source = UTM_SOURCE, medium = 'webchat', campaign = 'bot', content = '', cid = '' } = {}) {
  const s = String(url ?? '').trim();
  let u;
  try { u = new URL(s); } catch { return s; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s;
  const hashAt = s.indexOf('#');
  const head = hashAt >= 0 ? s.slice(0, hashAt) : s, hash = hashAt >= 0 ? s.slice(hashAt) : '';
  const has = (k) => u.searchParams.has(k);
  const add = [];
  if (!['utm_source', 'utm_medium', 'utm_campaign'].some(has)) {
    add.push(['utm_source', source], ['utm_medium', medium], ['utm_campaign', campaign]);
    if (content && !has('utm_content')) add.push(['utm_content', content]);
  }
  if (cid && !has(CID_PARAM)) add.push([CID_PARAM, cid]);
  const q = add.filter(([, v]) => v != null && String(v) !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  if (!q) return s;
  const sep = !head.includes('?') ? '?' : /[?&]$/.test(head) ? '' : '&';
  return `${head}${sep}${q}${hash}`;
}

/** Two characters derived from a link (FNV-1a over its text): the same link always gets the same two. */
export function linkSuffix(url) {
  const s = String(url ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return B32[h & 31] + B32[(h >>> 5) & 31];
}
/** The click id of one link of one answer: the answer's id + the link's two characters ('' without an answer id). */
export const linkClickId = (base, url) => (base && CLICK_ID_RE.test(String(base)) ? `${base}${linkSuffix(url)}` : '');

/** True when the browser asks not to be tracked: Global Privacy Control, or Do Not Track. */
export function privacySignal(nav = globalThis.navigator, win = globalThis.window) {
  try {
    if (nav?.globalPrivacyControl === true || nav?.globalPrivacyControl === '1') return true;
    const dnt = nav?.doNotTrack ?? win?.doNotTrack ?? nav?.msDoNotTrack;
    return dnt === '1' || dnt === 'yes' || dnt === 1;
  } catch { return false; }
}

/**
 * One link of an answer as the visitor should get it. `track` is what the server sent with the answer
 * ({ medium, campaign, cid? }); null (tracking off for this bot) leaves the link alone. → { href, cid }
 */
export function chatLink(url, kind, track, { privacy = privacySignal() } = {}) {
  if (!track || !track.medium) return { href: url, cid: '' };
  const cid = privacy ? '' : linkClickId(track.cid, url);
  return { href: appendTracking(url, { medium: track.medium, campaign: track.campaign || 'bot', content: CHAT_CONTENT[kind] || CHAT_CONTENT.link, cid }), cid };
}

/** Reports one click without holding the navigation: sendBeacon, else a keep-alive fetch. Never throws. */
export function sendClick(endpoint, data) {
  try {
    const body = JSON.stringify(data);
    // a plain string body is sent as text/plain: no preflight, and it survives the page being left
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(endpoint, body)) return true;
    if (typeof fetch === 'function') { fetch(endpoint, { method: 'POST', body, keepalive: true, credentials: 'omit', mode: 'cors' }).catch(() => {}); return true; }
  } catch { /* tracking never breaks a link */ }
  return false;
}

/**
 * Tags the outgoing links under `root` and reports their clicks. `kinds` is a list of [selector, kind]; the first
 * selector a link matches names its kind (product | source | link). The link stays a normal <a target="_blank">, so a
 * click, a middle-click and "open in a new tab" all carry the tags; click and middle-click are also reported to
 * `endpoint` (POST {cid, url, kind}). Links already tagged, non-http(s) links and links matching `skip` are left alone.
 */
export function trackLinks(root, track, { endpoint = '', kinds = [['a[href]', 'link']], skip = null, privacy = privacySignal() } = {}) {
  if (!root || !track || !track.medium) return 0;
  let n = 0;
  for (const [selector, kind] of kinds) {
    for (const a of root.querySelectorAll(selector)) {
      const url = a.getAttribute('href') || '';
      if (a.dataset.kbTracked || !/^https?:\/\//i.test(url) || (skip && a.matches(skip))) continue;
      const { href, cid } = chatLink(url, kind, track, { privacy });
      a.dataset.kbTracked = kind;
      a.setAttribute('href', href);
      n++;
      if (!cid || !endpoint) continue;
      const report = (e) => { if (e.type === 'click' || e.button === 1) sendClick(endpoint, { cid, url, kind }); };
      a.addEventListener('click', report);
      a.addEventListener('auxclick', report);
    }
  }
  return n;
}

// ------------------------------------------------------------------ the landing page: remember the click id
export const CID_KEY = 'kb_cid';
export const CID_AT_KEY = 'kb_cid_at';
/**
 * On a page that was opened from a chat link (…?kb_cid=<id>): keeps the click id in this site's own localStorage (not a
 * cookie, never sent anywhere by itself) so the order-confirmation page can report the sale (site/sale.js). The newest
 * click replaces the older one (last click wins). Nothing is kept when the browser asks not to be tracked.
 */
export function rememberClickId(loc = globalThis.location, storage = null, { privacy = privacySignal(), now = Date.now() } = {}) {
  try {
    const cid = new URLSearchParams(loc?.search || '').get(CID_PARAM) || '';
    if (!CLICK_ID_RE.test(cid) || privacy) return null;
    const st = storage || globalThis.localStorage;
    st.setItem(CID_KEY, cid);
    st.setItem(CID_AT_KEY, String(now));
    return cid;
  } catch { return null; }
}

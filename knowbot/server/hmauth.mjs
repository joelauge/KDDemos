// Admin sign-in through host-manager (KnowDrive Home & Office): verifies the Function Access Token (FAT) host-manager
// puts in Authorization when it proxies a signed-in browser to KnowBot, against host-manager's JWKS. The same
// contract KnowDB verifies on the box (issuer, audience = this backend's origin, asymmetric keys, required exp).
// Off unless KNOWBOT_AUTH_ISSUER, KNOWBOT_AUTH_AUDIENCE and KNOWBOT_AUTH_JWKS_URL are all set (createHmAuth → null).
// node:crypto only. See SPEC.md "Auth behind host-manager".
import { createPublicKey, verify as verifySig } from 'node:crypto';

export const LEEWAY_S = 30;            // host-manager's own cache skew (fatCacheTTLSkew)
const MAX_LIFETIME_S = 300 + LEEWAY_S; // a FAT lives 5 min; anything longer (a token exchange, 1 h) is not a FAT
const REFRESH_MS = 15 * 60000;         // KnowDB parity
const MISS_REFRESH_MS = 30000;         // an unknown kid refreshes at most this often
const JWKS_MAX_BYTES = 64 * 1024;
const AUTH_MAX = 8192;
const BROWSER = new Set(['local', 'oidc']); // host-manager's browser-session methods (isBrowserSession); oauth2 grants nothing
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const B64U = /^[A-Za-z0-9_-]+$/;

const json64 = (s) => { try { const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

/** kdex Dominates(held, "knowbot:*:<verb>"): only a wildcard or empty resource name covers it; verb or "all". */
export function grants(entitlements, verb) {
  return entitlements.some((e) => {
    const s = e.split(':');
    if (s[0] !== 'knowbot') return false;
    if (s.length === 2) return s[1] === verb || s[1] === 'all';
    return s.length === 3 && (s[1] === '*' || s[1] === '') && (s[2] === verb || s[2] === 'all');
  });
}

/**
 * @param {{ env: object, fetch?: Function, now?: () => number, log?: Function }} o
 * @returns {null | { issuer, audience, origin, start, refresh, verify, looksLikeFat, close }}
 */
export function createHmAuth({ env = {}, fetch: fetchFn = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) {
  const issuer = String(env.KNOWBOT_AUTH_ISSUER || ''), audience = String(env.KNOWBOT_AUTH_AUDIENCE || ''), jwksUrl = String(env.KNOWBOT_AUTH_JWKS_URL || '');
  const set = [issuer, audience, jwksUrl].filter(Boolean).length;
  if (!set) return null;
  if (set !== 3) throw new Error('KNOWBOT_AUTH_ISSUER, KNOWBOT_AUTH_AUDIENCE and KNOWBOT_AUTH_JWKS_URL must be set together');
  let origin, ju;
  try { origin = new URL(issuer).origin; ju = new URL(jwksUrl); } catch { throw new Error('KNOWBOT_AUTH_ISSUER and KNOWBOT_AUTH_JWKS_URL must be absolute URLs'); }
  // keys over plain HTTP only from this machine; never userinfo in the URL
  if (ju.username || ju.password || !(ju.protocol === 'https:' || (ju.protocol === 'http:' && LOOPBACK.has(ju.hostname)))) {
    throw new Error('KNOWBOT_AUTH_JWKS_URL must be https:, or http: to 127.0.0.1, ::1 or localhost');
  }

  let keys = new Map(); // kid → KeyObject (a Map: a kid of "__proto__" never resolves to anything)
  let inflight = null, lastMiss = -Infinity, timer = null;

  async function load() {
    const res = await fetchFn(jwksUrl, { redirect: 'error', signal: AbortSignal.timeout(2000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') || 0) > JWKS_MAX_BYTES) throw new Error('JWKS too large');
    const parts = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > JWKS_MAX_BYTES) throw new Error('JWKS too large'); parts.push(c); }
    const doc = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const next = new Map(); let skipped = 0;
    for (const k of Array.isArray(doc?.keys) ? doc.keys : []) {
      const ok = k && typeof k.kid === 'string' && k.kid && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string'
        && (k.alg === undefined || k.alg === 'ES256') && (k.use === undefined || k.use === 'sig');
      if (!ok) { skipped++; continue; }
      try { next.set(k.kid, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, format: 'jwk' })); } catch { skipped++; }
    }
    if (!next.size) throw new Error(`no ES256 key in the JWKS (${skipped} skipped)`);
    keys = next;
    log(`[auth] jwks: ${next.size} key(s)${skipped ? `, ${skipped} skipped (not ES256)` : ''}`);
  }
  /** Fetch the JWKS; a failure keeps the last good set (a host-manager restart never signs everyone out). */
  function refresh() {
    if (!inflight) inflight = load().catch((e) => { log(`[auth] jwks refresh failed, keeping ${keys.size} key(s): ${e.message}`); }).finally(() => { inflight = null; });
    return inflight;
  }

  /** A Bearer shaped like a JWT (three segments, JSON header with a string alg). Cheap; nothing is verified. */
  function candidate(req) {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) return null;
    const tok = auth.slice(7), seg = tok.split('.');
    if (seg.length !== 3) return null;
    const header = tok.length <= AUTH_MAX && B64U.test(seg[0]) ? json64(seg[0]) : null;
    if (tok.length > AUTH_MAX) return { tok, seg, header: null, tooLong: true };
    return header && typeof header.alg === 'string' ? { tok, seg, header } : null;
  }

  /**
   * Synchronous on purpose: an async gate called without await at any call site would admit the caller.
   * @returns {null | { ok: true, sub, exp, admin, reader, why? } | { ok: false, sub?, why }}  null: no FAT in the request
   */
  function verify(req) {
    const c = candidate(req);
    if (!c) return null;
    const deny = (why, sub) => ({ ok: false, why, ...(sub ? { sub } : {}) });
    if (c.tooLong) return deny('too_long');
    const h = c.header;
    if ('crit' in h) return deny('crit');
    if (h.alg !== 'ES256') return deny('alg'); // before any key lookup: no alg confusion
    if (typeof h.kid !== 'string' || !h.kid) return deny('kid');
    const key = keys.get(h.kid);
    if (!key) {
      if (now() - lastMiss >= MISS_REFRESH_MS) { lastMiss = now(); refresh(); }
      return deny('unknown_kid');
    }
    if (!B64U.test(c.seg[1]) || !B64U.test(c.seg[2])) return deny('signature');
    const sig = Buffer.from(c.seg[2], 'base64url');
    if (sig.length !== 64 || !verifySig('sha256', Buffer.from(`${c.seg[0]}.${c.seg[1]}`), { key, dsaEncoding: 'ieee-p1363' }, sig)) return deny('signature');
    const p = json64(c.seg[1]);
    if (!p) return deny('payload');
    const sub = typeof p.sub === 'string' && p.sub ? p.sub : '';
    const t = now() / 1000;
    if (p.iss !== issuer) return deny('iss', sub);
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(audience)) return deny('aud', sub);
    if (typeof p.exp !== 'number' || !Number.isFinite(p.exp) || t > p.exp + LEEWAY_S) return deny('exp', sub);
    if (typeof p.iat !== 'number' || !Number.isFinite(p.iat) || p.iat > t + LEEWAY_S) return deny('iat', sub);
    if (p.exp - p.iat > MAX_LIFETIME_S) return deny('lifetime', sub);
    if (p.nbf !== undefined && (typeof p.nbf !== 'number' || p.nbf > t + LEEWAY_S)) return deny('nbf', sub);
    if (!sub) return deny('sub');
    if ('act' in p) return deny('act', sub); // a token exchange result, never a FAT host-manager minted for this request
    const ok = { ok: true, sub, exp: p.exp };
    if (!BROWSER.has(p.auth_method)) return { ...ok, admin: false, reader: false, why: 'auth_method' };
    const ents = p.entitlements === undefined ? [] : p.entitlements;
    if (!Array.isArray(ents) || ents.some((e) => typeof e !== 'string')) return { ...ok, admin: false, reader: false, why: 'entitlements' };
    const admin = grants(ents, 'admin');
    return { ...ok, admin, reader: admin || grants(ents, 'read') };
  }

  return {
    issuer, audience, origin,
    start() { refresh(); if (!timer) { timer = setInterval(refresh, REFRESH_MS); timer.unref?.(); } },
    refresh, verify,
    looksLikeFat: (req) => !!candidate(req),
    close() { clearInterval(timer); timer = null; },
  };
}

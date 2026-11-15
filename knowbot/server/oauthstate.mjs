// Sealed, single-use OAuth `state` shared by every sign-in popup the Studio opens (server/kdaccount.mjs for KnowDrive,
// server/crm/oauth.mjs for the CRM connectors): PKCE (RFC 7636), a hash of the trial's bearer, and a state that is
// AES-GCM sealed under the server secret, expires, and can be consumed once. Nothing here ever reaches the browser
// except the opaque state string.
import { createHash, randomBytes } from 'node:crypto';
import { sealKey, openKey } from './providers.mjs';

export const b64u = (b) => Buffer.from(b).toString('base64url');
export const sha256u = (s) => createHash('sha256').update(String(s)).digest('base64url');
/** A short hash of the trial's bearer: the state is bound to the browser session that started the sign-in. */
export const bearerHash = (bearer) => sha256u(`knowbot-kd-bearer\n${bearer || ''}`).slice(0, 22);
/** PKCE (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: sha256u(verifier) };
}
export const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i;
export const STATE_TTL_MS = 15 * 60000;

/**
 * A state sealer for one kind of sign-in. `key` is the sealing key (derive it from the server secret with a label so
 * a KnowDrive state can never be replayed on a CRM callback); makeError(message) builds the caller's own error type.
 * A state is an object with at least {t: trial id, v: PKCE verifier}; seal() adds {n: nonce, e: expiry ms}.
 */
export function createStateSealer({ key, now = () => Date.now(), makeError = (m) => new Error(m), service = 'sign-in' } = {}) {
  const used = new Map(); // nonce → expiry
  const bad = (what) => makeError(`This ${service} ${what}. Start again from KnowBot Studio.`);
  /** data gets a nonce and an expiry (15 minutes, capped by `expiresAt`). */
  function seal(data, { expiresAt = null } = {}) {
    return sealKey(JSON.stringify({ ...data, n: b64u(randomBytes(12)), e: Math.min(now() + STATE_TTL_MS, Number(expiresAt) || Infinity) }), key);
  }
  /** Opens a state without consuming it (callback errors still need the trial and origin). */
  function peek(state) {
    let d;
    try { d = JSON.parse(openKey(String(state || ''), key)); } catch { throw bad('link is not valid'); }
    if (!d || typeof d !== 'object' || !d.t || !d.n || !d.v) throw bad('link is not valid');
    if (!(Number(d.e) > now())) throw makeError(`This ${service} took too long. Start again from KnowBot Studio.`);
    return d;
  }
  function consume(state) {
    const d = peek(state);
    for (const [n, e] of used) if (e < now()) used.delete(n);
    if (used.has(d.n)) throw bad('link was already used');
    used.set(d.n, Number(d.e));
    return d;
  }
  return { seal, peek, consume };
}

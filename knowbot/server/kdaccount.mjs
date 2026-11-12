// KnowDrive accounts for launched bots: the OAuth 2.0 client (authorization code + PKCE S256, dynamic client
// registration), the delegated tokens (refresh token sealed at rest, access tokens cached in memory only) and the
// customer's owned vector store. server/trials.mjs drives the flow for a Studio bot; the launched bot then answers
// from the customer's own store through `client()` on every surface.
//
// Verified live against knowdrive.ai (2026-11-12):
//   GET /.well-known/oauth-authorization-server → authorization_endpoint /-/oauth/authorize, token_endpoint /-/token,
//     registration_endpoint /-/oauth/register (DCR; POST only), code_challenge_methods_supported [S256],
//     grant_types authorization_code + refresh_token (+ others), scopes openid email profile entitlements roles.
//     No revocation_endpoint is advertised: unlink revokes when one appears, else it forgets the sealed token.
//   GET /.well-known/oauth-protected-resource → resource /api/v1/mcp, scopes [functions:/api/v1/mcp:read].
//   OpenAPI (/-/openapi): GET /v1/users/me {id (uuid), email, …}; GET /tenant/v1/stores [{id, owner, role, plan, …}]
//     ("vector stores the caller owns or is a member of"); GET /api/v1/vector_stores is scoped server-side to the
//     caller's own stores; GET /api/v1/files/{id}/content streams a file's bytes; POST /api/v1/ingest
//     (x-vector-store-id) writes.
// Assumed (not verifiable without creating an account): the authorization-code grant returns a refresh_token for the
// requested scopes; the user's access token carries their own entitlements (functions:/api/v1/* and
// vector_stores:<owned store>:*) so it can read and write their owned store; the owned store is the one /tenant/v1/stores
// reports with owner:true (a new free account has exactly one). See discover() for the fallbacks.
//
// Tokens never leave the server: the browser only ever sees a sealed `state` and the callback's ok/error page.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sealKey, openKey } from './providers.mjs';

export class KdError extends Error {
  /** code: reconnect | bad_state | denied | upstream | no_store | not_configured */
  constructor(code, message, status = 502) { super(message); this.name = 'KdError'; this.code = code; this.status = status; }
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256u = (s) => createHash('sha256').update(String(s)).digest('base64url');
export const bearerHash = (bearer) => sha256u(`knowbot-kd-bearer\n${bearer || ''}`).slice(0, 22);
/** PKCE (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: sha256u(verifier) };
}
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i;
const STATE_TTL_MS = 15 * 60000;
const REFRESH_MARGIN_MS = 60000;

/**
 * @param {{ env?: object, secret: string, log?: Function, now?: () => number, dataDir?: string, fetch?: Function }} o
 */
export function createKdAccount(o = {}) {
  const env = o.env || {};
  const log = o.log || (() => {});
  const now = o.now || (() => Date.now());
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const secret = String(o.secret || 'knowbot-local-dev');
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  // KNOWBOT_KD_AUTH_URL: the KnowDrive authorization server (default production); KNOWBOT_KD_API_URL: the KnowDrive API
  // the customer's store lives on (default: the same host, as in production).
  const authBase = trim(env.KNOWBOT_KD_AUTH_URL || 'https://knowdrive.ai');
  const apiBase = trim(env.KNOWBOT_KD_API_URL || authBase);
  const mode = String(env.KNOWBOT_KD_ACCOUNTS || '').toLowerCase();
  const ownerMode = String(env.KNOWBOT_MODE || '').toLowerCase() === 'owner';
  /** Required unless turned off (KNOWBOT_KD_ACCOUNTS=off) or the owner's own deployment (KNOWBOT_MODE=owner). */
  const required = !ownerMode && !['off', '0', 'false', 'no'].includes(mode);
  const scope = String(env.KNOWBOT_KD_SCOPE || 'openid email profile entitlements').trim();
  const clientName = String(env.KNOWBOT_KD_CLIENT_NAME || 'KnowBot');
  const pinnedClient = env.KNOWBOT_KD_CLIENT_ID ? { client_id: String(env.KNOWBOT_KD_CLIENT_ID), ...(env.KNOWBOT_KD_CLIENT_SECRET ? { client_secret: String(env.KNOWBOT_KD_CLIENT_SECRET) } : {}) } : null;
  const clientFile = o.dataDir ? path.join(o.dataDir, 'kd-clients.json') : null;
  const stateKey = `${secret}\nknowbot-kd-state`;
  const tokenKey = `${secret}\nknowbot-kd-refresh`;

  // ------------------------------------------------------------------ metadata + client registration (cached)
  let meta = null, metaAt = 0, metaLoading = null;
  async function metadata() {
    if (meta && now() - metaAt < 3600000) return meta;
    metaLoading ||= (async () => {
      try {
        const r = await doFetch(`${authBase}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new KdError('upstream', `KnowDrive sign-in metadata: HTTP ${r.status}`);
        const j = await r.json();
        if (!j.authorization_endpoint || !j.token_endpoint) throw new KdError('upstream', 'KnowDrive sign-in metadata is incomplete');
        if (Array.isArray(j.code_challenge_methods_supported) && !j.code_challenge_methods_supported.includes('S256')) throw new KdError('upstream', 'KnowDrive sign-in does not offer PKCE S256');
        meta = j; metaAt = now();
        return j;
      } catch (e) { throw e instanceof KdError ? e : new KdError('upstream', `KnowDrive sign-in is unreachable (${e.name === 'TimeoutError' ? 'timed out' : e.message})`); }
      finally { metaLoading = null; }
    })();
    return metaLoading;
  }
  const clients = new Map(); // `${authBase} ${redirectUri}` → { client_id, client_secret? }
  let clientsLoaded = false;
  async function loadClients() {
    if (clientsLoaded || !clientFile) { clientsLoaded = true; return; }
    clientsLoaded = true;
    try {
      const doc = JSON.parse(await fsp.readFile(clientFile, 'utf8'));
      for (const [k, v] of Object.entries(doc || {})) {
        if (!v?.client_id) continue;
        let client_secret;
        try { client_secret = v.sealedSecret ? openKey(v.sealedSecret, tokenKey) : undefined; } catch { continue; } // sealed with another secret: register again
        clients.set(k, { client_id: v.client_id, ...(client_secret ? { client_secret } : {}) });
      }
    } catch { /* none yet */ }
  }
  async function saveClients() {
    if (!clientFile) return;
    const doc = Object.fromEntries([...clients].map(([k, v]) => [k, { client_id: v.client_id, ...(v.client_secret ? { sealedSecret: sealKey(v.client_secret, tokenKey) } : {}) }]));
    try { await fsp.mkdir(path.dirname(clientFile), { recursive: true }); await fsp.writeFile(clientFile, JSON.stringify(doc, null, 2)); } catch (e) { log(`[kd] could not save the client registration: ${e.message}`); }
  }
  const registering = new Map();
  /** The OAuth client for a redirect URI: KNOWBOT_KD_CLIENT_ID when pinned, else registered once (DCR) and cached. */
  async function clientFor(redirectUri) {
    if (pinnedClient) return pinnedClient;
    await loadClients();
    const key = `${authBase} ${redirectUri}`;
    if (clients.has(key)) return clients.get(key);
    if (!registering.has(key)) {
      registering.set(key, (async () => {
        const m = await metadata();
        if (!m.registration_endpoint) throw new KdError('not_configured', 'KnowDrive offers no client registration; set KNOWBOT_KD_CLIENT_ID', 503);
        const r = await doFetch(m.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.client_id) throw new KdError('upstream', `KnowDrive client registration: HTTP ${r.status} ${String(j.error_description || j.error || '').slice(0, 160)}`);
        const c = { client_id: String(j.client_id), ...(j.client_secret ? { client_secret: String(j.client_secret) } : {}) };
        clients.set(key, c);
        await saveClients();
        log(`[kd] registered the KnowBot client with ${authBase} for ${redirectUri}`);
        return c;
      })().finally(() => registering.delete(key)));
    }
    return registering.get(key);
  }

  // ------------------------------------------------------------------ state (sealed, single use)
  const usedNonces = new Map(); // nonce → expiry
  function sealState(data) { return sealKey(JSON.stringify(data), stateKey); }
  /** Opens a state without consuming it (callback errors still need the trial and origin). */
  function peekState(state) {
    let d;
    try { d = JSON.parse(openKey(String(state || ''), stateKey)); } catch { throw new KdError('bad_state', 'This sign-in link is not valid. Start again from KnowBot Studio.', 400); }
    if (!d || typeof d !== 'object' || !d.t || !d.n || !d.v) throw new KdError('bad_state', 'This sign-in link is not valid. Start again from KnowBot Studio.', 400);
    if (!(Number(d.e) > now())) throw new KdError('bad_state', 'This sign-in took too long. Start again from KnowBot Studio.', 400);
    return d;
  }
  function consumeState(state) {
    const d = peekState(state);
    for (const [n, e] of usedNonces) if (e < now()) usedNonces.delete(n);
    if (usedNonces.has(d.n)) throw new KdError('bad_state', 'This sign-in link was already used. Start again from KnowBot Studio.', 400);
    usedNonces.set(d.n, Number(d.e));
    return d;
  }

  /**
   * Starts a sign-in for a trial: → { url } (the KnowDrive authorize page). The state is sealed (AES-GCM) and carries
   * the trial, a hash of its bearer, the Studio origin for the popup's message, the redirect URI and the PKCE verifier.
   * mode 'signup' asks the sign-in page to open on "Create account" (screen_hint; servers that don't know it ignore it).
   */
  async function start({ trialId, bearer, origin, redirectUri, mode: m = 'signup', expiresAt = null }) {
    const md = await metadata();
    const client = await clientFor(redirectUri);
    const { verifier, challenge } = pkcePair();
    const st = sealState({ t: trialId, bh: bearerHash(bearer), o: ORIGIN_RE.test(String(origin || '')) ? origin : null, r: redirectUri, v: verifier,
      n: b64u(randomBytes(12)), e: Math.min(now() + STATE_TTL_MS, Number(expiresAt) || Infinity), m: m === 'signin' ? 'signin' : 'signup' });
    const u = new URL(md.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', client.client_id);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', scope);
    u.searchParams.set('state', st);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (m !== 'signin') u.searchParams.set('screen_hint', 'signup');
    return { url: u.toString() };
  }

  async function tokenCall(params, client) {
    const md = await metadata();
    const body = new URLSearchParams({ ...params, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) });
    let r;
    try { r = await doFetch(md.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw new KdError('upstream', `KnowDrive token request failed (${e.name === 'TimeoutError' ? 'timed out' : e.message})`); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const grant = ['invalid_grant', 'invalid_token', 'unauthorized_client', 'invalid_client'].includes(j.error) || r.status === 401;
      throw new KdError(grant ? 'reconnect' : 'upstream', `KnowDrive token request: HTTP ${r.status} ${String(j.error || '').slice(0, 40)}`, grant ? 401 : 502);
    }
    if (!j.access_token) throw new KdError('upstream', 'KnowDrive returned no access token');
    return j;
  }

  /** An authenticated JSON GET against the customer's KnowDrive (null on 404 or an unknown route). */
  async function getJson(base, p, access) {
    const r = await doFetch(`${base}${p}`, { headers: { authorization: `Bearer ${access}`, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (r.status === 401) throw new KdError('reconnect', 'KnowDrive refused the sign-in', 401);
    if (!r.ok) return null;
    return r.json().catch(() => null);
  }
  /**
   * Who signed in and which vector store they own: GET /v1/users/me (fallback GET /-/state), then the owned store from
   * GET /tenant/v1/stores (owner:true; fallback GET /api/v1/vector_stores, the caller's own stores). Several owned
   * stores: the oldest-listed free one, else the first (logged), since a fresh account owns exactly one.
   */
  async function discover(access, idClaims = {}) {
    const me = (await getJson(apiBase, '/v1/users/me', access)) || (await getJson(authBase, '/-/state', access)) || {};
    const account = String(me.id || me.sub || idClaims.sub || '').trim();
    const email = String(me.email || idClaims.email || '').trim() || null;
    if (!account) throw new KdError('upstream', 'KnowDrive did not say who signed in');
    const listed = await getJson(apiBase, '/tenant/v1/stores', access);
    const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
    let owned = rows.filter((s) => s && s.id && (s.owner === true || s.role === 'owner'));
    let storeId = null;
    if (owned.length) {
      const pick = owned.find((s) => s.plan === 'free') || owned[0];
      if (owned.length > 1) log(`[kd] account owns ${owned.length} stores; using ${pick.id}`);
      storeId = pick.id;
    } else {
      const vs = await getJson(apiBase, '/api/v1/vector_stores?limit=100', access);
      owned = (Array.isArray(vs?.data) ? vs.data : []).filter((s) => s && s.id && s.id !== 'system');
      const mine = owned.filter((s) => email && String(s.created_by || '').toLowerCase().includes(email.toLowerCase()));
      storeId = (mine[0] || (owned.length === 1 ? owned[0] : null))?.id || null;
    }
    if (!storeId) throw new KdError('no_store', 'Your KnowDrive account has no file store yet. Open KnowDrive once, then try again.', 409);
    return { account, email, store: String(storeId) };
  }
  const claimsOf = (idToken) => { try { return JSON.parse(Buffer.from(String(idToken || '').split('.')[1] || '', 'base64url').toString('utf8')) || {}; } catch { return {}; } };

  /**
   * The callback: consumes the state, exchanges the code (server side), finds the account and its owned store.
   * → { state: {t, bh, o, …}, link: { account, email, store, sealed, scope, authBase, apiBase, linkedAt }, access }
   */
  async function finish({ state, code }) {
    const d = consumeState(state);
    if (!code) throw new KdError('denied', 'Sign-in was cancelled.', 400);
    const client = await clientFor(d.r);
    const tok = await tokenCall({ grant_type: 'authorization_code', code: String(code), redirect_uri: d.r, code_verifier: d.v }, client);
    if (!tok.refresh_token) throw new KdError('upstream', 'KnowDrive returned no refresh token, so KnowBot could not stay signed in');
    const who = await discover(tok.access_token, claimsOf(tok.id_token));
    const link = { ...who, sealed: sealKey(tok.refresh_token, tokenKey), scope: tok.scope || scope, authBase, apiBase, clientRedirect: d.r, linkedAt: new Date(now()).toISOString(), status: 'linked' };
    return { state: d, link, access: { token: tok.access_token, exp: now() + Math.max(30, Number(tok.expires_in) || 300) * 1000 } };
  }

  // ------------------------------------------------------------------ delegated access (refresh as needed)
  const cache = new Map();     // link key → { token, exp }
  const inflight = new Map();  // link key → Promise<token>
  function prime(key, access) { if (access?.token) cache.set(key, access); }
  /**
   * An access token for a link, refreshed when it is about to expire (single flight per link). onRotate(sealed) is
   * called when KnowDrive rotates the refresh token. A refresh KnowDrive refuses → KdError('reconnect').
   */
  async function accessFor(key, link, { force = false, onRotate } = {}) {
    if (!link?.sealed) throw new KdError('reconnect', 'KnowDrive is not connected', 401);
    const c = cache.get(key);
    if (!force && c && c.exp - REFRESH_MARGIN_MS > now()) return c.token;
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        let refresh;
        try { refresh = openKey(link.sealed, tokenKey); } catch { throw new KdError('reconnect', 'The saved KnowDrive sign-in cannot be read (the server secret changed)', 401); }
        const client = await clientFor(link.clientRedirect || env.KNOWBOT_KD_REDIRECT_URI || '');
        const tok = await tokenCall({ grant_type: 'refresh_token', refresh_token: refresh }, client);
        cache.set(key, { token: tok.access_token, exp: now() + Math.max(30, Number(tok.expires_in) || 300) * 1000 });
        if (tok.refresh_token && tok.refresh_token !== refresh) {
          const sealed = sealKey(tok.refresh_token, tokenKey);
          link.sealed = sealed;
          try { await onRotate?.(sealed); } catch (e) { log(`[kd] saving a rotated sign-in failed: ${e.message}`); }
        }
        return tok.access_token;
      })().finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }
  function forget(key) { cache.delete(key); }

  /** Revokes the refresh token where KnowDrive advertises a revocation endpoint (RFC 7009); best effort. */
  async function revoke(link) {
    if (!link?.sealed) return false;
    try {
      const md = await metadata();
      if (!md.revocation_endpoint) return false;
      const client = await clientFor(link.clientRedirect || '');
      const r = await doFetch(md.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ token: openKey(link.sealed, tokenKey), token_type_hint: 'refresh_token', client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) }) });
      return r.ok;
    } catch (e) { log(`[kd] revoke failed: ${e.message}`); return false; }
  }

  /**
   * A fetch bound to the customer's store: Authorization from accessFor (one forced refresh and retry on a 401).
   * hooks.onRotate(sealed) persists a rotated refresh token; hooks.onReconnect(err) flags the link.
   */
  function client(key, link, hooks = {}) {
    const base = trim(link.apiBase || apiBase);
    async function call(p, init = {}) {
      const { timeout = 30000, signal, headers, ...rest } = init;
      const go = async (force) => {
        const token = await accessFor(key, link, { force, onRotate: hooks.onRotate });
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
        return doFetch(`${base}${p}`, { ...rest, headers: { ...(headers || {}), authorization: `Bearer ${token}` }, signal: sig });
      };
      try {
        let res = await go(false);
        if (res.status === 401) { forget(key); res = await go(true); }
        if (res.status === 401) throw new KdError('reconnect', 'KnowDrive refused the saved sign-in', 401);
        return res;
      } catch (e) {
        if (e instanceof KdError && e.code === 'reconnect') { forget(key); try { hooks.onReconnect?.(e); } catch { /* never mask */ } }
        throw e;
      }
    }
    return { base, store: link.store, account: link.account, fetch: call, token: () => accessFor(key, link, { onRotate: hooks.onRotate }) };
  }

  return { authBase, apiBase, required, scope, metadata, clientFor, start, finish, peekState, discover, accessFor, prime, forget, revoke, client, bearerHash };
}

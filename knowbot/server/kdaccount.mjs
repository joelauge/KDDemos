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
// vector_stores:<owned store>:*) so it can read and write their owned store.
// NOT assumed any more: that /tenant/v1/stores' owner flag is the truth. In production a store another tenant had merely
// shared with the account was taken for the account's own and written to. So no store is ever picked here: the owner
// chooses one (server/trials.mjs, POST …/kd/store), and classifyStore() below only decides what may be offered.
//
// Tokens never leave the server: the browser only ever sees a sealed `state` and the callback's ok/error page.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sealKey, openKey } from './providers.mjs';
import { bearerHash, pkcePair, createStateSealer, ORIGIN_RE } from './oauthstate.mjs';

export { bearerHash, pkcePair };

export class KdError extends Error {
  /** code: reconnect | bad_state | denied | upstream | not_configured */
  constructor(code, message, status = 502) { super(message); this.name = 'KdError'; this.code = code; this.status = status; }
}

// ------------------------------------------------------------------ whose store is it? (pure; unit tested)
const lc = (v) => String(v ?? '').trim().toLowerCase();
const OWNER_ROLES = new Set(['owner']);
const SHARED_MARKERS = ['shared', 'is_shared', 'shared_with_me', 'invited', 'is_invited', 'guest', 'is_guest', 'external', 'is_external'];
const SHARED_BY_FIELDS = ['shared_by', 'shared_from', 'invited_by', 'shared_by_email', 'invited_by_email'];
const OWNER_REF_FIELDS = ['owner_id', 'owner_user_id', 'owner_account_id', 'owner_email', 'created_by', 'created_by_id', 'created_by_email', 'creator', 'creator_id', 'creator_email', 'user_id'];
const IDENTITY_RE = /@|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Every id or email a value names: a string ("bearer:a@b.co", a uuid) or an object ({ id, email, … }). */
function refsOf(v) {
  if (v == null || typeof v === 'boolean') return [];
  if (typeof v === 'object') return ['id', 'email', 'user_id', 'sub', 'account_id'].flatMap((k) => refsOf(v[k]));
  const s = lc(v);
  if (!s) return [];
  const out = new Set([s]);
  for (const part of s.split(/[\s:|,;<>()]+/)) if (part) out.add(part);
  return [...out];
}
/**
 * What may KnowBot offer for one store? One small pure function, so it can be corrected when the real shape of
 * KnowDrive's rows is known (their field names are logged the first time, see logShape).
 *
 *   input   { tenant: the row from GET /tenant/v1/stores (or null), vector: the row from GET /api/v1/vector_stores
 *             (or null), vectorListed: whether that second list came back with anything, me: { id, email, tenant_id? } }
 *   output  { ownership: 'owned' | 'shared' | 'unconfirmed', reasons: string[] }
 *
 * Rules, most cautious first:
 *   says owner   the tenant row has owner === true (the boolean) or is_owner === true, or role is "owner".
 *   says other   anything that names someone else or marks a share:
 *                  owner === false / is_owner === false; a role that is not "owner"; a truthy shared / invited /
 *                  guest / external marker; a shared_by / invited_by value; an owner or creator id or e-mail (on either
 *                  row, or inside an `owner` object) that is not this account's id or e-mail (free text such as
 *                  created_by: "system" names nobody and is ignored); a tenant / organization
 *                  id that differs from the account's own (only when the account record carries one); the store missing
 *                  from the account's own vector-store list while that list is not empty.
 *   owned        says owner, and nothing says other.
 *   shared       does not say owner, and something says other. Never offered.
 *   unconfirmed  everything else: the flags are missing (no tenant row, or a row with no owner flag and no role), or
 *                they are mixed (says owner AND something says other). Offered only behind the extra confirmation.
 */
export function classifyStore({ tenant = null, vector = null, vectorListed = false, me = {} } = {}) {
  const t = tenant && typeof tenant === 'object' ? tenant : null;
  const v = vector && typeof vector === 'object' ? vector : null;
  const mine = new Set([lc(me.id), lc(me.sub), lc(me.email)].filter(Boolean));
  const yes = [], no = [];
  if (t) {
    if (t.owner === true) yes.push('owner flag');
    if (t.is_owner === true) yes.push('is_owner flag');
    if (typeof t.role === 'string' && OWNER_ROLES.has(lc(t.role))) yes.push('role owner');
    if (t.owner === false || t.is_owner === false) no.push('owner flag is false');
    if (t.role != null && !(typeof t.role === 'string' && OWNER_ROLES.has(lc(t.role)))) no.push('role is not owner');
    if (t.owner != null && typeof t.owner !== 'boolean') {
      // only the boolean is a flag. "true" / 1 is unclear (neither yes nor no: not confirmed); a name, an id or an
      // object says who owns it, not that the caller does
      const word = lc(t.owner);
      if (['false', 'no', '0'].includes(word)) no.push('owner flag is false');
      else if (!['true', 'yes', '1'].includes(word)) {
        const refs = refsOf(t.owner);
        if (refs.some((r) => mine.has(r))) yes.push('owner names this account'); else no.push('owner names another account');
      }
    }
  }
  for (const [what, row] of [['tenant', t], ['vector', v]]) {
    if (!row) continue;
    for (const k of SHARED_MARKERS) if (row[k] === true || (typeof row[k] === 'string' && row[k] && !['false', 'no', '0', 'none'].includes(lc(row[k])))) no.push(`${k} marker`);
    for (const k of SHARED_BY_FIELDS) if (row[k] != null && row[k] !== '' && row[k] !== false) no.push(`${k} is set`);
    for (const k of OWNER_REF_FIELDS) {
      const refs = refsOf(row[k]);
      // free text ("system", a key's label) names nobody: only an e-mail, a uuid, an *_id field or an object counts
      const names = typeof row[k] === 'object' || /_(?:id|email)$/.test(k) || refs.some((r) => IDENTITY_RE.test(r));
      if (refs.length && names && mine.size && !refs.some((r) => mine.has(r))) no.push(`${what} ${k} names another account`);
    }
    const myTenant = lc(me.tenant_id ?? me.tenant?.id ?? me.organization_id ?? me.org_id);
    const theirs = lc(row.tenant_id ?? row.tenant?.id ?? row.organization_id ?? row.org_id);
    if (myTenant && theirs && myTenant !== theirs) no.push(`${what} row is in another tenant`);
  }
  if (t && !v && vectorListed) no.push("not in the account's own store list");
  const reasons = [...new Set([...yes.map((r) => `+ ${r}`), ...no.map((r) => `- ${r}`)])];
  if (yes.length && !no.length) return { ownership: 'owned', reasons };
  if (!yes.length && no.length) return { ownership: 'shared', reasons };
  return { ownership: 'unconfirmed', reasons: reasons.length ? reasons : ['no ownership fields'] };
}
/** The field names (and value types) of a row, for the log: "id:string owner:true role=owner plan:string". No values. */
export function shapeOf(row) {
  return Object.keys(row || {}).sort().slice(0, 60).map((k) => {
    const v = row[k];
    if (typeof v === 'boolean') return `${k}:${v}`;
    if (k === 'role' && typeof v === 'string' && /^[a-z_-]{1,24}$/i.test(v)) return `role=${v.toLowerCase()}`;
    return `${k}:${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`;
  }).join(' ');
}

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
  /**
   * The client a link's sign-in was issued to. A refresh token only works with that client, and a registered client is
   * otherwise remembered in a local file that a restart loses, so every link carries its own (the secret sealed).
   */
  const clientOfLink = async (link) => {
    if (link?.client?.client_id) {
      let client_secret;
      try { client_secret = link.client.sealedSecret ? openKey(link.client.sealedSecret, tokenKey) : undefined; } catch { client_secret = undefined; }
      return { client_id: String(link.client.client_id), ...(client_secret ? { client_secret } : {}) };
    }
    return clientFor(link?.clientRedirect || env.KNOWBOT_KD_REDIRECT_URI || '');
  };
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
  // server/oauthstate.mjs: sealed (AES-GCM), expiring, single use
  const states = createStateSealer({ key: stateKey, now, service: 'sign-in', makeError: (m) => new KdError('bad_state', m, 400) });
  const peekState = (state) => states.peek(state);
  const consumeState = (state) => states.consume(state);

  /**
   * Starts a sign-in for a trial: → { url } (the KnowDrive authorize page). The state is sealed (AES-GCM) and carries
   * the trial, a hash of its bearer, the Studio origin for the popup's message, the redirect URI and the PKCE verifier.
   * mode 'signup' asks the sign-in page to open on "Create account" (screen_hint; servers that don't know it ignore it).
   */
  async function start({ trialId, bearer, origin, redirectUri, mode: m = 'signup', expiresAt = null }) {
    const md = await metadata();
    const client = await clientFor(redirectUri);
    const { verifier, challenge } = pkcePair();
    const st = states.seal({ t: trialId, bh: bearerHash(bearer), o: ORIGIN_RE.test(String(origin || '')) ? origin : null, r: redirectUri, v: verifier,
      m: m === 'signin' ? 'signin' : 'signup' }, { expiresAt });
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
  /** The account that signed in: GET /v1/users/me (fallback GET /-/state). → the raw record (never logged). */
  async function whoAmI(access, idClaims = {}) {
    const me = (await getJson(apiBase, '/v1/users/me', access)) || (await getJson(authBase, '/-/state', access)) || {};
    const account = String(me.id || me.sub || idClaims.sub || '').trim();
    const email = String(me.email || idClaims.email || '').trim() || null;
    if (!account) throw new KdError('upstream', 'KnowDrive did not say who signed in');
    return { account, email, me };
  }
  // The real shape of a store row is not known for sure (see classifyStore): the first time each shape is seen, its
  // field NAMES and value types go to the log (never a value, apart from true/false and the role word).
  const seenShapes = new Set();
  function logShape(what, row) {
    if (!row || typeof row !== 'object') return;
    const sig = `${what} ${shapeOf(row)}`;
    if (seenShapes.has(sig) || seenShapes.size > 40) return;
    seenShapes.add(sig);
    log(`[kd] ${what} fields: ${shapeOf(row)}`);
  }
  /**
   * Signing in links the ACCOUNT only: who signed in, and the stores KnowDrive lists for them, each classified
   * (classifyStore). No store is ever picked here: the owner chooses one in the Launch dialog (server/trials.mjs).
   * → { account, email, stores: [{ id, name, plan, ownership: 'owned'|'shared'|'unconfirmed', reasons }] }
   */
  async function discover(access, idClaims = {}) {
    const { account, email, me } = await whoAmI(access, idClaims);
    logShape('account', me);
    const listed = await getJson(apiBase, '/tenant/v1/stores', access);
    const tenantRows = (Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : Array.isArray(listed?.stores) ? listed.stores : []).filter((r) => r && typeof r === 'object' && r.id);
    const vs = await getJson(apiBase, '/api/v1/vector_stores?limit=100', access);
    const vsRows = (Array.isArray(vs?.data) ? vs.data : Array.isArray(vs) ? vs : []).filter((r) => r && typeof r === 'object' && r.id && r.id !== 'system');
    if (tenantRows[0]) logShape('tenant store row', tenantRows[0]);
    if (vsRows[0]) logShape('vector store row', vsRows[0]);
    const vsById = new Map(vsRows.map((r) => [String(r.id), r]));
    const ids = [...new Set([...tenantRows.map((r) => String(r.id)), ...vsRows.map((r) => String(r.id))])];
    const tenantById = new Map(tenantRows.map((r) => [String(r.id), r]));
    const stores = ids.map((id) => {
      const t = tenantById.get(id) || null, v = vsById.get(id) || null;
      const c = classifyStore({ tenant: t, vector: v, vectorListed: vsRows.length > 0, me: { ...me, id: account, email } });
      const name = String(t?.display_name || t?.name || v?.display_name || v?.name || id).trim().slice(0, 120) || id;
      return { id, name, plan: typeof t?.plan === 'string' ? t.plan.slice(0, 40) : null, ownership: c.ownership, reasons: c.reasons };
    });
    return { account, email, stores };
  }
  const claimsOf = (idToken) => { try { return JSON.parse(Buffer.from(String(idToken || '').split('.')[1] || '', 'base64url').toString('utf8')) || {}; } catch { return {}; } };

  /**
   * The callback: consumes the state, exchanges the code (server side) and finds the account. The link carries NO
   * store: the owner chooses one afterwards (link.store, link.storeName, link.storeChosenAt are set by that choice).
   * → { state: {t, bh, o, …}, link: { account, email, store: null, sealed, scope, authBase, apiBase, linkedAt }, access, stores }
   */
  async function finish({ state, code }) {
    const d = consumeState(state);
    if (!code) throw new KdError('denied', 'Sign-in was cancelled.', 400);
    const client = await clientFor(d.r);
    const tok = await tokenCall({ grant_type: 'authorization_code', code: String(code), redirect_uri: d.r, code_verifier: d.v }, client);
    if (!tok.refresh_token) throw new KdError('upstream', 'KnowDrive returned no refresh token, so KnowBot could not stay signed in');
    const who = await whoAmI(tok.access_token, claimsOf(tok.id_token));
    const link = { account: who.account, email: who.email, store: null, sealed: sealKey(tok.refresh_token, tokenKey), scope: tok.scope || scope, authBase, apiBase, clientRedirect: d.r, linkedAt: new Date(now()).toISOString(), status: 'linked',
      client: { client_id: client.client_id, ...(client.client_secret ? { sealedSecret: sealKey(client.client_secret, tokenKey) } : {}) } };
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
        const client = await clientOfLink(link);
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
      const client = await clientOfLink(link);
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
    const self = { base, store: link.store || null, account: link.account, fetch: call, token: () => accessFor(key, link, { onRotate: hooks.onRotate }),
      /** The same sign-in pointed at another of the account's stores (the store step: counting files, the write check). */
      forStore: (id) => ({ ...self, store: String(id) }) };
    return self;
  }
  /** The account's stores right now, with the owner's sign-in (classified; nothing is chosen). */
  async function stores(key, link, hooks = {}) {
    const go = async (force) => discover(await accessFor(key, link, { force, onRotate: hooks.onRotate }));
    try {
      try { return await go(false); }
      catch (e) { if (!(e instanceof KdError) || e.code !== 'reconnect') throw e; forget(key); return await go(true); }
    } catch (e) {
      if (e instanceof KdError && e.code === 'reconnect') { forget(key); try { hooks.onReconnect?.(e); } catch { /* never mask */ } }
      throw e instanceof KdError ? e : new KdError('upstream', `KnowDrive did not list your stores (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
  }

  return { authBase, apiBase, required, scope, metadata, clientFor, start, finish, peekState, discover, stores, accessFor, prime, forget, revoke, client, bearerHash };
}

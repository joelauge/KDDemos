// What the OAuth connectors share: the token call (authorization code and refresh), the retry-once-on-401 wrapper,
// and the app credentials from the environment. The sealed, single-use `state` is server/oauthstate.mjs (the same
// code the KnowDrive sign-in uses); server/crm/index.mjs binds it to the trial and its bearer.
import { CrmError, call, scrub, clip } from './http.mjs';

/** The OAuth app for a connector from the environment (KNOWBOT_<CRM>_CLIENT_ID / _SECRET), or null. */
export function clientOf(env, id) {
  const k = String(id).toUpperCase();
  const client_id = String(env[`KNOWBOT_${k}_CLIENT_ID`] || '').trim();
  const client_secret = String(env[`KNOWBOT_${k}_CLIENT_SECRET`] || '').trim();
  return client_id && client_secret ? { client_id, client_secret } : null;
}

/**
 * POST to a token endpoint. → the vendor's token JSON. A refused grant → CrmError('auth') (the owner must reconnect).
 * o: { vendor, basic: {client_id, client_secret} (HTTP Basic instead of form fields), secrets: [...] to scrub }
 */
export async function tokenCall(ctx, url, form, { vendor, basic = null, secrets = [] } = {}) {
  const r = await call(ctx.fetch, url, { form, headers: basic ? { authorization: `Basic ${Buffer.from(`${basic.client_id}:${basic.client_secret}`).toString('base64')}` } : {} });
  const j = r.json || {};
  // Zoho answers 200 with {error}; everyone else uses 400/401
  const err = j.error || (r.status >= 400 ? `http_${r.status}` : null);
  if (err) {
    const said = clip(scrub(String(j.error_description || j.message || j.error || ''), [...secrets, ...Object.values(form || {})]), 120);
    if (r.status >= 500) throw new CrmError('upstream', `${vendor} sign-in had a problem on its side (${r.status}).`, { status: r.status });
    if (r.status === 429) throw new CrmError('rate_limited', `${vendor} sign-in is receiving too many requests right now.`, { status: 429 });
    throw new CrmError('auth', `${vendor} did not accept the sign-in${said ? ` (“${said}”)` : ''}.`, { status: r.status === 200 ? 400 : r.status, action: `Reconnect ${vendor}.` });
  }
  if (!j.access_token) throw new CrmError('upstream', `${vendor} sign-in returned no access.`);
  return j;
}

/**
 * Runs fn(accessToken). When the vendor answers 401 on an OAuth connection the access token is refreshed once and
 * the call repeated; a second 401 is the caller's CrmError('auth').
 */
export async function authed(ctx, fn) {
  const t = await ctx.token();
  try { return await fn(t); }
  catch (e) {
    if (!(e instanceof CrmError) || e.code !== 'auth' || e.status !== 401 || ctx.kind !== 'oauth') throw e;
    return fn(await ctx.token(true));
  }
}

/** True when `url` is https on one of the allowed host suffixes (token responses name the API host: never trust it blindly). */
export function hostAllowed(url, suffixes) {
  try {
    const u = new URL(String(url));
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.port && suffixes.some((s) => h === s || h.endsWith(`.${s}`));
  } catch { return false; }
}

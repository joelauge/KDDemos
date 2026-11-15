// CRM connectors: one error type, one JSON caller, one error mapping. Every connector talks to its vendor through
// call(), so timeouts, 401/403/429/5xx handling and secret scrubbing are the same everywhere.
//
// CrmError codes and what the outbox does with them (server/crm/index.mjs):
//   auth          the vendor refused our credentials (401, revoked token, missing scope)  → connection "Needs attention"; retried slowly
//   rate_limited  429 (retryAfterMs from Retry-After when given)                           → retried after that long
//   upstream      5xx                                                                      → retried with backoff
//   network       DNS, TLS, reset, timeout                                                 → retried with backoff
//   invalid       the vendor rejected this record or our mapping (other 4xx)               → dead-lettered at once (retrying cannot help)
//   blocked       the address is not a public https address (webhooks)                     → dead-lettered at once
//   gone          the receiver unsubscribed (410 from a REST hook)                         → the hook is removed
//   config        the connector is not set up on this server                               → dead-lettered at once
export class CrmError extends Error {
  constructor(code, message, { status = null, retryAfterMs = null, action = null } = {}) {
    super(message);
    this.name = 'CrmError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.action = action; // what the owner should do, in plain words
  }
}
export const RETRYABLE = new Set(['auth', 'rate_limited', 'upstream', 'network']);

const clip = (s, n = 200) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Removes every known secret value (and anything shaped like a bearer token) from a string before it is kept or logged. */
export function scrub(text, secrets = []) {
  let s = String(text ?? '');
  for (const x of secrets) if (x && String(x).length >= 6) s = s.split(String(x)).join('[hidden]');
  return s.replace(/\b(Bearer|Zoho-oauthtoken|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]').replace(/([?&](?:api_token|access_token|refresh_token|client_secret|code|key)=)[^&\s"']+/gi, '$1[hidden]');
}
/** Retry-After (seconds or an HTTP date) → ms, capped at an hour; null when absent or unreadable. */
export function retryAfterMs(v, now = Date.now()) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(String(v)) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 3600000) : null;
}

/**
 * One HTTP call to a vendor. → { status, headers, json, text }. Never throws for an HTTP status (use check()); throws
 * CrmError('network') when the request could not be made or timed out.
 * o: { method, headers, json (object → JSON body), form (object → urlencoded body), body, timeoutMs }
 */
export async function call(doFetch, url, o = {}) {
  const headers = { accept: 'application/json', ...(o.headers || {}) };
  let body = o.body;
  if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
  else if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  let res;
  try { res = await doFetch(url, { method: o.method || (body != null ? 'POST' : 'GET'), headers, body, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs || 15000) }); }
  catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new CrmError('network', timeout ? 'It took too long to answer.' : 'It could not be reached.');
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, json, text };
}

/**
 * Turns a vendor response into a CrmError unless it is 2xx. `vendor` is the name shown to the owner; `detail(r)` picks
 * the vendor's own message out of its error body (clipped and scrubbed before it is kept).
 */
export function check(r, { vendor, detail = null, secrets = [], now = Date.now() } = {}) {
  if (r.status >= 200 && r.status < 300) return r;
  let d = '';
  try { d = detail ? detail(r) : ''; } catch { d = ''; }
  d = clip(scrub(d || '', secrets), 160);
  const said = d ? ` ${vendor} said: “${d}”` : '';
  if (r.status === 401) throw new CrmError('auth', `${vendor} no longer accepts this connection.`, { status: 401, action: `Reconnect ${vendor}.` });
  if (r.status === 403) throw new CrmError('auth', `${vendor} did not allow this.${said}`, { status: 403, action: `Check that the ${vendor} user or app you connected may create and edit records, then reconnect.` });
  if (r.status === 429) throw new CrmError('rate_limited', `${vendor} is receiving too many requests right now.`, { status: 429, retryAfterMs: retryAfterMs(r.headers?.get?.('retry-after'), now) });
  if (r.status >= 500) throw new CrmError('upstream', `${vendor} had a problem on its side (${r.status}).`, { status: r.status });
  throw new CrmError('invalid', `${vendor} did not accept this lead.${said}`, { status: r.status, action: `Check the field settings for ${vendor}.` });
}

/** An error → { code, message, action } in plain words (never a stack, a URL with a token, or a secret). */
export function plain(e, vendor = 'The CRM') {
  if (e instanceof CrmError) return { code: e.code, message: e.message, action: e.action || (e.code === 'auth' ? `Reconnect ${vendor}.` : RETRYABLE.has(e.code) ? 'Nothing to do: we will try again.' : null) };
  return { code: 'error', message: 'Something went wrong on our side.', action: 'Try again. If it keeps happening, contact us.' };
}
export { clip };

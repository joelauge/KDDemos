// HTTP for lead delivery (mounted by server/trials.mjs under /api/studio).
//
// Studio (the trial token; nothing here ever returns a secret, only a 4-character hint):
//   GET    /trials/:id/crm                      the connectors, each with its connection, status and counts; Zapier
//   POST   /trials/:id/crm/:c/connect {token | url, config}   a pasted token or a webhook address → {…view, reveal?}
//                                               (reveal: a webhook's signing secret, returned this once only)
//   POST   /trials/:id/crm/:c/oauth {options}   → { url } the vendor's sign-in page for the popup
//   PATCH  /trials/:id/crm/:c {config}          the owner's field settings
//   POST   /trials/:id/crm/:c/test              send a test lead now → { ok, entry }
//   POST   /trials/:id/crm/:c/sync              queue the last 90 days of leads → { queued, already, days }
//   POST   /trials/:id/crm/:c/retry             put failed deliveries back in the queue → { retried }
//   GET    /trials/:id/crm/:c/log               the last 50 deliveries, newest first
//   GET    /trials/:id/crm/:c/lists             the audiences / lists to choose from (Mailchimp, Constant Contact)
//   DELETE /trials/:id/crm/:c                   disconnect (its queue and log go too)
//   POST   /trials/:id/crm/zapier/key           a new Zapier API key for this bot → { key } (shown once; the old one stops)
//   GET    /crm/callback/:c?code&state          the sign-in popup lands here (no trial token: the sealed state names the trial)
//
// Zapier (Authorization: Bearer kb_zap_…, the per-bot key; also accepted as X-API-Key):
//   GET    /zapier/v1/me                        the auth test → { id, name }
//   GET    /zapier/v1/leads?limit=              recent leads, newest first, each with a stable id (polling fallback + samples)
//   POST   /zapier/v1/hooks {hookUrl}           REST hook subscribe → 201 { id }
//   DELETE /zapier/v1/hooks/:id                 REST hook unsubscribe → { ok: true }
import { CrmError } from './http.mjs';

const STATUS = { not_found: 404, invalid: 400, blocked: 400, bad_state: 400, denied: 400, config: 409, auth: 400, rate_limited: 503, upstream: 502, network: 502, gone: 400 };

/**
 * h: { sendJson, readBody, bearer(req), publicBase(req), limit(key, n, ms, what), clientIp(req), page(res, {origin, trialId, ok, …}), log, env }
 */
export function createCrmRoutes(crm, h) {
  const env = h.env || {};
  const redirectUri = (req, id) => `${String(env.KNOWBOT_CRM_REDIRECT_BASE || '').replace(/\/+$/, '') || `${h.publicBase(req)}/api/studio/crm/callback`}/${id}`;
  /** A CrmError → the Studio's error shape. A vendor's own 401 is never passed on as ours (the Studio would think the trial expired). */
  function sendErr(res, e, { connecting = null } = {}) {
    if (!(e instanceof CrmError)) throw e;
    const status = STATUS[e.code] || 502;
    let message = e.message;
    if (connecting && e.code === 'auth') message = `${connecting} did not accept that. Check it and try again.`;
    return h.sendJson(res, status, { error: { status, code: `crm_${e.code}`, message, ...(e.action ? { action: e.action } : {}) } });
  }
  const methodNot = (m) => { throw Object.assign(new Error(`method ${m} not allowed`), { status: 405 }); };

  /** /trials/:id/crm[/<connector>[/<action>]] (T is already authorised). */
  async function trialRoute(req, res, T, conn, action, m) {
    try {
      if (!conn) {
        if (m !== 'GET') methodNot(m);
        return h.sendJson(res, 200, await crm.view(T));
      }
      const id = String(conn).toLowerCase();
      if (!action) {
        if (m === 'PATCH') { const b = await h.readBody(req); await crm.setConfig(T, id, b?.config || {}); return h.sendJson(res, 200, await crm.view(T)); }
        if (m === 'DELETE') { await crm.disconnect(T, id); return h.sendJson(res, 200, await crm.view(T)); }
        methodNot(m);
      }
      if (action === 'log') { if (m !== 'GET') methodNot(m); return h.sendJson(res, 200, await crm.logOf(T, id)); }
      if (action === 'lists') { if (m !== 'GET') methodNot(m); return h.sendJson(res, 200, await crm.listsOf(T, id)); }
      if (m !== 'POST') methodNot(m);
      h.limit(`crm ${T.id}`, 60, 60000, 'connection changes');
      const body = await h.readBody(req).catch(() => ({}));
      if (action === 'connect') {
        let r;
        try { r = await crm.connect(T, id, body || {}, { origin: req.headers.origin }); }
        catch (e) { return sendErr(res, e, { connecting: id === 'webhook' ? 'That address' : 'The vendor' }); }
        return h.sendJson(res, 200, { ...(await crm.view(T)), ...(r.reveal ? { reveal: r.reveal } : {}) });
      }
      if (action === 'oauth') return h.sendJson(res, 200, await crm.oauthStart(T, id, { bearer: h.bearer(req), origin: req.headers.origin, redirectUri: redirectUri(req, id), options: body?.options || {} }));
      if (action === 'test') { h.limit(`crmtest ${T.id}`, 10, 60000, 'test leads'); return h.sendJson(res, 200, await crm.test(T, id)); }
      if (action === 'sync') { h.limit(`crmsync ${T.id}`, 6, 3600000, 'syncs'); return h.sendJson(res, 200, await crm.sync(T, id)); }
      if (action === 'retry') return h.sendJson(res, 200, await crm.retryFailed(T, id));
      if (action === 'key' && id === 'zapier') return h.sendJson(res, 200, await crm.zapier.newKey(T, { origin: req.headers.origin }));
      throw new CrmError('not_found', 'No such endpoint.', { status: 404 });
    } catch (e) { return sendErr(res, e); }
  }

  /** GET /crm/callback/:c: the popup's last stop. It tells the Studio (its own origin only) and closes; never a token. */
  async function callback(req, res, url, id) {
    const state = url.searchParams.get('state') || '';
    let d = null;
    try { d = crm.oauthPeek(state); } catch { d = null; }
    const where = { origin: d?.o || null, trialId: d?.t || null, type: 'knowbot:crm', crm: id };
    try {
      h.limit(`crmcb ${h.clientIp(req)}`, 30, 60000, 'sign-in attempts');
      const err = url.searchParams.get('error');
      if (err) throw new CrmError('denied', err === 'access_denied' ? 'The sign-in was cancelled.' : 'The sign-in did not finish.', { status: 400 });
      await crm.oauthFinish({ id, state, code: url.searchParams.get('code'), query: Object.fromEntries(url.searchParams) });
      return h.page(res, { ...where, ok: true, title: 'Connected', body: 'You can close this window and go back to KnowBot Studio.' });
    } catch (e) {
      const ref = Math.random().toString(16).slice(2, 10);
      h.log(`[crm] sign-in failed ref=${ref} crm=${id}${where.trialId ? ` trial=${where.trialId}` : ''}: ${e?.code || ''} ${String(e?.message || e).slice(0, 160)}`);
      const message = e instanceof CrmError ? e.message : Number(e?.status) === 429 ? e.message : 'Something went wrong.';
      return h.page(res, { ...where, ok: false, code: e?.code || 'error', message, ref, title: "The connection didn't finish" });
    }
  }

  /** /zapier/v1/…: what the Zapier app (integrations/zapier) calls. Errors are JSON {error:{message}} with a real status. */
  async function zapierRoute(req, res, url, parts, m) {
    const json = (status, body) => h.sendJson(res, status, body);
    try {
      h.limit(`zapip ${h.clientIp(req)}`, 240, 60000, 'requests');
      const key = h.bearer(req) || String(req.headers['x-api-key'] || '').trim();
      const T = await crm.zapier.auth(key);
      h.limit(`zap ${T.id}`, 120, 60000, 'requests');
      const [what, sub] = parts;
      if (what === 'me' && !sub) { if (m !== 'GET') methodNot(m); return json(200, crm.zapier.me(T)); }
      if (what === 'leads' && !sub) { if (m !== 'GET') methodNot(m); return json(200, await crm.zapier.recent(T, { limit: url.searchParams.get('limit') })); }
      if (what === 'hooks' && !sub) {
        if (m !== 'POST') methodNot(m);
        const b = await h.readBody(req);
        return json(201, await crm.zapier.subscribe(T, b?.hookUrl || b?.hook_url || b?.target_url || b?.url));
      }
      if (what === 'hooks' && sub) { if (m !== 'DELETE') methodNot(m); return json(200, await crm.zapier.unsubscribe(T, decodeURIComponent(sub))); }
      throw new CrmError('not_found', 'No such endpoint.', { status: 404 });
    } catch (e) {
      if (e instanceof CrmError) { const status = e.code === 'auth' ? 401 : STATUS[e.code] || 502; return json(status, { error: { status, code: e.code, message: e.message } }); }
      throw e;
    }
  }

  return { trialRoute, callback, zapierRoute, redirectUri };
}

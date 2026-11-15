// Pipedrive connector: a lead becomes a Person (found by e-mail, else phone) with an open Lead (or Deal) and a Note.
//
// Endpoints used (Pipedrive API reference, read 2026-11-15):
//   GET  {base}/api/v2/persons/search?term=&fields=email|phone&exact_match=true&limit=1     ("Search persons", API v2)
//   POST {base}/api/v2/persons   {name (required), emails:[{value,primary,label}], phones:[…], owner_id}   ("Add a new person", API v2)
//   POST {base}/api/v1/leads     {title (required), person_id, owner_id}                    ("Add a lead"; a lead id is a uuid; Leads have no v2 create)
//   GET  {base}/api/v2/persons/search … and GET {base}/api/v2/leads/search exist; to find a person's open lead we list:
//   GET  {base}/api/v1/leads?person_id=&archived_status=not_archived&limit=1
//   GET  {base}/api/v2/deals?person_id=&status=open&limit=1 ; POST {base}/api/v2/deals {title, person_id, pipeline_id, stage_id, owner_id}
//   POST {base}/api/v1/notes     {content (HTML), lead_id | deal_id, person_id}
//   GET  {base}/api/v1/users/me  → {data:{name, company_name, company_domain}}
//   Pasted API token: header x-api-token, base https://api.pipedrive.com
//   OAuth: https://oauth.pipedrive.com/oauth/authorize?client_id&redirect_uri&state
//          POST https://oauth.pipedrive.com/oauth/token (HTTP Basic client_id:client_secret; form grant_type=authorization_code,
//          code, redirect_uri | grant_type=refresh_token, refresh_token) → {access_token, refresh_token, expires_in, api_domain}
//          then Authorization: Bearer against api_domain (https://<company>.pipedrive.com), used only when it is a pipedrive.com host.
// NOT verified against the docs (the reference pages did not expand these bodies when read): the exact shape of the
// search response (we read data.items[0].item.id) and of create responses (data.id); the list filters on GET /v1/leads
// and GET /api/v2/deals; the Notes endpoint and the OAuth endpoints (not on the pages we could read; from memory).
// OAuth scopes are chosen in Pipedrive's Developer Hub when the app is registered, not in the authorize URL:
// contacts:full, leads:full, deals:full (for the Deal option), base (users/me).
import { call, check, CrmError } from '../http.mjs';
import { authed, tokenCall, hostAllowed } from '../oauth.mjs';
import { nameOf, noteText } from '../payload.mjs';

const VENDOR = 'Pipedrive';
const OAUTH = (ctx) => ctx.base('oauth', 'https://oauth.pipedrive.com');
const detail = (r) => r.json?.error || r.json?.message || r.json?.error_info || '';
function baseOf(ctx) {
  const fixed = ctx.base('api', null);
  if (fixed) return fixed;
  if (ctx.kind !== 'oauth') return 'https://api.pipedrive.com';
  if (!hostAllowed(ctx.secrets.apiDomain, ['pipedrive.com'])) throw new CrmError('auth', 'Pipedrive did not say where your account lives.', { action: 'Reconnect Pipedrive.' });
  return String(ctx.secrets.apiDomain).replace(/\/+$/, '');
}
async function api(ctx, method, path, json) {
  return authed(ctx, async (token) => {
    const r = await call(ctx.fetch, `${baseOf(ctx)}${path}`, { method, json, headers: ctx.kind === 'oauth' ? { authorization: `Bearer ${token}` } : { 'x-api-token': token } });
    return check(r, { vendor: VENDOR, detail, secrets: [token], now: ctx.now() });
  });
}
async function who(ctx) {
  const r = await api(ctx, 'GET', '/api/v1/users/me');
  const d = r.json?.data || {};
  return { account: d.company_name ? `Pipedrive (${d.company_name})` : 'Pipedrive', extra: d.company_domain && /^[a-z0-9-]{1,60}$/i.test(d.company_domain) ? { company: d.company_domain } : {} };
}

export default {
  id: 'pipedrive',
  name: 'Pipedrive',
  blurb: 'Each lead becomes a person (matched by email, else phone) with a lead in your Leads Inbox and a note.',
  auth: {
    oauth: {},
    token: { label: 'Personal API token', placeholder: 'Your Pipedrive API token', help: 'In Pipedrive: your profile picture, Personal preferences, API. Copy “Your personal API token” and paste it here.' },
  },
  fields: [
    { key: 'object', label: 'Create', type: 'select', default: 'lead', options: [['lead', 'A lead (Leads Inbox)'], ['deal', 'A deal (pipeline)']] },
    { key: 'ownerId', label: 'Owner user ID (optional)', type: 'text', pattern: '^\\d{1,12}$' },
    { key: 'pipelineId', label: 'Pipeline ID for deals (optional)', type: 'text', pattern: '^\\d{1,12}$' },
    { key: 'stageId', label: 'Stage ID for deals (optional)', type: 'text', pattern: '^\\d{1,12}$' },
  ],
  async connect(ctx, input) {
    const token = String(input?.token || '').trim();
    if (!/^[A-Za-z0-9]{20,100}$/.test(token)) throw new CrmError('invalid', 'That does not look like a Pipedrive API token.', { action: 'Copy “Your personal API token” from Personal preferences, API.' });
    const w = await who({ ...ctx, kind: 'token', secrets: {}, token: async () => token });
    return { secrets: { token, ...w.extra }, account: w.account, hint: `…${token.slice(-4)}` };
  },
  oauth: {
    authorizeUrl(ctx, { client, redirectUri, state }) {
      const u = new URL(`${OAUTH(ctx)}/oauth/authorize`);
      u.searchParams.set('client_id', client.client_id);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchange(ctx, { client, code, redirectUri }) {
      const j = await tokenCall(ctx, `${OAUTH(ctx)}/oauth/token`, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, { vendor: VENDOR, basic: client, secrets: [client.client_secret] });
      if (!j.refresh_token) throw new CrmError('upstream', 'Pipedrive did not return a way to stay signed in.');
      if (!ctx.base('api', null) && !hostAllowed(j.api_domain, ['pipedrive.com'])) throw new CrmError('upstream', 'Pipedrive did not say where your account lives.');
      const secrets = { refresh: j.refresh_token, apiDomain: String(j.api_domain || '').replace(/\/+$/, '') };
      const w = await who({ ...ctx, kind: 'oauth', secrets, token: async () => j.access_token }).catch(() => ({ account: 'Pipedrive', extra: {} }));
      return { secrets: { ...secrets, ...w.extra }, access: { token: j.access_token, expiresIn: j.expires_in }, account: w.account };
    },
    async refresh(ctx, { client }) {
      const j = await tokenCall(ctx, `${OAUTH(ctx)}/oauth/token`, { grant_type: 'refresh_token', refresh_token: ctx.secrets.refresh }, { vendor: VENDOR, basic: client, secrets: [client.client_secret, ctx.secrets.refresh] });
      return { access: { token: j.access_token, expiresIn: j.expires_in }, ...(j.refresh_token && j.refresh_token !== ctx.secrets.refresh ? { secrets: { refresh: j.refresh_token } } : {}) };
    },
  },
  async verify(ctx) { return who(ctx); },

  /** progress: { personId, personAction, recordId, action, noted } */
  async deliver(ctx, lead, progress = {}) {
    const c = ctx.config || {};
    const n = nameOf(lead);
    const owner = c.ownerId ? { owner_id: Number(c.ownerId) } : {};
    const deal = c.object === 'deal';
    if (!progress.personId) {
      const term = lead.contact.email || lead.contact.phone;
      const s = await api(ctx, 'GET', `/api/v2/persons/search?term=${encodeURIComponent(term)}&fields=${lead.contact.email ? 'email' : 'phone'}&exact_match=true&limit=1`);
      const hit = s.json?.data?.items?.[0]?.item || null;
      if (hit?.id) { progress.personId = hit.id; progress.personAction = 'updated'; }
      else {
        const r = await api(ctx, 'POST', '/api/v2/persons', { name: n.full.slice(0, 120), ...(lead.contact.email ? { emails: [{ value: lead.contact.email, primary: true, label: 'work' }] } : {}),
          ...(lead.contact.phone ? { phones: [{ value: lead.contact.phone, primary: true, label: 'work' }] } : {}), ...owner });
        progress.personId = r.json?.data?.id; progress.personAction = 'created';
      }
      if (!progress.personId) throw new CrmError('upstream', 'Pipedrive did not say which person it saved.');
    }
    if (!progress.recordId) {
      // a person who already has an open lead (or deal) keeps it: the new question is added to it as a note
      let open = null;
      if (progress.personAction === 'updated') {
        const l = deal ? await api(ctx, 'GET', `/api/v2/deals?person_id=${encodeURIComponent(progress.personId)}&status=open&limit=1`)
          : await api(ctx, 'GET', `/api/v1/leads?person_id=${encodeURIComponent(progress.personId)}&archived_status=not_archived&limit=1`);
        open = l.json?.data?.[0] || null;
      }
      if (open?.id) { progress.recordId = open.id; progress.action = 'updated'; }
      else {
        const title = `${n.full} (${lead.bot.name})`.slice(0, 200);
        const r = deal ? await api(ctx, 'POST', '/api/v2/deals', { title, person_id: Number(progress.personId), ...(c.pipelineId ? { pipeline_id: Number(c.pipelineId) } : {}), ...(c.stageId ? { stage_id: Number(c.stageId) } : {}), ...owner })
          : await api(ctx, 'POST', '/api/v1/leads', { title, person_id: Number(progress.personId), ...owner });
        progress.recordId = r.json?.data?.id; progress.action = 'created';
      }
      if (!progress.recordId) throw new CrmError('upstream', `Pipedrive did not say which ${deal ? 'deal' : 'lead'} it saved.`);
    }
    if (!progress.noted) {
      await api(ctx, 'POST', '/api/v1/notes', { content: noteText(lead, { html: true }), person_id: Number(progress.personId), ...(deal ? { deal_id: Number(progress.recordId) } : { lead_id: String(progress.recordId) }) });
      progress.noted = true;
    }
    const co = ctx.secrets.company;
    return { action: progress.action, recordId: String(progress.recordId), ...(co ? { recordUrl: deal ? `https://${co}.pipedrive.com/deal/${progress.recordId}` : `https://${co}.pipedrive.com/leads/inbox/${progress.recordId}` } : {}) };
  },
};

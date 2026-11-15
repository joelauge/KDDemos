// Salesforce connector: a lead becomes a Lead (found by e-mail, else phone; never duplicated) with a completed Task
// (or a Note) carrying what they asked.
//
// Endpoints used (Salesforce REST API; written from the published REST API Developer Guide and OAuth "web server
// flow" help pages. developer.salesforce.com answered 403 to our reader on 2026-11-15, so these were NOT re-read
// live: treat them as from memory until the owner's first real connection confirms them):
//   GET   {login}/services/oauth2/authorize?response_type=code&client_id&redirect_uri&scope=api refresh_token&state
//         &code_challenge&code_challenge_method=S256          login = https://login.salesforce.com | https://test.salesforce.com (sandbox)
//   POST  {login}/services/oauth2/token   form: grant_type=authorization_code, code, client_id, client_secret, redirect_uri,
//         code_verifier → {access_token, refresh_token, instance_url, id}; grant_type=refresh_token → {access_token, instance_url}
//         (no expires_in: the session timeout is an org setting, so we refresh on a 401)
//   GET   {instance_url}/services/oauth2/userinfo             → {organization_id, preferred_username, name}
//   GET   {instance_url}/services/data/vNN.0/query?q=SELECT Id, Phone, Email FROM Lead WHERE Email = '…' AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 1
//   POST  {instance_url}/services/data/vNN.0/sobjects/Lead    {LastName, Company, Email, Phone, LeadSource, Description, …} → 201 {id, success}
//   PATCH {instance_url}/services/data/vNN.0/sobjects/Lead/{id}                               → 204
//   PATCH {instance_url}/services/data/vNN.0/sobjects/Lead/{ExternalIdField}/{value}          → 201 {id, created:true} | 200/204 (upsert on an external id)
//   POST  {instance_url}/services/data/vNN.0/sobjects/Task    {WhoId, Subject, Description, Status:'Completed', ActivityDate}
//   POST  {instance_url}/services/data/vNN.0/sobjects/Note    {ParentId, Title, Body}
// instance_url comes from the token response and is only used when it is https on a Salesforce domain.
// Errors are an array [{message, errorCode}]; REQUEST_LIMIT_EXCEEDED (403) is treated as a rate limit.
import { call, check, CrmError } from '../http.mjs';
import { authed, tokenCall, hostAllowed } from '../oauth.mjs';
import { nameOf, noteText, noteTitle } from '../payload.mjs';

const VENDOR = 'Salesforce';
export const SCOPES = 'api refresh_token';
const SF_HOSTS = ['salesforce.com', 'force.com', 'cloudforce.com', 'salesforce.mil', 'sfcrmproducts.cn'];
const loginOf = (ctx, sandbox) => ctx.base('login', sandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com');
const versionOf = (ctx) => (/^v\d{2,3}\.0$/.test(String(ctx.env?.KNOWBOT_SALESFORCE_API_VERSION || '')) ? ctx.env.KNOWBOT_SALESFORCE_API_VERSION : 'v62.0');
const detail = (r) => (Array.isArray(r.json) ? r.json[0]?.message : r.json?.error_description || r.json?.message) || '';
/** A SOQL string literal's contents (backslash and quote escaped; control characters dropped). */
export const soql = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function instanceOf(ctx) {
  const inst = ctx.base('instance', null) || ctx.secrets.instance;
  if (!ctx.base('instance', null) && !hostAllowed(inst, SF_HOSTS)) throw new CrmError('auth', 'Salesforce did not say where your org lives.', { action: 'Reconnect Salesforce.' });
  return String(inst).replace(/\/+$/, '');
}
async function api(ctx, method, path, json) {
  return authed(ctx, async (token) => {
    const r = await call(ctx.fetch, `${instanceOf(ctx)}${path}`, { method, json, headers: { authorization: `Bearer ${token}` } });
    if (r.status === 403 && Array.isArray(r.json) && r.json[0]?.errorCode === 'REQUEST_LIMIT_EXCEEDED') throw new CrmError('rate_limited', 'Your Salesforce org has used up its API requests for now.', { status: 403, retryAfterMs: 15 * 60000 });
    return check(r, { vendor: VENDOR, detail, secrets: [token], now: ctx.now() });
  });
}
const data = (ctx, p) => `/services/data/${versionOf(ctx)}${p}`;
async function who(ctx) {
  const r = await api(ctx, 'GET', '/services/oauth2/userinfo');
  const u = r.json || {};
  return { account: u.preferred_username ? `Salesforce (${u.preferred_username})` : 'Salesforce' };
}

export default {
  id: 'salesforce',
  name: 'Salesforce',
  blurb: 'Each lead becomes a Lead (matched by email, else phone) with a completed task of what they asked.',
  auth: { oauth: { scopes: SCOPES, pkce: true, options: [{ key: 'sandbox', label: 'Where to sign in', type: 'select', default: '', options: [['', 'Production'], ['1', 'Sandbox']] }] } },
  fields: [
    { key: 'leadSource', label: 'Lead source', type: 'text', default: 'KnowBot', maxLength: 40 },
    { key: 'company', label: 'Company for new leads', type: 'text', default: 'Unknown', maxLength: 80, help: 'Salesforce needs a company on every lead; visitors rarely give one.' },
    { key: 'ownerId', label: 'Lead owner ID (optional)', type: 'text', pattern: '^[a-zA-Z0-9]{15,18}$', help: 'A user or queue ID (starts with 005 or 00G). Leave empty to use your assignment rules.' },
    { key: 'activity', label: 'Record the question as', type: 'select', default: 'task', options: [['task', 'A completed task'], ['note', 'A note']] },
    { key: 'externalIdField', label: 'External ID field (optional)', type: 'text', pattern: '^[A-Za-z][A-Za-z0-9_]{0,60}__c$', help: 'An External ID text field on Lead, for example KnowBot_Contact__c. When set, leads are upserted on it instead of searched by email.' },
  ],
  oauth: {
    authorizeUrl(ctx, { client, redirectUri, state, challenge, options }) {
      const u = new URL(`${loginOf(ctx, options?.sandbox)}/services/oauth2/authorize`);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', client.client_id);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', SCOPES);
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      return u.toString();
    },
    async exchange(ctx, { client, code, redirectUri, verifier, options }) {
      const sandbox = !!options?.sandbox;
      const j = await tokenCall(ctx, `${loginOf(ctx, sandbox)}/services/oauth2/token`, { grant_type: 'authorization_code', code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, code_verifier: verifier },
        { vendor: VENDOR, secrets: [client.client_secret] });
      if (!j.refresh_token) throw new CrmError('upstream', 'Salesforce did not return a way to stay signed in.', { action: 'The KnowBot app in Salesforce needs the “Perform requests at any time (refresh_token, offline_access)” scope.' });
      if (!ctx.base('instance', null) && !hostAllowed(j.instance_url, SF_HOSTS)) throw new CrmError('upstream', 'Salesforce did not say where your org lives.');
      const secrets = { refresh: j.refresh_token, instance: String(j.instance_url || '').replace(/\/+$/, ''), ...(sandbox ? { sandbox: true } : {}) };
      const acct = await who({ ...ctx, kind: 'oauth', secrets, token: async () => j.access_token }).catch(() => ({ account: 'Salesforce' }));
      return { secrets, access: { token: j.access_token, expiresIn: 900 }, account: `${acct.account}${sandbox ? ' · sandbox' : ''}` };
    },
    async refresh(ctx, { client }) {
      const j = await tokenCall(ctx, `${loginOf(ctx, ctx.secrets.sandbox)}/services/oauth2/token`, { grant_type: 'refresh_token', refresh_token: ctx.secrets.refresh, client_id: client.client_id, client_secret: client.client_secret },
        { vendor: VENDOR, secrets: [client.client_secret, ctx.secrets.refresh] });
      const moved = j.instance_url && (ctx.base('instance', null) || hostAllowed(j.instance_url, SF_HOSTS)) && String(j.instance_url).replace(/\/+$/, '') !== ctx.secrets.instance;
      return { access: { token: j.access_token, expiresIn: 900 }, ...(moved ? { secrets: { instance: String(j.instance_url).replace(/\/+$/, '') } } : {}) };
    },
  },
  async verify(ctx) { return who(ctx); },

  async deliver(ctx, lead, progress = {}) {
    const c = ctx.config || {};
    const n = nameOf(lead);
    const full = { LastName: n.last.slice(0, 80), ...(n.first ? { FirstName: n.first.slice(0, 40) } : {}), Company: c.company || 'Unknown', ...(lead.contact.email ? { Email: lead.contact.email } : {}),
      ...(lead.contact.phone ? { Phone: lead.contact.phone } : {}), LeadSource: c.leadSource || 'KnowBot', Description: noteText(lead).slice(0, 30000), ...(c.ownerId ? { OwnerId: c.ownerId } : {}) };
    if (!progress.recordId) {
      const key = lead.contact.email || lead.contact.phone;
      if (c.externalIdField) {
        // upsert on the owner's external-id field: one call, and Salesforce itself guarantees there is no duplicate
        const r = await api(ctx, 'PATCH', data(ctx, `/sobjects/Lead/${encodeURIComponent(c.externalIdField)}/${encodeURIComponent(key)}`), full);
        progress.action = r.status === 201 || r.json?.created ? 'created' : 'updated';
        progress.recordId = r.json?.id || (await api(ctx, 'GET', data(ctx, `/sobjects/Lead/${encodeURIComponent(c.externalIdField)}/${encodeURIComponent(key)}?fields=Id`))).json?.Id;
      } else {
        const where = lead.contact.email ? `Email = '${soql(lead.contact.email)}'` : `Phone = '${soql(lead.contact.phone)}'`;
        const q = await api(ctx, 'GET', data(ctx, `/query?q=${encodeURIComponent(`SELECT Id, Phone, Email FROM Lead WHERE ${where} AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 1`)}`));
        const hit = q.json?.records?.[0] || null;
        if (hit) {
          const patch = { ...(lead.contact.phone && !hit.Phone ? { Phone: lead.contact.phone } : {}), ...(lead.contact.email && !hit.Email ? { Email: lead.contact.email } : {}) };
          if (Object.keys(patch).length) await api(ctx, 'PATCH', data(ctx, `/sobjects/Lead/${encodeURIComponent(hit.Id)}`), patch);
          progress.recordId = hit.Id; progress.action = 'updated';
        } else {
          const r = await api(ctx, 'POST', data(ctx, '/sobjects/Lead'), full);
          progress.recordId = r.json?.id; progress.action = 'created';
        }
      }
      if (!progress.recordId) throw new CrmError('upstream', 'Salesforce did not say which lead it saved.');
    }
    if (!progress.noted) {
      if (c.activity === 'note') await api(ctx, 'POST', data(ctx, '/sobjects/Note'), { ParentId: progress.recordId, Title: noteTitle(lead).slice(0, 80), Body: noteText(lead).slice(0, 30000) });
      else await api(ctx, 'POST', data(ctx, '/sobjects/Task'), { WhoId: progress.recordId, Subject: noteTitle(lead).slice(0, 255), Description: noteText(lead).slice(0, 30000), Status: 'Completed', Priority: 'Normal', ActivityDate: lead.createdAt.slice(0, 10) });
      progress.noted = true;
    }
    return { action: progress.action, recordId: progress.recordId, recordUrl: `${instanceOf(ctx)}/${progress.recordId}` };
  },
};

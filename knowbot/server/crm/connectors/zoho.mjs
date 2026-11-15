// Zoho CRM connector: a lead becomes a Lead (duplicate check on Email, else Phone; never duplicated) with a Note.
//
// Endpoints used (Zoho CRM API v8 and Zoho Accounts OAuth docs, read 2026-11-15):
//   GET  {accounts}/oauth/v2/auth?scope&client_id&response_type=code&access_type=offline&redirect_uri&state&prompt=consent
//        ("accounts-server-url is specific to the location (datacenter)"; access_type=offline returns a refresh token;
//        the redirect carries code (valid two minutes), location and accounts-server)
//   POST {accounts-server}/oauth/v2/token   form: grant_type=authorization_code, client_id, client_secret, redirect_uri, code
//        → {access_token, refresh_token, api_domain, expires_in}; grant_type=refresh_token, refresh_token → {access_token, api_domain}
//        (errors come back as HTTP 200 with {error})
//   POST {api_domain}/crm/v8/Leads/upsert   {data:[{…}], duplicate_check_fields:['Email'], trigger:['workflow']}
//        → {data:[{code:'SUCCESS', action:'insert'|'update', details:{id}}]}   ("upsert-records": HTTP 207 on partial failure)
//   GET  {api_domain}/crm/v8/Leads/search?email=… | ?phone=…   (204 when nothing matches)
//   PUT  {api_domain}/crm/v8/Leads/{id}     {data:[{…}]}
//   POST {api_domain}/crm/v8/Leads/{id}/Notes {data:[{Note_Title, Note_Content}]}
//   GET  {api_domain}/crm/v8/Leads?fields=Email&per_page=1      (the connection check; 204 for an empty module)
//   Authorization: Zoho-oauthtoken <access token>
// Data centres: the sign-in starts on the accounts host the owner picks and the token call goes to the
// `accounts-server` the redirect names; both, and api_domain, are only used when they are known Zoho hosts.
// Why search first: upsert overwrites every field it is given, and Zoho needs a Last_Name we often have to make up,
// so an existing lead would lose its real name. A lead found by search only gets empty fields filled; the upsert
// (with duplicate_check_fields) creates the rest and still protects against a race.
// Scopes: ZohoCRM.modules.leads.ALL, ZohoCRM.modules.notes.CREATE, ZohoSearch.securesearch.READ.
// NOT verified against the docs (pages not read): the search endpoint's parameters and its need for
// ZohoSearch.securesearch.READ, the Notes sub-resource body, and the token endpoint parameters (from memory).
import { call, check, CrmError } from '../http.mjs';
import { authed, tokenCall, hostAllowed } from '../oauth.mjs';
import { nameOf, noteText, noteTitle } from '../payload.mjs';

const VENDOR = 'Zoho CRM';
export const SCOPES = 'ZohoCRM.modules.leads.ALL,ZohoCRM.modules.notes.CREATE,ZohoSearch.securesearch.READ';
/** Data centre → accounts host. The API host comes from the token response (api_domain). */
export const DATA_CENTRES = Object.freeze({ com: 'https://accounts.zoho.com', eu: 'https://accounts.zoho.eu', in: 'https://accounts.zoho.in', 'com.au': 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp', ca: 'https://accounts.zohocloud.ca', sa: 'https://accounts.zoho.sa', 'com.cn': 'https://accounts.zoho.com.cn' });
const ACCOUNTS_HOSTS = Object.values(DATA_CENTRES).map((u) => new URL(u).hostname);
const API_HOSTS = ['zohoapis.com', 'zohoapis.eu', 'zohoapis.in', 'zohoapis.com.au', 'zohoapis.jp', 'zohoapis.ca', 'zohoapis.sa', 'zohoapis.com.cn'];
const accountsOk = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && !x.port && ACCOUNTS_HOSTS.includes(x.hostname.toLowerCase()); } catch { return false; } };
const detail = (r) => r.json?.data?.[0]?.message || r.json?.message || r.json?.code || '';

function apiOf(ctx) {
  const fixed = ctx.base('api', null);
  if (fixed) return fixed;
  if (!hostAllowed(ctx.secrets.api, API_HOSTS)) throw new CrmError('auth', 'Zoho did not say where your account lives.', { action: 'Reconnect Zoho CRM.' });
  return String(ctx.secrets.api).replace(/\/+$/, '');
}
const accountsOf = (ctx, given) => ctx.base('accounts', null) || (accountsOk(given) ? String(given).replace(/\/+$/, '') : null);
async function api(ctx, method, path, json) {
  return authed(ctx, async (token) => {
    const r = await call(ctx.fetch, `${apiOf(ctx)}/crm/v8${path}`, { method, json, headers: { authorization: `Zoho-oauthtoken ${token}` } });
    return check(r, { vendor: VENDOR, detail, secrets: [token], now: ctx.now() });
  });
}
/** Zoho answers 200/201/207 with a per-record result: anything but SUCCESS is an error for this lead. */
function record(r, what) {
  const row = r.json?.data?.[0];
  if (!row || row.code !== 'SUCCESS') {
    const said = String(row?.message || row?.code || '').slice(0, 120);
    throw new CrmError('invalid', `Zoho CRM did not accept ${what}.${said ? ` Zoho CRM said: “${said}”` : ''}`, { status: r.status, action: 'Check the field settings for Zoho CRM.' });
  }
  return row;
}

export default {
  id: 'zoho',
  name: 'Zoho CRM',
  blurb: 'Each lead becomes a Lead (matched by email, else phone) with a note of what they asked.',
  auth: { oauth: { scopes: SCOPES, options: [{ key: 'dc', label: 'Where your Zoho account lives', type: 'select', default: 'com',
    options: [['com', 'United States (zoho.com)'], ['eu', 'Europe (zoho.eu)'], ['in', 'India (zoho.in)'], ['com.au', 'Australia (zoho.com.au)'], ['jp', 'Japan (zoho.jp)'], ['ca', 'Canada (zohocloud.ca)'], ['sa', 'Saudi Arabia (zoho.sa)'], ['com.cn', 'China (zoho.com.cn)']] }] } },
  fields: [
    { key: 'leadSource', label: 'Lead source', type: 'text', default: 'KnowBot', maxLength: 60 },
    { key: 'company', label: 'Company for new leads (optional)', type: 'text', maxLength: 80 },
    { key: 'ownerId', label: 'Lead owner ID (optional)', type: 'text', pattern: '^\\d{6,24}$', help: 'The numeric ID of the Zoho CRM user who should own new leads.' },
    { key: 'workflows', label: 'Run your Zoho workflows on new leads', type: 'select', default: '1', options: [['1', 'Yes'], ['', 'No']] },
  ],
  oauth: {
    authorizeUrl(ctx, { client, redirectUri, state, options }) {
      const u = new URL(`${ctx.base('accounts', null) || DATA_CENTRES[options?.dc] || DATA_CENTRES.com}/oauth/v2/auth`);
      u.searchParams.set('scope', SCOPES);
      u.searchParams.set('client_id', client.client_id);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent'); // a refresh token is only returned with the consent screen
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchange(ctx, { client, code, redirectUri, options, query }) {
      // the redirect names the data centre the user really signed in to; fall back to the one they picked
      const accounts = accountsOf(ctx, query?.['accounts-server']) || DATA_CENTRES[options?.dc] || DATA_CENTRES.com;
      const j = await tokenCall(ctx, `${accounts}/oauth/v2/token`, { grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, code }, { vendor: VENDOR, secrets: [client.client_secret] });
      if (!j.refresh_token) throw new CrmError('upstream', 'Zoho did not return a way to stay signed in.');
      if (!ctx.base('api', null) && !hostAllowed(j.api_domain, API_HOSTS)) throw new CrmError('upstream', 'Zoho did not say where your account lives.');
      const home = accountsOk(accounts) ? new URL(accounts).hostname.replace(/^accounts\./, '') : null;
      return { secrets: { refresh: j.refresh_token, accounts, api: String(j.api_domain || '').replace(/\/+$/, '') }, access: { token: j.access_token, expiresIn: j.expires_in }, account: `Zoho CRM${home ? ` (${home})` : ''}` };
    },
    async refresh(ctx, { client }) {
      const accounts = accountsOf(ctx, ctx.secrets.accounts);
      if (!accounts) throw new CrmError('auth', 'Zoho did not say where your account lives.', { action: 'Reconnect Zoho CRM.' });
      const j = await tokenCall(ctx, `${accounts}/oauth/v2/token`, { grant_type: 'refresh_token', refresh_token: ctx.secrets.refresh, client_id: client.client_id, client_secret: client.client_secret }, { vendor: VENDOR, secrets: [client.client_secret, ctx.secrets.refresh] });
      return { access: { token: j.access_token, expiresIn: j.expires_in } };
    },
  },
  async verify(ctx) { await api(ctx, 'GET', '/Leads?fields=Email&per_page=1'); return {}; },

  async deliver(ctx, lead, progress = {}) {
    const c = ctx.config || {};
    const n = nameOf(lead);
    if (!progress.recordId) {
      const s = await api(ctx, 'GET', `/Leads/search?${lead.contact.email ? `email=${encodeURIComponent(lead.contact.email)}` : `phone=${encodeURIComponent(lead.contact.phone)}`}`);
      const hit = s.status === 204 ? null : s.json?.data?.[0] || null;
      if (hit?.id) {
        const patch = { ...(lead.contact.phone && !hit.Phone ? { Phone: lead.contact.phone } : {}), ...(lead.contact.email && !hit.Email ? { Email: lead.contact.email } : {}) };
        if (Object.keys(patch).length) record(await api(ctx, 'PUT', `/Leads/${encodeURIComponent(hit.id)}`, { data: [patch] }), 'the update');
        progress.recordId = String(hit.id); progress.action = 'updated';
      } else {
        const row = record(await api(ctx, 'POST', '/Leads/upsert', { data: [{ Last_Name: n.last.slice(0, 80), ...(n.first ? { First_Name: n.first.slice(0, 40) } : {}), ...(c.company ? { Company: c.company } : {}),
          ...(lead.contact.email ? { Email: lead.contact.email } : {}), ...(lead.contact.phone ? { Phone: lead.contact.phone } : {}), Lead_Source: c.leadSource || 'KnowBot', Description: noteText(lead).slice(0, 30000),
          ...(c.ownerId ? { Owner: { id: c.ownerId } } : {}) }], duplicate_check_fields: [lead.contact.email ? 'Email' : 'Phone'], trigger: c.workflows === '' ? [] : ['workflow'] }), 'this lead');
        progress.recordId = String(row.details?.id || ''); progress.action = row.action === 'update' ? 'updated' : 'created';
      }
      if (!progress.recordId) throw new CrmError('upstream', 'Zoho CRM did not say which lead it saved.');
    }
    if (!progress.noted) {
      record(await api(ctx, 'POST', `/Leads/${encodeURIComponent(progress.recordId)}/Notes`, { data: [{ Note_Title: noteTitle(lead), Note_Content: noteText(lead) }] }), 'the note');
      progress.noted = true;
    }
    return { action: progress.action, recordId: progress.recordId };
  },
};

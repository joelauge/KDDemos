// HubSpot connector: a lead becomes a Contact (found by e-mail, else by phone; updated, never duplicated) with a Note.
//
// Endpoints used (HubSpot developer docs, read 2026-11-15):
//   POST  https://api.hubapi.com/crm/v3/objects/contacts/search   {filterGroups:[{filters:[{propertyName,operator:'EQ',value}]}], properties, limit}
//   POST  https://api.hubapi.com/crm/v3/objects/contacts          {properties}                         (crm-contacts-v3 guide: "Create contacts")
//   PATCH https://api.hubapi.com/crm/v3/objects/contacts/{id}     {properties}                         ("Update contacts")
//   POST  https://api.hubapi.com/crm/v3/objects/notes             {properties:{hs_timestamp,hs_note_body}, associations:[{to:{id},
//         types:[{associationCategory:'HUBSPOT_DEFINED', associationTypeId:202}]}]}                     (crm-notes-v3 guide; 202 = note → contact)
//   OAuth: https://app.hubspot.com/oauth/authorize?client_id&redirect_uri&scope&state
//          POST https://api.hubspot.com/oauth/v3/token  (form: grant_type=authorization_code|refresh_token, client_id,
//          client_secret, redirect_uri, code | refresh_token) → {access_token, refresh_token, expires_in: 1800, hub_id}
//   Pasted token: a private-app (or legacy app) access token, sent as Authorization: Bearer.
// Why search + create/update instead of batch/upsert: the docs say "Partial upserts are not supported when using email
// as the idProperty", and a phone-only lead has no e-mail to upsert on. A create that races another create comes back
// 409 with the existing id, which we then update.
// Scopes: crm.objects.contacts.read, crm.objects.contacts.write.
// NOT verified against the docs (the "Scope requirements" sections were empty when read): that these two scopes are
// enough to create a Note associated with a contact; that `mobilephone` is searchable with EQ like `phone`.
import { call, check, CrmError } from '../http.mjs';
import { authed, tokenCall } from '../oauth.mjs';
import { nameOf, noteText } from '../payload.mjs';

const VENDOR = 'HubSpot';
export const SCOPES = 'crm.objects.contacts.read crm.objects.contacts.write';
const NOTE_TO_CONTACT = 202;
const bases = (ctx) => ({ api: ctx.base('api', 'https://api.hubapi.com'), token: ctx.base('token', 'https://api.hubspot.com/oauth/v3/token'), authorize: ctx.base('authorize', 'https://app.hubspot.com/oauth/authorize') });
const detail = (r) => r.json?.message || r.json?.errors?.[0]?.message || '';

async function api(ctx, method, path, json) {
  return authed(ctx, async (token) => check(await call(ctx.fetch, `${bases(ctx).api}${path}`, { method, json, headers: { authorization: `Bearer ${token}` } }), { vendor: VENDOR, detail, secrets: [token], now: ctx.now() }));
}
async function find(ctx, lead) {
  const groups = lead.contact.email ? [{ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.contact.email }] }]
    : [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: lead.contact.phone }] }, { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: lead.contact.phone }] }];
  const r = await api(ctx, 'POST', '/crm/v3/objects/contacts/search', { filterGroups: groups, properties: ['email', 'phone', 'firstname', 'lastname'], limit: 1 });
  return r.json?.results?.[0] || null;
}
async function account(ctx) {
  // the contacts read our scopes cover is the real check; the account name is a nicety
  await api(ctx, 'GET', '/crm/v3/objects/contacts?limit=1&properties=email');
  let portal = null;
  try { const r = await api(ctx, 'GET', '/account-info/v3/details'); portal = r.json?.portalId || null; } catch { portal = null; }
  return { account: portal ? `HubSpot account ${portal}` : 'HubSpot', extra: portal ? { portal: String(portal) } : {} };
}

export default {
  id: 'hubspot',
  name: 'HubSpot',
  blurb: 'Each lead becomes a contact (matched by email, else phone) with a note of what they asked.',
  auth: {
    oauth: { scopes: SCOPES },
    token: { label: 'Private app access token', placeholder: 'pat-…', help: 'In HubSpot: Settings, Integrations, Private Apps. Create an app with the contacts read and write scopes, then paste its access token here.' },
  },
  fields: [
    { key: 'lifecycle', label: 'Lifecycle stage for new contacts', type: 'select', default: 'lead',
      options: [['lead', 'Lead'], ['subscriber', 'Subscriber'], ['marketingqualifiedlead', 'Marketing qualified lead'], ['salesqualifiedlead', 'Sales qualified lead'], ['opportunity', 'Opportunity'], ['', "Don't set"]] },
    { key: 'leadStatus', label: 'Lead status for new contacts', type: 'select', default: 'NEW', options: [['NEW', 'New'], ['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['', "Don't set"]] },
    { key: 'ownerId', label: 'Contact owner ID (optional)', type: 'text', pattern: '^\\d{1,20}$', help: 'The numeric ID of the HubSpot user who should own new contacts.' },
    { key: 'sourceProperty', label: 'Lead source property (optional)', type: 'text', pattern: '^[a-z][a-z0-9_]{0,99}$', help: 'The internal name of a contact property of yours to stamp, for example lead_source.' },
    { key: 'sourceValue', label: 'Lead source value', type: 'text', default: 'KnowBot', maxLength: 80 },
  ],

  async connect(ctx, input) {
    const token = String(input?.token || '').trim();
    if (!/^[A-Za-z0-9._~-]{20,400}$/.test(token)) throw new CrmError('invalid', 'That does not look like a HubSpot access token.', { action: 'Copy the access token from your private app (it starts with “pat-”).' });
    const who = await account({ ...ctx, kind: 'token', token: async () => token });
    return { secrets: { token, ...who.extra }, account: who.account, hint: `…${token.slice(-4)}` };
  },
  oauth: {
    authorizeUrl(ctx, { client, redirectUri, state }) {
      const u = new URL(bases(ctx).authorize);
      u.searchParams.set('client_id', client.client_id);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', SCOPES);
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchange(ctx, { client, code, redirectUri }) {
      const j = await tokenCall(ctx, bases(ctx).token, { grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, code }, { vendor: VENDOR, secrets: [client.client_secret] });
      if (!j.refresh_token) throw new CrmError('upstream', 'HubSpot did not return a way to stay signed in.');
      return { secrets: { refresh: j.refresh_token, ...(j.hub_id ? { portal: String(j.hub_id) } : {}) }, access: { token: j.access_token, expiresIn: j.expires_in }, account: j.hub_id ? `HubSpot account ${j.hub_id}` : 'HubSpot' };
    },
    async refresh(ctx, { client }) {
      const j = await tokenCall(ctx, bases(ctx).token, { grant_type: 'refresh_token', client_id: client.client_id, client_secret: client.client_secret, refresh_token: ctx.secrets.refresh }, { vendor: VENDOR, secrets: [client.client_secret, ctx.secrets.refresh] });
      return { access: { token: j.access_token, expiresIn: j.expires_in }, ...(j.refresh_token && j.refresh_token !== ctx.secrets.refresh ? { secrets: { refresh: j.refresh_token } } : {}) };
    },
  },
  async verify(ctx) { return account(ctx); },

  /** progress: { recordId, action, noted } survives a retry, so a note is never written twice for one lead. */
  async deliver(ctx, lead, progress = {}) {
    const c = ctx.config || {};
    const n = nameOf(lead);
    if (!progress.recordId) {
      let hit = await find(ctx, lead);
      if (!hit) {
        const props = { ...(lead.contact.email ? { email: lead.contact.email } : {}), ...(lead.contact.phone ? { phone: lead.contact.phone } : {}),
          ...(n.known ? { ...(n.first ? { firstname: n.first } : {}), lastname: n.last } : {}),
          ...(c.lifecycle ? { lifecyclestage: c.lifecycle } : {}), ...(c.leadStatus ? { hs_lead_status: c.leadStatus } : {}), ...(c.ownerId ? { hubspot_owner_id: c.ownerId } : {}),
          ...(c.sourceProperty ? { [c.sourceProperty]: c.sourceValue || 'KnowBot' } : {}) };
        try {
          const r = await api(ctx, 'POST', '/crm/v3/objects/contacts', { properties: props });
          progress.recordId = String(r.json?.id || ''); progress.action = 'created';
        } catch (e) {
          // someone (or an earlier attempt) created it in between: HubSpot names the existing contact
          const id = e instanceof CrmError && e.status === 409 ? /Existing ID:\s*(\d+)/i.exec(e.message)?.[1] : null;
          if (!id) throw e;
          hit = { id, properties: {} };
        }
      }
      if (hit) {
        // an existing contact keeps what a person typed: only an empty phone is filled in
        const patch = { ...(lead.contact.phone && !hit.properties?.phone ? { phone: lead.contact.phone } : {}), ...(n.known && !hit.properties?.lastname ? { ...(n.first ? { firstname: n.first } : {}), lastname: n.last } : {}) };
        if (Object.keys(patch).length) await api(ctx, 'PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(hit.id)}`, { properties: patch });
        progress.recordId = String(hit.id); progress.action = 'updated';
      }
      if (!progress.recordId) throw new CrmError('upstream', 'HubSpot did not say which contact it saved.');
    }
    if (!progress.noted) {
      await api(ctx, 'POST', '/crm/v3/objects/notes', { properties: { hs_timestamp: lead.createdAt, hs_note_body: noteText(lead, { html: true }) },
        associations: [{ to: { id: progress.recordId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }] });
      progress.noted = true;
    }
    const portal = ctx.secrets.portal;
    return { action: progress.action, recordId: progress.recordId, ...(portal ? { recordUrl: `https://app.hubspot.com/contacts/${portal}/record/0-1/${progress.recordId}` } : {}) };
  },
};

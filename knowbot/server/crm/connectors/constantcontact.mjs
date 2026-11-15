// Constant Contact connector: a lead with an e-mail address becomes (or is added to the chosen list as) a contact.
// Constant Contact is a marketing list, not a CRM, so consent is handled explicitly:
//
//   - default, "Add as contacts only": a new contact is created with POST /contacts and
//     email_address.permission_to_send = "implicit" (the honest value: they contacted the business, they did not
//     sign up for e-mail), create_source "Account". An existing contact is only added to the chosen list
//     (POST /activities/add_list_memberships); nothing else about them is changed, and their permission is not touched.
//   - "They agreed to marketing emails" (the owner must choose it): POST /contacts/sign_up_form, Constant Contact's
//     create-or-update. Its guide says "Only use this method when a contact gives you their explicit permission to
//     send them emails": it sets explicit permission, or, when the account has Confirmed Opt-In switched on, sends
//     Constant Contact's own confirmation e-mail and leaves the contact pending. That is why it is never the default.
//   - phone-only leads are skipped (a contact needs an e-mail address here).
//   - the question and the consent label go into a custom field the owner picks (optional). Contact notes are not
//     written: the guides we could read do not document a notes field on these endpoints.
//
// Endpoints used (Constant Contact v3 API guide, read 2026-11-15):
//   GET  https://authz.constantcontact.com/oauth2/default/v1/authorize?client_id&redirect_uri&response_type=code&state&scope=contact_data offline_access
//   POST https://authz.constantcontact.com/oauth2/default/v1/token   HTTP Basic client_id:client_secret; form grant_type=authorization_code,
//        code, redirect_uri | grant_type=refresh_token, refresh_token → a new access token AND a new refresh token (it rotates: saved sealed)
//   POST https://api.cc.email/v3/contacts/sign_up_form   {email_address, list_memberships (required, 1-50), first_name, last_name, phone_number,
//        custom_fields:[{custom_field_id, value}]} → 201 {contact_id, action:'created'} | 200 {action:'updated'}; scope contact_data
//   POST https://api.cc.email/v3/contacts   → 409 when the e-mail address already exists
// NOT verified against the docs (the field-level pages were not reachable; from memory):
//   the POST /contacts body ({email_address:{address, permission_to_send}, create_source, first_name, last_name,
//   phone_numbers:[{phone_number, kind}], list_memberships, custom_fields}); GET /contacts?email=&status=all;
//   POST /activities/add_list_memberships {source:{contact_ids}, list_ids}; GET /contact_lists?limit=…  → {lists:[{list_id, name}]};
//   GET /contact_custom_fields → {custom_fields:[{custom_field_id, label}]}; PKCE on the server flow (we send
//   code_challenge / code_verifier, which an authorization server that does not use them ignores).
import { call, check, CrmError } from '../http.mjs';
import { authed, tokenCall } from '../oauth.mjs';
import { nameOf } from '../payload.mjs';

const VENDOR = 'Constant Contact';
export const SCOPES = 'contact_data offline_access';
const AUTHZ = (ctx) => ctx.base('authz', 'https://authz.constantcontact.com/oauth2/default/v1');
const API = (ctx) => ctx.base('api', 'https://api.cc.email/v3');
const UUID = '^[0-9a-fA-F-]{36}$';
const detail = (r) => (Array.isArray(r.json) ? r.json[0]?.error_message : r.json?.error_message || r.json?.error_description) || '';
async function api(ctx, method, path, json) {
  return authed(ctx, async (token) => check(await call(ctx.fetch, `${API(ctx)}${path}`, { method, json, headers: { authorization: `Bearer ${token}` } }), { vendor: VENDOR, detail, secrets: [token], now: ctx.now() }));
}
async function lists(ctx) {
  const r = await api(ctx, 'GET', '/contact_lists?limit=500&include_count=false');
  return (r.json?.lists || []).map((l) => ({ id: String(l.list_id), name: String(l.name || l.list_id) }));
}
const questionOf = (lead) => `${lead.question || ''}${lead.consent?.label ? ` [${lead.consent.label}]` : ''}`.trim().slice(0, 255);

export default {
  id: 'constantcontact',
  name: 'Constant Contact',
  kind: 'list',
  blurb: 'Each lead with an email address is added to the contact list you choose.',
  auth: { oauth: { scopes: SCOPES, pkce: true } },
  fields: [
    { key: 'listId', label: 'Contact list', type: 'list', required: true, pattern: UUID, help: 'The list new leads are added to.' },
    { key: 'optIn', label: 'When someone new is added', type: 'select', default: 'implicit', options: [
      ['implicit', 'Add as contacts only (they did not sign up for email)'],
      ['explicit', 'They agreed to marketing emails: I have their consent']],
    help: 'Asking your bot for an answer is not agreeing to marketing. Choose the second option only if your bot or your site asks people for that consent; Constant Contact then treats them as signed up, and sends your confirmation email first if Confirmed Opt-In is on in your account.' },
    { key: 'questionFieldId', label: 'Custom field ID for the question (optional)', type: 'text', pattern: UUID, help: 'The ID of a text custom field of yours. The question and how we got their address are saved in it.' },
  ],
  lists,
  oauth: {
    authorizeUrl(ctx, { client, redirectUri, state, challenge }) {
      const u = new URL(`${AUTHZ(ctx)}/authorize`);
      u.searchParams.set('client_id', client.client_id);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', SCOPES);
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      return u.toString();
    },
    async exchange(ctx, { client, code, redirectUri, verifier }) {
      const j = await tokenCall(ctx, `${AUTHZ(ctx)}/token`, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, { vendor: VENDOR, basic: client, secrets: [client.client_secret] });
      if (!j.refresh_token) throw new CrmError('upstream', 'Constant Contact did not return a way to stay signed in.');
      return { secrets: { refresh: j.refresh_token }, access: { token: j.access_token, expiresIn: j.expires_in }, account: 'Constant Contact' };
    },
    async refresh(ctx, { client }) {
      const j = await tokenCall(ctx, `${AUTHZ(ctx)}/token`, { grant_type: 'refresh_token', refresh_token: ctx.secrets.refresh }, { vendor: VENDOR, basic: client, secrets: [client.client_secret, ctx.secrets.refresh] });
      return { access: { token: j.access_token, expiresIn: j.expires_in }, ...(j.refresh_token && j.refresh_token !== ctx.secrets.refresh ? { secrets: { refresh: j.refresh_token } } : {}) };
    },
  },
  async verify(ctx) { await lists(ctx); return {}; },

  async deliver(ctx, lead, progress = {}) {
    const c = ctx.config || {};
    if (!lead.contact.email) return { action: 'skipped', reason: 'no email address' };
    if (!c.listId) throw new CrmError('config', 'No contact list is chosen yet.', { action: 'Choose a list in the Constant Contact settings.' });
    if (progress.recordId) return { action: progress.action, recordId: progress.recordId };
    const n = nameOf(lead);
    const names = n.known ? { ...(n.first ? { first_name: n.first.slice(0, 50) } : {}), last_name: n.last.slice(0, 50) } : {};
    const custom = c.questionFieldId && questionOf(lead) ? { custom_fields: [{ custom_field_id: c.questionFieldId, value: questionOf(lead) }] } : {};
    if (c.optIn === 'explicit') {
      // the owner states they have consent: Constant Contact's own create-or-update (explicit, or its confirmation e-mail)
      const r = await api(ctx, 'POST', '/contacts/sign_up_form', { email_address: lead.contact.email, list_memberships: [c.listId], ...names, ...(lead.contact.phone ? { phone_number: lead.contact.phone } : {}), ...custom });
      progress.recordId = String(r.json?.contact_id || ''); progress.action = r.json?.action === 'updated' ? 'updated' : 'created';
    } else {
      const f = await api(ctx, 'GET', `/contacts?email=${encodeURIComponent(lead.contact.email)}&status=all&limit=1`);
      const hit = f.json?.contacts?.[0] || null;
      const addToList = (id) => api(ctx, 'POST', '/activities/add_list_memberships', { source: { contact_ids: [id] }, list_ids: [c.listId] });
      if (hit?.contact_id) { await addToList(hit.contact_id); progress.recordId = String(hit.contact_id); progress.action = 'updated'; }
      else {
        try {
          const r = await api(ctx, 'POST', '/contacts', { email_address: { address: lead.contact.email, permission_to_send: 'implicit' }, create_source: 'Account', ...names,
            ...(lead.contact.phone ? { phone_numbers: [{ phone_number: lead.contact.phone, kind: 'other' }] } : {}), list_memberships: [c.listId], ...custom });
          progress.recordId = String(r.json?.contact_id || ''); progress.action = 'created';
        } catch (e) {
          if (!(e instanceof CrmError) || e.status !== 409) throw e;
          // created in between: find it again and only add the list
          const again = (await api(ctx, 'GET', `/contacts?email=${encodeURIComponent(lead.contact.email)}&status=all&limit=1`)).json?.contacts?.[0];
          if (!again?.contact_id) throw e;
          await addToList(again.contact_id); progress.recordId = String(again.contact_id); progress.action = 'updated';
        }
      }
    }
    if (!progress.recordId) throw new CrmError('upstream', 'Constant Contact did not say which contact it saved.');
    return { action: progress.action, recordId: progress.recordId };
  },
};

// Mailchimp connector: a lead with an e-mail address becomes (or updates) a member of the audience the owner picked,
// with tags and a member note. Mailchimp is a marketing list, not a CRM, so consent is handled explicitly:
//
//   - a lead who only asked the bot to send them an answer has NOT opted in to marketing. New members are therefore
//     added with status_if_new "transactional" by default ("Add as contacts only"): a non-subscribed contact that
//     marketing campaigns are not sent to. The owner may instead choose "pending" (Mailchimp sends its own
//     confirmation e-mail: double opt-in) or, only by ticking an option that says they have that consent, "subscribed".
//   - an existing member's status is never changed (we never send `status`): someone who unsubscribed stays unsubscribed.
//   - phone-only leads are skipped (Mailchimp members need an e-mail address).
//   - the lead's consent label is carried in the member note and as a tag.
//
// Endpoints used (Mailchimp Marketing API reference, read 2026-11-15):
//   PUT  https://{dc}.api.mailchimp.com/3.0/lists/{list_id}/members/{subscriber_hash}   {email_address, status_if_new, merge_fields}
//        ("Add or update list member"; subscriber_hash = MD5 of the lower-cased e-mail; status values subscribed,
//        unsubscribed, cleaned, pending, transactional)
//   POST https://{dc}.api.mailchimp.com/3.0/lists/{list_id}/members/{subscriber_hash}/tags   {tags:[{name, status:'active'}]}
//   OAuth: https://login.mailchimp.com/oauth2/authorize?response_type=code&client_id&redirect_uri (+ state)
//          POST https://login.mailchimp.com/oauth2/token   form: grant_type=authorization_code, client_id, client_secret, redirect_uri, code
// NOT verified against the docs (pages not reachable or silent when read; from memory):
//   POST …/lists/{list_id}/members/{subscriber_hash}/notes {note}   (member notes, at most 1,000 characters)
//   GET  …/lists?count=100&fields=lists.id,lists.name                (the audiences to pick from)
//   GET  https://login.mailchimp.com/oauth2/metadata with "Authorization: OAuth <token>" → {dc, api_endpoint, accountname}
//   that OAuth access tokens do not expire and there is no refresh token (so a signed-in connection is stored like a key);
//   that an API key is "<hex>-<dc>" and is accepted as HTTP Basic "anystring:<key>"; the exact meaning of "transactional"
//   (the reference lists the value without defining it); that PHONE is the audience's phone merge tag (it is only sent
//   when the owner switches it on, because an audience without that merge field rejects the request).
import { createHash } from 'node:crypto';
import { call, check, CrmError } from '../http.mjs';
import { authed, tokenCall, hostAllowed } from '../oauth.mjs';
import { nameOf, noteText } from '../payload.mjs';

const VENDOR = 'Mailchimp';
const LOGIN = (ctx) => ctx.base('login', 'https://login.mailchimp.com');
const detail = (r) => r.json?.detail || r.json?.title || '';
export const subscriberHash = (email) => createHash('md5').update(String(email).trim().toLowerCase()).digest('hex');
function apiOf(ctx) {
  const fixed = ctx.base('api', null);
  if (fixed) return fixed;
  const dc = String(ctx.secrets.dc || '');
  if (!/^[a-z]{2,4}\d{1,4}$/.test(dc)) throw new CrmError('auth', 'Mailchimp did not say where your account lives.', { action: 'Reconnect Mailchimp.' });
  return `https://${dc}.api.mailchimp.com/3.0`;
}
async function api(ctx, method, path, json) {
  return authed(ctx, async (token) => check(await call(ctx.fetch, `${apiOf(ctx)}${path}`, { method, json, headers: { authorization: `Bearer ${token}` } }), { vendor: VENDOR, detail, secrets: [token], now: ctx.now() }));
}
async function lists(ctx) {
  const r = await api(ctx, 'GET', '/lists?count=100&fields=lists.id,lists.name');
  return (r.json?.lists || []).map((l) => ({ id: String(l.id), name: String(l.name || l.id) }));
}
const tagOf = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 100);

export default {
  id: 'mailchimp',
  name: 'Mailchimp',
  kind: 'list',
  blurb: 'Each lead with an email address is added to the audience you choose, tagged, with a note of what they asked.',
  auth: {
    oauth: {},
    token: { label: 'API key', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us21', help: 'In Mailchimp: your profile, Extras, API keys. Create a key and paste it here.' },
  },
  fields: [
    { key: 'listId', label: 'Audience', type: 'list', required: true, pattern: '^[A-Za-z0-9]{4,20}$', help: 'The audience new leads are added to.' },
    { key: 'optIn', label: 'When someone new is added', type: 'select', default: 'transactional', options: [
      ['transactional', 'Add as contacts only (no marketing emails)'],
      ['pending', 'Send them your confirmation email (double opt-in)'],
      ['subscribed', 'Subscribe them: I have their consent to marketing emails']],
    help: 'Asking your bot for an answer is not agreeing to marketing. “Contacts only” keeps them out of your campaigns; the confirmation email lets them choose. People already in your audience keep the status they have.' },
    { key: 'phoneField', label: 'Also save their phone number', type: 'select', default: '', options: [['', 'No'], ['PHONE', 'Yes, in the PHONE field']], help: 'Only if your audience has a PHONE field.' },
    { key: 'tag', label: 'Tag', type: 'text', default: 'KnowBot', maxLength: 60 },
  ],
  lists,
  async connect(ctx, input) {
    const token = String(input?.token || '').trim();
    const m = /^[a-f0-9]{20,64}-([a-z]{2,4}\d{1,4})$/.exec(token);
    if (!m) throw new CrmError('invalid', 'That does not look like a Mailchimp API key.', { action: 'A key ends with a dash and your data centre, for example “-us21”.' });
    const c = { ...ctx, kind: 'token', secrets: { dc: m[1] }, token: async () => token };
    const n = (await lists(c)).length;
    return { secrets: { token, dc: m[1] }, account: `Mailchimp (${m[1]}, ${n === 1 ? '1 audience' : `${n} audiences`})`, hint: `…${token.slice(-4)}` };
  },
  oauth: {
    authorizeUrl(ctx, { client, redirectUri, state }) {
      const u = new URL(`${LOGIN(ctx)}/oauth2/authorize`);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', client.client_id);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchange(ctx, { client, code, redirectUri }) {
      const j = await tokenCall(ctx, `${LOGIN(ctx)}/oauth2/token`, { grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, code }, { vendor: VENDOR, secrets: [client.client_secret] });
      const md = check(await call(ctx.fetch, `${LOGIN(ctx)}/oauth2/metadata`, { headers: { authorization: `OAuth ${j.access_token}` } }), { vendor: VENDOR, detail, secrets: [j.access_token], now: ctx.now() }).json || {};
      const dc = String(md.dc || '');
      if (!ctx.base('api', null) && (!/^[a-z]{2,4}\d{1,4}$/.test(dc) || (md.api_endpoint && !hostAllowed(md.api_endpoint, ['api.mailchimp.com'])))) throw new CrmError('upstream', 'Mailchimp did not say where your account lives.');
      // Mailchimp access tokens do not expire and there is no refresh token: kept sealed, used like a key
      return { kind: 'token', secrets: { token: j.access_token, dc }, access: { token: j.access_token, expiresIn: 3600 }, account: `Mailchimp${md.accountname ? ` (${String(md.accountname).slice(0, 60)})` : ''}` };
    },
  },
  async verify(ctx) { await lists(ctx); return {}; },

  async deliver(ctx, lead, progress = {}) {
    const c = ctx.config || {};
    if (!lead.contact.email) return { action: 'skipped', reason: 'no email address' };
    if (!c.listId) throw new CrmError('config', 'No audience is chosen yet.', { action: 'Choose an audience in the Mailchimp settings.' });
    const n = nameOf(lead);
    const member = `/lists/${encodeURIComponent(c.listId)}/members/${subscriberHash(lead.contact.email)}`;
    if (!progress.recordId) {
      const merge = { ...(n.known ? { ...(n.first ? { FNAME: n.first } : {}), LNAME: n.last } : {}), ...(c.phoneField && lead.contact.phone ? { [c.phoneField]: lead.contact.phone } : {}) };
      const optIn = ['transactional', 'pending', 'subscribed'].includes(c.optIn) ? c.optIn : 'transactional';
      // status_if_new only: an existing member's own choice (subscribed, unsubscribed) is never overwritten
      const r = await api(ctx, 'PUT', member, { email_address: lead.contact.email, status_if_new: optIn, ...(Object.keys(merge).length ? { merge_fields: merge } : {}) });
      progress.recordId = String(r.json?.id || subscriberHash(lead.contact.email));
      progress.action = 'saved'; // the API answers the same for a new and an existing member
    }
    if (!progress.tagged) {
      const tags = [...new Set([tagOf(c.tag || 'KnowBot'), tagOf(lead.bot.name), tagOf(lead.channelLabel), lead.consent?.code ? tagOf(`consent: ${lead.consent.code.replace(/_/g, ' ')}`) : ''].filter(Boolean))];
      await api(ctx, 'POST', `${member}/tags`, { tags: tags.map((name) => ({ name, status: 'active' })) });
      progress.tagged = true;
    }
    if (!progress.noted) {
      await api(ctx, 'POST', `${member}/notes`, { note: noteText(lead).slice(0, 1000) });
      progress.noted = true;
    }
    return { action: progress.action, recordId: progress.recordId };
  },
};

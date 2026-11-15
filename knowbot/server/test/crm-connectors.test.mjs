// The CRM and e-mail-list connectors (server/crm/connectors) against the fake vendor server: auth (pasted token and
// OAuth), token refresh, create, dedupe/update, the note, error mapping, 429 Retry-After, and the marketing-consent
// rules of the two list connectors. No real vendor is ever called.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeCrm, HUBSPOT_PAT, PIPEDRIVE_TOKEN, MAILCHIMP_KEY, CC_LIST } from './fake-crm.mjs';
import { harness, BOT, leaks } from './crm-helpers.mjs';
import { backoffMs } from '../crm/index.mjs';
import { soql } from '../crm/connectors/salesforce.mjs';
import { subscriberHash } from '../crm/connectors/mailchimp.mjs';
import { DATA_CENTRES } from '../crm/connectors/zoho.mjs';
import { hostAllowed } from '../crm/oauth.mjs';

let fake;
before(async () => { fake = await startFakeCrm(); });
after(async () => { await fake.close(); });

const ENV = Object.fromEntries(['HUBSPOT', 'SALESFORCE', 'PIPEDRIVE', 'ZOHO', 'MAILCHIMP', 'CONSTANTCONTACT'].flatMap((k) => [[`KNOWBOT_${k}_CLIENT_ID`, `${k.toLowerCase()}-client-id`], [`KNOWBOT_${k}_CLIENT_SECRET`, `${k.toLowerCase()}-client-secret-VALUE`]]));
const REDIRECT = (id) => `https://agent.knowbot.app/api/studio/crm/callback/${id}`;
/** One-click sign-in end to end: the authorize URL, then the callback with the fake's code. */
async function signIn(H, id, options = {}, query = {}) {
  const { url } = await H.crm.oauthStart(H.T, id, { bearer: 'trial-bearer', origin: 'https://knowbot.app', redirectUri: REDIRECT(id), options });
  const u = new URL(url);
  await H.crm.oauthFinish({ id, state: u.searchParams.get('state'), code: 'code-ok', query });
  return u;
}
const conn = async (H, id) => (await H.crm.view(H.T)).connectors.find((c) => c.id === id);
const lastLog = async (H, id) => (await H.crm.logOf(H.T, id)).log[0];
const calls = (n, re) => fake.since(n).filter((r) => re.test(`${r.method} ${r.path}`));

describe('one-click sign-in (OAuth) shared rules', () => {
  test('offered only when the app credentials are set; the state is sealed, bound to the trial, single use, and per connector', async () => {
    const off = harness(fake);
    const v = await off.crm.view(off.T);
    for (const id of ['hubspot', 'salesforce', 'pipedrive', 'zoho', 'mailchimp', 'constantcontact']) assert.equal(v.connectors.find((c) => c.id === id).auth.oauth.available, false, id);
    assert.ok(v.connectors.find((c) => c.id === 'hubspot').auth.token, 'HubSpot still connects with a pasted token');
    assert.ok(v.connectors.find((c) => c.id === 'pipedrive').auth.token);
    assert.equal(v.connectors.find((c) => c.id === 'salesforce').auth.token, undefined);
    assert.ok(!JSON.stringify(v).includes('KNOWBOT_'), 'the reason is never in the customer view');
    assert.ok(off.logs.some((l) => /one-click connect is off until these are set: .*KNOWBOT_SALESFORCE_CLIENT_ID/.test(l)), 'the operator log names what to set');
    await assert.rejects(off.crm.oauthStart(off.T, 'salesforce', { redirectUri: REDIRECT('salesforce') }), (e) => e.code === 'config' && /not available yet/.test(e.message));

    const H = harness(fake, { env: ENV });
    const { url } = await H.crm.oauthStart(H.T, 'hubspot', { bearer: 'trial-bearer', origin: 'https://knowbot.app', redirectUri: REDIRECT('hubspot') });
    const u = new URL(url);
    assert.equal(u.searchParams.get('client_id'), 'hubspot-client-id');
    assert.equal(u.searchParams.get('redirect_uri'), REDIRECT('hubspot'));
    assert.equal(u.searchParams.get('scope'), 'crm.objects.contacts.read crm.objects.contacts.write');
    const state = u.searchParams.get('state');
    assert.ok(state.length > 80 && !state.includes(BOT) && !url.includes('client-secret'), 'opaque: no trial id, verifier or secret in the URL');
    assert.equal(H.crm.oauthPeek(state).t, BOT);
    await assert.rejects(H.crm.oauthFinish({ id: 'pipedrive', state, code: 'code-ok' }), (e) => e.code === 'bad_state', 'a HubSpot state cannot finish a Pipedrive sign-in');
    const again = new URL((await H.crm.oauthStart(H.T, 'hubspot', { redirectUri: REDIRECT('hubspot') })).url).searchParams.get('state');
    await H.crm.oauthFinish({ id: 'hubspot', state: again, code: 'code-ok' });
    await assert.rejects(H.crm.oauthFinish({ id: 'hubspot', state: again, code: 'code-ok' }), (e) => e.code === 'bad_state' && /already used/.test(e.message));
    await assert.rejects(H.crm.oauthFinish({ id: 'hubspot', state: `${again.slice(0, -2)}xx`, code: 'code-ok' }), (e) => e.code === 'bad_state');
    const cancelled = new URL((await H.crm.oauthStart(H.T, 'hubspot', { redirectUri: REDIRECT('hubspot') })).url).searchParams.get('state');
    await assert.rejects(H.crm.oauthFinish({ id: 'hubspot', state: cancelled, code: '' }), (e) => e.code === 'denied');
    const late = new URL((await H.crm.oauthStart(H.T, 'hubspot', { redirectUri: REDIRECT('hubspot') })).url).searchParams.get('state');
    H.clock.advance(16 * 60000);
    await assert.rejects(H.crm.oauthFinish({ id: 'hubspot', state: late, code: 'code-ok' }), (e) => e.code === 'bad_state' && /too long/.test(e.message));
    const refused = new URL((await H.crm.oauthStart(H.T, 'hubspot', { redirectUri: REDIRECT('hubspot') })).url).searchParams.get('state');
    await assert.rejects(H.crm.oauthFinish({ id: 'hubspot', state: refused, code: 'wrong-code' }), (e) => e.code === 'auth');
    // nothing secret is in the view, the saved state or the logs
    const all = JSON.stringify(await H.crm.view(H.T)) + JSON.stringify(H.T.flags) + H.logs.join('\n');
    assert.deepEqual(leaks(all, ['hubspot-client-secret-VALUE', 'RTOK_', 'ATOK_', 'code-ok']), []);
    assert.ok(hostAllowed('https://eu1.my.salesforce.com', ['salesforce.com']) && !hostAllowed('https://salesforce.com.evil.test', ['salesforce.com']) && !hostAllowed('http://x.salesforce.com', ['salesforce.com']) && !hostAllowed('https://x.salesforce.com:8443', ['salesforce.com']));
  });
});

describe('HubSpot', () => {
  test('pasted private-app token: verified, sealed, masked; a bad token is refused in plain words', async () => {
    const H = harness(fake);
    await assert.rejects(H.crm.connect(H.T, 'hubspot', { token: 'short' }), (e) => e.code === 'invalid' && /does not look like/.test(e.message));
    await assert.rejects(H.crm.connect(H.T, 'hubspot', { token: 'pat-na1-this-token-is-not-valid-0000' }), (e) => e.code === 'auth');
    assert.equal(H.T.flags.crm?.connections?.hubspot, undefined);
    await H.crm.connect(H.T, 'hubspot', { token: HUBSPOT_PAT, config: { leadStatus: 'OPEN' } });
    const c = await conn(H, 'hubspot');
    assert.equal(c.connection.status, 'connected');
    assert.equal(c.connection.account, 'HubSpot account 4242');
    assert.equal(c.connection.hint, `…${HUBSPOT_PAT.slice(-4)}`);
    assert.equal(c.connection.config.leadStatus, 'OPEN');
    assert.equal(c.connection.config.lifecycle, 'lead', 'defaults fill the rest');
    assert.deepEqual(leaks(JSON.stringify(await H.crm.view(H.T)) + JSON.stringify(H.T.flags) + H.logs.join('\n'), [HUBSPOT_PAT]), []);
    await assert.rejects(H.crm.setConfig(H.T, 'hubspot', { ownerId: 'not-a-number' }), (e) => e.code === 'invalid');
    await assert.rejects(H.crm.setConfig(H.T, 'hubspot', { lifecycle: 'customer; DROP' }), (e) => e.code === 'invalid');
  });

  test('create a contact with a note; the same e-mail later updates it (no duplicate) and adds a second note; phone-only leads match by phone', async () => {
    const H = harness(fake);
    await H.crm.connect(H.T, 'hubspot', { token: HUBSPOT_PAT, config: { ownerId: '77', sourceProperty: 'lead_source' } });
    const n0 = fake.state.hubspot.contacts.length, notes0 = fake.state.hubspot.notes.length;
    await H.lead({ value: 'hs.new@example.com', question: 'Do you price match?' });
    const c = fake.state.hubspot.contacts.at(-1);
    assert.equal(fake.state.hubspot.contacts.length, n0 + 1);
    assert.deepEqual(c.properties, { email: 'hs.new@example.com', lifecyclestage: 'lead', hs_lead_status: 'NEW', hubspot_owner_id: '77', lead_source: 'KnowBot' });
    const note = fake.state.hubspot.notes.at(-1);
    assert.equal(note.associations[0].to.id, c.id);
    assert.deepEqual(note.associations[0].types, [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]);
    assert.match(note.properties.hs_note_body, /Asked: Do you price match\?<br>/);
    assert.match(note.properties.hs_note_body, /Consent: Asked the bot to send them the answer/);
    assert.equal(note.properties.hs_timestamp, new Date(H.clock.now()).toISOString());
    let row = await lastLog(H, 'hubspot');
    assert.equal(row.action, 'created');
    assert.equal(row.recordUrl, `https://app.hubspot.com/contacts/4242/record/0-1/${c.id}`);
    H.clock.advance(60000);
    await H.lead({ value: 'HS.New@example.com', question: 'And delivery?' });
    assert.equal(fake.state.hubspot.contacts.length, n0 + 1, 'updated, not duplicated');
    assert.equal(fake.state.hubspot.notes.length, notes0 + 2);
    row = await lastLog(H, 'hubspot');
    assert.equal(row.action, 'updated');
    // phone-only
    H.clock.advance(60000);
    await H.lead({ value: '+14155550144', channel: 'sms', consent: 'inbound_message' });
    assert.equal(fake.state.hubspot.contacts.at(-1).properties.phone, '+14155550144');
    H.clock.advance(2 * 86400000);
    await H.lead({ value: '+14155550144', channel: 'sms', consent: 'inbound_message' });
    assert.equal(fake.state.hubspot.contacts.length, n0 + 2);
  });

  test('a retry never writes a second note or a second contact; a 409 on create updates the existing contact', async () => {
    const H = harness(fake);
    await H.crm.connect(H.T, 'hubspot', { token: HUBSPOT_PAT });
    const n0 = fake.state.hubspot.contacts.length, notes0 = fake.state.hubspot.notes.length;
    fake.failNext(/POST \/hubspot\/crm\/v3\/objects\/notes/, { status: 502 });
    await H.lead({ value: 'hs.retry@example.com' });
    assert.equal(fake.state.hubspot.contacts.length, n0 + 1);
    assert.equal(fake.state.hubspot.notes.length, notes0);
    const mark = fake.requests.length;
    H.clock.advance(backoffMs(1));
    await H.crm.tick(); await H.crm.idle();
    assert.equal(fake.state.hubspot.contacts.length, n0 + 1);
    assert.equal(fake.state.hubspot.notes.length, notes0 + 1);
    assert.equal(calls(mark, /contacts/).length, 0, 'the retry went straight to the note');
    // the search misses (indexing lag) but the create conflicts: we update the contact HubSpot names
    fake.failNext(/POST \/hubspot\/crm\/v3\/objects\/contacts\/search/, { status: 200, body: { total: 0, results: [] } });
    H.clock.advance(1000);
    await H.lead({ value: 'hs.retry@example.com', question: 'again' });
    assert.equal(fake.state.hubspot.contacts.length, n0 + 1);
    assert.equal((await lastLog(H, 'hubspot')).action, 'updated');
  });

  test('error mapping: 401 → needs attention with what to do; 429 waits for Retry-After; a rejected record is final with the vendor’s words', async () => {
    const H = harness(fake);
    await H.crm.connect(H.T, 'hubspot', { token: HUBSPOT_PAT });
    fake.failNext(/POST \/hubspot\/crm\/v3\/objects\/contacts\/search/, { status: 429, headers: { 'retry-after': '120' } });
    await H.lead({ value: 'hs.429@example.com' });
    assert.equal(H.doc().queue[0].nextAt - H.clock.now(), 120000);
    assert.equal((await lastLog(H, 'hubspot')).result, 'retrying');
    H.clock.advance(120000);
    fake.valid.delete(HUBSPOT_PAT); // the owner revoked the token
    await H.crm.tick(); await H.crm.idle();
    let c = await conn(H, 'hubspot');
    assert.equal(c.connection.status, 'attention');
    assert.match(c.connection.problem.message, /HubSpot no longer accepts this connection/);
    assert.equal(c.connection.problem.action, 'Reconnect HubSpot.');
    assert.equal(H.doc().queue.length, 1, 'the lead waits for the reconnect');
    fake.valid.add(HUBSPOT_PAT);
    await H.crm.connect(H.T, 'hubspot', { token: HUBSPOT_PAT });
    H.clock.advance(backoffMs(2));
    await H.crm.tick(); await H.crm.idle();
    c = await conn(H, 'hubspot');
    assert.equal(c.connection.status, 'connected');
    assert.equal(H.doc().queue.length, 0);
    fake.failNext(/POST \/hubspot\/crm\/v3\/objects\/contacts$/, { status: 400, body: { status: 'error', message: 'Property values were not valid: hubspot_owner_id' } });
    H.clock.advance(1000);
    await H.lead({ value: 'hs.bad@example.com' });
    const row = await lastLog(H, 'hubspot');
    assert.equal(row.result, 'failed');
    assert.match(row.error, /HubSpot did not accept this lead\. HubSpot said: “Property values were not valid: hubspot_owner_id”/);
    assert.equal(H.doc().dead.length, 1);
  });

  test('OAuth: the code is exchanged server side, the refresh token sealed; an expired access token is refreshed (single flight) and a refused refresh asks to reconnect', async () => {
    const H = harness(fake, { env: ENV });
    const t0 = fake.state.tokenCalls.length;
    await signIn(H, 'hubspot');
    const ex = fake.state.tokenCalls[t0];
    assert.deepEqual({ grant_type: ex.grant_type, client_id: ex.client_id, client_secret: ex.client_secret, redirect_uri: ex.redirect_uri, code: ex.code },
      { grant_type: 'authorization_code', client_id: 'hubspot-client-id', client_secret: 'hubspot-client-secret-VALUE', redirect_uri: REDIRECT('hubspot'), code: 'code-ok' });
    assert.equal(H.T.flags.crm.connections.hubspot.kind, 'oauth');
    assert.equal((await conn(H, 'hubspot')).connection.account, 'HubSpot account 4242');
    await H.lead({ value: 'hs.oauth@example.com' });
    assert.equal(fake.state.tokenCalls.length, t0 + 1, 'the first access token is used as is');
    // 31 minutes later the access token is past its 30 minutes: refreshed once, even for two leads at the same time
    H.clock.advance(31 * 60000);
    H.leads.lead({ botId: BOT, value: 'hs.a@example.com', at: H.clock.now() });
    H.leads.lead({ botId: BOT, value: 'hs.b@example.com', at: H.clock.now() + 1 });
    await H.crm.idle();
    const refreshes = fake.state.tokenCalls.slice(t0 + 1);
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].grant_type, 'refresh_token');
    assert.match(refreshes[0].refresh_token, /^RTOK_\d+$/);
    // the vendor expires the access token early: a 401 triggers one refresh and the call is repeated
    for (const t of [...fake.valid]) if (/^ATOK_/.test(t)) fake.valid.delete(t);
    H.clock.advance(1000);
    await H.lead({ value: 'hs.c@example.com' });
    assert.equal((await lastLog(H, 'hubspot')).result, 'delivered');
    assert.equal(fake.state.tokenCalls.length, t0 + 3);
    // the owner removed the app in HubSpot: the refresh is refused
    fake.refresh.clear();
    for (const t of [...fake.valid]) if (/^ATOK_/.test(t)) fake.valid.delete(t);
    H.clock.advance(1000);
    await H.lead({ value: 'hs.d@example.com' });
    const c = await conn(H, 'hubspot');
    assert.equal(c.connection.status, 'attention');
    assert.equal(c.connection.problem.action, 'Reconnect HubSpot.');
    assert.deepEqual(leaks(H.logs.join('\n') + JSON.stringify(await H.crm.view(H.T)) + JSON.stringify(H.T.flags) + H.docs.get(BOT), ['hubspot-client-secret-VALUE', 'RTOK_', 'ATOK_']), []);
  });
});

describe('Salesforce', () => {
  test('web-server flow with PKCE, production or sandbox login host; Lead created with LastName/Company, then updated by e-mail; a completed Task carries the question', async () => {
    const H = harness(fake, { env: ENV });
    const t0 = fake.state.tokenCalls.length;
    const u = await signIn(H, 'salesforce', { sandbox: '1' });
    assert.equal(u.pathname, '/sf/services/oauth2/authorize');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('scope'), 'api refresh_token');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('code_challenge'), /^[\w-]{43}$/);
    assert.match(fake.state.tokenCalls[t0].code_verifier, /^[\w-]{43}$/);
    const c = await conn(H, 'salesforce');
    assert.equal(c.connection.account, 'Salesforce (owner@example.com) · sandbox');
    assert.equal(c.auth.token, undefined, 'Salesforce has no pasted-token option');
    const n0 = fake.state.sf.leads.length;
    await H.lead({ value: "o'brien@example.com", question: 'Trade discount?' });
    const lead = fake.state.sf.leads.at(-1);
    assert.equal(fake.state.sf.leads.length, n0 + 1);
    assert.deepEqual({ LastName: lead.LastName, Company: lead.Company, Email: lead.Email, LeadSource: lead.LeadSource }, { LastName: "o'brien", Company: 'Unknown', Email: "o'brien@example.com", LeadSource: 'KnowBot' });
    assert.match(lead.Description, /Asked: Trade discount\?/);
    const task = fake.state.sf.tasks.at(-1);
    assert.deepEqual({ WhoId: task.WhoId, Status: task.Status }, { WhoId: lead.Id, Status: 'Completed' });
    assert.match(task.Subject, /^KnowBot lead: Trade discount\?/);
    assert.match(task.Description, /Consent: Asked the bot to send them the answer/);
    const row = await lastLog(H, 'salesforce');
    assert.equal(row.action, 'created');
    assert.equal(row.recordUrl, `${fake.url}/sf/${lead.Id}`);
    // the same e-mail (with a quote in it: SOQL-escaped) is found, not duplicated; a note instead of a task when chosen
    await H.crm.setConfig(H.T, 'salesforce', { activity: 'note', leadSource: 'Chatbot' });
    H.clock.advance(1000);
    await H.lead({ value: "o'brien@example.com", question: 'Second question' });
    assert.equal(fake.state.sf.leads.length, n0 + 1);
    assert.equal(fake.state.sf.notes.at(-1).ParentId, lead.Id);
    assert.equal((await lastLog(H, 'salesforce')).action, 'updated');
    assert.equal(soql("a'b\\c\n"), "a\\'b\\\\c");
  });

  test('upsert on an external id when configured; a session that expired is refreshed on the 401; REQUEST_LIMIT_EXCEEDED is a rate limit', async () => {
    const H = harness(fake, { env: ENV });
    await signIn(H, 'salesforce');
    await H.crm.setConfig(H.T, 'salesforce', { externalIdField: 'KnowBot_Contact__c', ownerId: '005000000000001AAA' });
    const n0 = fake.state.sf.leads.length;
    const mark = fake.requests.length;
    await H.lead({ value: 'ext@example.com' });
    assert.equal(calls(mark, /query/).length, 0, 'no search: Salesforce dedupes on the external id');
    assert.equal(calls(mark, /PATCH \/sf\/services\/data\/v62\.0\/sobjects\/Lead\/KnowBot_Contact__c\/ext%40example\.com/).length, 1);
    assert.equal(fake.state.sf.leads.at(-1).OwnerId, '005000000000001AAA');
    H.clock.advance(1000);
    await H.lead({ value: 'ext@example.com', question: 'more' });
    assert.equal(fake.state.sf.leads.length, n0 + 1);
    assert.equal((await lastLog(H, 'salesforce')).action, 'updated');
    // the access token dies (no expires_in from Salesforce): the 401 refreshes it once
    const t0 = fake.state.tokenCalls.length;
    for (const t of [...fake.valid]) if (/^ATOK_/.test(t)) fake.valid.delete(t);
    H.clock.advance(1000);
    await H.lead({ value: 'ext2@example.com' });
    assert.equal(fake.state.tokenCalls.length, t0 + 1);
    assert.equal((await lastLog(H, 'salesforce')).result, 'delivered');
    fake.failNext(/PATCH \/sf\/.*Lead/, { status: 403, body: [{ message: 'TotalRequests Limit exceeded.', errorCode: 'REQUEST_LIMIT_EXCEEDED' }] });
    H.clock.advance(1000);
    await H.lead({ value: 'ext3@example.com' });
    assert.equal(H.doc().queue[0].lastError.code, 'rate_limited');
    assert.equal(H.doc().queue[0].nextAt - H.clock.now(), 15 * 60000);
  });
});

describe('Pipedrive', () => {
  test('pasted API token: person found or created by e-mail, a Lead, a note; the next question goes to the open lead as a note', async () => {
    const H = harness(fake);
    await assert.rejects(H.crm.connect(H.T, 'pipedrive', { token: 'nope' }), (e) => e.code === 'invalid');
    await H.crm.connect(H.T, 'pipedrive', { token: PIPEDRIVE_TOKEN, config: { ownerId: '9' } });
    assert.equal((await conn(H, 'pipedrive')).connection.account, 'Pipedrive (Fake Co)');
    const P = fake.state.pd;
    const [p0, l0, n0] = [P.persons.length, P.leads.length, P.notes.length];
    const mark = fake.requests.length;
    await H.lead({ value: 'pd.one@example.com', question: 'Bulk pricing?' });
    assert.equal(calls(mark, /./)[0].headers['x-api-token'], PIPEDRIVE_TOKEN);
    const person = P.persons.at(-1);
    assert.deepEqual({ name: person.name, emails: person.emails, owner_id: person.owner_id }, { name: 'pd.one', emails: [{ value: 'pd.one@example.com', primary: true, label: 'work' }], owner_id: 9 });
    const lead = P.leads.at(-1);
    assert.deepEqual({ title: lead.title, person_id: lead.person_id, owner_id: lead.owner_id }, { title: 'pd.one (Lumen Helper)', person_id: person.id, owner_id: 9 });
    assert.deepEqual({ lead_id: P.notes.at(-1).lead_id, person_id: P.notes.at(-1).person_id }, { lead_id: lead.id, person_id: person.id });
    assert.match(P.notes.at(-1).content, /Asked: Bulk pricing\?/);
    assert.equal((await lastLog(H, 'pipedrive')).recordUrl, `https://fakeco.pipedrive.com/leads/inbox/${lead.id}`);
    H.clock.advance(1000);
    await H.lead({ value: 'pd.one@example.com', question: 'Lead time?' });
    assert.deepEqual([P.persons.length, P.leads.length, P.notes.length], [p0 + 1, l0 + 1, n0 + 2], 'one person, one lead, two notes');
    assert.equal((await lastLog(H, 'pipedrive')).action, 'updated');
    // a phone lead with a name, as a Deal in a chosen pipeline
    await H.crm.setConfig(H.T, 'pipedrive', { object: 'deal', pipelineId: '3', stageId: '12' });
    H.clock.advance(1000);
    await H.lead({ value: '+14155550166', channel: 'phone', consent: 'callback_request', name: 'Sam Doe' });
    assert.deepEqual(P.persons.at(-1).phones, [{ value: '+14155550166', primary: true, label: 'work' }]);
    const deal = P.deals.at(-1);
    assert.deepEqual({ title: deal.title, pipeline_id: deal.pipeline_id, stage_id: deal.stage_id }, { title: 'Sam Doe (Lumen Helper)', pipeline_id: 3, stage_id: 12 });
    assert.equal(P.notes.at(-1).deal_id, deal.id);
  });

  test('OAuth: Basic client auth on the token call, Bearer on the API, a rotated access token on refresh', async () => {
    const H = harness(fake, { env: ENV });
    const t0 = fake.state.tokenCalls.length;
    await signIn(H, 'pipedrive');
    assert.equal(fake.state.tokenCalls[t0].basic, `Basic ${Buffer.from('pipedrive-client-id:pipedrive-client-secret-VALUE').toString('base64')}`);
    assert.equal(fake.state.tokenCalls[t0].client_secret, undefined, 'not repeated in the body');
    const mark = fake.requests.length;
    await H.lead({ value: 'pd.oauth@example.com' });
    assert.match(calls(mark, /persons/)[0].headers.authorization, /^Bearer ATOK_\d+$/);
    H.clock.advance(31 * 60000);
    await H.lead({ value: 'pd.oauth2@example.com' });
    assert.equal(fake.state.tokenCalls.at(-1).grant_type, 'refresh_token');
    assert.equal((await lastLog(H, 'pipedrive')).result, 'delivered');
  });
});

describe('Zoho CRM', () => {
  test('data-centre aware sign-in; Leads upsert with a duplicate check on Email; a note; an existing lead keeps its name', async () => {
    const H = harness(fake, { env: ENV });
    assert.equal(DATA_CENTRES.eu, 'https://accounts.zoho.eu');
    assert.equal(DATA_CENTRES['com.au'], 'https://accounts.zoho.com.au');
    // without the test base the sign-in starts on the data centre the owner picks
    const real = harness(fake, { env: ENV, crm: { bases: {} } });
    for (const [dc, host] of [['com', 'accounts.zoho.com'], ['eu', 'accounts.zoho.eu'], ['in', 'accounts.zoho.in'], ['com.au', 'accounts.zoho.com.au'], ['jp', 'accounts.zoho.jp'], ['ca', 'accounts.zohocloud.ca']]) {
      const u = new URL((await real.crm.oauthStart(real.T, 'zoho', { redirectUri: REDIRECT('zoho'), options: { dc } })).url);
      assert.equal(u.host, host);
      assert.equal(u.pathname, '/oauth/v2/auth');
      assert.equal(u.searchParams.get('access_type'), 'offline');
      assert.equal(u.searchParams.get('scope'), 'ZohoCRM.modules.leads.ALL,ZohoCRM.modules.notes.CREATE,ZohoSearch.securesearch.READ');
    }
    assert.equal(new URL((await real.crm.oauthStart(real.T, 'zoho', { redirectUri: REDIRECT('zoho'), options: { dc: 'evil.test' } })).url).host, 'accounts.zoho.com', 'an unknown data centre falls back');
    await signIn(H, 'zoho', { dc: 'eu' }, { location: 'eu', 'accounts-server': 'https://accounts.zoho.eu' });
    const Z = fake.state.zoho;
    const [l0, n0] = [Z.leads.length, Z.notes.length];
    const mark = fake.requests.length;
    await H.lead({ value: 'zo.one@example.com', question: 'Warranty?' });
    assert.match(calls(mark, /Leads/)[0].headers.authorization, /^Zoho-oauthtoken ATOK_\d+$/);
    const up = calls(mark, /POST \/zoho\/crm\/v8\/Leads\/upsert/)[0].body;
    assert.deepEqual(up.duplicate_check_fields, ['Email']);
    assert.deepEqual(up.trigger, ['workflow']);
    assert.deepEqual({ Last_Name: up.data[0].Last_Name, Email: up.data[0].Email, Lead_Source: up.data[0].Lead_Source }, { Last_Name: 'zo.one', Email: 'zo.one@example.com', Lead_Source: 'KnowBot' });
    const lead = Z.leads.at(-1);
    assert.equal(Z.notes.at(-1).lead, lead.id);
    assert.match(Z.notes.at(-1).Note_Content, /Asked: Warranty\?/);
    lead.Last_Name = 'Real Name'; // a person fixed the name in Zoho
    H.clock.advance(1000);
    await H.lead({ value: 'zo.one@example.com', question: 'Returns?' });
    assert.deepEqual([Z.leads.length, Z.notes.length], [l0 + 1, n0 + 2]);
    assert.equal(lead.Last_Name, 'Real Name', 'an existing lead is not overwritten with a made-up name');
    assert.equal((await lastLog(H, 'zoho')).action, 'updated');
    // phone-only: the duplicate check is on Phone; a per-record error is final with Zoho's words
    await H.crm.setConfig(H.T, 'zoho', { workflows: '' });
    const m2 = fake.requests.length;
    H.clock.advance(1000);
    await H.lead({ value: '+14155550177', channel: 'sms', consent: 'inbound_message' });
    const up2 = calls(m2, /upsert/)[0].body;
    assert.deepEqual([up2.duplicate_check_fields, up2.trigger], [['Phone'], []]);
    fake.failNext(/POST \/zoho\/crm\/v8\/Leads\/upsert/, { status: 202, body: { data: [{ code: 'INVALID_DATA', details: { api_name: 'Owner' }, message: 'invalid data', status: 'error' }] } });
    H.clock.advance(1000);
    await H.lead({ value: 'zo.bad@example.com' });
    const row = await lastLog(H, 'zoho');
    assert.equal(row.result, 'failed');
    assert.match(row.error, /Zoho CRM did not accept this lead\. Zoho CRM said: “invalid data”/);
  });

  test('a token error that arrives as HTTP 200 {error} is an auth error; INVALID_TOKEN refreshes once', async () => {
    const H = harness(fake, { env: ENV });
    const st = new URL((await H.crm.oauthStart(H.T, 'zoho', { redirectUri: REDIRECT('zoho') })).url).searchParams.get('state');
    await assert.rejects(H.crm.oauthFinish({ id: 'zoho', state: st, code: 'expired-code' }), (e) => e.code === 'auth' && /Zoho CRM did not accept the sign-in/.test(e.message));
    await signIn(H, 'zoho');
    for (const t of [...fake.valid]) if (/^ATOK_/.test(t)) fake.valid.delete(t);
    const t0 = fake.state.tokenCalls.length;
    await H.lead({ value: 'zo.refresh@example.com' });
    assert.equal(fake.state.tokenCalls.length, t0 + 1);
    assert.equal((await lastLog(H, 'zoho')).result, 'delivered');
  });
});

describe('Mailchimp (a marketing list: consent first)', () => {
  test('API key: the data centre comes from the key; nothing is sent until the owner picks an audience', async () => {
    const H = harness(fake);
    await assert.rejects(H.crm.connect(H.T, 'mailchimp', { token: '0123456789abcdef0123456789abcdef' }), (e) => e.code === 'invalid' && /data centre/.test(e.action));
    await H.crm.connect(H.T, 'mailchimp', { token: MAILCHIMP_KEY });
    let c = await conn(H, 'mailchimp');
    assert.equal(c.kind, 'list');
    assert.equal(c.connection.account, 'Mailchimp (us21, 2 audiences)');
    assert.equal(c.connection.status, 'attention');
    assert.match(c.connection.problem.message, /Choose your audience to start sending leads/);
    assert.equal(c.connection.config.optIn, 'transactional', 'the default never subscribes anyone');
    await H.lead({ value: 'mc.early@example.com' });
    assert.equal(H.docs.size, 0, 'no audience yet: nothing queued');
    await assert.rejects(H.crm.test(H.T, 'mailchimp'), (e) => e.code === 'invalid' && /Choose your audience first/.test(e.message));
    assert.deepEqual((await H.crm.listsOf(H.T, 'mailchimp')).lists, [{ id: 'aud0001', name: 'Newsletter' }, { id: 'aud0002', name: 'Customers' }]);
    await assert.rejects(H.crm.setConfig(H.T, 'mailchimp', { listId: '../../evil' }), (e) => e.code === 'invalid');
    await H.crm.setConfig(H.T, 'mailchimp', { listId: 'aud0001' });
    c = await conn(H, 'mailchimp');
    assert.equal(c.connection.status, 'connected');
    assert.deepEqual(leaks(JSON.stringify(await H.crm.view(H.T)) + JSON.stringify(H.T.flags) + H.logs.join('\n'), [MAILCHIMP_KEY]), []);
  });

  test('a new member is added as a non-subscribed contact by default, tagged, with a note carrying the consent label; an existing member’s status is never changed', async () => {
    const H = harness(fake);
    await H.crm.connect(H.T, 'mailchimp', { token: MAILCHIMP_KEY, config: { listId: 'aud0001' } });
    const mark = fake.requests.length;
    await H.lead({ value: 'MC.One@Example.com', name: 'Ada Lovelace', question: 'Do you ship abroad?' });
    const hash = subscriberHash('mc.one@example.com');
    assert.equal(hash, subscriberHash(' MC.One@Example.com '));
    const put = calls(mark, new RegExp(`PUT /mc/3.0/lists/aud0001/members/${hash}$`))[0];
    assert.deepEqual(put.body, { email_address: 'mc.one@example.com', status_if_new: 'transactional', merge_fields: { FNAME: 'Ada', LNAME: 'Lovelace' } });
    assert.equal('status' in put.body, false, 'never `status`: an existing member keeps their own choice');
    const tags = calls(mark, /POST .*\/tags$/)[0].body.tags;
    assert.deepEqual(tags, [{ name: 'KnowBot', status: 'active' }, { name: 'Lumen Helper', status: 'active' }, { name: 'Website chat', status: 'active' }, { name: 'consent: asked to send', status: 'active' }]);
    const note = calls(mark, /POST .*\/notes$/)[0].body.note;
    assert.match(note, /Asked: Do you ship abroad\?/);
    assert.match(note, /Consent: Asked the bot to send them the answer/);
    assert.ok(note.length <= 1000);
    assert.equal(fake.state.mc.members[`aud0001/${hash}`].status, 'transactional');
    // the owner explicitly chooses double opt-in, then states they have consent: only then pending / subscribed
    await H.crm.setConfig(H.T, 'mailchimp', { optIn: 'pending', phoneField: 'PHONE' });
    H.clock.advance(1000);
    const m2 = fake.requests.length;
    await H.lead({ value: 'mc.two@example.com' });
    assert.equal(calls(m2, /PUT /)[0].body.status_if_new, 'pending');
    await H.crm.setConfig(H.T, 'mailchimp', { optIn: 'subscribed' });
    H.clock.advance(1000);
    const m3 = fake.requests.length;
    await H.lead({ value: 'mc.three@example.com' });
    assert.equal(calls(m3, /PUT /)[0].body.status_if_new, 'subscribed');
    await assert.rejects(H.crm.setConfig(H.T, 'mailchimp', { optIn: 'cleaned' }), (e) => e.code === 'invalid');
    // someone who unsubscribed stays unsubscribed
    fake.state.mc.members[`aud0001/${hash}`].status = 'unsubscribed';
    H.clock.advance(1000);
    await H.lead({ value: 'mc.one@example.com', question: 'again' });
    assert.equal(fake.state.mc.members[`aud0001/${hash}`].status, 'unsubscribed');
  });

  test('phone-only leads are skipped and logged as “Skipped: no email address”; OAuth reads the data centre from the metadata endpoint', async () => {
    const H = harness(fake, { env: ENV });
    const u = await signIn(H, 'mailchimp');
    assert.equal(u.pathname, '/mc/oauth2/authorize');
    assert.equal(H.T.flags.crm.connections.mailchimp.kind, 'token', 'Mailchimp tokens do not expire: kept like a key, sealed');
    assert.equal((await conn(H, 'mailchimp')).connection.account, 'Mailchimp (Fake Shop)');
    await H.crm.setConfig(H.T, 'mailchimp', { listId: 'aud0002' });
    const mark = fake.requests.length;
    await H.lead({ value: '+14155550188', channel: 'sms', consent: 'inbound_message' });
    assert.equal(calls(mark, /\/mc\//).length, 0, 'nothing is sent to Mailchimp');
    const row = await lastLog(H, 'mailchimp');
    assert.equal(row.result, 'skipped');
    assert.equal(row.error, 'Skipped: no email address.');
    assert.equal(H.doc().queue.length, 0);
    await H.lead({ value: 'mc.oauth@example.com' });
    assert.match(calls(mark, /PUT /)[0].headers.authorization, /^Bearer ATOK_\d+$/);
    assert.equal((await lastLog(H, 'mailchimp')).result, 'delivered');
  });
});

describe('Constant Contact (a marketing list: consent first)', () => {
  test('OAuth only (Basic client auth, PKCE, rotating refresh token saved sealed); a list must be chosen', async () => {
    const H = harness(fake, { env: ENV });
    const t0 = fake.state.tokenCalls.length;
    const u = await signIn(H, 'constantcontact');
    assert.equal(u.searchParams.get('scope'), 'contact_data offline_access');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(fake.state.tokenCalls[t0].basic, /^Basic /);
    const c = await conn(H, 'constantcontact');
    assert.equal(c.auth.token, undefined);
    assert.equal(c.connection.status, 'attention');
    assert.equal(c.connection.config.optIn, 'implicit');
    assert.deepEqual((await H.crm.listsOf(H.T, 'constantcontact')).lists, [{ id: CC_LIST, name: 'General Interest' }]);
    await H.crm.setConfig(H.T, 'constantcontact', { listId: CC_LIST });
    // the refresh token rotates: the new one is sealed and saved, and the old one is never used again
    const sealed0 = H.T.flags.crm.connections.constantcontact.sealed;
    H.clock.advance(9 * 3600000);
    await H.lead({ value: 'cc.rot@example.com' });
    assert.notEqual(H.T.flags.crm.connections.constantcontact.sealed, sealed0);
    H.clock.advance(9 * 3600000);
    await H.lead({ value: 'cc.rot2@example.com' });
    assert.equal((await lastLog(H, 'constantcontact')).result, 'delivered');
    const used = fake.state.tokenCalls.slice(t0 + 1).map((x) => x.refresh_token);
    assert.equal(new Set(used).size, used.length);
  });

  test('default: created with implicit permission (never the sign-up form); an existing contact is only added to the list; explicit only when the owner says they have consent; phone-only skipped', async () => {
    const H = harness(fake, { env: ENV });
    await signIn(H, 'constantcontact');
    await H.crm.setConfig(H.T, 'constantcontact', { listId: CC_LIST, questionFieldId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const C = fake.state.cc;
    const mark = fake.requests.length;
    await H.lead({ value: 'cc.one@example.com', name: 'Grace Hopper', question: 'Opening hours?' });
    assert.equal(calls(mark, /sign_up_form/).length, 0);
    const made = C.contacts.at(-1);
    assert.deepEqual(made.email_address, { address: 'cc.one@example.com', permission_to_send: 'implicit' });
    assert.deepEqual({ create_source: made.create_source, first_name: made.first_name, last_name: made.last_name, list_memberships: made.list_memberships }, { create_source: 'Account', first_name: 'Grace', last_name: 'Hopper', list_memberships: [CC_LIST] });
    assert.deepEqual(made.custom_fields, [{ custom_field_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', value: 'Opening hours? [Asked the bot to send them the answer]' }]);
    // the same person again: only a list membership, their record and permission untouched
    const n = C.contacts.length, mships = C.memberships.length;
    H.clock.advance(1000);
    const m2 = fake.requests.length;
    await H.lead({ value: 'cc.one@example.com', question: 'Parking?' });
    assert.equal(C.contacts.length, n);
    assert.deepEqual(C.memberships.slice(mships), [{ source: { contact_ids: [made.contact_id] }, list_ids: [CC_LIST] }]);
    assert.equal(calls(m2, /POST \/cc\/v3\/contacts$/).length, 0);
    assert.equal((await lastLog(H, 'constantcontact')).action, 'updated');
    // phone-only
    H.clock.advance(1000);
    const m3 = fake.requests.length;
    await H.lead({ value: '+14155550199', channel: 'phone', consent: 'inbound_call' });
    assert.equal(calls(m3, /\/cc\/v3\//).length, 0);
    assert.deepEqual([(await lastLog(H, 'constantcontact')).result, (await lastLog(H, 'constantcontact')).error], ['skipped', 'Skipped: no email address.']);
    // the owner states they have consent: Constant Contact's own sign-up form endpoint
    await H.crm.setConfig(H.T, 'constantcontact', { optIn: 'explicit' });
    H.clock.advance(1000);
    const m4 = fake.requests.length;
    await H.lead({ value: 'cc.two@example.com' });
    const form = calls(m4, /POST \/cc\/v3\/contacts\/sign_up_form/)[0].body;
    assert.deepEqual({ email_address: form.email_address, list_memberships: form.list_memberships }, { email_address: 'cc.two@example.com', list_memberships: [CC_LIST] });
    assert.equal('permission_to_send' in form, false);
  });
});

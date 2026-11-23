// The store step of Launch: no KnowDrive store is ever picked for the owner. Signing in links the account only; the
// owner chooses the store, and every gate is enforced on the server (server/trials.mjs kdChooseStore):
//   - a store another account shared is never an option;
//   - a store that holds other files needs a second confirmation; one whose ownership KnowDrive does not confirm also
//     needs its name typed;
//   - a real write is proven before the choice is saved;
//   - nothing is written, moved, sold or launched without a recorded choice.
// Fakes only: never touches knowDrive or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { createKdAccount, classifyStore, shapeOf } from '../kdaccount.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 20;
const nextIp = () => `198.51.100.${ipSeq++ % 250}`;
const TOKEN_RE = /kd(?:at|rt|code)_[\w-]{10,}/;

async function boot() {
  const kd = await startFakeKnowDrive({ speed: 6, narrowScope: 'all' });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-kdstore-'));
  const logs = [];
  const env = { KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_KD_AUTH_URL: kd.url, KNOWBOT_CHECKOUT: 'knowdrive' };
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env,
    studio: { sweep: false, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400, kdPollMs: 30, logger: (x) => logs.push(String(x)) } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  return { kd, llm, kb, base, api, logs, async close() { kb.studio?.close?.(); await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}
function client(S) {
  const h = (t, extra = {}) => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': t.ip, origin: 'http://studio.test', ...extra });
  const c = {
    async trial() {
      const ip = nextIp();
      const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } });
      assert.equal(r.status, 201);
      return { ...(await r.json()), ip };
    },
    call: (t, p, method = 'GET', body) => S.api(`/api/studio/trials/${t.trialId}${p}`, { method, headers: h(t, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }),
    json: async (t, p, method, body) => (await c.call(t, p, method, body)).json(),
    /** → [status, error code | null, body] */
    async try(t, p, method, body) { const r = await c.call(t, p, method, body); const j = await r.json(); return [r.status, j.error?.code || null, j]; },
    upload: (t, name, text) => S.api(`/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: h(t, { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' }), body: Buffer.from(text) }),
    async waitReady(t, n, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const j = await c.json(t, '/files');
        if (j.files.length >= n && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) return j.files;
        await sleep(60);
      }
      throw new Error('files never became ready');
    },
    async signIn(t, email, action = 'signin') {
      const { url } = await c.json(t, '/kd/start', 'POST', { mode: action === 'create' ? 'signup' : 'signin' });
      await fetch(url);
      const u = new URL(url);
      const form = new URLSearchParams({ client_id: u.searchParams.get('client_id'), redirect_uri: u.searchParams.get('redirect_uri'), state: u.searchParams.get('state'),
        code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256', email, action });
      const r = await fetch(`${S.kd.url}/-/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
      assert.equal(r.status, 302, await r.text());
      assert.equal((await fetch(r.headers.get('location'), { redirect: 'manual' })).status, 200);
    },
    async waitMove(t, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const s = await c.json(t, '/kd'); if (s.move && ['done', 'partial', 'error', 'paused'].includes(s.move.state)) return s; await sleep(40); }
      throw new Error('move never finished');
    },
    /** A bot with two files of its own, ready. */
    async bot() {
      const t = await c.trial();
      for (const [n, text] of Object.entries(DOCS)) assert.equal((await c.upload(t, n, text)).status, 201);
      await c.waitReady(t, 2);
      return t;
    },
  };
  return c;
}
const convert = (S, t, body) => S.api(`/api/studio/trials/${t.trialId}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body) });
const DOCS = {
  'returns.md': '# Returns\n\nUnworn shoes can be returned within 60 days of delivery for a full refund.\n',
  'care.md': '# Shoe care\n\nLeather uppers should be cleaned with a damp cloth and conditioned every three months.\n',
};
/** Every write (anything but a GET) the stand-in saw against a store, by header or by a file in it. */
const writesTo = (S, storeIds, since = 0) => S.kd.calls.slice(since).filter((x) => x.method !== 'GET' && storeIds.includes(x.store));
const names = (S, store) => S.kd.auth.storeFiles(store).map((f) => f.filename).sort();

// ------------------------------------------------------------------------------------------------- the classification
describe('classifyStore: whose store is it?', () => {
  const me = { id: '00000000-0000-4000-8000-000000000001', email: 'Owner@Example.com' };
  const cls = (tenant, vector = null, extra = {}) => classifyStore({ tenant, vector, me, ...extra }).ownership;

  test('owned: the tenant list says owner and nothing contradicts it', () => {
    assert.equal(cls({ id: 's', owner: true, role: 'owner' }), 'owned');
    assert.equal(cls({ id: 's', owner: true }), 'owned');
    assert.equal(cls({ id: 's', role: 'Owner' }), 'owned');
    assert.equal(cls({ id: 's', is_owner: true }), 'owned');
    assert.equal(cls({ id: 's', owner: true, role: 'owner' }, { id: 's', created_by: 'bearer:owner@example.com' }, { vectorListed: true }), 'owned', 'the creator is this account (case-insensitive)');
    assert.equal(cls({ id: 's', owner: true, owner_id: me.id.toUpperCase() }), 'owned');
    assert.equal(cls({ id: 's', owner: true, created_by: 'system' }), 'owned', 'free text names nobody');
    assert.equal(cls({ id: 's', owner: true, shared: false, invited: 'false' }), 'owned', 'a false marker is no marker');
    assert.equal(cls({ id: 's', owner: { id: me.id }, role: 'owner' }), 'owned', 'an owner object that names this account');
  });

  test('shared: the tenant list does not say owner, and says it is someone else’s', () => {
    assert.equal(cls({ id: 's', owner: false, role: 'member' }), 'shared');
    assert.equal(cls({ id: 's', role: 'editor' }), 'shared');
    assert.equal(cls({ id: 's', role: 'admin' }), 'shared', 'only the role "owner" counts as owner');
    assert.equal(cls({ id: 's', owner: false }), 'shared');
    assert.equal(cls({ id: 's', shared: true }), 'shared');
    assert.equal(cls({ id: 's', invited_by: 'someone@else.com' }), 'shared');
    assert.equal(cls({ id: 's', owner_email: 'someone@else.com' }), 'shared');
    assert.equal(cls({ id: 's', owner: { id: '00000000-0000-4000-8000-000000000099', email: 'someone@else.com' } }), 'shared', 'an owner object naming another account');
    assert.equal(cls(null, { id: 's', created_by: 'bearer:someone@else.com' }, { vectorListed: true }), 'shared', 'only in the fallback list, created by someone else');
  });

  test('unconfirmed: the flags are missing or mixed (never auto-eligible)', () => {
    assert.equal(cls({ id: 's' }), 'unconfirmed', 'no ownership fields');
    assert.equal(cls(null, { id: 's', name: 'x' }, { vectorListed: true }), 'unconfirmed', 'only in the fallback list');
    assert.equal(cls(null, { id: 's', created_by: 'bearer:owner@example.com' }, { vectorListed: true }), 'unconfirmed', 'the creator alone is not the tenant list saying owner');
    // the production failure: flags say owner, but the store is another tenant's
    assert.equal(cls({ id: 's', owner: true, role: 'owner' }, { id: 's', created_by: 'bearer:someone@else.com' }, { vectorListed: true }), 'unconfirmed');
    assert.equal(cls({ id: 's', owner: true, role: 'member' }), 'unconfirmed');
    assert.equal(cls({ id: 's', owner: false, role: 'owner' }), 'unconfirmed');
    assert.equal(cls({ id: 's', owner: true, shared: true }), 'unconfirmed');
    assert.equal(cls({ id: 's', owner: true, shared_by: 'x' }), 'unconfirmed');
    assert.equal(cls({ id: 's', owner: true, owner_id: '00000000-0000-4000-8000-000000000099' }), 'unconfirmed');
    assert.equal(cls({ id: 's', owner: 'true' }), 'unconfirmed', 'only the boolean true is a yes');
    assert.equal(cls({ id: 's', owner: true, role: 'owner' }, null, { vectorListed: true }), 'unconfirmed', "missing from the account's own store list");
    assert.equal(cls({ id: 's', owner: true, role: 'owner' }, null, { vectorListed: false }), 'owned', 'an empty or unavailable own-store list says nothing');
    assert.equal(classifyStore({ tenant: { id: 's', owner: true, tenant_id: 't2' }, me: { ...me, tenant_id: 't1' } }).ownership, 'unconfirmed', 'another tenant');
    assert.equal(classifyStore({ tenant: { id: 's', owner: true, tenant_id: 't1' }, me: { ...me, tenant_id: 't1' } }).ownership, 'owned');
    assert.equal(classifyStore({}).ownership, 'unconfirmed');
  });

  test('the reasons name fields, and the logged shape carries names and types, never values', () => {
    const r = classifyStore({ tenant: { id: 's', owner: true, role: 'member' }, me });
    assert.deepEqual(r.reasons, ['+ owner flag', '- role is not owner']);
    assert.equal(shapeOf({ id: 'vs_secret', display_name: 'Private name', owner: true, role: 'Owner', plan: 'free', quota: 5, nested: { a: 1 }, list: [], none: null }),
      'display_name:string id:string list:array nested:object none:null owner:true plan:string quota:number role=owner');
  });
});

// ------------------------------------------------------------------------------------------------- the flow over HTTP
describe('the store step (HTTP): several stores, one shared by another account, one with other files', () => {
  let S, c, me, other, st;
  before(async () => {
    S = await boot(); c = client(S);
    const A = S.kd.auth;
    me = A.createAccount('multi@example.com');                      // its first store: empty
    other = A.createAccount('agency@example.com');
    st = { empty: me.store };
    st.handbook = A.addStore('multi@example.com', { name: 'Team handbook', files: [{ path: 'hr/leave.md', text: 'Leave policy' }, { path: 'hr/pay.md', text: 'Pay' }, { path: 'notes.txt', text: 'Notes' }] });
    st.readonly = A.addStore('multi@example.com', { name: 'Archive 2019', readOnly: true });
    // another account's stores, shared with this one
    st.shared = A.addStore('agency@example.com', { name: 'Acme client files', plan: 'pro', files: [{ path: 'live/a.md', text: 'A' }, { path: 'live/b.md', text: 'B' }] });
    A.shareStore(st.shared, 'multi@example.com', { role: 'member' });
    // what went wrong in production: KnowDrive's flags call a shared store "owner"; only the creator gives it away
    st.lying = A.addStore('agency@example.com', { name: 'Agency Bots', files: [{ path: 'bot/faq.md', text: 'FAQ' }] });
    A.shareStore(st.lying, 'multi@example.com', { role: 'owner', row: { owner: true } });
    // a store the tenant list reports with no ownership fields at all
    st.bare = A.addStore('multi@example.com', { name: 'Side project', row: { owner: undefined, role: undefined } });
  });
  after(async () => { await S.close(); });
  const all = () => Object.values(st);

  test('signing in links the account only: no store, nothing written, and move, checkout and launch all refuse', async () => {
    const t = await c.bot();
    const mark = S.kd.calls.length;
    await c.signIn(t, 'multi@example.com');
    const s = await c.json(t, '/kd');
    assert.deepEqual([s.status, s.account, s.store, s.storeRequired, s.ready], ['linked', me.id, null, true, false]);
    const T = S.kb.studio.trials.get(t.trialId);
    assert.deepEqual([T.kdLink.store, T.kdLink.storeChosenAt, T.kdLink.storeName], [null, undefined, undefined], 'the link carries no store');
    assert.deepEqual(await c.try(t, '/kd/move', 'POST', {}).then((x) => x.slice(0, 2)), [409, 'kd_store_required']);
    assert.deepEqual(await c.try(t, '/checkout', 'POST', { email: 'multi@example.com' }).then((x) => x.slice(0, 2)), [409, 'kd_store_required']);
    const cv = await convert(S, t, { account: me.id, bucketId: 'nostore' });
    assert.deepEqual([cv.status, (await cv.json()).error.code], [409, 'kd_store_required'], 'no launch without a chosen store');
    // looking at the list reads, and still writes nothing
    const ls = await c.json(t, '/kd/stores');
    assert.equal(ls.stores.length, 6);
    assert.deepEqual(writesTo(S, all(), mark), [], 'not one write to any store before a choice');
    assert.equal(S.kd.calls.slice(mark).filter((x) => x.method === 'DELETE').length, 0);
    assert.equal((await c.json(t, '/kd')).storeRequired, true, 'listing chose nothing');
  });

  test('the list: live, named, counted, labelled; a shared store is not selectable and is not opened', async () => {
    const t = await c.bot();
    await c.signIn(t, 'multi@example.com');
    const mark = S.kd.calls.length;
    const { stores, locked } = await c.json(t, '/kd/stores');
    assert.equal(locked, false);
    const by = Object.fromEntries(stores.map((x) => [x.id, x]));
    assert.deepEqual([by[st.empty].ownership, by[st.empty].selectable, by[st.empty].needs, by[st.empty].files], ['owned', true, 'none', 0]);
    assert.deepEqual([by[st.handbook].name, by[st.handbook].ownership, by[st.handbook].needs, by[st.handbook].files, by[st.handbook].otherFiles], ['Team handbook', 'owned', 'confirm', 3, 3]);
    assert.deepEqual([by[st.shared].name, by[st.shared].ownership, by[st.shared].selectable, by[st.shared].needs, by[st.shared].files], ['Acme client files', 'shared', false, null, null]);
    assert.deepEqual([by[st.lying].ownership, by[st.lying].selectable, by[st.lying].needs], ['unconfirmed', true, 'name'], 'flags say owner, the creator is someone else: never auto-eligible');
    assert.deepEqual([by[st.bare].ownership, by[st.bare].needs], ['unconfirmed', 'name'], 'no ownership fields: not confirmed');
    assert.ok(stores.every((x) => !('reasons' in x) && x.current === false));
    assert.equal(S.kd.calls.slice(mark).filter((x) => x.url.includes(st.shared)).length, 0, 'a store that cannot be used is never opened');
    // the real shape of the rows is learned from the log: field names, once, never a token or a value
    const shapes = S.logs.filter((l) => /^\[kd\] (?:tenant store row|vector store row|account) fields:/.test(l));
    assert.ok(shapes.some((l) => /tenant store row fields: .*display_name:string .*owner:(?:true|false) .*role=/.test(l)), shapes.join('\n'));
    assert.ok(shapes.some((l) => /vector store row fields: .*created_by:string/.test(l)));
    assert.equal(new Set(shapes).size, shapes.length, 'each shape is logged once');
    assert.doesNotMatch(S.logs.join('\n'), TOKEN_RE);
    assert.doesNotMatch(shapes.join('\n'), /example\.com|Acme|vs_acct/, 'names only, no values');
  });

  test('a store shared by another account is refused on the server; so is a store that is not in the account', async () => {
    const t = await c.bot();
    await c.signIn(t, 'multi@example.com');
    const mark = S.kd.calls.length;
    for (const body of [{ storeId: st.shared }, { storeId: st.shared, confirmed: true, typedName: 'Acme client files' }]) {
      const [status, code, j] = await c.try(t, '/kd/store', 'POST', body);
      assert.deepEqual([status, code], [403, 'kd_store_shared']);
      assert.match(j.error.message, /shared with you by another account/);
    }
    const stranger = S.kd.auth.addStore('agency@example.com', { name: 'Not shared at all' });
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: stranger, confirmed: true, typedName: 'Not shared at all' })).slice(0, 2), [409, 'kd_store_unknown']);
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: 'vs_fake_trials', confirmed: true })).slice(0, 2), [409, 'kd_store_unknown'], "KnowBot's own store is not the owner's");
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', {})).slice(0, 2), [400, 'bad_request']);
    assert.deepEqual(writesTo(S, [...all(), stranger], mark), []);
    assert.equal((await c.json(t, '/kd')).storeRequired, true);
    assert.deepEqual(names(S, st.shared), ['live/a.md', 'live/b.md']);
  });

  test('a store that already holds other files needs the confirmation; an empty one needs only the pick', async () => {
    const t = await c.bot();
    await c.signIn(t, 'multi@example.com');
    for (const body of [{ storeId: st.handbook }, { storeId: st.handbook, confirmed: 'yes' }, { storeId: st.handbook, confirmed: false }]) {
      assert.deepEqual((await c.try(t, '/kd/store', 'POST', body)).slice(0, 2), [409, 'kd_store_confirm']);
    }
    assert.equal((await c.json(t, '/kd')).storeRequired, true);
    const [status, , j] = await c.try(t, '/kd/store', 'POST', { storeId: st.handbook, confirmed: true });
    assert.equal(status, 200);
    assert.deepEqual([j.store.id, j.store.name, j.storeRequired], [st.handbook, 'Team handbook', false]);
    const T = S.kb.studio.trials.get(t.trialId);
    assert.deepEqual([T.kdLink.store, T.kdLink.storeName, T.kdLink.storeOwnership], [st.handbook, 'Team handbook', 'owned']);
    assert.ok(Date.parse(T.kdLink.storeChosenAt) > 0, 'the choice is on record');
    assert.deepEqual(names(S, st.handbook), ['hr/leave.md', 'hr/pay.md', 'notes.txt'], 'the write check left nothing, the owner’s files are untouched');
    assert.ok(S.logs.some((l) => l.includes(`${t.trialId} store chosen: ${st.handbook} (owned`) && /other=3; confirmed/.test(l)));
    // the files then go under the bot's own folder, next to the owner's files
    assert.equal((await c.call(t, '/kd/move', 'POST', {})).status, 202);
    const mv = await c.waitMove(t);
    assert.deepEqual([mv.move.state, mv.ready], ['done', true]);
    const after = S.kd.auth.storeFiles(st.handbook);
    assert.equal(after.length, 5);
    assert.ok(after.filter((f) => f.tags.includes(`knowbot:${t.trialId}`)).every((f) => f.filename.startsWith('KnowBot/')));
    assert.equal(S.kd.auth.storeFiles(st.empty).length, 0, 'nothing went to the store the old code would have picked');

    // an empty store: the pick alone
    const t2 = await c.bot();
    await c.signIn(t2, 'multi@example.com');
    assert.equal((await c.call(t2, '/kd/store', 'POST', { storeId: st.empty })).status, 200);
    // a store that holds only KnowBot's files (the bot above) is no "other files" case either
    const only = S.kd.auth.addStore('multi@example.com', { name: 'Bots only', files: [{ path: 'KnowBot/x/a.md', text: 'a', tags: ['knowbot', 'knowbot:tr_aaaaaaaaaaaaaaaa'] }] });
    const row = (await c.json(t2, '/kd/stores')).stores.find((x) => x.id === only);
    assert.deepEqual([row.needs, row.files, row.knowbotFiles, row.otherFiles], ['none', 1, 1, 0]);
    S.kd.auth.setStore(only, { row: { owner: false, role: 'viewer' } }); // out of the way for the other tests' counts
  });

  test('a store whose ownership is not confirmed needs the tick AND its name typed', async () => {
    const t = await c.bot();
    await c.signIn(t, 'multi@example.com');
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: st.lying })).slice(0, 2), [409, 'kd_store_confirm']);
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: st.lying, confirmed: true })).slice(0, 2), [409, 'kd_store_name']);
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: st.lying, confirmed: true, typedName: 'Agency Bot' })).slice(0, 2), [409, 'kd_store_name']);
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: st.lying, typedName: 'Agency Bots' })).slice(0, 2), [409, 'kd_store_confirm'], 'the name without the tick is not enough');
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: st.bare, confirmed: true, typedName: 'Team handbook' })).slice(0, 2), [409, 'kd_store_name'], "another store's name does not do");
    assert.equal((await c.json(t, '/kd')).storeRequired, true);
    assert.deepEqual(names(S, st.lying), ['bot/faq.md']);
    const [status, , j] = await c.try(t, '/kd/store', 'POST', { storeId: st.bare, confirmed: true, typedName: '  side   PROJECT ' });
    assert.equal(status, 200);
    assert.equal(j.store.name, 'Side project');
    assert.equal(S.kb.studio.trials.get(t.trialId).kdLink.storeOwnership, 'unconfirmed');
    assert.ok(S.logs.some((l) => l.includes(`store chosen: ${st.bare} (unconfirmed`) && /confirmed by name/.test(l)));
  });

  test('a store KnowBot cannot write to is not saved as the choice', async () => {
    const t = await c.bot();
    await c.signIn(t, 'multi@example.com');
    const [status, code, j] = await c.try(t, '/kd/store', 'POST', { storeId: st.readonly });
    assert.deepEqual([status, code], [409, 'kd_store_unwritable']);
    assert.match(j.error.message, /didn't let KnowBot save a file in "Archive 2019"/);
    const s = await c.json(t, '/kd');
    assert.deepEqual([s.store, s.storeRequired], [null, true]);
    assert.equal(S.kb.studio.trials.get(t.trialId).kdLink.store, null);
    assert.deepEqual((await c.try(t, '/kd/move', 'POST', {})).slice(0, 2), [409, 'kd_store_required']);
    assert.ok(S.logs.some((l) => l.includes(`store ${st.readonly} failed the write check`)));
    // the write check itself: one tiny file under the bot's own folder, with the owner's sign-in, removed at once
    const mark = S.kd.calls.length;
    assert.equal((await c.call(t, '/kd/store', 'POST', { storeId: st.empty })).status, 200);
    const probe = S.kd.calls.slice(mark).filter((x) => x.url === '/api/v1/ingest' && x.store !== 'vs_fake_trials' /* the bot's own state doc */);
    assert.equal(probe.length, 1);
    assert.ok(/^Bearer kdat_/.test(probe[0].auth) && probe[0].store === st.empty);
    assert.match(probe[0].ingest.path, /^KnowBot\/[^/]+\/_knowbot-check\.txt$/);
    assert.ok(probe[0].ingest.tags.includes(`knowbot:${t.trialId}`) && probe[0].ingest.bytes < 200);
    assert.equal(S.kd.calls.slice(mark).filter((x) => x.method === 'DELETE').length, 1);
    assert.equal(S.kd.auth.storeFiles(st.empty).length, 0);
  });

  test('changing the store before launch removes only this bot’s own copies from the earlier one, and says so', async () => {
    const A = S.kd.auth;
    const from = A.addStore('multi@example.com', { name: 'First pick', files: [{ path: 'mine/plan.md', text: 'My plan' },
      { path: 'KnowBot/other-bot/faq.md', text: 'Another bot', tags: ['knowbot', 'knowbot:tr_bbbbbbbbbbbbbbbb', 'kbsrc:file_zzz'] }] });
    const to = A.addStore('multi@example.com', { name: 'Second pick' });
    const t = await c.bot();
    await c.signIn(t, 'multi@example.com');
    assert.equal((await c.call(t, '/kd/store', 'POST', { storeId: from, confirmed: true })).status, 200);
    await c.call(t, '/kd/move', 'POST', {});
    assert.equal((await c.waitMove(t)).ready, true);
    assert.equal(A.storeFiles(from).length, 4);
    assert.equal((await c.json(t, '/kd/stores')).stores.find((x) => x.id === from).current, true);
    const mark = S.kd.calls.length;
    const [status, , j] = await c.try(t, '/kd/store', 'POST', { storeId: to });
    assert.equal(status, 200);
    assert.deepEqual(j.removed, { store: 'First pick', files: 2, failed: 0 });
    assert.deepEqual([j.store.id, j.ready, j.move], [to, false, null], 'the files have to move again, into the new store');
    assert.deepEqual(names(S, from), ['KnowBot/other-bot/faq.md', 'mine/plan.md'], 'the owner’s file and another bot’s file are untouched');
    assert.equal(S.kd.calls.slice(mark).filter((x) => x.method === 'DELETE').length, 2 + 1 /* the write check in the new store */);
    assert.deepEqual((await c.try(t, '/checkout', 'POST', {})).slice(0, 2), [409, 'kd_required'], 'not ready until the files are in the new store');
    await c.call(t, '/kd/move', 'POST', {});
    const s = await c.waitMove(t);
    assert.deepEqual([s.move.state, s.ready, s.store.id], ['done', true, to]);
    assert.equal(A.storeFiles(to).length, 2);
    assert.equal((await c.call(t, '/checkout', 'POST', {})).status, 200);
    A.setStore(from, { row: { owner: false, role: 'viewer' } }); A.setStore(to, { row: { owner: false, role: 'viewer' } });
  });

  test('signing in again with the same account keeps the choice; another account starts with no store', async () => {
    const t = await c.bot();
    await c.signIn(t, 'multi@example.com');
    assert.equal((await c.call(t, '/kd/store', 'POST', { storeId: st.empty })).status, 200);
    const chosenAt = (await c.json(t, '/kd')).store.chosenAt;
    await c.signIn(t, 'multi@example.com');
    let s = await c.json(t, '/kd');
    assert.deepEqual([s.store.id, s.store.chosenAt, s.storeRequired], [st.empty, chosenAt, false]);
    S.kd.auth.createAccount('second@example.com');
    await c.signIn(t, 'second@example.com');
    s = await c.json(t, '/kd');
    assert.deepEqual([s.email, s.store, s.storeRequired], ['second@example.com', null, true], "one account's store is never carried to another");
  });

  test('an account with no store yet: an empty list, nothing to choose', async () => {
    S.kd.auth.createAccount('nostore@example.com', { noStore: true });
    const t = await c.bot();
    await c.signIn(t, 'nostore@example.com');
    assert.deepEqual((await c.json(t, '/kd/stores')).stores, []);
    assert.deepEqual((await c.try(t, '/kd/move', 'POST', {})).slice(0, 2), [409, 'kd_store_required']);
    // not signed in at all: the store routes ask for the account first
    const t2 = await c.bot();
    assert.deepEqual((await c.try(t2, '/kd/stores')).slice(0, 2), [409, 'kd_required']);
    assert.deepEqual((await c.try(t2, '/kd/store', 'POST', { storeId: st.empty })).slice(0, 2), [409, 'kd_required']);
  });
});

describe('bots from before the store step', () => {
  let S, c;
  before(async () => { S = await boot(); c = client(S); await S.kb.registry.ready; });
  after(async () => { await S.close(); });
  /** A linked, moved, unlaunched bot as the old code left it: a store picked for the owner, no recorded choice. */
  async function legacy(email, { extraStore = false } = {}) {
    const acct = S.kd.auth.createAccount(email);
    const second = extraStore ? S.kd.auth.addStore(email, { name: 'The right store' }) : null;
    const t = await c.bot();
    await c.signIn(t, email);
    assert.equal((await c.call(t, '/kd/store', 'POST', { storeId: acct.store })).status, 200);
    await c.call(t, '/kd/move', 'POST', {});
    assert.equal((await c.waitMove(t)).ready, true);
    const T = S.kb.studio.trials.get(t.trialId);
    delete T.kdLink.storeChosenAt; delete T.kdLink.storeName; delete T.kdLink.storeOwnership;
    return { t, T, acct, second };
  }

  test('a linked, unlaunched bot whose store was picked automatically must choose before anything else is written', async () => {
    const { t, T, acct } = await legacy('legacy@example.com');
    let s = await c.json(t, '/kd');
    assert.deepEqual([s.status, s.store, s.storeRequired, s.ready], ['linked', null, true, false]);
    assert.equal(s.move.state, 'done', 'what was copied is still reported');
    const mark = S.kd.calls.length;
    assert.deepEqual((await c.try(t, '/kd/move', 'POST', {})).slice(0, 2), [409, 'kd_store_required']);
    assert.deepEqual((await c.try(t, '/checkout', 'POST', {})).slice(0, 2), [409, 'kd_store_required']);
    const cv = await convert(S, t, { account: acct.id, bucketId: 'legacy' });
    assert.deepEqual([cv.status, (await cv.json()).error.code], [409, 'kd_store_required'], 'no launch on a store nobody chose');
    // a move a restart interrupted does not go on by itself either
    T.kdMove.state = 'moving';
    await c.json(t, '/kd');
    await sleep(150);
    assert.deepEqual(writesTo(S, [acct.store], mark), [], 'nothing more is written');
    assert.equal(S.kd.calls.slice(mark).filter((x) => x.method === 'DELETE').length, 0);
    T.kdMove.state = 'done';
    assert.equal(S.kd.auth.storeFiles(acct.store).length, 2, 'the copies already made stay where they are');
    // signing in again does not turn the old pick into a choice
    await c.signIn(t, 'legacy@example.com');
    assert.equal((await c.json(t, '/kd')).storeRequired, true);
    // the owner confirms the same store: its two files are this bot's own, so the pick is enough, and nothing moves twice
    const row = (await c.json(t, '/kd/stores')).stores[0];
    assert.deepEqual([row.id, row.needs, row.files, row.botFiles, row.current], [acct.store, 'none', 2, 2, false]);
    const [status, , j] = await c.try(t, '/kd/store', 'POST', { storeId: acct.store });
    assert.equal(status, 200);
    assert.deepEqual([j.store.id, j.ready, j.removed], [acct.store, true, undefined]);
    assert.equal(S.kd.auth.storeFiles(acct.store).length, 2);
    assert.equal((await c.call(t, '/checkout', 'POST', {})).status, 200);
    assert.equal((await convert(S, t, { account: acct.id, bucketId: 'legacy' })).status, 200);
  });

  test('…and when they pick a different store, the copies in the automatic one are removed', async () => {
    const { t, acct, second } = await legacy('legacy2@example.com', { extraStore: true });
    S.kd.add({ store: acct.store, path: 'own/price-list.md', text: 'Prices', tags: [] });
    const [status, , j] = await c.try(t, '/kd/store', 'POST', { storeId: second });
    assert.equal(status, 200);
    assert.deepEqual([j.removed.files, j.removed.failed, j.store.id, j.ready], [2, 0, second, false]);
    assert.deepEqual(names(S, acct.store), ['own/price-list.md'], 'only this bot’s copies went');
    await c.call(t, '/kd/move', 'POST', {});
    assert.equal((await c.waitMove(t)).ready, true);
    assert.equal(S.kd.auth.storeFiles(second).length, 2);
  });

  test('a launched bot keeps its store, even one from before the store step, and it cannot be changed', async () => {
    const { t, T, acct, second } = await legacy('live@example.com', { extraStore: true });
    T.kdLink.storeChosenAt = new Date().toISOString();
    assert.equal((await convert(S, t, { account: acct.id, bucketId: 'livebot' })).status, 200);
    delete T.kdLink.storeChosenAt; // launched by the old code: no recorded choice
    const s = await c.json(t, '/kd');
    assert.deepEqual([s.live, s.store.id, s.storeRequired, s.ready], [true, acct.store, false, true]);
    assert.deepEqual((await c.try(t, '/kd/store', 'POST', { storeId: second })).slice(0, 2), [409, 'kd_live']);
    assert.deepEqual(await c.json(t, '/kd/stores').then((x) => [x.locked, x.stores.length]), [true, 0]);
    assert.equal(T.kdLink.store, acct.store);
    assert.equal(S.kd.auth.storeFiles(acct.store).length, 2);
    // it still answers from that store
    const r = await S.api(`/v1/bots/${t.trialId}/web`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ question: 'How many days do I have to return unworn shoes?' }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).refused, false);
  });
});

describe('kdaccount.mjs: the stores of an account', () => {
  test('discover lists and classifies, picks nothing; a list scoped to the account’s own stores exposes a lying flag', async () => {
    const kd = await startFakeKnowDrive({ speed: 50 });
    try {
      const A = kd.auth;
      const me = A.createAccount('scope@example.com');
      const theirs = A.addStore((A.createAccount('them@example.com'), 'them@example.com'), { name: 'Theirs' });
      A.shareStore(theirs, 'scope@example.com', { role: 'owner', row: { owner: true } });
      A.setStore(theirs, { vectorRow: { created_by: undefined } }); // nothing on the row gives it away…
      const logs = [];
      const K = createKdAccount({ env: { KNOWBOT_KD_AUTH_URL: kd.url }, secret: 's', log: (x) => logs.push(x) });
      const ru = 'http://api.test/api/studio/kd/callback';
      const u = new URL((await K.start({ trialId: 'tr_ffffffffffffffff', bearer: 'b', origin: null, redirectUri: ru })).url);
      const r = await fetch(`${kd.url}/-/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: u.searchParams.get('client_id'), redirect_uri: ru, state: u.searchParams.get('state'), code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256', email: 'scope@example.com', action: 'signin' }) });
      const back = new URL(r.headers.get('location'));
      const out = await K.finish({ state: back.searchParams.get('state'), code: back.searchParams.get('code') });
      assert.equal(out.link.store, null);
      K.prime('k', out.access);
      const link = { ...out.link };
      let d = await K.stores('k', link);
      assert.deepEqual(d.stores.map((x) => [x.id, x.ownership]).sort(), [[me.store, 'owned'], [theirs, 'owned']].sort(), 'with every signal agreeing, the flags are all there is to go on');
      A.vectorStoresScope = 'own'; // …but KnowDrive's own-store list does not carry it
      d = await K.stores('k', link);
      assert.deepEqual(d.stores.map((x) => [x.id, x.ownership]).sort(), [[me.store, 'owned'], [theirs, 'unconfirmed']].sort());
      assert.equal(K.client('k', link).store, null, 'a link without a choice points at no store');
      assert.equal(K.client('k', link).forStore(theirs).store, theirs);
      assert.doesNotMatch(logs.join('\n'), TOKEN_RE);
    } finally { await kd.close(); }
  });
});

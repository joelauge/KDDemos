// KnowDrive accounts at launch (server/kdaccount.mjs + the trials.mjs flow): sign-in (OAuth 2.0 + PKCE + DCR) against
// the fake authorization server, refresh tokens sealed at rest, the copy into the customer's owned store, checkout tied
// to the account, convert without a shared-store re-tag, and the launched bot answering from the customer's store on
// every surface. Fakes only: never touches knowDrive or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { createHmac, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { createKdAccount, pkcePair, KdError } from '../kdaccount.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 20;
const nextIp = () => `203.0.113.${ipSeq++ % 250}`;
const TOKEN_RE = /kd(?:at|rt|code)_[\w-]{10,}/;

async function boot({ env = {}, studio = {}, kdOpts = {} } = {}) {
  const kd = await startFakeKnowDrive({ speed: 6, narrowScope: 'all', ...kdOpts });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-kdacct-'));
  const logs = [];
  const fullEnv = {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_KD_AUTH_URL: kd.url, ...env,
  };
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: fullEnv,
    studio: { sweep: false, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400, kdPollMs: 30, logger: (x) => logs.push(String(x)), ...studio } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  return { kd, llm, kb, base, api, logs, async close() { kb.studio?.close?.(); await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}

function client(S) {
  const h = (t, extra = {}) => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': t.ip, ...extra });
  const c = {
    async trial() {
      const ip = nextIp();
      const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } });
      assert.equal(r.status, 201);
      return { ...(await r.json()), ip };
    },
    h,
    call: (t, p, method = 'GET', body) => S.api(`/api/studio/trials/${t.trialId}${p}`, { method, headers: h(t, body ? { 'content-type': 'application/json', origin: 'http://studio.test' } : { origin: 'http://studio.test' }), body: body ? JSON.stringify(body) : undefined }),
    json: async (t, p, method, body) => (await c.call(t, p, method, body)).json(),
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
    /** The popup, end to end: start → the KnowDrive page → create/sign in → the callback. → { status, html, url } */
    async signIn(t, { email, action = 'create', mode = 'signup', cancel = false } = {}) {
      const st = await c.call(t, '/kd/start', 'POST', { mode });
      assert.equal(st.status, 200);
      const { url } = await st.json();
      const page = await fetch(url);
      assert.equal(page.status, 200);
      const u = new URL(url);
      const form = new URLSearchParams({ client_id: u.searchParams.get('client_id'), redirect_uri: u.searchParams.get('redirect_uri'), state: u.searchParams.get('state'),
        code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256', screen_hint: u.searchParams.get('screen_hint') || '', email, action: cancel ? 'cancel' : action });
      const r = await fetch(`${S.kd.url}/-/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
      assert.equal(r.status, 302, await r.text());
      const cb = r.headers.get('location');
      const res = await fetch(cb, { redirect: 'manual' });
      return { status: res.status, html: await res.text(), url, callback: cb, csp: res.headers.get('content-security-policy') };
    },
    async waitMove(t, want = ['done', 'partial', 'error', 'paused'], ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const s = await c.json(t, '/kd');
        if (s.move && want.includes(s.move.state)) return s;
        await sleep(40);
      }
      throw new Error('move never finished');
    },
    /** One question on the public website chat (the launched bot's surface), → the source lines it quotes. */
    async web(botId, question) {
      const r = await S.api(`/v1/bots/${botId}/web`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ question }) });
      const j = await r.json();
      return { status: r.status, j, lines: (j.proof?.lines || []).map((l) => `${String(l.file).split('/').pop()}|${l.text}`).sort() };
    },
  };
  return c;
}
const convert = (S, t, body) => S.api(`/api/studio/trials/${t.trialId}/convert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body) });

const DOCS = {
  'returns.md': '# Returns\n\nUnworn shoes can be returned within 60 days of delivery for a full refund.\n\nSale items can be exchanged within 14 days.\n',
  'care.md': '# Shoe care\n\nLeather uppers should be cleaned with a damp cloth and conditioned every three months.\n\nNever put the shoes in a washing machine.\n',
  'shipping.md': '# Shipping\n\nOrders ship within 3 business days. Shipping to Canada costs a flat $18.\n',
};
const QUESTIONS = ['How many days do I have to return unworn shoes?', 'How often should leather uppers be conditioned?', 'How much is shipping to Canada?'];

// ------------------------------------------------------------------------------------------------- unit
describe('kdaccount.mjs: PKCE, state, sealing, refresh', () => {
  let kd;
  before(async () => { kd = await startFakeKnowDrive({ speed: 50, accessTtlSec: 120 }); });
  after(async () => { await kd.close(); });

  test('PKCE: a 43-character verifier and its S256 challenge', () => {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[\w-]{43}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    assert.notEqual(pkcePair().verifier, verifier);
  });

  test('state: sealed (no verifier in the URL), bound to the trial, tamper-proof, single use, expires', async () => {
    let clock = Date.now();
    const A = createKdAccount({ env: { KNOWBOT_KD_AUTH_URL: kd.url }, secret: 's1', now: () => clock });
    const { url } = await A.start({ trialId: 'tr_aaaaaaaaaaaaaaaa', bearer: 'b', origin: 'http://studio.test', redirectUri: 'http://api.test/api/studio/kd/callback' });
    const u = new URL(url);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('screen_hint'), 'signup');
    const state = u.searchParams.get('state');
    const d = A.peekState(state);
    assert.equal(d.t, 'tr_aaaaaaaaaaaaaaaa');
    assert.equal(createHash('sha256').update(d.v).digest('base64url'), u.searchParams.get('code_challenge'), 'the sealed verifier matches the challenge');
    assert.ok(!url.includes(d.v), 'the verifier never appears in the URL');
    // another server secret cannot open it; a flipped character is refused
    const B = createKdAccount({ env: { KNOWBOT_KD_AUTH_URL: kd.url }, secret: 's2', now: () => clock });
    assert.throws(() => B.peekState(state), (e) => e instanceof KdError && e.code === 'bad_state');
    const flipped = state.slice(0, -3) + (state.at(-3) === 'A' ? 'B' : 'A') + state.slice(-2);
    assert.throws(() => A.peekState(flipped), (e) => e.code === 'bad_state');
    // single use: the first finish consumes it even though the code is bad
    await assert.rejects(A.finish({ state, code: 'kdcode_bogus' }), (e) => e.code === 'reconnect' || e.code === 'upstream');
    await assert.rejects(A.finish({ state, code: 'kdcode_bogus' }), (e) => e.code === 'bad_state' && /already used/.test(e.message));
    // expiry
    const { url: url2 } = await A.start({ trialId: 'tr_aaaaaaaaaaaaaaaa', bearer: 'b', origin: null, redirectUri: 'http://api.test/api/studio/kd/callback', mode: 'signin' });
    assert.equal(new URL(url2).searchParams.get('screen_hint'), null, 'sign-in mode opens on the sign-in screen');
    clock += 16 * 60000;
    assert.throws(() => A.peekState(new URL(url2).searchParams.get('state')), (e) => e.code === 'bad_state' && /too long/.test(e.message));
  });

  test('DCR once per redirect URI (cached across instances through the data dir); the token exchange checks PKCE', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-kdc-'));
    const ru = 'http://api.test/api/studio/kd/callback';
    const before0 = kd.auth.registrations;
    const A = createKdAccount({ env: { KNOWBOT_KD_AUTH_URL: kd.url }, secret: 's', dataDir: dir });
    const c1 = await A.clientFor(ru);
    assert.equal((await A.clientFor(ru)).client_id, c1.client_id);
    const A2 = createKdAccount({ env: { KNOWBOT_KD_AUTH_URL: kd.url }, secret: 's', dataDir: dir });
    assert.equal((await A2.clientFor(ru)).client_id, c1.client_id, 'a restarted server reuses the registration');
    assert.equal(kd.auth.registrations, before0 + 1);
    // a code redeemed with the wrong verifier is refused by the authorization server
    const { url } = await A.start({ trialId: 'tr_bbbbbbbbbbbbbbbb', bearer: 'b', origin: null, redirectUri: ru });
    const u = new URL(url);
    const r = await fetch(`${kd.url}/-/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: u.searchParams.get('client_id'), redirect_uri: ru, state: 'x', code_challenge: pkcePair().challenge, code_challenge_method: 'S256', email: 'pkce@example.com', action: 'create' }) });
    const code = new URL(r.headers.get('location')).searchParams.get('code');
    await assert.rejects(A.finish({ state: u.searchParams.get('state'), code }), (e) => e.code === 'reconnect' || e.code === 'upstream');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('finish → sealed refresh token, owned store found; refresh is single flight, rotation is persisted; revoked → reconnect; logs carry no token', async () => {
    const logs = [];
    let clock = Date.now();
    const A = createKdAccount({ env: { KNOWBOT_KD_AUTH_URL: kd.url }, secret: 'seal-secret', log: (x) => logs.push(x), now: () => clock });
    const ru = 'http://api.test/api/studio/kd/callback';
    const { url } = await A.start({ trialId: 'tr_cccccccccccccccc', bearer: 'b', origin: null, redirectUri: ru });
    const u = new URL(url);
    const r = await fetch(`${kd.url}/-/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: u.searchParams.get('client_id'), redirect_uri: ru, state: u.searchParams.get('state'), code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256', email: 'unit@example.com', action: 'create' }) });
    const back = new URL(r.headers.get('location'));
    const out = await A.finish({ state: back.searchParams.get('state'), code: back.searchParams.get('code') });
    const acct = kd.auth.accounts.get('unit@example.com');
    assert.deepEqual([out.link.account, out.link.email, out.link.store], [acct.id, 'unit@example.com', acct.store]);
    assert.match(out.link.sealed, /^v1\./);
    assert.doesNotMatch(JSON.stringify(out.link), TOKEN_RE, 'the link holds no token in the clear');
    // refresh: the cache answers first; past expiry ONE refresh serves concurrent callers, and the rotation is saved
    const link = { ...out.link };
    A.prime('k1', out.access);
    assert.equal(await A.accessFor('k1', link), out.access.token);
    const rotated = [];
    clock += 10 * 60000;
    const refreshes0 = kd.auth.tokenCalls.filter((x) => x.grant_type === 'refresh_token').length;
    const [a1, a2, a3] = await Promise.all([1, 2, 3].map(() => A.accessFor('k1', link, { onRotate: (s) => rotated.push(s) })));
    assert.ok(a1 === a2 && a2 === a3 && a1 !== out.access.token);
    assert.equal(kd.auth.tokenCalls.filter((x) => x.grant_type === 'refresh_token').length, refreshes0 + 1, 'single flight');
    assert.equal(rotated.length, 1, 'the rotated refresh token is handed back sealed');
    assert.equal(link.sealed, rotated[0]);
    // a client call refreshes on a 401 and retries once
    kd.auth.expireAccess();
    const cli = A.client('k1', link, {});
    const res = await cli.fetch(`/api/v1/vector_stores/${acct.store}/files`);
    assert.equal(res.status, 200);
    // the user revokes KnowBot in KnowDrive: the next refresh is refused → reconnect, and the hook fires
    kd.auth.revokeAccount('unit@example.com');
    kd.auth.expireAccess();
    let hooked = null;
    const cli2 = A.client('k1', link, { onReconnect: (e) => { hooked = e; } });
    await assert.rejects(cli2.fetch(`/api/v1/vector_stores/${acct.store}/files`), (e) => e instanceof KdError && e.code === 'reconnect');
    assert.ok(hooked && hooked.code === 'reconnect');
    kd.auth.restoreAccount('unit@example.com');
    assert.doesNotMatch(logs.join('\n'), TOKEN_RE, 'no token is ever logged');
  });

  test('the fake authorization server isolates accounts: KnowBot’s own key never reaches an owned store', async () => {
    const a = kd.auth.createAccount('iso@example.com');
    const r = await fetch(`${kd.url}/api/v1/vector_stores/${a.store}/files`, { headers: { authorization: 'Bearer fake-key' } });
    assert.equal(r.status, 403);
  });
});

// ------------------------------------------------------------------------------------------------- the flow over HTTP
describe('launch with a KnowDrive account (HTTP flow)', () => {
  let S, c;
  before(async () => { S = await boot(); c = client(S); await S.kb.registry.ready; });
  after(async () => { await S.close(); });

  test('sign up → files move → checkout tied to the account → convert → the launched bot answers from the customer store, everywhere', async () => {
    const t = await c.trial();
    await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' });
    for (const [n, text] of Object.entries(DOCS)) assert.equal((await c.upload(t, n, text)).status, 201);
    const files = await c.waitReady(t, 3 + 4);
    const own = files.filter((f) => !f.sample);
    assert.equal(own.length, 3);

    const cfg = await (await S.api('/api/studio/config')).json();
    assert.deepEqual(cfg.kd, { available: true, required: true });
    let st = await c.json(t, '/kd');
    assert.equal(st.status, 'none');
    assert.equal(st.movable, 3, 'samples are never counted');
    // checkout needs the account first
    let co = await c.call(t, '/checkout', 'POST', { email: 'owner@example.com' });
    assert.equal(co.status, 409);
    assert.equal((await co.json()).error.code, 'kd_required');
    assert.equal((await c.call(t, '/kd/move', 'POST', {})).status, 409, 'nothing moves before sign-in');

    // the popup: create the account; the callback page never shows a token and only talks to the Studio origin
    const s1 = await c.signIn(t, { email: 'owner@example.com' });
    assert.equal(s1.status, 200, s1.html);
    assert.match(s1.html, /signed in to KnowDrive/);
    assert.match(s1.html, /postMessage\(\{"type":"knowbot:kd","ok":true\},o\)/);
    assert.match(s1.html, /"http:\/\/studio\.test"/);
    assert.doesNotMatch(s1.html, TOKEN_RE);
    assert.match(s1.csp, /default-src 'none'/);
    assert.equal(new URL(s1.callback).pathname, '/api/studio/kd/callback', 'the redirect URI is on the API host');
    // a replayed callback (same state) is refused
    const replay = await fetch(s1.callback);
    assert.equal(replay.status, 400);
    const acct = S.kd.auth.accounts.get('owner@example.com');
    st = await c.json(t, '/kd');
    assert.deepEqual([st.status, st.email, st.account, st.ready], ['linked', 'owner@example.com', acct.id, false]);
    assert.doesNotMatch(JSON.stringify(st), TOKEN_RE);
    assert.ok(!('sealed' in st), 'the sealed token never leaves the server');
    // sealed at rest: the trial's state doc in KnowBot's store
    const doc = JSON.parse([...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_spec.json`).raw);
    assert.match(doc.kd.sealed, /^v1\./);
    assert.doesNotMatch(JSON.stringify(doc), TOKEN_RE, 'no token in the clear at rest');
    co = await c.call(t, '/checkout', 'POST', {});
    assert.equal((await co.json()).error.code, 'kd_required', 'linked but not moved: still no checkout');

    // the move: progress on the events stream, every own file (original bytes, tags minus trial/expiry) in the customer store
    const mv = await c.call(t, '/kd/move', 'POST', {});
    assert.equal(mv.status, 202);
    st = await c.waitMove(t);
    assert.equal(st.move.state, 'done', JSON.stringify(st.move));
    assert.deepEqual([st.move.total, st.move.ready, st.ready], [3, 3, true]);
    const copies = S.kd.auth.storeFiles(acct.store);
    assert.equal(copies.length, 3);
    for (const f of own) {
      const cp = copies.find((x) => x.tags.includes(`kbsrc:${f.id}`));
      assert.ok(cp, `copy of ${f.name}`);
      assert.equal(String(cp.blob), DOCS[f.name], 'original bytes');
      assert.ok(cp.filename.endsWith(`/${f.name}`) && cp.filename.startsWith('KnowBot/'), cp.filename);
      assert.ok(cp.tags.includes(`knowbot:${t.trialId}`) && cp.tags.some((x) => x.startsWith('tfile:')));
      assert.ok(!cp.tags.some((x) => x.startsWith('trial:') || x.startsWith('expires:') || x === 'kind:trial'), cp.tags.join(','));
    }
    assert.ok(!copies.some((x) => x.tags.some((y) => y.startsWith('sample'))), 'samples are never copied');
    // KnowBot wrote them with the customer's token, never its own key
    const writes = S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.store === acct.store);
    assert.ok(writes.length === 3 && writes.every((x) => /^Bearer kdat_/.test(x.auth)));
    // idempotent: moving again copies nothing
    assert.equal((await c.call(t, '/kd/move', 'POST', {})).status, 202);
    st = await c.waitMove(t);
    assert.equal(S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.store === acct.store).length, 3, 'no second copy');
    assert.equal(st.move.state, 'done');

    // checkout carries the account, signed with the other params
    co = await c.call(t, '/checkout', 'POST', {});
    assert.equal(co.status, 200);
    const cu = new URL((await co.json()).url);
    assert.equal(cu.searchParams.get('kd_account'), acct.id);
    assert.equal(cu.searchParams.get('email'), 'owner@example.com', 'the KnowDrive email fills in');
    const want = createHmac('sha256', 'knowbot-checkout\ndev-secret').update([t.trialId, cu.searchParams.get('surfaces'), cu.searchParams.get('interval'), cu.searchParams.get('price'), cu.searchParams.get('total'), acct.id].join('|')).digest('base64url');
    assert.equal(cu.searchParams.get('sig'), want);

    // answers before launch (KnowBot's shared copies) …
    const before0 = [];
    for (const q of QUESTIONS) { const a = await c.web(t.trialId, q); assert.equal(a.status, 200); assert.ok(a.lines.length, `${q}: ${JSON.stringify(a.j).slice(0, 300)}`); before0.push(a.lines); }

    // convert: the account must match; no re-tag in the shared store; the shared copies go
    assert.equal((await convert(S, t, { account: 'someone-else', bucketId: 'acme' })).status, 409);
    const tagCalls = S.kd.calls.filter((x) => x.url === '/api/v1/files/batch_tags').length;
    const cv = await convert(S, t, { account: acct.id, bucketId: 'acme' });
    assert.equal(cv.status, 200);
    const cvj = await cv.json();
    assert.deepEqual([cvj.converted, cvj.files, cvj.kd.account, cvj.kd.store], [true, 3, acct.id, acct.store]);
    assert.equal(S.kd.calls.filter((x) => x.url === '/api/v1/files/batch_tags').length, tagCalls, 'no shared-store re-tag');
    const left = [...S.kd.files.values()].filter((f) => f.store === 'vs_fake_trials' && f.tags.includes(`trial:${t.trialId}`) && !f.tags.includes('kind:trial-spec'));
    assert.deepEqual(left.map((f) => f.filename), [], 'the customer store is the only home');
    st = await c.json(t, '');
    assert.equal(st.converted, true);
    assert.equal(st.kd.live, true);
    assert.deepEqual(st.files.map((f) => f.name).sort(), Object.keys(DOCS).sort(), 'the Studio lists the copies');
    assert.ok(st.files.every((f) => copies.some((x) => x.id === f.id)));

    // … and after: the same questions, the same cited lines, now from the customer's store (parity)
    const searches0 = S.kd.calls.filter((x) => x.url === `/api/v1/vector_stores/${acct.store}/search`).length;
    for (const [i, q] of QUESTIONS.entries()) {
      const a = await c.web(t.trialId, q);
      assert.equal(a.status, 200);
      assert.deepEqual(a.lines, before0[i], `${q}: same cited lines`);
    }
    assert.ok(S.kd.calls.filter((x) => x.url === `/api/v1/vector_stores/${acct.store}/search`).length > searches0, 'searched in the customer store');
    // the registry's launched bot (POST /api/instances linking the bucket) answers from the same store
    const inst = await (await S.api('/api/instances', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin' }, body: JSON.stringify({ name: 'Acme Shoes', buckets: [{ id: 'acme' }] }) })).json();
    assert.ok(inst.id, JSON.stringify(inst) + S.logs.filter((l) => /registry|kd\]/.test(l)).join('\n'));
    for (const q of QUESTIONS.slice(0, 2)) {
      const a = await c.web(inst.id, q);
      assert.equal(a.status, 200);
      assert.equal(a.j.refused, false, `${q}: ${JSON.stringify(a.j).slice(0, 300)}`);
      assert.ok(a.lines.every((l) => Object.keys(DOCS).includes(l.split('|')[0])), a.lines.join(' / '));
    }
    assert.equal((await S.api('/api/buckets/acme/files', { headers: { authorization: 'Bearer dev-admin' } })).status, 409, "an owned bucket's files are managed in KnowDrive");

    // the customer revokes KnowBot: visitors get the normal refusal-safe answer, the owner sees "Reconnect KnowDrive"
    S.kd.auth.revokeAccount('owner@example.com');
    S.kd.auth.expireAccess();
    const r1 = await c.web(t.trialId, QUESTIONS[0]);
    assert.ok(r1.status === 502 || r1.j.refused === true, JSON.stringify(r1.j));
    if (r1.status === 502) assert.match(r1.j.error.message, /ref [0-9a-f]{8}/);
    st = await c.json(t, '/kd');
    assert.equal(st.status, 'reconnect');
    assert.match(st.ref, /^[0-9a-f]{8}$/);
    const g = await c.call(t, '');
    assert.equal(g.status, 200, 'the owner can still open the bot to reconnect');
    assert.equal((await g.json()).kd.status, 'reconnect');
    assert.equal(S.logs.filter((l) => /\[kd\] reconnect needed/.test(l)).length, 1, 'one log line');
    assert.ok(S.logs.some((l) => l.includes(`ref=${st.ref}`)));
    const r2 = await c.web(inst.id, QUESTIONS[0]);
    assert.equal(r2.status, 200);
    assert.equal(r2.j.refused, true, 'the registry bot refuses instead of answering from elsewhere');
    assert.equal((await c.call(t, '/kd', 'DELETE')).status, 409, 'a live bot reconnects, never signs out');
    // another account cannot take over a live bot
    const other = await c.signIn(t, { email: 'intruder@example.com' });
    assert.equal(other.status, 400);
    assert.match(other.html, /another KnowDrive account/);
    // reconnect: sign in to the same account again
    S.kd.auth.restoreAccount('owner@example.com');
    const s2 = await c.signIn(t, { email: 'owner@example.com', action: 'signin', mode: 'signin' });
    assert.equal(s2.status, 200);
    st = await c.json(t, '/kd');
    assert.deepEqual([st.status, st.live], ['linked', true]);
    const back = await c.web(t.trialId, QUESTIONS[0]);
    assert.deepEqual(back.lines, before0[0], 'answers again after reconnecting');
    assert.doesNotMatch(S.logs.join('\n'), TOKEN_RE, 'no token is ever logged');
  });

  test('an existing account signs in instead; cancel; sign out before launch; a failed copy is retried (resume)', async () => {
    S.kd.auth.createAccount('existing@example.com');
    const t = await c.trial();
    for (const [n, text] of Object.entries(DOCS)) await c.upload(t, n, text);
    await c.waitReady(t, 3);
    // cancel in the popup: an error page with a ref, nothing linked
    const x = await c.signIn(t, { email: 'existing@example.com', cancel: true });
    assert.equal(x.status, 400);
    assert.match(x.html, /cancelled/);
    assert.match(x.html, /"ok":false/);
    assert.equal((await c.json(t, '/kd')).status, 'none');
    // "Create account" with an email that already has one is answered on the KnowDrive page itself (no duplicate)
    const st0 = await (await c.call(t, '/kd/start', 'POST', { mode: 'signup' })).json();
    const u = new URL(st0.url);
    const dup = await fetch(`${S.kd.url}/-/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: u.searchParams.get('client_id'), redirect_uri: u.searchParams.get('redirect_uri'), state: u.searchParams.get('state'), code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256', email: 'existing@example.com', action: 'create' }) });
    assert.equal(dup.status, 200);
    assert.match(await dup.text(), /already has an account/);
    const s = await c.signIn(t, { email: 'existing@example.com', action: 'signin', mode: 'signin' });
    assert.equal(s.status, 200);
    const acct = S.kd.auth.accounts.get('existing@example.com');
    assert.equal(S.kd.auth.accounts.size >= 2, true);
    // one copy fails: the move ends partial with a per-file error; a retry copies only what's missing
    S.kd.failNext.ingestStore = { store: acct.store, n: 1 };
    await c.call(t, '/kd/move', 'POST', {});
    let st = await c.waitMove(t);
    assert.equal(st.move.state, 'partial');
    assert.equal(st.move.failed.length, 1);
    assert.ok(st.move.failed[0].name && st.move.failed[0].error);
    assert.equal(st.ready, false);
    assert.equal((await c.call(t, '/checkout', 'POST', {})).status, 409, 'no checkout with a file missing');
    await c.call(t, '/kd/move', 'POST', {});
    st = await c.waitMove(t);
    assert.equal(st.move.state, 'done');
    assert.equal(S.kd.auth.storeFiles(acct.store).length, 3, 'exactly one copy per file');
    // sign out before launch: the sign-in is revoked; the copies stay the customer's
    const rev0 = S.kd.auth.revocations;
    const out = await c.call(t, '/kd', 'DELETE');
    assert.equal(out.status, 200);
    assert.equal((await out.json()).status, 'none');
    assert.equal(S.kd.auth.revocations, rev0 + 1);
    assert.equal((await c.call(t, '/checkout', 'POST', {})).status, 409);
  });
});

describe('KnowDrive accounts off (KNOWBOT_KD_ACCOUNTS=off, KNOWBOT_MODE=owner)', () => {
  for (const env of [{ KNOWBOT_KD_ACCOUNTS: 'off' }, { KNOWBOT_MODE: 'owner' }]) {
    test(`${Object.entries(env)[0].join('=')}: checkout works without an account and keeps the old signature`, async () => {
      const S = await boot({ env });
      try {
        const c = client(S);
        const t = await c.trial();
        const cfg = await (await S.api('/api/studio/config')).json();
        assert.equal(cfg.kd.required, false);
        const r = await c.call(t, '/checkout', 'POST', { email: 'a@example.com' });
        assert.equal(r.status, 200);
        const u = new URL((await r.json()).url);
        assert.equal(u.searchParams.get('kd_account'), null);
        const want = createHmac('sha256', 'knowbot-checkout\ndev-secret').update([t.trialId, u.searchParams.get('surfaces'), u.searchParams.get('interval'), u.searchParams.get('price'), u.searchParams.get('total')].join('|')).digest('base64url');
        assert.equal(u.searchParams.get('sig'), want);
      } finally { await S.close(); }
    });
  }
});

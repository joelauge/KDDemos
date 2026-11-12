// Admin sign-in through host-manager (KNOWBOT_AUTH_*, server/hmauth.mjs): a fake host-manager JWKS + FAT minter, fake
// knowDrive and fake LLM. Switch off = today's behaviour; switch on = FAT gates, forgery check, allow-list + CSP through
// host-manager, JWKS life cycle, coexistence with the admin token and kb_live_ keys, configuration, no leaks.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { createHmAuth, grants } from '../hmauth.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { startFakeHm } from './fake-hm.mjs';

delete process.env.KNOWDRIVE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const AUD = 'http://127.0.0.1:8787';
const DOC = '# Returns\n\nYou can return any unused item within 30 days of delivery for a full refund.\n';
const now = () => Math.floor(Date.now() / 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// every server log line, for the no-leak assertions (T7); nothing is printed
const LOG = [];
const realLog = console.log;
console.log = (...a) => { LOG.push(a.map(String).join(' ')); };
after(() => { console.log = realLog; });

const authEnv = (hm) => ({ KNOWBOT_AUTH_ISSUER: hm.issuer, KNOWBOT_AUTH_AUDIENCE: AUD, KNOWBOT_AUTH_JWKS_URL: hm.jwksUrl });

async function boot({ hm, on = true, env = {}, kd, hmAuth } = {}) {
  const ownKd = !kd;
  kd = kd || await startFakeKnowDrive({ speed: 20 });
  const llm = await startFakeLLM();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-hmauth-'));
  const kb = createKnowBotServer({ root: ROOT, dataDir, watch: false, ...(hmAuth ? { hmAuth } : {}), env: {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', ...(on ? authEnv(hm) : {}), ...env,
  }, studio: { sweep: false, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400 } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  await kb.registry.ready;
  return {
    kd, kb, base,
    api: (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init }),
    async close() { await new Promise((r) => kb.server.close(() => r())); if (ownKd) await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); },
  };
}
/** A request as host-manager forwards it from the signed-in owner's dashboard. */
const viaHm = (hm, fat, extra = {}) => ({ authorization: `Bearer ${fat}`, 'x-kdex-forwarded': 'true', origin: hm.issuer, 'content-type': 'application/json', ...extra });
const fatFor = (hm, claims, o = {}) => hm.mint(claims, { aud: [AUD], ...o });

// ------------------------------------------------------------------------------------------------ unit
test('grant matcher: the kdex Dominates subset for knowbot:*:<verb>', () => {
  for (const e of ['knowbot:*:admin', 'knowbot::admin', 'knowbot:admin', 'knowbot:*:all', 'knowbot::all', 'knowbot:all']) assert.ok(grants([e], 'admin'), e);
  for (const e of ['knowbot:bot1:admin', 'knowbot:*:admin:ctx', 'vector_stores:*:all', 'knowbot:*:read', 'KNOWBOT:*:admin', '*:*:admin']) assert.ok(!grants([e], 'admin'), e);
});

// ------------------------------------------------------------------------------------------------ T6 configuration
describe('T6 configuration', () => {
  // port 9 (discard): nothing here ever reaches a real host-manager
  const full = { KNOWBOT_AUTH_ISSUER: 'http://127.0.0.1:9', KNOWBOT_AUTH_AUDIENCE: AUD, KNOWBOT_AUTH_JWKS_URL: 'http://127.0.0.1:9/.well-known/jwks.json' };
  test('none set: off (null); each partial combination refuses to start', () => {
    assert.equal(createHmAuth({ env: {} }), null);
    const names = Object.keys(full);
    for (let mask = 1; mask < 7; mask++) {
      const env = Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map((n) => [n, full[n]]));
      assert.throws(() => createKnowBotServer({ root: ROOT, quiet: true, watch: false, env: { ...env, KNOWBOT_SECRET_KEY: 's' } }), /must be set together/, JSON.stringify(env));
    }
  });
  test('JWKS URL: https, or http to a loopback hostname only', () => {
    for (const u of ['http://10.0.0.5/.well-known/jwks.json', 'http://127.0.0.1.evil/jwks.json', 'http://user@127.0.0.1/jwks.json', 'ftp://127.0.0.1/jwks.json', 'not a url']) {
      assert.throws(() => createHmAuth({ env: { ...full, KNOWBOT_AUTH_JWKS_URL: u } }), /JWKS_URL|absolute/, u);
    }
    for (const u of ['http://127.0.0.1:9/.well-known/jwks.json', 'http://localhost:9/jwks.json', 'http://[::1]:9/jwks.json', 'https://box.example:8443/.well-known/jwks.json']) {
      assert.ok(createHmAuth({ env: { ...full, KNOWBOT_AUTH_JWKS_URL: u } }), u);
    }
  });
  test('switch on with neither KNOWBOT_SECRET_KEY nor an admin token refuses to start; either one is enough', () => {
    assert.throws(() => createKnowBotServer({ root: ROOT, quiet: true, watch: false, env: full }), /KNOWBOT_SECRET_KEY/);
    for (const extra of [{ KNOWBOT_SECRET_KEY: 's' }, { KNOWBOT_ADMIN_TOKEN: 't' }]) {
      const kb = createKnowBotServer({ root: ROOT, quiet: true, watch: false, env: { ...full, ...extra } });
      kb.server.emit('close');
    }
  });
});

// ------------------------------------------------------------------------------------------------ T1 switch off
describe('T1 switch off (cloud parity)', () => {
  let hm, A, B;
  before(async () => {
    hm = await startFakeHm();
    A = await boot({ hm, on: false, env: { KNOWBOT_ADMIN_TOKEN: 'dev-admin' } });
    B = await boot({ hm, on: false });
  });
  after(async () => { await A.close(); await B.close(); await hm.close(); });

  test('a valid FAT is not an admin credential, the admin token is', async () => {
    const r = await A.api('/api/buckets', { method: 'POST', headers: viaHm(hm, fatFor(hm)), body: JSON.stringify({ name: 'Acme' }) });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), null);
    assert.equal((await A.api('/api/buckets', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
  });
  test('no admin token: loopback without X-Forwarded-For may write, with it may not; reader routes stay open', async () => {
    assert.equal((await B.api('/api/buckets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Loop' }) })).status, 201);
    assert.equal((await B.api('/api/buckets', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ name: 'Far' }) })).status, 403);
    assert.equal((await B.api('/api/sessions')).status, 200);
  });
  test('no JWKS fetch, no CSP, no allow-list even with X-Kdex-Forwarded', async () => {
    const d = await A.api('/dashboard/', { headers: { 'x-kdex-forwarded': 'true' } });
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('content-security-policy'), null);
    assert.equal((await A.api('/studio/', { headers: { 'x-kdex-forwarded': 'true' } })).status, 200);
    assert.equal(hm.fetches, 0);
  });
});

// ------------------------------------------------------------------------------------------------ T2-T5, T7 switch on
describe('switch on', () => {
  let hm, S;
  const H = (fat, extra) => viaHm(hm, fat, extra);
  before(async () => {
    hm = await startFakeHm();
    S = await boot({ hm, env: { KNOWBOT_ADMIN_TOKEN: 'dev-admin' } });
    for (let i = 0; i < 100 && !hm.fetches; i++) await wait(20);
    await wait(50);
  });
  after(async () => { await S.close(); await hm.close(); });
  const fat = (claims, o) => fatFor(hm, claims, o);
  const postBucket = (name, headers) => S.api('/api/buckets', { method: 'POST', headers, body: JSON.stringify({ name }) });
  const hasBucket = (id) => S.kb.registry.bucketList().some((b) => b.id === id);

  // -------------------------------------------------------------------------------------------- T2 accept
  test('T2 an admin FAT works on server, devapi (bot keys) and Studio (convert) admin routes', async () => {
    const a = fat();
    assert.equal((await postBucket('Acme', H(a))).status, 201);
    assert.equal((await S.api('/api/buckets/acme', { method: 'PATCH', headers: H(a), body: JSON.stringify({ name: 'Acme Co' }) })).status, 200);
    const up = await S.api('/api/buckets/acme/files', { method: 'POST', headers: H(a, { 'content-type': 'text/markdown', 'x-filename': 'returns.md' }), body: DOC });
    assert.equal(up.status, 201);
    assert.equal((await S.api('/api/instances', { method: 'POST', headers: H(a), body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
    assert.equal((await S.api('/api/providers', { headers: H(a) })).status, 200);
    assert.equal((await S.api('/api/instances/front-desk/keys', { headers: H(a) })).status, 200);
    const t = await (await S.api('/api/studio/trials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const conv = await S.api(`/api/studio/trials/${t.trialId}/convert`, { method: 'POST', headers: H(a), body: JSON.stringify({ account: 'acct1', bucketId: 'lumen' }) });
    assert.equal(conv.status, 200, await conv.clone().text());
  });
  test('owner mode with the switch on: Studio is not routed through host-manager, so bot creation keeps its own rule', async () => {
    const O = await boot({ hm, env: { KNOWBOT_MODE: 'owner' } }); // no admin token: a direct loopback request is the owner
    try {
      const create = (headers) => O.api('/api/studio/trials', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
      assert.equal((await create({})).status, 201, 'direct loopback, as on the box');
      assert.equal((await create({ 'x-forwarded-for': '203.0.113.9' })).status, 403, 'through a proxy');
      assert.equal((await create(H(fat()))).status, 404, 'a host-manager token is not a Studio credential: the route is not offered through host-manager');
    } finally { await O.close(); }
  });

  test('T2 a reader FAT works on the reader routes; an admin FAT passes them too', async () => {
    for (const f of [fat({ entitlements: ['knowbot:*:read'] }), fat()]) {
      assert.equal((await S.api('/api/sessions', { headers: H(f) })).status, 200);
      assert.equal((await S.api('/api/events', { headers: H(f) })).status, 200);
      assert.equal((await S.api('/api/reindex', { method: 'POST', headers: H(f) })).status, 200);
      const st = await S.api('/api/stream', { headers: H(f) });
      assert.equal(st.status, 200);
      await st.body.cancel();
    }
  });
  test('T2 short and empty-name forms and the verb all are accepted', async () => {
    for (const e of ['knowbot:admin', 'knowbot::all', 'knowbot:*:all']) {
      assert.equal((await S.api('/api/providers', { headers: H(fat({ entitlements: [e] })) })).status, 200, e);
    }
  });
  test('T2 a stream opened with a FAT closes when the FAT expires (+30 s leeway)', async () => {
    const exp = now() - 28; // valid for ~2 s more
    const st = await S.api('/api/stream', { headers: H(fat({ entitlements: ['knowbot:*:read'], exp, iat: exp - 300 })) });
    assert.equal(st.status, 200);
    const t0 = Date.now();
    const reader = st.body.getReader();
    while (!(await reader.read()).done) { if (Date.now() - t0 > 8000) break; }
    assert.ok(Date.now() - t0 < 8000, 'the stream ended');
  });

  // -------------------------------------------------------------------------------------------- T3 refuse
  test('T3 valid sign-in without the grant → 403, nothing written', async () => {
    const cases = [{ entitlements: ['knowbot:*:read'] }, { entitlements: ['knowbot:bot1:admin'] }, { entitlements: ['knowbot:*:admin:ctx'] },
      { entitlements: ['vector_stores:*:all'] }, { entitlements: undefined }, { entitlements: ['knowbot:*:admin', 7] }, { entitlements: 'knowbot:*:admin' },
      { auth_method: 'oauth2' }, { auth_method: undefined }];
    for (const [i, c] of cases.entries()) {
      const r = await postBucket(`Nope ${i}`, H(fat(c)));
      assert.equal(r.status, 403, JSON.stringify(c));
      assert.ok(!hasBucket(`nope-${i}`));
    }
  });
  test('T3 bad tokens → 401 with WWW-Authenticate, nothing written', async () => {
    const t = now();
    const tampered = (() => { const [h, p, s] = fat().split('.'); const pl = JSON.parse(Buffer.from(p, 'base64url')); pl.sub = 'mallory'; return `${h}.${Buffer.from(JSON.stringify(pl)).toString('base64url')}.${s}`; })();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    hm.extraKeys = [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa1', alg: 'RS256' }];
    await S.kb.registry.ready;
    const cases = {
      iss: fat({ iss: 'http://127.0.0.1:9999' }),
      knowdbAud: hm.mint({}, { aud: ['http://127.0.0.1:3000'] }),
      expired31: fat({ exp: t - 31, iat: t - 331 }),
      nbf: fat({ nbf: t + 60 }),
      noExp: fat({ exp: undefined }),
      noIat: fat({ iat: undefined }),
      lifetime: fat({ iat: t, exp: t + 3600 }),
      act: fat({ act: { sub: 'http://127.0.0.1:3000' } }),
      emptySub: fat({ sub: '' }),
      none: fat({}, { raw: (input) => `${input}.` , header: { alg: 'none' } }),
      hs256: hm.hs256({}, [AUD]),
      ps256: fat({}, { header: { alg: 'PS256' } }),
      rs256: fat({}, { header: { alg: 'RS256', kid: 'rsa1' } }),
      crit: fat({}, { header: { crit: ['exp'] } }),
      protoKid: fat({}, { header: { kid: '__proto__' } }),
      tampered,
      tooLong: `${fat()}${'A'.repeat(9000)}`,
    };
    for (const [name, tok] of Object.entries(cases)) {
      const r = await postBucket(`Bad ${name}`, H(tok));
      assert.equal(r.status, 401, name);
      assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="knowbot"', name);
    }
    assert.ok(!S.kb.registry.bucketList().some((b) => b.id.startsWith('bad-')));
    hm.extraKeys = [];
    const ok = fat({ exp: t - 29, iat: t - 329 });
    assert.equal((await S.api('/api/providers', { headers: H(ok) })).status, 200, '29 s past exp is inside the leeway');
  });
  test('T3 the loopback bypass is off; a FAT is never read from the query string', async () => {
    assert.equal((await postBucket('Loop', { 'content-type': 'application/json' })).status, 401);
    assert.equal((await S.api(`/api/sessions?token=${fat()}`)).status, 401);
    assert.equal((await S.api('/api/sessions')).status, 401, 'reader routes are no longer open');
  });
  test('T3 forged cross-origin writes are refused and write nothing', async () => {
    const a = fat();
    const forged = {
      evilOrigin: H(a, { origin: 'http://127.0.0.1:8787' }),
      nullOrigin: H(a, { origin: 'null' }),
      sameSite: H(a, { 'sec-fetch-site': 'same-site' }),
      crossReferer: { ...H(a, { referer: 'http://127.0.0.1:8095/page' }), origin: undefined },
    };
    for (const [name, h] of Object.entries(forged)) {
      const headers = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
      assert.equal((await postBucket(`Forged ${name}`, headers)).status, 403, name);
    }
    assert.equal((await postBucket('Plain', H(a, { 'content-type': 'text/plain' }))).status, 415, 'a text/plain body needs no preflight');
    assert.ok(!S.kb.registry.bucketList().some((b) => /^(forged|plain)/.test(b.id)));
    // no Origin, no Referer (not a browser): admitted
    assert.equal((await postBucket('Script', { authorization: `Bearer ${a}`, 'content-type': 'application/json' })).status, 201);
    // uploads: named in X-Filename only, never ?name=
    const before = [...S.kd.files.values()].length;
    assert.equal((await S.api('/api/buckets/acme/files?name=x.md', { method: 'POST', headers: H(a, { 'content-type': 'text/markdown' }), body: '# x' })).status, 400);
    assert.equal([...S.kd.files.values()].length, before);
  });
  // ingests of one bucket file (Studio and registry writes ingest in the background too)
  const ingests = (name) => S.kd.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/ingest' && String(c.ingestPath || '').endsWith(`acme/${name}`)).length;
  test('T3 an upload retried through host-manager is not ingested twice (409)', async () => {
    const a = fat();
    const up = () => S.api('/api/buckets/acme/files', { method: 'POST', headers: H(a, { 'content-type': 'text/markdown', 'x-filename': 'faq.md' }), body: '# faq' });
    const n0 = ingests('faq.md');
    const first = await up();
    assert.equal(first.status, 201);
    const { id } = await first.json();
    assert.equal((await up()).status, 409);
    // the fake replaces a same-path ingest, so count the ingests and keep the first file's id: a second ingest would change both
    assert.equal(ingests('faq.md') - n0, 1, 'one ingest');
    assert.equal([...S.kd.files.values()].filter((f) => /(^|\/)acme\/faq\.md$/.test(f.filename)).map((f) => f.id).join(), id, 'the first upload is the one in the bucket (trial samples have their own faq.md)');
    // the admin token on KnowBot's own port keeps today's behaviour (no existence check)
    assert.equal((await S.api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'faq.md' }, body: '# faq' })).status, 201);
  });

  test('T3 a retry sent while the first upload is still being ingested is 409 too', async () => {
    const a = fat();
    const up = () => S.api('/api/buckets/acme/files', { method: 'POST', headers: H(a, { 'content-type': 'text/markdown', 'x-filename': 'slow.md' }), body: '# slow' });
    S.kd.slow.ingest = 1500;
    try {
      const first = up();
      for (let i = 0; i < 300 && !ingests('slow.md'); i++) await wait(10); // the first is inside its ingest now
      assert.equal((await up()).status, 409);
      assert.equal((await first).status, 201);
    } finally { S.kd.slow.ingest = 0; }
    assert.equal(ingests('slow.md'), 1, 'one ingest');
    assert.equal((await up()).status, 409, 'and once stored, the listing check holds');
  });
  test('T3 the write checks see the path as it is routed (dot segments)', async () => {
    const r = await new Promise((resolve, reject) => {
      // node:http sends the path as written (fetch and a URL string would normalize it)
      const q = request({ host: '127.0.0.1', port: S.kb.server.address().port, path: '/api/buckets/acme/./files', method: 'POST', headers: H(fat(), { 'content-type': 'text/markdown', 'x-filename': 'dots.md' }) }, resolve);
      q.on('error', reject); q.end('# dots');
    });
    r.resume();
    assert.equal(r.statusCode, 201, 'an upload, named in X-Filename: not refused as a non-JSON write');
  });

  // -------------------------------------------------------------------------------------------- T5 coexistence
  test('T5 the admin token still works; kb_live_ keys never take the JWT path', async () => {
    assert.equal((await postBucket('ByToken', { authorization: 'Bearer dev-admin', 'content-type': 'application/json' })).status, 201);
    const key = await (await S.api('/api/instances/front-desk/keys', { method: 'POST', headers: H(fat()), body: JSON.stringify({ name: 't' }) })).json();
    assert.ok(String(key.key).startsWith('kb_live_'));
    const f0 = hm.fetches;
    const r = await S.api('/v1/bots/front-desk/chat', { method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How many days do I have to return an item?' }) });
    assert.equal(r.status, 200);
    const o = await S.api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'front-desk', messages: [{ role: 'user', content: 'Returns?' }] }) });
    assert.equal(o.status, 200);
    assert.equal(hm.fetches, f0);
  });
  test('T5 direct public surfaces unchanged; through host-manager only the dashboard and its API, under a CSP', async () => {
    for (const p of ['/studio/', '/site/', '/lib/widget.js', '/index.html']) {
      const r = await S.api(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('content-security-policy'), null, p);
    }
    for (const p of ['/studio/', '/site/', '/lib/widget.js', '/index.html', '/p/x', '/v1/bots/front-desk', '/api/v1/capabilities', '/healthz', '/demo/']) {
      const r = await S.api(p, { headers: { 'x-kdex-forwarded': 'true' } });
      assert.equal(r.status, 404, p);
      assert.ok(r.headers.get('content-security-policy'), p);
      // a FAT-shaped Bearer alone (no header) is refused the same way
      assert.equal((await S.api(p, { headers: { authorization: `Bearer ${fat()}` } })).status, 404, p);
    }
    assert.equal((await S.api('/api/events', { method: 'POST', headers: H(fat()), body: '{}' })).status, 404, 'telemetry is not an hm route');
    const d = await S.api('/dashboard/', { headers: { 'x-kdex-forwarded': 'true' } });
    assert.equal(d.status, 200);
    const csp = d.headers.get('content-security-policy');
    const script = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('script-src'));
    assert.ok(!script.includes("'unsafe-inline'") && /'sha256-[A-Za-z0-9+/=]+'/.test(script), script);
    assert.ok(csp.includes("form-action 'self'") && csp.includes("connect-src 'self'"));
    for (const p of ['/dashboard/favicon.svg', '/dashboard/dashboard.js', '/lib/site-config.js']) {
      const r = await S.api(p, { headers: { 'x-kdex-forwarded': 'true' } });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('content-security-policy'), csp, p);
    }
    assert.ok((await S.api('/api/config', { headers: { 'x-kdex-forwarded': 'true' } })).headers.get('content-security-policy'), 'JSON too');
    const redir = await S.api('/dashboard', { headers: { 'x-kdex-forwarded': 'true' } });
    assert.equal(redir.status, 301);
    assert.equal(redir.headers.get('location'), 'dashboard/', 'relative: stays under /knowbot');
  });
  test('T5 the dashboard inline script hash matches what the browser will compute', async () => {
    const { createHash } = await import('node:crypto');
    const html = await fsp.readFile(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    const csp = (await S.api('/dashboard/', { headers: { 'x-kdex-forwarded': 'true' } })).headers.get('content-security-policy');
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`));
  });

  // -------------------------------------------------------------------------------------------- T7 no leaks
  test('T7 no token, signature, claim set, cookie or api_token reaches the log', async () => {
    const a = fat({ entitlements: ['knowbot:*:admin', 'knowbot:secret-ent:read'] });
    await S.api('/api/providers?api_token=SECRETQUERY&x_token=SECRET2', { headers: H(a, { cookie: 'auth_token=SECRETCOOKIE; X-API-TOKEN=kd_h_SECRETPAT' }) });
    await postBucket('Leak', H(fat({ entitlements: ['knowbot:secret-ent:read'] })));
    await postBucket('Leak2', H(`${a.slice(0, -4)}AAAA`));
    const text = LOG.join('\n');
    for (const needle of [a, a.split('.')[2], a.split('.')[1], 'secret-ent', 'SECRETQUERY', 'SECRET2', 'SECRETCOOKIE', 'SECRETPAT']) assert.ok(!text.includes(needle), needle.slice(0, 20));
    assert.ok(/\[auth\] POST \/api\/buckets by owner/.test(text), 'allowed writes are logged with the actor');
    assert.ok(/\[auth\] denied owner no admin grant/.test(text) && /\[auth\] denied - signature/.test(text), 'denials are logged with a reason');
  });
});

// ------------------------------------------------------------------------------------------------ T4 JWKS life cycle
describe('T4 JWKS life cycle', () => {
  let hm, S, auth;
  const H = (fat) => viaHm(hm, fat);
  const providers = (fat) => S.api('/api/providers', { headers: H(fat) });
  before(async () => {
    hm = await startFakeHm();
    hm.down = true;
    auth = createHmAuth({ env: authEnv(hm), log: () => {} });
    S = await boot({ hm, hmAuth: auth });
    for (let i = 0; i < 100 && !hm.fetches; i++) await wait(20);
    await auth.refresh();
  });
  after(async () => { await S.close(); await hm.close(); });

  test('(a) host-manager down at start: 401; up: the next refresh admits', async () => {
    assert.equal((await providers(hm.mint({}, { aud: [AUD] }))).status, 401);
    await auth.refresh(); // the refresh that 401 triggered, while still down
    hm.down = false;
    await auth.refresh(); // the next one (the 15-min timer, or the next unknown-kid miss after 30 s)
    assert.equal((await providers(hm.mint({}, { aud: [AUD] }))).status, 200);
  });
  test('(b) rotation: the new kid is 401 once, triggers one refresh, then 200; the old kid is dropped', async () => {
    const oldFat = hm.mint({}, { aud: [AUD] });
    hm.rotate();
    const f0 = hm.fetches;
    assert.equal((await providers(hm.mint({}, { aud: [AUD] }))).status, 401);
    await auth.refresh();
    assert.equal(hm.fetches, f0 + 1);
    assert.equal((await providers(hm.mint({}, { aud: [AUD] }))).status, 200);
    assert.equal((await providers(oldFat)).status, 401);
  });
  test('(c) 50 unknown-kid requests within 30 s: at most one extra fetch', async () => {
    await wait(10);
    const f0 = hm.fetches;
    const stranger = { kid: 'nobody', ...generateKeyPairSync('ec', { namedCurve: 'P-256' }) };
    const tok = hm.mint({}, { aud: [AUD], key: stranger });
    for (let i = 0; i < 50; i++) assert.equal((await providers(tok)).status, 401);
    await auth.refresh();
    assert.ok(hm.fetches - f0 <= 2, `${hm.fetches - f0} fetches`); // ≤1 from the misses, +1 from this explicit refresh
  });
  test('(d)(e) a failed, oversized or redirecting refresh keeps the last good keys', async () => {
    const ok = () => providers(hm.mint({}, { aud: [AUD] }));
    for (const fault of ['down', 'oversize', 'redirect']) {
      hm[fault] = true;
      await auth.refresh();
      assert.equal((await ok()).status, 200, fault);
      hm[fault] = false;
    }
  });
});

// ------------------------------------------------------------------------------------------------ seal self-check
describe('T6 the sealing secret self-check', () => {
  test('a secret that does not open the stored kb_live_ keys is named in one log line; the right one is silent', async () => {
    const hm = await startFakeHm();
    const kd = await startFakeKnowDrive({ speed: 20 });
    const A = await boot({ hm, kd, on: false, env: { KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'secret-a' } });
    const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
    assert.equal((await A.api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Seal' }) })).status, 201);
    assert.equal((await A.api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Sealed', buckets: ['seal'] }) })).status, 201);
    assert.equal((await A.api('/api/instances/sealed/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'k' }) })).status, 201);
    await A.close();
    const line = /KNOWBOT_SECRET_KEY does not open the stored kb_live_ keys/;
    for (const [secret, expect] of [['secret-b', true], ['secret-a', false]]) {
      const mark = LOG.length;
      const B = await boot({ hm, kd, env: { KNOWBOT_SECRET_KEY: secret } });
      for (let i = 0; i < 50 && !LOG.slice(mark).some((l) => line.test(l)); i++) await wait(20);
      assert.equal(LOG.slice(mark).some((l) => line.test(l)), expect, secret);
      assert.ok(!LOG.slice(mark).some((l) => l.includes(secret)), 'the value is never logged');
      await B.close();
    }
    // knowDrive failing at boot is not the secret's fault: the right secret is never blamed
    const mark = LOG.length;
    kd.failNext.paths['knowbot/_config/devkeys.json'] = 1;
    const C = await boot({ hm, kd, env: { KNOWBOT_SECRET_KEY: 'secret-a' } });
    try {
      for (let i = 0; i < 50 && !LOG.slice(mark).some((l) => /could not check the kb_live_ keys/.test(l)); i++) await wait(20);
      assert.ok(LOG.slice(mark).some((l) => /could not check the kb_live_ keys/.test(l)));
      assert.ok(!LOG.slice(mark).some((l) => line.test(l)));
    } finally { await C.close(); await kd.close(); await hm.close(); }
  });
});

// ------------------------------------------------------------------------------------------------ listen address
describe('T6 listen address (npm start)', () => {
  // the real entry point, on an ephemeral port; no knowDrive key (local retrieval), nothing listens on port 9
  const start = (env) => new Promise((resolve, reject) => {
    const { HOST, ...base } = process.env;
    for (const k of Object.keys(base)) if (/^(KNOWBOT_|KNOWDRIVE_)/.test(k)) delete base[k];
    const c = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], { env: { ...base, PORT: '0', LLM_BASE_URL: 'http://127.0.0.1:9/v1', KNOWBOT_SECRET_KEY: 's', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { c.kill('SIGKILL'); reject(new Error(`no listen line: ${out}`)); }, 20000);
    c.stdout.on('data', (d) => {
      out += d;
      if (/listening on/.test(out)) { clearTimeout(t); c.kill('SIGKILL'); resolve(out); }
    });
  });
  const full = { KNOWBOT_AUTH_ISSUER: 'http://127.0.0.1:9', KNOWBOT_AUTH_AUDIENCE: AUD, KNOWBOT_AUTH_JWKS_URL: 'http://127.0.0.1:9/.well-known/jwks.json' };
  test('switch off: all interfaces as today; switch on: loopback unless HOST is set, and a non-loopback HOST is named', async () => {
    assert.match(await start({}), /listening on http:\/\/localhost:0/); // 0.0.0.0 is printed as localhost
    const on = await start(full);
    assert.match(on, /listening on http:\/\/127\.0\.0\.1:0/);
    assert.ok(!/reachable without host-manager/.test(on));
    assert.match(await start({ ...full, HOST: '0.0.0.0' }), /HOST=0\.0\.0\.0: KnowBot's own port is reachable without host-manager/);
  });
});

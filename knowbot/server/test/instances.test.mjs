// Chat instances: folder scoping, admin auth, upload path containment (no network: fake knowDrive).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { normalizeFolder, safeRelPath, slugify } from '../instances.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'lib', 'knowbot.js');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => srv.close(() => r()));

/** A knowDrive stand-in: registry file by path, multipart ingest, file list/get/delete and search. */
function fakeKnowDrive() {
  const files = new Map([
    ['file-out', { id: 'file-out', filename: 'knowbot/ugm/policies/refund.md', tags: ['knowbot'] }],
  ]);
  let registry = null;
  const calls = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1');
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, url: url.pathname, search: url.search, auth: req.headers.authorization, raw });
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname.includes('/path/content/')) return registry ? (res.writeHead(200), res.end(registry)) : json(404, { error: { message: 'not found' } });
      if (url.pathname === '/api/v1/ingest') {
        const name = /filename="([^"]+)"/.exec(raw)?.[1];
        const tags = /name="tags"\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '';
        if (name === 'knowbot/_config/instances.json') registry = raw.split('\r\n\r\n').slice(-1)[0].split('\r\n--')[0];
        const id = `file-${files.size + 1}`;
        files.set(id, { id, filename: name, tags: tags.split(','), status: 'in_progress' });
        return json(200, { files: [{ id, filename: name, status: 'in_progress' }] });
      }
      if (/\/vector_stores\/[^/]+\/files$/.test(url.pathname)) {
        const prefix = url.searchParams.get('prefix') || '';
        return json(200, { data: [...files.values()].filter((f) => f.filename.startsWith(prefix)), has_more: false });
      }
      const fm = /^\/api\/v1\/files\/([^/]+)$/.exec(url.pathname);
      if (fm) {
        const f = files.get(decodeURIComponent(fm[1]));
        if (!f) return json(404, {});
        if (req.method === 'DELETE') { files.delete(f.id); return json(200, { deleted: true }); }
        return json(200, f);
      }
      if (url.pathname.endsWith('/search')) {
        return json(200, { data: [
          { file_id: 'a', filename: 'knowbot/acme/hours.md', score: 0.9, content: [{ type: 'text', text: 'Open 9 to 5.' }] },
          { file_id: 'b', filename: 'knowbot/ugm/policies/refund.md', score: 0.95, content: [{ type: 'text', text: 'another folder' }] },
          { file_id: 'c', filename: 'other/knowbot/acme/x.md', score: 0.93, content: [{ type: 'text', text: 'same tags, wrong folder' }] },
          { file_id: 'd', filename: 'knowbot/acme/sub/menu.pdf', score: 0.8, content: [{ type: 'text', text: 'Menu.' }] },
        ] });
      }
      json(404, {});
    });
  });
  return { srv, calls, files };
}

describe('chat instances', () => {
  let kd, kdPort, kb, port;
  const admin = { authorization: 'Bearer s3cret', 'content-type': 'application/json' };
  const api = (p, init = {}) => fetch(`http://127.0.0.1:${port}${p}`, init);

  before(async () => {
    kd = fakeKnowDrive(); kdPort = await listen(kd.srv);
    kb = createKnowBotServer({ root: ROOT, corpusDir: path.join(ROOT, 'corpus'), dataDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-inst-')), libPath: LIB, quiet: true, watch: false,
      env: { KNOWDRIVE_BASE_URL: `http://127.0.0.1:${kdPort}`, KNOWDRIVE_API_KEY: 'k', KNOWDRIVE_STORE: 'vs_t', KNOWBOT_ADMIN_TOKEN: 's3cret', LLM_BASE_URL: 'http://127.0.0.1:9/v1' } });
    port = await listen(kb.server);
  });
  after(async () => { await close(kb.server); await close(kd.srv); });

  test('helpers: folders normalise, upload names cannot leave the folder, ids slugify', () => {
    assert.equal(normalizeFolder('/knowbot//acme'), 'knowbot/acme/');
    assert.throws(() => normalizeFolder('knowbot/../ugm/'), /\.\./);
    assert.throws(() => normalizeFolder(''), /required/);
    assert.throws(() => normalizeFolder('knowbot/_config/'), /reserved/);
    assert.equal(safeRelPath('../../ugm/evil.md'), 'ugm/evil.md');
    assert.equal(safeRelPath('docs\\guide.pdf'), 'docs/guide.pdf');
    assert.equal(slugify('Sunrise Bakery & Café!'), 'sunrise-bakery-cafe');
  });

  test('creating an instance needs the admin token and saves the registry to knowDrive', async () => {
    assert.equal((await api('/api/instances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Acme"}' })).status, 401);
    assert.equal((await api('/api/instances', { method: 'POST', headers: { ...admin, authorization: 'Bearer wrong!' }, body: '{"name":"Acme"}' })).status, 401);
    const r = await api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme', starters: ['Hours?'] }) });
    assert.equal(r.status, 201);
    const it = await r.json();
    assert.equal(it.id, 'acme'); assert.equal(it.folder, 'knowbot/acme/'); assert.equal(it.guards, 'general');
    assert.ok(kd.calls.some((c) => c.url === '/api/v1/ingest' && c.raw.includes('filename="knowbot/_config/instances.json"')));
    assert.equal((await api('/api/instances', { method: 'POST', headers: admin, body: '{"name":"Acme"}' })).status, 409);
    const list = await (await api('/api/instances')).json();
    assert.deepEqual(list.instances.map((x) => x.id), ['ugm', 'acme']);
  });

  test('search for an instance is filtered to its folder tags, and hits outside the folder are dropped', async () => {
    const j = await (await api('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hours', instance: 'acme' }) })).json();
    const searches = kd.calls.filter((c) => c.url.endsWith('/search')).map((c) => JSON.parse(c.raw));
    assert.ok(!searches.some((b) => b.filter.all_of.includes('kind:canonical')), 'no answer-card query for uploaded folders');
    const call = { raw: JSON.stringify(searches.find((b) => b.mode === 'hybrid')) };
    const body = JSON.parse(call.raw);
    assert.deepEqual(body.filter.all_of, ['dir:knowbot', 'dir:acme'], 'no knowbot:ugm tag, only the folder');
    assert.deepEqual(body.filter.none_of, ['kind:config'], 'the registry file is never a source');
    assert.deepEqual(j.results.map((r) => r.filename), ['hours.md', 'sub/menu.pdf'], 'other folders never come back, even with matching tags');
    assert.equal((await api('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x","instance":"nope"}' })).status, 404);
  });

  test('uploads land inside the instance folder with its tag; the built-in instance and other folders are off limits', async () => {
    const up = await api('/api/instances/acme/files', { method: 'POST', headers: { authorization: admin.authorization, 'content-type': 'text/markdown', 'x-filename': encodeURIComponent('../../ugm/evil.md') }, body: '# hi' });
    assert.equal(up.status, 201);
    const ingest = kd.calls.filter((c) => c.url === '/api/v1/ingest').at(-1);
    assert.match(ingest.raw, /filename="knowbot\/acme\/ugm\/evil\.md"/);
    assert.match(ingest.raw, /knowbot:acme/);
    assert.equal((await api('/api/instances/acme/files', { method: 'POST', headers: { 'x-filename': 'a.md' }, body: 'x' })).status, 401);
    assert.equal((await api('/api/instances/ugm/files', { method: 'POST', headers: { authorization: admin.authorization, 'x-filename': 'a.md' }, body: 'x' })).status, 403);
    const files = await (await api('/api/instances/acme/files', { headers: admin })).json();
    assert.deepEqual(files.files.map((f) => f.path), ['ugm/evil.md']);
    assert.equal((await api('/api/instances/acme/files/file-out', { method: 'DELETE', headers: admin })).status, 403, 'a file in another folder cannot be deleted through this instance');
    assert.equal((await api(`/api/instances/acme/files/${files.files[0].id}`, { method: 'DELETE', headers: admin })).status, 200);
  });

  test('instances can be edited and deleted, but not the built-in one', async () => {
    const r = await api('/api/instances/acme', { method: 'PATCH', headers: admin, body: JSON.stringify({ minSimilarity: 0.66, greeting: 'Hello!' }) });
    assert.equal((await r.json()).minSimilarity, 0.66);
    assert.equal((await api('/api/instances/ugm', { method: 'DELETE', headers: admin })).status, 403);
    assert.equal((await api('/api/instances/acme', { method: 'DELETE', headers: admin })).status, 200);
    assert.equal((await api('/api/config?instance=acme')).status, 404);
  });
});

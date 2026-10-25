// Chat instances: folder scoping, admin auth, upload path containment (no network: fake knowDrive).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { normalizeFolder, safeRelPath, slugify, folderTags, foldersOf } from '../instances.mjs';
import { sealKey, openKey } from '../providers.mjs';

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
      const having = (f) => (url.searchParams.get('tags_all') || '').split(',').filter(Boolean).every((t) => (f.tags || []).includes(t));
      if (/\/vector_stores\/[^/]+\/files$/.test(url.pathname)) {
        const prefix = url.searchParams.get('prefix') || '';
        return json(200, { data: [...files.values()].filter((f) => f.filename.startsWith(prefix) && having(f)), has_more: false });
      }
      if (/\/vector_stores\/[^/]+\/tags$/.test(url.pathname)) {
        const counts = new Map();
        for (const f of files.values()) if (having(f)) for (const t of f.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
        return json(200, { data: [...counts].map(([tag, count]) => ({ tag, count })), has_more: false });
      }
      if (url.pathname === '/api/v1/files/batch_tags') {
        const b = JSON.parse(raw);
        for (const id of b.file_ids) { const f = files.get(id); if (f) f.tags = [...new Set([...(f.tags || []).filter((t) => !(b.tags_remove || []).includes(t)), ...(b.tags_add || [])])]; }
        return json(200, { updated: b.file_ids.length });
      }
      const fm = /^\/api\/v1\/files\/([^/]+)$/.exec(url.pathname);
      if (fm) {
        const f = files.get(decodeURIComponent(fm[1]));
        if (!f) return json(404, {});
        if (req.method === 'DELETE') { files.delete(f.id); return json(200, { deleted: true }); }
        return json(200, f);
      }
      if (url.pathname.endsWith('/search')) {
        // Deliberately ignores the filter: KnowBot must drop every hit whose tags don't match the bucket and mask.
        return json(200, { data: [
          { file_id: 'a', filename: 'knowbot/acme/hours.md', score: 0.9, content: [{ type: 'text', text: 'Open 9 to 5.' }], tags: ['bucket:acme'] },
          { file_id: 'b', filename: 'knowbot/ugm/policies/refund.md', score: 0.95, content: [{ type: 'text', text: 'another bucket' }], tags: ['knowbot:ugm'] },
          { file_id: 'c', filename: 'elsewhere/lunch.md', score: 0.93, content: [{ type: 'text', text: 'tagged in, stored elsewhere' }], tags: ['bucket:acme', 'f1:menus'] },
          { file_id: 'd', filename: 'knowbot/acme/menus/menu.pdf', score: 0.8, content: [{ type: 'text', text: 'Menu.' }], tags: ['bucket:acme', 'f1:menus', 'format:pdf'] },
          { file_id: 'e', filename: 'knowbot/acme/untagged.md', score: 0.99, content: [{ type: 'text', text: 'no tags returned' }] },
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
    assert.deepEqual(folderTags(['Family Law', '04']), ['f1:family-law', 'f2:04']);
    assert.deepEqual(foldersOf(['bucket:x', 'f2:04', 'f1:family-law']), ['family-law', '04']);
    assert.equal(foldersOf(['bucket:x']), null);
    assert.equal(normalizeFolder('/knowbot//acme'), 'knowbot/acme/');
    assert.throws(() => normalizeFolder('knowbot/../ugm/'), /\.\./);
    assert.throws(() => normalizeFolder(''), /required/);
    assert.throws(() => normalizeFolder('knowbot/_config/'), /reserved/);
    assert.equal(safeRelPath('../../ugm/evil.md'), 'ugm/evil.md');
    assert.equal(safeRelPath('docs\\guide.pdf'), 'docs/guide.pdf');
    assert.equal(slugify('Sunrise Bakery & Café!'), 'sunrise-bakery-cafe');
  });

  const post = (p, body, h = admin) => api(p, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const patch = (p, body) => api(p, { method: 'PATCH', headers: admin, body: JSON.stringify(body) });
  const search = async (instance) => (await (await api('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hours', instance }) })).json());
  const lastSearches = (n) => kd.calls.filter((c) => c.url.endsWith('/search')).slice(-n).map((c) => JSON.parse(c.raw));

  test('buckets are tags: created by name, no folder, and saved to the registry in knowDrive', async () => {
    assert.equal((await post('/api/buckets', { name: 'Acme' }, { 'content-type': 'application/json' })).status, 401);
    assert.equal((await post('/api/buckets', { name: 'Acme' }, { ...admin, authorization: 'Bearer wrong!' })).status, 401);
    const b = await post('/api/buckets', { name: 'Acme' });
    assert.equal(b.status, 201);
    const bucket = await b.json();
    assert.equal(bucket.tag, 'bucket:acme');
    assert.equal(bucket.folder, undefined, 'no paths in the API');
    assert.equal((await post('/api/buckets', { name: 'Lunch Menus', tag: 'menus' })).status, 201);
    assert.equal((await post('/api/buckets', { name: 'Acme' })).status, 409);
    assert.ok(kd.calls.some((c) => c.url === '/api/v1/ingest' && c.raw.includes('filename="knowbot/_config/instances.json"')));
    assert.equal((await post('/api/instances', { name: 'Bad', buckets: [{ id: 'nope' }] })).status, 400, 'links must name real buckets');
    const bot = await (await post('/api/instances', { name: 'Front desk', buckets: [{ id: 'acme' }, { id: 'menus', enabled: false }] })).json();
    assert.deepEqual(bot.buckets, [{ id: 'acme', enabled: true }, { id: 'menus', enabled: false }]);
    const g = await (await api('/api/graph')).json();
    assert.deepEqual(g.buckets.map((x) => [x.id, x.tag]), [['ugm', 'knowbot:ugm'], ['acme', 'bucket:acme'], ['menus', 'bucket:menus']]);
  });

  test('a bot searches by its enabled buckets\' tags, and every hit must carry them', async () => {
    const j = await search('front-desk');
    const [body] = lastSearches(1);
    assert.deepEqual(body.filter.all_of, ['bucket:acme'], 'scope is the bucket tag only');
    assert.deepEqual(body.filter.none_of, ['kind:config'], 'the registry file is never a source');
    assert.equal(body.fields, 'tags,uri,score,text,file_id,metadata', 'tags are requested so hits can be checked');
    assert.deepEqual(j.results.map((r) => [r.bucket, r.filename]), [['acme', 'elsewhere/lunch.md'], ['acme', 'hours.md'], ['acme', 'menus/menu.pdf']],
      'hits from another bucket or without tags are dropped; where a file is stored does not matter');
    assert.equal((await api('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x","instance":"nope"}' })).status, 404);
  });

  test('masks narrow a link by tags: required tags and excluded tags', async () => {
    await patch('/api/instances/front-desk', { buckets: [{ id: 'acme', mask: { require: ['f1:menus'], exclude: ['format:pdf'] } }] });
    const j = await search('front-desk');
    const [body] = lastSearches(1);
    assert.deepEqual(body.filter.all_of, ['bucket:acme', 'f1:menus']);
    assert.deepEqual(body.filter.none_of, ['kind:config', 'format:pdf']);
    assert.deepEqual(j.results.map((r) => r.filename), ['elsewhere/lunch.md'], 'only the menus folder, no PDFs');
    const g = await (await api('/api/graph')).json();
    assert.deepEqual(g.bots.find((b) => b.id === 'front-desk').buckets[0].mask, { require: ['f1:menus'], exclude: ['format:pdf'] });
    assert.equal((await patch('/api/instances/front-desk', { buckets: [{ id: 'acme', mask: { require: ['not a tag!'] } }] })).status, 400);
    await patch('/api/instances/front-desk', { buckets: [{ id: 'acme' }] });
  });

  test('several bots can share one bucket; a bot with no enabled links answers from nothing', async () => {
    await post('/api/instances', { name: 'Kiosk', buckets: ['acme'] });
    for (const id of ['kiosk', 'front-desk']) assert.equal((await search(id)).results.length, 3);
    await patch('/api/instances/kiosk', { buckets: [] });
    await kb.registry.botTagging; // unlinking retags in the background
    const searches = () => kd.calls.filter((c) => c.url.endsWith('/search')).length;
    const before = searches();
    assert.deepEqual((await search('kiosk')).results, []);
    assert.equal(searches(), before, 'no knowDrive search at all');
  });

  test('uploads: folders become tags; moving a file only retags it; other buckets are off limits', async () => {
    const up = await api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: admin.authorization, 'content-type': 'text/markdown', 'x-filename': encodeURIComponent('../../Menus/Lunch Specials/today.md') }, body: '# hi' });
    assert.equal(up.status, 201);
    assert.deepEqual((await up.json()).folders, ['Menus', 'Lunch Specials']);
    const ingest = kd.calls.filter((c) => c.url === '/api/v1/ingest').at(-1);
    assert.match(ingest.raw, /bucket:acme/);
    assert.match(ingest.raw, /f1:menus,f2:lunch-specials/);
    assert.equal((await api('/api/buckets/acme/files', { method: 'POST', headers: { 'x-filename': 'a.md' }, body: 'x' })).status, 401);
    assert.equal((await api('/api/buckets/ugm/files', { method: 'POST', headers: { authorization: admin.authorization, 'x-filename': 'a.md' }, body: 'x' })).status, 403);
    let files = (await (await api('/api/buckets/acme/files', { headers: admin })).json()).files;
    assert.deepEqual(files.map((f) => [f.name, f.folders, f.path]), [['today.md', ['menus', 'lunch-specials'], 'menus/lunch-specials/today.md']]);
    assert.equal(files[0].folder, undefined);
    const mv = await api(`/api/buckets/acme/files/${files[0].id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ folders: ['Archive'] }) });
    assert.equal(mv.status, 200);
    files = (await (await api('/api/buckets/acme/files', { headers: admin })).json()).files;
    assert.deepEqual(files[0].folders, ['archive'], 'moved by retagging');
    const tags = (await (await api('/api/buckets/acme/tags')).json()).tags.map((t) => t.tag);
    assert.ok(tags.includes('f1:archive') && !tags.includes('bucket:acme') && !tags.includes('knowbot'), 'mask picker gets folder tags, not bookkeeping');
    assert.equal((await api('/api/buckets/acme/files/file-out', { method: 'DELETE', headers: admin })).status, 403, 'a file without the bucket tag cannot be deleted through it');
    assert.equal((await api(`/api/buckets/acme/files/${files[0].id}`, { method: 'DELETE', headers: admin })).status, 200);
  });

  test('linking a bucket to a bot tags its files bot:<id>; unlinking or deleting the bot removes the tag', async () => {
    const tagsOf = (id) => kd.files.get(id).tags;
    const up = await (await api('/api/buckets/menus/files', { method: 'POST', headers: { authorization: admin.authorization, 'content-type': 'text/markdown', 'x-filename': 'soup.md' }, body: '# soup' })).json();
    await kb.registry.botTagging;
    assert.ok(!tagsOf(up.id).some((t) => t.startsWith('bot:')), 'menus feeds no bot yet');
    const bot = await (await post('/api/instances', { name: 'Waiter', buckets: [{ id: 'menus' }] })).json();
    await kb.registry.botTagging;
    assert.ok(tagsOf(up.id).includes('bot:waiter'), 'existing files get the bot tag when linked');
    const up2 = await (await api('/api/buckets/menus/files', { method: 'POST', headers: { authorization: admin.authorization, 'content-type': 'text/markdown', 'x-filename': 'salad.md' }, body: '# salad' })).json();
    assert.ok(tagsOf(up2.id).includes('bot:waiter'), 'new uploads to a linked bucket carry it too');
    const tags = (await (await api('/api/buckets/menus/tags')).json()).tags.map((t) => t.tag);
    assert.ok(!tags.includes('bot:waiter'), 'not offered as a mask tag');
    await patch(`/api/instances/${bot.id}`, { buckets: [] });
    await kb.registry.botTagging;
    assert.ok(!tagsOf(up.id).includes('bot:waiter') && !tagsOf(up2.id).includes('bot:waiter'), 'unlinking removes it');
    await patch(`/api/instances/${bot.id}`, { buckets: [{ id: 'menus', enabled: false }] });
    await kb.registry.botTagging;
    assert.ok(tagsOf(up.id).includes('bot:waiter'), 'a link that is switched off still counts as connected');
    await api(`/api/instances/${bot.id}`, { method: 'DELETE', headers: admin });
    await kb.registry.botTagging;
    assert.ok(!tagsOf(up.id).includes('bot:waiter'), 'deleting the bot removes it');
  });

  test('the built-in bot can only change its links; deleting a bucket unlinks it everywhere', async () => {
    const renamed = await (await patch('/api/instances/ugm', { greeting: 'Welcome to UGM!' })).json();
    assert.equal(renamed.greeting, 'Welcome to UGM!', 'the built-in bot accepts settings');
    assert.equal(renamed.name, 'The Ultimate Game Master');
    const u = await (await patch('/api/instances/ugm', { buckets: [{ id: 'ugm' }, { id: 'acme' }] })).json();
    assert.deepEqual(u.buckets.map((l) => l.id), ['ugm', 'acme']);
    assert.equal((await api('/api/buckets/ugm', { method: 'DELETE', headers: admin })).status, 403);
    assert.equal((await api('/api/buckets/acme', { method: 'DELETE', headers: admin })).status, 200);
    const g = await (await api('/api/graph')).json();
    assert.ok(g.bots.every((b) => !b.buckets.some((l) => l.id === 'acme')), 'no dangling links');
    await patch('/api/instances/ugm', { buckets: [{ id: 'ugm' }] });
    assert.equal((await api('/api/instances/front-desk', { method: 'DELETE', headers: admin })).status, 200);
    assert.equal((await api('/api/config?instance=front-desk')).status, 404);
  });

  test('provider keys are sealed, never listed, and bots on a hosted platform need a model', async () => {
    const sealed = sealKey('sk-test-1234', 'secret-a');
    assert.ok(!sealed.includes('sk-test'), 'the key is not stored in the clear');
    assert.equal(openKey(sealed, 'secret-a'), 'sk-test-1234');
    assert.throws(() => openKey(sealed, 'secret-b'), /different server secret/);
    const g = await (await api('/api/graph')).json();
    assert.deepEqual(g.providers.map((p) => [p.id, p.configured]), [['local', true], ['openai', false], ['anthropic', false]]);
    assert.ok(g.providers.every((p) => !('last4' in p)), 'the public graph shows no key hints');
    assert.equal((await api('/api/providers')).status, 401, 'key status is admin-only');
    assert.equal((await post('/api/instances', { name: 'Claude bot', provider: 'anthropic' })).status, 400, 'a hosted platform needs a model');
    assert.equal((await post('/api/instances', { name: 'Bad model', provider: 'local', model: 'gpt-4o' })).status, 400, 'local models come from the server list');
    const bot = await (await post('/api/instances', { name: 'Claude bot', provider: 'anthropic', model: 'claude-opus-5-5', instructions: 'Answer warmly.', answerMode: 'generate' })).json();
    assert.deepEqual([bot.provider, bot.model, bot.answerMode, bot.instructions], ['anthropic', 'claude-opus-5-5', 'generate', 'Answer warmly.']);
    const local = await (await patch('/api/instances/claude-bot', { provider: 'local' })).json();
    assert.equal(local.model, undefined, 'switching platform clears the old model id');
    assert.equal((await api('/api/instances/claude-bot', { method: 'DELETE', headers: admin })).status, 200);
  });
});

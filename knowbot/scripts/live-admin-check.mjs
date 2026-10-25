#!/usr/bin/env node
// End-to-end check of the live bots & buckets admin API, run from CI with the admin token.
//   KNOWBOT_API=https://knowbot-api.….workers.dev KNOWBOT_ADMIN_TOKEN=… node scripts/live-admin-check.mjs [--keep]
// Creates a throwaway bucket + bot (kbtest-live-*), uploads a file, waits for knowDrive to finish it, checks the
// bot answers from it and nothing else, then deletes everything it made. Never prints the token.
const API = String(process.env.KNOWBOT_API || '').replace(/\/+$/, '');
const TOKEN = process.env.KNOWBOT_ADMIN_TOKEN || '';
const keep = process.argv.includes('--keep');
if (!API || !TOKEN) { console.error('KNOWBOT_API and KNOWBOT_ADMIN_TOKEN are required'); process.exit(2); }

const id = `kbtest-live-${Date.now().toString(36)}`;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
async function call(path, { method = 'GET', json, body, headers = {}, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ask = async (bot, question) => (await call('/api/canonical', { method: 'POST', auth: false, json: { question, instance: bot } })).data;

try {
  ok((await call('/api/providers', { auth: false })).status === 401, 'admin endpoints refuse requests without the token');
  const prov = await call('/api/providers');
  ok(prov.status === 200, `admin token accepted (providers: ${(prov.data.providers || []).map((p) => `${p.id}${p.configured ? '✓' : ''}`).join(', ')})`);

  const b = await call('/api/buckets', { method: 'POST', json: { name: `KB live check ${id}`, id } });
  ok(b.status === 201 && b.data.folder === `knowbot/${id}/`, `bucket created at ${b.data.folder}`);
  const doc = '# Lighthouse Café\n\nThe Lighthouse Café serves breakfast from 6:30am to 10:45am every day.\nThe café\'s signature dish is the harbour pancake stack.\n';
  const up = await call(`/api/buckets/${id}/files`, { method: 'POST', body: doc, headers: { 'content-type': 'text/markdown', 'x-filename': 'menu/breakfast.md' } });
  ok(up.status === 201 && up.data.path === 'menu/breakfast.md', `uploaded ${up.data.path}`);

  let stage = '', seen = [];
  for (let i = 0; i < 60 && stage !== 'ready' && stage !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const f = ((await call(`/api/buckets/${id}/files`)).data.files || []).find((x) => x.path === 'menu/breakfast.md');
    stage = f?.stage || 'missing';
    if (seen.at(-1) !== stage) { seen.push(stage); console.log(`      ${(i + 1) * 5}s  ${stage}${f?.atoms ? ` (${f.vectorized ?? 0}/${f.atoms} atoms vectorized)` : ''}`); }
  }
  ok(stage === 'ready', `file reached ready via ${seen.join(' → ')}`);
  const atoms = await call(`/api/buckets/${id}/files/${up.data.id}/atoms?limit=2`);
  ok(atoms.status === 200 && /6:30am/.test(JSON.stringify(atoms.data.items)), 'atom preview shows the extracted text');

  const bot = await call('/api/instances', { method: 'POST', json: { name: `KB live bot ${id}`, id: `${id}-bot`, buckets: [{ id }], instructions: 'Keep answers short.' } });
  ok(bot.status === 201, `bot ${bot.data.id} created and linked`);
  const a1 = await ask(`${id}-bot`, 'When is breakfast served?');
  ok(/6:30am/.test(a1.text || '') && (a1.citations || []).some((c) => c.filename === 'menu/breakfast.md'), `answers from the bucket: ${JSON.stringify((a1.text || '').slice(0, 90))}`);
  const a2 = await ask(`${id}-bot`, 'Do you ship to Canada?');
  ok(a2.refused === true, 'does not answer from other buckets (UGM shipping)');
  await call(`/api/instances/${id}-bot`, { method: 'PATCH', json: { buckets: [{ id, enabled: false }] } });
  const a3 = await ask(`${id}-bot`, 'When is breakfast served?');
  ok(a3.refused === true, 'switching the link off removes the source');
} catch (e) {
  ok(false, `unexpected error: ${e.message}`);
} finally {
  if (!keep) {
    const files = (await call(`/api/buckets/${id}/files`).catch(() => ({ data: {} }))).data.files || [];
    for (const f of files) await call(`/api/buckets/${id}/files/${f.id}`, { method: 'DELETE' }).catch(() => {});
    const d1 = await call(`/api/instances/${id}-bot`, { method: 'DELETE' }).catch(() => ({ status: 0 }));
    const d2 = await call(`/api/buckets/${id}`, { method: 'DELETE' }).catch(() => ({ status: 0 }));
    console.log(`cleanup: ${files.length} file(s) deleted, bot ${d1.status}, bucket ${d2.status}`);
  }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

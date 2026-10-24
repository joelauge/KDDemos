#!/usr/bin/env node
// Keep the live knowDrive store in sync with knowbot/corpus/ (dry run by default).
//
//   KNOWDRIVE_API_KEY=... node knowbot/scripts/sync-knowdrive.mjs [--apply] [--json] [--concurrency 4] [--verbose]
//
// Env: same as seed-knowdrive.mjs: KNOWDRIVE_BASE_URL (default https://knowdrive.ai), KNOWDRIVE_API_KEY (required),
//      KNOWDRIVE_STORE (default "Joel's Store"), KNOWDRIVE_TAG (default knowbot:ugm), KNOWDRIVE_PREFIX (default knowbot/ugm/).
//
// Plan, for every corpus/**/*.md compared with the live file at <PREFIX><relpath>:
//   add     not in the store                                  → upload (POST /api/v1/ingest)
//   update  content differs (trailing newlines normalised)    → upload (new version supersedes the old one)
//   same    identical bytes
//   retag   live tags lack knowbot / <TAG> / kind:<kind> / canonical TAGS.json extras
//           → POST /api/v1/files/batch_tags {tags_add} (additive only; never replaces the tag set)
//   remove  live file tagged <TAG> AND under <PREFIX> with no local counterpart → DELETE …/files/{id}
// Nothing outside <PREFIX> or without <TAG> is ever modified: the store is shared with 8,000+ unrelated files.
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, DEFAULT_STORE, DEFAULT_TAG, DEFAULT_PREFIX } from '../server/retrievers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (flag('--help') || flag('-h')) {
  console.log((await fsp.readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(1, 17).join('\n'));
  process.exit(0);
}

const APPLY = flag('--apply');
const JSON_OUT = flag('--json');
const VERBOSE = flag('--verbose') || flag('-v');
const CONCURRENCY = Math.max(1, Number(opt('--concurrency', 4)));
const corpusDir = path.resolve(opt('--corpus', path.join(__dirname, '..', 'corpus')));
const base = String(process.env.KNOWDRIVE_BASE_URL || 'https://knowdrive.ai').replace(/\/+$/, '');
const key = process.env.KNOWDRIVE_API_KEY || '';
const store = process.env.KNOWDRIVE_STORE || DEFAULT_STORE;
const tag = process.env.KNOWDRIVE_TAG ?? DEFAULT_TAG;
const prefix = String(process.env.KNOWDRIVE_PREFIX ?? DEFAULT_PREFIX).replace(/^\/+/, '');

if (!key) { console.error('KNOWDRIVE_API_KEY is required (sync reads the live store even in dry-run)'); process.exit(2); }
if (!tag || !prefix) { console.error('refusing to sync with an empty KNOWDRIVE_TAG or KNOWDRIVE_PREFIX (shared store)'); process.exit(2); }

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const auth = { authorization: `Bearer ${key}` };

async function req(url, init = {}, { retries = 3, okStatuses = [] } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) }, signal: AbortSignal.timeout(60000) });
      if (res.ok || okStatuses.includes(res.status)) return res;
      const text = await res.text();
      lastErr = new Error(`${init.method || 'GET'} ${url.replace(base, '')}: HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
  }
  throw lastErr;
}

async function pool(items, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

// ---------- local ----------
async function walk(dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
}

let extraTags = {};
try { extraTags = JSON.parse(await fsp.readFile(path.join(corpusDir, 'canonical', 'TAGS.json'), 'utf8')); } catch { /* no cards */ }

const local = new Map();
for (const abs of (await walk(corpusDir)).sort()) {
  const rel = path.relative(corpusDir, abs).split(path.sep).join('/');
  const src = await fsp.readFile(abs, 'utf8');
  const { meta } = parseFrontmatter(src);
  const kind = typeof meta.kind === 'string' && meta.kind ? meta.kind : 'page';
  // Same tag derivation as seed-knowdrive.mjs.
  const extra = (extraTags[rel] || extraTags[`canonical/${path.basename(rel)}`] || []).map((t) => String(t).toLowerCase()).filter((t) => /^[a-z0-9:._-]+$/.test(t));
  const tags = [...new Set(['knowbot', tag, `kind:${kind}`, ...extra].filter(Boolean))];
  local.set(`${prefix}${rel}`, { rel, storePath: `${prefix}${rel}`, src, tags });
}

// ---------- live ----------
async function listFiles(params) {
  const rows = [];
  let after = '';
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ limit: '500', ...params });
    if (after) qs.set('after', after);
    const j = await (await req(`${base}/api/v1/vector_stores/${store}/files?${qs}`)).json();
    rows.push(...(j.data || []));
    after = j.next_after || j.last_id || (j.data?.length ? j.data[j.data.length - 1].id : '');
    if (!j.has_more || !after) break;
  }
  return rows;
}

// Union of "tagged with the store tag" and "under the prefix", so an untagged file at our path still counts as live.
const liveById = new Map();
for (const r of [...await listFiles({ tags_all: tag }), ...await listFiles({ prefix })]) liveById.set(r.id, r);
const liveByPath = new Map();
for (const r of liveById.values()) {
  const prev = liveByPath.get(r.filename);
  const t = (x) => Number(x.last_modified_at || x.updated_at || x.created_at || 0);
  if (!prev || t(r) > t(prev)) liveByPath.set(r.filename, r);
}

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\n+$/, '');
async function liveContent(storePath) {
  const res = await req(`${base}/api/v1/vector_stores/${store}/path/content/${storePath.split('/').map(encodeURIComponent).join('/')}`, {}, { okStatuses: [404] });
  return res.status === 404 ? null : await res.text();
}

const plan = { add: [], update: [], same: [], retag: [], remove: [] };
await pool([...local.values()], async (item) => {
  const live = liveByPath.get(item.storePath);
  if (!live) { plan.add.push({ path: item.storePath, bytes: Buffer.byteLength(item.src), tags: item.tags }); return; }
  const content = await liveContent(item.storePath);
  if (content == null) plan.add.push({ path: item.storePath, bytes: Buffer.byteLength(item.src), tags: item.tags, note: 'listed but content 404' });
  else if (norm(content) !== norm(item.src)) plan.update.push({ path: item.storePath, file_id: live.id, localBytes: Buffer.byteLength(item.src), liveBytes: Buffer.byteLength(content) });
  else plan.same.push({ path: item.storePath, file_id: live.id });
  const have = new Set((live.tags || []).map((t) => String(t).toLowerCase()));
  const missing = item.tags.filter((t) => !have.has(t));
  if (missing.length) plan.retag.push({ path: item.storePath, file_id: live.id, missing, viaUpload: content == null || norm(content) !== norm(item.src) });
});
for (const r of liveById.values()) {
  const tagged = (r.tags || []).includes(tag);
  const underPrefix = typeof r.filename === 'string' && r.filename.startsWith(prefix);
  if (tagged && underPrefix && !local.has(r.filename)) plan.remove.push({ path: r.filename, file_id: r.id, bytes: r.bytes });
}
for (const k of Object.keys(plan)) plan[k].sort((a, b) => a.path.localeCompare(b.path));

// ---------- report ----------
const counts = Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length]));
log(`${APPLY ? '' : '[dry-run] '}sync ${local.size} local files ↔ ${liveByPath.size} live (${base}, store ${store}, prefix ${prefix}, tag ${tag})`);
log(`  add ${counts.add}  update ${counts.update}  same ${counts.same}  retag ${counts.retag}  remove ${counts.remove}`);
for (const a of plan.add) log(`  + add     ${a.path}  ${a.bytes}B${a.note ? `  (${a.note})` : ''}`);
for (const u of plan.update) log(`  ~ update  ${u.path}  live ${u.liveBytes}B → local ${u.localBytes}B`);
for (const t of plan.retag) log(`  # retag   ${t.path}  +[${t.missing.join(', ')}]${t.viaUpload ? '  (covered by upload)' : ''}`);
for (const r of plan.remove) log(`  - remove  ${r.path}  ${r.file_id}`);
if (VERBOSE) for (const s of plan.same) log(`  = same    ${s.path}`);

const result = { apply: APPLY, base, store, prefix, tag, local: local.size, live: liveByPath.size, counts, plan, applied: null };
if (!APPLY) {
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else log(counts.add + counts.update + counts.retag + counts.remove ? 'dry run: re-run with --apply to execute' : 'in sync');
  process.exit(0);
}

// ---------- apply ----------
const applied = { uploaded: [], retagged: [], removed: [], errors: [] };
async function upload(item) {
  const fd = new FormData();
  fd.append('tags', item.tags.join(','));
  fd.append('mime_type', 'text/markdown');
  fd.append('file', new Blob([item.src], { type: 'text/markdown' }), item.storePath);
  const res = await req(`${base}/api/v1/ingest`, { method: 'POST', headers: { 'x-vector-store-id': store }, body: fd });
  let j = {}; try { j = JSON.parse(await res.text()); } catch {}
  const got = j.files?.[0]?.filename ?? j.filename;
  if (got !== item.storePath) throw new Error(`stored as "${got}", expected "${item.storePath}"`);
  return j.files?.[0] ?? j;
}
await pool([...plan.add, ...plan.update], async (p) => {
  try { const r = await upload(local.get(p.path)); applied.uploaded.push({ path: p.path, file_id: r.id || r.file_id }); log(`  ✓ uploaded ${p.path}`); }
  catch (e) { applied.errors.push({ op: 'upload', path: p.path, error: e.message }); console.error(`  ✗ upload ${p.path}: ${e.message}`); }
});
// Retag only files not just re-uploaded (an upload already carries the full tag list). Additive: tags_add.
await pool(plan.retag.filter((t) => !t.viaUpload), async (t) => {
  try {
    await req(`${base}/api/v1/files/batch_tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_ids: [t.file_id], tags_add: t.missing }) });
    applied.retagged.push(t); log(`  ✓ retagged ${t.path} +[${t.missing.join(', ')}]`);
  } catch (e) { applied.errors.push({ op: 'retag', path: t.path, error: e.message }); console.error(`  ✗ retag ${t.path}: ${e.message}`); }
});
for (const r of plan.remove) {
  const row = liveById.get(r.file_id);
  // Re-check the guard right before deleting.
  if (!row || !(row.tags || []).includes(tag) || !String(row.filename).startsWith(prefix)) { console.error(`  ! skip remove ${r.path}: guard failed`); continue; }
  log(`  - deleting ${r.path} (${r.file_id})`);
  try {
    await req(`${base}/api/v1/vector_stores/${store}/files/${encodeURIComponent(r.file_id)}`, { method: 'DELETE' }, { okStatuses: [404] });
    applied.removed.push(r);
  } catch (e) { applied.errors.push({ op: 'remove', path: r.path, error: e.message }); console.error(`  ✗ remove ${r.path}: ${e.message}`); }
}
result.applied = applied;
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else log(`done: ${applied.uploaded.length} uploaded, ${applied.retagged.length} retagged, ${applied.removed.length} removed, ${applied.errors.length} errors`);
process.exit(applied.errors.length ? 1 : 0);

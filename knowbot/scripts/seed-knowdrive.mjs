#!/usr/bin/env node
// Upload knowbot/corpus/ into a (shared) knowDrive vector store, tag-windowed for KnowBot.
//
//   KNOWDRIVE_API_KEY=... node knowbot/scripts/seed-knowdrive.mjs [--dry-run] [--only <substring>] [--concurrency 4]
//
// Env: KNOWDRIVE_BASE_URL (default https://knowdrive.ai), KNOWDRIVE_API_KEY (required unless --dry-run),
//      KNOWDRIVE_STORE (default vs_97c857474b1f4e8892b134c283cf9849, "Joel's Store"), KNOWDRIVE_TAG (default knowbot:ugm),
//      KNOWDRIVE_PREFIX (default knowbot/ugm/: the folder inside the shared production store).
//
// Each corpus file is uploaded with
//   POST {base}/api/v1/vector_stores/{store}/files   (multipart: file, filename=<PREFIX><relpath>, purpose=assistants, tags)
// Path is the logical identity in knowDrive: re-uploading the same path creates a new version that
// supersedes the old one, so this script is idempotent (run it again after editing the corpus).
// Tags: knowbot, <KNOWDRIVE_TAG>, kind:<kind from frontmatter>, plus any canonical/TAGS.json tags for the file.
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, DEFAULT_STORE, DEFAULT_TAG, DEFAULT_PREFIX } from '../server/retrievers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = flag('--dry-run') || flag('-n');
const ONLY = opt('--only', '');
const CONCURRENCY = Math.max(1, Number(opt('--concurrency', 4)));
const corpusDir = path.resolve(opt('--corpus', path.join(__dirname, '..', 'corpus')));
const base = String(process.env.KNOWDRIVE_BASE_URL || 'https://knowdrive.ai').replace(/\/+$/, '');
const key = process.env.KNOWDRIVE_API_KEY || '';
const store = process.env.KNOWDRIVE_STORE || DEFAULT_STORE;
const tag = process.env.KNOWDRIVE_TAG ?? DEFAULT_TAG;
const prefix = String(process.env.KNOWDRIVE_PREFIX ?? DEFAULT_PREFIX).replace(/^\/+/, '');

if (flag('--help') || flag('-h')) {
  console.log(fileURLToPath(import.meta.url) + '\n' + (await fsp.readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(1, 16).join('\n'));
  process.exit(0);
}
if (!DRY && !key) { console.error('KNOWDRIVE_API_KEY is required (or pass --dry-run)'); process.exit(2); }

async function walk(dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
}

let files;
try { files = (await walk(corpusDir)).sort(); } catch (e) { console.error(`cannot read corpus at ${corpusDir}: ${e.message}`); process.exit(1); }
if (ONLY) files = files.filter((f) => f.includes(ONLY));

// Canonical answer cards carry extra targeting tags (topic:, entity:, intent:) from corpus/canonical/TAGS.json.
let extraTags = {};
try { extraTags = JSON.parse(await fsp.readFile(path.join(corpusDir, 'canonical', 'TAGS.json'), 'utf8')); } catch { /* no cards yet */ }

const plan = [];
for (const abs of files) {
  const rel = path.relative(corpusDir, abs).split(path.sep).join('/');
  const src = await fsp.readFile(abs, 'utf8');
  const { meta } = parseFrontmatter(src);
  const kind = typeof meta.kind === 'string' && meta.kind ? meta.kind : 'page';
  const extra = (extraTags[rel] || extraTags[`canonical/${path.basename(rel)}`] || []).map((t) => String(t).toLowerCase()).filter((t) => /^[a-z0-9:._-]+$/.test(t));
  const tags = [...new Set(['knowbot', tag, `kind:${kind}`, ...extra].filter(Boolean))];
  plan.push({ rel, storePath: `${prefix}${rel}`, bytes: Buffer.byteLength(src), tags, src, title: meta.title || '' });
}

console.log(`${DRY ? '[dry-run] ' : ''}seeding ${plan.length} files from ${corpusDir}`);
console.log(`  → ${base}/api/v1/vector_stores/${store}/files   prefix=${prefix} tag=${tag}`);

async function upload(item) {
  const fd = new FormData();
  fd.append('purpose', 'assistants');
  fd.append('filename', item.storePath);
  fd.append('tags', item.tags.join(','));
  fd.append('mime_type', 'text/markdown');
  fd.append('file', new Blob([item.src], { type: 'text/markdown' }), path.posix.basename(item.rel));
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base}/api/v1/vector_stores/${encodeURIComponent(store)}/files`, {
        method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (res.ok) { let j = {}; try { j = JSON.parse(text); } catch {} return j; }
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
  }
  throw lastErr;
}

let ok = 0, failed = 0;
const queue = [...plan];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    if (DRY) {
      console.log(`  would upload ${item.storePath.padEnd(70)} ${String(item.bytes).padStart(7)}B  tags=[${item.tags.join(', ')}]`);
      ok++; continue;
    }
    try {
      const r = await upload(item);
      ok++;
      console.log(`  ✓ ${item.storePath}  ${r.id || r.file_id || ''} ${r.status || ''}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${item.storePath}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: DRY ? 1 : CONCURRENCY }, worker));
console.log(`${DRY ? '[dry-run] ' : ''}done: ${ok} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);

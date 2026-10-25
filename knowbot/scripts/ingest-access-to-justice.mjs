#!/usr/bin/env node
// Ingest the access-to-justice corpus into knowDrive (bucket folder knowbot/access-to-justice/):
//   - Ontario court forms (ontariocourtforms.on.ca, English): Word versions (.docx, else .doc), PDF only when a form
//     has no Word version → ontario-court-forms/<category>/<form>/<file>
//   - Federal Acts and Regulations (laws-lois.justice.gc.ca/eng): HTML full text, page chrome removed
//     → federal-laws/acts/<id>.html, federal-laws/regulations/<id>.html
// Resumable (done list in --state), polite to the source sites (2 at a time, backoff on 429/503).
//   KNOWDRIVE_API_KEY=… node scripts/ingest-access-to-justice.mjs --forms ocf-files.json --legis legis.xml --state state.jsonl [--only forms|laws] [--limit N]
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const KEY = process.env.KNOWDRIVE_API_KEY;
const BASE = (process.env.KNOWDRIVE_BASE_URL || 'https://knowdrive.ai').replace(/\/+$/, '');
const STORE = process.env.KNOWDRIVE_STORE || 'vs_97c857474b1f4e8892b134c283cf9849';
const ROOT = 'knowbot/access-to-justice/';
const STATE = arg('state', 'ingest-state.jsonl');
const ONLY = arg('only', '');
const LIMIT = Number(arg('limit', 0)) || Infinity;
if (!KEY) { console.error('KNOWDRIVE_API_KEY is required'); process.exit(2); }

const done = new Set(existsSync(STATE) ? readFileSync(STATE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).path) : []);
const UA = { 'user-agent': 'Mozilla/5.0 (KnowBot access-to-justice ingest; contact joel@recoursellm.com)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', pdf: 'application/pdf', html: 'text/html' };

async function fetchSource(url, attempt = 0) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { retry: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    if (attempt >= 6 || !(e.retry || /fetch failed|timeout|aborted/i.test(e.message))) throw e;
    await sleep(2000 * 2 ** attempt + Math.random() * 1000);
    return fetchSource(url, attempt + 1);
  }
}

async function ingest(path, bytes, mime, tags, attempt = 0) {
  const fd = new FormData();
  fd.append('tags', ['knowbot', 'bucket:access-to-justice', 'kind:upload', ...tags].join(','));
  fd.append('mime_type', mime);
  fd.append('file', new Blob([bytes], { type: mime }), path);
  try {
    const r = await fetch(`${BASE}/api/v1/ingest`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'x-vector-store-id': STORE }, body: fd, signal: AbortSignal.timeout(180000) });
    const text = await r.text();
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`knowDrive HTTP ${r.status}: ${text.slice(0, 120)}`), { retry: true });
    if (!r.ok) throw new Error(`knowDrive HTTP ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text); const f = j.files?.[0] ?? j;
    if (f.filename && f.filename !== path) throw new Error(`stored at ${f.filename}, expected ${path}`);
    return f.id;
  } catch (e) {
    if (attempt >= 5 || !(e.retry || /fetch failed|timeout|aborted/i.test(e.message))) throw e;
    await sleep(3000 * 2 ** attempt);
    return ingest(path, bytes, mime, tags, attempt + 1);
  }
}

/** Keep the page's <main> (the law itself) with its title and source; drop site navigation, scripts and styles. */
function cleanLaw(html, url, title) {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] || html;
  const body = main.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, '');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="canonical" href="${esc(url)}"></head>\n<body>\n<p>Source: <a href="${esc(url)}">${esc(url)}</a></p>\n${body}\n</body></html>\n`;
}

// ---------------------------------------------------------------- the plan
// Folders are tags, one per level (f1:…, f2:…): the dashboard draws the folder tree from them, and masks select by them.
const tagSafe = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'x';
export const folderTags = (segments) => segments.map((seg, i) => `f${i + 1}:${tagSafe(seg)}`);
const safe = (s) => String(s).replace(/[,\s]+/g, '_').replace(/[^\w.\-]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
const plan = [];
if (ONLY !== 'laws') {
  const rows = JSON.parse(readFileSync(arg('forms', 'ocf-files.json'), 'utf8'));
  const byDir = new Map();
  for (const r of rows) {
    const rel = r.url.replace(/^https?:\/\/[^/]+\/static\/media\/uploads\//, '');
    if (!rel.startsWith('courtforms/')) continue; // notices to the profession etc. are not forms
    const dir = rel.split('/').slice(0, -1).join('/');
    (byDir.get(dir) || byDir.set(dir, []).get(dir)).push({ ...r, rel });
  }
  for (const [dir, files] of byDir) {
    // Word versions only; a form folder with no Word file keeps its PDF so no form is missing.
    const pick = ['docx', 'doc', 'pdf'].map((e) => files.filter((f) => f.ext === e)).find((x) => x.length) || [];
    for (const f of pick) {
      const segs = ['ontario-court-forms', ...dir.replace(/^courtforms\//, '').split('/')];
      const archived = /[-_]arc(?:hive[d]?)?\.[a-z]+$/i.test(f.rel);
      plan.push({ kind: 'form', url: f.url.replace(/^http:/, 'https:'), mime: MIME[f.ext], path: `${ROOT}${segs.join('/')}/${f.rel.split('/').pop()}`,
        tags: ['source:ontario-court-forms', 'doctype:form', `format:${f.ext}`, `status:${archived ? 'archived' : 'current'}`, ...folderTags(segs)] });
    }
  }
}
if (ONLY !== 'forms') {
  const xml = readFileSync(arg('legis', 'legis.xml'), 'utf8');
  for (const m of xml.matchAll(/<(Act|Regulation)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const b = m[2];
    if (!/<Language>eng<\/Language>/.test(b)) continue;
    const id = /<UniqueId>([^<]+)/.exec(b)[1];
    const title = (/<Title>([^<]+)/.exec(b)?.[1] || id).replace(/&amp;/g, '&');
    const toc = /<LinkToHTMLToC>([^<]+)/.exec(b)[1].replace('http://', 'https://');
    const kind = m[1] === 'Act' ? 'acts' : 'regulations';
    plan.push({ kind: 'law', url: toc.replace(/index\.html$/, 'FullText.html'), mime: MIME.html, title,
      path: `${ROOT}federal-laws/${kind}/${safe(id)}.html`, tags: ['source:justice-laws', `doctype:${m[1] === 'Act' ? 'act' : 'regulation'}`, 'status:current', ...folderTags(['federal-laws', kind])] });
  }
}
const todo = plan.filter((p) => !done.has(p.path)).slice(0, LIMIT);
console.log(`plan: ${plan.length} files (${plan.filter((p) => p.kind === 'form').length} forms, ${plan.filter((p) => p.kind === 'law').length} laws); ${done.size} already done; ${todo.length} to go`);

// ---------------------------------------------------------------- run: 2 source fetches, 3 ingests in flight
let fetched = 0, stored = 0, failed = 0, bytesIn = 0;
const t0 = Date.now();
const ready = [];
let sourceIdx = 0, fetchersDone = 0;
async function fetcher() {
  while (sourceIdx < todo.length) {
    const p = todo[sourceIdx++];
    try {
      let bytes = await fetchSource(p.url);
      if (p.kind === 'law') bytes = Buffer.from(cleanLaw(bytes.toString('utf8'), p.url, p.title));
      ready.push({ ...p, bytes }); fetched++;
    } catch (e) { failed++; appendFileSync(`${STATE}.errors`, `${JSON.stringify({ path: p.path, url: p.url, error: e.message })}\n`); }
    while (ready.length > 12) await sleep(200); // back-pressure: knowDrive sets the pace
    await sleep(250);
  }
  fetchersDone++;
}
async function uploader() {
  for (;;) {
    const p = ready.shift();
    if (!p) { if (fetchersDone === 2) return; await sleep(200); continue; }
    try {
      const id = await ingest(p.path, p.bytes, p.mime, p.tags);
      stored++; bytesIn += p.bytes.length;
      appendFileSync(STATE, `${JSON.stringify({ path: p.path, id, bytes: p.bytes.length })}\n`);
    } catch (e) { failed++; appendFileSync(`${STATE}.errors`, `${JSON.stringify({ path: p.path, url: p.url, error: e.message })}\n`); }
    if ((stored + failed) % 100 === 0) {
      const min = (Date.now() - t0) / 60000;
      console.log(`${new Date().toISOString().slice(11, 19)}  stored ${stored}/${todo.length} · failed ${failed} · ${(bytesIn / 1048576).toFixed(1)} MB · ${(stored / Math.max(min, 0.01)).toFixed(0)}/min`);
    }
  }
}
await Promise.all([fetcher(), fetcher(), uploader(), uploader(), uploader()]);
console.log(`done: stored ${stored}, failed ${failed}, ${(bytesIn / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 60000).toFixed(1)} min`);

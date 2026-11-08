// KnowBot Builder knowledge base: the only material the Builder may use to answer questions about KnowBot itself.
//
// The docs live in studio/kb/*.md (front-matter-free, one H1, short H2 sections each with a "Source: /path" line). They
// are ingested ONCE into the Studio's knowDrive store under knowbot/builder-kb/<name>.md, tagged
//   knowbot, kind:builder-kb, bucket:knowbot-builder, kbv:<sha256-12 of the doc text>
// and re-ingested only when a doc's text (its hash) changes. Every copy gets an invisible whitespace tail derived from
// (name, hash): production knowDrive does not make a byte-identical re-upload searchable under new tags, so each
// content version must be byte-unique.
//
// Safety rules:
//   * ensure() only ever lists, ingests or deletes rows whose path is under knowbot/builder-kb/ AND whose tags carry
//     kind:builder-kb (other paths are never touched). If the listing fails, nothing is written (fail closed).
//   * search() keeps a hit only when its TAGS prove membership: knowbot + kind:builder-kb + bucket:knowbot-builder +
//     the kbv:<hash> of the current local doc it claims to be; never questions / kind:config. Everything else (the
//     fake's production fixture, stale versions, excluded rows that leak through) is dropped.
//   * similarity = 1 - distance/2. A narrow-filter vector search can come back EMPTY in production, so hybrid hits
//     are scored by their own `distance` (never by their RRF `score`); a hybrid hit with no distance is a keyword match
//     with similarity null.
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const KB_DIR = path.resolve(__dirname, '..', '..', 'studio', 'kb');
export const KB_PREFIX = 'knowbot/builder-kb/';
export const KB_TAGS = Object.freeze(['knowbot', 'kind:builder-kb', 'bucket:knowbot-builder']);
export const KB_FILTER = Object.freeze({ all_of: ['kind:builder-kb'], none_of: ['questions', 'kind:config'] });
const NEVER = ['questions', 'kind:config', 'kind:trial-spec'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}\.md$/;
const SOURCE_RE = /^Source:\s*(\S+)\s*$/im;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
export const docHash = (text) => sha(text).slice(0, 12);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const round4 = (x) => Math.round(Number(x) * 10000) / 10000;

/** Invisible, deterministic tail (spaces and tabs) unique to one content version of one doc. */
export function kbTail(name, hash) {
  const h = createHash('sha256').update(`builder-kb:${name}:${hash}`).digest();
  let tail = '\n';
  for (let i = 0; i < 12; i++) for (let b = 0; b < 8; b++) tail += (h[i] >> b) & 1 ? '\t' : ' ';
  return `${tail}\n`;
}

/** Parses one KB doc: title (H1), sections [{heading, source}], and the doc-level first source. */
export function parseKbDoc(name, text) {
  const t = String(text || '').replace(/\r/g, '');
  const title = /^#\s+(.+)$/m.exec(t)?.[1].trim() || name.replace(/\.md$/, '');
  const sections = [];
  const re = /^##\s+(.+)$/gm;
  const heads = [];
  for (let m; (m = re.exec(t));) heads.push({ heading: m[1].trim(), at: m.index, end: m.index + m[0].length });
  heads.forEach((h, i) => {
    const body = t.slice(h.end, i + 1 < heads.length ? heads[i + 1].at : t.length);
    sections.push({ heading: h.heading, source: SOURCE_RE.exec(body)?.[1] || null });
  });
  return { name, title, sections, source: sections.find((s) => s.source)?.source || null };
}

/** Loads studio/kb/*.md (sorted). Each doc: {name, path, text, hash, title, sections, source}. */
export function loadKbDocs(dir = KB_DIR) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => NAME_RE.test(n)).sort(); } catch { return []; }
  return names.map((name) => {
    const text = readFileSync(path.join(dir, name), 'utf8');
    return { ...parseKbDoc(name, text), path: `${KB_PREFIX}${name}`, text, hash: docHash(text) };
  });
}

/** True when a row's/hit's tags prove it is a Builder KB doc (tags only). */
export function isKbTagged(tags) {
  const tg = Array.isArray(tags) ? tags.map(String) : null;
  return !!tg && KB_TAGS.every((t) => tg.includes(t)) && !NEVER.some((t) => tg.includes(t));
}
const versionOf = (tags) => (Array.isArray(tags) ? tags.map(String).find((t) => /^kbv:[0-9a-f]{12}$/.test(t))?.slice(4) : null) || null;
const tsOf = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n; return Date.parse(v) || 0; };
const failedRow = (r) => /error|failed|cancel/i.test(String(r.status || '')) || /error|failed/i.test(String(r.phase || ''));
const readyRow = (r) => !failedRow(r) && (/completed|processed|ready/i.test(String(r.phase || r.status || '')));

/**
 * @param {object} o
 * @param {(p:string, init?:object, what?:string) => Promise<object>} [o.kdJson]  trials.mjs-style JSON helper (throws on !ok)
 * @param {(p:string, init?:object) => Promise<Response>} [o.kdFetch]               raw helper (used when kdJson is absent)
 * @param {{baseUrl:string, apiKey:string|Function}} [o.kd]                         standalone: builds its own kdFetch
 * @param {string} o.store                                                         knowDrive vector store id
 * @param {(msg:string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {string} [o.dir]        KB folder (default studio/kb)
 * @param {Array} [o.docs]        preloaded docs (tests); default loadKbDocs(dir)
 * @param {number} [o.retryMs]    after a failed ensure(), the next call waits this long before trying again (default 60 s)
 */
export function createBuilderKb(o = {}) {
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const store = String(o.store || '');
  const retryMs = Number(o.retryMs ?? 60000);
  const docs = Array.isArray(o.docs) ? o.docs.map((d) => ({ ...parseKbDoc(d.name, d.text), path: `${KB_PREFIX}${d.name}`, text: d.text, hash: docHash(d.text) })) : loadKbDocs(o.dir);
  for (const d of docs) if (!NAME_RE.test(d.name)) throw new Error(`builder kb: bad doc name ${d.name}`);
  const byName = new Map(docs.map((d) => [d.name, d]));

  let kdFetch = o.kdFetch;
  if (!kdFetch && o.kd?.baseUrl) {
    const key = () => (typeof o.kd.apiKey === 'function' ? o.kd.apiKey() : o.kd.apiKey);
    kdFetch = (p, init = {}) => {
      const { timeout = 30000, signal, ...rest } = init;
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
      return fetch(`${String(o.kd.baseUrl).replace(/\/+$/, '')}${p}`, { ...rest, headers: { authorization: `Bearer ${key()}`, ...(rest.headers || {}) }, signal: sig });
    };
  }
  const kdJson = o.kdJson || (kdFetch ? async (p, init = {}, what = 'request') => {
    const res = await kdFetch(p, init);
    const text = await res.text();
    let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
    if (!res.ok) { const e = new Error(`knowDrive ${what}: HTTP ${res.status} ${String(j.error?.message || text).slice(0, 200)}`); e.upstreamStatus = res.status; throw e; }
    return j;
  } : null);
  const usable = !!(kdJson && store);
  const storeUrl = `/api/v1/vector_stores/${encodeURIComponent(store)}`;

  // ------------------------------------------------------------------ ensure
  const state = { promise: null, done: false, lastError: null, failedAt: 0, last: null };

  async function listKbRows() {
    const rows = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ tags_all: 'kind:builder-kb', prefix: KB_PREFIX, limit: '200' });
      if (after) qs.set('after', after);
      const j = await kdJson(`${storeUrl}/files?${qs}`, { timeout: 15000 }, 'listing builder kb');
      if (!Array.isArray(j?.data)) throw new Error('knowDrive listing builder kb: no data array');
      rows.push(...j.data);
      after = j.next_after || j.last_id || (j.data.length ? j.data[j.data.length - 1].id : '');
      if (!j.has_more || !after) break;
    }
    // never touch other paths, never trust a row whose tags don't prove membership
    return rows.filter((r) => r && typeof r.id === 'string' && String(r.filename || '').startsWith(KB_PREFIX) && isKbTagged(r.tags));
  }
  async function ingestDoc(d) {
    const fd = new FormData();
    // knowDrive /ingest is a batch endpoint: tags, then mime_type, then the file part (its filename is the store path)
    fd.append('tags', [...KB_TAGS, `kbv:${d.hash}`].join(','));
    fd.append('mime_type', 'text/markdown');
    fd.append('file', new Blob([`${d.text}${kbTail(d.name, d.hash)}`], { type: 'text/markdown' }), d.path);
    const j = await kdJson('/api/v1/ingest', { method: 'POST', headers: { 'x-vector-store-id': store }, body: fd, timeout: 60000 }, `ingesting ${d.path}`);
    return j?.files?.[0] ?? j?.data?.[0] ?? j;
  }
  async function deleteRow(r) {
    if (!String(r.filename || '').startsWith(KB_PREFIX) || !isKbTagged(r.tags)) return false; // belt and braces
    await kdJson(`/api/v1/files/${encodeURIComponent(r.id)}`, { method: 'DELETE', headers: { 'x-vector-store-id': store }, timeout: 15000 }, `deleting ${r.filename}`);
    return true;
  }

  async function runEnsure() {
    const out = { ingested: [], kept: [], deleted: [], failed: [] };
    const rows = await listKbRows(); // throws → nothing written (fail closed)
    const byPath = new Map();
    for (const r of rows) { const k = r.filename; if (!byPath.has(k)) byPath.set(k, []); byPath.get(k).push(r); }
    for (const d of docs) {
      const have = (byPath.get(d.path) || []).sort((a, b) => tsOf(a.created_at) - tsOf(b.created_at) || String(a.id).localeCompare(String(b.id)));
      byPath.delete(d.path);
      const current = have.filter((r) => versionOf(r.tags) === d.hash && !failedRow(r));
      // the oldest live copy of the current version is the searchable one (a later byte-identical copy is not)
      const keep = current[0] || null;
      const stale = have.filter((r) => r !== keep);
      if (keep) out.kept.push(d.name);
      else {
        // a failed copy of this exact version must go first: an identical live file would make the new one unsearchable
        for (const r of stale.filter((x) => versionOf(x.tags) === d.hash)) { try { if (await deleteRow(r)) out.deleted.push(r.id); } catch (e) { log(`[builder-kb] delete ${r.id}: ${e.message}`); } }
        try { await ingestDoc(d); out.ingested.push(d.name); } catch (e) { out.failed.push(d.name); log(`[builder-kb] ingest ${d.name}: ${e.message}`); continue; }
      }
      // old versions and duplicates go only once the current version exists
      for (const r of stale.filter((x) => versionOf(x.tags) !== d.hash || keep)) { try { if (await deleteRow(r)) out.deleted.push(r.id); } catch (e) { log(`[builder-kb] delete ${r.id}: ${e.message}`); } }
    }
    // docs removed from studio/kb: their rows go too (still only under the prefix, still only kb-tagged)
    for (const rest of byPath.values()) for (const r of rest) { try { if (await deleteRow(r)) out.deleted.push(r.id); } catch (e) { log(`[builder-kb] delete ${r.id}: ${e.message}`); } }
    if (out.ingested.length || out.deleted.length) log(`[builder-kb] ensure: ${out.ingested.length} ingested, ${out.kept.length} kept, ${out.deleted.length} deleted${out.failed.length ? `, ${out.failed.length} failed` : ''}`);
    if (out.failed.length) throw Object.assign(new Error(`builder kb: ${out.failed.length} doc(s) failed to ingest`), { result: out });
    return out;
  }

  /** Ingest the KB docs once per process (single-flight). Never throws; returns {ok, ...counts} or {ok:false, error}. */
  async function ensure({ force = false } = {}) {
    if (!usable) return { ok: false, error: 'no_store' };
    if (state.done && !force) return { ok: true, ...state.last, cached: true };
    if (!state.promise) {
      if (!force && state.failedAt && now() - state.failedAt < retryMs) return { ok: false, error: state.lastError, retryAfterMs: retryMs - (now() - state.failedAt) };
      state.promise = runEnsure().then((r) => { state.done = true; state.last = r; state.lastError = null; state.failedAt = 0; return { ok: true, ...r }; },
        (e) => { state.lastError = e.message; state.failedAt = now(); log(`[builder-kb] ensure failed: ${e.message}`); return { ok: false, error: e.message, ...(e.result || {}) }; })
        .finally(() => { state.promise = null; });
    }
    return state.promise;
  }

  // ------------------------------------------------------------------ search
  async function query(question, mode, k, signal) {
    const j = await kdJson(`${storeUrl}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 8000, signal,
      body: JSON.stringify({ query: question, max_num_results: k, mode, text: 'raw', filter: { all_of: [...KB_FILTER.all_of], none_of: [...KB_FILTER.none_of] }, fields: 'tags,uri,score,text,file_id,metadata' }) }, `${mode} search`);
    return Array.isArray(j?.data) ? j.data : [];
  }
  const textOf = (d) => (Array.isArray(d.content) ? d.content.map((c) => c?.text || '').join('\n') : String(d.text ?? d.content ?? ''));
  const offsetOf = (d) => d.attributes?.source_offset ?? d.attributes?.provenance?.logical?.offset ?? d.metadata?.source_offset ?? null;
  const crumbOf = (d) => {
    const pp = d.attributes?.parent_path ?? d.metadata?.parent_path;
    if (Array.isArray(pp) && pp.length) return pp.map(String);
    const b = d.attributes?.breadcrumb ?? d.metadata?.breadcrumb;
    return b ? String(b).split(' > ') : [];
  };

  /** One hit → a normalized candidate, or null when its tags don't prove it is a current KB atom (fail closed). */
  function normalize(d, mode) {
    if (!d || !isKbTagged(d.tags)) return null;
    const file = String(d.filename || d.attributes?.path || '');
    if (!file.startsWith(KB_PREFIX)) return null;
    const doc = byName.get(file.slice(KB_PREFIX.length));
    if (!doc || versionOf(d.tags) !== doc.hash) return null; // unknown or stale version
    let text = textOf(d).replace(/^\s*Source:\s*\S+\s*$/gim, '').trim();
    if (!text || /^#{1,6}\s/.test(text) && !text.includes('\n')) return null; // a bare Source line or heading carries no fact
    const dist = Number(d.distance);
    const similarity = Number.isFinite(dist) && d.distance != null ? round4(1 - dist / 2)
      : mode === 'vector' && Number.isFinite(Number(d.score)) ? round4(Number(d.score)) : null;
    const crumbs = crumbOf(d);
    const heading = crumbs.length > 1 ? crumbs[crumbs.length - 1] : null;
    const section = heading ? doc.sections.find((s) => s.heading === heading) : null;
    return { fileId: d.file_id ?? null, name: doc.name, path: file, title: doc.title, section: heading, page: section?.source || doc.source,
      offset: offsetOf(d), text: text.slice(0, 1200), similarity, match: similarity == null ? null : Math.round(similarity * 100),
      label: similarity == null ? 'keyword match' : 'match', mode };
  }

  /**
   * Cited sources for a question about KnowBot. Never throws.
   * @returns {Promise<{ sources: Array<{n, fileId, name, path, title, section, page, offset, text, similarity, match, label}>,
   *                     top: number|null, mode: 'vector'|'hybrid'|'none', error?: string }>}
   *   sources are sorted by similarity (keyword matches last), at most k, each with a citation number n (1-based).
   *   minSimilarity (default 0) drops scored hits below it; keyword matches are kept only when some scored hit passed.
   */
  async function search(question, { k = 6, minSimilarity = 0, signal } = {}) {
    const q = oneLine(question).slice(0, 1000);
    if (!usable || !q) return { sources: [], top: null, mode: 'none', ...(usable ? {} : { error: 'no_store' }) };
    const [v, h] = await Promise.allSettled([query(q, 'vector', Math.max(k * 2, 10), signal), query(q, 'hybrid', Math.max(k * 2, 10), signal)]);
    if (v.status === 'rejected' && h.status === 'rejected') { log(`[builder-kb] search failed: ${v.reason?.message}`); return { sources: [], top: null, mode: 'none', error: String(v.reason?.message || 'search failed') }; }
    const vec = (v.status === 'fulfilled' ? v.value : []).map((d) => normalize(d, 'vector')).filter(Boolean);
    // production: a narrow-filter vector search can be empty; hybrid hits are then scored by their own distance
    const hyb = (h.status === 'fulfilled' ? h.value : []).map((d) => normalize(d, 'hybrid')).filter(Boolean);
    const key = (x) => `${x.fileId}|${x.offset ?? createHash('sha1').update(oneLine(x.text).slice(0, 200)).digest('hex')}`;
    const merged = new Map();
    for (const x of [...vec, ...hyb]) {
      const prev = merged.get(key(x));
      if (!prev) merged.set(key(x), x);
      else if (prev.similarity == null && x.similarity != null) merged.set(key(x), { ...x, mode: prev.mode });
    }
    const all = [...merged.values()];
    const scored = all.filter((x) => x.similarity != null && x.similarity >= minSimilarity).sort((a, b) => b.similarity - a.similarity);
    const keyword = scored.length ? all.filter((x) => x.similarity == null) : [];
    const picked = [...scored, ...keyword].slice(0, k).map((x, i) => ({ n: i + 1, ...x }));
    return { sources: picked, top: scored[0]?.similarity ?? null, mode: vec.length ? 'vector' : hyb.length ? 'hybrid' : 'none' };
  }

  return {
    ensure, search, docs: () => docs.map(({ name, path: p, hash, title, sections }) => ({ name, path: p, hash, title, sections })),
    status: () => ({ usable, ready: state.done, running: !!state.promise, lastError: state.lastError, last: state.last }),
  };
}

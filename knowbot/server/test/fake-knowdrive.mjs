// A knowDrive stand-in for Studio tests and the local dev server (spec 7.2). Never talks to the network.
//
// Shapes mirror production as verified on 2026-11-08 (see the A-0 block at the top of server/trials.mjs):
//   search  POST /api/v1/vector_stores/:s/search {query, max_num_results, mode, text, filter, fields}
//           -> {object, search_query, total_count, has_more, score_kind, data:[{file_id, filename, score, distance?,
//               fts_score?, attributes:{type:'chunk', node_kind, source_offset, breadcrumb, provenance, text_tokens},
//               content:[{type:'text', text}], tags}]}
//   files   GET  /api/v1/vector_stores/:s/files?tags_all=&prefix=&limit=&after=  (paged)
//           rows {id, filename, bytes, status, phase, atom_count, atoms_vectorized, chunk_count, tags, created_at}
//   ingest  POST /api/v1/ingest  multipart (file, tags csv, mime_type) + header x-vector-store-id
//   tags    POST /api/v1/files/batch_tags {file_ids, tags_add, tags_remove} + header x-vector-store-id
//   atoms   GET  /api/v1/files/:id/atoms?limit&offset
//   content GET  /api/v1/vector_stores/:s/path/content/<path>  (404 until written)
//
// Pipeline (times divided by `speed`): pending -(600)-> text_extracted -(600)-> chunked (atom_count 0)
//   -(400)-> chunked (atom_count = N) -(4 x 400)-> atoms_vectorized N/4 .. N -> completed. (Small files; fixer r7: the
//   stages grow with bytes and atoms, and blocks over MAX_ATOM chars are split at line/sentence boundaries.)
//   A file containing FAIL_NO_TEXT ends status:'error', last_error:'no text layer found'.
//   A file containing STALL stays text_extracted forever.
// Search deliberately IGNORES `filter` and always adds one production hit tagged knowbot:ugm, so the caller's own
// tag enforcement is what keeps results in scope.
//
// Production facts this fake ENFORCES (verified against production knowDrive, 2026-11-08), so the bugs they caused
// can never pass a test again:
//   - /ingest is a batch endpoint. Parts go tags, mime_type, then file part(s). A mime_type part after a file part is
//     rejected (400). Any other text part (e.g. `path`) is stored as a file of its own, named after the part; the
//     store path of a real file is its file part's filename.
//   - created_at / updated_at are unix SECONDS (numbers), never ISO strings.
//   - A byte-identical re-upload (same store, same bytes as a live file) is stored but is NOT searchable under the
//     new copy's tags (search never returns it).
//   - A pure vector search under a narrow tag filter (all_of matching fewer than `narrowRows` files, default 3) returns
//     NOTHING, while hybrid search with the same filter still finds the atoms and every hybrid hit carries `distance`
//     (similarity = 1 - distance/2) next to its RRF `score`.
import http from 'node:http';
import { createHash } from 'node:crypto';

const STOP = new Set(`a about above after again all am an and any are as at be because been before being below between both but by can
could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its
itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the
their them then there these they this those through to too under until up very was we were what when where which while who whom why will
with you your yours i'm i've you're it's what's don't can't isn't there's do you we're get got`.split(/\s+/));

export function stemWord(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(?:ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}
// A tiny concept layer so plain paraphrases land near the facts they ask about, the way a real embedding does
// ("annual" ~ "per year", "how much" ~ "costs", "fix" ~ "repair"). Applied after stemming, to queries and atoms alike.
const CONCEPTS = Object.freeze({
  annual: 'year', annually: 'year', yearly: 'year', yr: 'year',
  much: 'cost', price: 'cost', pric: 'cost', priced: 'cost', pricing: 'cost', charge: 'cost', charg: 'cost', billed: 'cost', fee: 'cost', pay: 'cost', expensive: 'cost', cheap: 'cost',
  fix: 'repair', mend: 'repair', servic: 'service', servicing: 'service', maintenance: 'service', maintain: 'service', tuneup: 'tune-up',
  guarantee: 'warranty', guaranteed: 'warranty', cover: 'warranty', coverage: 'warranty',
  hour: 'open', opening: 'open', close: 'open', closing: 'open',
  refund: 'return', exchange: 'return', send: 'ship', deliver: 'delivery', shipping: 'ship', shipp: 'ship',
  rental: 'rent', rented: 'rent', hire: 'rent', bicycle: 'bike', ebike: 'e-bike', membership: 'plan', subscription: 'plan', last: 'long', duration: 'long',
  location: 'address', located: 'address', far: 'range',
});
let CONCEPT_TARGETS_ = null;
const CONCEPT_TARGETS = { has: (w) => (CONCEPT_TARGETS_ ||= new Set(Object.values(CONCEPTS))).has(w) };
// fixer r5: like an embedding, "how long" and a stated duration ("lifetime", "for 2 years", "30 days") are one concept;
// the bare word "long" ("ridden hard for a long time", "as long as") is not a duration.
const DURATION_RE = /\b(?:lifetime|for\s+life|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|thirty|ninety)[\s-]+(?:business\s+|working\s+|calendar\s+)?(?:days?|weeks?|months?|years?|hours?|minutes?))\b/gi;
export function bag(text) {
  const m = new Map();
  const src = String(text || '');
  const dur = (src.match(DURATION_RE) || []).length + (/\bhow\s+long\b/i.test(src) ? 1 : 0);
  if (dur) m.set('duration', dur);
  // fixer r7: like an embedding, a stated amount ("is $100") sits near "how much" even when no cost word is used
  const money = !/\b(?:costs?|price[sd]?|pricing|charges?|fees?|pay|paid)\b/i.test(src) && /[$€£]\s?\d/.test(src);
  text = src.replace(/\bhow\s+long\b/gi, 'how');
  // fixer r3: "paid time off" / "PTO" and "vacation" are one concept, the way an embedding places them
  for (const raw0 of String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/\b(?:paid\s+)?time\s+off\b|\bpto\b|\bvacations?\b|\bannual\s+leave\b/g, 'vacation').match(/[a-z0-9][a-z0-9'-]*/g) || []) {
    const raw = raw0.replace(/-+$/, '').replace(/'s$/, '');
    for (const part of raw.includes('-') && !/^(?:e-bike|tune-up|e-city)s?$/.test(raw) ? raw.split('-') : [raw]) {
      const w0 = part.replace(/'s$/, '').replace(/'/g, '');
      if (!w0 || STOP.has(part) || STOP.has(w0)) continue;
      const st = stemWord(w0);
      const w = CONCEPTS[w0] || CONCEPTS[st] || st;
      m.set(w, (m.get(w) || 0) + 1);
      // fixer r5: a concept named literally ("warranty") sits a little closer than a paraphrase of it ("covered")
      if (w === st && CONCEPT_TARGETS.has(w)) m.set(`=${w}`, (m.get(`=${w}`) || 0) + 1);
    }
  }
  if (money && !m.has('cost')) m.set('cost', 1);
  return m;
}
/**
 * Fake embedding similarity in [0.55, 0.95]: a blend of bag-of-words cosine and idf-weighted query coverage (how much of
 * what the question asks about the atom covers). Words the corpus never uses carry the highest idf, so off-topic
 * questions stay near the 0.55 base while short paraphrases of a covered fact clear a 0.70 floor.
 * @param {Map} q query bag  @param {Map} a atom bag  @param {(t:string)=>number} [idf]
 */
export function similarity(q, a, idf = () => 1) {
  const cos = cosine(q, a);
  let num = 0, den = 0;
  for (const t of q.keys()) { const w = idf(t); den += w; if (a.has(t)) num += w; }
  const cov = den ? num / den : 0;
  const blend = Math.max(cos, 0.45 * cos + 0.55 * cov * cov);
  return { cos, cov, sim: 0.55 + 0.4 * blend };
}
/** idf over a list of bags (unknown words get the highest weight). */
export function idfOf(bags) {
  const df = new Map();
  for (const b of bags) for (const t of b.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = bags.length;
  return (t) => Math.log((n + 1) / ((df.get(t) || 0) + 1)) + 1;
}
const trigramCache = new Map();
function trigrams(text) {
  const key = String(text || '');
  let t = trigramCache.get(key);
  if (t) return t;
  t = new Set();
  const s = ` ${key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  for (let i = 0; i + 3 <= s.length; i++) t.add(s.slice(i, i + 3));
  if (trigramCache.size > 30000) trigramCache.clear();
  trigramCache.set(key, t);
  return t;
}
/** Cosine of the question's and the text's character-trigram sets (0..1): a soft, spelling-level overlap. */
export function trigramOverlap(query, text) {
  const q = trigrams(query), a = trigrams(text);
  if (!q.size || !a.size) return 0;
  let n = 0;
  for (const g of q) if (a.has(g)) n++;
  return n / Math.sqrt(q.size * a.size);
}
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  for (const [k, v] of a) if (b.has(k)) dot += v * b.get(k);
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ------------------------------------------------------------------ extraction + atomization
function stripHtml(html) {
  let s = String(html).replace(/<head[\s\S]*?<\/head>/i, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  // tables become Markdown pipe tables (the way knowDrive keeps table structure in extracted text)
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (t) => {
    const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()));
    if (!rows.length) return '\n';
    const line = (cells) => `| ${cells.join(' | ')} |`;
    return `\n\n${[line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
  });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(p|div|li|ul|ol|section|article|header|footer)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractText(bytes, mime = '', name = '') {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const buf = Buffer.from(bytes);
  if (/^(?:md|markdown|txt|csv|json)$/.test(ext) || /^text\/(?:plain|markdown|csv)|json/.test(mime)) return buf.toString('utf8');
  if (/^html?$/.test(ext) || /html/.test(mime)) return stripHtml(buf.toString('utf8'));
  // binary formats: keep printable runs (a real PDF text layer is far richer; tests only need markers)
  const runs = buf.toString('latin1').match(/[\x20-\x7e]{24,}/g) || [];
  return runs.filter((r) => /[a-z]{3,}\s+[a-z]{3,}/i.test(r) && !/^%PDF|obj|endobj|stream|xref/.test(r)).join('\n\n');
}

/** Paragraph atoms with a heading breadcrumb; a pipe table is one atom (its header travels with its rows). */
export function atomize(text) {
  const atoms = [];
  const crumbs = [];
  const re = /\n\s*\n/g;
  let last = 0;
  const blocks = [];
  const src = String(text || '');
  for (let m; (m = re.exec(src));) { blocks.push([last, m.index]); last = m.index + m[0].length; }
  blocks.push([last, src.length]);
  for (const [s, e] of blocks) {
    const raw = src.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) continue;
    const h = /^(#{1,6})\s+(.+)$/.exec(t);
    if (h && !t.includes('\n')) { crumbs.length = h[1].length - 1; crumbs[h[1].length - 1] = h[2].trim(); continue; }
    const kind = /^\s*\|.*\|\s*$/m.test(t) && t.split('\n').every((l) => /^\s*\|/.test(l)) ? 'table' : /^\s*[-*]\s/.test(t) ? 'list' : 'paragraph';
    const breadcrumb = crumbs.filter(Boolean).join(' > ');
    // fixer r7: like the real chunker, a block is never one giant atom: anything over MAX_ATOM chars is cut at line or
    // sentence boundaries (a single 5 MB paragraph becomes thousands of ~1,200-character atoms, offsets exact)
    for (const [o, len] of splitBlock(t)) atoms.push({ seq: atoms.length, text: t.slice(o, o + len), offset: s + lead + o, len, kind, breadcrumb });
  }
  return atoms;
}
export const MAX_ATOM = 1200;

/**
 * The production Markdown chunker, as observed on knowDrive build 0.80.28 (atoms 150-500 tokens, self_describing):
 *   - every atom's text starts with its heading path ("H1 > H2 > H3"), the H1 always first; paths deeper than 3 keep
 *     only the first and last heading ("H1 > … > H4");
 *   - an atom that starts at a heading has its PARENT path as breadcrumb, and the heading text (no #) as its first
 *     body line; the H1 atom has no breadcrumb at all and simply begins with the H1 line;
 *   - the H1 atom swallows its intro and the whole first H2 section when they are small together;
 *   - a section over ~500 tokens is cut into fragments with ~100 tokens of overlap; continuation fragments carry the
 *     section's own path but repeat nothing else (only the first fragment has the section's "Source:" line);
 *   - small sibling sections are never packed together; an atom edge can still fall across the next heading line.
 * Tokens are approximated as characters / 4. → [{ seq, text, offset, len, kind, breadcrumb }]
 */
export function atomizeProduction(text, { maxTokens = 500, overlapTokens = 100 } = {}) {
  const src = String(text || '');
  const maxChars = maxTokens * 4, overlapChars = overlapTokens * 4;
  const secs = [];
  let cur = { level: 0, heading: null, path: [], start: 0, body: [] };
  const stack = [];
  let off = 0, fence = false;
  const open = (level, heading, start) => {
    secs.push(cur);
    stack.length = level - 1; stack[level - 1] = heading;
    cur = { level, heading, path: stack.filter(Boolean).slice(), start, body: [] };
  };
  let prevStart = 0;
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    // CommonMark setext headings (like production's parser): a text line underlined by === (H1) or --- (H2)
    const last = cur.body.length ? cur.body[cur.body.length - 1] : null;
    const setext = !fence && !h && last != null && last.trim() && !/^\s*(?:[-*+]\s|>|\d+[.)]\s)/.test(last) && /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (h) open(h[1].length, h[2], off);
    else if (setext) { cur.body.pop(); open(setext[1][0] === '=' ? 1 : 2, last.trim(), prevStart); }
    else cur.body.push(line);
    prevStart = off;
    off += line.length + 1;
  }
  secs.push(cur);
  const crumbOf = (path) => (path.length > 3 ? [path[0], '…', path[path.length - 1]] : path).join(' > ');
  const bodyOf = (sec) => `${sec.heading ? `${sec.heading}\n` : ''}${sec.body.join('\n').trim()}`.trim();
  const split = (body) => {
    if (body.length <= maxChars) return [body];
    const out = [];
    for (let i = 0; i < body.length;) {
      let end = Math.min(body.length, i + maxChars);
      if (end < body.length) { const win = body.slice(i, end); const nl = win.lastIndexOf('\n'), sp = win.lastIndexOf(' '); end = i + (nl > maxChars * 0.5 ? nl : sp > maxChars * 0.5 ? sp : win.length); }
      out.push(body.slice(i, end).trim());
      if (end >= body.length) break;
      let next = Math.max(i + 1, end - overlapChars);
      const s2 = body.indexOf(' ', next);
      if (s2 > 0 && s2 < end) next = s2 + 1;
      i = next;
    }
    return out.filter(Boolean);
  };
  const atoms = [];
  const list = secs.filter((sc) => sc.heading || sc.body.join('').trim());
  for (let i = 0; i < list.length; i++) {
    const sec = list[i];
    let body = bodyOf(sec);
    // the H1 atom swallows a small intro + first H2 (production seq 0: H1, intro and the whole first H2)
    if (sec.level === 1 && list[i + 1]?.level === 2 && (body.length + bodyOf(list[i + 1]).length) <= maxChars) { body = `${body}\n${bodyOf(list[i + 1])}`; i++; }
    const pieces = split(body);
    const next = list[i + 1];
    pieces.forEach((piece, j) => {
      const crumb = j === 0 ? crumbOf(sec.heading ? sec.path.slice(0, -1) : sec.path) : crumbOf(sec.path);
      let t = piece;
      // an atom edge can fall across the next heading line (production help seq 7)
      if (j === pieces.length - 1 && next?.heading && atoms.length % 3 === 1) t = `${t}\n${next.heading}`;
      const textOut = crumb ? `${crumb}\n${t}` : t;
      atoms.push({ seq: atoms.length, text: textOut, offset: sec.start, len: piece.length, kind: j === 0 && sec.heading ? 'atx_heading' : 'paragraph', breadcrumb: crumb });
    });
  }
  return atoms;
}
/** [offset, len] pieces of a block, each at most MAX_ATOM chars, cut after a newline or a sentence end when possible. */
function splitBlock(t) {
  if (t.length <= MAX_ATOM) return [[0, t.length]];
  const out = [];
  let i = 0;
  while (i < t.length) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (i >= t.length) break;
    let end = Math.min(t.length, i + MAX_ATOM);
    if (end < t.length) {
      const win = t.slice(i, end);
      const nl = win.lastIndexOf('\n');
      let cut = nl > MAX_ATOM * 0.4 ? nl : -1;
      if (cut < 0) { const re = /[.!?]["”')\]]?\s+(?=[A-Z0-9"“(])/g; for (let m; (m = re.exec(win));) if (m.index > MAX_ATOM * 0.3) cut = m.index + m[0].trimEnd().length; }
      if (cut < 0) { const sp = win.lastIndexOf(' '); cut = sp > MAX_ATOM * 0.5 ? sp : win.length; }
      end = i + cut;
    }
    const piece = t.slice(i, end).replace(/\s+$/, '');
    if (piece) out.push([i, piece.length]);
    i = end;
  }
  return out;
}

const FIXTURE_UGM = Object.freeze({
  file_id: 'file_prod_ugm_shipping', filename: 'knowbot/ugm/policies/shipping.md',
  text: 'Production fixture: The Ultimate Game Master ships worldwide. This hit belongs to another store and must never be shown.',
  tags: ['knowbot', 'knowbot:ugm'],
});

// ------------------------------------------------------------------ server
/**
 * @param {{ speed?: number, fixtures?: Array<{path, text, tags, store?}>, latencyMs?: number, chunker?: 'blocks'|'production' }} [o]
 * @returns {Promise<{ url: string, port: number, calls: object[], files: Map, close: () => Promise<void>, failNext: object, settle: () => Promise<void> }>}
 */
export async function startFakeKnowDrive({ speed = 1, fixtures = [], latencyMs = 0, host = '127.0.0.1', queueStaggerMs = 0, honorScope = false, narrowRows = 3, narrowScope = 'all', chunker = 'blocks', progressOverride } = {}) {
  speed = Math.max(0.01, Number(speed) || 1);
  const files = new Map();
  const calls = [];
  const timers = new Set();
  const failNext = { search: 0, ingest: 0, list: 0 };
  let seq = 0;
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, Math.max(0, ms / speed)); timers.add(t); };

  const nowSec = () => Math.floor(Date.now() / 1000);
  function add({ store = 'vs_fake', path, text, tags = [], bytes, mime = 'text/plain', pipeline = false, hash = null }) {
    // same path in the same store replaces the file (how the registry and spec docs are rewritten)
    for (const f of files.values()) if (f.store === store && f.filename === path) { for (const t of f.timers || []) clearTimeout(t); files.delete(f.id); }
    const id = `file_${(++seq).toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
    // chunker 'production' (opt-in): Markdown files are cut like production knowDrive (heading-path prefixed atoms)
    const atoms = chunker === 'production' && /\.(?:md|markdown)$/i.test(String(path || '')) ? atomizeProduction(text) : atomize(text);
    const created = nowSec();
    // production dedup: a byte-identical copy of a live file is stored, but never searchable under its own tags
    const dupOf = hash ? [...files.values()].find((x) => x.store === store && x.hash === hash)?.id ?? null : null;
    const f = { id, store, hash, dupOf, filename: path, tags: [...new Set(tags)], bytes: bytes ?? Buffer.byteLength(String(text || '')), mime_type: mime, text: String(text || ''),
      status: 'in_progress', phase: 'pending', atom_count: 0, atoms_vectorized: 0, chunk_count: 0, created_at: created, updated_at: created, last_error: null, atoms };
    files.set(id, f);
    const touch = () => { f.updated_at = nowSec(); };
    if (!pipeline) {
      Object.assign(f, { status: 'processed', phase: 'completed', atom_count: atoms.length, atoms_vectorized: atoms.length, chunk_count: Math.max(1, Math.ceil(atoms.length / 3)) });
      return f;
    }
    const failNoText = f.text.includes('FAIL_NO_TEXT') || (!atoms.length && !/json/.test(mime));
    // knowDrive works through a queue: a file that arrives while others are extracting starts a little later
    const queued = [...files.values()].filter((x) => x !== f && x.store === store && x.phase === 'pending' && x.status === 'in_progress').length;
    // fixer r4: two lanes, like the real pipeline's parallel workers. Files arriving together run in pairs (the second
    // 400 ms behind the first), so two files atomize and vectorize at once; the next pair starts while the first pair
    // vectorizes. queueStaggerMs (dev server only) adds real-time spacing per pair (not divided by speed), so the
    // partial-readiness state stays visible at FAKE_SPEED=4.
    const q = Math.min(queued, 6);
    const pairGap = 1400 + Math.max(0, Number(queueStaggerMs) || 0) * speed;
    // fixer r7: stage times grow with the file like the real pipeline (extraction with bytes, chunking and vectorizing
    // with atoms), so a 5 MB file takes ~25 s at speed 1 rather than 4 s; small files keep the documented timings
    const mb = (f.bytes || 0) / 1048576;
    const tExtract = 600 + Math.round(1500 * mb), tChunk = 600 + Math.round(800 * mb), tAtoms = 400 + Math.round(atoms.length * 0.2);
    const vSteps = Math.max(4, Math.min(12, Math.ceil(atoms.length / 400)));
    const tVec = Math.max(400, Math.round((1600 + atoms.length * 2.5) / vSteps));
    later(tExtract + Math.floor(q / 2) * pairGap + (q % 2) * 400, () => {
      if (!files.has(id)) return;
      if (failNoText) { Object.assign(f, { status: 'error', phase: 'error', last_error: 'no text layer found' }); touch(); return; }
      f.phase = 'text_extracted'; touch();
      if (f.text.includes('STALL')) return;
      later(tChunk, () => {
        if (!files.has(id)) return;
        Object.assign(f, { phase: 'chunked', chunk_count: Math.max(1, Math.ceil(atoms.length / 3)), atom_count: 0 }); touch();
        later(tAtoms, () => {
          if (!files.has(id)) return;
          f.atom_count = atoms.length; touch();
          const step = (i) => later(tVec, () => {
            if (!files.has(id)) return;
            f.atoms_vectorized = Math.min(atoms.length, Math.ceil((atoms.length * i) / vSteps)); touch();
            if (i < vSteps) step(i + 1);
            else later(200, () => { if (files.has(id)) { Object.assign(f, { phase: 'completed', status: 'processed' }); touch(); } });
          });
          step(1);
        });
      });
    });
    return f;
  }

  for (const fx of fixtures) add({ ...fx, pipeline: fx.pipeline ?? false });

  const row = (f) => ({ id: f.id, object: 'vector_store.file', filename: f.filename, bytes: f.bytes, mime_type: f.mime_type, status: f.status, phase: f.phase,
    atom_count: f.atom_count, atoms_vectorized: f.atoms_vectorized, chunk_count: f.chunk_count, tags: [...f.tags], created_at: f.created_at, updated_at: f.updated_at,
    ...(f.last_error ? { last_error: f.last_error } : {}) });

  function hitsFor(query, store, mode, k, filter) {
    const q = bag(query);
    const scored = [];
    // Filters are otherwise ignored on purpose (client-side tag enforcement is under test), but a trial: tag in
    // all_of scopes the ranking like real knowDrive does, so many trials on one dev server don't crowd each other
    // out of the top-k (identical sample atoms in other trials would otherwise fill it).
    const trialTag = (Array.isArray(filter?.all_of) ? filter.all_of : []).find((t) => typeof t === 'string' && t.startsWith('trial:'));
    // honorScope (dev server only): none_of tfile:<k> is applied like real knowDrive, so a switched-off file leaves room
    // for the other files' candidates. Tests keep it off so the server's own client-side scope check is exercised.
    const scopeOff = honorScope ? new Set((Array.isArray(filter?.none_of) ? filter.none_of : []).filter((t) => typeof t === 'string' && t.startsWith('tfile:'))) : null;
    const pool = [];
    // production: a pure vector search under a narrow tag filter can come back empty (approximate index), hybrid can't
    const allOf = (Array.isArray(filter?.all_of) ? filter.all_of : []).filter((t) => typeof t === 'string');
    // narrowScope 'all' (default): every all_of filter; 'trial': Studio trial scopes only (trial:, sample-set:, bucket:);
    // 'none': off. Every vector caller (trials retrieve, retrievers.mjs, devapi trialSearch/liveSimilarities, questions)
    // retries an empty vector search as hybrid and scores it by each hit's `distance`, never by its RRF score.
    const narrowTag = (t) => narrowScope === 'all' || (narrowScope === 'trial' && /^(?:trial|sample-set|bucket):/.test(t));
    if (mode === 'vector' && allOf.some(narrowTag) && narrowRows > 0) {
      const matching = [...files.values()].filter((f) => f.store === store && allOf.every((t) => f.tags.includes(t))).length;
      if (matching < narrowRows) return [];
    }
    for (const f of files.values()) {
      if (f.store !== store) continue;
      if (f.dupOf && files.has(f.dupOf)) continue; // byte-identical re-upload: not searchable under the new tags
      if (trialTag && !f.tags.includes(trialTag)) continue;
      if (scopeOff?.size && f.tags.some((t) => scopeOff.has(t))) continue;
      const live = f.phase === 'completed' ? f.atoms.length : Math.min(f.atoms_vectorized, f.atoms.length);
      for (const a of f.atoms.slice(0, live)) {
        a.bag ||= bag(`${a.breadcrumb.split(' > ').pop()} ${a.text}`); // the nearest heading travels with its atom
        pool.push({ f, a });
      }
    }
    const idf = idfOf(pool.map((x) => x.a.bag));
    for (const { f, a } of pool) {
      const { sim, cos } = similarity(q, a.bag, idf);
      // fixer r2: unrelated text spreads out like a real embedding (0.41–0.62) instead of a flat 0.55–0.58 wall:
      // character-trigram overlap with the question (shared word stems, spelling) plus a per-atom hash jitter.
      // Atoms sharing a concept word keep their 0.55+ score; everything stays well under the 0.64 close-miss band.
      // fixer r7: the jitter and trigram terms are only computed for the atoms that need them (large files stay fast)
      const hj = () => parseInt(createHash('sha1').update(`${query}|${f.id}|${a.seq}`).digest('hex').slice(0, 6), 16) / 0xffffff;
      // fixer r4: weak matches (a shared everyday word: "today", "files") no longer pile up at 0.58–0.62 either. Below
      // 0.63 the score gets a deterministic per-atom term (trigram overlap + hash), so refusal charts show a real spread.
      // A shared-word match keeps the documented 0.55 floor; it spreads within 0.55–0.625 (under the 0.64 close-miss band).
      let s = sim;
      if (!(cos > 0)) s = 0.41 + Math.min(0.21, 0.3 * trigramOverlap(query, a.text) + 0.16 * hj() ** 4);
      else if (s < 0.63) s = Math.max(0.55, Math.min(0.625, s - 0.08 + 0.05 * trigramOverlap(query, a.text) + 0.13 * hj() ** 4));
      scored.push({ f, a, sim: Math.min(0.95, s), cos });
    }
    scored.sort((x, y) => y.sim - x.sim || x.f.id.localeCompare(y.f.id) || x.a.seq - y.a.seq);
    // fixer r4: below the close-miss band a real embedding's top-k falls off steadily rather than sitting on one value;
    // each further weak candidate drops a little more (order is kept, floors are kept), so refusal charts slope.
    let weak = 0;
    for (const x of scored) if (x.sim < 0.63) x.sim = Math.max(x.cos > 0 ? 0.55 : 0.41, x.sim - 0.006 * weak++);
    let list = scored;
    if (mode === 'fts') list = scored.filter((x) => x.cos > 0);
    // none_of tags other than tfile: (questions, kind:config, kind:trial-spec …) are applied like real knowDrive, so
    // logged questions — which repeat the question verbatim — never crowd real atoms out of the top-k. The single best
    // excluded hit still leaks through (like the production fixture), so client-side tag enforcement stays under test.
    const noneOf = (Array.isArray(filter?.none_of) ? filter.none_of : []).filter((t) => typeof t === 'string' && !t.startsWith('tfile:'));
    if (noneOf.length) {
      const out = (x) => x.f.tags.some((t) => noneOf.includes(t));
      const leak = list.find(out);
      list = [...(leak ? [leak] : []), ...list.filter((x) => !out(x))];
    }
    const fixture = { f: { id: FIXTURE_UGM.file_id, filename: FIXTURE_UGM.filename, tags: FIXTURE_UGM.tags }, a: { seq: 3, text: FIXTURE_UGM.text, offset: 120, len: FIXTURE_UGM.text.length, kind: 'paragraph', breadcrumb: 'Shipping' }, sim: 0.93 };
    list = [fixture, ...list].slice(0, k);
    return list.map((x, i) => {
      const words = (x.a.text.match(/\S+/g) || []).length;
      const base = { file_id: x.f.id, filename: x.f.filename, tags: [...x.f.tags],
        attributes: { type: 'chunk', node_kind: x.a.kind, source_offset: x.a.offset, table_id: x.a.kind === 'table' ? `t_${x.f.id}_${x.a.seq}` : null,
          ...(x.a.breadcrumb ? { breadcrumb: x.a.breadcrumb, parent_path: x.a.breadcrumb.split(' > ') } : {}),
          provenance: { logical: { kind: 'offset', offset: x.a.offset, len: x.a.len } }, text_tokens: Math.ceil(words * 1.3) },
        content: [{ type: 'text', text: x.a.text }] };
      if (mode === 'vector') return { ...base, score: round(x.sim), distance: round(2 * (1 - x.sim)) };
      if (mode === 'fts') return { ...base, score: round(x.cos), fts_score: round(x.cos) };
      // hybrid: RRF score (never a similarity) plus the hit's vector distance, like production
      return { ...base, score: round(1 / (60 + i + 1)), fts_score: round(x.cos ?? 0), distance: round(2 * (1 - x.sim)) };
    });
  }

  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const call = { method: req.method, url: p, search: url.search, auth: req.headers.authorization || null, store: req.headers['x-vector-store-id'] || null, at: Date.now() };
      calls.push(call);
      const json = (status, b) => { if (res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      const err = (status, message) => json(status, { error: { message, type: 'invalid_request_error' } });
      try {
        if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
        if (!/^Bearer \S+/.test(call.auth || '')) return err(401, 'missing api key');

        if (p === '/api/v1/ingest' && req.method === 'POST') {
          if (failNext.ingest > 0) { failNext.ingest--; return err(500, 'ingest failed (injected)'); }
          if (!call.store) return err(400, 'x-vector-store-id header required');
          const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body }).formData();
          // production batch semantics, in part order: tags, mime_type, then file parts
          let tags = [], mime = null, sawFile = false;
          const items = [];
          for (const [name, v] of fd.entries()) {
            const isFile = typeof v !== 'string';
            if (isFile) { sawFile = true; items.push({ path: String(v.name || ''), bytes: Buffer.from(await v.arrayBuffer()), type: v.type }); continue; }
            if (name === 'mime_type') { if (sawFile) return err(400, 'mime_type must come before the file parts'); mime = String(v); continue; }
            if (name === 'tags' && !sawFile && mime == null) { tags = String(v).split(',').map((t) => t.trim()).filter(Boolean); continue; }
            // any other text part is stored as a file of its own (this is how a stray `path` part became a junk file)
            items.push({ path: name, bytes: Buffer.from(String(v), 'utf8'), type: 'text/plain', stray: true });
          }
          if (!items.some((x) => !x.stray)) return err(400, 'file is required');
          const out = [];
          for (const it of items) {
            const m0 = it.stray ? 'text/plain' : String(mime || it.type || 'application/octet-stream');
            const cfg = tags.includes('kind:trial-spec') || tags.includes('kind:config');
            const hash = createHash('sha256').update(it.bytes).digest('hex');
            const f = add({ store: call.store, path: it.path, text: extractText(it.bytes, m0, it.path), tags, bytes: it.bytes.length, mime: m0, pipeline: !cfg, hash: cfg ? null : hash });
            if (cfg) f.raw = it.bytes.toString('utf8');
            if (!it.stray && !call.ingest) call.ingest = { path: it.path, tags, mime: m0, bytes: it.bytes.length };
            if (it.stray) (call.stray ||= []).push(it.path);
            out.push(row(f));
          }
          return json(200, { object: 'list', files: out });
        }

        let m;
        if ((m = /^\/api\/v1\/vector_stores\/([^/]+)\/search$/.exec(p)) && req.method === 'POST') {
          if (failNext.search > 0) { failNext.search--; return err(500, 'search failed (injected)'); }
          const b = JSON.parse(body.toString('utf8') || '{}');
          call.body = b;
          const mode = b.mode || 'hybrid';
          const data = hitsFor(String(b.query || ''), decodeURIComponent(m[1]), mode, Math.max(1, Math.min(50, Number(b.max_num_results) || 10)), b.filter);
          return json(200, { object: 'vector_store.search_results.page', search_query: b.query, total_count: data.length, has_more: false,
            score_kind: mode === 'vector' ? 'distance' : mode === 'fts' ? 'fts' : 'rrf', data });
        }

        if ((m = /^\/api\/v1\/vector_stores\/([^/]+)\/files$/.exec(p)) && req.method === 'GET') {
          if (failNext.list > 0) { failNext.list--; return err(500, 'list failed (injected)'); }
          const store = decodeURIComponent(m[1]);
          const want = (url.searchParams.get('tags_all') || '').split(',').map((t) => t.trim()).filter(Boolean);
          const prefix = url.searchParams.get('prefix') || '';
          const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100));
          const after = url.searchParams.get('after') || '';
          const all = [...files.values()].filter((f) => f.store === store && f.filename.startsWith(prefix) && want.every((t) => f.tags.includes(t)))
            .sort((a, b) => a.id.localeCompare(b.id));
          const start = after ? all.findIndex((f) => f.id > after) : 0;
          const page = start < 0 ? [] : all.slice(start, start + limit);
          return json(200, { object: 'list', data: page.map(row), has_more: start >= 0 && start + limit < all.length, last_id: page.length ? page[page.length - 1].id : null });
        }

        if ((m = /^\/api\/v1\/vector_stores\/([^/]+)\/tags$/.exec(p)) && req.method === 'GET') {
          const store = decodeURIComponent(m[1]);
          const want = (url.searchParams.get('tags_all') || '').split(',').filter(Boolean);
          const counts = new Map();
          for (const f of files.values()) if (f.store === store && want.every((t) => f.tags.includes(t))) for (const t of f.tags) counts.set(t, (counts.get(t) || 0) + 1);
          return json(200, { object: 'list', data: [...counts].map(([tag, count]) => ({ tag, count })), has_more: false });
        }

        if ((m = /^\/api\/v1\/vector_stores\/([^/]+)\/path\/content\/(.+)$/.exec(p)) && req.method === 'GET') {
          const store = decodeURIComponent(m[1]);
          const path = m[2].split('/').map(decodeURIComponent).join('/');
          const f = [...files.values()].find((x) => x.store === store && x.filename === path);
          if (!f) return err(404, 'not found');
          res.writeHead(200, { 'content-type': f.mime_type || 'application/octet-stream' });
          return res.end(f.raw ?? f.text);
        }

        if (p === '/api/v1/files/batch_tags' && req.method === 'POST') {
          if (!call.store) return err(400, 'x-vector-store-id header required');
          const b = JSON.parse(body.toString('utf8') || '{}');
          call.body = b;
          let updated = 0;
          for (const id of b.file_ids || []) {
            const f = files.get(id);
            if (!f || f.store !== call.store) continue;
            const rm = new Set(b.tags_remove || []);
            f.tags = [...new Set([...f.tags.filter((t) => !rm.has(t)), ...(b.tags_add || [])])];
            updated++;
          }
          return json(200, { updated });
        }

        if ((m = /^\/api\/v1\/files\/([^/]+)\/atoms$/.exec(p)) && req.method === 'GET') {
          const f = files.get(decodeURIComponent(m[1]));
          if (!f) return err(404, 'no such file');
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const visible = f.atom_count ? f.atoms : [];
          return json(200, { object: 'list', total: visible.length, has_more: offset + limit < visible.length,
            data: visible.slice(offset, offset + limit).map((a) => ({ id: `a_${f.id}_${a.seq}`, sequence_index: a.seq, text: a.text,
              metadata: { text_tokens: Math.ceil((a.text.match(/\S+/g) || []).length * 1.3), node_kind: a.kind, source_offset: a.offset, ...(a.breadcrumb ? { breadcrumb: a.breadcrumb } : {}) } })) });
        }

        if ((m = /^\/api\/v1\/files\/([^/]+)$/.exec(p))) {
          const f = files.get(decodeURIComponent(m[1]));
          if (!f) return err(404, 'no such file');
          if (req.method === 'DELETE') { files.delete(f.id); return json(200, { id: f.id, deleted: true }); }
          if (req.method === 'GET') return json(200, row(f));
        }
        // store record with production's #886 `progress` block (the store's drain ETA); `progressOverride` pins it in tests
        if ((m = /^\/api\/v1\/vector_stores\/([^/]+)$/.exec(p)) && req.method === 'GET') {
          const store = decodeURIComponent(m[1]);
          if (progressOverride !== undefined) return json(200, { id: store, object: 'vector_store', progress: progressOverride });
          const live = [...files.values()].filter((f) => f.store === store && f.phase !== 'completed' && f.status !== 'error' && f.raw == null);
          const left = live.reduce((n, f) => n + Math.max(0, (f.atoms?.length || 0) - (f.atoms_vectorized || 0)), 0);
          const eta = Math.ceil(live.length * 3.2 / speed);
          const by = (ph) => live.filter((f) => f.phase === ph).length;
          return json(200, { id: store, object: 'vector_store', progress: {
            state: live.length ? 'draining' : 'drained', contents_remaining: { pending: by('pending'), text_extracted: by('text_extracted'), chunked: by('chunked') },
            atoms_unvectorized: left, atoms_estimated_remaining: left, eta_seconds: eta, eta_low_seconds: Math.floor(eta * 0.7), eta_high_seconds: Math.ceil(eta * 1.5),
            computed_at: Math.floor(Date.now() / 1000) } });
        }
        return err(404, `fake knowDrive: no route ${req.method} ${p}`);
      } catch (e) {
        return err(500, `fake knowDrive error: ${e.message}`);
      }
    });
  });

  await new Promise((r) => srv.listen(0, host, r));
  const port = srv.address().port;
  return {
    url: `http://${host}:${port}`, port, calls, files, failNext,
    /** Pins the store record's `progress` block (undefined = derive it from the files). */
    setProgress(v) { progressOverride = v; },
    /** Adds a delay to every request from now on (slow-store tests). */
    setLatency(ms) { latencyMs = Math.max(0, Number(ms) || 0); },
    /** Adds a file directly (already processed unless pipeline:true). */
    add,
    /** Resolves once every file has reached a terminal phase (or STALL). */
    async settle(timeoutMs = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if ([...files.values()].every((f) => f.phase === 'completed' || f.status === 'error' || (f.text.includes('STALL') && f.phase === 'text_extracted') || f.raw != null)) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('fake knowDrive: files did not settle');
    },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      srv.closeAllConnections?.();
      return new Promise((r) => srv.close(() => r()));
    },
  };
}

function round(x) { return Math.round(x * 10000) / 10000; }

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
//   -(400)-> chunked (atom_count = N) -(4 x 400)-> atoms_vectorized N/4 .. N -> completed.
//   A file containing FAIL_NO_TEXT ends status:'error', last_error:'no text layer found'.
//   A file containing STALL stays text_extracted forever.
// Search deliberately IGNORES `filter` and always adds one production hit tagged knowbot:ugm, so the caller's own
// tag enforcement is what keeps results in scope.
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
  much: 'cost', price: 'cost', pric: 'cost', priced: 'cost', pricing: 'cost', charge: 'cost', pay: 'cost', expensive: 'cost', cheap: 'cost',
  fix: 'repair', mend: 'repair', servic: 'service', servicing: 'service', maintenance: 'service', maintain: 'service', tuneup: 'tune-up',
  guarantee: 'warranty', guaranteed: 'warranty', cover: 'warranty', coverage: 'warranty',
  hour: 'open', opening: 'open', close: 'open', closing: 'open',
  refund: 'return', exchange: 'return', send: 'ship', deliver: 'delivery', shipping: 'ship', shipp: 'ship',
  rental: 'rent', rented: 'rent', hire: 'rent', bicycle: 'bike', ebike: 'e-bike', membership: 'plan', subscription: 'plan', last: 'long', duration: 'long',
  location: 'address', located: 'address',
});
export function bag(text) {
  const m = new Map();
  for (const raw0 of String(text || '').toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9][a-z0-9'-]*/g) || []) {
    const raw = raw0.replace(/-+$/, '').replace(/'s$/, '');
    for (const part of raw.includes('-') && !/^(?:e-bike|tune-up|e-city)s?$/.test(raw) ? raw.split('-') : [raw]) {
      const w0 = part.replace(/'s$/, '').replace(/'/g, '');
      if (!w0 || STOP.has(part) || STOP.has(w0)) continue;
      const st = stemWord(w0);
      const w = CONCEPTS[w0] || CONCEPTS[st] || st;
      m.set(w, (m.get(w) || 0) + 1);
    }
  }
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
    atoms.push({ seq: atoms.length, text: t, offset: s + lead, len: t.length, kind, breadcrumb: crumbs.filter(Boolean).join(' > ') });
  }
  return atoms;
}

const FIXTURE_UGM = Object.freeze({
  file_id: 'file_prod_ugm_shipping', filename: 'knowbot/ugm/policies/shipping.md',
  text: 'Production fixture: The Ultimate Game Master ships worldwide. This hit belongs to another store and must never be shown.',
  tags: ['knowbot', 'knowbot:ugm'],
});

// ------------------------------------------------------------------ server
/**
 * @param {{ speed?: number, fixtures?: Array<{path, text, tags, store?}>, latencyMs?: number }} [o]
 * @returns {Promise<{ url: string, port: number, calls: object[], files: Map, close: () => Promise<void>, failNext: object, settle: () => Promise<void> }>}
 */
export async function startFakeKnowDrive({ speed = 1, fixtures = [], latencyMs = 0, host = '127.0.0.1', queueStaggerMs = 0, honorScope = false } = {}) {
  speed = Math.max(0.01, Number(speed) || 1);
  const files = new Map();
  const calls = [];
  const timers = new Set();
  const failNext = { search: 0, ingest: 0, list: 0 };
  let seq = 0;
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, Math.max(0, ms / speed)); timers.add(t); };

  function add({ store = 'vs_fake', path, text, tags = [], bytes, mime = 'text/plain', pipeline = false }) {
    // same path in the same store replaces the file (how the registry and spec docs are rewritten)
    for (const f of files.values()) if (f.store === store && f.filename === path) { for (const t of f.timers || []) clearTimeout(t); files.delete(f.id); }
    const id = `file_${(++seq).toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
    const atoms = atomize(text);
    const created = new Date().toISOString();
    const f = { id, store, filename: path, tags: [...new Set(tags)], bytes: bytes ?? Buffer.byteLength(String(text || '')), mime_type: mime, text: String(text || ''),
      status: 'in_progress', phase: 'pending', atom_count: 0, atoms_vectorized: 0, chunk_count: 0, created_at: created, updated_at: created, last_error: null, atoms };
    files.set(id, f);
    const touch = () => { f.updated_at = new Date().toISOString(); };
    if (!pipeline) {
      Object.assign(f, { status: 'processed', phase: 'completed', atom_count: atoms.length, atoms_vectorized: atoms.length, chunk_count: Math.max(1, Math.ceil(atoms.length / 3)) });
      return f;
    }
    const failNoText = f.text.includes('FAIL_NO_TEXT') || (!atoms.length && !/json/.test(mime));
    // knowDrive works through a queue: a file that arrives while others are extracting starts a little later
    const queued = [...files.values()].filter((x) => x !== f && x.store === store && x.phase === 'pending' && x.status === 'in_progress').length;
    // queueStaggerMs (dev server only): extra real-time spacing per queued file, not divided by speed, so files that
    // arrive together still finish one poll apart and the partial-readiness state is visible at FAKE_SPEED=4.
    later(600 + Math.min(queued, 6) * 700 + Math.min(queued, 6) * Math.max(0, Number(queueStaggerMs) || 0) * speed, () => {
      if (!files.has(id)) return;
      if (failNoText) { Object.assign(f, { status: 'error', phase: 'error', last_error: 'no text layer found' }); touch(); return; }
      f.phase = 'text_extracted'; touch();
      if (f.text.includes('STALL')) return;
      later(600, () => {
        if (!files.has(id)) return;
        Object.assign(f, { phase: 'chunked', chunk_count: Math.max(1, Math.ceil(atoms.length / 3)), atom_count: 0 }); touch();
        later(400, () => {
          if (!files.has(id)) return;
          f.atom_count = atoms.length; touch();
          const step = (i) => later(400, () => {
            if (!files.has(id)) return;
            f.atoms_vectorized = Math.min(atoms.length, Math.ceil((atoms.length * i) / 4)); touch();
            if (i < 4) step(i + 1);
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
    for (const f of files.values()) {
      if (f.store !== store) continue;
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
      // unrelated text still sits a little above the base, like a real embedding (deterministic, < 0.03)
      const jitter = (parseInt(createHash('sha1').update(`${query}|${f.id}|${a.seq}`).digest('hex').slice(0, 6), 16) / 0xffffff) * 0.03;
      scored.push({ f, a, sim: Math.min(0.95, sim + (cos > 0 ? 0 : jitter)), cos });
    }
    scored.sort((x, y) => y.sim - x.sim || x.f.id.localeCompare(y.f.id) || x.a.seq - y.a.seq);
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
      return { ...base, score: round(1 / (60 + i + 1)), fts_score: round(x.cos ?? 0) }; // hybrid: RRF, no distance
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
          const file = fd.get('file');
          if (!file || typeof file === 'string') return err(400, 'file is required');
          const tags = String(fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
          const mime = String(fd.get('mime_type') || file.type || 'application/octet-stream');
          const bytes = Buffer.from(await file.arrayBuffer());
          const path = String(fd.get('path') || file.name || '');
          call.ingest = { path, tags, mime, bytes: bytes.length };
          const f = add({ store: call.store, path, text: extractText(bytes, mime, path), tags, bytes: bytes.length, mime, pipeline: !tags.includes('kind:trial-spec') && !tags.includes('kind:config') });
          if (tags.includes('kind:trial-spec') || tags.includes('kind:config')) f.raw = bytes.toString('utf8');
          return json(200, { object: 'list', files: [row(f)] });
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

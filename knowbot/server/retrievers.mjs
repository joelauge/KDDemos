// KnowBot retrievers — local BM25 over corpus/ and knowDrive REST search.
// Node 22, no dependencies.
import { promises as fsp, watch as fsWatch, existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- frontmatter

/** Parse a markdown file with optional YAML frontmatter (flat key: value only). */
export function parseFrontmatter(src) {
  const meta = {};
  let body = src.replace(/^﻿/, '');
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (m) {
    body = body.slice(m[0].length);
    let lastKey = null;
    for (const line of m[1].split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (kv) {
        lastKey = kv[1];
        meta[lastKey] = unquote(stripComment(kv[2]));
      } else if (lastKey && /^\s+-\s+/.test(line)) {
        // simple YAML list
        const v = unquote(line.replace(/^\s+-\s+/, '').trim());
        if (!Array.isArray(meta[lastKey])) meta[lastKey] = meta[lastKey] ? [meta[lastKey]] : [];
        meta[lastKey].push(v);
      }
    }
  }
  return { meta, body };
}

function stripComment(v) {
  // strip trailing "  # comment" or "(comment)" only when value is unquoted
  v = v.trim();
  if (/^["']/.test(v)) return v;
  return v.replace(/\s+#.*$/, '').trim();
}

function unquote(v) {
  v = String(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean);
  }
  return v;
}

// ---------------------------------------------------------------- tokenization

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before
being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself
his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of
off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some
such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this
those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where
where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself
yourselves also just will may might must shall get got tell please us yes s t`.split(/\s+/));

/** Light English stemmer (plural / -ing / -ed / -ly). Deterministic and symmetric for index + query. */
export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) { w = w.slice(0, -3); return undouble(w); }
  if (w.endsWith('edly') && w.length > 6) return undouble(w.slice(0, -4));
  if (w.endsWith('ed') && w.length > 4) { w = w.slice(0, -2); return undouble(w); }
  if (w.endsWith('ly') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('es') && /(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
function undouble(w) {
  if (w.length > 3 && /([bdfgmnprt])\1$/.test(w)) return w.slice(0, -1);
  if (w.endsWith('e') && w.length > 4) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  const out = [];
  const norm = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  for (const raw of norm.split(/[^a-z0-9']+/)) {
    const w = raw.replace(/^'+|'+$/g, '').replace(/'s$/, '');
    if (!w || STOPWORDS.has(w)) continue;
    if (w.length === 1 && !/[0-9]/.test(w)) continue;
    const s = stem(w.replace(/'/g, ''));
    // also strip trailing 'e' so "ship"/"shipping"/"shipped" & "return"/"returns" & "store"/"stores" align
    out.push(s.length > 4 && s.endsWith('e') ? s.slice(0, -1) : s);
  }
  return out;
}

// ---------------------------------------------------------------- chunking

const wc = (s) => (s.match(/\S+/g) || []).length;

/** Split body into ~120–350-word chunks on heading / paragraph boundaries. */
export function chunkMarkdown(body, { min = 120, max = 350 } = {}) {
  // sections by heading
  const lines = body.split(/\r?\n/);
  const sections = [];
  let cur = { heading: '', lines: [] };
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      if (cur.lines.join('').trim() || cur.heading) sections.push(cur);
      cur = { heading: line.replace(/^#+\s+/, '').trim(), lines: [line] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim()) sections.push(cur);

  // paragraphs (with heading attached to the following paragraph), splitting oversized ones by sentence
  const paras = [];
  for (const sec of sections) {
    const ps = sec.lines.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let pendingHeading = '';
    for (const p of ps) {
      if (/^#{1,6}\s+[^\n]*$/.test(p)) { pendingHeading += (pendingHeading ? '\n' : '') + p; continue; }
      const full = pendingHeading ? pendingHeading + '\n' + p : p;
      pendingHeading = '';
      if (wc(full) <= max) paras.push({ text: full, heading: sec.heading });
      else {
        const sentences = full.match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) || [full];
        let buf = '';
        for (const s of sentences) {
          if (buf && wc(buf) + wc(s) > max) { paras.push({ text: buf.trim(), heading: sec.heading }); buf = ''; }
          // pathological single "sentence" longer than max: hard split by words
          if (wc(s) > max) {
            const words = s.split(/\s+/);
            for (let i = 0; i < words.length; i += max) paras.push({ text: words.slice(i, i + max).join(' '), heading: sec.heading });
            continue;
          }
          buf += s;
        }
        if (buf.trim()) paras.push({ text: buf.trim(), heading: sec.heading });
      }
    }
    if (pendingHeading) paras.push({ text: pendingHeading, heading: sec.heading });
  }

  // greedy merge to reach min without exceeding max
  const chunks = [];
  let buf = [], words = 0, heading = '';
  for (const p of paras) {
    const n = wc(p.text);
    if (buf.length && words + n > max) { chunks.push({ text: buf.join('\n\n'), heading }); buf = []; words = 0; }
    if (!buf.length) heading = p.heading;
    buf.push(p.text); words += n;
    if (words >= min) { chunks.push({ text: buf.join('\n\n'), heading }); buf = []; words = 0; }
  }
  if (buf.length) {
    const last = chunks[chunks.length - 1];
    if (last && words < min / 2 && wc(last.text) + words <= max + 60) last.text += '\n\n' + buf.join('\n\n');
    else chunks.push({ text: buf.join('\n\n'), heading });
  }
  return chunks.filter((c) => c.text.trim());
}

// ---------------------------------------------------------------- local retriever

function titleFromFilename(filename) {
  const base = path.basename(String(filename || ''), path.extname(String(filename || '')));
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || String(filename || '');
}

async function walkMd(dir, root = dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkMd(p, root, out);
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
}

export class LocalRetriever {
  /**
   * @param {{ corpusDir: string, watch?: boolean, k1?: number, b?: number, titleBoost?: number, maxPerFile?: number, logger?: Function }} opts
   */
  constructor({ corpusDir, watch = true, k1 = 1.2, b = 0.75, titleBoost = 2.0, maxPerFile = 2, logger = () => {} }) {
    this.corpusDir = path.resolve(corpusDir);
    this.k1 = k1; this.b = b; this.titleBoost = titleBoost; this.maxPerFile = maxPerFile;
    this.log = logger;
    this.docs = new Map();   // filename -> { filename, title, url, meta }
    this.chunks = [];        // { filename, title, url, text, tf: Map, len, titleTerms: Set }
    this.df = new Map();
    this.avgLen = 1;
    this.loadedAt = 0;
    this.ready = this.reindex();
    if (watch) this._watch();
  }

  get name() { return 'local'; }
  get fileCount() { return this.docs.size; }
  get chunkCount() { return this.chunks.length; }

  async reindex() {
    const t0 = Date.now();
    const files = await walkMd(this.corpusDir);
    const docs = new Map();
    const chunks = [];
    for (const abs of files.sort()) {
      let src;
      try { src = await fsp.readFile(abs, 'utf8'); } catch { continue; }
      const filename = path.relative(this.corpusDir, abs).split(path.sep).join('/');
      const { meta, body } = parseFrontmatter(src);
      const title = (typeof meta.title === 'string' && meta.title) || firstHeading(body) || titleFromFilename(filename);
      const url = typeof meta.url === 'string' && meta.url ? meta.url : null;
      docs.set(filename, { filename, title, url, meta });
      const titleTerms = new Set(tokenize(title));
      for (const c of chunkMarkdown(body)) {
        const text = `${title}\n\n${c.text}`;
        const terms = tokenize(text);
        const tf = new Map();
        for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
        chunks.push({ filename, title, url, text, tf, len: terms.length, titleTerms });
      }
    }
    const df = new Map();
    for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    this.docs = docs; this.chunks = chunks; this.df = df;
    this.avgLen = chunks.length ? chunks.reduce((a, c) => a + c.len, 0) / chunks.length : 1;
    this.loadedAt = Date.now();
    this.log(`[retriever] indexed ${docs.size} files / ${chunks.length} chunks from ${this.corpusDir} in ${Date.now() - t0}ms`);
    return { files: docs.size, chunks: chunks.length, ms: Date.now() - t0 };
  }

  _watch() {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { this.ready = this.reindex().catch((e) => this.log(`[retriever] reindex failed: ${e.message}`)); }, 400);
      timer.unref?.();
    };
    const tryWatch = () => {
      if (!existsSync(this.corpusDir)) {
        // corpus not created yet: poll until it appears
        const iv = setInterval(() => { if (existsSync(this.corpusDir)) { clearInterval(iv); schedule(); tryWatch(); } }, 2000);
        iv.unref?.();
        return;
      }
      try {
        this.watcher = fsWatch(this.corpusDir, { recursive: true, persistent: false }, schedule);
        this.watcher.on('error', () => {});
      } catch (e) {
        this.log(`[retriever] fs.watch unavailable (${e.message}); use /api/reindex`);
      }
    };
    tryWatch();
  }

  close() { try { this.watcher?.close(); } catch {} }

  idf(t) {
    const n = this.chunks.length, d = this.df.get(t) || 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  }

  /** Lookup frontmatter for a corpus-relative filename. */
  lookup(filename) {
    if (!filename) return null;
    const f = String(filename).replace(/^\/+/, '');
    return this.docs.get(f) || this.docs.get(f.replace(/^corpus\//, '')) || null;
  }

  async search(query, k = 6) {
    await this.ready;
    k = Math.max(1, Math.min(50, Number(k) || 6));
    const qTerms = [...new Set(tokenize(query))];
    if (!qTerms.length || !this.chunks.length) return { source: 'local', results: [] };
    const idf = new Map(qTerms.map((t) => [t, this.idf(t)]));
    const scored = [];
    for (const c of this.chunks) {
      let s = 0, matched = 0;
      for (const t of qTerms) {
        const f = c.tf.get(t);
        if (f) {
          matched++;
          s += idf.get(t) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * c.len / this.avgLen));
        }
        if (c.titleTerms.has(t)) s += idf.get(t) * this.titleBoost;
      }
      if (s > 0 && matched) scored.push({ c, s: s * (0.6 + 0.4 * matched / qTerms.length) });
    }
    scored.sort((a, b) => b.s - a.s);
    const perFile = new Map();
    const results = [];
    for (const { c, s } of scored) {
      const n = perFile.get(c.filename) || 0;
      if (n >= this.maxPerFile) continue;
      perFile.set(c.filename, n + 1);
      results.push({
        file_id: `local:${c.filename}`,
        filename: c.filename,
        title: c.title,
        url: c.url,
        score: Math.round((s / (s + 8)) * 10000) / 10000, // squash BM25 into (0,1) so it is comparable to knowDrive scores
        bm25: Math.round(s * 1000) / 1000,
        text: c.text,
      });
      if (results.length >= k) break;
    }
    return { source: 'local', results };
  }
}

function firstHeading(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------- knowDrive retriever

export class KnowDriveRetriever {
  /**
   * @param {{ baseUrl: string, apiKey: string, store: string, local: LocalRetriever, timeoutMs?: number, logger?: Function }} opts
   */
  constructor({ baseUrl, apiKey, store, tag = 'knowbot:ugm', prefix = '', local, timeoutMs = 8000, logger = () => {} }) {
    this.baseUrl = String(baseUrl || 'https://dev.knowdrive.ai').replace(/\/+$/, '');
    this.apiKey = apiKey; this.store = store; this.local = local; this.timeoutMs = timeoutMs; this.log = logger;
    this.tag = tag;
    this.prefix = String(prefix || '').replace(/^\/+/, '');
  }

  get name() { return 'knowdrive'; }

  async search(query, k = 6) {
    k = Math.max(1, Math.min(50, Number(k) || 6));
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/vector_stores/${encodeURIComponent(this.store)}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ query, max_num_results: k, mode: 'hybrid', text: 'raw', ...(this.tag ? { filter: { all_of: [this.tag] } } : {}) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`knowDrive HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      const data = Array.isArray(json?.data) ? json.data : [];
      await this.local?.ready; // title/url lookups need the local frontmatter index
      // defense in depth: when a prefix is configured, only hits under it (tag window is the primary guard)
      const results = data.map((d) => this.mapResult(d)).filter((r) => r && r.text);
      results.sort((a, b) => b.score - a.score);
      return { source: 'knowdrive', results };
    } catch (e) {
      this.log(`[retriever] knowDrive search failed (${e.name === 'TimeoutError' ? 'timeout' : e.message}); falling back to local`);
      const r = await this.local.search(query, k);
      return { ...r, source: 'local-fallback', error: String(e.message || e) };
    }
  }

  mapResult(d) {
    const attrs = { ...(d.metadata || {}), ...(d.attributes || {}) };
    const full = String(d.filename || attrs.path || attrs.filename || '').replace(/^\/+/, '');
    if (this.prefix && !full.startsWith(this.prefix)) return null;
    const filename = full.slice(this.prefix.length);
    if (!filename) return null;
    const local = this.local?.lookup(filename);
    const text = Array.isArray(d.content)
      ? d.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n')
      : typeof d.content === 'string' ? d.content : (d.text || '');
    const title = pickStr(attrs.title) || local?.title || titleFromFilename(filename);
    const url = pickStr(attrs.url) || local?.url || null;
    return { file_id: d.file_id || d.id || `kd:${filename}`, filename, title, url, score: Number(d.score) || 0, text };
  }
}

function pickStr(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

export const DEFAULT_STORE = 'vs_f66318f0dd0e4540b27663b03ea40f40';
export const DEFAULT_TAG = 'knowbot:ugm';
export const DEFAULT_PREFIX = '';

/** Build the retriever for the given env. */
export function createRetriever({ corpusDir, env = process.env, logger, watch = true } = {}) {
  const local = new LocalRetriever({ corpusDir, logger, watch });
  if (env.KNOWDRIVE_API_KEY) {
    const kd = new KnowDriveRetriever({
      baseUrl: env.KNOWDRIVE_BASE_URL || 'https://dev.knowdrive.ai', apiKey: env.KNOWDRIVE_API_KEY,
      store: env.KNOWDRIVE_STORE || DEFAULT_STORE, tag: env.KNOWDRIVE_TAG ?? DEFAULT_TAG, prefix: env.KNOWDRIVE_PREFIX ?? DEFAULT_PREFIX, local, logger,
    });
    return { mode: 'knowdrive', retriever: kd, local };
  }
  return { mode: 'local', retriever: local, local };
}

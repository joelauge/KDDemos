// KnowBot bots and buckets.
// A BUCKET is one knowDrive folder of files. A BOT (chat instance) links to any number of buckets, each link on or
// off, and answers only from its enabled buckets: nothing outside those folders can be searched or cited.
// The registry lives in the knowDrive store itself (knowbot/_config/instances.json) so it survives container
// restarts; without a knowDrive key it falls back to a JSON file in the data dir (local development).
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { KnowDriveRetriever } from './retrievers.mjs';

export const REGISTRY_PATH = 'knowbot/_config/instances.json';
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // Cloudflare Workers accept request bodies up to 100 MB
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['_config', 'api', 'new']);

export class InstanceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** A folder is a store path prefix: relative, no dot segments, ending in '/'. */
export function normalizeFolder(folder) {
  const segs = String(folder || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) throw new InstanceError(400, 'folder is required (a store folder such as knowbot/acme/)');
  if (segs.some((s) => s === '.' || s === '..' || /[\0-\x1f]/.test(s))) throw new InstanceError(400, 'folder may not contain . or .. segments');
  if (segs[0] === 'knowbot' && segs[1] === '_config') throw new InstanceError(400, 'knowbot/_config/ is reserved');
  return `${segs.join('/')}/`;
}

/** An uploaded file's path inside its bucket folder (sub-folders kept, traversal removed). */
export function safeRelPath(name) {
  const segs = String(name || '').replace(/\\/g, '/').split('/')
    .map((s) => s.replace(/[\0-\x1f]/g, '').trim()).filter((s) => s && s !== '.' && s !== '..');
  if (!segs.length) throw new InstanceError(400, 'file name is required');
  const rel = segs.join('/');
  if (rel.length > 400) throw new InstanceError(400, 'file name too long');
  return rel;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const BOT_KEYS = ['id', 'name', 'org', 'botName', 'greeting', 'starters', 'guards', 'minSimilarity', 'buckets', 'builtin', 'createdAt', 'updatedAt'];
const BUCKET_KEYS = ['id', 'name', 'folder', 'builtin', 'createdAt', 'updatedAt'];
const now = () => new Date().toISOString();

function cleanName(v) {
  const name = String(v ?? '').trim();
  if (!name || name.length > 80) throw new InstanceError(400, 'name is required (max 80 characters)');
  return name;
}

function newId(body, name, taken) {
  const id = slugify(body.id || name);
  if (!ID_RE.test(id) || RESERVED.has(id)) throw new InstanceError(400, 'id must be 1-40 lowercase letters, digits or dashes');
  if (taken(id)) throw new InstanceError(409, `"${id}" already exists`);
  return id;
}

function cleanBot(body, { partial = false } = {}) {
  const out = {};
  if (body.name !== undefined || !partial) out.name = cleanName(body.name);
  for (const k of ['org', 'botName', 'greeting']) {
    if (body[k] === undefined) continue;
    const v = String(body[k] ?? '').trim();
    if (v.length > (k === 'greeting' ? 300 : 80)) throw new InstanceError(400, `${k} too long`);
    out[k] = v || undefined;
  }
  if (body.starters !== undefined) {
    if (!Array.isArray(body.starters)) throw new InstanceError(400, 'starters must be an array of strings');
    out.starters = body.starters.map((s) => String(s).trim()).filter(Boolean).slice(0, 6).map((s) => s.slice(0, 120));
  }
  if (body.guards !== undefined) {
    if (!['general', 'store'].includes(body.guards)) throw new InstanceError(400, 'guards must be "general" or "store"');
    out.guards = body.guards;
  }
  if (body.minSimilarity !== undefined) {
    if (body.minSimilarity === null || body.minSimilarity === '') out.minSimilarity = undefined;
    else {
      const v = Number(body.minSimilarity);
      if (!(v >= 0 && v < 1)) throw new InstanceError(400, 'minSimilarity must be between 0 and 1');
      out.minSimilarity = v;
    }
  }
  return out;
}

/** Bot results from several buckets: each bucket searched on its own (its folder is its world), then merged. */
class LinkedRetriever {
  constructor(parts) { this.parts = parts; }
  get name() { return 'knowdrive'; }
  async search(query, k = 6) {
    if (!this.parts.length) return { source: 'none', results: [], floor: { top: 0, min: null, buckets: [] } };
    if (this.parts.length === 1) {
      const r = await this.parts[0].retriever.search(query, k);
      return { ...r, results: r.results.map((x) => ({ ...x, bucket: this.parts[0].bucket })) };
    }
    const all = await Promise.all(this.parts.map(async ({ bucket, retriever }) => ({ bucket, r: await retriever.search(query, k) })));
    const results = [];
    // Interleave by rank so no single bucket crowds the others out; answer cards keep their lead.
    for (let i = 0; i < k; i++) for (const { bucket, r } of all) if (r.results[i]) results.push({ ...r.results[i], bucket });
    results.sort((a, b) => Number(String(b.filename).startsWith('canonical/')) - Number(String(a.filename).startsWith('canonical/')));
    const tops = all.map(({ r }) => r.floor?.top).filter((x) => typeof x === 'number');
    return {
      source: all.some(({ r }) => r.source === 'knowdrive') ? 'knowdrive' : all[0].r.source,
      results: results.slice(0, k),
      floor: { top: tops.length ? Math.max(...tops) : null, buckets: all.map(({ bucket, r }) => ({ bucket, top: r.floor?.top ?? null, count: r.results.length })) },
    };
  }
}

export class InstanceRegistry {
  /**
   * @param {{ kd?: { baseUrl: string, apiKey: string|Function, store: string } | null, dataDir: string,
   *           builtin: object, builtinRetriever: object, defaultMinSimilarity: number, logger?: Function }} o
   */
  constructor({ kd = null, dataDir, builtin, builtinRetriever, defaultMinSimilarity = 0.7, logger = () => {} }) {
    this.kd = kd; this.dataDir = dataDir; this.log = logger;
    // The built-in bot and bucket come from the server config. Only the bot's bucket links can be changed.
    this.builtinBucket = { id: builtin.id, name: builtin.name, folder: builtin.folder, builtin: true };
    this.builtinBotBase = { id: builtin.id, name: builtin.name, org: builtin.org, guards: builtin.guards || 'store', builtin: true };
    this.builtinLinks = [{ id: builtin.id, enabled: true }];
    this.builtinRetriever = builtinRetriever;
    this.defaultMinSimilarity = defaultMinSimilarity;
    this.bots = new Map();
    this.buckets = new Map();
    this.retrievers = new Map();
    this.writeChain = Promise.resolve();
    this.ready = this.load().catch((e) => this.log(`[instances] registry load failed: ${e.message}`));
  }

  get canWrite() { return !!this.kd; }
  key() { return typeof this.kd.apiKey === 'function' ? this.kd.apiKey() : this.kd.apiKey; }

  kdFetch(p, init = {}) {
    return fetch(`${this.kd.baseUrl}${p}`, {
      ...init, headers: { authorization: `Bearer ${this.key()}`, ...(init.headers || {}) }, signal: init.signal || AbortSignal.timeout(init.timeout || 30000),
    });
  }

  async load() {
    let raw = null;
    if (this.kd) {
      const res = await this.kdFetch(`/api/v1/vector_stores/${encodeURIComponent(this.kd.store)}/path/content/${REGISTRY_PATH.split('/').map(encodeURIComponent).join('/')}`);
      if (res.ok) raw = await res.text();
      else if (res.status !== 404) throw new Error(`knowDrive HTTP ${res.status}`);
    } else {
      try { raw = await fsp.readFile(path.join(this.dataDir, 'instances.json'), 'utf8'); } catch { /* none yet */ }
    }
    const doc = raw ? JSON.parse(raw) : {};
    let buckets = doc.buckets || [], bots = doc.bots || [];
    if (!doc.bots && Array.isArray(doc.instances)) {
      // v1 registry: one folder per instance → one bucket per instance, linked to a bot of the same id.
      buckets = doc.instances.map((x) => ({ id: x.id, name: x.name, folder: x.folder, createdAt: x.createdAt, updatedAt: x.updatedAt }));
      bots = doc.instances.map(({ folder, ...x }) => ({ ...x, buckets: [{ id: x.id, enabled: true }] }));
    }
    const builtinId = this.builtinBucket.id;
    this.buckets = new Map(buckets.filter((x) => x && ID_RE.test(x.id) && x.id !== builtinId).map((x) => [x.id, x]));
    this.bots = new Map(bots.filter((x) => x && ID_RE.test(x.id) && x.id !== builtinId).map((x) => [x.id, { ...x, buckets: this.cleanLinks(x.buckets, { strict: false }) }]));
    if (Array.isArray(doc.builtinBot?.buckets)) this.builtinLinks = this.cleanLinks(doc.builtinBot.buckets, { strict: false });
    this.log(`[instances] ${this.bots.size} bot(s), ${this.buckets.size} bucket(s) loaded`);
  }

  async save() {
    const doc = JSON.stringify({ v: 2, buckets: [...this.buckets.values()], bots: [...this.bots.values()], builtinBot: { buckets: this.builtinLinks } }, null, 2);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      if (!this.kd) {
        await fsp.mkdir(this.dataDir, { recursive: true });
        await fsp.writeFile(path.join(this.dataDir, 'instances.json'), doc);
        return;
      }
      const fd = new FormData();
      fd.append('tags', 'knowbot,kind:config');
      fd.append('mime_type', 'application/json');
      fd.append('file', new Blob([doc], { type: 'application/json' }), REGISTRY_PATH);
      const res = await this.kdFetch('/api/v1/ingest', { method: 'POST', headers: { 'x-vector-store-id': this.kd.store }, body: fd });
      if (!res.ok) throw new InstanceError(502, `saving the registry failed: knowDrive HTTP ${res.status}`);
    });
    return this.writeChain;
  }

  /** Apply a change and persist it; on a failed save the previous state comes back. */
  async commit(change) {
    const snap = { bots: new Map(this.bots), buckets: new Map(this.buckets), builtinLinks: this.builtinLinks };
    const out = change();
    try { await this.save(); } catch (e) { Object.assign(this, snap); throw e; }
    this.retrievers.clear();
    return out;
  }

  needWrite() { if (!this.canWrite) throw new InstanceError(503, 'managing bots and buckets needs a knowDrive key (KNOWDRIVE_API_KEY)'); }

  cleanLinks(links, { strict = true } = {}) {
    if (links === undefined) return [];
    if (!Array.isArray(links)) throw new InstanceError(400, 'buckets must be an array of {id, enabled}');
    const seen = new Set(), out = [];
    for (const l of links) {
      const id = String(typeof l === 'string' ? l : l?.id || '').toLowerCase();
      if (!id || seen.has(id)) continue;
      if (id !== this.builtinBucket.id && !this.buckets.has(id)) {
        if (strict) throw new InstanceError(400, `no such bucket "${id}"`);
        continue;
      }
      seen.add(id);
      out.push({ id, enabled: typeof l === 'object' && l ? l.enabled !== false : true });
    }
    return out;
  }

  // ---------------------------------------------------------------- reads
  bucketList() { return [this.builtinBucket, ...[...this.buckets.values()].sort((a, b) => a.name.localeCompare(b.name))].map((x) => pick(x, BUCKET_KEYS)); }
  builtinBot() { return { ...this.builtinBotBase, buckets: this.builtinLinks }; }
  list() { return [this.builtinBot(), ...[...this.bots.values()].sort((a, b) => a.name.localeCompare(b.name))].map((x) => pick(x, BOT_KEYS)); }

  get(id) {
    const key = String(id || '').toLowerCase();
    if (!key || key === this.builtinBotBase.id) return this.builtinBot();
    const it = this.bots.get(key);
    if (!it) throw new InstanceError(404, `no such bot "${id}"`);
    return it;
  }

  bucket(id) {
    const key = String(id || '').toLowerCase();
    if (key === this.builtinBucket.id) return this.builtinBucket;
    const b = this.buckets.get(key);
    if (!b) throw new InstanceError(404, `no such bucket "${id}"`);
    return b;
  }

  bucketRetriever(b, minSimilarity) {
    if (b.builtin) return this.builtinRetriever;
    if (!this.kd) throw new InstanceError(503, 'bucket search needs a knowDrive key (KNOWDRIVE_API_KEY)');
    const key = `${b.id}@${b.folder}@${minSimilarity}`;
    if (!this.retrievers.has(key)) {
      this.retrievers.set(key, new KnowDriveRetriever({
        baseUrl: this.kd.baseUrl, apiKey: this.kd.apiKey, store: this.kd.store, tag: '', prefix: b.folder, local: null,
        minSimilarity, exclude: ['kind:config'], cards: false, logger: this.log,
      }));
    }
    return this.retrievers.get(key);
  }

  /** The retriever for a bot: its enabled buckets are the whole world it can search or cite. */
  retriever(id) {
    const bot = this.get(id);
    const floor = bot.minSimilarity ?? this.defaultMinSimilarity;
    const parts = bot.buckets.filter((l) => l.enabled).map((l) => {
      try { const b = this.bucket(l.id); return { bucket: b.id, retriever: this.bucketRetriever(b, floor) }; } catch { return null; }
    }).filter(Boolean);
    return new LinkedRetriever(parts);
  }

  // ---------------------------------------------------------------- bots
  async create(body) {
    this.needWrite();
    const fields = cleanBot(body);
    const id = newId(body, fields.name, (x) => x === this.builtinBotBase.id || this.bots.has(x));
    const t = now();
    const bot = { id, guards: 'general', ...fields, buckets: this.cleanLinks(body.buckets), createdAt: t, updatedAt: t };
    return this.commit(() => { this.bots.set(id, bot); return pick(bot, BOT_KEYS); });
  }

  async update(id, body) {
    this.needWrite();
    const bot = this.get(id);
    if (bot.builtin) {
      if (Object.keys(body).some((k) => k !== 'buckets')) throw new InstanceError(403, 'the built-in bot only lets you change its bucket links');
      const links = this.cleanLinks(body.buckets);
      return this.commit(() => { this.builtinLinks = links; return pick(this.builtinBot(), BOT_KEYS); });
    }
    const next = { ...bot, ...cleanBot(body, { partial: true }), updatedAt: now() };
    if (body.buckets !== undefined) next.buckets = this.cleanLinks(body.buckets);
    return this.commit(() => { this.bots.set(bot.id, next); return pick(next, BOT_KEYS); });
  }

  async remove(id) {
    this.needWrite();
    const bot = this.get(id);
    if (bot.builtin) throw new InstanceError(403, 'the built-in bot cannot be deleted');
    return this.commit(() => { this.bots.delete(bot.id); return bot; });
  }

  // ---------------------------------------------------------------- buckets
  async createBucket(body) {
    this.needWrite();
    const name = cleanName(body.name);
    const id = newId(body, name, (x) => x === this.builtinBucket.id || this.buckets.has(x));
    const folder = normalizeFolder(body.folder || `knowbot/${id}/`);
    const t = now();
    const b = { id, name, folder, createdAt: t, updatedAt: t };
    return this.commit(() => { this.buckets.set(id, b); return pick(b, BUCKET_KEYS); });
  }

  async updateBucket(id, body) {
    this.needWrite();
    const b = this.bucket(id);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket is managed by the corpus sync script');
    if (body.folder !== undefined && normalizeFolder(body.folder) !== b.folder) throw new InstanceError(400, "a bucket's folder can't change; create a new bucket instead");
    const next = { ...b, ...(body.name !== undefined ? { name: cleanName(body.name) } : {}), updatedAt: now() };
    return this.commit(() => { this.buckets.set(b.id, next); return pick(next, BUCKET_KEYS); });
  }

  /** Removes the bucket and every link to it. The files stay in knowDrive. */
  async removeBucket(id) {
    this.needWrite();
    const b = this.bucket(id);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket cannot be deleted');
    return this.commit(() => {
      this.buckets.delete(b.id);
      for (const [k, bot] of this.bots) this.bots.set(k, { ...bot, buckets: bot.buckets.filter((l) => l.id !== b.id) });
      this.builtinLinks = this.builtinLinks.filter((l) => l.id !== b.id);
      return b;
    });
  }

  // ---------------------------------------------------------------- files (knowDrive only)
  needKd() { if (!this.kd) throw new InstanceError(503, 'file management needs a knowDrive key (KNOWDRIVE_API_KEY)'); }

  async listFiles(bucketId) {
    this.needKd();
    const b = this.bucket(bucketId);
    const rows = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: '500', prefix: b.folder });
      if (after) qs.set('after', after);
      const res = await this.kdFetch(`/api/v1/vector_stores/${encodeURIComponent(this.kd.store)}/files?${qs}`);
      if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status} listing files`);
      const j = await res.json();
      rows.push(...(j.data || []));
      after = j.next_after || j.last_id || (j.data?.length ? j.data[j.data.length - 1].id : '');
      if (!j.has_more || !after) break;
    }
    return rows.filter((r) => String(r.filename || '').startsWith(b.folder) && !(r.tags || []).includes('kind:config')).map((r) => ({
      id: r.id, path: r.filename.slice(b.folder.length), bytes: r.bytes ?? r.size ?? null, status: r.status || null, phase: r.phase || null,
      mime: r.mime_type || null, atoms: r.atom_count ?? null, error: r.last_error?.message || r.error || null,
      updatedAt: r.updated_at || r.last_modified_at || r.created_at || null,
    })).sort((a, c) => a.path.localeCompare(c.path));
  }

  async upload(bucketId, name, contentType, bytes) {
    this.needKd();
    const b = this.bucket(bucketId);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket is managed by the corpus sync script');
    const rel = safeRelPath(name);
    if (!bytes?.length) throw new InstanceError(400, 'empty file');
    const storePath = `${b.folder}${rel}`;
    const fd = new FormData();
    fd.append('tags', ['knowbot', `bucket:${b.id}`, 'kind:upload'].join(','));
    if (contentType && contentType !== 'application/octet-stream') fd.append('mime_type', contentType);
    fd.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), storePath);
    const res = await this.kdFetch('/api/v1/ingest', { method: 'POST', headers: { 'x-vector-store-id': this.kd.store }, body: fd, timeout: 120000 });
    const text = await res.text();
    let j = {}; try { j = JSON.parse(text); } catch {}
    if (!res.ok) throw new InstanceError([413, 415, 422].includes(res.status) ? res.status : 502, `knowDrive rejected ${rel}: ${j.error?.message || text.slice(0, 200)}`);
    const f = j.files?.[0] ?? j;
    if (f.filename && f.filename !== storePath) throw new InstanceError(502, `knowDrive stored ${rel} at an unexpected path`);
    return { id: f.id || f.file_id, path: rel, status: f.status || 'in_progress', bytes: bytes.length };
  }

  async deleteFile(bucketId, fileId) {
    this.needKd();
    const b = this.bucket(bucketId);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket is managed by the corpus sync script');
    const res = await this.kdFetch(`/api/v1/files/${encodeURIComponent(fileId)}`);
    if (res.status === 404) throw new InstanceError(404, 'no such file');
    if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status}`);
    const f = await res.json();
    // Only files inside the bucket's folder can be deleted through it.
    if (!String(f.filename || '').startsWith(b.folder)) throw new InstanceError(403, "that file is outside this bucket's folder");
    const del = await this.kdFetch(`/api/v1/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (!del.ok) throw new InstanceError(502, `knowDrive HTTP ${del.status} deleting the file`);
    return { ok: true, id: fileId, path: f.filename.slice(b.folder.length) };
  }
}

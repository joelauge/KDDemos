// KnowBot chat instances: each one answers only from one knowDrive folder.
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

/** An uploaded file's path inside its instance folder (sub-folders kept, traversal removed). */
export function safeRelPath(name) {
  const segs = String(name || '').replace(/\\/g, '/').split('/')
    .map((s) => s.replace(/[\0-\x1f]/g, '').trim()).filter((s) => s && s !== '.' && s !== '..');
  if (!segs.length) throw new InstanceError(400, 'file name is required');
  const rel = segs.join('/');
  if (rel.length > 400) throw new InstanceError(400, 'file name too long');
  return rel;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const PUBLIC_KEYS = ['id', 'name', 'folder', 'org', 'botName', 'greeting', 'starters', 'guards', 'minSimilarity', 'builtin', 'createdAt', 'updatedAt'];

function cleanInput(body, { partial = false } = {}) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 80) throw new InstanceError(400, 'name is required (max 80 characters)');
    out.name = name;
  }
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
  if (body.minSimilarity !== undefined && body.minSimilarity !== null && body.minSimilarity !== '') {
    const v = Number(body.minSimilarity);
    if (!(v >= 0 && v < 1)) throw new InstanceError(400, 'minSimilarity must be between 0 and 1');
    out.minSimilarity = v;
  }
  return out;
}

export class InstanceRegistry {
  /**
   * @param {{ kd?: { baseUrl: string, apiKey: string|Function, store: string } | null, dataDir: string,
   *           builtin: object, builtinRetriever: object, defaultMinSimilarity: number, logger?: Function }} o
   */
  constructor({ kd = null, dataDir, builtin, builtinRetriever, defaultMinSimilarity = 0.745, logger = () => {} }) {
    this.kd = kd; this.dataDir = dataDir; this.log = logger;
    this.builtin = { ...builtin, builtin: true };
    this.builtinRetriever = builtinRetriever;
    this.defaultMinSimilarity = defaultMinSimilarity;
    this.items = new Map();
    this.retrievers = new Map();
    this.ready = this.load().catch((e) => this.log(`[instances] registry load failed: ${e.message}`));
    this.writeChain = Promise.resolve();
  }

  get canWrite() { return !!this.kd; }
  key() { return typeof this.kd.apiKey === 'function' ? this.kd.apiKey() : this.kd.apiKey; }

  async kdFetch(p, init = {}) {
    const res = await fetch(`${this.kd.baseUrl}${p}`, {
      ...init, headers: { authorization: `Bearer ${this.key()}`, ...(init.headers || {}) }, signal: init.signal || AbortSignal.timeout(init.timeout || 30000),
    });
    return res;
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
    const list = raw ? JSON.parse(raw).instances || [] : [];
    this.items = new Map(list.filter((x) => x && ID_RE.test(x.id) && x.id !== this.builtin.id).map((x) => [x.id, x]));
    this.log(`[instances] ${this.items.size} custom instance(s) loaded`);
  }

  async save() {
    const doc = JSON.stringify({ v: 1, instances: [...this.items.values()] }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
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
      if (!res.ok) throw new InstanceError(502, `saving the instance registry failed: knowDrive HTTP ${res.status}`);
    });
    return this.writeChain;
  }

  list() { return [this.builtin, ...[...this.items.values()].sort((a, b) => a.name.localeCompare(b.name))].map((x) => pick(x, PUBLIC_KEYS)); }

  get(id) {
    const key = String(id || '').toLowerCase();
    if (!key || key === this.builtin.id) return this.builtin;
    const it = this.items.get(key);
    if (!it) throw new InstanceError(404, `no such instance "${id}"`);
    return it;
  }

  /** The retriever for an instance: its folder is the whole world it can search or cite. */
  retriever(id) {
    const it = this.get(id);
    if (it.builtin) return this.builtinRetriever;
    const cached = this.retrievers.get(it.id);
    if (cached && cached._v === it.updatedAt) return cached;
    if (!this.kd) throw new InstanceError(503, 'this instance needs a knowDrive key (KNOWDRIVE_API_KEY) to search');
    const r = new KnowDriveRetriever({
      baseUrl: this.kd.baseUrl, apiKey: this.kd.apiKey, store: this.kd.store, tag: '', prefix: it.folder, local: null,
      minSimilarity: it.minSimilarity ?? this.defaultMinSimilarity, exclude: ['kind:config'], cards: false, logger: this.log,
    });
    r._v = it.updatedAt;
    this.retrievers.set(it.id, r);
    return r;
  }

  async create(body) {
    if (!this.canWrite) throw new InstanceError(503, 'creating instances needs a knowDrive key (KNOWDRIVE_API_KEY)');
    const fields = cleanInput(body);
    const id = slugify(body.id || fields.name);
    if (!ID_RE.test(id) || RESERVED.has(id)) throw new InstanceError(400, 'id must be 1-40 lowercase letters, digits or dashes');
    if (id === this.builtin.id || this.items.has(id)) throw new InstanceError(409, `instance "${id}" already exists`);
    const now = new Date().toISOString();
    const it = { id, guards: 'general', ...fields, folder: normalizeFolder(body.folder || `knowbot/${id}/`), createdAt: now, updatedAt: now };
    this.items.set(id, it);
    try { await this.save(); } catch (e) { this.items.delete(id); throw e; }
    return pick(it, PUBLIC_KEYS);
  }

  async update(id, body) {
    const it = this.get(id);
    if (it.builtin) throw new InstanceError(403, 'the built-in instance is configured by the server');
    const next = { ...it, ...cleanInput(body, { partial: true }), updatedAt: new Date().toISOString() };
    if (body.folder !== undefined) next.folder = normalizeFolder(body.folder);
    this.items.set(it.id, next);
    try { await this.save(); } catch (e) { this.items.set(it.id, it); throw e; }
    return pick(next, PUBLIC_KEYS);
  }

  async remove(id) {
    const it = this.get(id);
    if (it.builtin) throw new InstanceError(403, 'the built-in instance cannot be deleted');
    this.items.delete(it.id); this.retrievers.delete(it.id);
    try { await this.save(); } catch (e) { this.items.set(it.id, it); throw e; }
    return it;
  }

  // ---------------------------------------------------------------- files (knowDrive only)
  needKd() { if (!this.kd) throw new InstanceError(503, 'file management needs a knowDrive key (KNOWDRIVE_API_KEY)'); }

  async listFiles(id) {
    this.needKd();
    const it = this.get(id);
    const rows = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: '500', prefix: it.folder });
      if (after) qs.set('after', after);
      const res = await this.kdFetch(`/api/v1/vector_stores/${encodeURIComponent(this.kd.store)}/files?${qs}`);
      if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status} listing files`);
      const j = await res.json();
      rows.push(...(j.data || []));
      after = j.next_after || j.last_id || (j.data?.length ? j.data[j.data.length - 1].id : '');
      if (!j.has_more || !after) break;
    }
    return rows.filter((r) => String(r.filename || '').startsWith(it.folder) && !(r.tags || []).includes('kind:config')).map((r) => ({
      id: r.id, path: r.filename.slice(it.folder.length), bytes: r.bytes ?? r.size ?? null, status: r.status || null, phase: r.phase || null,
      mime: r.mime_type || null, atoms: r.atom_count ?? null, error: r.last_error?.message || r.error || null,
      updatedAt: r.updated_at || r.last_modified_at || r.created_at || null,
    })).sort((a, b) => a.path.localeCompare(b.path));
  }

  async upload(id, name, contentType, bytes) {
    this.needKd();
    const it = this.get(id);
    const rel = safeRelPath(name);
    if (!bytes?.length) throw new InstanceError(400, 'empty file');
    const storePath = `${it.folder}${rel}`;
    const fd = new FormData();
    fd.append('tags', ['knowbot', `knowbot:${it.id}`, 'kind:upload'].join(','));
    if (contentType && contentType !== 'application/octet-stream') fd.append('mime_type', contentType);
    fd.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), storePath);
    const res = await this.kdFetch('/api/v1/ingest', { method: 'POST', headers: { 'x-vector-store-id': this.kd.store }, body: fd, timeout: 120000 });
    const text = await res.text();
    let j = {}; try { j = JSON.parse(text); } catch {}
    if (!res.ok) throw new InstanceError(res.status === 413 || res.status === 415 || res.status === 422 ? res.status : 502, `knowDrive rejected ${rel}: ${j.error?.message || text.slice(0, 200)}`);
    const f = j.files?.[0] ?? j;
    if (f.filename && f.filename !== storePath) throw new InstanceError(502, `knowDrive stored ${rel} at an unexpected path`);
    return { id: f.id || f.file_id, path: rel, status: f.status || 'in_progress', bytes: bytes.length };
  }

  async deleteFile(id, fileId) {
    this.needKd();
    const it = this.get(id);
    const res = await this.kdFetch(`/api/v1/files/${encodeURIComponent(fileId)}`);
    if (res.status === 404) throw new InstanceError(404, 'no such file');
    if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status}`);
    const f = await res.json();
    // Only files inside the instance folder can be deleted through it.
    if (!String(f.filename || '').startsWith(it.folder)) throw new InstanceError(403, 'that file is outside this instance folder');
    const del = await this.kdFetch(`/api/v1/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (!del.ok) throw new InstanceError(502, `knowDrive HTTP ${del.status} deleting the file`);
    return { ok: true, id: fileId, path: f.filename.slice(it.folder.length) };
  }
}

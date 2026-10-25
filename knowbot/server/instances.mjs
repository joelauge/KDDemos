// KnowBot bots and buckets.
// A BUCKET is a tag (bucket:<id>): every file carrying it is in the bucket, wherever knowDrive stores it. Folders are
// tags too (f1:<name>, f2:<name>, … one per level), so people organise files in folders without ever seeing a path.
// A BOT (chat instance) links to any number of buckets, each link on or off and optionally MASKED by tags (required
// and excluded tags narrow what that bot sees of the bucket). A bot answers only from its enabled, masked buckets.
// The registry lives in the knowDrive store itself (knowbot/_config/instances.json) so it survives container
// restarts; without a knowDrive key it falls back to a JSON file in the data dir (local development).
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { KnowDriveRetriever } from './retrievers.mjs';
import { PROVIDERS, sealKey, openKey, listModels } from './providers.mjs';

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

// ---------------------------------------------------------------- tags
const TAG_RE = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9._-]+)?$/;
export const tagSafe = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
/** Folder chain → level tags: ['family', '04'] → ['f1:family', 'f2:04']. */
export const folderTags = (folders) => folders.map((f, i) => `f${i + 1}:${tagSafe(f)}`);
/** Level tags → folder chain (null when the file has none). */
export function foldersOf(tags = []) {
  const lv = tags.map((t) => /^f(\d{1,2}):(.+)$/.exec(String(t))).filter(Boolean).map((m) => [Number(m[1]), m[2]]).sort((a, b) => a[0] - b[0]);
  return lv.length ? lv.map((x) => x[1]) : null;
}
const isFolderTag = (t) => /^f\d{1,2}:/.test(String(t));
// Tags people never pick in a mask: bookkeeping, and the bucket tag itself.
// Linking a bucket to a bot tags every file in it bot:<bot id>; unlinking (or deleting the bot) takes it off again.
export const botTag = (botId) => `bot:${botId}`;
const HIDDEN_TAG = /^(?:knowbot|kind:upload|kind:config|bucket:.*|knowbot:.*|dir:.*|mime:.*|charset:.*)$/;
function cleanMask(m) {
  if (!m || typeof m !== 'object') return undefined;
  const list = (v) => [...new Set((Array.isArray(v) ? v : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  const require = list(m.require), exclude = list(m.exclude);
  for (const t of [...require, ...exclude]) if (!TAG_RE.test(t) || t.length > 80) throw new InstanceError(400, `"${t}" is not a tag`);
  return require.length || exclude.length ? { require: require.slice(0, 12), exclude: exclude.slice(0, 12) } : undefined;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const BOT_KEYS = ['id', 'flow', 'name', 'org', 'botName', 'greeting', 'instructions', 'provider', 'model', 'answerMode', 'starters', 'guards', 'minSimilarity', 'buckets', 'builtin', 'createdAt', 'updatedAt'];
const BUCKET_KEYS = ['id', 'flow', 'name', 'tag', 'builtin', 'createdAt', 'updatedAt'];
const now = () => new Date().toISOString();

function cleanName(v) {
  const name = String(v ?? '').trim();
  if (!name || name.length > 80) throw new InstanceError(400, 'name is required (max 80 characters)');
  return name;
}

/** A bot's provider/model pair must make sense together: local models from the server list, hosted ones by id. */
function checkModel(bot, localModels) {
  const provider = bot.provider || 'local';
  if (provider === 'local') {
    if (bot.model && localModels.length && !localModels.includes(bot.model)) throw new InstanceError(400, `unknown local model "${bot.model}"`);
  } else if (!bot.model) throw new InstanceError(400, `choose a ${PROVIDERS[provider].label} model for this bot`);
}

function newId(body, name, taken) {
  const id = slugify(body.id || name);
  if (!ID_RE.test(id) || RESERVED.has(id)) throw new InstanceError(400, 'id must be 1-40 lowercase letters, digits or dashes');
  if (taken(id)) throw new InstanceError(409, `"${id}" already exists`);
  return id;
}

function cleanBot(body, { partial = false, models = [] } = {}) {
  const out = {};
  if (body.instructions !== undefined) {
    const v = String(body.instructions ?? '').trim();
    if (v.length > 800) throw new InstanceError(400, 'instructions too long (max 800 characters)');
    out.instructions = v || undefined;
  }
  if (body.provider !== undefined) {
    const v = String(body.provider || 'local');
    if (!PROVIDERS[v]) throw new InstanceError(400, `provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
    out.provider = v === 'local' ? undefined : v;
  }
  if (body.model !== undefined) {
    const v = String(body.model ?? '').trim();
    if (v.length > 100 || /[^\w.:@/-]/.test(v)) throw new InstanceError(400, 'model must be a model id such as claude-opus-5-5 or gpt-4.1-mini');
    out.model = v || undefined;
  }
  if (body.answerMode !== undefined) {
    if (body.answerMode && !['select', 'generate'].includes(body.answerMode)) throw new InstanceError(400, 'answerMode must be "select" or "generate"');
    out.answerMode = body.answerMode || undefined;
  }
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

/**
 * One pipeline stage per file, from knowDrive's coarse status plus its raw phase:
 * uploaded → extracted → chunked → vectorizing → ready, or failed.
 */
export function fileStage(f) {
  const phase = String(f.phase || ''), status = String(f.status || '');
  if (status === 'error' || ['error', 'quarantined', 'retained'].includes(phase)) return 'failed';
  if (phase === 'completed' || status === 'processed') return 'ready';
  if (phase === 'chunked') return f.atom_count > 0 && (f.atoms_vectorized ?? 0) > 0 ? 'vectorizing' : 'chunked';
  if (phase === 'text_extracted') return 'extracted';
  return 'uploaded'; // pending / fetching / just stored
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
  constructor({ kd = null, dataDir, builtin, builtinRetriever, defaultMinSimilarity = 0.7, models = [], secret = 'knowbot-local-dev', logger = () => {} }) {
    this.kd = kd; this.dataDir = dataDir; this.log = logger; this.models = models; this.secret = secret;
    this.providerKeys = {}; // provider id → { sealed, last4, updatedAt }
    // The built-in bot and bucket come from the server config. Only the bot's bucket links can be changed.
    // root: where knowDrive stores a bucket's uploads. Never shown; membership is the tag.
    this.builtinBucket = { id: builtin.id, name: builtin.name, tag: builtin.tag || `knowbot:${builtin.id}`, root: builtin.folder, builtin: true };
    this.migrated = {}; // bucket id → ISO time its files were given bucket + folder tags
    // Flows group bots and buckets into separate canvases. The built-in bot and bucket live in the demo flow.
    this.flows = new Map();
    this.demoFlow = { id: 'demo', name: `${builtin.name} (demo)`, demo: true };
    this.botTagged = {}; // "bot>bucket" → bucket tag, for every link whose files carry bot:<bot id>
    this.tagChain = Promise.resolve();
    this.builtinBotBase = { id: builtin.id, name: builtin.name, org: builtin.org, guards: builtin.guards || 'store', builtin: true };
    this.builtinLinks = [{ id: builtin.id, enabled: true }];
    this.builtinSettings = {}; // operator overrides for the built-in bot (model, instructions, greeting, …)
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
      buckets = doc.instances.map((x) => ({ id: x.id, name: x.name, root: x.folder, createdAt: x.createdAt, updatedAt: x.updatedAt }));
      bots = doc.instances.map(({ folder, ...x }) => ({ ...x, buckets: [{ id: x.id, enabled: true }] }));
    }
    const builtinId = this.builtinBucket.id;
    // v2 buckets named a folder; now a bucket is its tag, and the old folder is just where its uploads live.
    this.buckets = new Map(buckets.filter((x) => x && ID_RE.test(x.id) && x.id !== builtinId).map(({ folder, ...x }) => [x.id,
      { ...x, tag: x.tag || `bucket:${x.id}`, root: x.root || folder || `knowbot/${x.id}/` }]));
    this.migrated = doc.migrated && typeof doc.migrated === 'object' ? doc.migrated : {};
    this.botTagged = doc.botTagged && typeof doc.botTagged === 'object' ? doc.botTagged : {};
    this.flows = new Map((Array.isArray(doc.flows) ? doc.flows : []).filter((f) => f && ID_RE.test(f.id) && f.id !== this.demoFlow.id).map((f) => [f.id, { id: f.id, name: String(f.name || f.id).slice(0, 80), createdAt: f.createdAt }]));
    this.bots = new Map(bots.filter((x) => x && ID_RE.test(x.id) && x.id !== builtinId).map((x) => [x.id, { ...x, buckets: this.cleanLinks(x.buckets, { strict: false }) }]));
    if (Array.isArray(doc.builtinBot?.buckets)) this.builtinLinks = this.cleanLinks(doc.builtinBot.buckets, { strict: false });
    if (doc.builtinBot?.settings && typeof doc.builtinBot.settings === 'object') this.builtinSettings = doc.builtinBot.settings;
    this.providerKeys = Object.fromEntries(Object.entries(doc.providers || {}).filter(([k, v]) => PROVIDERS[k] && v && v.sealed));
    if (this.assignFlows() && this.kd) this.save().catch((e) => this.log(`[instances] saving flows failed: ${e.message}`));
    this.log(`[instances] ${this.bots.size} bot(s), ${this.buckets.size} bucket(s) loaded`);
    if (this.kd) {
      this.migration = this.migrateTags().catch((e) => this.log(`[instances] tag migration failed: ${e.message}`));
      // Full pass at start-up: also tags files that reached a linked bucket some other way (e.g. a bulk ingest script).
      this.migration.then(() => this.syncBotTags({ full: true }));
    }
  }

  /**
   * One-time per bucket: files stored under its folder get the bucket tag and folder tags (f1:, f2:, …) derived from
   * their path, so membership, the folder tree and masks all work from tags. Files that already have them are skipped.
   */
  async migrateTags() {
    let changed = false;
    for (const b of [this.builtinBucket, ...this.buckets.values()]) {
      if (this.migrated[b.id] || !b.root) continue;
      const rows = await this.listRows({ prefix: b.root });
      const groups = new Map(); // tag set → file ids
      for (const r of rows) {
        if ((r.tags || []).includes('kind:config')) continue;
        const want = [...(r.tags || []).includes(b.tag) ? [] : [b.tag]];
        if (!foldersOf(r.tags)) want.push(...folderTags(r.filename.slice(b.root.length).split('/').slice(0, -1)));
        if (!want.length) continue;
        const k = want.join(',');
        (groups.get(k) || groups.set(k, []).get(k)).push(r.id);
      }
      for (const [k, ids] of groups) {
        for (let i = 0; i < ids.length; i += 500) {
          const res = await this.kdFetch('/api/v1/files/batch_tags', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ file_ids: ids.slice(i, i + 500), tags_add: k.split(',') }), timeout: 120000 });
          if (!res.ok) throw new Error(`knowDrive HTTP ${res.status} tagging files of ${b.id}`);
        }
      }
      this.migrated[b.id] = now(); changed = true;
      this.log(`[instances] tagged ${[...groups.values()].reduce((a, x) => a + x.length, 0)} file(s) in bucket ${b.id}`);
    }
    if (changed) await this.save();
  }

  /**
   * Every bot and bucket belongs to one flow. Anything without one (a registry from before flows) is grouped by what it
   * is linked to: the built-in bot's group is the demo flow; each other group becomes a flow named after its first bucket (or its bot).
   */
  assignFlows() {
    const known = (f) => f === this.demoFlow.id || this.flows.has(f);
    const loose = [...this.bots.values(), ...this.buckets.values()].filter((x) => !known(x.flow));
    if (!loose.length) return false;
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
    const union = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };
    const builtinKey = `bot:${this.builtinBotBase.id}`;
    add(builtinKey); union(builtinKey, `bucket:${this.builtinBucket.id}`);
    for (const l of this.builtinLinks) union(builtinKey, `bucket:${l.id}`);
    for (const b of this.bots.values()) { add(`bot:${b.id}`); for (const l of b.buckets || []) union(`bot:${b.id}`, `bucket:${l.id}`); }
    for (const k of this.buckets.values()) add(`bucket:${k.id}`);
    // A group that already has a flow (some member has one) keeps it.
    const flowOf = new Map([[find(builtinKey), this.demoFlow.id]]);
    for (const x of [...this.bots.values(), ...this.buckets.values()]) {
      if (!known(x.flow)) continue;
      const r = find(`${this.bots.get(x.id) === x ? 'bot' : 'bucket'}:${x.id}`);
      if (!flowOf.has(r)) flowOf.set(r, x.flow);
    }
    const t = now();
    // Buckets first, so a group's flow is named after what it answers from ("Access to Justice"), then lone bots.
    for (const x of [...[...this.buckets.values()].sort((a, b) => a.name.localeCompare(b.name)), ...[...this.bots.values()].sort((a, b) => a.name.localeCompare(b.name))]) {
      if (known(x.flow)) continue;
      const r = find(`${this.bots.get(x.id) === x ? 'bot' : 'bucket'}:${x.id}`);
      if (!flowOf.has(r)) {
        const id = this.freeFlowId(x.name);
        this.flows.set(id, { id, name: x.name, createdAt: t });
        flowOf.set(r, id);
      }
      x.flow = flowOf.get(r);
    }
    this.log(`[instances] grouped ${loose.length} bot(s)/bucket(s) into flows`);
    return true;
  }

  flowList() {
    const count = (f) => ({ bots: this.list().filter((b) => b.flow === f).length, buckets: this.bucketList().filter((b) => b.flow === f).length });
    return [{ ...this.demoFlow, ...count(this.demoFlow.id) }, ...[...this.flows.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ ...f, ...count(f.id) }))];
  }

  freeFlowId(name) {
    const base = slugify(name).slice(0, 34) || 'flow';
    for (let i = 1; ; i++) { const id = i === 1 ? base : `${base}-${i}`; if (id !== this.demoFlow.id && !this.flows.has(id)) return id; }
  }
  checkFlow(flow) {
    const f = String(flow || '').toLowerCase();
    if (f !== this.demoFlow.id && !this.flows.has(f)) throw new InstanceError(400, `no such flow "${flow}"`);
    return f;
  }
  /** The flow a new bot or bucket goes into: the one named, or a new flow named after it. Returns [flowId, newFlow?]. */
  flowFor(body, name) {
    if (body.flow) return [this.checkFlow(body.flow), null];
    const id = this.freeFlowId(name);
    return [id, { id, name, createdAt: now() }];
  }

  async createFlow(body) {
    this.needWrite();
    const name = cleanName(body.name);
    const id = newId(body, name, (v) => v === this.demoFlow.id || this.flows.has(v));
    const f = { id, name, createdAt: now() };
    return this.commit(() => { this.flows.set(id, f); return { ...f, bots: 0, buckets: 0 }; });
  }

  async updateFlow(id, body) {
    this.needWrite();
    const f = this.flows.get(String(id).toLowerCase());
    if (!f) throw new InstanceError(String(id) === this.demoFlow.id ? 403 : 404, String(id) === this.demoFlow.id ? 'the demo flow cannot be renamed' : `no such flow "${id}"`);
    const next = { ...f, name: cleanName(body.name) };
    return this.commit(() => { this.flows.set(f.id, next); return next; });
  }

  /** Only an empty flow can be deleted: delete or move its bots and buckets first. */
  async removeFlow(id) {
    this.needWrite();
    const f = this.flows.get(String(id).toLowerCase());
    if (!f) throw new InstanceError(String(id) === this.demoFlow.id ? 403 : 404, String(id) === this.demoFlow.id ? 'the demo flow cannot be deleted' : `no such flow "${id}"`);
    if ([...this.bots.values(), ...this.buckets.values()].some((x) => x.flow === f.id)) throw new InstanceError(409, 'this flow still has bots or buckets');
    return this.commit(() => { this.flows.delete(f.id); return { ok: true, id: f.id }; });
  }

  /** Every link's files carry bot:<bot id>; links that are gone have it removed. Serialised; failures retry next time. */
  syncBotTags({ full = false } = {}) {
    if (!this.kd) return Promise.resolve();
    this.botTagging = this.tagChain = this.tagChain.catch(() => {}).then(async () => {
      const want = new Map();
      for (const bot of [{ id: this.builtinBotBase.id, buckets: this.builtinLinks }, ...this.bots.values()]) {
        for (const l of bot.buckets || []) { const b = l.id === this.builtinBucket.id ? this.builtinBucket : this.buckets.get(l.id); if (b) want.set(`${bot.id}>${b.id}`, b.tag); }
      }
      let changed = false;
      const batch = async (ids, body) => {
        for (let i = 0; i < ids.length; i += 500) {
          const res = await this.kdFetch('/api/v1/files/batch_tags', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ file_ids: ids.slice(i, i + 500), ...body }), timeout: 120000 });
          if (!res.ok) throw new Error(`knowDrive HTTP ${res.status} tagging files`);
        }
      };
      for (const [pair, bucketTag] of want) {
        if (this.botTagged[pair] && !full) continue;
        const tag = botTag(pair.split('>')[0]);
        try {
          const ids = (await this.listRows({ tags_all: bucketTag })).filter((r) => !(r.tags || []).includes(tag) && !(r.tags || []).includes('kind:config')).map((r) => r.id);
          await batch(ids, { tags_add: [tag] });
          if (ids.length) this.log(`[instances] tagged ${ids.length} file(s) in ${bucketTag} with ${tag}`);
          if (this.botTagged[pair] !== bucketTag) { this.botTagged[pair] = bucketTag; changed = true; }
        } catch (e) { this.log(`[instances] ${tag} on ${bucketTag} failed: ${e.message}`); }
      }
      for (const [pair, bucketTag] of Object.entries(this.botTagged)) {
        if (want.has(pair)) continue;
        const tag = botTag(pair.split('>')[0]);
        try {
          const ids = (await this.listRows({ tags_all: `${bucketTag},${tag}` })).map((r) => r.id);
          await batch(ids, { tags_remove: [tag] });
          if (ids.length) this.log(`[instances] removed ${tag} from ${ids.length} file(s) in ${bucketTag}`);
          delete this.botTagged[pair]; changed = true;
        } catch (e) { this.log(`[instances] removing ${tag} from ${bucketTag} failed: ${e.message}`); }
      }
      if (changed) await this.save().catch((e) => this.log(`[instances] ${e.message}`));
    });
    return this.botTagging;
  }

  async listRows(params) {
    const rows = [];
    let after = '';
    for (let page = 0; page < 200; page++) {
      const qs = new URLSearchParams({ limit: '1000', ...params });
      if (after) qs.set('after', after);
      const res = await this.kdFetch(`/api/v1/vector_stores/${encodeURIComponent(this.kd.store)}/files?${qs}`, { timeout: 60000 });
      if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status} listing files`);
      const j = await res.json();
      rows.push(...(j.data || []));
      after = j.next_after || j.last_id || (j.data?.length ? j.data[j.data.length - 1].id : '');
      if (!j.has_more || !after) break;
    }
    return rows;
  }

  async save() {
    const doc = JSON.stringify({ v: 2, buckets: [...this.buckets.values()], bots: [...this.bots.values()], builtinBot: { buckets: this.builtinLinks, settings: this.builtinSettings }, providers: this.providerKeys, migrated: this.migrated, botTagged: this.botTagged, flows: [...this.flows.values()] }, null, 2);
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
    const snap = { flows: new Map(this.flows), bots: new Map(this.bots), buckets: new Map(this.buckets), builtinLinks: this.builtinLinks, builtinSettings: this.builtinSettings, providerKeys: { ...this.providerKeys } };
    const out = change();
    try { await this.save(); } catch (e) { Object.assign(this, snap); throw e; }
    this.retrievers.clear();
    this.syncBotTags(); // in the background: a big bucket can take a while to retag
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
      const mask = typeof l === 'object' && l ? cleanMask(l.mask) : undefined;
      out.push({ id, enabled: typeof l === 'object' && l ? l.enabled !== false : true, ...(mask ? { mask } : {}) });
    }
    return out;
  }

  // ---------------------------------------------------------------- reads
  bucketList() { return [{ ...this.builtinBucket, flow: this.demoFlow.id }, ...[...this.buckets.values()].sort((a, b) => a.name.localeCompare(b.name))].map((x) => pick(x, BUCKET_KEYS)); }
  builtinBot() { return { ...this.builtinBotBase, ...this.builtinSettings, builtin: true, id: this.builtinBotBase.id, flow: this.demoFlow.id, buckets: this.builtinLinks }; }
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

  /** A bucket's retriever, narrowed by the link's mask. Scope is the bucket tag (enforced by knowDrive's filter). */
  bucketRetriever(b, minSimilarity, mask) {
    if (b.builtin) return this.builtinRetriever.withMask ? this.builtinRetriever.withMask(mask || {}) : this.builtinRetriever;
    if (!this.kd) throw new InstanceError(503, 'bucket search needs a knowDrive key (KNOWDRIVE_API_KEY)');
    const key = `${b.id}@${b.tag}@${minSimilarity}`;
    if (!this.retrievers.has(key)) {
      this.retrievers.set(key, new KnowDriveRetriever({
        baseUrl: this.kd.baseUrl, apiKey: this.kd.apiKey, store: this.kd.store, tag: b.tag, prefix: b.root, dirFilter: false, prefixFilter: false,
        local: null, minSimilarity, exclude: ['kind:config'], cards: false, logger: this.log,
      }));
    }
    return this.retrievers.get(key).withMask(mask || {});
  }

  /** The retriever for a bot: its enabled buckets are the whole world it can search or cite. */
  retriever(id) {
    const bot = this.get(id);
    const floor = bot.minSimilarity ?? this.defaultMinSimilarity;
    const parts = bot.buckets.filter((l) => l.enabled).map((l) => {
      try { const b = this.bucket(l.id); return { bucket: b.id, retriever: this.bucketRetriever(b, floor, l.mask) }; } catch { return null; }
    }).filter(Boolean);
    return new LinkedRetriever(parts);
  }

  // ---------------------------------------------------------------- bots
  async create(body) {
    this.needWrite();
    const fields = cleanBot(body, { models: this.models });
    const id = newId(body, fields.name, (x) => x === this.builtinBotBase.id || this.bots.has(x));
    const t = now();
    const links = this.cleanLinks(body.buckets);
    // No flow named: join the flow of the first bucket it links to, else start a flow of its own.
    const first = links[0] && this.bucket(links[0].id);
    const [flow, newFlow] = this.flowFor(body.flow || !first ? body : { flow: first.flow || this.demoFlow.id }, fields.name);
    const bot = { id, flow, guards: 'general', ...fields, buckets: links, createdAt: t, updatedAt: t };
    checkModel(bot, this.models);
    return this.commit(() => { if (newFlow) this.flows.set(newFlow.id, newFlow); this.bots.set(id, bot); return pick(bot, BOT_KEYS); });
  }

  async update(id, body) {
    this.needWrite();
    const bot = this.get(id);
    if (bot.builtin) {
      const settings = { ...this.builtinSettings, ...cleanBot(body, { partial: true, models: this.models }) };
      if (body.provider !== undefined && body.model === undefined && settings.provider !== bot.provider) settings.model = undefined;
      checkModel(settings, this.models);
      const links = body.buckets !== undefined ? this.cleanLinks(body.buckets) : this.builtinLinks;
      return this.commit(() => { this.builtinSettings = settings; this.builtinLinks = links; return pick(this.builtinBot(), BOT_KEYS); });
    }
    const next = { ...bot, ...cleanBot(body, { partial: true, models: this.models }), updatedAt: now() };
    if (body.flow !== undefined) next.flow = this.checkFlow(body.flow);
    if (body.buckets !== undefined) next.buckets = this.cleanLinks(body.buckets);
    if (body.provider !== undefined && body.model === undefined && next.provider !== bot.provider) next.model = undefined;
    checkModel(next, this.models);
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
    // The bucket IS its tag: "Access to Justice" → bucket:access-to-justice. (body.tag may name it explicitly.)
    const id = newId({ id: body.tag ? String(body.tag).replace(/^bucket:/, '') : body.id }, name, (x) => x === this.builtinBucket.id || this.buckets.has(x));
    const t = now();
    const [flow, newFlow] = this.flowFor(body, name);
    const b = { id, flow, name, tag: `bucket:${id}`, root: `knowbot/${id}/`, createdAt: t, updatedAt: t };
    this.migrated[id] = t; // new: every file gets its tags at upload
    return this.commit(() => { if (newFlow) this.flows.set(newFlow.id, newFlow); this.buckets.set(id, b); return pick(b, BUCKET_KEYS); });
  }

  async updateBucket(id, body) {
    this.needWrite();
    const b = this.bucket(id);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket is managed by the corpus sync script');
    if (body.tag !== undefined && `bucket:${String(body.tag).replace(/^bucket:/, '')}` !== b.tag) throw new InstanceError(400, "a bucket's tag can't change; create a new bucket instead");
    const next = { ...b, ...(body.name !== undefined ? { name: cleanName(body.name) } : {}), updatedAt: now() };
    if (body.flow !== undefined) next.flow = this.checkFlow(body.flow);
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

  // ---------------------------------------------------------------- answering platforms (API keys)
  providerList() {
    return Object.entries(PROVIDERS).map(([id, p]) => {
      const k = this.providerKeys[id];
      return { id, label: p.label, needsKey: p.needsKey, keyHint: p.keyHint, docs: p.docs, defaultModel: p.defaultModel,
        configured: !p.needsKey || !!k, ...(k ? { last4: k.last4, updatedAt: k.updatedAt } : {}) };
    });
  }

  providerKey(id) {
    if (!PROVIDERS[id]?.needsKey) return null;
    const k = this.providerKeys[id];
    if (!k) throw new InstanceError(409, `no ${PROVIDERS[id].label} API key is set; add one under Answering platforms`);
    return openKey(k.sealed, this.secret);
  }

  /** Checks the key against the platform (by listing its models) before it is stored. */
  async setProviderKey(id, apiKey) {
    this.needWrite();
    if (!PROVIDERS[id]?.needsKey) throw new InstanceError(400, `"${id}" does not take an API key`);
    const key = String(apiKey || '').trim();
    if (!key) {
      if ([...this.bots.values(), this.builtinBot()].some((b) => b.provider === id)) throw new InstanceError(409, `bots still answer with ${PROVIDERS[id].label}; switch them first`);
      return this.commit(() => { delete this.providerKeys[id]; return this.providerList().find((p) => p.id === id); });
    }
    if (key.length > 400 || /\s/.test(key)) throw new InstanceError(400, 'that does not look like an API key');
    const models = await listModels(id, key);
    return this.commit(() => {
      this.providerKeys[id] = { sealed: sealKey(key, this.secret), last4: key.slice(-4), updatedAt: now() };
      return { ...this.providerList().find((p) => p.id === id), models: models.length };
    });
  }

  async providerModels(id) {
    if (!PROVIDERS[id]) throw new InstanceError(404, `no such provider "${id}"`);
    if (id === 'local') return this.models.map((m) => ({ id: m, label: m }));
    return listModels(id, this.providerKey(id));
  }

  // ---------------------------------------------------------------- files (knowDrive only)
  needKd() { if (!this.kd) throw new InstanceError(503, 'file management needs a knowDrive key (KNOWDRIVE_API_KEY)'); }

  /** A file belongs to a bucket by its tag. */
  async memberFile(b, fileId) {
    const res = await this.kdFetch(`/api/v1/files/${encodeURIComponent(fileId)}`);
    if (res.status === 404) throw new InstanceError(404, 'no such file');
    if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status}`);
    const f = await res.json();
    if (!(f.tags || []).includes(b.tag)) throw new InstanceError(403, 'that file is not in this bucket');
    return f;
  }

  /** How people see a file: its name and folder chain (from folder tags; from the stored path for older files). */
  view(b, r) {
    const name = String(r.filename || '').split('/').pop();
    const rel = b.root && String(r.filename).startsWith(b.root) ? String(r.filename).slice(b.root.length) : name;
    const folders = foldersOf(r.tags) || rel.split('/').slice(0, -1);
    return { name, folders, path: [...folders, name].join('/'), tags: (r.tags || []).filter((t) => !HIDDEN_TAG.test(t) && !isFolderTag(t)) };
  }

  async listFiles(bucketId) {
    this.needKd();
    const b = this.bucket(bucketId);
    await this.migration;
    const rows = await this.listRows({ tags_all: b.tag });
    return rows.filter((r) => !(r.tags || []).includes('kind:config')).map((r) => ({
      id: r.id, ...this.view(b, r), bytes: r.bytes ?? r.size ?? null, mime: r.mime_type || null,
      status: r.status || null, phase: r.phase || null, stage: fileStage(r),
      chunks: r.chunk_count ?? null, atoms: r.atom_count ?? null, vectorized: r.atoms_vectorized ?? null,
      error: r.status_details || r.last_error?.message || null,
      createdAt: r.created_at || null, updatedAt: r.updated_at || r.last_modified_at || r.created_at || null,
    })).sort((a, c) => a.path.localeCompare(c.path));
  }

  /** The tags in a bucket with their file counts: what a mask can require or exclude. Folders come back as f1:…/f2:…. */
  async bucketTags(bucketId) {
    this.needKd();
    const b = this.bucket(bucketId);
    await this.migration;
    const out = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ tags_all: b.tag, limit: '500' });
      if (after) qs.set('after', after);
      const res = await this.kdFetch(`/api/v1/vector_stores/${encodeURIComponent(this.kd.store)}/tags?${qs}`);
      if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status} listing tags`);
      const j = await res.json();
      out.push(...(j.data || []));
      after = j.next_after || '';
      if (!j.has_more || !after) break;
    }
    return out.filter((t) => !HIDDEN_TAG.test(t.tag) && !t.tag.startsWith('bot:')).map((t) => ({ tag: t.tag, count: t.count })).sort((a, c) => a.tag.localeCompare(c.tag));
  }

  /** The first atoms of a file in this bucket: what knowDrive actually extracted and will cite. */
  async fileAtoms(bucketId, fileId, limit = 5) {
    this.needKd();
    const b = this.bucket(bucketId);
    const f = await this.memberFile(b, fileId);
    const n = Math.max(1, Math.min(20, Number(limit) || 5));
    const ar = await this.kdFetch(`/api/v1/files/${encodeURIComponent(fileId)}/atoms?limit=${n}`);
    if (!ar.ok) throw new InstanceError(502, `knowDrive HTTP ${ar.status} reading atoms`);
    const j = await ar.json();
    const atoms = (j.data || j.atoms || []).map((a) => ({ seq: a.sequence_index ?? null, tokens: a.metadata?.text_tokens ?? null, kind: a.metadata?.node_kind || a.metadata?.type || null, text: String(a.text || '').slice(0, 800) }));
    return { id: fileId, path: this.view(b, f).path, stage: fileStage(f), atoms: f.atom_count ?? atoms.length, shown: atoms.length, items: atoms };
  }

  /** name may carry folders ("menus/lunch/specials.md"): they become folder tags. */
  async upload(bucketId, name, contentType, bytes) {
    this.needKd();
    const b = this.bucket(bucketId);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket is managed by the corpus sync script');
    const rel = safeRelPath(name);
    if (!bytes?.length) throw new InstanceError(400, 'empty file');
    const folders = rel.split('/').slice(0, -1);
    const storePath = `${b.root}${rel}`; // where knowDrive keeps it; people only ever see the folder tags
    const fd = new FormData();
    const bots = [{ id: this.builtinBotBase.id, buckets: this.builtinLinks }, ...this.bots.values()].filter((x) => (x.buckets || []).some((l) => l.id === b.id)).map((x) => botTag(x.id));
    fd.append('tags', ['knowbot', b.tag, 'kind:upload', ...folderTags(folders), ...bots].join(','));
    if (contentType && contentType !== 'application/octet-stream') fd.append('mime_type', contentType);
    fd.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), storePath);
    const res = await this.kdFetch('/api/v1/ingest', { method: 'POST', headers: { 'x-vector-store-id': this.kd.store }, body: fd, timeout: 120000 });
    const text = await res.text();
    let j = {}; try { j = JSON.parse(text); } catch {}
    if (!res.ok) throw new InstanceError([413, 415, 422].includes(res.status) ? res.status : 502, `knowDrive rejected ${rel}: ${j.error?.message || text.slice(0, 200)}`);
    const f = j.files?.[0] ?? j;
    if (f.filename && f.filename !== storePath) throw new InstanceError(502, `knowDrive stored ${rel} at an unexpected path`);
    return { id: f.id || f.file_id, path: rel, folders, status: f.status || 'in_progress', bytes: bytes.length };
  }

  /** Moving a file between folders only changes its folder tags. */
  async moveFile(bucketId, fileId, folders) {
    this.needKd();
    const b = this.bucket(bucketId);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket is managed by the corpus sync script');
    if (!Array.isArray(folders) || folders.length > 12) throw new InstanceError(400, 'folders must be a list of folder names');
    const clean = folders.map((x) => String(x).trim()).filter(Boolean);
    const f = await this.memberFile(b, fileId);
    const add = folderTags(clean), remove = (f.tags || []).filter((t) => isFolderTag(t) && !add.includes(t));
    const res = await this.kdFetch('/api/v1/files/batch_tags', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_ids: [fileId], tags_add: add, tags_remove: remove }) });
    if (!res.ok) throw new InstanceError(502, `knowDrive HTTP ${res.status} moving the file`);
    return { ok: true, id: fileId, folders: clean.map(tagSafe) };
  }

  async deleteFile(bucketId, fileId) {
    this.needKd();
    const b = this.bucket(bucketId);
    if (b.builtin) throw new InstanceError(403, 'the built-in bucket is managed by the corpus sync script');
    const f = await this.memberFile(b, fileId); // only files carrying this bucket's tag
    const del = await this.kdFetch(`/api/v1/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (!del.ok) throw new InstanceError(502, `knowDrive HTTP ${del.status} deleting the file`);
    return { ok: true, id: fileId, path: this.view(b, f).path };
  }
}

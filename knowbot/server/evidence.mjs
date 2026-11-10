// The evidence selector: a loopback sidecar (attendd) that picks the passages one answer may quote, with a status and a
// receipt, instead of the server's own search. Off unless KNOWBOT_EVIDENCE=attend. Every failure (sidecar absent, down,
// slow, an error) returns null and the caller keeps its search path, so turning it on can never break an answer.
//
// Settings (names only): KNOWBOT_EVIDENCE=attend, ATTENDD_URL (default http://127.0.0.1:7071),
// ATTENDD_TIMEOUT_MS (default 20000), KNOWBOT_EVIDENCE_WEAK=answer (a weak match goes to the answer step, which may
// still find nothing, instead of the fixed refusal; default: refuse).
import { createHash } from 'node:crypto';

/** Statuses that mean "the files do not answer this": the fixed refusal, with no model call. */
export const REFUSAL_STATUSES = new Set(['underspecified', 'none_in_window', 'weak_match']);
/** Statuses whose evidence an answer may quote. */
export const ANSWER_STATUSES = new Set(['ok', 'truncated']);

const HEALTH_TTL_MS = 30000;
const DOWN_TTL_MS = 30000;

/**
 * @param {object} env
 * @param {{ log?: (s: string) => void, fetch?: typeof fetch, now?: () => number, timeoutMs?: number }} [o]
 * @returns {null | { url: string, healthy: () => Promise<boolean>, select: (q: object) => Promise<null | object> }}
 */
export function createEvidenceSelector(env = {}, o = {}) {
  if (String(env.KNOWBOT_EVIDENCE || '').trim().toLowerCase() !== 'attend') return null;
  const url = String(env.ATTENDD_URL || 'http://127.0.0.1:7071').replace(/\/+$/, '');
  const log = typeof o.log === 'function' ? o.log : () => {};
  const doFetch = o.fetch || fetch;
  const now = o.now || Date.now;
  const timeoutMs = Number(o.timeoutMs ?? env.ATTENDD_TIMEOUT_MS ?? 20000);
  const weakAnswers = String(env.KNOWBOT_EVIDENCE_WEAK || '').trim().toLowerCase() === 'answer';
  let health = { at: -Infinity, ok: false, loading: null };
  let downUntil = 0, lastLog = -Infinity;
  const warn = (msg) => { if (now() - lastLog >= 60000) { lastLog = now(); log(`[evidence] ${msg}; using search instead`); } };

  async function healthy() {
    if (now() < downUntil) return false;
    if (now() - health.at < HEALTH_TTL_MS) return health.ok;
    if (!health.loading) {
      health.loading = (async () => {
        let ok = false;
        try { const r = await doFetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) }); ok = r.ok; } catch { ok = false; }
        health = { at: now(), ok, loading: null };
        if (!ok) warn(`selector at ${url} is not answering`);
        return ok;
      })();
    }
    return health.loading;
  }

  async function attendOnce(store, question, scope, opts, signal) {
    const body = { store, question, scope: { tags_all: scope.tags_all || [], tags_any: scope.tags_any || [], tags_none: scope.tags_none || [] },
      ...(opts.budget ? { budget: opts.budget } : {}), ...(opts.query_limit ? { query_limit: opts.query_limit } : {}),
      ...(opts.section_files ? { section_files: opts.section_files } : {}), ...(opts.depth ? { depth: opts.depth } : {}) };
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await doFetch(`${url}/attend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: sig });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
    const b = JSON.parse(text);
    if (!b || typeof b.status !== 'string' || !Array.isArray(b.evidence)) throw new Error('malformed bundle');
    return b;
  }

  /**
   * One question over one or more scopes (each its own attend call, run together), merged in scope order.
   * @param {{ store: string, question: string, scope?: object, scopes?: object[], budget?: object, signal?: AbortSignal }} q
   * @returns {Promise<null | { status: string, sources: object[], receipt: object, ms: number }>} null: use search instead
   */
  async function select({ store, question, scope, scopes, signal, ...opts } = {}) {
    const list = (Array.isArray(scopes) && scopes.length ? scopes : [scope || {}]);
    if (!store || !question || !(await healthy())) return null;
    const t0 = now();
    let bundles;
    try {
      bundles = await Promise.all(list.map((s) => attendOnce(store, question, s, opts, signal)));
    } catch (e) {
      if (signal?.aborted) return null;
      downUntil = now() + DOWN_TTL_MS;
      warn(`selector failed (${e?.name === 'TimeoutError' ? 'timed out' : e?.message || e})`);
      return null;
    }
    return { ...mergeBundles(bundles, { weakAnswers }), ms: now() - t0 };
  }

  return { url, healthy, select };
}

/** Pure: the merged view of one attend bundle per scope. Evidence keeps scope order, deduped by (file_id, atom_index). */
export function mergeBundles(bundles = [], { weakAnswers = false } = {}) {
  const seen = new Set();
  const sources = [];
  for (const b of bundles) {
    for (const it of b.evidence || []) {
      const key = `${it.file_id}#${it.atom_index}`;
      if (!it.file_id || seen.has(key) || !String(it.text || '').trim()) continue;
      seen.add(key);
      sources.push(sourceOf(it));
    }
  }
  const st = bundles.map((b) => b.status);
  // a scope that answers wins (a trial's own files may say nothing while its sample files answer); otherwise the
  // strongest "not in the files" reason; degraded (the store's vocabulary could not be read) hands back to search
  const answers = (x) => ANSWER_STATUSES.has(x) || (weakAnswers && x === 'weak_match');
  const status = sources.length && st.some(answers)
    ? (st.includes('truncated') ? 'truncated' : 'ok')
    : st.includes('degraded') ? 'degraded'
      : st.includes('weak_match') ? 'weak_match'
        : st.length && st.every((x) => x === 'underspecified') ? 'underspecified' : 'none_in_window';
  const digests = bundles.map((b) => b.receipt?.bundle_digest).filter(Boolean);
  const digest = digests.length <= 1 ? (digests[0] || null) : `sha256:${createHash('sha256').update(digests.join('\n')).digest('hex')}`;
  return { status, sources: ANSWER_STATUSES.has(status) ? sources : [], receipt: { digest, bundles: digests }, attribution: attributionOf(bundles) };
}

/**
 * Pure, internal only (never sent to a visitor or put in a proof): which selector heads ran, failed and surfaced each
 * passage, over every scope's bundle. items follow the merged sources' order (file_id, seq, via); heads counts each
 * head's passages; section_available is false when any bundle ran without H-section.
 */
export function attributionOf(bundles = []) {
  const runs = new Set(), failed = new Set(), heads = {}, items = [], seen = new Set();
  let section = bundles.length > 0, rankMode = null;
  for (const b of bundles) {
    const sm = b.summary || {};
    for (const h of sm.heads_run || (b.heads || []).filter((x) => x.status !== 'skipped').map((x) => x.id)) runs.add(h);
    for (const h of sm.heads_failed || []) failed.add(h);
    if (sm.section_available === false) section = false;
    rankMode = rankMode || sm.rank_mode || null;
    for (const it of b.evidence || []) {
      const key = `${it.file_id}#${it.atom_index}`;
      if (!it.file_id || seen.has(key) || !String(it.text || '').trim()) continue;
      seen.add(key);
      const via = Array.isArray(it.via) ? it.via.map(String) : [];
      for (const v of via) heads[v] = (heads[v] || 0) + 1;
      items.push({ file_id: it.file_id, seq: Number.isFinite(Number(it.atom_index)) ? Number(it.atom_index) : null, via });
    }
  }
  return { heads_run: [...runs], heads_failed: [...failed], section_available: section, rank_mode: rankMode, heads, items };
}

/** An evidence item as the source shape answers consume (lib normalizeResult's fields, plus seq and content_hash). */
export function sourceOf(it) {
  const path = String(it.path || '');
  const base = path.split('/').pop() || '';
  return {
    file_id: it.file_id, filename: path, path, title: String(it.title || '').trim() || base.replace(/\.\w+$/, '') || 'Untitled',
    text: String(it.text || ''), seq: Number.isFinite(Number(it.atom_index)) ? Number(it.atom_index) : null,
    content_hash: it.content_hash || null, score: typeof it.score === 'number' ? it.score : null, h: it.h || null,
  };
}

/** Whether a selection lets an answer go ahead (quote from its sources) or must be the fixed refusal. */
export const isRefusal = (sel) => !!sel && REFUSAL_STATUSES.has(sel.status);
export const isAnswerable = (sel) => !!sel && ANSWER_STATUSES.has(sel.status) && sel.sources.length > 0;

/**
 * A launched bot's scope, read off its retriever (one knowDrive retriever, or a linked set of them, one per bucket):
 * {store, scopes:[{tags_all, tags_none}], parts}. null when any part is not a tag-scoped knowDrive search (the local
 * corpus, a custom retriever): such a bot keeps its search path.
 */
export function scopesFromRetriever(retriever) {
  const parts = Array.isArray(retriever?.parts) ? retriever.parts.map((p) => p?.retriever) : [retriever];
  if (!parts.length || parts.some((r) => !r || !Array.isArray(r.allOf) || !Array.isArray(r.exclude) || !r.store || !r.allOf.length)) return null;
  const store = parts[0].store;
  if (parts.some((r) => r.store !== store)) return null;
  return { store, scopes: parts.map((r) => ({ tags_all: [...r.allOf], tags_none: [...r.exclude] })), parts };
}

/**
 * The selector's evidence for a launched bot, as retriever results (file names relative to the bucket folder, as its
 * retriever reports them). null: keep the search path.
 * @returns {Promise<null | { status: string, results: object[], receipt: object, ms: number }>}
 */
export async function selectForRetriever(evidence, retriever, question, { signal } = {}) {
  if (!evidence) return null;
  const sc = scopesFromRetriever(retriever);
  if (!sc) return null;
  const sel = await evidence.select({ store: sc.store, question, scopes: sc.scopes, signal }).catch(() => null);
  if (!sel || (!isRefusal(sel) && !isAnswerable(sel))) return null;
  const prefixes = sc.parts.map((r) => ({ prefix: String(r.prefix || ''), strict: r.prefixFilter !== false }));
  const results = sel.sources.flatMap((s) => {
    const full = String(s.path || '').replace(/^\/+/, '');
    const p = prefixes.find((x) => x.prefix && full.startsWith(x.prefix));
    // a full path outside every strict folder is not this bot's (a bare name: the dir: tags already fenced it)
    if (!p && full.includes('/') && prefixes.every((x) => x.strict && x.prefix)) return [];
    const filename = p ? full.slice(p.prefix.length) : full;
    return filename ? [{ ...s, filename, evidence: true }] : [];
  });
  if (isAnswerable(sel) && !results.length) return { ...sel, status: 'none_in_window', results: [] };
  return { ...sel, results };
}

/** The content hash of the evidence passage a quote came from (its file, the passage holding its words), or null. */
export function hashFor(sources = [], fileId, quote) {
  const fold = (t) => String(t || '').replace(/[“”"‘’']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const q = fold(quote).replace(/…$/, '').slice(0, 120);
  const mine = sources.filter((s) => s.file_id === fileId && s.content_hash);
  const hit = (q && mine.find((s) => fold(s.text).includes(q))) || (mine.length === 1 ? mine[0] : null);
  return hit ? hit.content_hash : null;
}

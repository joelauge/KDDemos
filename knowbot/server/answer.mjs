// The ONE answer pipeline every surface asks through: the Studio's trial ask (POST /api/studio/trials/:id/ask), the
// developer API and AI agents (/v1/bots/:id/ask, /chat, MCP), the channels (SMS, WhatsApp, email, voice, phone), the
// website chat widget (/v1/bots/:id/web) and /api/canonical. Studio trial bots and live bots differ only in their
// retrieval adapter (server/trials.mjs trialAdapter, server/devapi.mjs liveAdapter); everything after the search is here:
//
//   guard → search (the question at once; the hidden rewrite + alternative phrasings in parallel, fused when they arrive,
//   skipped when the question's own search clears the floor confidently) → floor refusal → select (research agent, else
//   the line selector, keyword fallback) → keep relevant lines → citation gate → table interpretation (only when the
//   cited lines are table rows) → verdict (in parallel, capped; never on voice/SMS/phone) → product cards → proof.
//
// A failure past the search is logged with its step and a short reference and recovered to the fixed refusal (the
// honest answer for the visitor); a failure before it throws AnswerError {step, ref}. The result carries per-step
// timings (ms): rewrite, search, select, interpret, verdict, products, total.
import { randomBytes } from 'node:crypto';
import * as kbLib from '../lib/knowbot.js';
import { isRefusal } from './evidence.mjs';
import { findOffset, keepRelevantLines, LINE_MARGIN, citeQuotedLines, quotedLineParts, answerCheck, locatorOf, isDerivedLine } from './trials.mjs';

const clip = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).replace(/\s+\S*$/, '')}…`; };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const round4 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10000) / 10000);
const pct = (x) => (x == null ? null : Math.round(Number(x) * 100));
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }, { once: true }); });
const voiceQuote = (t) => String(t ?? '').replace(/…$/, '').replace(/\s*[.;:,]?\s*$/, '').replace(/“/g, '‘').replace(/”/g, '’');
const normQ = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}$€£]+/gu, ' ').trim();
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); t.unref?.(); })]);
const rawOf = (out) => (typeof out === 'string' ? out : String(out?.raw ?? out?.text ?? out?.choices?.[0]?.message?.content ?? ''));

/** Spoken and texted surfaces: the verdict only changes the closing follow-up, which they never wait for. */
export const NO_VERDICT_CHANNELS = new Set(['voice', 'phone', 'sms', 'whatsapp', 'webvoice']);
/** How long a grounded answer waits for its verdict on the other surfaces (it runs beside product cards and proof). */
export const VERDICT_CAP_MS = 1500;
/** The question's own search clears the floor by this much: no hidden rewrite and no alternative searches. */
export const CONFIDENT_MARGIN = 0.1;
export const SELECT_TIMEOUT_MS = 20000;
const PRE_SEARCH = new Set(['start', 'embed', 'search']);

export class AnswerError extends Error {
  constructor(step, ref, message) { super(message); this.name = 'AnswerError'; this.step = step; this.ref = ref; }
}
export const emptyProof = (floor) => ({ quotedLines: [], claims: [], verified: { claims: 0, verified: 0 }, unsupported: 0, candidates: 0, picked: [], floor });

/**
 * @param {object} o
 * @param {string} o.question
 * @param {Array} [o.history]        the thread's last exchanges (only to understand a follow-up, never a source)
 * @param {object} o.persona         {name, org, instructions}
 * @param {number} o.floor           the relevance floor the answer is gated on (0: the retriever already applied its own)
 * @param {object} o.adapter         retrieval for one bot: { retrieve(q, {variant, signal}) → {vector, hybridOnly, top, receipt?},
 *                                   expandable?, evidence?(q, signal), resolveAtoms?(hits), sources(hits) → {sources, srcHit},
 *                                   fileName(id), searched() → {atoms, files}, products?({text, cites}), expected?(q), closeMiss?(top, q) }
 * @param {Function} o.complete      (messages, settings) → string | {raw, model}: select, table interpretation, verdict
 * @param {Function} [o.rewrite]     the hidden query rewrite's model call (null: the deterministic rules)
 * @param {number} [o.variants]      alternative phrasings (0: off)
 * @param {Function} [o.research]    the research agent (null: the select path)
 * @param {string} [o.channel]       studio | api | agent | web | sms | whatsapp | email | voice | phone | site …
 * @param {string} [o.mode]          select (default) | generate (a live bot that opted into free generation)
 * @param {Function} [o.onEvent]     (event, data): status, retrieval, research, lines, selected, delta
 * @param {number} [o.paceMs]        per-line delta pacing (the Studio: 40 ms); 0 sends deltas at once
 * @returns {Promise<object>} the final answer (Studio shape) + timings
 */
export async function runAnswer(o) {
  const { question, persona, adapter: A, complete, signal } = o;
  const floor = Number(o.floor) || 0;
  const channel = o.channel || 'studio';
  const log = o.log || (() => {});
  const onEvent = o.onEvent || (() => {});
  const mode = o.mode === 'generate' ? 'generate' : 'select';
  const voice = o.voice ?? true;
  const history = kbLib.normalizeHistory(Array.isArray(o.history) ? o.history : []);
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const T = { rewrite: 0, search: 0, select: 0, interpret: 0, verdict: 0, products: 0 };
  const base = { question };
  let stage = 'start';
  const emit = (event, data) => {
    if (event === 'status' && data?.step) { stage = data.step; if (o.faultAt === stage) throw new Error(`injected fault at ${stage}`); } // tests only
    if (!signal?.aborted) onEvent(event, data);
  };
  const done = (final) => {
    const out = { ...final, timings: { ...T, total: ms() } };
    log(`[answer] ${channel} ${out.status} ${JSON.stringify(out.timings)}`);
    return out;
  };
  const aborted = () => !!signal?.aborted;
  let lastRetrieval = null, keptHits = [];
  const hidden = (final) => {
    Object.defineProperty(final, 'retrieval', { value: lastRetrieval, enumerable: false, configurable: true });
    Object.defineProperty(final, 'hits', { value: keptHits, enumerable: false, configurable: true });
    return final;
  };
  try {
    // 1. guard
    const g = kbLib.guardRequest(question, persona, { profile: o.profile || 'general' });
    if (g) {
      lastRetrieval = { ms: 0, guard: g.guard || 'guard', floor: { min: null, top: null }, hits: [] };
      return hidden(done({ ...base, text: g.text, refused: true, status: 'guard', citations: [], proof: emptyProof(floor), why: null, guard: g.guard || 'guard',
        latencyMs: { retrieve: 0, select: 0, quote: 0, total: ms() } }));
    }
    // 2. search: the question as asked goes out at once; the hidden rewrite (the follow-up made to stand alone plus
    // alternative phrasings) runs beside it and its searches are fused in only when the question's own search did not
    // clear the floor confidently (a follow-up always waits for its standalone form)
    emit('status', { step: 'embed', t: ms() });
    const tS0 = performance.now();
    const variants = Math.max(0, Math.min(4, Number(o.variants) || 0));
    const exAc = new AbortController();
    signal?.addEventListener?.('abort', () => exAc.abort(), { once: true });
    const exP = variants && A.expandable !== false
      ? kbLib.expandQuery({ question, history, complete: o.rewrite || null, signal: exAc.signal, variants }).catch(() => null) : null;
    // the rewrite's time counts only when the answer waited for it (how long after the question's own search it arrived)
    const awaitRewrite = async () => { const w0 = performance.now(); const x = await exP; T.rewrite = Math.round(performance.now() - w0); return x; };
    emit('status', { step: 'search', t: ms() });
    let ex = null, standalone = question, sel = null;
    // the evidence selector, when on and answering, replaces the search (and the research agent's search tool); it
    // takes one question, so a follow-up gives it the standalone one
    if (A.evidence) {
      if (history.length && exP) { ex = await awaitRewrite(); standalone = ex?.standalone || question; }
      sel = await A.evidence(standalone, signal);
      if (sel) exAc.abort();
    }
    if (aborted()) return null;
    let receipt = sel?.receipt?.digest ? { digest: sel.receipt.digest } : null;
    const searched = A.searched ? A.searched() : { atoms: 0, files: 0 };
    const fileName = (id) => (A.fileName ? A.fileName(id) : '') || '';
    if (sel && isRefusal(sel)) {
      exAc.abort();
      T.search = Math.round(performance.now() - tS0);
      lastRetrieval = { ms: ms(), searched, floor: { min: floor, top: 0 }, hits: [] };
      emit('retrieval', lastRetrieval);
      return hidden(done({ ...base, text: kbLib.NOT_IN_DATA, refused: true, status: 'refused', citations: [], proof: { ...emptyProof(floor), candidates: 0, ...(receipt ? { receipt } : {}) },
        why: { best: 0, floor, candidates: [], reason: sel.status === 'underspecified' ? 'the question names nothing to look for' : 'nothing in the files answers the question' },
        closeMiss: null, guard: null, latencyMs: { retrieve: ms(), select: 0, quote: 0, total: ms() } }));
    }
    let r, ways = 1;
    if (sel) r = { vector: sel.hits, hybridOnly: [], top: floor, receipt: null };
    else {
      const main = await A.retrieve(question, { signal });
      const confident = !history.length && (main.top ?? 0) >= floor + CONFIDENT_MARGIN && (main.vector || []).length > 0;
      if (!ex && exP && !confident) ex = await awaitRewrite();
      if (confident || !ex) { exAc.abort(); r = main; }
      else {
        standalone = ex.standalone || question;
        const alts = (ex.queries || []).filter((q) => normQ(q) !== normQ(question) && normQ(q) !== normQ(standalone));
        // the follow-up's standalone form gets the full search; each alternative one variant search; all in parallel
        const [own, ...more] = await Promise.all([normQ(standalone) !== normQ(question) ? A.retrieve(standalone, { signal }).catch(() => null) : null,
          ...alts.map((q) => A.retrieve(q, { signal, variant: true }).catch(() => null))]);
        const first = own || main;
        const keyOf = (h) => h.atomId || `${h.fileId}|${h.seq}|${oneLine(h.text).slice(0, 200)}`;
        const lists = [first.vector, ...(own ? [main.vector] : []), ...more.filter(Boolean).map((x) => x.vector)];
        const vector = lists.length > 1 ? kbLib.fuseKept(lists, { k: 6, keep: (h) => (h.similarity ?? 0) >= floor, keyOf, copy: false, fill: ex.source !== 'model' }) : first.vector;
        const inV = new Set(vector.map(keyOf));
        const hybridOnly = (first.hybridOnly || []).filter((h) => !inV.has(keyOf(h)));
        const known = vector.map((h) => h.similarity).filter((x) => typeof x === 'number');
        const top = known.length ? Math.max(...known) : vector.length ? first.top ?? null : 0;
        r = { ...first, vector, hybridOnly, top, receipt: first.receipt || null };
        ways = 1 + (own ? 1 : 0) + alts.length;
      }
    }
    if (aborted()) return null;
    if (!receipt && r.receipt) receipt = { digest: r.receipt };
    T.search = Math.round(performance.now() - tS0);
    const tRet = ms();
    // 3. keep: up to six hits above the floor, then up to three keyword-only hits
    const top = r.top ?? 0;
    const above = sel ? [...sel.hits] : (r.vector || []).filter((h) => (h.similarity ?? 0) >= floor).slice(0, 6);
    const kept = [...above];
    if (!sel && top >= floor) for (const h of (r.hybridOnly || []).filter((x) => x.hybridRank <= 3)) if (kept.length < 6) { h.keyword = true; kept.push(h); }
    const shown = [...kept, ...(r.vector || []).filter((h) => !kept.includes(h)), ...(r.hybridOnly || []).filter((h) => !kept.includes(h))].slice(0, sel ? kept.length : 12);
    if (!sel && A.resolveAtoms) await A.resolveAtoms(shown);
    keptHits = kept;
    const hitView = (h, i) => ({
      rank: i + 1, fileId: h.fileId, file: fileName(h.fileId), atomId: h.atomId ?? null, seq: h.seq ?? null, similarity: h.similarity == null ? null : round4(h.similarity),
      rrf: h.rrf == null ? null : round4(h.rrf), match: pct(h.similarity), label: h.evidence ? 'selected passage' : h.similarity == null ? 'keyword match' : 'match',
      excerpt: clip(oneLine(h.text), 240), kept: kept.includes(h), locator: locatorOf(h, h.atomsTotal), ...(h.title ? { title: h.title } : {}),
    });
    emit('status', { step: 'rank', t: ms() });
    // ways: how many phrasings were searched (the Proof trace's "searched N ways"); never in the visitor's answer
    // a launched bot's retriever applies its own floor (floorMin); the gate here is then 0
    lastRetrieval = { ms: tRet, searched: { ...searched, ...(ways > 1 ? { ways, waysMs: T.rewrite + T.search } : {}) }, floor: { min: r.floorMin !== undefined ? r.floorMin : floor, top: r.top == null ? null : round4(top) }, hits: shown.map(hitView) };
    emit('retrieval', lastRetrieval);
    const candidatesOf = () => (r.vector || []).slice(0, 5).map((h) => ({ file: fileName(h.fileId), similarity: round4(h.similarity ?? 0), match: pct(h.similarity), excerpt: clip(oneLine(h.text), 200) }));
    const closeMiss = (best) => (A.closeMiss ? A.closeMiss(best, question) : null);
    // 4. floor refusal
    if (top < floor || !kept.length) {
      return hidden(done({ ...base, text: kbLib.NOT_IN_DATA, refused: true, status: 'refused', citations: [], proof: { ...emptyProof(floor), candidates: 0, ...(receipt ? { receipt } : {}) },
        why: { best: round4(top), floor, candidates: candidatesOf() }, closeMiss: closeMiss(top), guard: null, latencyMs: { retrieve: tRet, select: 0, quote: 0, total: ms() } }));
    }
    // 5. select
    let { sources, srcHit } = await A.sources(kept);
    // each source remembers its hit (non-enumerable): research can add sources from new searches
    const tagHits = (src, hits) => src.forEach((x, i) => Object.defineProperty(x, '_hit', { value: hits[i], enumerable: false, configurable: true }));
    tagHits(sources, srcHit);
    let lines = kbLib.candidateLines(sources);
    // a line whose passage lost its hit (never expected) is shown without a place rather than failing the answer
    const lineView = (l) => {
      const h = srcHit[l.source] || { text: '' };
      const derived = isDerivedLine(l.text) && !String(h.text || '').includes(l.text.replace(/…$/, ''));
      return { L: l.n, fileId: h.fileId ?? null, atomId: h.atomId ?? null, text: clip(l.text, 320), offset: derived ? null : findOffset(String(h.text || ''), l.text), derived };
    };
    emit('status', { step: 'select', t: ms() });
    const tSel0 = performance.now();
    let raw = '', model = 'keyword-fallback', rfin = null, fin0 = null;
    const routed = mode === 'select' ? kbLib.routeAnswer(standalone, sources, { voice }) : null;
    if (mode === 'generate') {
      // a live bot that opted into free generation: the library's generate path (finalizeAnswer checks support)
      const g2 = await kbLib.answerFromSources({ question, standalone, results: sources, complete: (m, c) => complete(m, c?.settings), persona, minScore: 0, k: 6, history: o.history || [], mode: 'generate', settings: o.settings, voice, signal });
      fin0 = { ...g2.fin, selected: [] };
      model = 'generate';
    } else if (routed) { fin0 = { ...routed, selected: routed.selected || [] }; model = 'route'; }
    if (!fin0 && o.research) {
      // research first: reads whole passages, may search the files again (not when the selector chose the evidence)
      const searchMore = sel ? undefined : async (q) => {
        const r2 = await A.retrieve(q, { signal });
        const hits = [...(r2.vector || []).filter((h) => (h.similarity ?? 0) >= floor * 0.85).slice(0, 8), ...(r2.hybridOnly || []).filter((x) => x.hybridRank <= 3)];
        if (A.resolveAtoms) await A.resolveAtoms(hits);
        const got = await A.sources(hits);
        tagHits(got.sources, got.srcHit);
        return got.sources;
      };
      rfin = await kbLib.researchAnswer({ question, standalone, history, sources, search: searchMore, searchTool: !sel, agent: o.research, persona, voice, k: 8, signal,
        onEvent: (e) => { if (e.type === 'search') emit('research', { query: e.query, t: ms() }); else if (e.type === 'error') log(`[answer] research failed: ${e.message}`); } })
        .catch((e) => { log(`[answer] research failed: ${e?.message}`); return null; });
      if (aborted()) return null;
      if (rfin) {
        // a research answer of "not found" (found:false, or no quote it named was a real line) carries no passages:
        // it is the refusal, and the search's own lines stay for the trace (before: sources.map on undefined threw
        // at step "select", and the answer was recovered to the refusal with a failure reference)
        if (Array.isArray(rfin.sources) && Array.isArray(rfin.allLines)) { sources = rfin.sources; srcHit = sources.map((x) => x._hit); lines = rfin.allLines; }
        model = o.research.model || 'research';
        const { lines: _l, allLines: _a, sources: _s, ...rest } = rfin;
        fin0 = rest;
      }
    }
    emit('lines', { count: lines.length, items: lines.slice(0, 12).map(lineView) });
    if (!fin0) {
      try {
        const out = await withTimeout(Promise.resolve(complete(kbLib.buildSelectMessages(standalone, lines, persona, { history, asked: question }), { ...kbLib.SELECT_SETTINGS })), SELECT_TIMEOUT_MS);
        raw = rawOf(out); model = (out && typeof out === 'object' && out.model) || 'select';
      } catch (e) { raw = ''; model = 'keyword-fallback'; log(`[answer] select failed (${e.message}); keyword fallback`); }
      if (aborted()) return null;
      fin0 = kbLib.finalizeSelection(raw, lines, sources, { question: standalone, voice });
      if (fin0.fallback) model = 'keyword-fallback';
      // keep only lines that answer the question themselves (within LINE_MARGIN of the best selected line); research
      // picks spans on purpose (a name line and its price line), so they are kept as chosen
      if (!fin0.refused && (fin0.selected || []).length > 1) {
        const keep = keepRelevantLines(standalone, fin0.selected, (L) => lines[L - 1]?.text || '', (L) => srcHit[lines[L - 1]?.source]?.similarity ?? floor, LINE_MARGIN,
          { isIntro: (L) => { const h = srcHit[lines[L - 1]?.source]; return !!h && Number(h.seq) <= 2 && !!h.crumb && !h.crumb.includes(' > '); } });
        if (keep.length && keep.length < fin0.selected.length) {
          const fb = fin0.fallback;
          fin0 = { ...kbLib.finalizeSelection(keep.map((L) => `L${L}`).join(', '), lines, sources, { question: standalone, voice }), fallback: fb };
        }
      }
    }
    T.select = Math.round(performance.now() - tSel0);
    emit('selected', { lines: fin0.selected ?? [], ms: T.select, model, ...(fin0.research ? { research: fin0.research } : {}), ...(fin0.summary ? { summary: true } : {}) });
    // 6. quote: the citation gate, then a plain sentence for table rows
    emit('status', { step: 'quote', t: ms() });
    const tQ0 = performance.now();
    let fin = citeQuotedLines(fin0, kbLib.requireCitations);
    if (!fin.refused && !fin0.summary && mode === 'select') {
      const tI0 = performance.now();
      const t = await kbLib.interpretTabular({ fin: { ...fin, selected: fin0.selected }, lines, sources, question, ask: standalone, persona, complete: (m, st) => complete(m, st) });
      T.interpret = Math.round(performance.now() - tI0);
      if (aborted()) return null;
      if (t.tabular) { fin = t; fin0 = { ...fin0, summary: t.summary, tabular: true }; }
    }
    if (fin.refused) {
      return hidden(done({ ...base, text: kbLib.NOT_IN_DATA, refused: true, status: 'refused', citations: [], proof: { ...emptyProof(floor), candidates: lines.length, ...(receipt ? { receipt } : {}) },
        why: { best: round4(top), floor, candidates: candidatesOf(), reason: 'no line answered the question' }, closeMiss: closeMiss(top), guard: null,
        latencyMs: { retrieve: tRet, select: T.select, quote: 0, total: ms() } }));
    }
    // the verdict (does it answer the core question?) only sets the closing follow-up: it runs beside the product cards
    // and the proof, capped; spoken and texted answers never wait for it
    const tV0 = performance.now();
    const verdictP = mode === 'select' && kbLib.judgeAnswer && !NO_VERDICT_CHANNELS.has(channel)
      ? kbLib.judgeAnswer({ complete: (m, st) => complete(m, st), question: standalone, text: fin.text, timeoutMs: VERDICT_CAP_MS }).then((v) => { T.verdict = Math.round(performance.now() - tV0); return v; })
      : null;
    const quotes = [];
    for (const L of fin0.selected || []) {
      const line = lines[L - 1];
      if (!line) continue;
      const h = srcHit[line.source], src = sources[line.source];
      if (!h || !src) continue;   // a line whose passage lost its search hit is never quoted (never a crash)
      const c = fin.citations.find((x) => x.file_id === src.file_id);
      if (!c) continue;
      const lv = lineView(line);
      quotes.push({ n: c.n, L, text: line.text, fileId: h.fileId, file: src.filename, atomId: h.atomId ?? null, seq: h.seq ?? null, offset: lv.offset, derived: lv.derived, hit: h, ...(h.contentHash ? { contentHash: h.contentHash } : {}) });
    }
    // product cards: started now, beside the verdict (a photo lookup gets that time), awaited before the final
    const tP0 = performance.now();
    const productsP = A.products && o.cards !== false ? Promise.resolve(A.products({ text: fin.text, cites: fin.citations.map((c) => ({ n: c.n, url: c.url, fileId: c.file_id })), sources }))
      .catch((e) => { log(`[answer] product cards failed: ${e.message}`); return []; }).then((p) => { T.products = Math.round(performance.now() - tP0); return p || []; }) : Promise.resolve([]);
    const verdict = verdictP ? await verdictP : null;
    if (aborted()) return null;
    if (verdict) fin = kbLib.applyVerdict(fin, verdict);
    const outLines = String(fin.text).split('\n').filter((l) => l.trim());
    // proof claims: the cited lines only (a courtesy opener/closer is not a claim, and a "Here's what “X” says [1]:"
    // pointer line only names the place), each matched to its quote by marker and quoted text, never by position
    const claimLines = outLines.map((l) => quotedLineParts(l)).filter((x) => !x.courtesyOnly && /\[\d{1,3}\]/.test(x.body) && !/\[\d{1,3}\]:\s*$/.test(x.body));
    // an interpreted table answer states the row in its own words (verified), so its cells are not unsupported claims
    const unsupported = fin0.tabular || mode === 'generate' || routed ? 0 : Math.max(0, (fin0.selected || []).length - claimLines.length);
    // the answer's lines as they go out (the Studio paces them, 40 ms per line: presentation, not generation)
    for (const l of outLines) {
      if (aborted()) break;
      emit('delta', { text: l.replace(/^\s*-\s+/, '').replace(/\s*\[\d{1,3}\]/g, '').trim(), n: [...l.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])) });
      if (o.paceMs) await sleep(o.paceMs, signal);
    }
    const citations = fin.citations.map((c) => {
      const qs = quotes.filter((q) => q.n === c.n);
      const h = qs[0]?.hit || srcHit.find((x) => x && x.fileId === c.file_id);
      return { n: c.n, fileId: c.file_id, file: c.filename, title: c.title, ...(c.url ? { url: c.url } : {}), ...(c.page ? { page: c.page } : {}), ...(c.section ? { section: c.section } : {}), atomId: h?.atomId ?? null, seq: h?.seq ?? null, excerpt: clip(oneLine(h?.text || c.snippet || ''), 240),
        offset: qs[0]?.offset ?? null, locator: h ? locatorOf(h, h.atomsTotal) : null, similarity: h?.similarity == null ? null : round4(h.similarity), match: pct(h?.similarity),
        quotes: qs.map((q) => ({ L: q.L, text: q.text, offset: q.offset, derived: q.derived })) };
    });
    const usedQ = new Set();
    const summaryText = fin0.summary ? String(fin0.summary).trim() : null;
    const claims = claimLines.map((x) => {
      const l = x.body;
      const bare = (t) => String(t).replace(/\s*\[\d{1,3}\]/g, '').replace(/\s+/g, ' ').trim();
      if (summaryText && bare(l) === bare(summaryText)) {
        const sn = Number(/\[(\d{1,3})\]/.exec(l)?.[1] ?? 0) || null;
        return { sentence: l.replace(/^\s*-\s+/, '').replace(/\s*\[\d{1,3}\]/g, '').trim(), n: sn, quote: null, file: null, locator: null, summary: true,
          verified: true, check: 'every number, price, date and name in it is in the quoted lines' };
      }
      const nn = Number(/\[(\d{1,3})\]/.exec(l)?.[1] ?? 0) || null;
      const flat = l.replace(/“/g, '‘').replace(/”/g, '’');
      const has = (q) => { const t = voiceQuote(q.text); return !!t && (flat.includes(t.slice(0, 60)) || l.includes(q.text.replace(/…$/, '').slice(0, 40))); };
      const q = quotes.find((y) => !usedQ.has(y) && y.n === nn && has(y)) || quotes.find((y) => !usedQ.has(y) && has(y));
      if (q) usedQ.add(q);
      return { sentence: l.replace(/^\s*-\s+/, '').replace(/\s*\[\d{1,3}\]/g, '').trim(), n: nn ?? q?.n ?? null, quote: q?.text ?? null, file: q?.file ?? null,
        locator: q ? locatorOf(q.hit, q.hit.atomsTotal) : null, verified: !!q && (q.offset != null || q.derived) };
    });
    const quotedLines = quotes.map((q) => ({ n: q.n, L: q.L, text: q.text, file: q.file, fileId: q.fileId, atomId: q.atomId, offset: q.offset, ...(q.contentHash ? { contentHash: q.contentHash } : {}) }));
    // the Proof Run checks the answer says what was asked (sample questions carry expected substrings)
    const check = answerCheck(question, quotes.map((q) => q.text), A.expected ? await A.expected(question) : null);
    const products = await productsP;
    const tQ = Math.round(performance.now() - tQ0);
    return hidden(done({ ...base, text: fin.text, refused: false, status: 'grounded', citations, check, ...(verdict ? { verdict } : {}), ...(products.length ? { products } : {}),
      proof: { quotedLines, claims, verified: { claims: claims.length, verified: claims.filter((c) => c.verified).length }, unsupported, candidates: lines.length, picked: fin0.selected || [], floor, ...(receipt ? { receipt } : {}) },
      why: null, guard: null, model, latencyMs: { retrieve: tRet, select: T.select, quote: tQ, total: ms() } }));
  } catch (e) {
    if (aborted()) return null;
    // every failure is logged with its step and a short reference the owner sees, so it can be traced
    const ref = randomBytes(4).toString('hex');
    log(`[answer] failed ref=${ref} channel=${channel} step=${stage}: ${e?.stack || e?.message || e}`);
    // past the search, a failure means the matches couldn't be turned into an answer: the honest result for the
    // visitor is "not in our files" (what a weak match gets anyway), with the reference for the owner
    if (!PRE_SEARCH.has(stage) && !e?.noRecover) {
      return hidden(done({ ...base, text: kbLib.NOT_IN_DATA, refused: true, status: 'refused', citations: [], proof: emptyProof(floor), why: null, guard: null,
        failure: { step: stage, ref, recovered: true }, latencyMs: { total: ms() } }));
    }
    const err = new AnswerError(stage, ref, e?.message || String(e));
    err.cause = e;
    throw err;
  }
}

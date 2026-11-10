#!/usr/bin/env node
// Evaluates KnowBot's evidence paths on real questions against REAL KnowDrive, READ-ONLY (it only searches and reads;
// nothing is written or deleted). Not part of CI.
//
// Arms, per question:
//   A  today's path: the trial search (vector 12 + hybrid 8 under the trial's tag filter, the narrow-filter hybrid
//      fallback, clause decomposition for multi-part questions, similarity floor, at most 6 kept + top-3 keyword hits)
//   B  the evidence selector (attendd) with KnowDB's server-side hybrid search      (ATTENDD_FUSION off)
//   C  the evidence selector (attendd) with the engine's client-side fused ranking  (ATTENDD_FUSION=on)
//   B20 B with query_limit 20 (one run), to see what the smaller window costs
//   D  resolve mode (KNOWBOT_EVIDENCE=resolve): attendd's POST /resolve, the engine's ranked search WITHOUT attend
//      (server-side hybrid), in place of the trial search only; then today's keep step (similarity floor, at most 6
//      kept + top-3 keyword hits) and answer step, exactly as arm A (server/trials.mjs resolvedRetrieval)
//   E  D with the engine's client-side fused ranking (ATTENDD_FUSION=on)
// B, C, D and E run each question twice and compare the digest and the passage order (determinism).
// --arms picks the arms (default A,D,E; B, C and B20 are the attend arms of the first run).
//
// The answer key (expected fact as regexes + expected source files) was written by reading the bots' files before
// any arm was run. Retrieval metrics: rank of the first passage holding the expected fact, expected file in the top
// 3/5 passages; for B/C also the same with H-section's passages removed (= section off). Weak matches are answered
// both ways (KNOWBOT_EVIDENCE_WEAK=refuse, the default, and =answer).
//
// Answer step (--answer):
//   keyword  (default) KnowBot's deterministic keyword selector (lib answerFromSources, mode select; no model)
//   haiku    the REAL research step, as production runs it for each arm (server/trials.mjs ask path): lib researchAnswer
//            with the research agent (server/research.mjs, claude-haiku-5-5 unless KNOWBOT_RESEARCH_MODEL says otherwise,
//            effort low), voice on, k 8, over the kept passages; for A, D and E with its search_files tool backed by that
//            arm's own retrieve (today's searches for A, /resolve for D and E; hits at 0.85 x floor, at most 8, plus
//            the top-3 keyword hits), for B and C with no search tool (the selector chose the passages). Then
//            citeQuotedLines, as production does. A failed research call falls back to the keyword selector (counted).
//            Needs ANTHROPIC_API_KEY (KNOWBOT_ANTHROPIC_BASE_URL points it at a fake for tests). The report adds the
//            agent's token use per arm.
// Each answer is judged against the answer key: correct (the quoted text holds every expected fact), partial (some),
// wrong answer (none), wrong refusal; off-topic: refused or answered; plus whether a cited file is an expected one.
//
// Usage (two attendd instances on the loopback, one with ATTENDD_FUSION=on):
//   KNOWDRIVE_API_KEY=… node scripts/evidence-eval.mjs [--arms A,D,E] [--hybrid http://127.0.0.1:7181] [--fusion http://127.0.0.1:7182]
//     [--bots ugm,wyrmwood] [--only u1,w3] [--runs 2] [--answer keyword|haiku] [--json out.json] [--md out.md]
//   --runs: runs per question for B, C, D, E (default 2; the determinism columns need 2)
import { writeFileSync } from 'node:fs';
import * as lib from '../lib/knowbot.js';
import { normHit, questionClauses, resolvedRetrieval, citeQuotedLines } from '../server/trials.mjs';
import { mergeBundles, spanToDoc, combineDigests } from '../server/evidence.mjs';

const args = process.argv.slice(2);
const opt = (name, d = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const base = String(process.env.KNOWDRIVE_BASE_URL || 'https://knowdrive.ai').replace(/\/+$/, '');
const key = process.env.KNOWDRIVE_API_KEY;
const STORE = 'vs_97c857474b1f4e8892b134c283cf9849';
const FLOOR = 0.7;
const EXCLUDE = ['kind:trial-spec', 'kind:config', 'questions'];
const URLS = { B: opt('hybrid', 'http://127.0.0.1:7181'), C: opt('fusion', 'http://127.0.0.1:7182') };
// resolve arms: attendd's /resolve on the same two instances (server hybrid / client fusion)
URLS.D = URLS.B; URLS.E = URLS.C;
const ARMS = (opt('arms') || 'A,D,E').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const ANSWER = String(opt('answer', 'keyword')).toLowerCase();
const RUNS = Math.max(1, Number(opt('runs', 2)) || 2);
if (!key) { console.error('KNOWDRIVE_API_KEY is not set'); process.exit(2); }
if (!['keyword', 'haiku'].includes(ANSWER)) { console.error(`--answer ${ANSWER}: keyword or haiku`); process.exit(2); }
if (ARMS.some((a) => !['A', 'B', 'C', 'B20', 'D', 'E'].includes(a))) { console.error(`--arms ${ARMS}: A, B, C, B20, D, E`); process.exit(2); }

// ------------------------------------------------------------------------------------------------ the answer key
// type: policy | price | service | staff | paraphrase | multi | offtopic. keys: every one must be quoted for a correct
// answer (the first locates "the passage holding the answer"). files: path suffixes of the files that hold it.
const BOTS = {
  ugm: {
    name: 'The Ultimate Game Master', trial: 'tr_6ajxk3z2gxkzrbwi',
    questions: [
      { id: 'u1', type: 'policy', q: 'What is your return policy?', keys: ['30[- ](day|night)'], files: ['policy/refund-policy.md', 'faq/avada-faqs.md'], note: '30 days after receiving the item (FAQ: 30-night risk-free return)' },
      { id: 'u2', type: 'price', q: 'How much is the Tales of the Valiant Rules Pack?', keys: ['30\\.00'], files: ['tales-of-the-valiant-rules-pack.md'], note: '$30.00 USD' },
      { id: 'u3', type: 'policy', q: 'How quickly do you ship orders?', keys: ['2 business days|24 hours'], files: ['policy/shipping-policy.md', 'faq/avada-faqs.md'], note: 'within 2 business days (FAQ: in-stock within 24 hours)' },
      { id: 'u4', type: 'policy', q: 'Do you ship outside the United States?', keys: ['weight'], files: ['policy/shipping-policy.md'], note: 'yes, weight-based shipping anywhere else, calculated at checkout' },
      { id: 'u5', type: 'policy', q: 'Can I return a gift card?', keys: ['sale items or gift cards'], files: ['policy/refund-policy.md'], note: 'no: no returns on sale items or gift cards' },
      { id: 'u6', type: 'multi', q: 'What does the Magnetic Dice Tray cost and how big is it?', keys: ['29\\.99', '9\\.84'], files: ['ugms-magnetic-dice-tray.md'], note: '$29.99; 9.84 x 7.28 inches' },
      { id: 'u7', type: 'staff', q: 'Who teaches the Dungeon Masterclass course?', keys: ['Jason Azevedo'], files: ['game-master-foundations-online-course.md', 'page/dungeon-masterclass.md'], note: 'Jason Azevedo of RealmSmith' },
      { id: 'u8', type: 'paraphrase', q: "Where do I mail stuff to if I'm sending it back?", keys: ['13665'], files: ['policy/refund-policy.md', 'help/contact-information.md'], note: '13665 E 42 Terr S, Ste F, Independence, Missouri 64055' },
      { id: 'u9', type: 'paraphrase', q: 'I ordered the wrong thing. Can I just swap it for a different one?', keys: ['separate purchase'], files: ['policy/refund-policy.md'], note: 'return it, then make a separate purchase for the new item' },
      { id: 'u10', type: 'multi', q: "What discount do shops get for stocking your products, and what's the minimum order?", keys: ['25%|40%|50%', '\\$500|\\$1,000|\\$1,500'], files: ['page/wholesale.md'], note: 'tiers 25/40/50% off, minimums $500/$1,000/$1,500' },
      { id: 'u11', type: 'price', q: 'How much is a seat in the Wednesday Everlasting Rime campaign?', keys: ['50\\.00'], files: ['the-everlasting-rime-wednesday.md'], note: '$50.00 USD' },
      { id: 'u12', type: 'service', q: 'What comes in the box with the screen?', keys: ['12 blank magnetic charts'], files: ['faq/avada-faqs.md'], note: '4-panel screen, 12 blank magnetic charts, 4 rivet magnets, magnetic clasp' },
      { id: 'u13', type: 'policy', q: 'How long does a refund take to reach my card?', keys: ['10 business days'], files: ['policy/refund-policy.md'], note: 'refunded to the original payment method within 10 business days' },
      { id: 'u14', type: 'offtopic', q: 'What is the capital of Australia?', keys: [], files: [], note: 'refuse' },
      { id: 'u15', type: 'offtopic', q: 'Can you recommend a good pizza place in Independence, Missouri?', keys: [], files: [], note: 'refuse (shares words with the return address)' },
    ],
  },
  wyrmwood: {
    name: 'Wyrmwood Help', trial: 'tr_fpfsjztz7h7insy6',
    questions: [
      { id: 'w1', type: 'policy', q: 'Do you offer a military discount?', keys: ['standing discount|temporary promotions'], files: ['26115689444763-discounts.md'], note: 'no standing discount programs (military, seniors, …); only temporary promotions' },
      { id: 'w2', type: 'policy', q: 'Do your gift certificates expire?', keys: ['never expire'], files: ['26148615958939-gift-certificates.md'], note: 'never expire' },
      { id: 'w3', type: 'paraphrase', q: 'Can I spread the cost of a table over a few months?', keys: ['Affirm'], files: ['payment-plans-by-affirm.md'], note: 'payment plans through Affirm at checkout' },
      { id: 'w4', type: 'policy', q: 'Will I have to pay customs or VAT if I order from Germany?', keys: ['VAT'], files: ['international-fees-customs-duties-and-vat.md', 'shipping-locations-carriers.md'], note: 'yes, calculated and collected at checkout' },
      { id: 'w5', type: 'service', q: 'Do you ship furniture to Australia?', keys: ['United States and Canada'], files: ['shipping-locations-carriers.md'], note: 'furniture ships to the US and Canada only' },
      { id: 'w6', type: 'policy', q: 'How long until my order ships?', keys: ['2-5 days'], files: ['order-status-and-expected-ship-dates.md'], note: 'in-stock orders generally ship within 2-5 days' },
      { id: 'w7', type: 'service', q: 'How long does support take to reply?', keys: ['48 business hours'], files: ['26174791100827-contact-us.md'], note: '48 business hours' },
      { id: 'w8', type: 'service', q: 'Can you build me a custom table?', keys: ['not currently accepting custom orders'], files: ['do-you-accept-custom-orders.md'], note: 'not currently; the Signature Series is coming' },
      { id: 'w9', type: 'staff', q: 'Who founded Wyrmwood?', keys: ['Douglas Costello|Ed Maranville'], files: ['help/about-us.md'], note: 'Douglas Costello and Ed Maranville, then Ian Costello' },
      { id: 'w10', type: 'paraphrase', q: 'I want to put half on my Visa and half on my Amex. Is that possible?', keys: ['splitting payments'], files: ['split-my-purchase-between-multiple-payment-methods.md'], note: 'not directly; buy gift certificates with one card first' },
      { id: 'w11', type: 'multi', q: 'How many sleeved cards fit in the deck box, and will the tarot box hold a full tarot deck?', keys: ['100 sleeved', '78-card'], files: ['deck-box-capacity.md'], note: '100 sleeved cards; yes, a standard 78-card tarot deck' },
      { id: 'w12', type: 'multi', q: 'Which meeple color has the skull pattern, and how many meeples come in a color set?', keys: ['skull', 'set of 8|8 meeples'], files: ['colorblind-friendly-meeples.md'], note: 'black; 8 per color set' },
      { id: 'w13', type: 'policy', q: 'Can I pick up my order in person?', keys: ['in-person pickup'], files: ['shipping-locations-carriers.md'], note: 'no in-person pickup at either location' },
      { id: 'w14', type: 'offtopic', q: "What's the best way to train for a marathon?", keys: [], files: [], note: 'refuse' },
      { id: 'w15', type: 'offtopic', q: 'Can you write me a cover letter for a job at IKEA?', keys: [], files: [], note: 'refuse (near "Working for Wyrmwood")' },
    ],
  },
};

// ----------------------------------------------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ');
const has = (text, re) => new RegExp(re, 'i').test(norm(text));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)] : null; };
let calls = 0;

/** fetch with KnowDrive's busy answers retried (HTTP 503 search_busy / 429), a few times. */
async function kdFetch(url, init) {
  for (let i = 0; ; i++) {
    calls++;
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    if ((res.status === 503 || res.status === 429) && i < 4) { await res.text(); await sleep(400 * (i + 1) ** 2); continue; }
    return res;
  }
}

// --------------------------------------------------------------------------------- arm A: today's trial search
async function rawSearch(query, mode, k, scopeTag) {
  const res = await kdFetch(`${base}/api/v1/vector_stores/${STORE}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_num_results: k, mode, text: 'raw', filter: { all_of: [scopeTag], none_of: EXCLUDE }, fields: 'tags,uri,score,text,file_id,metadata' }),
  });
  if (!res.ok) throw new Error(`${mode} search HTTP ${res.status}`);
  return (await res.json()).data || [];
}

/** server/trials.mjs retrieve(), for one trial with no disabled files or shared samples. */
async function retrieveA(question, scopeTag) {
  const ok = (h) => h.text && h.tags?.includes(scopeTag) && !EXCLUDE.some((t) => h.tags.includes(t));
  const vRaw = await rawSearch(question, 'vector', 12, scopeTag);
  const hRaw = await rawSearch(question, 'hybrid', 8, scopeTag);
  let vector = vRaw.map((d) => normHit(d, 'vector')).filter(ok);
  const hyb = hRaw.map((d) => normHit(d, 'hybrid')).filter(ok);
  if (!vector.length && hyb.length) vector = hyb.filter((h) => h.similarity != null).map((h) => ({ ...h, mode: 'vector', viaHybrid: true }));
  vector.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  const k200 = (h) => `${h.fileId}|${norm(h.text).slice(0, 200)}`;
  for (const [i, h] of hyb.entries()) {
    h.hybridRank = i + 1;
    const v = vector.find((x) => x.atomId && x.atomId === h.atomId) || vector.find((x) => x.fileId === h.fileId && x.seq != null && x.seq === h.seq) || vector.find((x) => k200(x) === k200(h));
    if (v) { v.hybridRank = h.hybridRank; h.joined = v; }
  }
  let hybridOnly = hyb.filter((h) => !h.joined);
  let merged = vector;
  const clauses = questionClauses(question);
  if (clauses.length > 1) {
    const per = [];
    for (const c of clauses) {
      const v = (await rawSearch(c, 'vector', 6, scopeTag)).map((d) => normHit(d, 'vector'));
      per.push(v.length ? v : (await rawSearch(c, 'hybrid', 6, scopeTag)).map((d) => ({ ...normHit(d, 'hybrid'), mode: 'vector', viaHybrid: true })).filter((h) => h.similarity != null));
    }
    const keyOf = (h) => h.atomId || `${h.fileId}|${h.seq}|${norm(h.text).slice(0, 200)}`;
    const byKey = new Map(vector.map((h) => [keyOf(h), h]));
    const lists = per.map((hits) => hits.filter(ok).map((h) => {
      const kk = keyOf(h), cur = byKey.get(kk);
      if (cur) { if ((h.similarity ?? 0) > (cur.similarity ?? 0)) cur.similarity = h.similarity; return cur; }
      byKey.set(kk, h); return h;
    }).sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)));
    const first = [];
    for (let r = 0; r < 2; r++) for (const l of lists) if (l[r] && !first.includes(l[r])) first.push(l[r]);
    merged = [...first, ...[...byKey.values()].filter((h) => !first.includes(h)).sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))];
    const inV = new Set(merged);
    hybridOnly = hybridOnly.filter((h) => !inV.has(h));
  }
  const top = merged.length ? Math.max(...merged.map((h) => h.similarity ?? 0)) : 0;
  return { vector: merged, hybridOnly, top, calls: 2 + (clauses.length > 1 ? clauses.length : 0) };
}

/** retrieve() + the ask path's keep step. */
async function searchPath(question, scopeTag) {
  const r = await retrieveA(question, scopeTag);
  return { ...keepStep(r), calls: r.calls, vector: r.vector };
}

const toSource = (h) => ({ file_id: h.fileId, filename: h.filename, path: h.filename, title: h.filename.split('/').pop(), text: h.text, score: h.similarity, seq: h.seq });

/**
 * The research agent's search_files tool in the ask path (server/trials.mjs searchMore): the arm's own retrieve() for
 * the new query, hits at 0.85 x floor (at most 8) plus the top-3 keyword hits, as sources.
 */
const searchMoreOf = (retrieveFn) => async (q) => {
  const r2 = await retrieveFn(q);
  return [...r2.vector.filter((h) => (h.similarity ?? 0) >= FLOOR * 0.85).slice(0, 8), ...r2.hybridOnly.filter((x) => x.hybridRank <= 3)].map(toSource);
};

/** The ask path's keep step (server/trials.mjs, steps 3-4) over retrieve()'s result: floor, at most 6 kept + top-3 keyword hits. */
function keepStep({ vector, hybridOnly, top }) {
  const keep = (floor) => {
    const kept = vector.filter((h) => (h.similarity ?? 0) >= floor).slice(0, 6);
    if (top >= floor) for (const h of hybridOnly.filter((x) => x.hybridRank <= 3)) if (kept.length < 6) kept.push(h);
    return kept;
  };
  const kept = keep(FLOOR);
  // retrieval metrics read the kept window as if the floor were 0, so a floor refusal still shows what search found
  return { status: top >= FLOOR && kept.length ? 'ok' : 'refused_floor', top, sources: kept.map(toSource), candidates: keep(-Infinity).map(toSource) };
}

// ------------------------------------------------------------------------------- arms D, E: resolve (no attend)
async function resolveCall(url, question, scopeTag, limit) {
  const res = await fetch(`${url}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ store: STORE, question, scope: { tags_all: [scopeTag], tags_none: EXCLUDE }, limit }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`resolve HTTP ${res.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (j.spans.some((x) => typeof x.similarity !== 'number')) throw new Error('a span has no similarity');
  return j;
}

/** server/trials.mjs resolvedRetrieve(): the question's window (20) + one per clause (6), run together. */
async function retrieveR(url, question, scopeTag) {
  const ok = (h) => h.text && h.tags?.includes(scopeTag) && !EXCLUDE.some((t) => h.tags.includes(t));
  const clauses = questionClauses(question);
  const [main, ...per] = await Promise.all([resolveCall(url, question, scopeTag, 20), ...(clauses.length > 1 ? clauses.map((c) => resolveCall(url, c, scopeTag, 6)) : [])]);
  return { ...resolvedRetrieval([main.spans.map(spanToDoc), ...per.map((x) => x.spans.map(spanToDoc))], ok), main, per };
}

/** retrieveR() then the keep step. */
async function resolvePath(url, question, scopeTag) {
  const r = await retrieveR(url, question, scopeTag);
  const { main, per } = r;
  return { ...keepStep(r), vector: r.vector, digest: combineDigests([main.receipt?.digest, ...per.map((x) => x.receipt?.digest)]),
    order: main.spans.map((x) => `${x.file_id}#${x.atom_index}`).join(','), calls: 1 + per.length, rankMode: main.rank_mode, simMs: main.similarity?.ms ?? null };
}

// ------------------------------------------------------------------------------------------ arms B, C, D: attendd
async function attend(url, question, scopeTag, extra = {}) {
  const res = await fetch(`${url}/attend`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ store: STORE, question, scope: { tags_all: [scopeTag], tags_none: EXCLUDE }, ...extra }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`attend HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// --------------------------------------------------------------------------------------------------- answering
let agent = null, answerMode = 'keyword selector (lib answerFromSources, mode select; no model)';
// the research agent's token use and outcomes, per arm
const usage = {};
const tallyOf = (arm) => (usage[arm] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, answers: 0, fallbacks: 0, searches: 0 });
async function probeModel() {
  if (ANSWER !== 'haiku') return;
  // only through an explicit key: no key is requested, read from elsewhere, or printed
  if (!process.env.ANTHROPIC_API_KEY) { console.error('--answer haiku needs ANTHROPIC_API_KEY'); process.exit(2); }
  const { createResearchAgent } = await import('../server/research.mjs');
  agent = createResearchAgent({ ...process.env, KNOWBOT_RESEARCH: 'on' }, { log: (m) => console.error(m), timeoutMs: 60000 });
  if (!agent) { console.error('no research agent'); process.exit(2); }
  answerMode = `research agent ${agent.model} (lib researchAnswer, effort ${process.env.KNOWBOT_RESEARCH_EFFORT || 'low'}, as the ask path runs it)`;
}

/** The agent, counting its calls and token use toward one arm. */
function counted(arm) {
  const t = tallyOf(arm);
  return async (params, o) => {
    const r = await agent(params, o);
    const u = r?.usage || {};
    t.calls++;
    t.input += u.input_tokens || 0; t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0; t.cacheWrite += u.cache_creation_input_tokens || 0;
    return r;
  };
}

/**
 * One answer from the kept sources. keyword: lib answerFromSources (mode select). haiku: the ask path's research step
 * (lib researchAnswer, then citeQuotedLines); search is the arm's search_files backing (none when evidenceOnly).
 */
async function answer(question, sources, evidenceOnly, { arm = '?', search = null, persona = {} } = {}) {
  if (!sources?.length) return { refused: true, text: '', files: [] };
  const view = (fin) => ({ refused: !!fin.refused, text: fin.refused ? '' : String(fin.text || ''), files: [...new Set((fin.citations || []).map((c) => String(c.filename || '')))] });
  const keyword = async () => (await lib.answerFromSources({ question, results: sources, complete: async () => '', mode: 'select', voice: false, evidenceOnly, k: evidenceOnly ? sources.length : 6 })).fin;
  if (!agent) return view(await keyword());
  const t = tallyOf(arm);
  t.answers++;
  const rfin = await lib.researchAnswer({ question, sources, search: evidenceOnly ? undefined : search || undefined, searchTool: !evidenceOnly, agent: counted(arm), persona, voice: true, k: 8 })
    .catch((e) => { console.error(`[research] ${arm}: ${e?.message || e}`); return null; });
  if (!rfin) { t.fallbacks++; return { ...view(await keyword()), research: 'fallback' }; }
  const { lines: _l, allLines: _a, sources: _s, ...fin0 } = rfin;
  t.searches += rfin.research?.searches || 0;
  return { ...view(citeQuotedLines(fin0, lib.requireCitations)), research: rfin.research ? `${rfin.research.searches} search${rfin.research.searches === 1 ? '' : 'es'}` : null };
}

/** The bot's persona for the research step (production: the trial spec's name/org; here the bot's name). */
function personaOf(Q) {
  const bot = Object.values(BOTS).find((b) => b.questions.includes(Q));
  return { name: bot?.name, org: bot?.name };
}

function judge(Q, a) {
  if (Q.type === 'offtopic') return { verdict: a.refused ? 'refused_ok' : 'answered_offtopic' };
  if (a.refused) return { verdict: 'wrong_refusal' };
  const got = Q.keys.filter((k) => has(a.text, k)).length;
  const src = a.files.some((f) => Q.files.some((s) => f.endsWith(s)));
  return { verdict: got === Q.keys.length ? 'correct' : got ? 'partial' : 'wrong', source: src };
}

/** Retrieval metrics over an ordered passage list ({path|filename, text}). */
function retrieval(Q, passages) {
  if (Q.type === 'offtopic') return {};
  const path = (p) => String(p.path || p.filename || '');
  const i = passages.findIndex((p) => has(p.text, Q.keys[0]));
  const fileAt = (n) => passages.slice(0, n).some((p) => Q.files.some((s) => path(p).endsWith(s)));
  const allKeys = (n) => Q.keys.every((k) => passages.slice(0, n).some((p) => has(p.text, k)));
  return { rank: i >= 0 ? i + 1 : null, file3: fileAt(3), file5: fileAt(5), keysIn5: allKeys(5), keysInAll: allKeys(passages.length) };
}

/** One sentence of the answer for the report: the first line holding an expected fact, else the first that is not a heading. */
function quote(s, keys = []) {
  const lines = String(s || '').split('\n').map((l) => l.replace(/\[\d+\]/g, '').replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l && !/^Source:/i.test(l) && !/ · https?:\/\//.test(l));
  const t = norm(lines.find((l) => keys.some((k) => has(l, k))) || lines[0] || '');
  const m = t.match(/^(.{0,160}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 160)).trim();
}

// ------------------------------------------------------------------------------------------------------- run
async function runAttendArm(name, url, Q, scopeTag, runs, extra = {}) {
  const out = { runs: [] };
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    let b;
    try { b = await attend(url, Q.q, scopeTag, extra); } catch (e) { out.runs.push({ error: String(e.message || e), ms: Math.round(performance.now() - t0) }); continue; }
    const ms = Math.round(performance.now() - t0);
    out.runs.push({ ms, status: b.status, digest: b.receipt?.bundle_digest || null, order: (b.evidence || []).map((e) => `${e.file_id}#${e.atom_index}`).join(','), bundle: b });
  }
  const ok = out.runs.filter((x) => x.bundle);
  if (!ok.length) return { name, error: out.runs[0]?.error, ms: out.runs.map((x) => x.ms) };
  const b = ok[0].bundle;
  const ev = b.evidence || [];
  const noSection = ev.filter((e) => !(e.via || []).every((v) => v === 'H-section'));
  const merged = mergeBundles([b]);
  const mergedWeak = mergeBundles([b], { weakAnswers: true });
  const persona = personaOf(Q);
  const a = await answer(Q.q, merged.sources, true, { arm: name, persona });
  const res = {
    name, status: b.status, passages: ev.length, ms: out.runs.map((x) => x.ms),
    heads: b.summary?.heads_contributing || {}, headsRun: b.summary?.heads_run || [], headsFailed: b.summary?.heads_failed || [],
    sectionAvailable: b.summary?.section_available, rankMode: b.summary?.rank_mode,
    match: b.match ? { weak: !!b.match.weak, unmatched: b.match.unmatched || [] } : null,
    ret: retrieval(Q, ev.map((e) => ({ path: e.path, text: e.text }))),
    retNoSection: retrieval(Q, noSection.map((e) => ({ path: e.path, text: e.text }))),
    deterministic: ok.length >= 2 ? { digest: ok[0].digest === ok[1].digest, order: ok[0].order === ok[1].order } : null,
    answer: { ...judge(Q, a), quote: quote(a.text, Q.keys), files: a.files.map((f) => f.split('/').pop()), research: a.research ?? null },
  };
  if (b.status === 'weak_match') {
    const aw = await answer(Q.q, mergedWeak.sources, true, { arm: name, persona });
    res.weakAnswer = { ...judge(Q, aw), quote: quote(aw.text, Q.keys) };
  }
  return res;
}

async function runResolveArm(name, url, Q, scopeTag, runs) {
  const out = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    try { out.push({ ...(await resolvePath(url, Q.q, scopeTag)), ms: Math.round(performance.now() - t0) }); } catch (e) { out.push({ error: String(e.message || e), ms: Math.round(performance.now() - t0) }); }
  }
  const ok = out.filter((x) => !x.error);
  if (!ok.length) return { name, error: out[0]?.error, ms: out.map((x) => x.ms) };
  const p = ok[0];
  const a = await answer(Q.q, p.status === 'ok' ? p.sources : [], false, { arm: name, persona: personaOf(Q), search: searchMoreOf((q) => retrieveR(url, q, scopeTag)) });
  return { name, status: p.status, top: Number(p.top.toFixed(3)), passages: p.sources.length, ms: out.map((x) => x.ms), rankMode: p.rankMode, digest: p.digest, vector: p.vector,
    ret: retrieval(Q, p.candidates), deterministic: ok.length >= 2 ? { digest: ok[0].digest === ok[1].digest, order: ok[0].order === ok[1].order } : null,
    answer: { ...judge(Q, a), quote: quote(a.text, Q.keys), files: a.files.map((f) => f.split('/').pop()), research: a.research ?? null } };
}

/** Similarity agreement: |resolve's cosine - search's 1 - distance/2| over the passages both arms returned. */
function simAgreement(aVec = [], dVec = []) {
  const key = (h) => `${h.fileId}|${norm(h.text).trim().slice(0, 200)}`;
  const a = new Map(aVec.filter((h) => h.similarity != null).map((h) => [key(h), h.similarity]));
  return dVec.filter((h) => a.has(key(h))).map((h) => Math.abs(h.similarity - a.get(key(h))));
}

async function main() {
  await probeModel();
  const health = {};
  const need = new Set(ARMS.flatMap((a) => (['B', 'B20', 'D'].includes(a) ? ['B'] : ['C', 'E'].includes(a) ? ['C'] : [])));
  for (const arm of need) {
    const url = URLS[arm];
    try { health[arm] = await (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) })).json(); } catch (e) { console.error(`attendd ${arm} at ${url}: ${e.message}`); process.exit(2); }
  }
  if ((need.has('B') && health.B.rank_mode !== 'server_hybrid') || (need.has('C') && health.C.rank_mode !== 'client_rrf')) { console.error(`attendd modes: ${JSON.stringify(health)}; want server_hybrid (--hybrid) and client_rrf (--fusion)`); process.exit(2); }
  const only = opt('only') ? new Set(opt('only').split(',')) : null;
  const bots = (opt('bots') || 'ugm,wyrmwood').split(',');
  const results = [];
  for (const botId of bots) {
    const bot = BOTS[botId];
    if (!bot) { console.error(`--bots: no bot ${botId} (${Object.keys(BOTS).join(', ')})`); process.exit(2); }
    const scopeTag = `trial:${bot.trial}`;
    for (const Q of bot.questions) {
      if (only && !only.has(Q.id)) continue;
      const row = { bot: botId, id: Q.id, type: Q.type, q: Q.q, note: Q.note, files: Q.files, arms: {} };
      // A
      if (ARMS.includes('A')) {
        const t0 = performance.now();
        try {
          const p = await searchPath(Q.q, scopeTag);
          const ms = Math.round(performance.now() - t0);
          const a = await answer(Q.q, p.status === 'ok' ? p.sources : [], false, { arm: 'A', persona: personaOf(Q), search: searchMoreOf((q) => retrieveA(q, scopeTag)) });
          row.arms.A = { name: 'A', status: p.status, top: Number(p.top.toFixed(3)), passages: p.sources.length, ms: [ms], ret: retrieval(Q, p.candidates), vector: p.vector,
            answer: { ...judge(Q, a), quote: quote(a.text, Q.keys), files: a.files.map((f) => f.split('/').pop()), research: a.research ?? null } };
        } catch (e) { row.arms.A = { name: 'A', error: String(e.message || e), ms: [Math.round(performance.now() - t0)] }; }
      }
      if (ARMS.includes('B')) row.arms.B = await runAttendArm('B', URLS.B, Q, scopeTag, RUNS);
      if (ARMS.includes('C')) row.arms.C = await runAttendArm('C', URLS.C, Q, scopeTag, RUNS);
      if (ARMS.includes('B20')) row.arms.B20 = await runAttendArm('B20', URLS.B, Q, scopeTag, 1, { query_limit: 20 });
      if (ARMS.includes('D')) row.arms.D = await runResolveArm('D', URLS.D, Q, scopeTag, RUNS);
      if (ARMS.includes('E')) row.arms.E = await runResolveArm('E', URLS.E, Q, scopeTag, RUNS);
      // single-clause questions only: arm A raises a passage's similarity to its best clause's on a multi-part one
      if (row.arms.A?.vector && row.arms.D?.vector && questionClauses(Q.q).length <= 1) row.simDiffs = simAgreement(row.arms.A.vector, row.arms.D.vector);
      for (const x of Object.values(row.arms)) delete x.vector;
      results.push(row);
      const s = (x) => x.error ? 'ERR' : `${x.status}${x.ret?.rank ? '@' + x.ret.rank : ''}/${x.answer?.verdict}`;
      console.error(`${Q.id.padEnd(4)} ${Object.entries(row.arms).map(([k, x]) => `${k} ${s(x)}`).join(' | ')}`);
    }
  }
  const diffs = results.flatMap((r) => r.simDiffs || []);
  const meta = { at: new Date().toISOString(), store: STORE, answerMode, answer: ANSWER, runs: RUNS, usage: agent ? usage : null, health, kdSearchCallsArmA: calls, floor: FLOOR, arms: ARMS,
    simAgreement: diffs.length ? { n: diffs.length, max: Number(Math.max(...diffs).toFixed(5)), mean: Number((diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(5)) } : null };
  if (opt('json')) writeFileSync(opt('json'), JSON.stringify({ meta, results }, null, 2));
  const md = report(meta, results);
  if (opt('md')) writeFileSync(opt('md'), md);
  if (!opt('md') || args.includes('--print')) console.log(md);
}

// ---------------------------------------------------------------------------------------------------- report
function summarize(rows, arm) {
  const xs = rows.map((r) => r.arms[arm]).filter(Boolean);
  const inScope = rows.filter((r) => r.type !== 'offtopic').map((r) => r.arms[arm]).filter((x) => x && !x.error);
  const off = rows.filter((r) => r.type === 'offtopic').map((r) => r.arms[arm]).filter((x) => x && !x.error);
  const at = (n) => inScope.filter((x) => x.ret?.rank && x.ret.rank <= n).length;
  const ms = xs.flatMap((x) => x.ms || []);
  const det = xs.filter((x) => x.deterministic);
  return {
    n: inScope.length, hit1: at(1), hit3: at(3), hit5: at(5), file3: inScope.filter((x) => x.ret?.file3).length, file5: inScope.filter((x) => x.ret?.file5).length,
    correct: inScope.filter((x) => x.answer?.verdict === 'correct').length, partial: inScope.filter((x) => x.answer?.verdict === 'partial').length,
    srcOk: inScope.filter((x) => x.answer?.source).length, wrongRefusal: inScope.filter((x) => x.answer?.verdict === 'wrong_refusal').length,
    wrong: inScope.filter((x) => x.answer?.verdict === 'wrong').length,
    offRefused: off.filter((x) => x.answer?.verdict === 'refused_ok').length, offN: off.length,
    med: median(ms), p90: p90(ms), errors: xs.filter((x) => x.error).length,
    det: det.length ? `${det.filter((x) => x.deterministic.digest).length}/${det.length} digest, ${det.filter((x) => x.deterministic.order).length}/${det.length} order` : 'n/a',
    hit5NoSection: inScope.filter((x) => x.retNoSection?.rank && x.retNoSection.rank <= 5).length,
  };
}

function report(meta, results) {
  const L = [];
  L.push('# Evidence selection eval: per-question results', '');
  L.push(`Run ${meta.at} against prod KnowDrive (read-only), store \`${meta.store}\`. Answer step: ${meta.answerMode}. Floor (arm A): ${meta.floor}.`);
  L.push(`attendd: ${Object.entries(meta.health).map(([k, v]) => `${k === 'B' ? 'hybrid' : 'fusion'} ${JSON.stringify(v)}`).join('; ')}.`, '');
  L.push(`Arms run: ${meta.arms.join(', ')}. **A** today's trial search + keep; **B** attend, server hybrid; **C** attend, client-side fusion; **B20** B with query_limit 20; **D** resolve (no attend), server hybrid, then today's keep + answer steps; **E** D with client-side fusion. B, C, D, E ran each question ${meta.runs === 1 ? 'once' : `${meta.runs} times`}.`, '');
  if (meta.usage) {
    const u = Object.entries(meta.usage);
    const tot = u.reduce((a, [, t]) => ({ calls: a.calls + t.calls, input: a.input + t.input, output: a.output + t.output, cacheRead: a.cacheRead + t.cacheRead, cacheWrite: a.cacheWrite + t.cacheWrite }), { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    L.push(`Cost (research agent tokens): ${tot.calls} calls, ${tot.input} input + ${tot.output} output tokens${tot.cacheRead || tot.cacheWrite ? ` (cache read ${tot.cacheRead}, cache write ${tot.cacheWrite})` : ''}. Per arm: ${u.map(([arm, t]) => `${arm} ${t.answers} answers, ${t.calls} calls, ${t.searches} searches, ${t.input}/${t.output} in/out${t.fallbacks ? `, ${t.fallbacks} research failures → keyword selector` : ''}`).join('; ')}.`, '');
  }
  if (meta.simAgreement) L.push(`Similarity check (resolve's cosine vs search's 1 - distance/2, same passage, A vs D): n=${meta.simAgreement.n}, max |Δ| ${meta.simAgreement.max}, mean |Δ| ${meta.simAgreement.mean}.`, '');
  L.push('Columns: status; rank = position of the first passage holding the expected fact (— = none); f3/f5 = expected file in top 3/5; heads = passages per head; det = run 1 vs 2 (digest/order); answer verdict, cited file, and the first sentence quoted.', '');
  for (const botId of [...new Set(results.map((r) => r.bot))]) {
    const rows = results.filter((r) => r.bot === botId);
    L.push(`## ${BOTS[botId].name} (\`trial:${BOTS[botId].trial}\`)`, '');
    L.push('| arm | in-scope n | hit@1 | hit@3 | hit@5 | file@3 | file@5 | correct | partial | wrong answer | source ok | wrong refusals | off-topic refused | median ms | p90 ms | determinism | hit@5 w/o H-section |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const arm of meta.arms) {
      const s = summarize(rows, arm);
      L.push(`| ${arm} | ${s.n} | ${s.hit1} | ${s.hit3} | ${s.hit5} | ${s.file3} | ${s.file5} | ${s.correct} | ${s.partial} | ${s.wrong} | ${s.srcOk} | ${s.wrongRefusal} | ${s.offRefused}/${s.offN} | ${s.med} | ${s.p90} | ${s.det} | ${['B', 'C', 'B20'].includes(arm) ? s.hit5NoSection : '—'} |`);
    }
    L.push('');
    for (const r of rows) {
      L.push(`### ${r.id} (${r.type}): ${r.q}`, '', `Expected: ${r.note}${r.files.length ? ` — ${r.files.map((f) => `\`${f.split('/').pop()}\``).join(', ')}` : ''}`, '');
      L.push('| arm | status | passages | rank | f3/f5 | heads | det | ms | answer | cited | quote |', '|---|---|---|---|---|---|---|---|---|---|---|');
      for (const arm of meta.arms) {
        const x = r.arms[arm];
        if (!x) continue;
        if (x.error) { L.push(`| ${arm} | error: ${String(x.error).replace(/\|/g, '/').slice(0, 80)} | | | | | | ${x.ms?.join('/')} | | | |`); continue; }
        const heads = x.heads ? Object.entries(x.heads).map(([h, n]) => `${h.replace('H-', '')}:${n}`).join(' ') : '—';
        const det = x.deterministic ? `${x.deterministic.digest ? '=' : '≠'}/${x.deterministic.order ? '=' : '≠'}` : '—';
        const st = x.status + (x.top != null ? ` (top ${x.top})` : '') + (x.match?.weak ? ` unmatched: ${x.match.unmatched.join(' ')}` : '');
        const ans = x.answer?.verdict + (x.answer?.research ? ` (${x.answer.research})` : '') + (x.weakAnswer ? `; weak→answer: ${x.weakAnswer.verdict}` : '');
        L.push(`| ${arm} | ${st} | ${x.passages} | ${x.ret?.rank ?? '—'} | ${x.ret?.file3 ? 'y' : 'n'}/${x.ret?.file5 ? 'y' : 'n'} | ${heads} | ${det} | ${x.ms.join('/')} | ${ans} | ${(x.answer?.files || []).join(', ') || '—'} | ${(x.answer?.quote || '').replace(/\|/g, '/')} |`);
      }
      L.push('');
    }
  }
  // weak-match outcome (attend arms only)
  if (!meta.arms.some((a) => a === 'B' || a === 'C')) return L.join('\n');
  const weak = results.flatMap((r) => ['B', 'C'].map((arm) => ({ r, x: r.arms[arm], arm }))).filter(({ x }) => x?.status === 'weak_match');
  L.push('## Weak matches: KNOWBOT_EVIDENCE_WEAK=refuse vs answer', '');
  if (!weak.length) L.push('No weak_match bundles in this run.');
  else {
    L.push('| bot | id | arm | type | refuse (default) | answer |', '|---|---|---|---|---|---|');
    for (const { r, x, arm } of weak) L.push(`| ${r.bot} | ${r.id} | ${arm} | ${r.type} | ${x.answer.verdict} | ${x.weakAnswer?.verdict} |`);
  }
  L.push('');
  return L.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });

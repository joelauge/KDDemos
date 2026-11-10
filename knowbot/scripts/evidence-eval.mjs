#!/usr/bin/env node
// Evaluates KnowBot's evidence paths on real questions against REAL KnowDrive, READ-ONLY (it only searches and reads;
// nothing is written or deleted). Not part of CI.
//
// Arms, per question:
//   A  today's path: the trial search (vector 12 + hybrid 8 under the trial's tag filter, the narrow-filter hybrid
//      fallback, clause decomposition for multi-part questions, similarity floor, at most 6 kept + top-3 keyword hits)
//   B  the evidence selector (attendd) with KnowDB's server-side hybrid search      (ATTENDD_FUSION off)
//   C  the evidence selector (attendd) with the engine's client-side fused ranking  (ATTENDD_FUSION=on)
//   D  B with query_limit 20 (one run), to see what the smaller window costs
// B and C run each question twice and compare the bundle digest and the passage order (determinism).
//
// The answer key (expected fact as regexes + expected source files) was written by reading the bots' files before
// any arm was run. Retrieval metrics: rank of the first passage holding the expected fact, expected file in the top
// 3/5 passages; for B/C also the same with H-section's passages removed (= section off). Answer step: the real
// research agent (claude-haiku-5-5) when an Anthropic key works here, else KnowBot's deterministic keyword selector
// (lib answerFromSources, mode select); the report says which. Weak matches are answered both ways
// (KNOWBOT_EVIDENCE_WEAK=refuse, the default, and =answer).
//
// Usage (two attendd instances on the loopback, one with ATTENDD_FUSION=on):
//   KNOWDRIVE_API_KEY=… node scripts/evidence-eval.mjs [--hybrid http://127.0.0.1:7181] [--fusion http://127.0.0.1:7182]
//     [--bots ugm,wyrmwood] [--only u1,w3] [--json out.json] [--md out.md]
import { writeFileSync } from 'node:fs';
import * as lib from '../lib/knowbot.js';
import { normHit, questionClauses } from '../server/trials.mjs';
import { mergeBundles, REFUSAL_STATUSES } from '../server/evidence.mjs';

const args = process.argv.slice(2);
const opt = (name, d = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const base = String(process.env.KNOWDRIVE_BASE_URL || 'https://knowdrive.ai').replace(/\/+$/, '');
const key = process.env.KNOWDRIVE_API_KEY;
const STORE = 'vs_97c857474b1f4e8892b134c283cf9849';
const FLOOR = 0.7;
const EXCLUDE = ['kind:trial-spec', 'kind:config', 'questions'];
const URLS = { B: opt('hybrid', 'http://127.0.0.1:7181'), C: opt('fusion', 'http://127.0.0.1:7182') };
if (!key) { console.error('KNOWDRIVE_API_KEY is not set'); process.exit(2); }

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

/** server/trials.mjs retrieve() + the ask path's keep step, for one trial with no disabled files or shared samples. */
async function searchPath(question, scopeTag) {
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
  const keep = (floor) => {
    const kept = merged.filter((h) => (h.similarity ?? 0) >= floor).slice(0, 6);
    if (top >= floor) for (const h of hybridOnly.filter((x) => x.hybridRank <= 3)) if (kept.length < 6) kept.push(h);
    return kept;
  };
  const toSource = (h) => ({ file_id: h.fileId, filename: h.filename, path: h.filename, title: h.filename.split('/').pop(), text: h.text, score: h.similarity, seq: h.seq });
  const kept = keep(FLOOR);
  // retrieval metrics read the kept window as if the floor were 0, so a floor refusal still shows what search found
  return { status: top >= FLOOR && kept.length ? 'ok' : 'refused_floor', top, sources: kept.map(toSource), candidates: keep(-Infinity).map(toSource), calls: 2 + (clauses.length > 1 ? clauses.length : 0) };
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
async function probeModel() {
  // only through an explicit key: no key is requested, read from elsewhere, or printed
  if (!process.env.ANTHROPIC_API_KEY) return;
  const { createResearchAgent } = await import('../server/research.mjs');
  agent = createResearchAgent(process.env);
  if (agent) answerMode = `research agent ${agent.model}`;
}

async function answer(question, sources, evidenceOnly) {
  if (!sources?.length) return { refused: true, text: '', files: [] };
  const r = await lib.answerFromSources({ question, results: sources, complete: async () => '', mode: 'select', voice: false, evidenceOnly, k: evidenceOnly ? sources.length : 6, ...(agent ? { research: agent } : {}) });
  const fin = r.fin;
  return { refused: !!fin.refused, text: fin.refused ? '' : String(fin.text || ''), files: [...new Set((fin.citations || []).map((c) => String(c.filename || '')))] };
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
  const a = await answer(Q.q, merged.sources, true);
  const res = {
    name, status: b.status, passages: ev.length, ms: out.runs.map((x) => x.ms),
    heads: b.summary?.heads_contributing || {}, headsRun: b.summary?.heads_run || [], headsFailed: b.summary?.heads_failed || [],
    sectionAvailable: b.summary?.section_available, rankMode: b.summary?.rank_mode,
    match: b.match ? { weak: !!b.match.weak, unmatched: b.match.unmatched || [] } : null,
    ret: retrieval(Q, ev.map((e) => ({ path: e.path, text: e.text }))),
    retNoSection: retrieval(Q, noSection.map((e) => ({ path: e.path, text: e.text }))),
    deterministic: ok.length >= 2 ? { digest: ok[0].digest === ok[1].digest, order: ok[0].order === ok[1].order } : null,
    answer: { ...judge(Q, a), quote: quote(a.text, Q.keys), files: a.files.map((f) => f.split('/').pop()) },
  };
  if (b.status === 'weak_match') {
    const aw = await answer(Q.q, mergedWeak.sources, true);
    res.weakAnswer = { ...judge(Q, aw), quote: quote(aw.text, Q.keys) };
  }
  return res;
}

async function main() {
  await probeModel();
  const health = {};
  for (const [arm, url] of Object.entries(URLS)) {
    try { health[arm] = await (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) })).json(); } catch (e) { console.error(`attendd ${arm} at ${url}: ${e.message}`); process.exit(2); }
  }
  if (health.B.rank_mode !== 'server_hybrid' || health.C.rank_mode !== 'client_rrf') { console.error(`attendd modes: B=${health.B.rank_mode} C=${health.C.rank_mode}; want server_hybrid and client_rrf`); process.exit(2); }
  const only = opt('only') ? new Set(opt('only').split(',')) : null;
  const bots = (opt('bots') || 'ugm,wyrmwood').split(',');
  const results = [];
  for (const botId of bots) {
    const bot = BOTS[botId];
    const scopeTag = `trial:${bot.trial}`;
    for (const Q of bot.questions) {
      if (only && !only.has(Q.id)) continue;
      const row = { bot: botId, id: Q.id, type: Q.type, q: Q.q, note: Q.note, files: Q.files, arms: {} };
      // A
      const t0 = performance.now();
      try {
        const p = await searchPath(Q.q, scopeTag);
        const ms = Math.round(performance.now() - t0);
        const a = await answer(Q.q, p.status === 'ok' ? p.sources : [], false);
        row.arms.A = { name: 'A', status: p.status, top: Number(p.top.toFixed(3)), passages: p.sources.length, ms: [ms], ret: retrieval(Q, p.candidates),
          answer: { ...judge(Q, a), quote: quote(a.text, Q.keys), files: a.files.map((f) => f.split('/').pop()) } };
      } catch (e) { row.arms.A = { name: 'A', error: String(e.message || e), ms: [Math.round(performance.now() - t0)] }; }
      row.arms.B = await runAttendArm('B', URLS.B, Q, scopeTag, 2);
      row.arms.C = await runAttendArm('C', URLS.C, Q, scopeTag, 2);
      row.arms.D = await runAttendArm('D', URLS.B, Q, scopeTag, 1, { query_limit: 20 });
      results.push(row);
      const s = (x) => x.error ? 'ERR' : `${x.status}${x.ret?.rank ? '@' + x.ret.rank : ''}/${x.answer?.verdict}`;
      console.error(`${Q.id.padEnd(4)} A ${s(row.arms.A)} | B ${s(row.arms.B)} | C ${s(row.arms.C)} | D ${s(row.arms.D)}`);
    }
  }
  const meta = { at: new Date().toISOString(), store: STORE, answerMode, health, kdSearchCallsArmA: calls, floor: FLOOR };
  if (opt('json')) writeFileSync(opt('json'), JSON.stringify({ meta, results }, null, 2));
  const md = report(meta, results);
  if (opt('md')) writeFileSync(opt('md'), md); else console.log(md);
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
  L.push(`attendd: B ${JSON.stringify(meta.health.B)}; C ${JSON.stringify(meta.health.C)}.`, '');
  L.push('Arms: **A** today\'s trial search + keep; **B** attend, server hybrid; **C** attend, client-side fusion; **D** B with query_limit 20 (one run). B and C ran each question twice.', '');
  L.push('Columns: status; rank = position of the first passage holding the expected fact (— = none); f3/f5 = expected file in top 3/5; heads = passages per head; det = run 1 vs 2 (digest/order); answer verdict, cited file, and the first sentence quoted.', '');
  for (const botId of [...new Set(results.map((r) => r.bot))]) {
    const rows = results.filter((r) => r.bot === botId);
    L.push(`## ${BOTS[botId].name} (\`trial:${BOTS[botId].trial}\`)`, '');
    L.push('| arm | in-scope n | hit@1 | hit@3 | hit@5 | file@3 | file@5 | correct | partial | source ok | wrong refusals | off-topic refused | median ms | p90 ms | determinism | hit@5 w/o H-section |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const arm of ['A', 'B', 'C', 'D']) {
      const s = summarize(rows, arm);
      L.push(`| ${arm} | ${s.n} | ${s.hit1} | ${s.hit3} | ${s.hit5} | ${s.file3} | ${s.file5} | ${s.correct} | ${s.partial} | ${s.srcOk} | ${s.wrongRefusal} | ${s.offRefused}/${s.offN} | ${s.med} | ${s.p90} | ${s.det} | ${arm === 'A' ? '—' : s.hit5NoSection} |`);
    }
    L.push('');
    for (const r of rows) {
      L.push(`### ${r.id} (${r.type}): ${r.q}`, '', `Expected: ${r.note}${r.files.length ? ` — ${r.files.map((f) => `\`${f.split('/').pop()}\``).join(', ')}` : ''}`, '');
      L.push('| arm | status | passages | rank | f3/f5 | heads | det | ms | answer | cited | quote |', '|---|---|---|---|---|---|---|---|---|---|---|');
      for (const arm of ['A', 'B', 'C', 'D']) {
        const x = r.arms[arm];
        if (!x) continue;
        if (x.error) { L.push(`| ${arm} | error: ${String(x.error).replace(/\|/g, '/').slice(0, 80)} | | | | | | ${x.ms?.join('/')} | | | |`); continue; }
        const heads = x.heads ? Object.entries(x.heads).map(([h, n]) => `${h.replace('H-', '')}:${n}`).join(' ') : '—';
        const det = x.deterministic ? `${x.deterministic.digest ? '=' : '≠'}/${x.deterministic.order ? '=' : '≠'}` : '—';
        const st = x.status + (x.top != null ? ` (top ${x.top})` : '') + (x.match?.weak ? ` unmatched: ${x.match.unmatched.join(' ')}` : '');
        const ans = x.answer?.verdict + (x.weakAnswer ? `; weak→answer: ${x.weakAnswer.verdict}` : '');
        L.push(`| ${arm} | ${st} | ${x.passages} | ${x.ret?.rank ?? '—'} | ${x.ret?.file3 ? 'y' : 'n'}/${x.ret?.file5 ? 'y' : 'n'} | ${heads} | ${det} | ${x.ms.join('/')} | ${ans} | ${(x.answer?.files || []).join(', ') || '—'} | ${(x.answer?.quote || '').replace(/\|/g, '/')} |`);
      }
      L.push('');
    }
  }
  // weak-match outcome
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

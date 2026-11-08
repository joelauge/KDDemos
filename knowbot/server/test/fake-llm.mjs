// An OpenAI-compatible model stand-in (POST /v1/chat/completions, JSON and SSE; GET /v1/models) for Studio tests and
// the local dev server (spec 7.2). Deterministic; never talks to the network.
//
//   select prompts  (system contains "You select lines")  -> up to 3 line numbers, best (most similar) first: the best
//                    line per clause of the QUESTION plus lines nearly as dense and similar, or NONE (fixer r7)
//   summary prompts (system contains "summarize")          -> {"oneLine","topics"} from the first lines of the file
//   question prompts (system contains "write test questions") -> a JSON list of heading questions
//   setup prompts   (system contains "KnowBot Builder")    -> {"reply","patch","actions","chips"} built from the
//                    intent parser exported by server/trials.mjs plus canned replies
//   any message containing FAIL -> HTTP 500; SLOW -> a 9 s delay (exercises time-outs and fallbacks)
import http from 'node:http';
import { bag, similarity, idfOf } from './fake-knowdrive.mjs';

const SECOND_MARGIN = 0.08;
const LINE_FLOOR = 0.62; // a single line scores lower than its whole atom; this is the line-level stand-in for the 0.70 floor
/** Self-describing intro sentences ("This page explains…", "This policy covers every bike…"): never a supporting line. */
export const GENERIC_LINE_RE = /\b(?:this|the following|our)\s+(?:page|policy|document|guide|section|faq|list|handbook|article|sheet|site)\s+(?:explains|covers|describes|lists|sets out|tells|shows|is written|answers)\b|\bit is written in plain\b/i;

const NEG_RE = /\b(?:not|never|no|cannot|can't|won't|isn't|aren't|doesn't|don't)\b/i;
const NUM = '(?:\\d[\\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty|ninety|a|an)';
// What a quantity question wants: how long -> a duration, how much -> money, how far -> a distance, how many -> a count.
const WANTS = [
  [/\bhow\s+long\b|\bhow\s+soon\b/i, new RegExp(`\\b${NUM}[\\s-]+(?:business\\s+|working\\s+)?(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\\b|\\blifetime\\b|\\bsame day\\b`, 'i')],
  [/\bhow\s+much\b|\bcost\b|\bprice\b|\bfee\b/i, /[$€£]\s?\d|\d\s?%|\bfree\b|\bno (?:cost|charge)\b/i],
  [/\bhow\s+far\b/i, /\d\s?(?:km|kilomet|mi(?:les?)?\b)/i],
  [/\bhow\s+(?:many|often|old)\b|\bwhat\s+time\b|\bwhen\b/i, /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|daily|weekly|monthly|yearly|every)\b/i],
];
const QTY_WORDS = ['long', 'soon', 'far', 'many', 'often', 'old', 'duration'];
const wantsOf = (q) => WANTS.find(([re]) => re.test(q))?.[1] || null;
/** Adjacent content-word pairs, stemmed through the fake embedding's own bag ("test rides" -> "test ride"). */
function pairsOf(text) {
  const ws = String(text || '').toLowerCase().split(/[^a-z0-9'-]+/).map((w) => [...bag(w).keys()][0]).filter(Boolean);
  const out = new Set();
  for (let i = 1; i < ws.length; i++) if (ws[i] !== ws[i - 1]) out.add(`${ws[i - 1]} ${ws[i]}`);
  return out;
}
const lastUser = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content || '';
const textOf = (c) => (Array.isArray(c) ? c.map((b) => b?.text || '').join('') : String(c ?? ''));

function selectReply(messages) {
  const u = textOf(lastUser(messages));
  const q = /QUESTION:\s*([\s\S]*)$/.exec(u)?.[1] || '';
  const lines = [...u.matchAll(/^L(\d+)\s+(.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
  return selectLines(q, lines);
}

// fixer r7: a multi-part question ("How much is a spare battery and how long is it covered?") is read clause by clause,
// like a reader would: each clause gets its own best line, so the answer is complete and can cite two files.
const CLAUSE_SPLIT = /\s*[,;]?\s+\band\b\s+(?=(?:how|what|what's|whats|when|where|which|who|why|is|are|do|does|can|could|will|would|should|did)\b)|\?\s+(?=\S)|;\s+/i;
const PRONOUN_RE = /\b(?:it|its|they|them|their|that|this|those|these|one)\b/i;
/** The clauses of a question; a pronoun clause ("how long is it covered") borrows the first clause's subject words. */
export function clausesOf(q) {
  const parts = String(q || '').split(CLAUSE_SPLIT).map((x) => x.trim()).filter((x) => bag(x).size >= 1);
  if (parts.length < 2) return [String(q || '')];
  return parts.slice(0, 3).map((c, i) => (i > 0 && PRONOUN_RE.test(c) ? `${c} ${subjectWords(parts[0])}` : c));
}
// the head noun of the first clause's subject ("a spare E-City battery" -> "battery")
// (or its whole named thing when that ends the phrase: "the Lumen Care Plan", but "battery" for "a spare E-City battery")
const subjectWords = (c) => {
  const head = [...bag(c).keys()].filter((w) => !/^(?:cost|duration|long|include|much|many|warranty|range|open)$/.test(w) && !w.startsWith('=')).slice(-1)[0] || '';
  const named = String(c).trim().split(/\s+/).slice(1).filter((w) => /^[A-Z][A-Za-z0-9-]*[a-z0-9]/.test(w));
  if (named.length && [...bag(named[named.length - 1]).keys()].includes(head)) return named.join(' ');
  return head;
};
// verbs and filler a FAQ question wraps its topic in ("Do you help with …", "Can I get …"): not a different topic
const CTX_GENERIC = new Set('help offer offers sell sells take get need use make provide give know find buy order book bring come way much long cost lot also really still ever any'.split(' '));
const MAX_PICKS = 3;
const numsOf = (t) => (String(t).match(/[$€£]?\d[\d,.]*%?/g) || []).map((x) => x.replace(/[.,]+$/, ''));

/**
 * The line numbers a careful reader would quote for `question`, best (highest line similarity) first, at most 3;
 * 'NONE' when no line answers it. Pure, for tests.
 * @param {string} question  @param {{n:number,text:string}[]} raw
 */
export function selectLines(question, raw) {
  const q = String(question || '');
  // an FAQ answer line inherits the question line just above it (within 3 lines): "A basic fit is free with every new
  // bike." under "Do you help with bike fitting?" IS about bike fitting, the way a reader sees it
  let ctxQ = null, ctxAge = 0;
  const parsed = [];
  for (const m of raw) {
    const t = String(m.text || '');
    if (/\?\s*$/.test(t)) { ctxQ = t; ctxAge = 0; parsed.push({ ...m, question: true }); continue; }
    ctxAge++;
    // the line right under the question, or a later one that carries on its topic (shares a word with it); a line from
    // the next passage ("A spare E-City battery costs $649.") never inherits "Do you offer financing?"
    const attached = ctxQ && (ctxAge === 1 || (ctxAge <= 3 && [...bag(t).keys()].some((w) => bag(ctxQ).has(w))));
    if (!attached) ctxQ = null;
    parsed.push({ ...m, ctx: attached ? ctxQ : null });
  }
  // A question line ("Can I take a test ride?") is never an answer; among equal overlaps the shorter, denser line wins.
  // fixer r5: an FAQ line that opens with its own question ("Does servicing my bike elsewhere void the warranty? No, …")
  // is scored on its answer part only: the interrogative sentence is never a claim.
  const answerPart = (t) => String(t).replace(/^(?:[^.!?]*\?\s+)+/, '');
  const qbAll = bag(q);
  const sameQ = (t, qb) => { const qq = bag(t); const k = [...qb.keys()].filter((w) => qq.has(w)).length; return k >= Math.max(2, Math.ceil(0.6 * qb.size)); };
  const seenText = new Set();
  const lines = parsed.filter((m) => !m.question && answerPart(m.text).trim())
    .map((m) => {
      const ans = answerPart(m.text);
      const qa = ans !== m.text;
      const own = qa ? m.text.slice(0, m.text.length - ans.length) : null;
      const text = qa && sameQ(own, qbAll) ? m.text : ans;
      return { n: m.n, len: m.text.length, text, qa: qa && text === ans, b: bag(text), ctx: own || m.ctx, key: text.toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim() };
    })
    // the same sentence from two atoms (a repeated policy line) is quoted once
    .filter((l) => (seenText.has(l.key) ? false : seenText.add(l.key)));
  if (!lines.length) return 'NONE';
  const df = new Map();
  for (const l of lines) for (const w of l.b.keys()) df.set(w, (df.get(w) || 0) + 1);
  const common = (w) => lines.length >= 3 && (df.get(w) || 0) >= 0.6 * lines.length;
  // A named thing the question asks about ("Care Plan": capitalised, not the first word) that no candidate line
  // mentions, e.g. with the plans file switched off: a reader answers NONE rather than quoting a neighbouring price.
  const named = q.trim().split(/\s+/).slice(1).filter((w) => /^[A-Z][A-Za-z0-9-]*[a-z0-9]/.test(w)).flatMap((w) => [...bag(w).keys()]);
  if (named.some((w) => !df.has(w))) return 'NONE';
  const idf = idfOf(lines.map((l) => l.b));
  const lsimOf = new Map(lines.map((l) => [l.n, similarity(qbAll, l.b, idf).sim]));
  const byN = new Map(lines.map((l) => [l.n, l]));

  const clauses = clausesOf(q);
  const picks = [], rank = new Map();
  for (const [ci, clause] of clauses.entries()) {
    const scored = scoreLines(clause, lines, { common, df, whole: q });
    if (!scored.length) { if (ci === 0 && clauses.length === 1) return 'NONE'; continue; }
    const [top] = scored;
    const cb = bag(clause);
    const csim = (n) => similarity(cb, byN.get(n).b, idf).sim;
    const topSim = csim(top.n);
    // a line that already answers an earlier clause answers this one too ("includes two tune-ups … costs $149")
    if (!picks.includes(top.n)) { picks.push(top.n); rank.set(top.n, top.score - 1000 * ci); }
    // fixer r2/r7: further lines ride along only when each is itself about the clause: nearly as dense and as similar
    // as the top line and above the line floor, never a generic intro; a list question ("What does X include?") may
    // take up to 3 lines, any other clause one more
    const listy = /\b(?:include[sd]?|what(?:'s| is) in|what do (?:i|you) get|benefits?|perks?|which|covers?)\b/i.test(clause);
    let extra = 0;
    for (const x of scored.slice(1)) {
      if (picks.length >= MAX_PICKS || extra >= (listy ? 2 : clauses.length > 1 ? 0 : 1)) break;
      if (picks.includes(x.n) || x.otherNamed) continue;
      const t = byN.get(x.n).text;
      // a line that only repeats amounts already quoted ("A spare E-City battery costs $649." next to the $649 row) adds nothing
      const nums = numsOf(t);
      if (nums.length && nums.every((v) => picks.some((p) => numsOf(byN.get(p).text).includes(v)))) continue;
      if (x.hit >= Math.max(x.need, top.hit - 1) && x.score >= top.score - 1 && x.dens >= 0.6 * top.dens && !GENERIC_LINE_RE.test(t)
        && csim(x.n) >= topSim - (listy ? 1.5 : 1) * SECOND_MARGIN && csim(x.n) >= LINE_FLOOR) { picks.push(x.n); rank.set(x.n, Math.min(x.score, top.score - 0.001) - 1000 * ci); extra++; }
    }
  }
  if (!picks.length) return 'NONE';
  // best first: the answer leads with its strongest quote (the reader's score, then the line's similarity); a multi-part
  // question is answered in the order its parts were asked
  return picks.slice(0, MAX_PICKS).map((n, i) => ({ n, i, r: rank.get(n) ?? 0, s: lsimOf.get(n) })).sort((a, b) => b.r - a.r || b.s - a.s || a.i - b.i).map((x) => `L${x.n}`).join(', ');
}

/** Candidate lines for one clause, best first: [{n, hit, need, score, dens}] (only lines sharing enough concepts). */
function scoreLines(q, lines, { common, whole }) {
  const want = wantsOf(q);
  // fixer r5: the quantity word of a how-long / how-far / how-many question ("long") is what the answer's SHAPE must
  // be (a duration), not a concept to share
  const qb = bag(q);
  if (want) for (const w of QTY_WORDS) if (qb.size > 1) qb.delete(w);
  // the visitor's own words, literally present in a line ("warranty" vs a line that only says "covered")
  const qWords = (q.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter((w) => !/^(?:what|when|where|which|does|have|your|with|from|that|this|long|much|many|often|there|about|will|would|could|should)$/.test(w));
  const distinctive = [...qb.keys()].some((w) => lines.some((l) => l.b.has(w)) && !common(w));
  // a quantity question counts its wanted shape as one concept ("How long is the warranty?" = warranty + a duration)
  const need = Math.max(1, Math.min(2, qb.size + (want ? 1 : 0)));
  const qPairs = pairsOf(q);
  const wholeBag = bag(whole);
  const namedWords = new Set(q.trim().split(/\s+/).slice(1).filter((w) => /^[A-Z]/.test(w)).map((w) => w.replace(/[^A-Za-z0-9-]/g, '').toLowerCase()));
  const namedPairs = pairsOf(q.trim().split(/\s+/).slice(1).filter((w) => /^[A-Z][A-Za-z0-9-]*[a-z0-9]/.test(w)).join(' '));
  return lines.map((l) => {
    // fixer r7: an answer under an FAQ question about something else ("Can you fit mudguards to my bike?") is about
    // that thing, not about what was asked ("Do you do bike fitting?"): it is never the answer, however many words
    // (fit, bike) it shares
    let ctxPair = false;
    if (l.ctx) {
      const cb = bag(l.ctx);
      ctxPair = [...pairsOf(l.ctx)].some((p) => qPairs.has(p));
      const extra = [...cb.keys()].filter((w) => !w.startsWith('=') && !wholeBag.has(w) && !CTX_GENERIC.has(w) && !common(w));
      const sharesQ = [...cb.keys()].some((w) => qb.has(w));
      if (extra.length && !ctxPair && sharesQ) return null;
    }
    const lb = l.ctx ? new Map([...l.b, ...[...bag(l.ctx)].filter(([w]) => qb.has(w))]) : l.b;
    const shared = [...lb.keys()].filter((w) => qb.has(w));
    const shape = !!(want && want.test(l.text));
    // fixer r7: the quantity belongs to what was asked when a question word sits just before it ("returned within 30
    // days", "frames carry a lifetime warranty") rather than to another verb ("inspected in the workshop within 2 days")
    let near = false;
    if (shape) {
      const m = want.exec(l.text);
      const before = l.text.slice(0, m.index).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
      near = before.slice(-4).some((w) => [...bag(w).keys()].some((k) => qb.has(k)));
    }
    // fixer r7: a line naming the question's named thing ("Care Plan" in "What does the Lumen Care Plan include?") is on
    // topic even when every line in the file is about it (its words are then "common")
    const namedHit = namedPairs.size && [...pairsOf(l.text)].some((p) => namedPairs.has(p));
    const hit = (distinctive && !namedHit && !shared.some((w) => !common(w))) || !shared.length ? 0 : shared.length + (shape ? 1 : 0);
    const fragment = /^[a-z]/.test(l.text.trim()) || l.text.trim().split(/\s+/).length < 4;
    const pair = ctxPair || [...pairsOf(l.text)].some((p) => qPairs.has(p));
    // a reader prefers the affirmative statement over a caveat that shares the same words, unless the question is negative
    const negative = !NEG_RE.test(q) && NEG_RE.test(l.text);
    const intro = GENERIC_LINE_RE.test(l.text);
    const lower = `${l.text} ${l.ctx || ''}`.toLowerCase();
    const literal = qWords.filter((w) => lower.includes(w)).length;
    const score = hit + (shape ? 0.75 : 0) + (near ? 0.5 : 0) + (pair ? 0.3 : 0) + (ctxPair ? 1 : 0) - (negative ? 0.4 : 0) - (fragment ? 1.5 : 0) - (intro ? 2 : 0) - (l.qa ? 0.25 : 0) + 0.3 * Math.min(2, literal);
    // a line about another named thing ("Care Plus", "the Family Care Plan") never rides along as an extra
    const otherNamed = namedPairs.size > 0 && (l.text.match(/(?<=[a-z0-9,;)]\s+)[A-Z][a-z][A-Za-z-]*/g) || []).some((w) => !namedWords.has(w.toLowerCase()));
    return { n: l.n, len: l.len, hit, need, score: score - (otherNamed ? 0.6 : 0), pair, otherNamed, dens: hit / Math.sqrt(Math.max(1, l.b.size)) };
  }).filter((x) => { if (process.env.DBGSEL && x) console.error('  ', q.slice(0, 30), x.n, x.hit, x.score.toFixed(2), x.dens.toFixed(2)); return x && x.hit >= need; }).sort((a, b) => b.score - a.score || b.dens - a.dens || a.len - b.len || a.n - b.n);
}

function summaryReply(messages) {
  const u = textOf(lastUser(messages));
  const body = u.replace(/^[\s\S]*?FILE[^\n]*\n/, '');
  const heads = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim());
  const sentences = body.split('\n').filter((l) => l.trim() && !/^[#|]/.test(l.trim()) && !/\?\s*$/.test(l))
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.split(' ').length >= 8 && /^[A-Z0-9"“]/.test(x));
  const first = sentences[0] || heads[0] || 'A short document.';
  const oneLine = first.length > 120 ? `${first.slice(0, 117).replace(/\s+\S*$/, '')}…` : first;
  const short = (t) => t.split(/\s+/).length <= 4;
  const uniq = [...new Set(heads)];
  // the first heading is the title; casing is kept (the server lowers plain sentence-case topics, never product names)
  let topics = [...new Set((uniq.length > 1 ? uniq.slice(1) : uniq).map(cleanHeading))].filter(Boolean).filter(short).filter((t) => !GENERIC_HEADING.test(t));
  if (topics.length < 3) {
    // Q&A files: the questions name the topics ("Can I take a test ride?" -> "take a test ride")
    const qs = body.split('\n').map((l) => l.trim()).filter((l) => /\?$/.test(l))
      .map((l) => l.replace(/\?$/, '').replace(/^(?:what|how|when|where|who|why|can|does|do|is|are)\s+(?:(?:are|is|does|do|can|i|you|we)\b\s*)?(?:(?:your|our|you|we|i)\b\s*)?/i, '').trim().toLowerCase());
    for (const q of qs) if (topics.length < 3 && q && short(q) && !topics.includes(q)) topics.push(q);
  }
  // fixer r3: never single stray words ("day", "section", "full"): the most frequent two-word noun phrases instead
  if (topics.length < 3) {
    const STOPW = /^(?:a|an|the|and|or|of|to|in|on|at|for|from|by|with|is|are|be|can|will|you|your|we|our|it|this|that|per|up|all|any|each|every|new|full|day|days|year|years|section|part|variant|page)$/;
    const bi = new Map();
    for (const sent of sentences) {
      const ws = sent.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z-]+/).filter(Boolean);
      for (let i = 1; i < ws.length; i++) if (!STOPW.test(ws[i - 1]) && !STOPW.test(ws[i]) && ws[i - 1].length > 2 && ws[i].length > 2 && !/ly$/.test(ws[i - 1])) bi.set(`${ws[i - 1]} ${ws[i]}`, (bi.get(`${ws[i - 1]} ${ws[i]}`) || 0) + 1);
    }
    for (const [k] of [...bi.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])) if (topics.length < 3 && !topics.includes(k)) topics.push(k);
  }
  return JSON.stringify({ oneLine, topics: topics.slice(0, 3) });
}

const GENERIC_HEADING = /^(?:(?:section|chapter|part|article|appendix|clause|schedule|page|item|step)\s*[\dIVXLA-Z][\w.]*|[\d.]+|introduction|overview|summary|contents|notes?|general|other|faq)$/i;
// Like a real model: questions about concrete facts (a number, a price, a duration) first, then about named headings.
// fixer r3: a passive "How long is X <verb>ed?" is only written for coverage verbs (covered, warrantied, guaranteed,
// valid) over a real duration, the subject must be a noun phrase, and headings are cleaned of numbering
// ("Section 4. Travel policy variant 1" -> "travel policy") and asked as "What does the handbook say about …?".
const PASSIVE_OK = /^(?:covered|warrantied|guaranteed|insured|valid)$/i;
const DURATION = /\b(?:\d+|one|two|three|four|five|six|ten|twelve|thirty)[\s-]+(?:business\s+|working\s+)?(?:days?|weeks?|months?|years?)\b|\blifetime\b/i;
const NOT_NOUN = /\b(?:is|are|was|were|be|can|will|must|should|have|has|do|does|use|used|up|out|off|very|only|not|it|this|that|they|we|you)\b/i;
export function cleanHeading(h) {
  return String(h || '').replace(/^(?:(?:section|chapter|part|article|appendix|clause)\s+)?[\dIVXL]+[a-z]?(?:[.:)\-–]\d+)*[.:)\-–]?\s+/i, '')
    .replace(/\s+(?:variant|version|v|rev|option|part)\.?\s*\d+[a-z]?$/i, '').replace(/\s+\(?\d+\)?$/, '').replace(/[:.\s]+$/, '').trim();
}
const docNoun = (u) => {
  const name = (/^FILE\s+(\S+)/m.exec(u)?.[1] || '').toLowerCase();
  const m = /(handbook|policy|guide|manual|faq|contract|plan|report|catalog)/.exec(name);
  return m ? `the ${m[1] === 'faq' ? 'FAQ' : m[1]}` : 'the file';
};
function questionsReply(messages) {
  const u = textOf(lastUser(messages));
  const out = [];
  for (const sent of u.split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n/).map((x) => x.trim())) {
    if (out.length >= 3) break;
    const m = /^(?:The |Our |All )?([A-Z][\w-]*(?: [\w-]+){0,3}?) (?:is|are) (\w+ed|valid) (?:for|within|up to) (.+?)[.]?$/.exec(sent);
    if (m && PASSIVE_OK.test(m[2]) && DURATION.test(m[3]) && !NOT_NOUN.test(m[1])) { const subj = /^[A-Z][a-z]+ [A-Z]/.test(m[1]) ? m[1] : m[1][0].toLowerCase() + m[1].slice(1); out.push(`How long ${/s$/.test(subj) ? 'are' : 'is'} ${subj} ${m[2]}?`); continue; }
    const c = /^(?:(The|Our|A|An) )?([A-Za-z][\w-]*(?: [\w-]+){0,3}?) (costs?) [$€£]/.exec(sent);
    if (c && (c[1] || /^[A-Z]/.test(c[2])) && !NOT_NOUN.test(c[2])) {
      const proper = /^[A-Z][a-z]+ [A-Z]|^[A-Z][a-z]*\d/.test(c[2]);
      const art = proper ? '' : /^an?$/i.test(c[1] || '') ? `${c[1].toLowerCase()} ` : c[3] === 'cost' && !c[1] ? '' : 'the ';
      out.push(`How much ${c[3] === 'cost' && !proper ? 'do' : 'does'} ${art}${proper ? c[2] : c[2].toLowerCase()} cost?`);
    }
  }
  const noun = docNoun(u);
  const heads = [...u.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => cleanHeading(m[1])).filter((h) => h && h.split(/\s+/).length <= 5 && !GENERIC_HEADING.test(h));
  for (const h of [...new Set(heads)]) { if (out.length >= 4) break; out.push(`What does ${noun} say about ${/^[A-Z][a-z]+ [A-Z]/.test(h) ? h : h.toLowerCase()}?`); }
  return JSON.stringify(out.slice(0, 4));
}

async function setupReply(messages) {
  const u = textOf(lastUser(messages));
  let ctx = {};
  try { ctx = JSON.parse(u); } catch { /* free text */ }
  const msg = String(ctx.message ?? (typeof ctx === 'object' ? '' : u) ?? '');
  let patch = {}, actions = [];
  try {
    const { parseIntent } = await import('../trials.mjs');
    const r = parseIntent(msg, { files: ctx.files || [], spec: ctx.spec || {} });
    patch = r.patch || {};
    actions = (r.actions || []).map((a) => (typeof a === 'string' ? { type: a } : a));
  } catch { /* trials.mjs not available: canned reply only */ }
  const name = patch.name || ctx.spec?.name || 'your bot';
  const reply = Object.keys(patch).length ? `Done. I've updated ${name}. Want to test it?` : `Got it. Drop a file on the right, or try the samples.`;
  return JSON.stringify({ reply, patch, actions, chips: [{ label: 'Use sample files', action: { type: 'attach_samples' } }, { label: 'Upload my files', action: { type: 'request_upload' } }] });
}

/**
 * @returns {Promise<{ url: string, port: number, calls: object[], close: () => Promise<void> }>}
 */
export async function startFakeLLM({ host = '127.0.0.1', slowMs = 9000, model = 'fake-qwen2.5-1.5b' } = {}) {
  const calls = [];
  const pending = new Set();
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const json = (status, b) => { if (res.headersSent || res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.method === 'GET' && /\/models$/.test(url.pathname)) return json(200, { object: 'list', data: [{ id: model, object: 'model' }] });
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) return json(404, { error: { message: 'not found' } });
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(400, { error: { message: 'bad json' } }); }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const sys = textOf(messages.find((m) => m.role === 'system')?.content);
      const all = messages.map((m) => textOf(m.content)).join('\n');
      const user = textOf(lastUser(messages));
      const kind = /You select lines/.test(sys) ? 'select' : /summari[sz]e/i.test(sys) ? 'summary' : /write test questions/i.test(sys) ? 'questions' : /KnowBot Builder/.test(sys) ? 'setup' : 'chat';
      calls.push({ kind, at: Date.now(), stream: !!body.stream, user: user.slice(0, 400) });
      if (/\bFAIL\b/.test(user) || (kind !== 'select' && /\bFAIL\b/.test(all))) return json(500, { error: { message: 'injected failure' } });
      if (/\bSLOW\b/.test(user)) {
        await new Promise((r) => { const t = setTimeout(r, slowMs); pending.add(t); res.on('close', () => { clearTimeout(t); pending.delete(t); r(); }); });
        if (res.destroyed) return;
      }
      let content;
      if (kind === 'select') content = selectReply(messages);
      else if (kind === 'summary') content = summaryReply(messages);
      else if (kind === 'questions') content = questionsReply(messages);
      else if (kind === 'setup') content = await setupReply(messages);
      else content = 'Fake model reply.';
      const id = `chatcmpl-fake-${calls.length}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const piece of content.match(/.{1,16}/gs) || ['']) {
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      return json(200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.ceil(all.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil((all.length + content.length) / 4) } });
    });
  });
  await new Promise((r) => srv.listen(0, host, r));
  const port = srv.address().port;
  return {
    url: `http://${host}:${port}`, port, calls,
    close() {
      for (const t of pending) clearTimeout(t);
      srv.closeAllConnections?.();
      return new Promise((r) => srv.close(() => r()));
    },
  };
}

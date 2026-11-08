// An OpenAI-compatible model stand-in (POST /v1/chat/completions, JSON and SSE; GET /v1/models) for Studio tests and
// the local dev server (spec 7.2). Deterministic; never talks to the network.
//
//   select prompts  (system contains "You select lines")  -> the 1-2 line numbers sharing the most concepts with the
//                    QUESTION (a second only when nearly as dense), or NONE when the overlap is under min(2, question terms)
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
  const qb = bag(q);
  // A question line ("Can I take a test ride?") is never an answer; among equal overlaps the shorter, denser line wins.
  const lines = [...u.matchAll(/^L(\d+)\s+(.*)$/gm)].filter((m) => !/\?\s*$/.test(m[2])).map((m) => ({ n: Number(m[1]), len: m[2].length, text: m[2], b: bag(m[2]) }));
  // A one-concept question ("When are you open?") needs one shared concept; longer ones need two. Like a real
  // selector, a second line is only added when it is nearly as much about the question as the first (term density),
  // so a spare-battery row never rides along on "How much is the E-City?".
  // Like a real reader, a line that only shares terms found on most lines (the brand "Lumen", "costs" in a price list)
  // is not about the question: "How much is the Lumen Care Plan?" against a price list without the plan is NONE.
  const df = new Map();
  for (const l of lines) for (const w of l.b.keys()) df.set(w, (df.get(w) || 0) + 1);
  const common = (w) => lines.length >= 3 && (df.get(w) || 0) >= 0.6 * lines.length;
  const distinctive = [...qb.keys()].some((w) => df.has(w) && !common(w));
  // A named thing the question asks about ("Care Plan": capitalised, not the first word) that no candidate line
  // mentions, e.g. with the plans file switched off: a reader answers NONE rather than quoting a neighbouring price.
  const named = q.trim().split(/\s+/).slice(1).filter((w) => /^[A-Z][A-Za-z0-9-]*[a-z0-9]/.test(w)).flatMap((w) => [...bag(w).keys()]);
  if (named.some((w) => !df.has(w))) return 'NONE';
  const need = Math.max(1, Math.min(2, qb.size));
  // fixer r3: like a reader, prefer the line that answers the question's shape: a how-long / how-many / how-much question
  // wants a line with a quantity ("Test rides last 30 minutes…", not "We will set the saddle height…"), a line that
  // repeats an adjacent pair of the question's words ("warranty claim", "test ride") beats one that shares them apart,
  // and a fragment (starts lowercase, under 4 words) is never the answer while a whole sentence shares as much.
  const want = wantsOf(q);
  const qPairs = pairsOf(q);
  const scored = lines.map((l) => {
    const shared = [...l.b.keys()].filter((w) => qb.has(w));
    const hit = (distinctive && !shared.some((w) => !common(w))) ? 0 : shared.length;
    const fragment = /^[a-z]/.test(l.text.trim()) || l.text.trim().split(/\s+/).length < 4;
    const pair = [...pairsOf(l.text)].some((p) => qPairs.has(p));
    // a reader prefers the affirmative statement ("Lumen frames carry a lifetime warranty") over a caveat that shares
    // the same words ("The frame warranty is not transferable…") unless the question itself is negative
    const negative = !NEG_RE.test(q) && NEG_RE.test(l.text);
    const score = hit + (want && want.test(l.text) ? 0.75 : 0) + (pair ? 0.3 : 0) - (negative ? 0.4 : 0) - (fragment ? 1.5 : 0);
    return { n: l.n, len: l.len, hit, score, pair, dens: hit / Math.sqrt(Math.max(1, l.b.size)) };
  }).filter((x) => x.hit >= need).sort((a, b) => b.score - a.score || b.dens - a.dens || a.len - b.len || a.n - b.n);
  if (!scored.length) return 'NONE';
  const [top] = scored;
  // fixer r2: a second line rides along only when it is itself about the question: its own (fake) vector similarity
  // is within SECOND_MARGIN of the top line and above the floor, and it is not a generic intro ("This page explains
  // exactly what is covered…"), which shares words with every question and answers none of them.
  const idf = idfOf(lines.map((l) => l.b));
  const lsim = (n) => similarity(qb, lines.find((l) => l.n === n).b, idf).sim;
  const topSim = lsim(top.n);
  const text = (n) => lines.find((l) => l.n === n)?.text || '';
  const second = scored.slice(1).find((x) => x.hit >= Math.max(need, top.hit - 1) && x.score >= top.score - 1 && x.dens >= 0.6 * top.dens
    && !GENERIC_LINE_RE.test(text(x.n)) && lsim(x.n) >= topSim - SECOND_MARGIN && lsim(x.n) >= LINE_FLOOR);
  return [top, ...(second ? [second] : [])].map((x) => `L${x.n}`).join(', ');
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

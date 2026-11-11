// Recall eval (offline, deterministic) and conversation memory: does query expansion FIND the answer when the question's
// words differ from the files' words, and does the conversation history stay out of every answer's citations?
//
// The eval runs the local BM25 retriever (server/retrievers.mjs LocalRetriever) over the Lumen sample corpus
// (studio/samples/lumen-bikes, the same files lib/test/core.test.mjs uses) and measures hit@K: does an atom that holds
// the answer appear in the K results the answer step reads? Single = the question alone; expanded = expandQuery() with a
// stub rewriter that returns what a good rewrite looks like (the standalone question plus four alternative phrasings,
// never the answer), searched in parallel and fused (searchVariants). `node lib/test/recall.test.mjs` prints the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandQuery, searchVariants, fuseResults, normalizeHistory, historyBlock, parseExpansion, fallbackExpansion, buildExpandMessages, buildSelectMessages, queryVariantsOf,
  answerFromSources, researchAnswer, NOT_IN_DATA, EXPAND_SETTINGS } from '../knowbot.js';
import { LocalRetriever } from '../../server/retrievers.mjs';
import { htmlToText } from '../../server/storeimport.mjs';

const LUMEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'studio', 'samples', 'lumen-bikes');
const K = 6; // the answer step reads the top 6 sources (answerFromSources k, the Studio's kept hits)

async function lumen(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-recall-'));
  t?.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(LUMEN).filter((x) => !x.endsWith('.json') && !x.endsWith('.png'))) {
    const raw = fs.readFileSync(path.join(LUMEN, f), 'utf8');
    fs.writeFileSync(path.join(dir, f.replace(/\.\w+$/, '.md')), f.endsWith('.html') ? htmlToText(raw, { main: true, minLevel: 2 }) : raw);
  }
  const r = new LocalRetriever({ corpusDir: dir, watch: false });
  await r.ready;
  if (!t) process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return r;
}

// ~20 paraphrased or indirect questions: the answer is in the files, in other words. `want`: text an answering atom holds.
// `rewrite`: what the stub rewriter returns (a good model's rewrite: the question on its own + other words, likely names
// and a keywords-only form; it never contains the answer). Follow-ups carry `history`.
export const EVAL = [
  { q: 'Can I take one for a spin first?', want: ['Test rides last 30 minutes', 'Test rides on weekdays need no booking'],
    rewrite: { standalone: 'Can I test ride a bike before buying?', queries: ['test ride a bike', 'try a bike before buying', 'test ride booking', 'test ride'] } },
  { q: 'Do the e-bike packs wear out?', want: ['800 full charge cycles', 'capacity loss of up to 30%'],
    rewrite: { standalone: 'Do e-bike batteries lose capacity over time, and is that covered?', queries: ['e-bike battery warranty', 'battery capacity loss', 'how long are e-bike batteries covered', 'battery charge cycles warranty'] } },
  { q: "What's cheapest for a toddler?", want: ['Lumen Balance 12', 'balance bike for ages 2 to 4'],
    rewrite: { standalone: 'What is the cheapest bike for a toddler?', queries: ['balance bike for young children price', 'kids bike ages 2 to 4', 'cheapest kids bike price', 'kids balance bike'] } },
  { q: 'When do you shut on a Sunday?', want: ['Sunday 11am–4pm'],
    rewrite: { standalone: 'What time does the store close on Sunday?', queries: ['opening hours Sunday', 'store hours', 'closing time Sunday', 'opening hours'] } },
  { q: 'Can I spread the cost of a bike?', want: ['0% financing'],
    rewrite: { standalone: 'Can I pay for a bike in instalments?', queries: ['financing', 'pay in instalments', 'payment plan monthly payments', 'finance a bike'] } },
  { q: 'Will you take my old ride as part payment?', want: ['trade in your old bike', 'Trade-in credit'],
    rewrite: { standalone: 'Can I trade in my old bike against a new one?', queries: ['trade in old bike', 'trade-in credit', 'part exchange used bike', 'trade-in value'] } },
  { q: 'Something broke while still under guarantee, who do I tell?', want: ['warranty@lumenbikes.example'],
    rewrite: { standalone: 'How do I make a warranty claim?', queries: ['warranty claim', 'how to claim warranty', 'warranty claim email', 'report a defect'] } },
  { q: 'Can I hire a bike for the day?', want: ['$45 per day'],
    rewrite: { standalone: 'Can I rent a bike for a day?', queries: ['bike rental per day', 'rent a bike price', 'day rental cost', 'rentals'] } },
  { q: 'Is there somewhere to leave my car?', want: ['car park on Quay Lane', 'loading bays'],
    rewrite: { standalone: 'Is there car parking near the store?', queries: ['car parking', 'parking near the store', 'where to park', 'car park'] } },
  { q: "Do you fix bikes you didn't sell?", want: ['repairs and services every kind of bike'],
    rewrite: { standalone: 'Do you repair bikes bought elsewhere?', queries: ['repair bikes', 'workshop repairs any bike', 'bike repair service', 'workshop service'] } },
  { q: 'Can I send a bike back if I change my mind?', want: ['returned within 30 days'],
    rewrite: { standalone: 'Can I return a bike I bought?', queries: ['returns policy bikes', 'return a bike refund', 'refund unridden bike', 'returns'] } },
  { q: 'What happens if I wreck the frame in a crash?', want: ['40% off a new frame', '40% off the list price'],
    rewrite: { standalone: 'Is a frame damaged in a crash covered?', queries: ['crash replacement frame', 'crash damage frame warranty', 'damaged frame discount', 'crash replacement'] } },
  { q: 'How much to bring a new bike to my house?', want: ['within city limits for $25'],
    rewrite: { standalone: 'How much does bike delivery to my home cost?', queries: ['bike delivery cost', 'deliver assembled bikes', 'home delivery price', 'delivery'] } },
  { q: 'What does an hour with the mechanic cost?', want: ['$80 per hour'],
    rewrite: { standalone: 'What is the hourly workshop labour rate?', queries: ['workshop rate per hour', 'labour cost per hour', 'standard workshop rate', 'mechanic hourly rate'] } },
  { q: 'Is there a discount for hospital staff?', want: ['Nurses, firefighters, paramedics'],
    rewrite: { standalone: 'Do healthcare or emergency workers get a discount?', queries: ['discount for nurses', 'emergency workers discount', 'key worker discount', 'staff discount nurses paramedics'] } },
  { q: 'My daughter has grown out of her bike, any deal on a bigger one?', want: ['next size up'],
    rewrite: { standalone: 'Is there a trade-up deal when a child outgrows a kids bike?', queries: ['kids bike trade-up scheme', 'child outgrows bike', 'trade in kids bike next size', 'kids trade-up'] } },
  { q: 'Can you put a bike aside for me?', want: ['we hold it for 3 days'],
    rewrite: { standalone: 'Can I reserve a bike and pick it up later?', queries: ['reserve a bike', 'hold a bike for collection', 'reserve online pick up later', 'reserve'] } },
  { q: 'What should I do with a dead e-bike battery?', want: ['recycled free of charge'],
    rewrite: { standalone: 'How do I dispose of an old e-bike battery?', queries: ['battery recycling', 'old e-bike batteries recycled', 'dispose of battery', 'recycle battery'] } },
  // follow-ups: the question only makes sense with the conversation before it
  { q: 'how much weight can it carry?', want: ['80 kg'],
    history: [{ q: 'Do you sell cargo bikes?', a: 'Yes. The Lumen E-Cargo carries two children or up to 80 kg of shopping [1].' }],
    rewrite: { standalone: 'How much weight can the Lumen E-Cargo carry?', queries: ['Lumen E-Cargo load capacity', 'E-Cargo maximum load kg', 'cargo bike how much weight', 'E-Cargo load'] } },
  { q: 'and for a whole week?', want: ['Weekly bike rentals cost $180'],
    history: [{ q: 'Do you rent bikes?', a: 'Bike rentals cost $45 per day [1].' }],
    rewrite: { standalone: 'How much does it cost to rent a bike for a week?', queries: ['weekly bike rental price', 'rent a bike for a week', 'week rental cost', 'weekly rentals'] } },
  { q: 'does it pass to the next owner if I sell?', want: ['not transferable'],
    history: [{ q: "What's the warranty on the frame?", a: 'Lumen frames carry a lifetime warranty for the original owner [1].' }],
    rewrite: { standalone: 'Is the frame warranty transferable to a new owner?', queries: ['frame warranty transferable', 'warranty new owner sell bike', 'lifetime frame warranty original owner', 'transfer warranty'] } },
  { q: 'what about the brown one?', want: ['Commuter 3 comes in three colours'],
    history: [{ q: 'Is the Commuter 3 available in blue?', a: 'The Commuter 3 comes in harbour blue, sand and graphite [1].' }],
    rewrite: { standalone: 'Is the Lumen Commuter 3 available in a brown colour?', queries: ['Commuter 3 colours', 'Lumen Commuter 3 colour options', 'Commuter 3 brown', 'Commuter 3 sand colour'] } },
];

const holds = (r, want) => want.some((w) => String(r.text || '').includes(w));
const stubRewriter = (item) => async () => JSON.stringify(item.rewrite);

/** hit@K for one question: single (the question alone) and expanded (rewrite + parallel searches + RRF fusion). */
async function score(r, item, k = K) {
  const search = async (q) => (await r.search(q, k)).results;
  const single = (await search(item.q)).slice(0, k);
  const ex = await expandQuery({ question: item.q, history: item.history || [], complete: stubRewriter(item) });
  const fused = (await searchVariants({ search, queries: ex.queries, k })).results;
  return { single: single.some((x) => holds(x, item.want)), expanded: fused.some((x) => holds(x, item.want)), queries: ex.queries.length, source: ex.source };
}

export async function runEval(r, k = K) {
  const rows = [];
  for (const item of EVAL) rows.push({ q: item.q, followUp: !!item.history, ...(await score(r, item, k)) });
  const n = rows.length;
  return { rows, n, single: rows.filter((x) => x.single).length, expanded: rows.filter((x) => x.expanded).length };
}

// measured on this corpus: single 10/22 (45%), expanded 21/22 (95%) at K=6; rules-only (no model, fill-only fusion) 11/22
const FLOOR = 0.9;

test('recall eval: expanded queries find at least as many answers as the question alone, and clear a fixed floor (hit@6)', async (t) => {
  const r = await lumen(t);
  const res = await runEval(r);
  t.diagnostic(`hit@${K}: single ${res.single}/${res.n}, expanded ${res.expanded}/${res.n}`);
  for (const x of res.rows) assert.equal(x.source, 'model', 'the stub rewrite is parsed (not the rules fallback)');
  for (const x of res.rows) assert.ok(x.queries <= 5, 'at most the question plus 4 variants are searched');
  assert.ok(res.expanded >= res.single, 'expansion never loses what the question alone finds');
  assert.ok(res.expanded / res.n >= FLOOR, `expanded hit@${K} ${res.expanded}/${res.n} clears ${FLOOR}`);
  assert.ok(res.expanded - res.single >= 5, 'expansion finds answers the question alone misses');
  // nothing the single search found is lost by the fusion
  for (const x of res.rows) if (x.single) assert.ok(x.expanded, `kept: ${x.q}`);
});

test('recall eval: the deterministic fallback (no model) never does worse than the question alone', async (t) => {
  const r = await lumen(t);
  let single = 0, rules = 0;
  for (const item of EVAL) {
    const search = async (q) => (await r.search(q, K)).results;
    if ((await search(item.q)).some((x) => holds(x, item.want))) single++;
    const ex = await expandQuery({ question: item.q, history: item.history || [] });
    assert.equal(ex.source, 'rules');
    if ((await searchVariants({ search, queries: ex.queries, k: K, fill: true })).results.slice(0, K).some((x) => holds(x, item.want))) rules++;
  }
  t.diagnostic(`hit@${K}: single ${single}/${EVAL.length}, rules-only expansion ${rules}/${EVAL.length}`);
  assert.ok(rules >= single);
});

// ------------------------------------------------------------------------------------------------ expansion units

test('expandQuery: one short call with the history; JSON parsed, original first, at most 1 + n queries; settings capped', async () => {
  let seen = null;
  const complete = async (m, c) => { seen = { m, c }; return '```json\n{"standalone":"stock of the Brown Initiative Trackers","queries":["Brown Initiative Trackers available","Initiative Trackers on hand inventory","brown initiative tracker stock","initiative trackers","extra one too many"]}\n```'; };
  const ex = await expandQuery({ question: 'what about the brown one?', history: [{ q: 'How many Blue Initiative Trackers are in stock?', a: 'There are 12 Blue Initiative Trackers available [1].' }], complete });
  assert.equal(ex.source, 'model');
  assert.equal(ex.standalone, 'stock of the Brown Initiative Trackers');
  assert.deepEqual(ex.queries, ['what about the brown one?', 'stock of the Brown Initiative Trackers', 'Brown Initiative Trackers available', 'Initiative Trackers on hand inventory', 'brown initiative tracker stock']);
  assert.equal(seen.c.settings.max_tokens, 120);
  assert.deepEqual(seen.c.settings, { ...EXPAND_SETTINGS });
  assert.match(seen.m[1].content, /Earlier in this conversation \(for understanding the question only; not a source\)/);
  assert.match(seen.m[1].content, /Visitor: How many Blue Initiative Trackers are in stock\?/);
  assert.doesNotMatch(seen.m[1].content, /\[1\]/, 'citation markers never reach the rewrite');
});

test('expandQuery: timeout, error, unreadable reply or no model → the deterministic fallback; variants 0 → the question alone', async () => {
  const history = [{ q: 'Do you rent bikes?', a: 'Bike rentals cost $45 per day.' }];
  const want = fallbackExpansion('and for a whole week?', history);
  assert.deepEqual(want.queries, ['and for a whole week?', 'whole week', 'whole week rent bikes']);
  const slow = () => new Promise((r) => setTimeout(() => r('{"standalone":"x","queries":["y"]}'), 500));
  for (const complete of [slow, async () => { throw new Error('down'); }, async () => 'Sure! Here you go.', undefined]) {
    const ex = await expandQuery({ question: 'and for a whole week?', history, complete, timeoutMs: 50 });
    assert.equal(ex.source, 'rules');
    assert.deepEqual(ex.queries, want.queries);
    assert.equal(ex.standalone, 'and for a whole week?');
  }
  const off = await expandQuery({ question: 'Do you rent bikes?', variants: 0, complete: async () => { throw new Error('never called'); } });
  assert.deepEqual([off.source, off.queries], ['off', ['Do you rent bikes?']]);
  assert.deepEqual([queryVariantsOf(''), queryVariantsOf('0'), queryVariantsOf('2'), queryVariantsOf('9'), queryVariantsOf('x')], [4, 0, 2, 4, 4]);
});

test('parseExpansion: a standalone question with a number from nowhere is not trusted; one-per-line replies are read', () => {
  const p = parseExpansion('{"standalone":"Is the E-City $2,999?","queries":["E-City price"]}', 'how much is it?', [{ q: 'Tell me about the E-City', a: 'The E-City has a 500 Wh battery.' }]);
  assert.equal(p.standalone, 'how much is it?');
  assert.deepEqual(p.queries, ['how much is it?', 'E-City price']);
  const lines = parseExpansion('Standalone: How long are e-bike batteries covered?\n- e-bike battery warranty\n- battery cover period', 'how long is the pack covered?');
  assert.deepEqual(lines.queries, ['how long is the pack covered?', 'How long are e-bike batteries covered?', 'e-bike battery warranty', 'battery cover period']);
  assert.equal(parseExpansion('', 'q'), null);
  assert.equal(parseExpansion('{"standalone":"q","queries":[]}', 'q'), null);
});

test('fuseResults: reciprocal-rank fusion de-duplicates by atom and keeps the best score / similarity', () => {
  const a = [{ atomId: 'x', text: 'X', similarity: 0.71, score: 0.71 }, { atomId: 'y', text: 'Y', similarity: 0.8, score: 0.8 }];
  const b = [{ atomId: 'y', text: 'Y', similarity: 0.83, score: 0.83 }, { atomId: 'z', text: 'Z', similarity: 0.6, score: 0.6 }];
  const f = fuseResults([a, b]);
  assert.deepEqual(f.map((r) => r.atomId), ['y', 'x', 'z']);
  assert.equal(f[0].similarity, 0.83);
  const byText = fuseResults([[{ file_id: 'f', text: 'same words', score: 2 }], [{ file_id: 'f', text: 'same  words', score: 5 }]]);
  assert.equal(byText.length, 1);
  assert.equal(byText[0].score, 5);
});

test('normalizeHistory: [{q,a}] or chat messages → the last 2 exchanges, markers removed, answers capped at ~600 chars', () => {
  const chat = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'A1 [1].' }, { role: 'user', content: 'two' }, { role: 'assistant', content: `${'long '.repeat(300)}[2]` }, { role: 'user', content: 'three' }, { role: 'assistant', content: 'A3 [1]' }];
  const h = normalizeHistory(chat);
  assert.deepEqual(h.map((x) => x.q), ['two', 'three']);
  assert.ok(h[0].a.length <= 600 && !/\[\d\]/.test(h[0].a));
  assert.equal(h[1].a, 'A3');
  assert.deepEqual(normalizeHistory([{ q: 'a', a: 'b [3]' }]), [{ q: 'a', a: 'b' }]);
  assert.equal(historyBlock([]), '');
});

// ------------------------------------------------------------------------------------------------ history never cited

const E_CARGO = 'The Lumen E-Cargo costs $5,499 [1].';
const HISTORY = [{ q: 'How much is the Lumen E-Cargo?', a: E_CARGO }];
const WARRANTY = { file_id: 'w1', filename: 'lumen-warranty-returns.md', title: 'Lumen Bikes Warranty and Returns Policy', url: null, score: 3,
  text: 'Lumen frames carry a lifetime warranty for the original owner.\nThe frame warranty is not transferable.' };

test('history is never a source (select): the prompt labels it, the answer quotes only retrieved lines, and a history-only fact is never stated', async () => {
  let prompt = '';
  // an adversarial selector that answers from the history instead of naming lines
  const complete = async (m) => { prompt = m.at(-1).content; return 'The E-Cargo costs $5,499.'; };
  const { fin } = await answerFromSources({ question: 'and the frame warranty on it?', results: [WARRANTY], complete, history: HISTORY, voice: true });
  assert.match(prompt, /Earlier in this conversation \(for understanding the question only; not a source\):\nVisitor: How much is the Lumen E-Cargo\?\nBot: The Lumen E-Cargo costs \$5,499\./);
  assert.ok(prompt.indexOf('END OF EARLIER CONVERSATION') < prompt.indexOf('LINES:'), 'the history sits before, never inside, the LINES');
  assert.doesNotMatch(fin.text, /5,499|E-Cargo/);
  assert.ok(fin.refused || fin.citations.every((c) => c.file_id === 'w1'));
  // a fact only in the history, nothing retrieved: the canonical refusal
  const none = await answerFromSources({ question: 'how much was that again?', results: [], complete, history: HISTORY });
  assert.equal(none.fin.text, NOT_IN_DATA);
});

test('history is never a source (generate): a sentence stating a history-only number is dropped, even when the rewrite carries it', async () => {
  const complete = async () => 'Good news! The E-Cargo costs $5,499 [1]. Lumen frames carry a lifetime warranty for the original owner [1].';
  const { fin } = await answerFromSources({ question: 'and the frame warranty?', standalone: 'What is the frame warranty on the $5,499 Lumen E-Cargo?', results: [WARRANTY], complete, history: HISTORY, mode: 'generate' });
  assert.doesNotMatch(fin.text, /5,499/);
  assert.match(fin.text, /lifetime warranty/);
});

test('history is never a source (research): a summary restating a history-only fact fails verification; only quoted lines remain', async () => {
  const calls = [];
  const agent = async (params) => { calls.push(params); return { content: [{ type: 'tool_use', id: 't1', name: 'answer', input: { found: true, quotes: [{ from: 1, to: 1 }], summary: 'The $5,499 E-Cargo frame has a lifetime warranty [L1].' } }], stop_reason: 'tool_use' }; };
  const fin = await researchAnswer({ question: 'and the frame warranty on it?', standalone: 'What is the frame warranty on the $5,499 Lumen E-Cargo?', history: HISTORY, sources: [WARRANTY], agent, voice: false, searchTool: false });
  assert.match(calls[0].messages[0].content, /^Earlier in this conversation \(for understanding the question only; not a source\):/);
  assert.match(calls[0].messages[0].content, /THE QUESTION ON ITS OWN: What is the frame warranty/);
  assert.match(calls[0].system, /It is not a file: never quote it/);
  assert.equal(fin.summary, undefined);
  assert.match(fin.research.summaryDropped, /5,499|E-Cargo/);
  assert.doesNotMatch(fin.text, /5,499|E-Cargo/);
  assert.match(fin.text, /lifetime warranty/);
});

test('answerFromSources expand: searches the variants in parallel, fuses them with the results, and picks with the standalone question', async () => {
  const atoms = {
    week: { file_id: 'faq', filename: 'faq.md', title: 'FAQ', score: 2, text: 'Can I rent a bike for a week?\nWeekly bike rentals cost $180, and the rental can start on any day.' },
    day: { file_id: 'faq2', filename: 'faq.md', title: 'FAQ', score: 2, text: 'Do you rent bikes?\nBike rentals cost $45 per day.' },
  };
  const searched = [];
  const search = async (q) => { searched.push(q); return { results: /week/i.test(q) && /rent/i.test(q) ? [atoms.week] : [] }; };
  let selectPrompt = '';
  const complete = async (m) => { selectPrompt = m.at(-1).content; return 'L2'; };
  const rewrite = async () => '{"standalone":"How much is a weekly bike rental?","queries":["weekly bike rental price","rent a bike for a week"]}';
  const r = await answerFromSources({ question: 'and for a whole week?', results: [atoms.day], complete, search, history: [{ q: 'Do you rent bikes?', a: 'Bike rentals cost $45 per day [1].' }], expand: 4, rewrite, voice: false });
  assert.deepEqual(r.expansion && [r.expansion.queries, r.expansion.searched, r.expansion.source], [4, 3, 'model']);
  assert.deepEqual(searched.slice(0, 3), ['How much is a weekly bike rental?', 'weekly bike rental price', 'rent a bike for a week']);
  assert.match(selectPrompt, /QUESTION: How much is a weekly bike rental\?\nASKED AS: and for a whole week\?/);
  assert.match(r.fin.text, /\$180/);
  assert.ok(r.results.some((x) => x.file_id === 'faq'));
});

test('KnowBot.ask (the website widget): the server engine makes the rewrite call, variants are searched, the last exchanges reach the select prompt', async () => {
  const rows = {
    day: { file_id: 'a', filename: 'faq.md', title: 'FAQ', score: 2, text: 'Do you rent bikes?\nBike rentals cost $45 per day.' },
    week: { file_id: 'b', filename: 'faq.md', title: 'FAQ', score: 2, text: 'Can I rent a bike for a week?\nWeekly bike rentals cost $180, and the rental can start on any day.' },
  };
  const searched = [];
  const search = async (q) => { searched.push(q); return /week/i.test(q) ? [rows.week] : /rent/i.test(q) ? [rows.day] : []; };
  const prompts = [];
  const complete = async (m) => {
    const sys = m[0].content, user = m.at(-1).content;
    prompts.push({ sys, user });
    if (/search queries/.test(sys)) return /week/.test(user) ? '{"standalone":"How much is a weekly bike rental?","queries":["weekly bike rental price"]}' : '{"standalone":"Do you rent bikes?","queries":["bike rental"]}';
    const n = /^L(\d+) .*(?:\$180|\$45)/m.exec(user)?.[1];
    return n ? `L${n}` : 'NONE';
  };
  const { KnowBot } = await import('../knowbot.js');
  const bot = new KnowBot({ apiBase: 'http://127.0.0.1:1', telemetry: false, retriever: { type: 'custom', search }, engine: { type: 'server', complete }, voice: false });
  const a1 = await bot.ask('Do you rent bikes?');
  assert.match(a1.text, /\$45 per day/);
  const a2 = await bot.ask('and for a whole week?');
  assert.match(a2.text, /\$180/);
  assert.ok(searched.includes('How much is a weekly bike rental?') && searched.includes('weekly bike rental price'));
  const rw = prompts.filter((p) => /search queries/.test(p.sys)).at(-1);
  assert.match(rw.user, /Visitor: Do you rent bikes\?\nBot: Bike rentals cost \$45 per day\./);
  const sel = prompts.filter((p) => /You select lines/.test(p.sys)).at(-1);
  assert.match(sel.user, /^Earlier in this conversation \(for understanding the question only; not a source\):/);
  assert.match(sel.user, /QUESTION: How much is a weekly bike rental\?\nASKED AS: and for a whole week\?/);
  // another engine type (in-browser model, OpenAI-compatible): the deterministic rules, no rewrite call
  prompts.length = 0;
  const local = new KnowBot({ apiBase: 'http://127.0.0.1:1', telemetry: false, retriever: { type: 'custom', search }, engine: { type: 'webllm', complete }, voice: false });
  await local.ask('Do you rent bikes?');
  assert.ok(!prompts.some((p) => /search queries/.test(p.sys)));
});

test('buildSelectMessages without history is unchanged', () => {
  const m = buildSelectMessages('Do gift cards expire?', [{ n: 1, text: 'Gift cards never expire.' }]);
  assert.equal(m.at(-1).content, 'LINES:\nL1 Gift cards never expire.\nQUESTION: Do gift cards expire?');
  assert.doesNotMatch(m[0].content, /earlier conversation/);
  assert.equal(buildExpandMessages('q').length, 2);
});

// `node lib/test/recall.test.mjs --table` prints the per-question table
if (process.argv.includes('--table')) {
  const r = await lumen(null);
  const res = await runEval(r);
  for (const x of res.rows) console.log(`${x.single ? 'hit ' : 'miss'}  ${x.expanded ? 'hit ' : 'miss'}  ${x.followUp ? '(follow-up) ' : ''}${x.q}`);
  console.log(`hit@${K}: single ${res.single}/${res.n} (${Math.round((100 * res.single) / res.n)}%), expanded ${res.expanded}/${res.n} (${Math.round((100 * res.expanded) / res.n)}%)`);
}

// KnowBot Studio server: sentence and citation helpers, curated answers, own files, Proof Run queue, restore links, misc routes, Builder product intents (rounds r3, r6, r7).
// Split from trials.test.mjs along its describe boundaries; shared helpers live in trials-helpers.mjs.
// Fakes only: never touches knowDrive or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer, internalSecret } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { etaOf, parseIntent, validatePatch, defaultSpec, normHit, sniffOk, deriveStage, findOffset, hitAllowed, keepRelevantLines, LINE_MARGIN, topicCase, GENERIC_HEADING_RE,
  splitSentences, citeQuotedLines, quotedLineParts, storeIntentOf, sourceSegments, stripSourceLines, lastSourceUrl, answerCheck, cleanTopic, topicsOf, sectionLine, starterGrammarOk, genericNumbered, titleWords, insightKey, refusalReasonOf } from '../trials.mjs';
import { requireCitations, isCourtesy } from '../../lib/knowbot.js';
import { atomize, extractText, startFakeKnowDrive as startKD } from './fake-knowdrive.mjs';
import { NOT_IN_DATA } from '../../lib/knowbot.js';
import { ROOT, DAY, yyyymmdd, sleep, nextIp, parseSSE, openSSE, boot, client, headersOnlyUpload, fakeShop, useFakeSpeed, FAST_SPEED } from './trials-helpers.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1: nothing here may reach a real store
useFakeSpeed(FAST_SPEED);              // nothing here asserts the order of ingest stages (trials-helpers.mjs)

describe('KnowBot Studio server (trials.mjs): answers r3-r7, proof run, misc routes', () => {
  let S, c, registryWritesBefore, spies;

  before(async () => {
    S = await boot();
    c = client(S);
    await S.kb.registry.ready;
    // the registry's own start-up housekeeping may save once or twice: let it settle before the studio runs
    const regWrites = () => S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path === 'knowbot/_config/instances.json').length;
    for (let last = -1, i = 0; i < 40 && regWrites() !== last; i++) { last = regWrites(); await sleep(150); }
    registryWritesBefore = regWrites();
    spies = { createBucket: 0, create: 0, commit: 0 };
    for (const k of Object.keys(spies)) { const orig = S.kb.registry[k]?.bind(S.kb.registry); S.kb.registry[k] = (...a) => { spies[k]++; return orig?.(...a); }; }
  });
  after(async () => { await S.close(); });

  // ---------------------------------------------------------------------------------------------- sample trial shared by 8–13
  let sample;
  async function sampleTrial() {
    if (sample) return sample;
    const t = await c.trial();
    const r = await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' });
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.equal(j.files.length, 4);
    assert.ok(j.files.every((f) => f.sample));
    assert.equal(j.spec.name, 'Lumen Help');
    const again = await (await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' })).json();
    assert.deepEqual(again.files.map((f) => f.id).sort(), j.files.map((f) => f.id).sort(), 'samples are idempotent');
    const files = await c.waitReady(t, 4);
    assert.ok(files.every((f) => f.stage === 'ready' && f.atoms > 0));
    sample = { t, files };
    return sample;
  }


  /** A sample trial of its own (the shared one is near its per-minute ask limit by now). */
  async function freshSample() {
    const t = await c.trial();
    assert.equal((await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' })).status, 201);
    await c.waitReady(t, 4);
    return { t };
  }
  // ---------------------------------------------------------------------------------------------- fixer r3
  test('r3: sentences end only at real sentence ends; quoted lines stay whole (pure)', () => {
    assert.deepEqual(splitSentences('To make a warranty claim, email us. Email warranty@lumenbikes.example with photos and your serial number.'),
      ['To make a warranty claim, email us.', 'Email warranty@lumenbikes.example with photos and your serial number.']);
    assert.deepEqual(splitSentences('A tube costs $1.50, e.g. for a 700c wheel. See lumenbikes.example/help.html for more. 3 left'),
      ['A tube costs $1.50, e.g. for a 700c wheel.', 'See lumenbikes.example/help.html for more.', '3 left']);
    // lib requireCitations alone keeps only the fragment after the address's dot; citeQuotedLines keeps the quoted line
    const fin = { text: 'To make a warranty claim, email us. Email warranty@lumenbikes.example with photos and your serial number. [1]', citations: [{ n: 1, file_id: 'f1' }], refused: false };
    // the lib may split at every stop (historic) or only at a stop followed by whitespace; never mid-address beyond that
    const rc = requireCitations(fin).text;
    assert.ok(rc === fin.text || /^example with photos/.test(rc) || /^Email warranty@lumenbikes\.example with photos/.test(rc), rc);
    assert.equal(citeQuotedLines(fin, requireCitations).text, fin.text);
    const two = { ...fin, text: '- Test rides last 30 minutes and require photo ID. We will set the saddle height. [1]\n- Test rides on weekdays need no booking. [1]' };
    assert.equal(citeQuotedLines(two, requireCitations).text, two.text);
    const unmarked = { ...fin, text: 'An uncited line.\nA cited one. [1]' };
    assert.equal(citeQuotedLines(unmarked, requireCitations).text, requireCitations(unmarked).text, 'a line without its own marker is still judged by sentence');
  });

  test('librarian voice: courtesy lines may stand unmarked only as opener/closer; proof helpers split by Source lines (pure)', () => {
    const c1 = [{ n: 1, file_id: 'f1' }, { n: 2, file_id: 'f2' }];
    // one-line guide answer: opener + pointer + quote + closer, an e-mail address inside the quote stays whole
    const one = { text: "I think I found what you're looking for! In “Warranty”, under “Claims”, it says: “Email warranty@lumenbikes.example with photos” [1]. Hope this helps!", citations: c1.slice(0, 1), refused: false };
    assert.equal(citeQuotedLines(one, requireCitations).text, one.text);
    const parts = quotedLineParts(one.text);
    assert.equal(parts.opener, "I think I found what you're looking for!");
    assert.equal(parts.closer, 'Hope this helps!');
    assert.match(parts.body, /^In “Warranty”.*\[1\]\.$/);
    // list answer: opener line, a pointer line, cited bullets, closer line
    const list = { text: "Here's what I found!\n- From “A”: “Helmets are free” [1]\n- From “B”: “Locks cost $5” [2]\nFeel free to ask if you have any other questions.", citations: c1, refused: false };
    assert.equal(citeQuotedLines(list, requireCitations).text, list.text);
    // a courtesy line in the middle, or courtesy alone, is never accepted as is
    const mid = { ...list, text: '- “Helmets are free” [1]\nHope this helps!\n- “Locks cost $5” [2]' };
    assert.notEqual(citeQuotedLines(mid, requireCitations).text, mid.text);
    assert.equal(citeQuotedLines({ ...list, text: 'Hope this helps!' }, requireCitations).refused, true);
    // an uncited fact line is still dropped
    const fact = { ...list, text: "Here's what I found!\nShipping is free.\n- “Helmets are free” [1]" };
    assert.doesNotMatch(citeQuotedLines(fact, requireCitations).text, /Shipping is free/);
    // Source lines: split into sections with their URL, stripped from what is quoted
    const segs = sourceSegments('tail of an earlier product\n\n## Trail Pro\n\nSource: https://shop.example/products/trail-pro\n- Price: 1,299.00 USD\n## Mug\nSource: https://shop.example/products/mug\nHandmade.');
    assert.deepEqual(segs.map((x) => [x.url, x.heading]), [[null, null], ['https://shop.example/products/trail-pro', 'Trail Pro'], ['https://shop.example/products/mug', 'Mug']]);
    assert.ok(!segs.some((x) => /Source:/.test(stripSourceLines(x.text))));
    assert.equal(lastSourceUrl('a\nSource: https://x.example/a\nb\nSource: https://x.example/b'), 'https://x.example/b');
    assert.equal(lastSourceUrl('Source: javascript:alert(1)'), null);
  });

  test('r3: answerCheck wants the asked-for fact: expected substrings, shared terms, a duration for "how long" (pure)', () => {
    assert.equal(answerCheck('How long does a test ride last?', ['We will set the saddle height and show you the gears before you head out on the cycle path.']).ok, false);
    assert.equal(answerCheck('How long does a test ride last?', ['Test rides last 30 minutes and require photo ID.']).ok, true);
    assert.equal(answerCheck('How much is a Full Overhaul?', ['Full Overhaul is a complete strip-down.']).ok, false);
    assert.equal(answerCheck('How do I make a warranty claim?', ['example with photos and your serial number.'], ['warranty@lumenbikes.example']).ok, false);
    assert.equal(answerCheck('How do I make a warranty claim?', ['Warranty claims: Email warranty@lumenbikes.example with photos and your serial number.'], ['warranty@lumenbikes.example']).ok, true);
  });

  test('r3: curated answers say what was asked, with no fragments, in the Studio and on /v1', async () => {
    const { t } = await sampleTrial();
    const key = (await (await c.json(t, '/devkey')).json());
    const k = key.key || key.apiKey || key.token;
    const cases = [
      ['How long does a test ride last?', /30 minutes/, /saddle height/],
      ['How do I make a warranty claim?', /warranty@lumenbikes\.example/, /^example/i],
      ['How long is the frame warranty?', /lifetime/, null],
      ['How long are batteries covered?', /800 full charge cycles/, null],
      ['Do you offer financing?', /0% financing for 12 months/, null],
      ['How much does it cost to rent a bike?', /\$45 per day/, /lube|wash/],
    ];
    for (const [q, want, never] of cases) {
      const final = (await c.stream(t, '/ask', { question: q })).find((e) => e.event === 'final').data;
      assert.equal(final.status, 'grounded', `${q}: ${final.text}`);
      assert.match(final.text, want, `${q}: ${final.text}`);
      if (never) assert.doesNotMatch(final.text.split('\n')[0], never, `${q}: ${final.text}`);
      assert.ok(final.proof.quotedLines.every((l) => /^[A-Z0-9"“]/.test(l.text) && l.text.split(/\s+/).length >= 4), `${q}: fragment quoted: ${final.text}`);
      assert.ok(final.check?.ok, `${q}: check ${JSON.stringify(final.check)}`);
      const v1 = await (await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })).json();
      assert.match(v1.answer, want, `/v1 ${q}: ${v1.answer}`);
      assert.ok(/^[A-Z0-9"“]/.test(v1.answer), `/v1 ${q} starts mid-sentence: ${v1.answer}`);
    }
    // the warranty-claim answer (what the Launch card and checkout show) carries the address, not "example with photos…"
    const claim = (await c.stream(t, '/ask', { question: 'How do I make a warranty claim?' })).find((e) => e.event === 'final').data;
    assert.ok(claim.text.includes('warranty@lumenbikes.example'), claim.text);
    assert.deepEqual(claim.check.expected, ['warranty@lumenbikes.example']);
  });

  test('r3: every curated sample question carries an expected substring and every proof question answers with it', async () => {
    const sq = JSON.parse(await fsp.readFile(path.join(ROOT, 'studio/samples/lumen-bikes/questions.json'), 'utf8'));
    const { t } = await sampleTrial();
    for (const q of sq.proof) {
      assert.ok(Array.isArray(sq.expect?.[q]) && sq.expect[q].length, `questions.json expect is missing ${q}`);
      const final = (await c.stream(t, '/ask', { question: q, label: 'Proof Run' })).find((e) => e.event === 'final').data;
      assert.equal(final.status, 'grounded', q);
      assert.equal(final.check.ok, true, `${q}: ${final.text} ${JSON.stringify(final.check)}`);
    }
  });

  test('r3: the sample corpus is 400+ atoms and keeps every spec fact verbatim', async () => {
    const dir = path.join(ROOT, 'studio/samples/lumen-bikes');
    let total = 0;
    const text = {};
    for (const f of (await fsp.readdir(dir)).filter((x) => !x.endsWith('.json'))) { const b = await fsp.readFile(path.join(dir, f)); text[f] = extractText(b, '', f); total += atomize(text[f]).length; }
    assert.ok(total >= 400 && total <= 650, `sample atoms ${total}`);
    const facts = { 'lumen-warranty-returns.md': ['Lumen frames carry a lifetime warranty for the original owner.', 'Components are covered for 2 years from purchase.', 'E-bike batteries are covered for 2 years or 800 full charge cycles, whichever comes first.', 'Unridden bikes can be returned within 30 days with the receipt.', 'E-bike returns carry a 15% restocking fee.', 'Crash replacement: 40% off a new frame within 3 years of purchase.', 'Email warranty@lumenbikes.example with photos and your serial number.', 'Claims are processed in 5–7 business days.'],
      'lumen-service-plans.html': ['Basic Tune-Up costs $79.', 'Full Overhaul costs $229.', 'costs $149 per year and includes two tune-ups and 10% off parts.', 'Every new bike gets a free 30-day check.', 'Standard turnaround is 3–5 business days.', 'Mobile service within city limits has a $35 call-out fee.'],
      'lumen-store-faq.txt': ['The store is open Monday to Saturday 9am–6pm and Sunday 11am–4pm.', 'We are closed on public holidays.', 'Test rides last 30 minutes and require photo ID.', 'Trade-in credit is up to 30% of the original price.', '0% financing for 12 months is available on bikes over $1,000.', 'Bike rentals cost $45 per day.'],
      'lumen-price-list-2026.md': ['| Lumen Commuter 3 | city | $1,149 | S/M/L | Dynamo lights included |', '| Lumen E-City | e-bike | $3,199 | M/L | 500 Wh battery, about 90 km range |', 'Prices include assembly and the 30-day check.'] };
    for (const [f, list] of Object.entries(facts)) for (const x of list) assert.ok(text[f].includes(x), `${f} lost "${x}"`);
    // FAQ answers keep one sentence per line, so a line-level quote is always a whole sentence
    for (const l of text['lumen-store-faq.txt'].split('\n')) assert.ok(!/[a-z]\. [a-z]/.test(l), `lowercase sentence start in: ${l}`);
  });

  test('r3: own handbook: paid time off answers with 25 days; starters read naturally; topics are clean', async () => {
    assert.equal(cleanTopic('Section 4. Travel policy variant 1'), 'Travel policy');
    assert.equal(cleanTopic('2.3 Paid time off:'), 'Paid time off');
    assert.equal(cleanTopic('Section 7'), '');
    assert.equal(cleanTopic('day section full'), '');
    assert.equal(starterGrammarOk('How long is the economy class used?'), false);
    assert.equal(starterGrammarOk('How long is the equipment replaced?'), false);
    assert.equal(starterGrammarOk('How much does the a parking permit cost?'), false);
    assert.equal(starterGrammarOk('How long are e-bike batteries covered?'), true);
    assert.deepEqual(topicsOf([{ text: 'x', meta: { breadcrumb: 'Handbook > Section 2. Paid time off' } }, { text: 'y', meta: { breadcrumb: 'Handbook > Section 4. Travel policy variant 1' } }]), ['paid time off', 'travel policy']);
    const doc = ['# Northwind Employee Handbook', 'This handbook sets out the policies that apply to every Northwind employee.',
      '## Section 1. Working hours', 'Core hours are 10am to 4pm, Monday to Friday.',
      '## Section 2. Paid time off', 'Full-time employees receive 25 days of paid vacation per year, plus public holidays.', 'Up to 5 unused days can be carried over into the next year, and carried-over days must be used by 31 March.',
      '## Section 4. Travel policy variant 1', 'Economy class is used for flights under 6 hours. Business class is allowed for flights over 6 hours with director approval.', 'Hotel costs are reimbursed up to $180 per night in most cities.',
      '## Section 5. Equipment', 'Laptops are replaced every 3 years. Phones are replaced every 2 years.',
      '## Section 6. Parental leave', 'Primary carers receive 26 weeks of full pay. Secondary carers receive 4 weeks of full pay.'].join('\n\n');
    const t = await c.trial();
    const up = await (await c.upload(t, 'handbook.md', Buffer.from(doc))).json();
    await c.waitReady(t, 1);
    const final = (await c.stream(t, '/ask', { question: 'How many days of paid time off do I get?' })).find((e) => e.event === 'final').data;
    assert.equal(final.status, 'grounded', final.text);
    assert.match(final.text.split('\n')[0], /25 days of paid vacation/, final.text);
    assert.ok(final.check.ok);
    const q = await (await c.json(t, '/questions')).json();
    const all = [...q.starters, ...q.proof].map((x) => x.q);
    assert.ok(q.starters.length >= 3, JSON.stringify(q.starters));
    assert.ok(all.every(starterGrammarOk), all.join(' | '));
    assert.ok(!all.some((x) => /\b(?:used|replaced)\?$|section \d|variant/i.test(x)), all.join(' | '));
    for (const s of q.starters) {
      const fin = (await c.stream(t, '/ask', { question: s.q })).find((e) => e.event === 'final').data;
      assert.equal(fin.status, 'grounded', `${s.q}: ${fin.text}`);
      assert.ok(fin.check.ok, `${s.q}: ${fin.text} ${JSON.stringify(fin.check)}`);
    }
    const files = await (await c.json(t, '/files')).json();
    const f = files.files.find((x) => x.id === up.file.id);
    if (f.summary) {
      assert.ok(f.summary.topics.length >= 2 && f.summary.topics.every((x) => !/section|variant|\d/i.test(x) && x.split(/\s+/).length >= 1), JSON.stringify(f.summary));
    }
  });

  test('r6: starters never read "the its warranty" or "rental item 1"; topics drop verb bigrams; file copy pluralizes and names without a possessive', async () => {
    assert.equal(starterGrammarOk('How long does the its warranty last?'), false);
    assert.equal(starterGrammarOk('How much does the rental item 1 cost?'), false);
    assert.equal(genericNumbered('rental item 2'), true);
    assert.equal(genericNumbered('Lumen Aero'), false);
    assert.equal(titleWords('bike shop'), 'Bike Shop');
    assert.equal(titleWords('house of KDE'), 'House of KDE');
    const body = 'The robot arm has a reach of 1.2 metres. The robot arm has six joints and the arm has a payload of 5 kg. Its warranty lasts 3 years. The warranty lasts 3 years from delivery and the warranty lasts longer with service.';
    const topics = topicsOf([{ text: body, meta: { breadcrumb: '' } }, { text: body, meta: { breadcrumb: '' } }], { n: 3 });
    assert.ok(!topics.some((x) => /\b(?:has|lasts)$/.test(x)), topics.join(' | '));
    assert.ok(topics.includes('robot arm'), topics.join(' | '));
    const doc = '# Robot Arm Manual\n\nThe robot arm has a reach of 1.2 metres and six joints.\n\nIts warranty lasts 3 years from delivery. The robot arm costs $4,900.\n\n| Item | Price |\n|---|---|\n| Rental item 1 | $40 |\n| Rental item 2 | $55 |\n';
    const t = await c.trial();
    await c.upload(t, 'arm.md', Buffer.from(doc));
    await c.waitReady(t, 1);
    const q = await (await c.json(t, '/questions')).json();
    const all = [...q.starters, ...q.proof].map((x) => x.q);
    assert.ok(!all.some((x) => /\bthe its\b|item \d/i.test(x)), all.join(' | '));
    const at = (await c.stream(t, '/setup', { event: { type: 'file_atomized', data: {} } })).filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    // fixer r8 (D2): the file is described by its headings or first descriptive sentence, never by keyword triples
    // ("It covers robot arm, arm has and warranty lasts")
    assert.doesNotMatch(at, /\b1 atoms\b|It covers|Sections:[^.]*\b(?:arm has|warranty lasts)/, at);
    assert.match(at, /\*\*arm\.md\*\*: 3 atoms so far\. The robot arm has a reach of 1\.2 metres and six joints\./, at);
    const rd = (await c.stream(t, '/setup', { event: { type: 'file_ready', data: {} } })).filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.doesNotMatch(rd, /\b1 atoms\b|All 1 file|1 of 1 files/, rd);
    assert.match(at, /Looks like a robot arm manual\./, at);
    // a single topic word title ("Shipping Policy") is not an org: no "Shipping's policy", and the name is "Shipping Help"
    const t2 = await c.trial();
    await c.upload(t2, 'shipping.md', Buffer.from('# Shipping Policy\n\nOrders ship within 2 business days.\n'));
    await c.waitReady(t2, 1);
    const sh = (await c.stream(t2, '/setup', { event: { type: 'file_atomized', data: {} } })).filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.doesNotMatch(sh, /'s policy|\b1 atoms\b|Shipping Guide/, sh);
    if (/Call it/.test(sh)) assert.match(sh, /Looks like a shipping policy\. Call it \*\*Shipping Help\*\*\?/, sh);
  });

  test('r2: a Proof Run asked for while files learn is queued, a partial run never passes, and it starts when all are Ready', async () => {
    const S2 = await boot({ speed: 0.5 });
    const c2 = client(S2);
    try {
      const t = await c2.trial();
      await c2.json(t, '/samples', 'POST', { set: 'lumen-bikes' });
      const turn = async (body) => { const ev = await c2.stream(t, '/setup', body); return { reply: ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), actions: ev.filter((e) => e.event === 'action').map((e) => e.data), chips: ev.find((e) => e.event === 'chips').data.chips }; };
      // wait for the first Ready file while others still learn
      let files = [];
      for (let i = 0; i < 600; i++) { files = (await (await c2.json(t, '/files')).json()).files; if (files.some((f) => f.stage === 'ready')) break; await sleep(25); }
      assert.ok(files.some((f) => f.stage === 'ready') && files.some((f) => f.stage !== 'ready'), files.map((f) => f.stage).join(','));
      const q = await (await c2.json(t, '/questions')).json();
      assert.ok(q.pending.files > 0 && q.complete === false, JSON.stringify(q.pending));
      const run = await turn({ message: 'run the proof run' });
      assert.ok(!run.actions.some((a) => a.type === 'run_proof'), 'no partial run while files learn');
      assert.match(run.reply, /Waiting for \d+ files? to finish learning/);
      // a client that ran anyway reports 6/6: it does not count as a pass
      const partial = await turn({ event: { type: 'proof_done', data: { score: { answered: 5, total: 5, refused: 1, probes: 1 } } } });
      assert.doesNotMatch(partial.reply, /Proof Run passed/);
      assert.match(partial.reply, /doesn't count yet/);
      await c2.waitReady(t, 4, 60000);
      const next = await turn({ message: 'looks good' });
      assert.ok(next.actions.some((a) => a.type === 'run_proof' && a.mini === false), `queued run starts: ${next.reply}`);
      assert.match(next.reply, /Running the full Proof Run now/);
      const full = await (await c2.json(t, '/questions')).json();
      const total = full.proof.length + full.probes.length;
      const short = await turn({ event: { type: 'proof_done', data: { score: { passed: total - 2, total: total - 2 } } } });
      assert.doesNotMatch(short.reply, /Proof Run passed/, 'fewer than the full set never passes');
      const done = await turn({ event: { type: 'proof_done', data: { score: { passed: total, total } } } });
      assert.match(done.reply, /Proof Run passed/);
      // after the pass: no stale proof chip, and a price question gets the card
      const after = await turn({ message: 'how much to launch?' });
      assert.ok(after.card || after.actions.some((a) => a.type === 'show_launch') || after.chips.some((x) => x.action?.type === 'show_launch'));
      assert.ok(!after.chips.some((x) => x.action?.type === 'run_proof'), after.chips.map((x) => x.label).join(','));
      const ev2 = await c2.stream(t, '/setup', { message: 'how much to launch?' });
      assert.ok(ev2.some((e) => e.event === 'card' && e.data.type === 'launch') || ev2.some((e) => e.event === 'action' && e.data.type === 'show_launch'), 'asking again still gets the card');
    } finally { await S2.close(); }
  });

  test('r1: a restore key in the shared link reopens the bot on another device (exchanged for the bearer)', async () => {
    const t = await c.trial();
    const g = await (await c.json(t, '')).json();
    assert.ok(g.restoreKey && g.shareLink.includes(`?t=${t.trialId}&k=`), g.shareLink);
    const em = await (await S.api(`/api/studio/trials/${t.trialId}/email`, { method: 'POST', headers: c.h(t, null, { 'content-type': 'application/json', origin: 'https://studio.example' }), body: JSON.stringify({ email: 'a@b.co' }) })).json();
    assert.match(em.link, new RegExp(`^https://studio\\.example/studio/\\?t=${t.trialId}&k=[\\w.-]+$`));
    const k = decodeURIComponent(new URL(em.link).searchParams.get('k'));
    const other = nextIp();
    const r = await S.api(`/api/studio/trials/${t.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': other }, body: JSON.stringify({ k }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.trialId, t.trialId);
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}`, { headers: { authorization: `Bearer ${j.token}`, 'x-forwarded-for': other } })).status, 200, 'the exchanged bearer works');
    // the restore key is not a bearer, is bound to its trial, and forged keys fail
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}`, { headers: { authorization: `Bearer ${k}` } })).status, 401);
    const y = await c.trial();
    // r5: a link that doesn't verify (or an unknown id) is 404 not_found, never the false "expired" claim
    assert.equal((await S.api(`/api/studio/trials/${y.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k }) })).status, 404);
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: `${k.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAA` }) })).status, 404);
    assert.equal((await S.api(`/api/studio/trials/${t.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: t.token }) })).status, 404, 'a bearer is not a restore key');
    const unknown = await S.api('/api/studio/trials/tr_doesnotexist/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: 'bad' }) });
    assert.equal(unknown.status, 404);
    const uj = await unknown.json();
    assert.equal(uj.error.code, 'not_found');
    assert.doesNotMatch(uj.error.message, /expired|deleted/i);
    S.clock.skew = 8 * DAY;
    try {
      const ex = await S.api(`/api/studio/trials/${t.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k }) });
      assert.equal(ex.status, 410);
      assert.equal((await ex.json()).error.code, 'expired');
    } finally { S.clock.skew = 0; }
  });

  // ---------------------------------------------------------------------------------------------- misc routes
  test('config, files list, atoms window, delete, 404/405, samples removal', async () => {
    const cfg = await (await S.api('/api/studio/config')).json();
    assert.equal(cfg.price.amount, 549);
    assert.equal(cfg.price.answersIncluded, null);
    assert.equal(cfg.floor, 0.7);
    assert.equal(cfg.builder.engine, 'scripted');
    assert.deepEqual(cfg.samples.map((s) => [s.id, s.files]), [['lumen-bikes', 4]]);
    assert.equal(cfg.anchors.asOf, '2026-11');
    assert.equal(cfg.types.length, 9);
    const t = await c.trial();
    await c.json(t, '/samples', 'POST', {});
    const files = await c.waitReady(t, 4);
    const f = files.find((x) => x.name === 'lumen-store-faq.txt');
    assert.equal(f.kind, 'txt');
    assert.ok(f.stageAt.uploaded && f.stageAt.ready >= f.stageAt.uploaded);
    const win = await (await c.json(t, `/files/${f.id}/atoms?around=3&span=1`)).json();
    assert.deepEqual(win.items.map((a) => a.seq), [2, 3, 4]);
    assert.ok(win.items.every((a) => a.text.length <= 800 && a.atomId));
    assert.equal((await c.json(t, '/files/file_nope')).status, 404);
    const other = await c.trial();
    assert.equal((await c.json(other, `/files/${f.id}`, 'DELETE')).status, 404, 'another trial cannot delete it');
    assert.equal((await c.json(t, '/nope')).status, 404);
    assert.equal((await c.json(t, '/ask')).status, 405);
    assert.equal((await c.json(t, `/files/${f.id}`, 'DELETE')).status, 204);
    assert.equal((await c.json(t, '/samples', 'DELETE')).status, 204);
    const after = await (await c.json(t, '/files')).json();
    assert.equal(after.files.length, 0);
    assert.equal(after.usage.bytes, 0);
    assert.equal((await (await c.json(t, '')).json()).spec.sampleSet, null);
  });

  // ---------------------------------------------------------------------------------------------- 4.11
  // ------------------------------------------------------------------------------------------- fixer r7
  test('r7: Builder product intents: 15 phrasings route to developers, insights, inventory, refusal, language (pure table)', () => {
    const files = [{ stage: 'ready' }];
    const table = [
      ['how do I use this from my own app?', 'open_developers'],
      ['Is there an API?', 'open_developers'],
      ['can I integrate it with our backend', 'open_developers'],
      ['show me the developer docs', 'open_developers'],
      ['what did people ask so far?', 'show_insights'],
      ['which questions went unanswered?', 'show_insights'],
      ['show me the question insights', 'show_insights'],
      ['what is in my files?', 'show_inventory'],
      ['what do my files cover?', 'show_inventory'],
      ['what did it learn so far?', 'show_inventory'],
      ['change the refusal message', 'explain_refusal'],
      ['what does it say when it doesn\'t know?', 'explain_refusal'],
      ['can it answer in French?', 'explain_language'],
      ['what languages does it speak?', 'explain_language'],
      ['set the greeting to "Welcome to Spokes!"', 'greeting'],
    ];
    for (const [q, want] of table) {
      const p = parseIntent(q, { files, spec: {} });
      assert.ok(p.intents.includes(want), `${q} -> ${p.intents.join(',')} (want ${want})`);
      assert.ok(!p.actions.some((a) => a.type === 'ask_samplebot'), `${q} is a Builder question, never sent to the bot`);
    }
    // bot questions and bot descriptions stay what they were
    assert.deepEqual(parseIntent('How long is the frame warranty?', { files, spec: {} }).intents, ['ask_question']);
    assert.ok(!parseIntent('a bot for our developers', { files, spec: {} }).intents.includes('open_developers'));
    assert.equal(parseIntent('rename it to Lumen Help').patch.name, 'Lumen Help');
  });

  test('r7: the Builder answers product questions with the right reply, card and chips (scripted)', async () => {
    const { t } = await freshSample();
    const turn = async (message) => {
      const ev = await c.stream(t, '/setup', { message });
      return { reply: ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), chips: ev.find((e) => e.event === 'chips').data.chips, card: ev.find((e) => e.event === 'card')?.data || null,
        actions: ev.filter((e) => e.event === 'action').map((e) => e.data) };
    };
    const dev = await turn('how do I use this from my own app?');
    assert.match(dev.reply, /chat API/);
    assert.match(dev.reply, /OpenAI-compatible/);
    assert.deepEqual(dev.chips.map((x) => x.label).slice(0, 2), ['Developers', 'Set up']);
    assert.deepEqual(dev.chips[0].emit, { type: 'golive:open', detail: { tab: 'developers' } });
    assert.ok(dev.chips.some((x) => x.action?.type === 'show_launch'));
    assert.ok(!dev.actions.some((a) => a.type === 'ask_samplebot'));
    const inv = await turn('what is in my files?');
    assert.match(inv.reply, /knows 4 files, [\d,]+ atoms it can quote/);
    for (const n of ['lumen-warranty-returns.md', 'lumen-store-faq.txt']) assert.match(inv.reply, new RegExp(n.replace(/\./g, '\\.')));
    assert.ok(inv.chips.some((x) => x.action?.type === 'ask_samplebot' && x.action.question), 'one real starter to try');
    const ref = await turn('change the refusal message');
    assert.ok(ref.reply.includes(NOT_IN_DATA), ref.reply);
    assert.match(ref.reply, /fixed on purpose/);
    assert.ok(ref.chips.some((x) => x.label === 'Change greeting'));
    assert.ok(ref.chips.some((x) => x.label === 'Ask something off-topic'));
    const lang = await turn('can it answer in French?');
    assert.match(lang.reply, /French/);
    assert.ok(lang.chips.some((x) => x.action?.type === 'ask_samplebot' && /français|coûte/i.test(x.action.question)));
    await c.stream(t, '/ask', { question: 'How much is a Full Overhaul?' });
    const ins = await turn('what did people ask so far?');
    assert.match(ins.reply, /\d+ questions? so far: \d+ answered from your files, \d+ refused/);
    assert.equal(ins.card?.type, 'insights');
    assert.ok(ins.card.data.top.some((x) => x.q === 'How much is a Full Overhaul?'));
    assert.ok(!ins.card.data.top.some((x) => /weather in Paris/.test(x.q)), 'the Builder\'s own probes are not insights');
  });

  test('r7: composite edits confirm every clause in one sentence; "use your samples" says Loading once', async () => {
    const { t } = await sampleTrial();
    const ev = await c.stream(t, '/setup', { message: 'make answers shorter and only answer staff questions' });
    const reply = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(reply, /speaks to employees/, reply);
    assert.match(reply, /answers are (?:already )?short/, reply);
    assert.match(reply, /"staff questions" doesn't match a file, so .+ still searches all 4 files/, reply);
    assert.doesNotMatch(reply, /Pick one to keep|Also:/, reply);
    const t2 = await c.trial();
    const typed = (await c.stream(t2, '/setup', { message: 'skip ahead, just use your samples' })).filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(typed, /^Loading Lumen Bikes' sample docs/);
    assert.equal((await c.json(t2, '/samples', 'POST', { set: 'lumen-bikes' })).status, 201);
    const draft = await c.stream(t2, '/setup', { event: { type: 'samples_attached', data: { set: 'lumen-bikes' } } });
    const dr = draft.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.doesNotMatch(dr, /Loading/, `one Loading line, not two: ${dr}`);
    assert.equal(draft.find((e) => e.event === 'card')?.data.type, 'config-diff');
  });

  test('r7: sample files never overwrite a name the person chose; the sample name is offered as a chip', async () => {
    const t = await c.trial();
    await c.stream(t, '/setup', { message: 'call it Spokes, for my bike shop' });
    const r = await (await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' })).json();
    assert.equal(r.spec.name, 'Spokes', 'the name the person set stays');
    assert.equal(r.spec.org, 'Bike shop');
    assert.equal(r.spec.length, 'short', 'fields still at their default take the sample draft');
    const ev = await c.stream(t, '/setup', { event: { type: 'samples_attached', data: { set: 'lumen-bikes', prevName: 'Spokes' } } });
    const reply = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(reply, /kept what you set, the name \*\*Spokes\*\*/);
    const card = ev.find((e) => e.event === 'card')?.data;
    assert.ok(!card || !card.data.rows.some((x) => x.field === 'Name'), 'no Name row: nothing changed it');
    const chips = ev.find((e) => e.event === 'chips').data.chips;
    const offer = chips.find((x) => /^Rename to Lumen Help\?$/.test(x.label));
    assert.ok(offer && offer.send === 'Call it Lumen Help', JSON.stringify(chips));
    assert.equal((await (await c.json(t, '')).json()).spec.name, 'Spokes');
    // an untouched trial still gets the whole draft
    const u = await c.trial();
    assert.equal((await (await c.json(u, '/samples', 'POST', { set: 'lumen-bikes' })).json()).spec.name, 'Lumen Help');
  });

  test('r7: multi-part questions quote one line per part, best first, citing two files (Studio and /v1)', async () => {
    const { t } = await freshSample();
    const sq = JSON.parse(await fsp.readFile(path.join(ROOT, 'studio/samples/lumen-bikes/questions.json'), 'utf8'));
    assert.ok(sq.multiSource.length >= 3 && sq.multiSource.every((q) => sq.proof.includes(q) || sq.starters.includes(q)), 'three curated multi-source questions');
    for (const q of sq.multiSource) {
      const final = (await c.stream(t, '/ask', { question: q })).find((e) => e.event === 'final').data;
      assert.equal(final.status, 'grounded', q);
      assert.ok(new Set(final.citations.map((x) => x.file)).size >= 2, `${q}: [1][2] from two files: ${final.text}`);
      assert.match(final.text, /\[1\][\s\S]*\[2\]/, final.text);
      assert.equal(final.check.ok, true, `${q}: ${JSON.stringify(final.check)}`);
    }
    // the same two-file answer through the developer API (/v1/bots/:id/chat with the trial key)
    const dk = await (await c.json(t, '/devkey')).json();
    const api = await (await S.api(dk.endpoints.chat.replace(/^https?:\/\/[^/]+/, ''), { method: 'POST', headers: { authorization: `Bearer ${dk.key}`, 'content-type': 'application/json', 'x-forwarded-for': t.ip },
      body: JSON.stringify({ question: sq.multiSource[0] }) })).json();
    assert.ok(new Set((api.citations || []).map((x) => x.file || x.filename)).size >= 2, JSON.stringify(api));
    // the strongest quote leads (the 30-day return rule, not the inspection line)
    const ret = (await c.stream(t, '/ask', { question: 'How long do I have to return a bike?' })).find((e) => e.event === 'final').data;
    assert.match(ret.text.split('\n').find((l) => /\[\d+\]/.test(l)), /30 days/, ret.text);
    // a list question quotes more than one line
    const inc = (await c.stream(t, '/ask', { question: 'What does the Lumen Care Plan include?' })).find((e) => e.event === 'final').data;
    assert.ok(inc.proof.quotedLines.length >= 2, inc.text);
    assert.match(inc.text, /two tune-ups/);
  });

  test('r7: the line picker needs the head noun phrase: "bike fitting" never quotes mudguard fitting (pure + Studio)', async () => {
    const { selectLines } = await import('./fake-llm.mjs');
    const L = (arr) => arr.map((text, i) => ({ n: i + 1, text }));
    const without = L(['Can you fit mudguards to my bike?', 'Mudguard fitting costs $20 plus the mudguards, and most bikes can take them.',
      'Can I fit a child seat to my bike?', 'We fit rear child seats on bikes with a rack rated to 25 kg, and fitting is free when you buy the seat from us.',
      'Do you sell bike lights?', 'Our USB-C front and rear light set costs $49, and dynamo lights can be fitted in the workshop.']);
    assert.equal(selectLines('Do you do bike fitting?', without), 'NONE', 'a different FAQ question is a different topic');
    const withFit = L(['Can you fit mudguards to my bike?', 'Mudguard fitting costs $20 plus the mudguards, and most bikes can take them.',
      'Do you help with bike fitting?', 'A basic fit is free with every new bike.', 'A full fit session with saddle, bar and cleat set-up takes 90 minutes and is booked separately.']);
    assert.match(selectLines('Do you do bike fitting?', withFit), /^L4\b/);
    assert.doesNotMatch(selectLines('Do you do bike fitting?', withFit), /\bL2\b/);
    // the same sentence from two passages is quoted once; a multi-part question takes one line per part, in order
    assert.equal(selectLines('How much is a rental?', L(['Bike rentals cost $45 per day.', 'Bike rentals cost $45 per day.'])), 'L1');
    const two = selectLines('How much is a spare E-City battery and how long is it covered?', L(['A spare E-City battery costs $649.', 'A battery damaged by a fall or a crash is not covered by the warranty.',
      'E-bike batteries are covered for 2 years or 800 full charge cycles, whichever comes first.']));
    assert.equal(two, 'L1, L3');
    const { t } = await freshSample();
    const fit = (await c.stream(t, '/ask', { question: 'Do you do bike fitting?' })).find((e) => e.event === 'final').data;
    assert.doesNotMatch(fit.text, /Mudguard|child seat/i, fit.text);
    if (fit.status === 'grounded') assert.match(fit.text, /fit/i);
  });

  test('r7: the fake chunker splits a 5 MB paragraph into ~1,200-char atoms and its stages scale with size', async () => {
    const sentence = 'Late returns of a rental kayak are charged $35 per day after the due time. ';
    const big = sentence.repeat(Math.ceil(5e6 / sentence.length));
    const atoms = atomize(big);
    assert.ok(atoms.length > 3000, `${atoms.length} atoms`);
    assert.ok(atoms.every((a) => a.len <= 1200 && big.slice(a.offset, a.offset + a.len) === a.text), 'atoms are bounded and offsets exact');
    assert.ok(atoms.every((a) => /\.$/.test(a.text)), 'cut at sentence ends');
    // stage timing: a 2 MB file is still extracting when a small one is long done
    const kd = await startKD({ speed: 1 });
    try {
      const small = kd.add({ path: 'a.txt', text: 'Short file. One fact.', pipeline: true });
      const large = kd.add({ path: 'b.txt', text: sentence.repeat(30000), bytes: 2.3e6, pipeline: true });
      await sleep(1500);
      assert.notEqual(small.phase, 'pending');
      assert.equal(large.phase, 'pending', 'a 2 MB file takes longer to extract');
    } finally { await kd.close(); }
  });

  test('r7: a large own file (100+ atoms) always gets a validated starter that its bot answers', async () => {
    const t = await c.trial();
    const items = ['kayak', 'canoe', 'tent', 'wetsuit', 'dry bag', 'roof rack'];
    const paras = [];
    for (let i = 0; i < 1200; i++) {
      const it = items[i % items.length];
      paras.push([`Late returns of a rental ${it} are charged $${10 + (i % 5) * 5} per day after the due time.`,
        `The deposit for a rental ${it} is $${50 + (i % 4) * 25}, refunded when the item is returned on time.`,
        `Each rental ${it} is inspected when it comes back, and damage beyond normal wear is charged at repair cost.`][i % 3]);
    }
    assert.equal((await c.upload(t, 'rental-policy.txt', Buffer.from(paras.join('\n\n')))).status, 201);
    await c.waitReady(t, 1, 30000);
    const qv = await (await c.json(t, '/questions')).json();
    assert.ok(qv.starters.length >= 1, JSON.stringify(qv));
    const final = (await c.stream(t, '/ask', { question: qv.starters[0].q })).find((e) => e.event === 'final').data;
    assert.equal(final.status, 'grounded', `${qv.starters[0].q}: ${final.text}`);
  });

  test('4.11: no studio route ever creates buckets, bots or commits the registry', () => {
    assert.deepEqual(spies, { createBucket: 0, create: 0, commit: 0 });
    const writes = S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path === 'knowbot/_config/instances.json').length;
    assert.equal(writes, registryWritesBefore, 'instances.json untouched');
    assert.ok(S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path?.startsWith('knowbot/trials/')).every((x) => x.store === 'vs_fake_trials'));
  });
});

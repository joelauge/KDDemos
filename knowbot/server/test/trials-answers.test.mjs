// KnowBot Studio server: insights and the answer-quality fixes (rounds r1, r2, r4, r5), recall.
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

describe('KnowBot Studio server (trials.mjs): insights and answers', () => {
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


  test('r8 insights: near-duplicates group ("asked 2 ways"); off-topic refusals are not gaps (refusalReasonOf)', async () => {
    const { t } = await sampleTrial();
    await c.stream(t, '/ask', { question: 'Do you ship to Brazil?' });
    await c.stream(t, '/ask', { question: 'Do you deliver to Brazil?' });
    await c.stream(t, '/ask', { question: 'What is the capital of France?' });
    const j = await (await c.json(t, '/insights')).json();
    const brazil = j.gaps.filter((g) => /brazil/i.test(g.q));
    assert.equal(brazil.length, 1, JSON.stringify(j.gaps));
    assert.equal(brazil[0].ways, 2);
    assert.equal(brazil[0].reason, 'near_miss');
    assert.ok(!j.gaps.some((g) => /france/i.test(g.q)), 'general knowledge is never a content gap');
    assert.ok(j.offTopic.some((g) => /france/i.test(g.q) && g.reason === 'off_topic'), JSON.stringify(j.offTopic));
    assert.equal(insightKey('Do you ship to Brazil?'), insightKey('Do you deliver to Brazil?'));
    assert.equal(refusalReasonOf({ q: 'Do you ship to Brazil?', best: 0.67, floor: 0.72 }), 'near_miss');
    assert.equal(refusalReasonOf({ q: 'Something odd', best: 0.4, floor: 0.72 }), 'off_topic');
    // the Builder praises an off-topic refusal and offers no "add a file"
    const ev = await c.stream(t, '/setup', { event: { type: 'refusal', data: { question: 'What is the capital of France?', best: 0.41, floor: 0.72 } } });
    const chips = ev.find((e) => e.event === 'chips').data.chips.map((x) => x.label);
    assert.ok(!chips.some((x) => /add a file/i.test(x)), chips.join(','));
  });

  // ---------------------------------------------------------------------------------------------- fixer r1
  test('r1: plain paraphrases of covered facts are answered; tangential lines are dropped from the answer', async () => {
    const { t } = await sampleTrial();
    for (const q of ['What does the service plan cost?', 'How much does the annual service plan cost?']) {
      const final = (await c.stream(t, '/ask', { question: q })).find((e) => e.event === 'final').data;
      assert.equal(final.status, 'grounded', `${q}: ${JSON.stringify(final.why)}`);
      assert.ok(final.proof.quotedLines.some((l) => /\$149/.test(l.text)), `${q} quotes the $149 Care Plan line: ${final.text}`);
    }
    const ecity = (await c.stream(t, '/ask', { question: 'How much does the Lumen E-City cost?' })).find((e) => e.event === 'final').data;
    assert.equal(ecity.status, 'grounded');
    assert.ok(ecity.proof.quotedLines.some((l) => /\$3,199/.test(l.text)));
    assert.ok(!ecity.proof.quotedLines.some((l) => /recharges|wall socket|motor assists/i.test(l.text)), `no battery paragraph rides along: ${ecity.text}`);
  });

  test('r1: keepRelevantLines keeps lines within the margin of the best and never empties the answer (pure)', () => {
    const lines = { 1: 'The Lumen E-City costs $3,199.', 2: 'Its 500 Wh battery gives about 90 km range in the eco mode, and it recharges fully in about 4 hours.', 3: 'The Lumen E-City costs $3,199 including assembly.' };
    const sim = { 1: 0.9, 2: 0.78, 3: 0.88 };
    assert.deepEqual(keepRelevantLines('How much does the Lumen E-City cost?', [1, 2, 3], (n) => lines[n], (n) => sim[n]), [1, 3]);
    assert.deepEqual(keepRelevantLines('anything', [2], (n) => lines[n], (n) => sim[n]), [2]);
    assert.ok(LINE_MARGIN > 0 && LINE_MARGIN <= 0.1);
    const both = keepRelevantLines('What does the Lumen Care Plan include?', [1, 2],
      (n) => ['', 'Lumen Care Plan costs $149 per year and includes two tune-ups and 10% off parts.', 'The Care Plan also includes priority booking.'][n], () => 0.9);
    assert.deepEqual(both, [1, 2], 'two lines that both answer stay');
  });

  test('r1: a near-floor refusal carries closeMiss and the Builder says "Close miss" with [Add a file] [Rephrase it for me]', async () => {
    const { t } = await sampleTrial();
    const final = (await c.stream(t, '/ask', { question: 'Do you ship to Brazil?' })).find((e) => e.event === 'final').data;
    assert.equal(final.refused, true);
    assert.ok(final.closeMiss && final.closeMiss.best >= final.closeMiss.floor - 0.06 && final.closeMiss.best < final.closeMiss.floor, JSON.stringify(final.why));
    const probe = (await c.stream(t, '/ask', { question: "What's the weather in Paris today?" })).find((e) => e.event === 'final').data;
    assert.equal(probe.closeMiss, null, 'probes are never close misses');
    for (const [i, type] of ['close_miss', 'refusal'].entries()) {
      const ev = await c.stream(t, '/setup', { event: { type, data: { question: 'Do you ship to Brazil?', best: final.closeMiss.best, floor: final.closeMiss.floor } } });
      const reply = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
      const chips = ev.find((e) => e.event === 'chips').data.chips.map((x) => x.label);
      assert.ok(chips.includes('Add a file') && chips.includes('Rephrase it for me'), chips.join(','));
      // r2: the same gap advice is not repeated within a 2-turn window
      if (i === 0) assert.match(reply, /^Close miss: best match \d+/, `${type}: ${reply}`);
      else { assert.doesNotMatch(reply, /Add a file about/, `${type}: ${reply}`); assert.match(reply, /same gap/i); }
    }
  });

  test('r1: Proof Run asks never reach question insights', async () => {
    const t = await c.trial();
    await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' });
    await c.waitReady(t, 4);
    await c.stream(t, '/ask', { question: 'How long are batteries covered?', label: 'Proof Run' });
    await c.stream(t, '/ask', { question: 'How much is a Full Overhaul?', by: 'proof' });
    await c.stream(t, '/ask', { question: 'How long is the frame warranty?' });
    const j = await (await c.json(t, '/insights')).json();
    const qs = j.top.map((x) => x.q);
    assert.ok(qs.includes('How long is the frame warranty?'), JSON.stringify(j));
    assert.ok(!qs.includes('How long are batteries covered?') && !qs.includes('How much is a Full Overhaul?'), `proof asks leaked: ${qs}`);
    assert.equal(j.total, 1);
  });

  test('r1: /questions has 3 validated starters as soon as the first sample file is ready', async () => {
    const t = await c.trial();
    await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' });
    let j = null;
    for (let i = 0; i < 400; i++) {
      const files = (await (await c.json(t, '/files')).json()).files;
      const ready = files.filter((f) => f.stage === 'ready');
      if (ready.length >= 1) {
        j = await (await c.json(t, '/questions')).json();
        if (ready.length === 1) break;
        if (ready.length > 1) break; // raced past the single-ready moment: still must have 3
      }
      await sleep(20);
    }
    assert.ok(j, 'a file became ready');
    assert.equal(j.starters.length, 3, JSON.stringify(j.starters));
    assert.equal(new Set(j.starters.map((x) => x.q)).size, 3);
    assert.ok(j.starters.every((x) => x.top >= 0.72));
  });

  test('recall: the thread\'s last two exchanges reach the select prompt, labelled; a history-only fact is never stated; the trace says how many ways', async () => {
    const { t } = await sampleTrial();
    const n0 = S.llm.calls.length;
    const ev = await c.stream(t, '/ask', { question: 'and how long are its batteries covered?', history: [
      { q: 'Do you sell e-bikes?', a: 'Yes. The Lumen E-City costs $3,199 [1].' }, { q: 'Is there a cheaper one?', a: 'The Lumen E-Fold costs $2,299 and the secret code is ZEBRA-42 [1].' }] });
    const final = ev.find((e) => e.event === 'final').data;
    const ret = ev.find((e) => e.event === 'retrieval').data;
    assert.ok(ret.searched.ways >= 2, `searched ${ret.searched.ways} ways`);
    const sel = S.llm.calls.slice(n0).filter((x) => x.kind === 'select');
    assert.ok(sel.length, 'the select step ran');
    assert.match(sel[0].user, /^Earlier in this conversation \(for understanding the question only; not a source\):\nVisitor: Do you sell e-bikes\?/);
    assert.match(sel[0].user, /Bot: The Lumen E-Fold costs \$2,299 and the secret code is ZEBRA-42\./, 'markers removed');
    assert.doesNotMatch(final.text, /ZEBRA-42|secret code/);
    assert.ok(!JSON.stringify(final).includes('ZEBRA-42'), 'nothing from the history in the answer, its citations or its proof');
    assert.equal(final.question, 'and how long are its batteries covered?');
    if (final.status === 'grounded') assert.ok(final.citations.every((x) => x.quotes.every((q) => !/ZEBRA/.test(q.text))));
  });

  // ---------------------------------------------------------------------------------------------- fixer r2
  test('r2: no padding: a generic intro line never rides along on an answer (Studio and /v1)', async () => {
    const { t } = await sampleTrial();
    const q = 'How long are batteries covered?';
    const final = (await c.stream(t, '/ask', { question: q })).find((e) => e.event === 'final').data;
    assert.equal(final.status, 'grounded');
    assert.ok(final.proof.quotedLines.some((l) => /800 full charge cycles/.test(l.text)), final.text);
    assert.ok(!/This page explains|We build bikes/.test(final.text), `Studio answer padded: ${final.text}`);
    const key = (await (await c.json(t, '/devkey')).json());
    const k = key.key || key.apiKey || key.token;
    assert.ok(k, JSON.stringify(key));
    const v1 = await (await S.api(`/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })).json();
    assert.match(v1.answer, /800 full charge cycles/);
    assert.ok(!/This page explains|We build bikes/.test(v1.answer), `/v1 answer padded: ${v1.answer}`);
    // the pure filter drops a generic intro even when it scores within the margin
    const lines = { 1: 'E-bike batteries are covered for 2 years or 800 full charge cycles.', 2: 'This page explains exactly what is covered, for how long, and how to claim.' };
    assert.deepEqual(keepRelevantLines(q, [1, 2], (n) => lines[n], () => 0.88), [1]);
    assert.deepEqual(keepRelevantLines(q, [1, 2], (n) => lines[n], () => 0.88, LINE_MARGIN, { isIntro: (n) => n === 1 }), [1], 'the best line always stays');
  });

  test('r2: off-topic questions get spread-out similarities, not a flat wall', async () => {
    const { t } = await sampleTrial();
    const ev = await c.stream(t, '/ask', { question: 'What is the capital of Mars?' });
    const hits = ev.find((e) => e.event === 'retrieval').data.hits.map((h) => h.similarity).filter((x) => x != null);
    assert.ok(hits.length >= 6);
    assert.ok(new Set(hits.map((x) => Math.round(x * 100))).size >= 3, `distinct scores: ${hits.join(',')}`);
    assert.ok(Math.max(...hits) < 0.64 && Math.min(...hits) >= 0.41, hits.join(','));
  });

  test('r2/r4: "call it Spokes, friendly, for my bike shop": the business is Spokes, a greeting is proposed, no no-op rows', async () => {
    // r5: "call it X" names the bot, never the business: the org comes from "for my <X>" only
    const p = parseIntent('call it Spokes, friendly, for my bike shop');
    assert.deepEqual([p.patch.name, p.patch.org, p.patch.tone, p.business], ['Spokes', 'Bike shop', 'friendly', 'bike shop']);
    const pp = parseIntent('call it Paddle Pal, friendly, a support bot for my kayak rental shop');
    assert.equal(pp.patch.name, 'Paddle Pal');
    assert.equal(pp.patch.org, 'Kayak rental shop', 'the bot name is never copied into org');
    assert.equal(pp.patch.tone, 'friendly');
    assert.match(pp.patch.purpose, /^Support bot for my kayak rental shop$/);
    assert.doesNotMatch(pp.patch.purpose, /^[\s,;:-]/, 'no leading punctuation left from the name clause');
    assert.doesNotMatch(pp.patch.purpose, /Paddle Pal/);
    assert.equal(parseIntent('a bot for my customers').patch.org, undefined, 'an audience is not an org');
    assert.equal(parseIntent('a bot for my dental clinic').patch.org, 'Dental clinic', 'no name: the business type is the org');
    const q = parseIntent('support bot for my bike shop called Spokes, friendly');
    assert.equal(q.patch.org, 'Spokes', 'the "called X" clause never leaks into the org');
    const t = await c.trial();
    const ev = await c.stream(t, '/setup', { message: 'support bot for my bike shop called Spokes, friendly' });
    const patch = ev.find((e) => e.event === 'patch').data;
    assert.ok(patch.diff.some((d) => d.field === 'name' && d.to === 'Spokes'));
    assert.ok(patch.diff.some((d) => d.field === 'org' && d.to === 'Spokes'));
    assert.ok(patch.diff.some((d) => d.field === 'greeting' && d.to === 'Hi! Ask me anything about Spokes.'), JSON.stringify(patch.diff));
    assert.ok(patch.diff.every((d) => JSON.stringify(d.from) !== JSON.stringify(d.to) && !d.unchanged), `no no-op rows: ${JSON.stringify(patch.diff)}`);
    const reply = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(reply, /^Done, meet \*\*Spokes\*\*: a friendly support bot for your bike shop\./);
    assert.doesNotMatch(reply, /Bike shop called/);
    const chips = ev.find((e) => e.event === 'chips').data.chips.map((x) => x.label);
    assert.ok(!chips.includes('Try to trip it up'), 'no Proof Run without files');
    assert.equal((await (await c.json(t, '')).json()).spec.org, 'Spokes');
  });

  test('r5: multi-field free text, greeting from the org, upload copy after naming', async () => {
    const t = await c.trial();
    const ev = await c.stream(t, '/setup', { message: 'call it Paddle Pal, friendly, a support bot for my kayak rental shop' });
    const patch = ev.find((e) => e.event === 'patch').data;
    const to = (f) => patch.diff.find((d) => d.field === f)?.to;
    assert.equal(to('name'), 'Paddle Pal');
    assert.equal(to('org'), 'Kayak rental shop');
    assert.equal(to('purpose'), 'Support bot for my kayak rental shop');
    assert.equal(to('greeting'), 'Hi! Ask me anything about the kayak rental shop.');
    const reply = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(reply, /^Done, meet \*\*Paddle Pal\*\*: a friendly support bot for your kayak rental shop\./, reply);
    const q = await c.stream(t, '/setup', { event: { type: 'files_queued', data: { n: 1, bytes: 2048 } } });
    const qr = q.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.doesNotMatch(qr, /suggest a name/, 'the bot is already named');
    assert.match(qr, /draft starter questions for Paddle Pal/);
    const t2 = await c.trial();
    const q2 = await c.stream(t2, '/setup', { event: { type: 'files_queued', data: { n: 1, bytes: 2048 } } });
    assert.match(q2.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /suggest a name that fits/);
  });

  test('r5: failure copy by file type (scanned image only for PDF and images)', async () => {
    const { mapError } = await import('../trials.mjs');
    assert.equal(mapError('no text extracted', { ext: 'md', name: 'broken.md' }).message, 'This file has no readable text (it may be empty or corrupted).');
    assert.equal(mapError('no text extracted', { mime: 'text/plain' }).message, 'This file has no readable text (it may be empty or corrupted).');
    assert.equal(mapError('no text extracted', { ext: 'pdf' }).message, 'No readable text found. It looks like a scanned image.');
    assert.equal(mapError('OCR found nothing', { mime: 'image/png' }).message, 'No readable text found. It looks like a scanned image.');
    assert.equal(mapError('no text extracted').code, 'no_text');
  });

  test('r4: scope asks, custom tone and multi-intent turns are acted on or acknowledged', async () => {
    const sc = parseIntent('only answer about warranties and returns');
    assert.ok(sc.intents.includes('set_scope'));
    assert.equal(sc.scope, 'warranties and returns');
    assert.equal(parseIntent('stick to pricing').scope, 'pricing');
    assert.equal(parseIntent('use all my files').scope, '*');
    assert.equal(parseIntent('just upload').scope, null);
    const pir = parseIntent('use the samples and make it sound like a pirate');
    assert.ok(pir.intents.includes('attach_samples'));
    assert.deepEqual(pir.customTone, { raw: 'pirate', to: 'friendly' });
    // zero files: the scope ask is explained, chips are files first
    const t0 = await c.trial();
    const none = await c.stream(t0, '/setup', { message: 'only answer about warranties and returns' });
    assert.match(none.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /Add files first/);
    assert.deepEqual(none.find((e) => e.event === 'chips').data.chips.map((x) => x.label), ['Upload files', 'Use sample files', 'Add website', 'Open bot spec']);
    // a scope over the sample files keeps only the warranty file on, with a ConfigDiff card
    const t = await c.trial();
    assert.equal((await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' })).status, 201);
    const files = await c.waitReady(t, 4);
    const ev = await c.stream(t, '/setup', { message: 'only answer about warranties and returns' });
    const reply = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(reply, /now answers only from lumen-warranty-returns\.md/, reply);
    const card = ev.find((e) => e.event === 'card')?.data;
    assert.equal(card?.type, 'config-diff');
    assert.deepEqual(card.data.rows[0], { field: 'Searching', from: '4 files', to: '1 file' });
    const spec = (await (await c.json(t, '')).json()).spec;
    const warranty = files.find((f) => /warranty/.test(f.name));
    assert.equal(Object.keys(spec.sources).length, 3);
    assert.ok(!(warranty.id in spec.sources), 'the warranty file stays on');
    const back = await c.stream(t, '/setup', { message: 'use all my files' });
    assert.match(back.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /searches all 4 files again/);
    assert.deepEqual((await (await c.json(t, '')).json()).spec.sources, {});
    // multi-intent: the custom tone is saved and acknowledged alongside the other change
    const mt = await c.stream(t, '/setup', { message: 'make answers shorter and make it sound like a pirate' });
    const mr = mt.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(mr, /Custom tone noted: "pirate"/, mr);
    assert.match(mr, /answers are (?:already )?short/, mr);
    // an unsupported ask inside a multi-intent message is named, never dropped
    const lg = await c.stream(t, '/setup', { message: 'make it more formal and add our logo' });
    const lr = lg.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(lr, /tone is formal/);
    assert.match(lr, /"add our logo"/, lr);
  });

  test('r4: topics come from section headings; the summary line lists sections, not the first sentence', () => {
    const md = ['# Lumen Bikes Price List 2026', 'Prices valid from 1 January 2026 until further notice. All prices are in US dollars.', '## 2026 bike range', '| a | b |\n|---|---|\n| 1 | 2 |',
      '## More models', 'Text.', '## Lumen Commuter 3', 'A city bike.', '## Lumen Trail 5', 'A trail bike.', '## Lumen E-City', 'An e-bike.', '## Accessories', 'Locks and lights.', 'Racks.',
      '## Payment and finance', 'Pay over 12 months.', '## Common price questions', 'Ask us.'].join('\n\n');
    const atoms = [];
    let crumbs = [];
    for (const b of md.split('\n\n')) { const h = /^(#+)\s+(.+)$/.exec(b); if (h) { crumbs = crumbs.slice(0, h[1].length - 1); crumbs[h[1].length - 1] = h[2]; continue; } atoms.push({ text: b, meta: { breadcrumb: crumbs.join(' > ') } }); }
    const topics = topicsOf(atoms);
    assert.deepEqual(topics, ['accessories', 'payment and finance', 'Lumen models']);
    const line = sectionLine(atoms, 'Price list');
    assert.equal(line, 'Lumen Bikes Price List 2026: Lumen models, accessories and payment and finance.');
  });

  test('r4: an own-file naming proposal survives file_ready; generic titles never become an org; spec edits with no files offer files', async () => {
    const t = await c.trial();
    const doc = '# Northwind Studio Employee Handbook\n\nThis handbook applies to everyone at Northwind Studio.\n\n## Paid time off\n\nFull-time employees receive 25 days of paid vacation per year.\n\n## Equipment\n\nLaptops are replaced every 3 years.\n';
    await c.upload(t, 'handbook.md', Buffer.from(doc));
    await c.waitReady(t, 1);
    for (let i = 0; i < 40 && !(await (await c.json(t, '')).json()).files?.[0]?.summary; i++) await sleep(100);
    const at = await c.stream(t, '/setup', { event: { type: 'file_atomized', data: {} } });
    const ar = at.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(ar, /Looks like the Northwind Studio employee handbook\. Call it \*\*Northwind Studio Guide\*\*\?/, ar);
    const rd = await c.stream(t, '/setup', { event: { type: 'file_ready', data: {} } });
    const chips = rd.find((e) => e.event === 'chips').data.chips;
    assert.equal(chips[0].label, 'Call it Northwind Studio Guide', JSON.stringify(chips));
    assert.equal(chips.filter((x) => x.kind === 'primary').length, 1);
    const yes = await c.stream(t, '/setup', { message: chips[0].send });
    assert.equal(yes.find((e) => e.event === 'patch').data.spec.name, 'Northwind Studio Guide');
    const after = await c.stream(t, '/setup', { event: { type: 'file_ready', data: {} } });
    assert.ok(!after.find((e) => e.event === 'chips').data.chips.some((x) => /^Call it/.test(x.label)), 'answered: the chip is gone');
    // a generic title ("Shop Notes") gives no "Shop's notes docs" proposal
    const t2 = await c.trial();
    await c.upload(t2, 'notes.md', Buffer.from('# Shop Notes\n\n## Opening\n\nWe open at 8am every weekday morning.\n\n## Parking\n\nParking is free for the first two hours.\n'));
    await c.waitReady(t2, 1);
    const g = (await c.stream(t2, '/setup', { event: { type: 'file_atomized', data: {} } })).filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.doesNotMatch(g, /Shop's|notes docs/, g);
    // no files: a spec edit never offers the Proof Run
    const t3 = await c.trial();
    const se = await c.stream(t3, '/setup', { event: { type: 'spec_edit', data: {} } });
    assert.deepEqual(se.find((e) => e.event === 'chips').data.chips.map((x) => x.label), ['Upload files', 'Use sample files', 'Add website', 'Open bot spec']);
  });

  test('r4: fake knowDrive spreads weak candidates and runs two files at once', async () => {
    const { startFakeKnowDrive: start } = await import('./fake-knowdrive.mjs');
    const dir = path.join(ROOT, 'studio', 'samples', 'lumen-bikes');
    const names = (await fsp.readdir(dir)).filter((n) => !n.endsWith('.json'));
    const kd = await start({ speed: 20, fixtures: await Promise.all(names.map(async (n) => ({ path: n, text: await fsp.readFile(path.join(dir, n), 'utf8'), tags: ['trial:x'] }))) });
    try {
      const r = await (await fetch(`${kd.url}/api/v1/vector_stores/vs_fake/search`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: JSON.stringify({ query: "What's the capital of Australia?", max_num_results: 9, mode: 'vector', filter: { all_of: ['trial:x'] } }) })).json();
      const sims = r.data.map((d) => d.score).filter((x) => x < 0.9);
      assert.ok(Math.max(...sims) - Math.min(...sims) >= 0.012 && new Set(sims.map((x) => Math.round(x * 100))).size >= 3, `spread: ${sims.join(',')}`);
      assert.ok(Math.min(...sims) >= 0.41, 'floors are kept');
      assert.ok(Math.max(...sims) < 0.64);
      // four files uploaded together: two are past "pending" at once
      for (const n of names) {
        const fd = new FormData();
        fd.append('file', new Blob([await fsp.readFile(path.join(dir, n))]), `p-${n}`);
        await fetch(`${kd.url}/api/v1/ingest`, { method: 'POST', headers: { 'x-vector-store-id': 'vs_fake', authorization: 'Bearer x' }, body: fd });
      }
      let maxBusy = 0;
      for (let i = 0; i < 60; i++) {
        const busy = [...kd.files.values()].filter((f) => f.filename.startsWith('p-') && !['pending', 'completed'].includes(f.phase)).length;
        maxBusy = Math.max(maxBusy, busy);
        await sleep(10);
      }
      assert.ok(maxBusy >= 2, `concurrent files: ${maxBusy}`);
    } finally { await kd.close(); }
  });

  test('r4: a fresh trial reuses the live trial when the browser presents its restore key', async () => {
    const ip = nextIp();
    const a = await (await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } })).json();
    const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' }, body: JSON.stringify({ trialId: a.trialId, restoreKey: a.restoreKey }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.trialId, a.trialId);
    assert.equal(j.reused, true);
    const bad = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' }, body: JSON.stringify({ trialId: a.trialId, restoreKey: 'x'.repeat(20) + '.' + 'y'.repeat(20) }) });
    assert.equal(bad.status, 201, 'a bad key just creates a new trial');
    assert.notEqual((await bad.json()).trialId, a.trialId);
  });

  test('r2: topic casing and fact-based starters (no "How does section 1 work?")', async () => {
    assert.equal(topicCase('Lumen Commuter 3'), 'Lumen Commuter 3');
    assert.equal(topicCase('Frame warranty'), 'frame warranty');
    assert.ok(GENERIC_HEADING_RE.test('Section 1') && GENERIC_HEADING_RE.test('Part II') && !GENERIC_HEADING_RE.test('Parental leave'));
    const t = await c.trial();
    const doc = '# Acme Staff Policy\n\n## Section 1\n\nParental leave is paid for 16 weeks at full salary.\n\n## Section 2\n\nExpense claims are reimbursed within 10 business days of approval.\n\n## Section 3\n\nThe annual learning budget costs the company $1,200 per employee.\n';
    const up = await (await c.upload(t, 'policy.md', Buffer.from(doc))).json();
    await c.waitReady(t, 1);
    const q = await (await c.json(t, '/questions')).json();
    const all = [...q.starters, ...q.proof].map((x) => x.q);
    assert.ok(all.length >= 2, JSON.stringify(q));
    assert.ok(!all.some((x) => /section \d/i.test(x)), all.join(' | '));
    assert.ok(all.some((x) => /parental leave|expense claims|learning budget/i.test(x)), all.join(' | '));
    assert.ok([...q.starters, ...q.proof].every((x) => x.top >= 0.72 && x.fileId === up.file.id));
    assert.equal(q.complete, true);
    assert.deepEqual(q.pending, { files: 0, names: [] });
  });

  test('4.11: no studio route ever creates buckets, bots or commits the registry', () => {
    assert.deepEqual(spies, { createBucket: 0, create: 0, commit: 0 });
    const writes = S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path === 'knowbot/_config/instances.json').length;
    assert.equal(writes, registryWritesBefore, 'instances.json untouched');
    assert.ok(S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path?.startsWith('knowbot/trials/')).every((x) => x.store === 'vs_fake_trials'));
  });
});

// The live voice bots' shared brain (server/channels/voice-brain.mjs) and what it changes in the web voice session
// (server/channels/webvoice.mjs): the search tool's answer (short answer, more, exact facts, options, related items, on
// screen), the facts guard, speculative search, instant answers, read-back, message-taking, settings and hours, the
// prompt rules, and the latency before/after against a fake Gemini Live, fake knowDrive and fake LLM on 127.0.0.1.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { flushQuestions, _resetQuestions } from '../questions.mjs';
import { NOT_IN_DATA } from '../channels/util.mjs';
import { acceptWebSocket } from '../channels/ws.mjs';
import {
  VOICES, DEFAULT_VOICE, voiceSetupOf, cleanVoiceSetup, withinHours, toolAnswer, extractFacts, unsupportedFigures, figuresIn, wordsToDigits, spokenStyle,
  relatedFrom, createSpeculator, createInstantAnswers, bumpFilesEpoch, filesEpoch, readBackPhone, readBackEmail, createReadBack, conversationRules,
  asyncToolsSupported, silenceMs, toE164Strict,
} from '../channels/voice-brain.mjs';
import { createToolRunner, systemInstruction, toolDeclarations, respondToTools } from '../channels/voice-live.mjs';
import { webSystemInstruction, webToolDeclarations } from '../channels/webvoice.mjs';
import { createBargeIn, rmsOf, BARGE_RESUME_MS } from '../../lib/voice-mode.js';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(10); } throw new Error(`timed out waiting for ${what}`); };
const PUBLIC = 'https://kb.example.test';
// the server logs with console.log: captured here (tests assert on what was logged), not printed
const LOGS = [];
const print = (s) => process.stdout.write(`${s}\n`);
console.log = (...a) => { LOGS.push(a.map(String).join(' ')); if (LOGS.length > 20000) LOGS.splice(0, 10000); };
const DOC = `# Returns Policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const OFF = 'What is the capital of Australia?';
const pcm = (n, rate, f = 440) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * f * i) / rate)), i * 2); return b; };

// a grounded answer as the pipeline returns it
const GROUNDED = {
  refused: false, answer: 'The Lumen Care Plan costs $129.00 per year [1]. It covers accidental damage for 2 years [1]. See https://lumen.example/care [1].',
  citations: [{ n: 1, file: 'care-plan.md', title: 'Lumen Care Plan', url: 'https://lumen.example/care' }],
  proof: { quoted: [{ n: 1, text: 'The Lumen Care Plan costs $129.00 per year.' }, { n: 1, text: 'It covers accidental damage for 2 years. Details at https://lumen.example/care' }], hits: [] },
};

describe('voice brain: the search tool answer (N2, N3, U1, U3, U5, U7, U8)', () => {
  test('grounded: a short spoken answer first, the rest as "more", exact facts, no URLs; citations stay out of the tool', () => {
    const r = toolAnswer(GROUNDED, { names: ['Lumen'] });
    assert.equal(r.status, 'ok');
    assert.equal(r.answer, 'The Lumen Care Plan costs $129 per year.', 'money said without ".00"');
    assert.match(r.more, /^It covers accidental damage for 2 years\./);
    assert.ok(!/https?:|www\./.test(JSON.stringify(r)), 'no URL reaches the model');
    assert.ok(r.facts.includes('$129 per year'), JSON.stringify(r.facts));
    assert.ok(r.facts.includes('2 years'), JSON.stringify(r.facts));
    assert.ok(r.facts.includes('Lumen Care Plan'), JSON.stringify(r.facts));
    assert.deepEqual(r.source_titles, ['Lumen Care Plan']);
    assert.equal(r.on_screen, undefined, 'the phone has no screen');
    assert.equal(r.can_send, undefined, 'nothing to offer when the bot cannot send');
  });
  test('on screen (web), can send (U1), and the wrap-up hint after several answers (U7)', () => {
    const web = toolAnswer({ ...GROUNDED, products: [{ title: 'Care Plan', url: 'https://lumen.example/care' }] }, { onScreen: true, send: { text: true, email: true } });
    assert.equal(web.on_screen, 'products');
    assert.equal(web.can_send, 'text or email');
    assert.equal(web.suggest_summary, undefined);
    assert.equal(toolAnswer(GROUNDED, { onScreen: true, send: { email: true } }).on_screen, 'sources');
    assert.equal(toolAnswer(GROUNDED, { send: { email: true }, questionsSoFar: 4 }).suggest_summary, true);
    assert.equal(toolAnswer(GROUNDED, { send: { email: true }, questionsSoFar: 4, sentSomething: true }).suggest_summary, undefined, 'never after something was sent');
  });
  test('options (U3/U4): several different products from the results, named as the results name them', () => {
    const a = { ...GROUNDED, products: [{ title: 'Lumen City 2', url: 'https://x/c2' }, { title: 'Lumen Trail X', url: 'https://x/tx' }, { title: 'lumen city 2', url: 'https://x/c2b' }] };
    assert.deepEqual(toolAnswer(a).options, ['Lumen City 2', 'Lumen Trail X']);
    assert.equal(toolAnswer({ ...GROUNDED, products: [{ title: 'Only One', url: 'https://x/1' }] }).options, undefined, 'one product: nothing to clarify');
  });
  test('refusal (U5): related items only from the search results (close enough), else message-taking, else other help', () => {
    const near = { refused: true, citations: [], proof: { floor: { min: 0.7, top: 0.6 }, hits: [{ file: 'warranty-policy.md', similarity: 0.62 }, { file: 'store-hours.md', similarity: 0.3 }, { file: 'warranty-policy.md', similarity: 0.6 }] } };
    const r = toolAnswer(near, { takeMessages: true });
    assert.equal(r.status, 'not_in_data');
    assert.equal(r.say, NOT_IN_DATA);
    assert.deepEqual(r.related, ['Warranty Policy'], 'only the close hit, named from its title, once');
    assert.equal(r.next, 'offer_related');
    const far = { refused: true, citations: [], proof: { floor: { min: 0.7 }, hits: [{ file: 'store-hours.md', similarity: 0.2 }] } };
    assert.deepEqual(toolAnswer(far, { takeMessages: true }), { status: 'not_in_data', say: NOT_IN_DATA, next: 'offer_message' });
    assert.deepEqual(toolAnswer(far, { takeMessages: false }), { status: 'not_in_data', say: NOT_IN_DATA, next: 'offer_other_help' });
    assert.deepEqual(relatedFrom({ refused: true, guard: 'off_topic', proof: { floor: { min: 0.7 }, hits: [{ file: 'a.md', similarity: 0.69 }] } }), [], 'a guarded refusal offers nothing');
  });
  test('spoken style: no URLs or markdown, symbols as words', () => {
    assert.equal(spokenStyle('Call **us** & see [the page](https://x.example/a) or www.x.example, e.g. today. Costs $40.00.'), 'Call us and see the page or for example today. Costs $40.');
  });
});

describe('voice brain: the facts guard (N2)', () => {
  test('figures: digits, money, spoken numbers', () => {
    assert.equal(wordsToDigits('thirty five dollars, two hundred and ten, call one two'), '35 dollars, 210, call 1 2');
    assert.deepEqual(figuresIn('$1,299.00 or 30% within thirty days'), ['1299', '30']);
  });
  test('extractFacts: prices, dates, times, numbers with units, phone numbers, quoted terms, names', () => {
    const f = extractFacts('The Lumen Care Plan costs $129 per year. Returns within 30 days, until March 3, 2026. Call 415-555-0100 at 9am. Ships in 3-5 business days. It covers “accidental damage”.');
    for (const x of ['$129 per year', '30 days', 'March 3, 2026', '415-555-0100', '9am', '3-5 business days', 'accidental damage', 'Lumen Care Plan']) assert.ok(f.includes(x), `${x} in ${JSON.stringify(f)}`);
  });
  test('a figure in no fact, answer or question is reported; spoken forms of a backed figure are not', () => {
    const allowed = ['You can return it within 30 days of delivery.', '30 days', 'How long do I have?'];
    assert.deepEqual(unsupportedFigures('You have thirty days.', allowed), []);
    assert.deepEqual(unsupportedFigures('You have 45 days, or one of the others.', allowed), ['45']);
    assert.deepEqual(unsupportedFigures('Texting four one five, five five five, zero one zero zero', ['plus one, four one five, five five five, zero one zero zero', '+14155550100']), []);
  });
});

describe('voice brain: speculative search (N4)', () => {
  test('starts on the partial transcript once it holds still, and is reused when the final query is the same or very close', async () => {
    const runs = [];
    const sp = createSpeculator({ idleMs: 30, run: async (q, { signal }) => { runs.push({ q, signal }); await sleep(80); return { question: q, refused: false }; } });
    sp.partial('How many');
    sp.partial('How many days do I');
    sp.partial('How many days do I have to return an unused item');
    await sleep(60);
    assert.equal(runs.length, 1, 'one search, after the words held still');
    const hit = sp.take(Q);
    assert.ok(hit, 'reused');
    assert.ok(hit.aheadMs >= 20, `started ${hit.aheadMs} ms ahead`);
    assert.equal((await hit.promise).question, 'How many days do I have to return an unused item');
    assert.equal(sp.stats.reused, 1);
  });
  test('discarded when the final query is a different question; capped per turn; a newer guess makes the older one stale', async () => {
    const runs = [];
    const sp = createSpeculator({ idleMs: 10, maxPerTurn: 2, run: async (q, { signal }) => { runs.push({ q, signal }); await sleep(200); return { question: q }; } });
    sp.partial('What are your opening hours on'); await sleep(25);
    sp.partial('What are your opening hours on Sunday in the city store'); await sleep(25);
    sp.partial('What are your opening hours on Sunday in the city store and the trail store'); await sleep(25);
    assert.equal(runs.length, 2, 'at most two searches per turn');
    assert.equal(runs[0].signal.aborted, true, 'the older, unfinished guess was cancelled');
    assert.equal(sp.take('How do I return a bike?'), null, 'a different question never reuses a guess');
    assert.equal(sp.stats.discarded >= 1, true);
    assert.equal(sp.pending, 0);
    // a yes/no question never reuses an open one
    const sp2 = createSpeculator({ idleMs: 5, run: async (q) => ({ question: q }) });
    sp2.partial('What is the warranty on the frame'); await sleep(20);
    assert.equal(sp2.take('Is the warranty on the frame transferable?'), null);
  });
});

describe('voice brain: instant answers (N5)', () => {
  test('built from the most-asked answered questions, grounded only; matched closely; stale once the files change', async () => {
    const calls = [];
    let clock = 1000;
    const ia = createInstantAnswers({ now: () => clock, ttlMs: 60000, minRebuildMs: 0,
      top: async () => ['How many days do I have to return an unused item?', 'What is the capital of Australia?', 'Do you ship abroad?'],
      answerFor: async (_k, q) => { calls.push(q); return /australia/i.test(q) ? { refused: true, citations: [] } : /abroad/i.test(q) ? { refused: false, citations: [] } : { refused: false, citations: [{ n: 1, file: 'returns.md' }], question: q }; } });
    assert.equal(ia.match('b1', Q), null, 'nothing before it is built');
    await ia.warm('b1');
    assert.equal(calls.length, 3);
    const hit = ia.match('b1', 'how many days do i have to return an unused item');
    assert.ok(hit && hit.sim === 1);
    assert.ok(ia.match('b1', 'How many days do I have to return an unused item please?'), 'filler words still match');
    assert.equal(ia.match('b1', 'What is the capital of Australia?'), null, 'never a refusal');
    assert.equal(ia.match('b1', 'Do you ship abroad?'), null, 'never an answer without citations');
    assert.equal(ia.match('b1', 'How many days do I have to return a used item?'), null, 'a different question');
    await ia.warm('b1');
    assert.equal(calls.length, 3, 'fresh: not rebuilt');
    const e0 = filesEpoch();
    bumpFilesEpoch();
    assert.equal(filesEpoch(), e0 + 1);
    assert.equal(ia.match('b1', Q), null, 'files changed: the cache is stale at once');
    await ia.warm('b1');
    assert.equal(calls.length, 6, 'rebuilt');
    assert.ok(ia.match('b1', Q));
    clock += 61000;
    assert.equal(ia.match('b1', Q), null, 'older than the TTL');
  });
  test('a change while building throws the build away', async () => {
    let builds = 0, clock = 0;
    const ia = createInstantAnswers({ now: () => clock, top: async () => [Q], answerFor: async () => { builds++; if (builds === 1) bumpFilesEpoch(); return { refused: false, citations: [{ n: 1 }] }; } });
    await ia.warm('b2');
    assert.equal(ia.match('b2', Q), null);
    await ia.warm('b2');
    assert.equal(builds, 1, 'rebuilds are throttled (one a minute per bot); nothing stale is served meanwhile');
    clock += 61e3;
    await ia.warm('b2');
    assert.equal(builds, 2);
    assert.ok(ia.match('b2', Q));
  });
});

describe('voice brain: read-back before sending (U2)', () => {
  test('phone numbers grouped digit by digit; email spelled, common domains said as words', () => {
    assert.equal(readBackPhone('+14155550100'), 'plus one, four one five, five five five, zero one zero zero');
    assert.equal(readBackPhone('415 555 0100'), 'four one five, five five five, zero one zero zero');
    assert.equal(readBackEmail('Ann.Lee42@gmail.com'), 'a n n, dot, l e e, four two, at gmail dot com');
    assert.equal(readBackEmail('bo_x@acme-co.io'), 'b o, underscore, x, at a c m e, dash, c o, dot, i o');
  });
  test('the gate: the first call reads back, the confirmed one passes; a new address is read back again (a "no")', () => {
    const rb = createReadBack();
    assert.equal(rb.check('jo@example.com', { confirmed: true }), 'j o, at e x a m p l e, dot, c o m', 'confirmed without a read-back is not enough');
    assert.equal(rb.check('jo@example.com', { confirmed: true }), null);
    assert.ok(rb.check('jo2@example.com', { confirmed: true }), 'they said no and gave another address: read back again');
    assert.equal(rb.check('', { lastFour: '0199' }), 'the number ending in zero one nine nine');
  });
});

describe('voice brain: message-taking and the summary offer through the tool runner (U5, U7)', () => {
  test('take_message: read back, then a lead with the unanswered question; off when the owner turned it off', async () => {
    const leads = [];
    const run = createToolRunner({ ask: async () => ({ refused: true, citations: [], proof: { hits: [] } }), callSid: 'wv1', takeMessage: async (m) => { leads.push(m); return { ok: true }; } });
    const r = await run({ name: 'search_knowledge_base', args: { query: 'Do you sell gift cards?' } });
    assert.equal(r.next, 'offer_message');
    assert.equal((await run({ name: 'take_message', args: { name: 'Ann', question: 'Gift cards?' } })).status, 'need_contact');
    const c = await run({ name: 'take_message', args: { name: 'Ann', contact: 'ann@example.com', question: 'Do you sell gift cards?' } });
    assert.equal(c.status, 'confirm_first');
    assert.equal(leads.length, 0);
    const ok = await run({ name: 'take_message', args: { name: 'Ann', contact: 'ann@example.com', question: 'Do you sell gift cards?', confirmed: true } });
    assert.equal(ok.status, 'ok');
    assert.match(ok.note, /never promise/);
    assert.deepEqual(leads, [{ kind: 'message', name: 'Ann', contact: 'ann@example.com', question: 'Do you sell gift cards?', preferredTime: '' }]);
    assert.equal((await run({ name: 'take_message', args: { kind: 'callback', contact: 'ann@example.com', question: 'x', confirmed: true } })).status, 'need_phone_number', 'a callback needs a phone');
    const off = createToolRunner({ ask: async () => ({ refused: true, citations: [], proof: { hits: [] } }) });
    assert.equal((await off({ name: 'search_knowledge_base', args: { query: 'x' } })).next, 'offer_other_help');
    assert.equal((await off({ name: 'take_message', args: { contact: 'a@b.co', question: 'x' } })).status, 'error');
  });
  test('the fourth grounded answer suggests the summary offer when the bot can send', async () => {
    const run = createToolRunner({ ask: async () => GROUNDED, sendInfo: async () => ({ status: 'sent' }), sendMedia: { email: true, text: false } });
    const out = [];
    for (let i = 0; i < 4; i++) out.push(await run({ name: 'search_knowledge_base', args: { query: `q${i}` } }));
    assert.deepEqual(out.map((x) => !!x.suggest_summary), [false, false, false, true]);
    assert.equal(out[0].can_send, 'email');
  });
});

describe('voice brain: settings, hours, voices (N8, U6, U9)', () => {
  test('defaults: Kore, the caller\'s language, message-taking on, no transfer', () => {
    assert.deepEqual(voiceSetupOf(undefined), { voice: 'Kore', language: 'auto', takeMessages: true, transfer: null });
    assert.equal(DEFAULT_VOICE, 'Kore');
    assert.equal(VOICES.length, 30);
    assert.equal(voiceSetupOf({ voice: 'nope' }, { defaultVoice: 'Puck' }).voice, 'Puck', 'GEMINI_VOICE stays the server default');
  });
  test('validation: voice names, languages, E.164 transfer numbers, time zones, days and hours', () => {
    assert.deepEqual(cleanVoiceSetup({ voice: 'sulafat', language: 'es', takeMessages: false }), { voice: 'Sulafat', language: 'es', takeMessages: false });
    assert.throws(() => cleanVoiceSetup({ voice: 'Robot' }), /voice must be one of/);
    assert.throws(() => cleanVoiceSetup({ language: 'xx' }), /language must be/);
    assert.throws(() => cleanVoiceSetup({ takeMessages: 'yes' }), /true or false/);
    assert.throws(() => cleanVoiceSetup({ transfer: { number: '555-0100' } }), /country code/);
    assert.throws(() => cleanVoiceSetup({ transfer: { number: '+14155550100', timezone: 'Mars/Base' } }), /time zone/);
    assert.throws(() => cleanVoiceSetup({ transfer: { number: '+14155550100', days: ['funday'] } }), /days/);
    assert.throws(() => cleanVoiceSetup({ transfer: { number: '+14155550100', start: '9am' } }), /24-hour/);
    assert.throws(() => cleanVoiceSetup({ bogus: 1 }), /unknown setting/);
    assert.deepEqual(cleanVoiceSetup({ transfer: { number: '(415) 555-0100', timezone: 'America/New_York' } }).transfer,
      { number: '+14155550100', timezone: 'America/New_York', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' });
    assert.equal(cleanVoiceSetup({ transfer: null }, { transfer: { number: '+14155550100' } }).transfer, null, 'removed');
    assert.equal(toE164Strict('+44 20 7946 0958'), '+442079460958');
    assert.equal(toE164Strict('12'), null);
  });
  test('business hours in their own time zone; overnight spans; no days means closed', () => {
    const t = { number: '+14155550100', timezone: 'America/New_York', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' };
    assert.equal(withinHours(t, Date.parse('2026-11-12T15:00:00Z')), true, 'Thursday 10:00 in New York');
    assert.equal(withinHours(t, Date.parse('2026-11-12T23:30:00Z')), false, 'Thursday 18:30 in New York');
    assert.equal(withinHours(t, Date.parse('2026-11-14T15:00:00Z')), false, 'Saturday');
    const night = { ...t, timezone: 'UTC', days: ['fri'], start: '22:00', end: '06:00' };
    assert.equal(withinHours(night, Date.parse('2026-11-13T23:00:00Z')), true, 'Friday night');
    assert.equal(withinHours(night, Date.parse('2026-11-14T05:00:00Z')), true, 'early Saturday belongs to Friday');
    assert.equal(withinHours(night, Date.parse('2026-11-14T07:00:00Z')), false);
    assert.equal(withinHours({ ...t, days: [] }, Date.parse('2026-11-12T15:00:00Z')), false);
    assert.equal(withinHours(null), false);
  });
});

describe('voice brain: prompts and model support (N1, N3, U3, U4, U5, U6, U8, U9)', () => {
  test('acknowledge before (or while) searching, varied; NON_BLOCKING only where the model supports it', () => {
    const sync = conversationRules({ who: 'caller' });
    assert.match(sync, /Say one short acknowledgement \(a few words\), then call search_knowledge_base/);
    assert.match(sync, /Never use the same words twice in a row/);
    const asyncR = conversationRules({ who: 'caller', asyncSearch: true });
    assert.match(asyncR, /Call search_knowledge_base right away and, while it runs, say one short acknowledgement/);
    assert.match(asyncR, /Never start answering before the result arrives/);
    assert.equal(asyncToolsSupported('gemini-3.8-live'), true);
    assert.equal(asyncToolsSupported('models/gemini-3.8-live-extended-thinking'), true);
    assert.equal(asyncToolsSupported('gemini-2.5-flash-native-audio-preview-12-2025'), true);
    assert.equal(asyncToolsSupported('gemini-3.1-flash-live-preview'), false, 'synchronous only');
    assert.equal(asyncToolsSupported('gemini-3.8-live', { KNOWBOT_VOICE_ASYNC_TOOLS: '0' }), false);
    assert.equal(toolDeclarations({ org: 'A', asyncSearch: true })[0].functionDeclarations[0].behavior, 'NON_BLOCKING');
    assert.equal(toolDeclarations({ org: 'A' })[0].functionDeclarations[0].behavior, undefined);
    assert.equal(silenceMs({}), 600);
    assert.equal(silenceMs({ KNOWBOT_VOICE_SILENCE_MS: '800' }), 800);
  });
  test('facts not a script, short then more, clarify and recommend only from results, related or a message, on screen', () => {
    const p = webSystemInstruction({ botName: 'Front Desk', org: 'Acme', takeMessages: true, sendInfo: { email: true, text: true } });
    assert.match(p, /Say it in your own natural words/);
    assert.match(p, /"facts" are exact/);
    assert.match(p, /Never change, round or add a fact, number, date, price or name/);
    assert.match(p, /Want the details\?/);
    assert.match(p, /ask ONE short question naming the real options exactly as the result names them\. Never invent an option/);
    assert.match(p, /ask at most one or two short questions .* then recommend only from products and facts in the results/);
    assert.match(p, /I've put it on your screen/);
    assert.match(p, /if it lists "related", offer those by name, exactly as named/);
    assert.match(p, /offer to take a message .* Never promise when or whether the team will answer, and never say the information exists/);
    assert.match(p, /Want me to text you the link\?/);
    assert.match(p, /offer to send a summary of what you covered/);
    assert.match(p, /say its "read_back" exactly and get a yes/);
    assert.match(p, /offer a callback/, 'the web offers a callback, never a transfer');
    assert.doesNotMatch(p, /transfer_call/);
    assert.match(p, /Speak for the business: "we", "our", "us"/);
    assert.ok(p.includes(`say exactly: "${NOT_IN_DATA}"`));
    assert.doesNotMatch(p, /Gemini|Twilio/);
    assert.deepEqual(webToolDeclarations({ org: 'Acme', takeMessages: true })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'take_message']);
    const off = webSystemInstruction({ botName: 'Front Desk', org: 'Acme', takeMessages: false });
    assert.doesNotMatch(off, /take_message/);
    assert.match(off, /otherwise offer to help with something else/);
  });
  test('the phone: a transfer only with a yes (in hours); otherwise a callback request', () => {
    const now = systemInstruction({ botName: 'Front Desk', org: 'Acme', takeMessages: true, transfer: 'now' });
    assert.match(now, /Only after they say yes, tell them you're connecting them and call transfer_call\. Never transfer without a clear yes/);
    assert.deepEqual(toolDeclarations({ org: 'Acme', takeMessages: true, transfer: 'now' })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'transfer_call', 'take_message', 'end_call']);
    const cb = systemInstruction({ botName: 'Front Desk', org: 'Acme', takeMessages: true, transfer: 'callback' });
    assert.match(cb, /our team isn't available to take calls right now and offer a callback/);
    assert.doesNotMatch(cb, /transfer_call/);
  });
  test('language (U9): auto follows the visitor; a fixed language speaks it; the refusal and greeting are faithful translations', () => {
    const auto = systemInstruction({ botName: 'Front Desk', org: 'Acme' });
    assert.match(auto, /Reply in the language the caller speaks; if they switch, switch with them\. Greet in English/);
    assert.match(auto, /say the greeting and the refusal line as faithful translations/);
    assert.match(auto, /Never add anything in translation/);
    assert.match(auto, /Write search_knowledge_base queries in the language of our files/);
    const es = webSystemInstruction({ botName: 'Front Desk', org: 'Acme', language: 'es' });
    assert.match(es, /Speak Spanish\. Greet in Spanish with a faithful translation of the greeting, and say the refusal line as a faithful Spanish translation/);
    assert.ok(es.includes(NOT_IN_DATA), 'the canonical English refusal stays the source of the translation');
  });
  test('tool responses: a NON_BLOCKING search answers on its own, scheduled WHEN_IDLE; blocking tools answer together', async () => {
    const sent = [];
    let release;
    const slow = new Promise((r) => { release = r; });
    await respondToTools([{ id: 's', name: 'search_knowledge_base' }, { id: 'e', name: 'end_call' }], async (c) => (c.name === 'search_knowledge_base' ? slow : { status: 'ok' }), { asyncSearch: true, send: (r) => sent.push(r) });
    assert.deepEqual(sent, [[{ id: 'e', name: 'end_call', response: { status: 'ok' } }]], 'end_call is not held up by the search');
    release({ status: 'ok', answer: 'x' });
    await until(() => sent.length === 2);
    assert.deepEqual(sent[1], [{ id: 's', name: 'search_knowledge_base', response: { status: 'ok', answer: 'x', scheduling: 'WHEN_IDLE' } }]);
    const sent2 = [];
    await respondToTools([{ id: 's', name: 'search_knowledge_base' }, { id: 'e', name: 'end_call' }], async () => ({ status: 'ok' }), { asyncSearch: false, send: (r) => sent2.push(r) });
    assert.equal(sent2.length, 1);
    assert.equal(sent2[0].length, 2);
    assert.equal(sent2[0][0].response.scheduling, undefined);
    // a NON_BLOCKING search the model cancelled (the caller interrupted it) gets no response
    const sent3 = [];
    await respondToTools([{ id: 'c1', name: 'search_knowledge_base' }], async () => ({ status: 'ok' }), { asyncSearch: true, cancelled: new Set(['c1']), send: (r) => sent3.push(r) });
    await sleep(20);
    assert.deepEqual(sent3, []);
  });
});

describe('voice brain: barge-in in the browser (N7)', () => {
  test('local voice over the bot trips after two loud frames; quiet residue and speech between answers do not', () => {
    const b = createBargeIn();
    for (let i = 0; i < 20; i++) b.feed(0.003, false); // a quiet room while listening
    assert.equal(b.feed(0.01, true), false, 'echo residue while the bot speaks');
    assert.equal(b.feed(0.2, true), false, 'one frame is not enough');
    assert.equal(b.feed(0.2, true), true, 'two loud frames: barge in');
    const c = createBargeIn();
    for (let i = 0; i < 50; i++) c.feed(0.3, false); // the visitor talking between answers never raises the floor
    assert.ok(c.floor < 0.01, String(c.floor));
    assert.equal(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
    assert.ok(BARGE_RESUME_MS >= 500 && BARGE_RESUME_MS <= 1500);
  });
});

// ------------------------------------------------------------------ through the server: speculative search, instant answers, messages, latency
async function startFakeGemini(script) {
  const sessions = [];
  const srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('key') !== 'gkey') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const ws = acceptWebSocket(req, socket, head, { maxMessage: 4 * 1024 * 1024 });
    const s = { setup: null, received: [], waiters: [], closed: false, ws };
    sessions.push(s);
    const kindOf = (m) => (m.setup ? 'setup' : m.toolResponse ? 'toolResponse' : m.realtimeInput?.text ? 'text' : m.realtimeInput?.audio ? 'audio' : 'other');
    const next = (kind) => new Promise((resolve) => {
      const i = s.received.findIndex((m) => !m.taken && kindOf(m) === kind);
      if (i >= 0) { s.received[i].taken = true; return resolve(s.received[i]); }
      s.waiters.push({ kind, resolve });
    });
    const send = (o) => ws.send(JSON.stringify(o));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      m.at = performance.now();
      if (m.setup) { s.setup = m.setup; send({ setupComplete: {} }); script({ send, next, s }).catch((e) => { s.error = e; }); return; }
      const w = s.waiters.findIndex((x) => x.kind === kindOf(m));
      if (w >= 0) { const [x] = s.waiters.splice(w, 1); m.taken = true; s.received.push(m); return x.resolve(m); }
      s.received.push(m);
    });
    ws.on('close', () => { s.closed = true; });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${srv.address().port}/live`, sessions, close: () => new Promise((r) => { for (const x of sessions) try { x.ws.close(); } catch {} srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
async function boot(env = {}) {
  const kd = await startFakeKnowDrive({ speed: 20 });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-voicebrain-'));
  const from = LOGS.length;
  const logs = { filter: (fn) => LOGS.slice(from).filter(fn), some: (fn) => LOGS.slice(from).some(fn) };
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: false, watch: false, env: {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_PUBLIC_URL: PUBLIC,
    KNOWBOT_WEBVOICE_RATE_LIMIT: '100', KNOWBOT_WEBVOICE_MAX_PER_IP: '10', ...env,
  }, studio: { sweep: false } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const port = kb.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
  const api = (p, init = {}) => fetch(base + p, init);
  await kb.registry.ready;
  assert.equal((await api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
  assert.equal((await api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'returns-policy.md' }, body: DOC })).status, 201);
  assert.equal((await api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
  await kd.settle();
  return { kd, kb, base, api, logs, admin, wsBase: `ws://127.0.0.1:${port}`,
    async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}
function browser(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const json = [], audio = [];
  const opened = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('socket failed'))); });
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.addEventListener('message', (ev) => { const at = performance.now(); if (typeof ev.data === 'string') json.push({ ...JSON.parse(ev.data), at }); else audio.push({ at, n: ev.data.byteLength }); });
  return { ws, json, audio, opened, closed, send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 8000) => until(() => json.find((m) => m.type === type && !m.seen && (m.seen = true)), ms, type) };
}

/**
 * One spoken question as the Live model plays it: the caller's words stream in (three transcript deltas, 120 ms apart),
 * the model's turn detection waits out the silence (vadMs), then it calls the search; it speaks the moment the tool
 * answers. Measured in the fake model: answer latency (tool call → tool response) and time to first answer audio (the
 * caller's last word → the first answer audio frame at the browser).
 */
const ASKS = [];
const QUESTION_SCRIPT = (vadMs) => async ({ send, next, s }) => {
  await next('text'); // [visitor connected]
  s.turns = [];
  while (!s.closed) {
    await next('audio'); // the visitor starts talking (the test sends one mic frame per question)
    const query = ASKS.shift();
    const words = query.split(' ');
    const parts = [words.slice(0, 3).join(' '), ` ${words.slice(3, 7).join(' ')}`, ` ${words.slice(7).join(' ')}`];
    for (const p of parts) { send({ serverContent: { inputTranscription: { text: p } } }); await sleep(120); }
    const lastWord = performance.now();
    await sleep(vadMs);
    const t0 = performance.now();
    send({ toolCall: { functionCalls: [{ id: `t${s.turns.length}`, name: 'search_knowledge_base', args: { query } }] } });
    const r = await next('toolResponse');
    const t1 = performance.now();
    send({ serverContent: { outputTranscription: { text: r.toolResponse.functionResponses[0].response.answer || NOT_IN_DATA }, modelTurn: { parts: [{ inlineData: { data: pcm(2400, 24000).toString('base64') } }] } } });
    send({ serverContent: { turnComplete: true } });
    s.turns.push({ query, lastWord, toolMs: Math.round(t1 - t0), response: r.toolResponse.functionResponses[0].response, sentAt: t1 });
  }
};
async function askByVoice(S, G, b, query, i) {
  const at = G.sessions.length - 1;
  const s = G.sessions[at];
  const n0 = b.audio.length;
  ASKS.push(query);
  b.ws.send(pcm(1600, 16000));
  await until(() => s.turns?.length > i, 20000, 'the turn');
  await until(() => b.audio.length > n0, 5000, 'answer audio');
  const turn = s.turns[i];
  return { toolMs: turn.toolMs, ttfaMs: Math.round(b.audio[n0].at - turn.lastWord), response: turn.response };
}
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

describe('voice brain: latency before/after against the fake Gemini Live (N4, N5)', () => {
  const VAD_MS = 600; // the model's end-of-turn silence (this server's setting) + its own thinking, simulated
  const KD_MS = 300; // each knowDrive request, as on a real network
  const results = {};
  async function measure(label, env, { warm = false, n = 3 } = {}) {
    _resetQuestions();
    const G = await startFakeGemini(QUESTION_SCRIPT(VAD_MS));
    const S = await boot({ GEMINI_API_KEY: 'gkey', GEMINI_LIVE_URL: G.url, ...env });
    S.kd.setLatency(KD_MS);
    try {
      if (warm) {
        // the bot's most-asked question, asked (and answered) before the voice session opens
        for (let i = 0; i < 3; i++) await S.api('/v1/bots/front-desk/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: Q }) });
        await until(async () => { await flushQuestions(); return [...S.kd.files.values()].some((f) => f.tags.includes('questions')); }, 5000, 'questions logged');
      }
      const b = browser(`${S.wsBase}/v1/bots/front-desk/voice/live`);
      await b.opened;
      b.send({ type: 'start' });
      await b.wait('ready');
      if (warm) await until(() => S.logs.some((l) => /instant answers for front-desk\|voice\|cards: [1-9]/.test(l)), 15000, 'instant answers ready');
      const runs = [];
      for (let i = 0; i < n; i++) runs.push(await askByVoice(S, G, b, Q, i));
      b.send({ type: 'stop' });
      await b.closed;
      results[label] = { toolMs: median(runs.map((r) => r.toolMs)), ttfaMs: median(runs.map((r) => r.ttfaMs)), runs, logs: S.logs.filter((l) => /\[voice\]/.test(l)) };
      return results[label];
    } finally { await S.close(); await G.close(); _resetQuestions(); }
  }
  test('before: no speculation, no instant answers', async () => {
    const r = await measure('before', { KNOWBOT_VOICE_SPECULATE: '0', KNOWBOT_VOICE_INSTANT: '0' });
    assert.ok(r.runs.every((x) => x.response.status === 'ok' && /30 days/.test(x.response.answer)), JSON.stringify(r.runs.map((x) => x.response)));
  });
  test('after: speculative search on the partial transcript (reused, logged once)', async () => {
    const r = await measure('speculative', { KNOWBOT_VOICE_INSTANT: '0' });
    assert.ok(r.runs.every((x) => x.response.status === 'ok' && /30 days/.test(x.response.answer)), JSON.stringify(r.runs.map((x) => x.response)) + r.logs.join('\n'));
    assert.ok(r.logs.some((l) => /speculative search reused/.test(l)), r.logs.join('\n'));
  });
  test('after: instant answers for the most-asked question', async () => {
    const r = await measure('instant', { KNOWBOT_VOICE_SPECULATE: '0' }, { warm: true });
    assert.ok(r.runs.every((x) => x.response.status === 'ok' && /30 days/.test(x.response.answer)));
    assert.ok(r.logs.some((l) => /instant answer \(sim/.test(l)), r.logs.join('\n'));
  });
  test('after: both on (the default)', async () => {
    await measure('default', {}, { warm: true });
    const row = (k) => `${k.padEnd(12)} answer latency (tool call → response) median ${String(results[k].toolMs).padStart(4)} ms · time to first answer audio after the last word median ${String(results[k].ttfaMs).padStart(4)} ms`;
    print(`  [latency] fake Gemini (${VAD_MS} ms turn detection), fake knowDrive (${KD_MS} ms a request) + LLM:\n    ${['before', 'speculative', 'instant', 'default'].map(row).join('\n    ')}`);
    // nothing added may make an answer slower; each change makes it faster
    for (const k of ['speculative', 'instant', 'default']) {
      assert.ok(results[k].toolMs <= results.before.toolMs, `${k} answer latency ${results[k].toolMs} vs before ${results.before.toolMs}`);
      assert.ok(results[k].ttfaMs <= results.before.ttfaMs + 5, `${k} time to first audio ${results[k].ttfaMs} vs before ${results.before.ttfaMs}`);
    }
    assert.ok(results.instant.toolMs < 30, `an instant answer is immediate (${results.instant.toolMs} ms)`);
  });
});

describe('voice brain: message-taking and invalidation through the web voice session (U5, N5)', () => {
  let S, G;
  before(async () => {
    _resetQuestions();
    G = await startFakeGemini(async ({ send, next, s }) => {
      await next('text');
      const call = async (id, name, args) => { send({ toolCall: { functionCalls: [{ id, name, args }] } }); const r = await next('toolResponse'); return r.toolResponse.functionResponses[0].response; };
      s.ref = await call('m1', 'search_knowledge_base', { query: OFF });
      s.rb = await call('m2', 'take_message', { name: 'Jo', contact: 'jo@example.com', question: OFF });
      s.ok = await call('m3', 'take_message', { name: 'Jo', contact: 'jo@example.com', question: OFF, confirmed: true });
      send({ serverContent: { turnComplete: true } });
    });
    S = await boot({ GEMINI_API_KEY: 'gkey', GEMINI_LIVE_URL: G.url });
  });
  after(async () => { _resetQuestions(); await S.close(); await G.close(); });
  test('a refusal offers a message; the address is read back; the lead is recorded with the unanswered question', async () => {
    const b = browser(`${S.wsBase}/v1/bots/front-desk/voice/live`);
    await b.opened;
    b.send({ type: 'start' });
    await b.wait('ready');
    const s = G.sessions[0];
    await until(() => s.ok, 15000, 'the message');
    assert.equal(s.ref.status, 'not_in_data');
    assert.equal(s.ref.say, NOT_IN_DATA);
    assert.ok(['offer_message', 'offer_related'].includes(s.ref.next));
    assert.equal(s.rb.status, 'confirm_first');
    assert.equal(s.rb.read_back, 'j o, at e x a m p l e, dot, c o m');
    assert.equal(s.ok.status, 'ok');
    const rep = await S.kb.leads.report(['front-desk'], { days: 7 });
    const lead = rep.leads.find((l) => l.consent === 'left_message');
    assert.ok(lead, JSON.stringify(rep.leads));
    assert.equal(lead.channel, 'voice');
    assert.equal(lead.type, 'email');
    assert.equal(lead.value, 'jo@example.com');
    assert.equal(lead.question, `Asked: ${OFF} · Name: Jo`);
    assert.equal(lead.name, 'Jo');
    b.send({ type: 'stop' });
    await b.closed;
  });
  test('owner settings through the Studio spec and a launched bot: validated, stored, defaults', async () => {
    const t = await (await S.api('/api/studio/trials', { method: 'POST' })).json();
    const H = { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
    const bad = await S.api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ voiceSetup: { transfer: { number: '12' } } }) });
    assert.equal(bad.status, 400);
    const ok = await (await S.api(`/api/studio/trials/${t.trialId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ voiceSetup: { voice: 'Aoede', language: 'fr', takeMessages: false, transfer: { number: '+33 1 23 45 67 89', timezone: 'Europe/Paris' } } }) })).json();
    assert.deepEqual(ok.spec.voiceSetup, { voice: 'Aoede', language: 'fr', takeMessages: false, transfer: { number: '+33123456789', timezone: 'Europe/Paris', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' } });
    const inst = await S.api('/api/instances/front-desk', { method: 'PATCH', headers: S.admin, body: JSON.stringify({ voiceSetup: { voice: 'Charon', takeMessages: false } }) });
    assert.equal(inst.status, 200);
    const at = G.sessions.length;
    const b = browser(`${S.wsBase}/v1/bots/front-desk/voice/live`);
    await b.opened;
    b.send({ type: 'start' });
    await b.wait('ready');
    await until(() => G.sessions[at]?.setup, 5000, 'setup');
    const setup = G.sessions[at].setup;
    assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
    assert.deepEqual(setup.tools[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base'], 'message-taking off: no take_message');
    b.send({ type: 'stop' });
    await b.closed;
    await S.api('/api/instances/front-desk', { method: 'PATCH', headers: S.admin, body: JSON.stringify({ voiceSetup: null }) });
  });
});

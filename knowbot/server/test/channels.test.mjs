// Channel adapters (SPEC 11.3) against FAKE providers only: a fake Twilio (signatures + recordings), a fake Meta Graph
// API, a fake Google Speech/TTS and a fake mail relay all run on 127.0.0.1. No real credentials exist or are used.
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
import { flushQuestions, configureQuestions, _resetQuestions, hashCaller } from '../questions.mjs';
import { twilioSignature, metaSignature, mailgunSignature, formatSms, smsInfo, toGsm7, formatSpoken, formatWhatsApp, formatEmail, channelStatus, answerSentences, NOT_IN_DATA as UTIL_REFUSAL } from '../channels/util.mjs';
import { encodingFor } from '../channels/google.mjs';
import { stripReply } from '../channels/email.mjs';
import { NOT_IN_DATA } from '../../lib/knowbot.js';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PUBLIC = 'https://kb.example.test';
const PHONE = '+14155550199';

const DOC = `# Returns Policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.

# Shipping

We ship to Canada and the United States. Standard shipping takes 3 to 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const OFF = 'What is the capital of Australia?';

/** Fake Twilio + Meta + Google + mail relay. */
async function startFakeProviders() {
  const calls = [];
  const state = { transcript: Q };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const call = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: body.toString('utf8') };
      calls.push(call);
      const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (u.pathname === '/google/stt/v1/speech:recognize') {
        if (u.searchParams.get('key') !== 'gkey') return json(403, { error: { message: 'bad key' } });
        const b = JSON.parse(call.body);
        call.json = b;
        return json(200, { results: [{ alternatives: [{ transcript: state.transcript, confidence: 0.94 }] }] });
      }
      if (u.pathname === '/google/tts/v1/text:synthesize') {
        if (u.searchParams.get('key') !== 'gkey') return json(403, { error: { message: 'bad key' } });
        call.json = JSON.parse(call.body);
        return json(200, { audioContent: Buffer.from(`ID3-fake-mp3:${call.json.input.text.slice(0, 40)}`).toString('base64') });
      }
      if (/^\/twilio\/2010-04-01\/Accounts\/AC1\/Recordings\/RE1\.wav$/.test(u.pathname)) {
        if (req.headers.authorization !== `Basic ${Buffer.from('AC1:twilio-secret').toString('base64')}`) { res.writeHead(401); return res.end(); }
        const wav = Buffer.alloc(64); wav.write('RIFF', 0); wav.write('WAVE', 8); wav.writeUInt16LE(1, 20); wav.writeUInt32LE(8000, 24);
        res.writeHead(200, { 'content-type': 'audio/x-wav' }); return res.end(wav);
      }
      if (/^\/graph\/1234567890\/messages$/.test(u.pathname)) { call.json = JSON.parse(call.body); return json(200, { messages: [{ id: 'wamid.1' }] }); }
      if (u.pathname === '/relay') { call.json = JSON.parse(call.body); return json(200, { ok: true }); }
      json(404, { error: 'no route' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, state, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

async function boot(env = {}) {
  const kd = await startFakeKnowDrive({ speed: 20 });
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-channels-'));
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, env: {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_PUBLIC_URL: PUBLIC, ...env,
  }, studio: { sweep: false } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
  const api = (p, init = {}) => fetch(base + p, init);
  await kb.registry.ready;
  assert.equal((await api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
  assert.equal((await api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'returns-policy.md' }, body: DOC })).status, 201);
  assert.equal((await api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
  await kd.settle();
  return {
    kd, kb, base, api,
    /** POST form params to a Twilio webhook, signed for the public URL Twilio would have called. */
    twilio(p, params, { token = 'twilio-secret', sign = true } = {}) {
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      if (sign) headers['x-twilio-signature'] = twilioSignature(token, PUBLIC + p, params);
      return api(p, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
    },
    async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); },
  };
}
/** The bot's admin insights after every queued question is written (customer traffic total, all channels). */
async function questionsInsightsFor(S) {
  await flushQuestions();
  const r = await S.api('/api/instances/front-desk/insights?limit=50', { headers: { authorization: 'Bearer dev-admin' } });
  assert.equal(r.status, 200);
  return r.json();
}
const messageOf = (xmlText) => /<Message>([\s\S]*?)<\/Message>/.exec(xmlText)?.[1]?.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// ------------------------------------------------------------------ formatting units
describe('channels: per-medium formatting', () => {
  const r = { refused: false, answer: '- You can return any unused item within 30 days of delivery for a full refund. [1]\n- Refunds go back to the original payment method within 5 business days. [2]',
    citations: [{ n: 1, file: 'returns-policy.md', title: 'returns-policy.md' }, { n: 2, file: 'refunds.md', title: 'Refunds' }],
    proof: { quoted: [{ n: 1, text: 'You can return any unused item within 30 days of delivery for a full refund.' }, { n: 2, text: 'Refunds go back to the original payment method within 5 business days.' }] } };
  test('SMS stays within 320 characters with markers and the proof link', () => {
    const long = { ...r, answer: Array.from({ length: 12 }, (_, i) => `- Line ${i} says something useful about returns and refunds. [1]`).join('\n') };
    const s = formatSms(long, 'https://kb.example.test/p/abcdefghijkl');
    assert.ok(s.length <= 320, String(s.length));
    assert.match(s, /\[1\]/);
    assert.match(s, / Proof: https:\/\/kb\.example\.test\/p\/abcdefghijkl$/);
    // whole sentences only, ending at a stop before the link: no clipped excerpt, no ellipsis
    assert.ok(!s.includes('…'), s);
    // a run of sentences from the same source carries its marker once, at the end of the run (no "[1]" after every sentence)
    assert.match(s, /^Line 0 says something useful about returns and refunds\. Line 1 .*\[1\]\. Proof: /);
    assert.equal((s.match(/\[1\]/g) || []).length, 1, s);
    const mixed = formatSms({ ...r, answer: '- Frames carry a lifetime warranty. [1]\n- Paint is covered for two years. [1]\n- Returns take 30 days. [2]' }, null);
    assert.equal(mixed, 'Frames carry a lifetime warranty. Paint is covered for two years [1]. Returns take 30 days [2].');
    const quoteHeavy = formatSms({ ...r, answer: '- You can return any unused item within 30 days of delivery for a full refund. [1]' }, 'https://x/p/abc');
    assert.equal(quoteHeavy, 'You can return any unused item within 30 days of delivery for a full refund [1]. Proof: https://x/p/abc', 'answer + proof link only, never citation excerpts');
    assert.equal(formatSms({ refused: true }, 'x'), NOT_IN_DATA);
    assert.equal(UTIL_REFUSAL, NOT_IN_DATA, 'the channels use the canonical refusal byte for byte');
  });
  test('SMS spends its budget on the answer: no courtesy, GSM-7 only, whole quotes, best match first (frame warranty)', () => {
    const fw = { refused: false, question: 'How long is the frame warranty?',
      answer: 'I found a few things that should help!\n- From “Lumen Bikes Warranty and Returns Policy”, under “Crash damage”: “Damage from crashes and falls is covered by the Crash Replacement program at 40% off, but not by the lifetime frame warranty” [1]\n- From “Lumen Bikes Warranty and Returns Policy”, under “Frames”: “Lumen frames carry a lifetime warranty for the original owner – registration required within 30 days” [1]\n- From “Lumen Store FAQ”: “Paint and finish are covered for two years from the date of purchase, excluding chips from normal riding” [2]\nHope this helps!',
      citations: [{ n: 1, file: 'lumen-warranty-returns.md' }, { n: 2, file: 'faq.md' }] };
    const s = formatSms(fw, 'https://kb.example.test/p/abcdefghijkl');
    assert.match(s, /^"Lumen frames carry a lifetime warranty for the original owner - registration required within 30 days" \[1\]\. /, s);
    assert.ok(s.includes('lifetime'), s);
    assert.ok(!/[“”‘’–…]/.test(s) && !/From "|Hope this|I found/.test(s), s);
    const info = smsInfo(s);
    assert.equal(info.encoding, 'GSM-7');
    assert.ok(info.segments <= 2 && s.length <= 306, JSON.stringify(info));
    // whole quotes only: an item that does not fit is left out, never cut mid-quote
    assert.equal((s.match(/"/g) || []).length % 2, 0, s);
    assert.ok(!s.includes('...'), s);
    assert.match(s, / Proof: https:\/\/kb\.example\.test\/p\/abcdefghijkl$/);
    assert.equal(toGsm7('“a” ‘b’ – c… café'), '"a" \'b\' - c... café');
    assert.deepEqual(smsInfo('x'.repeat(161)), { encoding: 'GSM-7', chars: 161, segments: 2 });
    assert.equal(smsInfo('日本').encoding, 'UCS-2');
  });
  test('voice speaks with attribution and no markers', () => {
    const s = formatSpoken(r);
    assert.equal(s, 'According to the Returns Policy, you can return any unused item within 30 days of delivery for a full refund. And according to the Refunds file, refunds go back to the original payment method within 5 business days.');
    // a name keeps its casing after the attribution (never "According to …, lumen Care Plan")
    const named = formatSpoken({ refused: false, answer: 'x', citations: [{ n: 1, file: 'lumen-care-plan.md', title: 'lumen care plan' }], proof: { quoted: [{ n: 1, text: 'Lumen Care Plan covers accidental damage for 2 years.' }] } });
    assert.equal(named, 'According to the Lumen Care Plan, Lumen Care Plan covers accidental damage for 2 years.');
    assert.ok(!/\[\d\]/.test(s));
    assert.equal(formatSpoken({ refused: true }), NOT_IN_DATA);
  });
  test('voice: a name that starts with an ordinary opener keeps its capital; title words count as names', () => {
    const care = formatSpoken({ refused: false, answer: 'x', citations: [{ n: 1, file: 'care.md', title: 'Lumen Care Plan' }], proof: { quoted: [{ n: 1, text: 'The Lumen Care Plan costs $129 a year.' }] } });
    assert.equal(care, 'According to the Lumen Care Plan, the Lumen Care Plan costs $129 a year.');
    const plain = formatSpoken({ refused: false, answer: 'x', citations: [{ n: 1, file: 'returns.md', title: 'Returns' }], proof: { quoted: [{ n: 1, text: 'The return window is 30 days.' }] } });
    assert.equal(plain, 'According to the Returns file, the return window is 30 days.');
  });
  test('voice keeps proper nouns capitalised after the attribution', () => {
    // the golive critic's case: never "According to …, lumen frames carry …"
    const lumen = { refused: false, answer: 'Lumen frames carry a lifetime warranty for the original owner. [1]', citations: [{ n: 1, file: 'lumen-warranty-returns.md', title: 'Lumen Bikes Warranty and Returns Policy' }],
      proof: { quoted: [{ n: 1, text: 'Lumen frames carry a lifetime warranty for the original owner.' }] } };
    assert.equal(formatSpoken(lumen), 'According to the Lumen Bikes Warranty and Returns Policy, Lumen frames carry a lifetime warranty for the original owner.');
    // a common opener that the bot's own material uses as a name keeps its capital ("our Standard plan …")
    const plan = { refused: false, answer: 'Standard covers one bike. You can upgrade to our Standard plus tier later. [1]', citations: [{ n: 1, file: 'plans.md', title: 'Plans' }],
      proof: { quoted: [{ n: 1, text: 'Standard covers one bike.' }] } };
    assert.equal(formatSpoken(plan), 'According to the Plans, Standard covers one bike.');
    // the bot's name / org tokens keep their capital too; ordinary openers still read naturally
    const named = { refused: false, answer: 'x', citations: [{ n: 1, file: 'faq.md', title: 'FAQ' }], proof: { quoted: [{ n: 1, text: 'Free returns are included.' }] } };
    assert.equal(formatSpoken(named), 'According to the FAQ, free returns are included.');
    assert.equal(formatSpoken(named, 450, { names: ['Free Wheel Co'] }), 'According to the FAQ, Free returns are included.');
    assert.equal(formatSpoken(named, 450, { names: ['Your Bike Shop'] }), 'According to the FAQ, free returns are included.', 'pronouns in a name never count');
    // the voice critic's case: an article before the title, and an ordinary first word lower-cased ("E-bike" → "e-bike")
    const ebike = { refused: false, answer: 'x', citations: [{ n: 1, file: 'lumen-warranty-returns.md', title: 'Lumen Bikes Warranty and Returns Policy' }], proof: { quoted: [{ n: 1, text: 'E-bike batteries are covered for two years.' }] } };
    assert.equal(formatSpoken(ebike), 'According to the Lumen Bikes Warranty and Returns Policy, e-bike batteries are covered for two years.');
    const acro = { refused: false, answer: 'x', citations: [{ n: 1, file: 'shipping.md', title: 'Shipping' }], proof: { quoted: [{ n: 1, text: 'UPS delivers within 3 days.' }] } };
    assert.equal(formatSpoken(acro), 'According to the Shipping file, UPS delivers within 3 days.', 'acronyms keep their capitals');
  });
  test('WhatsApp and e-mail carry footnotes and a source list', () => {
    const w = formatWhatsApp(r, 'https://p');
    assert.match(w, /^• You can return .*\[1\]\n• Refunds .*\[2\]\n\n\*Sources\*\n\[1\] Returns Policy \(returns-policy\.md\)\n\[2\] Refunds \(refunds\.md\)\n\nSee the exact quotes: https:\/\/p$/);
    const e = formatEmail(r, { proofUrl: 'https://p', botName: 'Front Desk' });
    assert.match(e.text, /Sources\n\[1\] Returns Policy \(returns-policy\.md\)\n {4}"You can return/);
    assert.match(e.html, /<sup[^>]*>\[1\]<\/sup>/);
    assert.ok(!/<script/i.test(formatEmail({ ...r, answer: '<script>x</script> [1]' }, {}).html));
  });
  test('librarian voice on every channel: links become “Title” (url), quotations never split, page/section named, URLs never spoken', () => {
    const one = { refused: false, answer: 'I think I found what you\'re looking for! In [“Owner\'s Manual”](https://x.example/manual.pdf), page 17, under “Oil filter”, it says: “Replace the oil filter every 5,000 km. Use OEM parts only” [1]. Feel free to download it if that\'s helpful.',
      citations: [{ n: 1, file: 'manual.pdf', title: "Owner's Manual", page: 17, section: 'Oil filter', url: 'https://x.example/manual.pdf' }],
      proof: { quoted: [{ n: 1, text: 'Replace the oil filter every 5,000 km. Use OEM parts only' }] } };
    // a stop inside “…” never ends a sentence
    const sn = answerSentences(one.answer);
    assert.equal(sn.length, 3, JSON.stringify(sn));
    assert.ok(sn[0].courtesy && sn[2].courtesy && !sn[1].courtesy);
    assert.match(sn[1].text, /“Replace the oil filter every 5,000 km\. Use OEM parts only”$/);
    assert.equal(sn[1].tag, ' [1]');
    const sms = formatSms(one, 'https://kb/p/abc');
    assert.ok(sms.length <= 320, String(sms.length));
    // SMS: the verbatim quote and its marker only (GSM-7 straight quotes, no courtesy, no "In “Title”, it says:" pointer)
    assert.equal(sms, '"Replace the oil filter every 5,000 km. Use OEM parts only" [1]. Proof: https://kb/p/abc');
    // too long for one SMS: the courtesy opener goes first, the cited fact stays
    const long = { ...one, answer: one.answer.replace('Use OEM parts only', `Use OEM parts only${' and keep the receipt'.repeat(8)}`) };
    const ls = formatSms(long, 'https://kb/p/abc');
    assert.ok(ls.length <= 306 && !/^I think/.test(ls) && smsInfo(ls).encoding === 'GSM-7' && smsInfo(ls).segments <= 2, ls);
    const w = formatWhatsApp(one, 'https://p');
    assert.ok(!w.includes(']('), w);
    assert.match(w, /\[1\] Owner's Manual, page 17, “Oil filter” \(manual\.pdf\)\n {4}Download: https:\/\/x\.example\/manual\.pdf/);
    const e = formatEmail(one, { proofUrl: 'https://p' });
    assert.ok(!e.text.includes(']('));
    assert.match(e.html, /<a href="https:\/\/x\.example\/manual\.pdf"[^>]*>“Owner's Manual”<\/a>, page 17/);
    assert.match(e.html, /· page 17, “Oil filter”/);
    assert.ok(!/<a href="javascript/i.test(formatEmail({ ...one, answer: 'See [“x”](javascript:alert(1)) “y” [1]' }, {}).html), 'only http(s) links');
    const spoken = formatSpoken(one);
    assert.equal(spoken, 'According to page 17 of the Owner\'s Manual, replace the oil filter every 5,000 km. Use OEM parts only.');
    // a list: opener and closer stay plain lines, one bullet per cited item; spoken from the web page without its URL
    const list = { refused: false, answer: 'I found a few things that should help!\n- From [“Returns”](https://shop.example/returns): “Returns are accepted within 30 days” [1]\n- From “Warranty”, page 3: “Frames carry a lifetime warranty” [2]\nFeel free to open the link for the full details.',
      citations: [{ n: 1, file: 'returns.md', title: 'Returns', url: 'https://shop.example/returns' }, { n: 2, file: 'warranty.pdf', title: 'Warranty', page: 3 }] };
    assert.match(formatWhatsApp(list, null), /^I found a few things that should help!\n• From “Returns” \(https:\/\/shop\.example\/returns\): “Returns are accepted within 30 days” \[1\]\n• From “Warranty”, page 3: .*\[2\]\nFeel free to open the link for the full details\.\n/);
    assert.match(formatEmail(list, {}).html, /<p[^>]*>I found a few things that should help!<\/p><ul[^>]*><li[^>]*>From <a href="https:\/\/shop\.example\/returns"/);
    const sp = formatSpoken(list);
    assert.equal(sp, 'According to the Returns page, returns are accepted within 30 days. And according to page 3 of the Warranty, frames carry a lifetime warranty.');
    assert.ok(!/https?:|\]\(/.test(sp), 'a URL is never read aloud');
  });
  test('helpers: reply stripping, audio encodings, status without secrets', () => {
    assert.equal(stripReply('Do you ship to Canada?\n\nOn Mon, Jane wrote:\n> old stuff\n> more'), 'Do you ship to Canada?');
    assert.equal(stripReply('Hours?\n-- \nJane, CEO'), 'Hours?');
    assert.equal(encodingFor('audio/webm;codecs=opus').encoding, 'WEBM_OPUS');
    assert.equal(encodingFor('audio/ogg').encoding, 'OGG_OPUS');
    const st = channelStatus({ TWILIO_AUTH_TOKEN: 'secret-value' });
    assert.equal(st.sms.configured, true);
    assert.equal(st.whatsapp.provider, 'twilio');
    assert.ok(!JSON.stringify(st).includes('secret-value'));
  });
});

// ------------------------------------------------------------------ webhooks, all providers configured
describe('channels: webhooks against fake providers', () => {
  let S, F;
  before(async () => {
    _resetQuestions(); configureQuestions({ debounceMs: 5 });
    F = await startFakeProviders();
    S = await boot({
      TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_BASE_URL: `${F.url}/twilio`,
      WHATSAPP_VERIFY_TOKEN: 'verify-me', WHATSAPP_APP_SECRET: 'meta-secret', WHATSAPP_ACCESS_TOKEN: 'meta-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', META_GRAPH_BASE_URL: `${F.url}/graph`,
      EMAIL_WEBHOOK_SECRET: 'mail-secret', MAILGUN_SIGNING_KEY: 'mg-key', EMAIL_REPLY_WEBHOOK: `${F.url}/relay`, EMAIL_FROM: 'bot@acme.test',
      GOOGLE_API_KEY: 'gkey', GOOGLE_STT_BASE_URL: `${F.url}/google/stt`, GOOGLE_TTS_BASE_URL: `${F.url}/google/tts`,
    });
  });
  after(async () => { _resetQuestions(); await S.close(); await F.close(); });

  test('status: every channel configured, webhook URLs carry the bot id, no secrets', async () => {
    const j = await (await S.api('/v1/channels/front-desk')).json();
    // one canonical base for every URL handed out (/v1 and /api/v1 are aliases), whichever alias the caller used
    assert.equal(j.channels.sms.webhook, `${PUBLIC}/api/v1/channels/front-desk/sms`);
    assert.equal(j.channels.chat.endpoint, `${PUBLIC}/api/v1/bots/front-desk/chat`);
    const viaApi = await (await S.api('/api/v1/channels/front-desk')).json();
    assert.deepEqual(viaApi.channels, j.channels);
    for (const c of Object.values(j.channels)) for (const u of [c.webhook, c.endpoint].filter(Boolean)) assert.ok(u.startsWith(`${PUBLIC}/api/v1/`), u);
    assert.equal(j.channels.whatsapp.provider, 'meta');
    // phone calls are Gemini Live only: no GEMINI_API_KEY here, so the voice channel is not configured (no classic loop)
    assert.equal(j.channels.voice.engine, 'not_configured');
    assert.equal(j.channels.voice.configured, false);
    assert.deepEqual(j.channels.voice.needs, ['GEMINI_API_KEY']);
    assert.equal(j.channels.voice.speech, undefined);
    assert.equal(j.channels.voiceBot.google, true);
    assert.ok(!/twilio-secret|meta-secret|gkey|mail-secret/.test(JSON.stringify(j)));
    assert.equal((await S.api('/v1/channels/nope')).status, 404);
  });

  test('SMS: signature required; TwiML reply ≤ 320 chars with [1] and a proof link; refusal is canonical', async () => {
    const p = '/v1/channels/front-desk/sms';
    assert.equal((await S.twilio(p, { From: PHONE, Body: Q }, { sign: false })).status, 403);
    assert.equal((await S.twilio(p, { From: PHONE, Body: Q }, { token: 'wrong' })).status, 403);
    const r = await S.twilio(p, { From: PHONE, To: '+15550001111', Body: Q, MessageSid: 'SM1' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/xml/);
    const xml = await r.text();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<Response><Message>/);
    const msg = messageOf(xml);
    assert.ok(msg.length <= 320);
    assert.match(msg, /30 days[^.]*\[1\]\. Proof: https:\/\/kb\.example\.test\/p\/[A-Za-z0-9_-]+$/);
    assert.ok(!msg.includes('…'));
    const id = /\/p\/([A-Za-z0-9_-]+)$/.exec(msg)[1];
    const proof = await (await S.api(`/p/${id}`)).text();
    assert.ok(proof.includes('within 30 days') && proof.includes('returns-policy.md'));
    const ref = messageOf(await (await S.twilio(p, { From: '+14155550100', Body: OFF })).text());
    assert.equal(ref, NOT_IN_DATA);
  });

  test('Voice without GEMINI_API_KEY: Google speech keys do not make a phone engine; the call hears "not set up yet" and is hung up', async () => {
    const p = '/v1/channels/front-desk/voice';
    assert.equal((await S.twilio(p, { CallSid: 'CA1', From: PHONE }, { sign: false })).status, 403);
    const first = await (await S.twilio(p, { CallSid: 'CA1', From: PHONE })).text();
    assert.match(first, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<Response><Say voice="[^"]+" language="en-US">Sorry, this phone line isn&apos;t set up yet\. Please try again later\. Goodbye\.<\/Say><Hangup\/><\/Response>$/);
    assert.ok(!/<Gather|<Record|<Play|<Stream/.test(first));
    // the classic steps are gone
    for (const sub of ['answer?empty=0', 'recording?empty=0', 'audio/abcdefghij.mp3']) assert.equal((await S.twilio(`${p}/${sub}`, { CallSid: 'CA1', From: PHONE, SpeechResult: Q })).status, 404, sub);
    assert.ok(!F.calls.some((c) => c.path.startsWith('/google/')), 'no Google speech call for a phone call');
  });

  test('WhatsApp (Meta): verify handshake, signed webhook, reply via Graph API with footnotes', async () => {
    const p = '/v1/channels/front-desk/whatsapp';
    const ok = await S.api(`${p}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '1158201444');
    assert.equal((await S.api(`${p}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550001111', phone_number_id: '1234567890' }, contacts: [{ profile: { name: 'Jane' }, wa_id: '14155550199' }],
      messages: [{ from: '14155550199', id: 'wamid.in1', timestamp: '1762560000', type: 'text', text: { body: Q } }] } }] }] });
    assert.equal((await S.api(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: payload })).status, 403);
    const r = await S.api(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSignature('meta-secret', payload) }, body: payload });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, received: 1 });
    let sent;
    for (let i = 0; i < 100 && !(sent = F.calls.find((c) => c.path === '/graph/1234567890/messages')); i++) await sleep(20);
    assert.ok(sent, 'replied through the Graph API');
    assert.equal(sent.headers.authorization, 'Bearer meta-token');
    assert.equal(sent.json.to, '14155550199');
    assert.equal(sent.json.messaging_product, 'whatsapp');
    assert.match(sent.json.text.body, /30 days.*\[1\][\s\S]*\*Sources\*\n\[1\] Returns Policy \(returns-policy\.md\)/);
  });

  test('WhatsApp (Twilio): form webhook, TwiML reply', async () => {
    const xml = await (await S.twilio('/v1/channels/front-desk/whatsapp', { From: `whatsapp:${PHONE}`, To: 'whatsapp:+15550001111', Body: Q })).text();
    assert.match(messageOf(xml), /\[1\][\s\S]*\*Sources\*/);
  });

  test('E-mail: Postmark JSON, SendGrid multipart and Mailgun signed form; replies are footnoted; loops ignored', async () => {
    const p = '/v1/channels/front-desk/email';
    const postmark = JSON.stringify({ From: 'Jane <jane@example.com>', FromFull: { Email: 'jane@example.com' }, Subject: 'Returns', TextBody: `${Q}\n\nOn Mon, Bot wrote:\n> earlier`, Headers: [] });
    assert.equal((await S.api(`${p}?key=wrong`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: postmark })).status, 403);
    const r = await S.api(`${p}?key=mail-secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: postmark });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.provider, 'postmark');
    assert.equal(j.delivered, true);
    assert.equal(j.reply.subject, 'Re: Returns');
    assert.match(j.reply.text, /30 days.*\[1\][\s\S]*Sources\n\[1\] Returns Policy \(returns-policy\.md\)\n {4}"You can return any unused item within 30 days/);
    const relayed = F.calls.filter((c) => c.path === '/relay').at(-1).json;
    assert.equal(relayed.to, 'jane@example.com');
    assert.equal(relayed.from, 'bot@acme.test');
    assert.match(relayed.html, /<blockquote/);
    // SendGrid Inbound Parse (multipart, basic-auth password = secret)
    const fd = new FormData();
    fd.append('from', 'Sam <sam@example.org>'); fd.append('subject', OFF); fd.append('text', ''); fd.append('headers', 'Received: x');
    const sg = await (await S.api(p, { method: 'POST', headers: { authorization: `Basic ${Buffer.from('sendgrid:mail-secret').toString('base64')}` }, body: fd })).json();
    assert.equal(sg.provider, 'sendgrid');
    assert.equal(sg.refused, true);
    assert.match(sg.reply.text, new RegExp(`^${NOT_IN_DATA.replace(/[.?]/g, '\\$&')}`));
    // Mailgun (signature instead of the shared secret)
    const ts = String(Math.floor(Date.now() / 1000)), token = 'tok123';
    const mg = new URLSearchParams({ sender: 'lee@example.net', subject: 'Question', 'stripped-text': Q, timestamp: ts, token, signature: mailgunSignature('mg-key', ts, token) });
    const mr = await (await S.api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: mg.toString() })).json();
    assert.equal(mr.provider, 'mailgun');
    assert.equal(mr.refused, false);
    const bad = new URLSearchParams({ sender: 'lee@example.net', subject: 'Q', 'stripped-text': Q, timestamp: ts, token, signature: 'f'.repeat(64) });
    assert.equal((await S.api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: bad.toString() })).status, 403);
    // our own address / auto-replies never get an answer (no mail loops)
    const own = JSON.stringify({ FromFull: { Email: 'bot@acme.test' }, Subject: 'Re: Returns', TextBody: Q });
    assert.equal((await (await S.api(`${p}?key=mail-secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: own })).json()).ignored, true);
    const ooo = JSON.stringify({ FromFull: { Email: 'x@example.com' }, Subject: 'Out of office', TextBody: 'away', Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }] });
    assert.equal((await (await S.api(`${p}?key=mail-secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ooo })).json()).ignored, true);
    // a payload with no sender is never silently dropped: it says why and which shapes are accepted
    const odd = await (await S.api(`${p}?key=mail-secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'Q', text: Q }) })).json();
    assert.equal(odd.ignored, true);
    assert.equal(odd.reason, 'unrecognized_payload');
    assert.match(odd.message, /Postmark/);
    // a plain {from, subject, text} relay shape is answered
    const plain = await (await S.api(`${p}?key=mail-secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Kim <kim@example.org>', subject: 'Returns', text: Q }) })).json();
    assert.equal(plain.refused, false, JSON.stringify(plain));
  });

  test('browser voice bot: audio in → Google transcript → cited answer → Google audio out', async () => {
    const k = await (await S.api('/api/instances/front-desk/keys', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'application/json' }, body: '{}' })).json();
    const r = await S.api('/v1/bots/front-desk/voice', { method: 'POST', headers: { authorization: `Bearer ${k.key}`, 'content-type': 'audio/webm;codecs=opus' }, body: Buffer.from('OggS-not-really-webm') });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.transcript, Q);
    assert.equal(j.refused, false);
    assert.match(j.answer, /\[1\]/);
    assert.match(j.spoken, /^According to the Returns Policy/);
    assert.equal(j.mime, 'audio/mpeg');
    assert.match(Buffer.from(j.audio, 'base64').toString(), /^ID3-fake-mp3:According to/);
    assert.deepEqual(j.speech, { recognition: 'google', synthesis: 'google' });
    assert.equal(F.calls.filter((c) => c.path === '/google/stt/v1/speech:recognize').at(-1).json.config.encoding, 'WEBM_OPUS');
  });

  test('every channel logged its questions with its channel tag; caller phone numbers and e-mails are only hashed', async () => {
    await flushQuestions();
    const files = [...S.kd.files.values()].filter((f) => f.tags.includes('questions'));
    const chans = new Set(files.map((f) => f.tags.find((t) => t.startsWith('channel:'))));
    for (const c of ['sms', 'voice', 'whatsapp', 'email']) assert.ok(chans.has(`channel:${c}`), `channel:${c} logged`); // voice = browser voice bot (phone calls: voice-live.test.mjs)
    assert.ok(files.some((f) => f.tags.includes(`from:${hashCaller(PHONE)}`)));
    assert.ok(files.some((f) => f.tags.includes(`from:${hashCaller('jane@example.com')}`)));
    const all = files.map((f) => `${f.filename} ${f.tags.join(',')} ${f.text}`).join('\n');
    for (const secret of ['4155550199', 'jane@example.com', 'sam@example.org', 'lee@example.net']) assert.ok(!all.includes(secret), `${secret} never stored`);
    assert.ok(files.every((f) => f.tags.includes('bot:front-desk') && f.filename.startsWith('knowbot/_bots/front-desk/questions/')));
  });
});

// ------------------------------------------------------------------ phone without Gemini + unconfigured server
describe('channels: phone without GEMINI_API_KEY and missing configuration', () => {
  let S, N;
  before(async () => { _resetQuestions(); S = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret' }); N = await boot({}); });
  after(async () => { _resetQuestions(); await S.close(); await N.close(); });

  test('Voice without GEMINI_API_KEY: a polite "not set up yet" and a hang-up, never a <Gather> answering loop', async () => {
    const p = '/v1/channels/front-desk/voice';
    const caller = '+14155550177';
    const before = (await questionsInsightsFor(S)).total;
    for (const params of [{ CallSid: 'CA2', From: PHONE }, { CallSid: 'CA9', From: caller, SpeechResult: Q, Confidence: '0.9' }]) {
      const xml = await (await S.twilio(p, params)).text();
      assert.match(xml, /<Say voice="[^"]+" language="en-US">Sorry, this phone line isn&apos;t set up yet\. Please try again later\. Goodbye\.<\/Say><Hangup\/>/);
      assert.ok(!/<Gather|According to/.test(xml), 'a question in the first POST is not answered either');
    }
    assert.equal((await S.twilio(`${p}/answer?empty=0`, { CallSid: 'CA2', From: PHONE, SpeechResult: Q })).status, 404);
    assert.equal((await questionsInsightsFor(S)).total, before, 'nothing answered, nothing logged');
    const st = await (await S.api('/v1/channels/front-desk')).json();
    assert.equal(st.channels.voice.engine, 'not_configured');
    assert.equal(st.channels.voice.mediaStream, undefined);
  });

  test('a channel with no configuration answers 503 "channel not configured" and names what to set', async () => {
    for (const [ch, needs] of [['sms', 'TWILIO_AUTH_TOKEN'], ['voice', 'TWILIO_AUTH_TOKEN'], ['whatsapp', 'WHATSAPP_VERIFY_TOKEN'], ['email', 'EMAIL_WEBHOOK_SECRET']]) {
      const r = await N.api(`/v1/channels/front-desk/${ch}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'Body=hi' });
      assert.equal(r.status, 503, ch);
      const j = await r.json();
      assert.equal(j.error.code, 'channel_not_configured');
      assert.ok(j.error.message.includes(needs), j.error.message);
    }
    assert.equal((await N.api('/v1/channels/front-desk/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status, 503);
    assert.equal((await N.api('/v1/channels/front-desk/fax', { method: 'POST' })).status, 404);
    const st = await (await N.api('/v1/channels/front-desk')).json();
    assert.equal(st.channels.sms.configured, false);
    assert.deepEqual(st.channels.sms.needs, ['TWILIO_AUTH_TOKEN']);
    assert.equal(st.channels.voiceBot.recognition, 'browser');
  });
});

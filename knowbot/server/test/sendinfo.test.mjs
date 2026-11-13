// "Send me this information" (server/sendinfo.mjs) on every surface, against FAKES on 127.0.0.1 only: a fake mail API
// (POST /emails) and a fake texting API (Messages.json) record every send. No real credentials are used.
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
import { twilioSignature, smsInfo } from '../channels/util.mjs';
import { createToolRunner, systemInstruction, toolDeclarations } from '../channels/voice-live.mjs';
import { webToolDeclarations } from '../channels/webvoice.mjs';
import {
  createSendInfo, detectSendIntent, findContacts, normalizePhone, maskEmail, emailFrom, textMessage, emailMessage, normalizeAnswer, isStopWord, NOTHING, TEXT_MAX,
} from '../sendinfo.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = 'https://kb.example.test';
const LINE = '+14155550100';
const DOC = `# Returns Policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const OFF = 'What is the capital of Australia?';
const ANSWER = {
  question: Q, refused: false, answer: 'Good news, I found it! In [“Returns Policy”](https://shop.example/returns), it says: “You can return any unused item within 30 days of delivery for a full refund.” [1]',
  citations: [{ n: 1, file: 'returns-policy.md', title: 'Returns Policy', url: 'https://shop.example/returns', excerpt: 'You can return any unused item within 30 days of delivery for a full refund.' }],
  proof: { quoted: [{ n: 1, text: 'You can return any unused item within 30 days of delivery for a full refund.' }] }, proofUrl: `${PUBLIC}/p/abc123`,
};

/** Fake mail API + texting API. */
async function startFakeSenders() {
  const emails = [], texts = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/emails') { emails.push({ auth: req.headers.authorization, body: JSON.parse(raw) }); return json(200, { id: `em_${emails.length}` }); }
      if (/\/2010-04-01\/Accounts\/AC1\/Messages\.json$/.test(req.url)) { texts.push({ auth: req.headers.authorization, ...Object.fromEntries(new URLSearchParams(raw)) }); return json(201, { sid: `SM${texts.length}` }); }
      json(404, { error: 'no route' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, emails, texts, reset() { emails.length = 0; texts.length = 0; }, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

// ------------------------------------------------------------------ units
describe('sendinfo: intent, addresses and messages', () => {
  test('detects "send me this" in many phrasings, and not ordinary questions', () => {
    for (const s of ['Can you send me this?', 'email me that', 'text me the info', 'send it to my phone', 'Can you text me?', 'Please send that to jo@example.com',
      'email me at jo@example.com', 'could you email me your return policy', 'Can you send me a copy?', 'send it', 'I would like this by email', 'text it to 905-555-0123',
      'can I get this emailed?']) assert.ok(detectSendIntent(s), s);
    for (const s of [Q, 'Do you send it to Canada?', 'Can I send my bike back?', 'Will you text me when my order ships?', 'Can you send me a brochure?', 'Do you email me the receipt automatically?', 'What is your email address?'])
      assert.equal(detectSendIntent(s), null, s);
    assert.equal(detectSendIntent('email me that').via, 'email');
    assert.equal(detectSendIntent('text me the info').via, 'text');
    assert.equal(detectSendIntent('send me this').via, null);
  });
  test('addresses: e-mail and E.164 (default country from the sending line), masked in replies', () => {
    assert.deepEqual(findContacts('reach me at Jo@Example.com please').emails, ['jo@example.com']);
    assert.deepEqual(findContacts('my cell is (905) 555-0123').phones, ['+19055550123']);
    assert.equal(normalizePhone('07700 900123', '+447700900000'), '+447700900123');
    assert.equal(normalizePhone('+44 7700 900123', LINE), null, 'texts stay in the sending line\'s country');
    assert.equal(normalizePhone('1-900-555-0123', LINE), null, 'never a premium-rate number');
    assert.equal(normalizePhone('555-0123', LINE), null);
    assert.equal(maskEmail('jo@example.com'), 'j***@example.com');
    assert.equal(emailFrom({}, 'Waterdown Village Chiropractic'), 'Waterdown Village Chiropractic <answers@knowbot.knowdrive.ai>');
    assert.equal(emailFrom({}, ''), 'KnowBot <answers@knowbot.knowdrive.ai>');
    assert.equal(emailFrom({ KNOWBOT_EMAIL_FROM: 'Answers <hi@mail.example>' }, 'Acme, Inc'), '"Acme, Inc" <hi@mail.example>');
    assert.ok(isStopWord('STOP') && isStopWord(' unsubscribe ') && !isStopWord('stop sending me texts about returns?'));
  });
  test('a stored answer in the old refusal wording (no flag, nothing cited) is still a refusal; the new one too', () => {
    for (const text of ["The answer to that doesn't seem to be in my files.", "Looks like we don't have that in our files."]) {
      assert.equal(normalizeAnswer({ question: 'q', text, citations: [] }).refused, true, text);
      assert.equal(normalizeAnswer({ question: 'q', answer: text }).refused, true, text);
    }
    assert.equal(normalizeAnswer({ question: 'q', answer: 'Open 9 to 5 [1].', citations: [{ n: 1, file: 'a.md' }] }).refused, false);
  });
  test('the text fits 3 segments with the bot\'s name, the proof link and the opt-out line; the e-mail has the answer, quotes, sources and proof', () => {
    const long = { ...ANSWER, answer: Array.from({ length: 10 }, (_, i) => `- Line ${i} says something useful about returns and refunds for every order. [1]`).join('\n') };
    for (const a of [ANSWER, long]) {
      const t = textMessage(normalizeAnswer(a), { botName: 'Waterdown Village Chiropractic', proofUrl: a.proofUrl });
      assert.ok(t.length <= TEXT_MAX, `${t.length}`);
      assert.ok(smsInfo(t).segments <= 3 && smsInfo(t).encoding === 'GSM-7', JSON.stringify(smsInfo(t)));
      assert.match(t, /^Waterdown Village Chiropractic:\n/);
      assert.match(t, /\nhttps:\/\/kb\.example\.test\/p\/abc123\n/, 'the proof link on its own line');
      assert.match(t, /Reply STOP to opt out\.$/);
      assert.doesNotMatch(t, /\[\d+\]|Good news/);
    }
    const m = emailMessage(normalizeAnswer(ANSWER), { botName: 'Front Desk', to: 'jo@example.com', proofUrl: ANSWER.proofUrl });
    assert.match(m.subject, /^Your answer from Front Desk: How many days/);
    for (const body of [m.text, m.html].map((x) => x.replace(/\s+/g, ' '))) { // the text part is wrapped at 72 columns
      assert.match(body, /within 30 days of delivery/);
      assert.match(body, /Returns Policy/);
      assert.match(body, /\/p\/abc123/);
      assert.match(body, /You asked Front Desk to send this to jo@example\.com/);
    }
  });
});

describe('sendinfo: the conversation seam (createSendInfo)', () => {
  const mk = (env = { RESEND_API_KEY: 're_test', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: LINE }) => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, body: init.body }); return new Response('{"id":"x"}', { status: 200 }); };
    return { si: createSendInfo({ env, fetchImpl, onSent: () => {} }), calls };
  };
  const base = { botId: 'front-desk', botName: 'Front Desk', channel: 'api' };
  test('asks for an address, re-asks on an invalid one, sends once on a valid one', async () => {
    const { si, calls } = mk();
    assert.equal(await si.maybeSendInfo({ ...base, key: 'k1', question: Q }), null, 'an ordinary question is answered normally');
    si.remember('k1', ANSWER);
    const a = await si.maybeSendInfo({ ...base, key: 'k1', question: 'Can you send me this?' });
    assert.equal(a.status, 'ask');
    assert.match(a.reply, /email address or mobile number/);
    const b = await si.maybeSendInfo({ ...base, key: 'k1', question: 'jo@example' });
    assert.equal(b.status, 'invalid');
    assert.equal(calls.length, 0);
    const c = await si.maybeSendInfo({ ...base, key: 'k1', question: 'jo@example.com' });
    assert.equal(c.status, 'sent');
    assert.equal(c.reply.startsWith('Sent to j***@example.com.'), true, c.reply);
    assert.equal(calls.length, 1);
    assert.equal(await si.maybeSendInfo({ ...base, key: 'k1', question: 'thanks, what about refunds?' }), null, 'the flow is over');
  });
  test('end-of-call send: the transcript and the sources for every answer (email), proof links (text)', async () => {
    const { si, calls } = mk();
    const A2 = { ...ANSWER, proofUrl: null, question: 'Do you ship to Canada?', answer: 'Yes, for a flat $25 [1].', citations: [{ n: 1, file: 'shipping.md', title: 'Shipping', excerpt: 'We ship to Canada for a flat $25.' }], proof: { quoted: [{ n: 1, text: 'We ship to Canada for a flat $25.' }] } };
    const transcript = [{ role: 'caller', text: Q }, { role: 'agent', text: 'You can return it within 30 days.' }, { role: 'caller', text: 'Do you ship to Canada?' }, { role: 'agent', text: 'Yes, for a flat $25.' }];
    const proofUrlFor = (a) => `https://kb.example.test/p/${/Canada/.test(a.question) ? 'ship1' : 'ret1'}`;
    const e = await si.send({ ...base, channel: 'phone', via: 'email', to: 'jo@example.com', answer: A2, answers: [{ ...ANSWER, proofUrl: null }, { ...ANSWER, refused: true }, A2], transcript, proofUrlFor });
    assert.equal(e.status, 'sent');
    assert.equal(e.scope, 'conversation');
    assert.match(e.reply, /transcript of our conversation and the sources/);
    const mail = JSON.parse(calls[0].body);
    assert.equal(mail.subject, 'Your call with Front Desk: How many days do I have to return an unused item? + 1 more');
    assert.match(mail.text, /Transcript\n=+\nYou: .*\nFront Desk: You can return it within 30 days\./);
    assert.match(mail.text, /1\. .*return/i);
    assert.match(mail.text, /2\. Do you ship to Canada\?/);
    assert.match(mail.text, /\/p\/ret1/);
    assert.match(mail.text, /\/p\/ship1/);
    assert.match(mail.html, />Transcript</);
    assert.ok(mail.html.indexOf('Do you ship to Canada?') < mail.html.indexOf('>Transcript<'), 'the answers come first, the transcript after');
    assert.equal((mail.text.match(/answers only from documents/g) || []).length, 1, 'said once, not after every answer');
    const t = await si.send({ ...base, channel: 'phone', via: 'text', to: '+1 415 555 0134', answer: A2, answers: [{ ...ANSWER, proofUrl: null }, A2], transcript, proofUrlFor, fromNumber: LINE });
    assert.equal(t.status, 'sent');
    const sms = new URLSearchParams(calls[1].body).get('Body');
    assert.match(sms, /^Front Desk: the answers from our call, with their sources\./);
    assert.match(sms, /\n1\) .*\nhttps:\/\/kb\.example\.test\/p\/ret1\n/);
    assert.match(sms, /\n2\) Do you ship to Canada\?\nhttps:\/\/kb\.example\.test\/p\/ship1\n/);
    assert.ok(sms.length <= TEXT_MAX);
    assert.match(sms, /Reply STOP to opt out\.$/);
  });
  test('nothing grounded yet: nothing is sent', async () => {
    const { si, calls } = mk();
    si.remember('k2', { ...ANSWER, refused: true });
    const r = await si.maybeSendInfo({ ...base, key: 'k2', question: 'email me that at jo@example.com' });
    assert.equal(r.status, 'nothing');
    assert.equal(r.reply, NOTHING);
    assert.equal(calls.length, 0);
  });
  test('one recipient per request; cancel; only the medium the server can send', async () => {
    const { si } = mk();
    si.remember('k3', ANSWER);
    assert.match((await si.maybeSendInfo({ ...base, key: 'k3', question: 'send it to jo@example.com and al@example.com' })).reply, /one address at a time/);
    assert.equal((await si.maybeSendInfo({ ...base, key: 'k3', question: 'never mind' })).status, 'cancelled');
    const mailOnly = mk({ RESEND_API_KEY: 're_test' }).si;
    mailOnly.remember('k4', ANSWER);
    assert.match((await mailOnly.maybeSendInfo({ ...base, key: 'k4', question: 'text me that' })).reply, /can't send texts from here, but I can email it/);
    const none = mk({}).si;
    none.remember('k5', ANSWER);
    assert.equal((await none.maybeSendInfo({ ...base, key: 'k5', question: 'text me that' })).status, 'unavailable');
    assert.equal(await none.maybeSendInfo({ ...base, key: 'k5', question: Q }), null);
  });
  test('a stateless client: the last question in its history is answered again and sent', async () => {
    const { si, calls } = mk();
    const asked = [];
    const r = await si.maybeSendInfo({ ...base, key: 'k6', question: 'email me that at jo@example.com', history: [{ role: 'user', content: Q }, { role: 'assistant', content: '30 days [1]' }],
      answerFor: async (q) => { asked.push(q); return ANSWER; } });
    assert.equal(r.status, 'sent');
    assert.deepEqual(asked, [Q]);
    assert.equal(calls.length, 1);
  });
});

describe('sendinfo: the phone tool (send_info)', () => {
  test('declared only when the line can send, with a prompt that confirms the address first', () => {
    assert.deepEqual(toolDeclarations({ org: 'Acme' })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'end_call']);
    assert.deepEqual(toolDeclarations({ org: 'Acme', sendInfo: { email: true, text: true } })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'send_info', 'end_call']);
    assert.deepEqual(toolDeclarations({ org: 'Acme', sendInfo: { email: false, text: false } })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'end_call']);
    assert.deepEqual(webToolDeclarations({ org: 'Acme', sendInfo: { email: true, text: false } })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'send_info']);
    const p = systemInstruction({ botName: 'Front Desk', org: 'Acme', sendInfo: { email: true, text: true, callerKnown: true } });
    assert.match(p, /I can text that to the number you're calling from/);
    assert.match(p, /spell it back to them and get a yes/);
    assert.match(p, /Only after they confirm, call send_info/);
    assert.doesNotMatch(systemInstruction({ botName: 'Front Desk', org: 'Acme' }), /send_info/);
    assert.doesNotMatch(p, /Twilio|Resend|Gemini|Google|Meta\b/);
  });
  test('texts the last answer to the caller\'s own number by default, or to an e-mail they confirmed', async () => {
    const calls = [];
    const si = createSendInfo({ env: { RESEND_API_KEY: 're_test', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: LINE }, onSent: () => {},
      fetchImpl: async (url, init) => { calls.push({ url: String(url), body: String(init.body) }); return new Response('{}', { status: 200 }); } });
    const run = createToolRunner({ ask: async () => ANSWER, callSid: 'CA1', callerNumber: '+14155550199',
      sendInfo: ({ via, to, answer }) => si.send({ botId: 'front-desk', botName: 'Front Desk', channel: 'phone', via, to, answer, callerKey: '+14155550199' }) });
    assert.equal((await run({ name: 'send_info', args: { channel: 'text' } })).status, 'nothing_to_send');
    await run({ name: 'search_knowledge_base', args: { query: Q } });
    // read back before anything is sent (U2): the first call returns what to say; only the confirmed one sends
    const rb = await run({ name: 'send_info', args: { channel: 'text' } });
    assert.equal(rb.status, 'confirm_first');
    assert.equal(rb.read_back, 'the number ending in zero one nine nine');
    assert.equal(calls.length, 0, 'nothing sent before the read-back is confirmed');
    const t = await run({ name: 'send_info', args: { channel: 'text', confirmed: true } });
    assert.deepEqual(t, { status: 'ok', sent_by: 'text', sent_to_last_four: '0199' });
    assert.match(calls[0].url, /Messages\.json$/);
    assert.equal(new URLSearchParams(calls[0].body).get('To'), '+14155550199');
    // confirmed:true for an address that was never read back still gets the read-back first
    const e0 = await run({ name: 'send_info', args: { channel: 'email', to: 'jo@example.com', confirmed: true } });
    assert.equal(e0.status, 'confirm_first');
    assert.equal(e0.read_back, 'j o, at e x a m p l e, dot, c o m');
    const e = await run({ name: 'send_info', args: { channel: 'email', to: 'jo@example.com', confirmed: true } });
    assert.equal(e.status, 'ok');
    assert.match(calls[1].url, /\/emails$/);
    assert.equal((await run({ name: 'send_info', args: { channel: 'email', to: 'jo at example' } })).status, 'invalid');
    assert.equal(calls.length, 2);
  });
});

// ------------------------------------------------------------------ through the server
describe('sendinfo: every surface through the server (fake mail + texting APIs)', () => {
  let kd, llm, F, kb, base, dataDir, key;
  const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
  const api = (p, init = {}) => fetch(base + p, init);
  const chat = (question, user, extra = {}) => api('/v1/bots/front-desk/chat', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question, user, ...extra }) }).then((r) => r.json());
  const twilio = (p, params) => api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('twilio-secret', PUBLIC + p, params) }, body: new URLSearchParams(params).toString() });
  const message = (x) => /<Message>([\s\S]*?)<\/Message>/.exec(x)?.[1]?.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"');
  before(async () => {
    _resetQuestions();
    kd = await startFakeKnowDrive({ speed: 20 });
    llm = await startFakeLLM({ slowMs: 9000 });
    F = await startFakeSenders();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sendinfo-'));
    kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, env: {
      KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
      KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_PUBLIC_URL: PUBLIC,
      RESEND_API_KEY: 're_fake', RESEND_BASE_URL: F.url, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_FROM_NUMBER: LINE, TWILIO_API_BASE_URL: F.url,
      EMAIL_WEBHOOK_SECRET: 'mail-secret',
    }, studio: { sweep: false } });
    await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${kb.server.address().port}`;
    await kb.registry.ready;
    assert.equal((await api('/api/buckets', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Acme' }) })).status, 201);
    assert.equal((await api('/api/buckets/acme/files', { method: 'POST', headers: { authorization: 'Bearer dev-admin', 'content-type': 'text/markdown', 'x-filename': 'returns-policy.md' }, body: DOC })).status, 201);
    assert.equal((await api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Front Desk', buckets: ['acme'] }) })).status, 201);
    await kd.settle();
    key = (await (await api('/api/instances/front-desk/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'sendinfo' }) })).json()).key;
  });
  after(async () => { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await F.close(); await fsp.rm(dataDir, { recursive: true, force: true }); });

  test('API chat: intent → asks; an e-mail → ONE mail with the right from/to/subject and the answer, sources and proof link', async () => {
    F.reset();
    const a = await chat(Q, 'u1');
    assert.equal(a.refused, false);
    const ask = await chat('Can you send me this?', 'u1');
    assert.equal(ask.sendInfo.status, 'ask');
    assert.match(ask.answer, /email address or mobile number/);
    assert.deepEqual(ask.citations, []);
    const bad = await chat('jo@example', 'u1');
    assert.equal(bad.sendInfo.status, 'invalid');
    assert.equal(F.emails.length + F.texts.length, 0);
    const sent = await chat('jo@example.com', 'u1');
    assert.equal(sent.sendInfo.status, 'sent');
    assert.equal(sent.answer.startsWith('Sent to j***@example.com.'), true);
    assert.doesNotMatch(JSON.stringify(sent), /jo@example\.com/, 'the address is masked in the reply');
    assert.equal(F.emails.length, 1);
    const m = F.emails[0];
    assert.equal(m.auth, 'Bearer re_fake');
    assert.equal(m.body.from, 'Front Desk <answers@knowbot.knowdrive.ai>');
    assert.deepEqual(m.body.to, ['jo@example.com']);
    assert.ok(!('reply_to' in m.body), 'no Reply-To unless the owner set one');
    assert.match(m.body.subject, /^Your answer from Front Desk: How many days/);
    for (const body of [m.body.html, m.body.text].map((x) => x.replace(/\s+/g, ' '))) {
      assert.match(body, /30 days/);
      assert.match(body, /Returns Policy/);
      assert.match(body, /https:\/\/kb\.example\.test\/r\/[A-Za-z0-9]+/, 'the proof link is a tracked short link');
    }
    const short = /https:\/\/kb\.example\.test(\/r\/[A-Za-z0-9]+)/.exec(m.body.text)[1];
    const hop = await api(short, { redirect: 'manual' });
    assert.equal(hop.status, 302);
    const to = new URL(hop.headers.get('location'));
    assert.match(to.pathname, /^\/p\/[A-Za-z0-9_-]+$/);
    assert.deepEqual([to.searchParams.get('utm_source'), to.searchParams.get('utm_medium'), to.searchParams.get('utm_campaign'), to.searchParams.get('utm_content')], ['knowbot', 'webchat', 'front-desk', 'proof_email']);
    assert.equal((await api(to.pathname + to.search)).status, 200, 'the proof link resolves');
  });
  test('API chat: a mobile number in the same message → ONE text (≤ 3 segments, proof link, STOP line); a refused answer is never sent', async () => {
    F.reset();
    await chat(Q, 'u2');
    const r = await chat('text me that at (415) 555-0123', 'u2');
    assert.equal(r.sendInfo.status, 'sent');
    assert.match(r.answer, /ending in 0123/);
    assert.equal(F.texts.length, 1);
    assert.equal(F.texts[0].To, '+14155550123');
    assert.equal(F.texts[0].From, LINE);
    assert.ok(smsInfo(F.texts[0].Body).segments <= 3);
    assert.match(F.texts[0].Body, /^Front Desk:\n/);
    assert.match(F.texts[0].Body, /\nhttps:\/\/kb\.example\.test\/r\/[A-Za-z0-9]+\n/);
    assert.match(F.texts[0].Body, /Reply STOP to opt out\.$/);
    F.reset();
    const off = await chat(OFF, 'u3');
    assert.equal(off.refused, true);
    const none = await chat('email me that at jo@example.com', 'u3');
    assert.equal(none.sendInfo.status, 'nothing');
    assert.equal(F.emails.length + F.texts.length, 0);
  });
  test('rate limit: 5 sends per caller per hour', async () => {
    F.reset();
    await chat(Q, 'u4');
    for (let i = 0; i < 5; i++) assert.equal((await chat(`email me that at r${i}@example.com`, 'u4')).sendInfo.status, 'sent');
    const sixth = await chat('email me that at r9@example.com', 'u4');
    assert.equal(sixth.sendInfo.status, 'limited');
    assert.equal(F.emails.length, 5);
  });
  test('SMS: "email me that" → asks for an address → sends and confirms; STOP is honoured for later texts', async () => {
    F.reset();
    const p = '/v1/channels/front-desk/sms';
    const from = '+14155550177';
    assert.match(message(await (await twilio(p, { From: from, To: LINE, Body: Q })).text()), /30 days/);
    const ask = message(await (await twilio(p, { From: from, To: LINE, Body: 'can you email me that?' })).text());
    assert.match(ask, /What email address should I send it to\?/);
    const done = message(await (await twilio(p, { From: from, To: LINE, Body: 'sam@example.com' })).text());
    assert.match(done, /^Sent to s\*\*\*@example\.com\./);
    assert.equal(F.emails.length, 1);
    assert.deepEqual(F.emails[0].body.to, ['sam@example.com']);
    // STOP: no reply of ours, and the number is never texted again
    const stop = await (await twilio(p, { From: from, To: LINE, Body: 'STOP' })).text();
    assert.equal(message(stop), undefined);
    await chat(Q, 'u5');
    const blocked = await chat('text me that at 415-555-0177', 'u5');
    assert.equal(blocked.sendInfo.status, 'opted_out');
    assert.equal(F.texts.length, 0);
    const saved = JSON.parse(await fsp.readFile(path.join(dataDir, 'sendinfo-stops.json'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(saved), /4155550177/, 'the opt-out list keeps hashes, not numbers');
  });
  test('WhatsApp: "text me this" says it is already here; another number gets the text', async () => {
    F.reset();
    const p = '/v1/channels/front-desk/whatsapp';
    const from = 'whatsapp:+14155550188';
    assert.match(message(await (await twilio(p, { From: from, To: 'whatsapp:+15550001111', Body: Q })).text()), /30 days/);
    assert.match(message(await (await twilio(p, { From: from, To: 'whatsapp:+15550001111', Body: 'text me this' })).text()), /right here in this conversation/);
    const sent = message(await (await twilio(p, { From: from, To: 'whatsapp:+15550001111', Body: '415-555-0144' })).text());
    assert.match(sent, /^Sent to the number ending in 0144/);
    assert.equal(F.texts.length, 1);
    assert.equal(F.texts[0].To, '+14155550144');
  });
  test('e-mail channel: "send it to my other address" sends there; the reply confirms', async () => {
    F.reset();
    const p = '/v1/channels/front-desk/email?key=mail-secret';
    const mail = (text) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ From: 'Ann <ann@example.com>', FromFull: { Email: 'ann@example.com' }, Subject: 'Returns', TextBody: text, Headers: [] }) }).then((r) => r.json());
    assert.equal((await mail(Q)).refused, false);
    const r = await mail('Please send that to my other address ann.work@example.org');
    assert.equal(r.sendInfo.status, 'sent');
    assert.match(r.reply.text, /^Sent to a\*\*\*@example\.org\./);
    assert.equal(F.emails.length, 1);
    assert.deepEqual(F.emails[0].body.to, ['ann.work@example.org']);
    const here = await mail('can you email me that?');
    assert.equal(here.sendInfo.status, 'here');
    assert.match(here.reply.text, /already come to you by email at a\*\*\*@example\.com/);
  });
  test('preview endpoint: the SMS shape shows the flow', async () => {
    F.reset();
    const pv = (question) => api('/v1/bots/front-desk/preview', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms', question }) }).then((r) => r.json());
    assert.match((await pv(Q)).text, /30 days/);
    const ask = await pv('can you send me this?');
    assert.equal(ask.sendInfo.status, 'here');
    const sent = await pv('ok send it to pat@example.com');
    assert.equal(sent.sendInfo.status, 'sent');
    assert.match(sent.text, /^Sent to p\*\*\*@example\.com\./);
    assert.equal(F.emails.length, 1);
  });
  test('Studio chat: a grounded answer, then "email me that" → asks → an address → sent (final status send_info, never a question)', async () => {
    F.reset();
    const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);
    const r0 = await api('/api/studio/trials', { method: 'POST' });
    assert.equal(r0.status, 201);
    const t = await r0.json();
    const H = { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
    const T = (p) => `/api/studio/trials/${t.trialId}${p}`;
    assert.equal((await api(T('/samples'), { method: 'POST', headers: H, body: JSON.stringify({ set: 'lumen-bikes' }) })).status, 201);
    for (let i = 0; i < 400; i++) {
      const j = await (await api(T('/files'), { headers: H })).json();
      if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const ask = async (question) => sse(await (await api(T('/ask'), { method: 'POST', headers: H, body: JSON.stringify({ question }) })).text()).find((e) => e.event === 'final').data;
    const g = await ask('How long is the frame warranty?');
    assert.equal(g.status, 'grounded');
    const a = await ask('can you email me that?');
    assert.equal(a.status, 'send_info');
    assert.equal(a.sendInfo.status, 'ask');
    assert.match(a.text, /What email address should I send it to\?/);
    const s = await ask('lee@example.com');
    assert.equal(s.sendInfo.status, 'sent');
    assert.match(s.text, /^Sent to l\*\*\*@example\.com\./);
    assert.equal(F.emails.length, 1);
    assert.match(F.emails[0].body.from, /^Lumen Help <answers@knowbot\.knowdrive\.ai>$/);
    assert.match(F.emails[0].body.text, /warranty/i);
    assert.match(F.emails[0].body.text, /https:\/\/kb\.example\.test\/r\/[A-Za-z0-9]+/);
  });
  test('channel status says which media can be sent', async () => {
    const j = await (await api('/v1/channels/front-desk')).json();
    assert.deepEqual(j.sendInfo, { email: true, text: true });
  });
  test('insights count sends without storing any address', async () => {
    await flushQuestions();
    const ins = await (await api('/api/instances/front-desk/insights?limit=50', { headers: { authorization: 'Bearer dev-admin' } })).json();
    assert.ok(ins.sends.total >= 10, JSON.stringify(ins.sends));
    assert.ok(ins.sends.email >= 1 && ins.sends.text >= 1);
    assert.doesNotMatch(JSON.stringify(ins), /@example\.(?:com|org)|4155550/);
    assert.ok(!ins.top.some((t) => /send me this|email me that/i.test(t.q)), 'a send request is not a customer question');
  });
});

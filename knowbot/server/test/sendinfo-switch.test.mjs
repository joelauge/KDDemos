// "Send me this" as a per-bot switch (spec.sendInfo: {on, email, text}; server/sendinfo.mjs): default on for every bot,
// validated like any spec field, carried to a launched bot, and enforced on every surface (Studio ask, /v1 chat, /web,
// SMS, WhatsApp, e-mail, web voice). When off, a "text me that" gets a plain "this bot doesn't send messages" reply
// (never the refusal line), nothing is sent and no lead is recorded. FAKES only (127.0.0.1): no real credentials.
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
import { _resetQuestions } from '../questions.mjs';
import { twilioSignature, NOT_IN_DATA } from '../channels/util.mjs';
import { createLeads } from '../leads.mjs';
import { systemInstruction, toolDeclarations, greetingFor, sendInfoInstruction } from '../channels/voice-live.mjs';
import { webSystemInstruction, webToolDeclarations } from '../channels/webvoice.mjs';
import { createSendInfo, sendInfoSwitches, sendInfoAllow, sendInfoMedia, cleanSendInfo, OFF_REPLY } from '../sendinfo.mjs';
import { validatePatch, defaultSpec, parseIntent, sendInfoIntentOf } from '../trials.mjs';
import { createBuilderTools } from '../builder/tools.mjs';
import { sendInfoSwitches as clientSwitches, SEND_INFO_HELP } from '../../studio/surfaces.js';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = 'https://kb.example.test';
const LINE = '+14155550100';
const DOC = `# Returns Policy

You can return any unused item within 30 days of delivery for a full refund.
`;
const Q = 'How many days do I have to return an unused item?';
const ANSWER = {
  question: Q, refused: false, answer: 'You can return any unused item within 30 days of delivery for a full refund. [1]',
  citations: [{ n: 1, file: 'returns-policy.md', title: 'Returns Policy', excerpt: 'You can return any unused item within 30 days of delivery for a full refund.' }],
  proof: { quoted: [{ n: 1, text: 'You can return any unused item within 30 days of delivery for a full refund.' }] }, proofUrl: `${PUBLIC}/p/abc123`,
};
const ALL = { RESEND_API_KEY: 're_test', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: LINE };

async function startFakeSenders() {
  const emails = [], texts = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/emails') { emails.push(JSON.parse(raw)); return json(200, { id: `em_${emails.length}` }); }
      if (/Messages\.json$/.test(req.url)) { texts.push(Object.fromEntries(new URLSearchParams(raw))); return json(201, { sid: `SM${texts.length}` }); }
      json(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, emails, texts, reset() { emails.length = 0; texts.length = 0; }, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

// ------------------------------------------------------------------ units
describe('sendinfo switch: the setting', () => {
  test('default on (absent, empty, partial), the same on the server and in the Studio', () => {
    for (const v of [undefined, null, {}, 'junk', [], { email: true }]) assert.deepEqual(sendInfoSwitches(v), { on: true, email: true, text: true });
    assert.deepEqual(sendInfoSwitches({ on: false }), { on: false, email: true, text: true });
    assert.deepEqual(sendInfoAllow({ on: false }), { email: false, text: false });
    assert.deepEqual(sendInfoAllow({ text: false }), { email: true, text: false });
    for (const v of [undefined, { on: false }, { email: false }, { text: false, on: true }]) assert.deepEqual(clientSwitches(v), sendInfoSwitches(v));
    assert.equal(SEND_INFO_HELP, 'Visitors can ask the bot to text or email them an answer and its sources. Each request adds them to Stats & Leads.');
    assert.throws(() => cleanSendInfo({ on: 'no' }), /on must be true or false/);
    assert.throws(() => cleanSendInfo({ fax: true }), /unknown setting/);
    assert.throws(() => cleanSendInfo([true]), /must be/);
  });
  test('effective media = the server AND the bot switch', () => {
    assert.deepEqual(sendInfoMedia(ALL, '', { email: false, text: true }), { email: false, text: true });
    assert.deepEqual(sendInfoMedia({ RESEND_API_KEY: 'x' }, '', { email: true, text: true }), { email: true, text: false }, 'the bot cannot switch on what the server cannot send');
    assert.deepEqual(sendInfoMedia(ALL, ''), { email: true, text: true }, 'no switch = the server alone (today)');
  });
  test('spec patch validation: booleans only, merged onto the current value, not material, default-on bots unchanged', () => {
    const spec = defaultSpec(0.7);
    assert.equal(spec.sendInfo, undefined, 'a new bot has no stored switch: on');
    const r = validatePatch({ sendInfo: { text: false } }, spec);
    assert.deepEqual(r.next.sendInfo, { on: true, email: true, text: false });
    assert.deepEqual(r.diff.map((d) => d.field), ['sendInfo']);
    assert.equal(r.material, false);
    assert.equal(r.next.version, spec.version, 'the answers never change with it');
    const r2 = validatePatch({ sendInfo: { on: false } }, r.next);
    assert.deepEqual(r2.next.sendInfo, { on: false, email: true, text: false }, 'the media switches are kept under the main switch');
    assert.deepEqual(validatePatch({ sendInfo: { on: true } }, spec).diff, [], 'switching on an existing (default) bot is no change');
    for (const bad of [{ sendInfo: true }, { sendInfo: { on: 1 } }, { sendInfo: { sms: false } }, { sendInfo: [] }]) {
      assert.throws(() => validatePatch(bad, spec), (e) => e.status === 400 && /sendInfo/.test(e.message), JSON.stringify(bad));
    }
  });
  test('the Builder: "turn off texting answers" switches texting, never the SMS feature; the tool engine has the same switch', async () => {
    assert.deepEqual(sendInfoIntentOf('turn off texting answers'), { text: false });
    assert.deepEqual(sendInfoIntentOf('stop emailing answers to visitors'), { email: false });
    assert.deepEqual(sendInfoIntentOf('turn off send me this'), { on: false });
    assert.deepEqual(sendInfoIntentOf('turn send-me-this back on'), { on: true, email: true, text: true });
    assert.equal(sendInfoIntentOf('drop SMS'), null);
    assert.equal(sendInfoIntentOf('can you text me that?'), null, 'no on/off verb: not a settings change');
    const p = parseIntent('turn off texting answers', { spec: { surfaces: ['webchat', 'sms'] } });
    assert.deepEqual(p.patch, { sendInfo: { text: false } });
    assert.ok(p.intents.includes('send_info') && !p.intents.includes('surfaces'));
    for (const tools of [createBuilderTools({ validatePatch }), createBuilderTools()]) { // the real validation, and the tools' own mirror
      const t = await tools.run('update_bot', { send_info: { text: false } }, { spec: defaultSpec(0.7), files: [] });
      assert.equal(t.ok, true, JSON.stringify(t));
      assert.deepEqual(t.patch, { sendInfo: { text: false } });
      assert.deepEqual(t.data.changed, ['sendInfo']);
    }
  });
});

describe('sendinfo switch: the conversation seam', () => {
  const mk = () => {
    const calls = [], leads = [];
    const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: String(init.body) }); return new Response('{"id":"x"}', { status: 200 }); };
    return { si: createSendInfo({ env: ALL, fetchImpl, onSent: () => {}, onLead: (e) => leads.push(e) }), calls, leads };
  };
  const base = { botId: 'b', botName: 'Front Desk', channel: 'api' };
  test('on (no switch, or all on): asks, then sends and records a lead', async () => {
    for (const allow of [null, { email: true, text: true }]) {
      const { si, calls, leads } = mk();
      si.remember('k', ANSWER);
      const a = await si.maybeSendInfo({ ...base, key: 'k', question: 'Can you send me this?', allow });
      assert.equal(a.status, 'ask');
      assert.match(a.reply, /email address or mobile number/);
      assert.equal((await si.maybeSendInfo({ ...base, key: 'k', question: 'jo@example.com', allow })).status, 'sent');
      assert.equal(calls.length, 1);
      assert.equal(leads.length, 1);
    }
  });
  test('off: a plain "doesn\'t send messages" reply, even with an address given; nothing sent, no lead, never the refusal line', async () => {
    const { si, calls, leads } = mk();
    const allow = sendInfoAllow({ on: false });
    si.remember('k', ANSWER);
    for (const q of ['text me that', 'Can you email me that?', 'email me that at jo@example.com', 'send it to 415 555 0123']) {
      const r = await si.maybeSendInfo({ ...base, key: 'k', question: q, allow });
      assert.equal(r.status, 'off', q);
      assert.equal(r.reply, OFF_REPLY);
      assert.notEqual(r.reply, NOT_IN_DATA);
    }
    assert.equal(await si.maybeSendInfo({ ...base, key: 'k', question: 'jo@example.com', allow }), null, 'no pending request: an address alone is just a message');
    assert.equal(await si.maybeSendInfo({ ...base, key: 'k', question: Q, allow }), null, 'questions are answered as usual');
    const s = await si.send({ ...base, channel: 'phone', via: 'text', to: '+14155550123', answer: ANSWER, allow });
    assert.equal(s.status, 'off');
    assert.equal(calls.length, 0);
    assert.equal(leads.length, 0);
  });
  test('email only: "text me that" offers email; the address is then sent by email; a number is never texted', async () => {
    const { si, calls, leads } = mk();
    const allow = sendInfoAllow({ text: false });
    si.remember('k', ANSWER);
    const r = await si.maybeSendInfo({ ...base, key: 'k', question: 'text me that', allow });
    assert.equal(r.status, 'off');
    assert.equal(r.reply, "This bot doesn't send texts, but I can email it to you. What email address should I use?");
    const sent = await si.maybeSendInfo({ ...base, key: 'k', question: 'jo@example.com', allow });
    assert.equal(sent.status, 'sent');
    assert.match(calls[0].url, /\/emails$/);
    const num = await si.maybeSendInfo({ ...base, key: 'k', question: 'text me that at 415 555 0123', allow });
    assert.equal(num.status, 'off');
    assert.equal((await si.maybeSendInfo({ ...base, key: 'k2', question: 'Send me this', allow, lastAnswer: ANSWER })).reply, 'Sure. What email address should I send it to?');
    assert.equal((await si.send({ ...base, via: 'text', to: '+14155550123', answer: ANSWER, allow })).status, 'off');
    assert.equal(calls.length, 1);
    assert.equal(leads.length, 1);
  });
  test('text only: "email me that" offers a text; the number is then texted', async () => {
    const { si, calls } = mk();
    const allow = sendInfoAllow({ email: false });
    si.remember('k', ANSWER);
    const r = await si.maybeSendInfo({ ...base, key: 'k', question: 'email me that', allow });
    assert.equal(r.reply, "This bot doesn't send email, but I can text it to you. What mobile number should I use?");
    const sent = await si.maybeSendInfo({ ...base, key: 'k', question: '415 555 0123', allow });
    assert.equal(sent.status, 'sent');
    assert.match(calls[0].url, /Messages\.json$/);
    assert.equal((await si.maybeSendInfo({ ...base, key: 'k', question: 'email me that at jo@example.com', allow })).status, 'off');
    assert.equal(calls.length, 1);
  });
  test('voice prompts: off = no send_info tool, no offer in the greeting, and a plain "doesn\'t send messages" line', () => {
    const off = { email: false, text: false, off: true };
    assert.deepEqual(toolDeclarations({ org: 'Acme', sendInfo: off })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'end_call']);
    assert.deepEqual(webToolDeclarations({ org: 'Acme', sendInfo: off })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base']);
    for (const p of [systemInstruction({ botName: 'Front Desk', org: 'Acme', sendInfo: off }), webSystemInstruction({ botName: 'Front Desk', org: 'Acme', sendInfo: off })]) {
      assert.match(p, /This bot doesn't send messages/);
      assert.match(p, /never use the "not in my files" line for it/);
      assert.doesNotMatch(p, /send_info|send you the sources/);
    }
    assert.doesNotMatch(greetingFor('Front Desk', { offerSources: false }), /sources/);
    assert.equal(sendInfoInstruction({ email: false, text: false }), '', 'the server cannot send: nothing said, as before');
    assert.match(sendInfoInstruction({ email: true, text: false }), /Texts aren't available here; offer an email instead/);
  });
});

// ------------------------------------------------------------------ through the server
describe('sendinfo switch: every surface through the server', () => {
  let kd, llm, F, kb, base, dataDir, key, leads;
  const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
  const api = (p, init = {}) => fetch(base + p, init);
  const setBot = async (sendInfo) => { const r = await api('/api/instances/front-desk', { method: 'PATCH', headers: admin, body: JSON.stringify({ sendInfo }) }); assert.equal(r.status, 200); return r.json(); };
  const chat = (question, user) => api('/v1/bots/front-desk/chat', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question, user }) }).then((r) => r.json());
  const web = (question, user) => api('/v1/bots/front-desk/web', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, user }) }).then((r) => r.json());
  const twilio = (p, params) => api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('twilio-secret', PUBLIC + p, params) }, body: new URLSearchParams(params).toString() });
  const message = (x) => /<Message>([\s\S]*?)<\/Message>/.exec(x)?.[1]?.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"');
  const sendLeads = async (bot = 'front-desk') => (await leads.report(bot, { days: 7 })).leads.filter((l) => l.consent === 'asked_to_send');
  const voiceText = (text) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/bots/front-desk/voice/live`);
    const got = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error(`timed out: ${JSON.stringify(got)}`)); }, 15000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start' })));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      got.push(m);
      if (m.type === 'ready') ws.send(JSON.stringify({ type: 'text', text }));
      if (m.type === 'answer' || m.type === 'error') { clearTimeout(timer); ws.close(); resolve(got); }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket failed')); });
  });
  before(async () => {
    _resetQuestions();
    kd = await startFakeKnowDrive({ speed: 20 });
    llm = await startFakeLLM({ slowMs: 9000 });
    F = await startFakeSenders();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sendinfo-switch-'));
    leads = createLeads({ dataDir, log: () => {} });
    kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, leads, env: {
      KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live', KNOWBOT_KD_ACCOUNTS: 'off',
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
    key = (await (await api('/api/instances/front-desk/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'switch' }) })).json()).key;
  });
  after(async () => { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await F.close(); await fsp.rm(dataDir, { recursive: true, force: true }); });

  test('an existing bot (no setting) keeps sending; the launched bot\'s setting is validated and stored', async () => {
    assert.equal((await (await api('/api/instances/front-desk', { headers: admin })).json()).sendInfo, undefined);
    assert.deepEqual((await (await api('/v1/channels/front-desk')).json()).sendInfo, { email: true, text: true });
    await chat(Q, 'u0');
    assert.equal((await chat('Can you send me this?', 'u0')).sendInfo.status, 'ask');
    const bad = await api('/api/instances/front-desk', { method: 'PATCH', headers: admin, body: JSON.stringify({ sendInfo: { on: 'off' } }) });
    assert.equal(bad.status, 400);
    assert.deepEqual((await setBot({ text: false })).sendInfo, { on: true, email: true, text: false });
    assert.deepEqual((await (await api('/v1/channels/front-desk')).json()).sendInfo, { email: true, text: false });
  });

  test('off: /v1 chat, /web, SMS, WhatsApp and e-mail all say the bot doesn\'t send messages; nothing sent, no lead', async () => {
    F.reset();
    await setBot({ on: false });
    assert.deepEqual((await (await api('/v1/channels/front-desk')).json()).sendInfo, { email: false, text: false });
    const before = (await sendLeads()).length;
    // /v1 chat (the developer API)
    assert.match((await chat(Q, 'u1')).answer, /30 days/);
    for (const q of ['Can you email me that?', 'text me that at (415) 555-0123']) {
      const r = await chat(q, 'u1');
      assert.equal(r.sendInfo.status, 'off', q);
      assert.equal(r.answer, OFF_REPLY);
      assert.equal(r.refused, false);
    }
    // /web (the chat bubble)
    assert.match((await web(Q, 'v1')).answer, /30 days/);
    const w = await web('email me that at jo@example.com', 'v1');
    assert.equal(w.sendInfo.status, 'off');
    assert.equal(w.answer, OFF_REPLY);
    // SMS
    const from = '+14155550177';
    assert.match(message(await (await twilio('/v1/channels/front-desk/sms', { From: from, To: LINE, Body: Q })).text()), /30 days/);
    assert.equal(message(await (await twilio('/v1/channels/front-desk/sms', { From: from, To: LINE, Body: 'can you email me that?' })).text()), OFF_REPLY);
    // WhatsApp
    const wa = 'whatsapp:+14155550188';
    assert.match(message(await (await twilio('/v1/channels/front-desk/whatsapp', { From: wa, To: 'whatsapp:+15550001111', Body: Q })).text()), /30 days/);
    assert.equal(message(await (await twilio('/v1/channels/front-desk/whatsapp', { From: wa, To: 'whatsapp:+15550001111', Body: 'send it to 415-555-0144' })).text()), OFF_REPLY);
    // e-mail
    const mail = (text) => api('/v1/channels/front-desk/email?key=mail-secret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ From: 'Ann <ann@example.com>', FromFull: { Email: 'ann@example.com' }, Subject: 'Returns', TextBody: text, Headers: [] }) }).then((r) => r.json());
    assert.equal((await mail(Q)).refused, false);
    F.reset(); // the e-mail channel's own reply went out by mail: only "send me this" sends count from here
    const m = await mail('Please send that to my other address ann.work@example.org');
    assert.equal(m.sendInfo.status, 'off');
    assert.match(m.reply.text, /^This bot doesn't send messages/);
    assert.ok(!F.emails.some((e) => (e.to || []).includes('ann.work@example.org')), 'never sent to the other address');
    assert.equal(F.texts.length, 0);
    assert.equal((await sendLeads()).length, before, 'no lead recorded');
  });

  test('off: web voice (text engine) says it plainly, and the greeting never offers to send', async () => {
    await setBot({ on: false });
    const got = await voiceText('Can you text me that?');
    assert.doesNotMatch(got.find((m) => m.type === 'ready').greeting, /send you the sources/);
    const a = got.find((m) => m.type === 'answer');
    assert.equal(a.sendInfo.status, 'off');
    assert.equal(a.text, OFF_REPLY);
    await setBot({ on: true, email: true, text: true });
    assert.match((await voiceText('Hello')).find((m) => m.type === 'ready').greeting, /send you the sources/, 'back on: the greeting offers again');
  });

  test('email only / text only: the other medium is offered and used; the switched-off one never sends', async () => {
    F.reset();
    await setBot({ on: true, email: true, text: false });
    await chat(Q, 'u2');
    const r = await chat('text me that', 'u2');
    assert.equal(r.sendInfo.status, 'off');
    assert.match(r.answer, /doesn't send texts, but I can email it/);
    assert.equal((await chat('jo@example.com', 'u2')).sendInfo.status, 'sent');
    assert.equal(F.emails.length, 1);
    assert.equal(F.texts.length, 0);
    await setBot({ on: true, email: false, text: true });
    await chat(Q, 'u3');
    assert.match((await chat('email me that', 'u3')).answer, /doesn't send email, but I can text it/);
    assert.equal((await chat('415 555 0123', 'u3')).sendInfo.status, 'sent');
    assert.equal(F.texts.length, 1);
    assert.equal(F.emails.length, 1);
    assert.equal((await sendLeads()).length >= 2, true, 'each send is a lead');
    await setBot({ on: true, email: true, text: true });
  });

  test('Studio ask: on asks; off replies plainly (status send_info / off), no send, no lead; convert carries the setting to the launched bot', async () => {
    F.reset();
    const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);
    const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
    const H = { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' };
    const T = (p) => `/api/studio/trials/${t.trialId}${p}`;
    assert.equal((await api(T('/samples'), { method: 'POST', headers: H, body: JSON.stringify({ set: 'lumen-bikes' }) })).status, 201);
    for (let i = 0; i < 400; i++) {
      const j = await (await api(T('/files'), { headers: H })).json();
      if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const ask = async (question) => sse(await (await api(T('/ask'), { method: 'POST', headers: H, body: JSON.stringify({ question }) })).text()).find((e) => e.event === 'final').data;
    assert.equal((await ask('How long is the frame warranty?')).status, 'grounded');
    assert.equal((await ask('can you email me that?')).sendInfo.status, 'ask', 'a new bot sends by default');
    assert.equal((await ask('never mind')).sendInfo.status, 'cancelled');
    // the devkey tells the Studio what this server can send (the Set up switches)
    const dk = await (await api(T('/devkey'), { headers: H })).json();
    assert.deepEqual(dk.sendInfo, { server: { email: true, text: true } });
    // the Builder: "turn off texting answers" switches texting only (never the SMS feature), and says so
    const turn = sse(await (await api(T('/setup'), { method: 'POST', headers: H, body: JSON.stringify({ message: 'turn off texting answers' }) })).text());
    const said = turn.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.match(said, /texting answers is off/, said);
    assert.deepEqual(turn.find((e) => e.event === 'patch')?.data.spec.sendInfo, { on: true, email: true, text: false });
    assert.deepEqual(turn.find((e) => e.event === 'patch')?.data.spec.surfaces || ['webchat'], ['webchat']);
    assert.match((await ask('text me that')).text, /doesn't send texts, but I can email it/);
    const p = await api(T(''), { method: 'PATCH', headers: H, body: JSON.stringify({ sendInfo: { on: false } }) });
    assert.equal(p.status, 200);
    const pj = await p.json();
    assert.deepEqual(pj.spec.sendInfo, { on: false, email: true, text: false });
    assert.deepEqual(pj.diff.map((d) => d.field), ['sendInfo']);
    const off = await ask('email me that at lee@example.com');
    assert.equal(off.status, 'send_info');
    assert.equal(off.sendInfo.status, 'off');
    assert.equal(off.text, OFF_REPLY);
    assert.equal(F.emails.length + F.texts.length, 0);
    assert.equal((await sendLeads(t.trialId)).length, 0);
    // the trial's own /v1 surfaces follow its spec too
    assert.deepEqual((await (await api(`/v1/channels/${t.trialId}`)).json()).sendInfo, { email: false, text: false });
    // launch: the launched bot keeps the owner's switch
    assert.equal((await api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Lumen Live', buckets: ['acme'] }) })).status, 201);
    const conv = await api(T('/convert'), { method: 'POST', headers: admin, body: JSON.stringify({ account: 'acct1', bucketId: 'lumenb', bot: 'lumen-live' }) });
    assert.equal(conv.status, 200);
    assert.deepEqual((await conv.json()).sendInfo, { on: false, email: true, text: false });
    assert.deepEqual((await (await api('/api/instances/lumen-live', { headers: admin })).json()).sendInfo, { on: false, email: true, text: false });
    assert.deepEqual((await (await api('/v1/channels/lumen-live')).json()).sendInfo, { email: false, text: false });
    // the converted Studio bot keeps it as well
    assert.deepEqual((await (await api(T(''), { headers: H })).json()).spec.sendInfo, { on: false, email: true, text: false });
  });
});

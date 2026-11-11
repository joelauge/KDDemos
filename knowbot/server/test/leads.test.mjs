// The leads report (server/leads.mjs): tracked links (UTM + click id + /r/ short links), lead capture from every
// surface, checkout links sent, clicks, the CSV export and its auth. FAKES on 127.0.0.1 only: a fake mail API and a fake
// texting API record every send; no real credentials are used.
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
import { twilioSignature } from '../channels/util.mjs';
import { logQuestion, questionActivity, flushQuestions, _resetQuestions } from '../questions.mjs';
import { appendTracking, trackAnswer, contactOf, mediumOf, campaignOf, csvCell, createLeads, CSV_COLUMNS, isHttpUrl } from '../leads.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = 'https://kb.example.test';
const LINE = '+14155550100';
const DOC = `# Returns Policy

You can return any unused item within 30 days of delivery for a full refund. See https://shop.example/returns?lang=en#policy for the form.

Refunds go back to the original payment method within 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const P = { medium: 'sms', campaign: 'front-desk', content: 'proof_sms', cid: 'abcdefghij' };

// ------------------------------------------------------------------ units
describe('leads: tracking parameters', () => {
  test('appends utm_* and kb_cid to http(s) links only, keeping the query and #hash byte for byte', () => {
    assert.equal(appendTracking('https://shop.example/returns', P), 'https://shop.example/returns?utm_source=knowbot&utm_medium=sms&utm_campaign=front-desk&utm_content=proof_sms&kb_cid=abcdefghij');
    assert.equal(appendTracking('https://shop.example/a?lang=en#policy', P), 'https://shop.example/a?lang=en&utm_source=knowbot&utm_medium=sms&utm_campaign=front-desk&utm_content=proof_sms&kb_cid=abcdefghij#policy');
    assert.equal(appendTracking('https://shop.example/a?#top', P), 'https://shop.example/a?utm_source=knowbot&utm_medium=sms&utm_campaign=front-desk&utm_content=proof_sms&kb_cid=abcdefghij#top');
    assert.equal(appendTracking('https://shop.example/a?x=1&', P), 'https://shop.example/a?x=1&utm_source=knowbot&utm_medium=sms&utm_campaign=front-desk&utm_content=proof_sms&kb_cid=abcdefghij');
    // a cart permalink's encoded attribute is never re-encoded or reordered
    const cart = 'https://store.example/cart/4401:2,7701:1?ref=ai-voice-agent&attributes%5Bcall%5D=CA7';
    assert.ok(appendTracking(cart, P).startsWith(`${cart}&utm_source=knowbot`));
    for (const u of ['mailto:jo@example.com', 'tel:+14155550100', 'javascript:alert(1)', 'ftp://x.example/f', '/relative/path', 'not a url', '']) assert.equal(appendTracking(u, P), u);
  });
  test('never twice, and never over the owner\'s own campaign tags', () => {
    const once = appendTracking('https://shop.example/a', P);
    assert.equal(appendTracking(once, P), once, 'appending twice is a no-op');
    const own = 'https://shop.example/a?utm_source=newsletter&utm_campaign=spring';
    assert.equal(appendTracking(own, P), `${own}&kb_cid=abcdefghij`, 'existing utm_* win; only the click id is added');
    assert.equal(appendTracking('https://shop.example/a?kb_cid=zzz', { ...P, cid: 'abcdefghij' }).match(/kb_cid=/g).length, 1);
    // special characters in values are encoded
    assert.match(appendTracking('https://x.example/', { ...P, campaign: 'a b&c' }), /utm_campaign=a%20b%26c/);
  });
  test('channels map to the owner\'s utm_medium set; bot ids are the campaign', () => {
    assert.deepEqual(['sms', 'email', 'phone', 'whatsapp', 'studio', 'web', 'api', 'voice', 'site', 'nope'].map(mediumOf), ['sms', 'email', 'phone', 'whatsapp', 'webchat', 'webchat', 'webchat', 'voice', 'homepage', 'webchat']);
    assert.equal(campaignOf('tr_abcdefghijklmnop'), 'tr_abcdefghijklmnop');
    assert.equal(campaignOf('Front Desk!'), 'front-desk');
  });
  test('trackAnswer rewrites the proof link, citation urls and links inside the answer text (http only), and copies', () => {
    const a = { answer: 'In [“Returns”](https://shop.example/returns), it says “30 days”. Form: https://shop.example/form?x=1. Call tel:+1555', citations: [{ n: 1, url: 'https://shop.example/returns' }, { n: 2, url: 'file.pdf' }],
      proofUrl: 'https://kb.example.test/p/abc', question: 'q' };
    const seen = [];
    const t = trackAnswer(a, (u, kind) => { seen.push([kind, u]); return `https://kb.example.test/r/${seen.length}`; });
    assert.notEqual(t, a);
    assert.equal(a.proofUrl, 'https://kb.example.test/p/abc', 'the original is untouched');
    assert.match(t.answer, /\]\(https:\/\/kb\.example\.test\/r\/\d\)/);
    assert.match(t.answer, /Form: https:\/\/kb\.example\.test\/r\/\d\. Call tel:\+1555$/, 'a sentence stop after a bare link is not part of it');
    assert.equal(t.citations[1].url, 'file.pdf');
    assert.match(t.proofUrl, /\/r\/\d$/);
    assert.deepEqual(seen.map((x) => x[0]).sort(), ['proof', 'source', 'source']);
    assert.deepEqual(seen.find((x) => x[1].includes('form'))[1], 'https://shop.example/form?x=1');
  });
  test('contacts: e-mail addresses and phone numbers from caller ids; everything else is not a lead', () => {
    assert.deepEqual(contactOf('Ann <Ann@Example.com>'), { type: 'email', value: 'ann@example.com' });
    assert.deepEqual(contactOf('whatsapp:+14155550188'), { type: 'phone', value: '+14155550188' });
    assert.deepEqual(contactOf('14155550188'), { type: 'phone', value: '+14155550188' }, 'a WhatsApp wa_id');
    assert.deepEqual(contactOf('(415) 555-0123'), { type: 'phone', value: '+14155550123' });
    for (const x of ['ip:1.2.3.4', 'tr_abcdefghijklmnop', 'u1', 'jo@example', '', null]) assert.equal(contactOf(x), null, String(x));
    assert.equal(isHttpUrl('https://x.example'), true);
    assert.equal(isHttpUrl('javascript:1'), false);
  });
  test('CSV cells: quoted per RFC 4180, formula injection neutralised, phone numbers kept', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('+14155550123'), '+14155550123');
    assert.equal(csvCell(null), '');
  });
});

describe('leads: the store (createLeads)', () => {
  let dir;
  before(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-leads-')); });
  after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  test('short links redirect only to what was stored; clicks are tied to the lead through its click id', async () => {
    const logs = [];
    const L = createLeads({ dataDir: dir, log: (s) => logs.push(s) });
    const short = L.link({ botId: 'front-desk', url: 'https://shop.example/a?x=1#h', channel: 'sms', delivery: 'sms', kind: 'source', cid: 'cid0000001', base: 'https://kb.example.test/api' });
    assert.match(short, /^https:\/\/kb\.example\.test\/api\/r\/[A-Za-z0-9]{8}$/);
    const id = short.split('/').pop();
    assert.equal(await L.click(id), 'https://shop.example/a?x=1&utm_source=knowbot&utm_medium=sms&utm_campaign=front-desk&utm_content=source_sms&kb_cid=cid0000001#h');
    for (const bad of ['nope', '../../etc/passwd', 'AAAAAAAA', '', 'https://evil.example']) assert.equal(await L.click(bad), null, bad);
    assert.equal(L.link({ botId: 'front-desk', url: 'javascript:alert(1)', base: 'https://kb.example.test' }), 'javascript:alert(1)', 'never a short link to a non-http URL');
    L.lead({ botId: 'front-desk', channel: 'studio', value: 'Jo@Example.com', question: 'Returns?', cid: 'cid0000001', session: 'abcd1234' });
    const r = await L.report(['front-desk'], { days: 7 });
    assert.equal(r.leads.length, 1);
    assert.equal(r.leads[0].value, 'jo@example.com');
    assert.equal(r.leads[0].clicks, 1);
    assert.ok(r.leads[0].clickedAt);
    assert.equal(r.leads[0].utm_medium, 'sms');
    assert.equal(r.links.clicks, 1);
    assert.ok(!logs.join('\n').includes('jo@example.com'), 'no address in the server log');
    await L.idle();
    // a new process reads the same file: the link still redirects, the lead is still there
    const L2 = createLeads({ dataDir: dir });
    assert.ok(await L2.click(id));
    assert.equal((await L2.report('front-desk', { days: 7 })).leads.length, 1);
  });
  test('inbound contacts: once per value and channel per day; "send me this" leads every time', async () => {
    let t = Date.parse('2026-11-01T10:00:00Z');
    const L = createLeads({ now: () => t });
    for (let i = 0; i < 3; i++) L.lead({ botId: 'b1', channel: 'sms', value: '+14155550111', consent: 'inbound_message' });
    L.lead({ botId: 'b1', channel: 'whatsapp', value: '+14155550111', consent: 'inbound_message' });
    L.lead({ botId: 'b1', channel: 'sms', value: '+14155550111', consent: 'asked_to_send' });
    L.lead({ botId: 'b1', channel: 'sms', value: '+14155550111', consent: 'asked_to_send' });
    assert.equal(L.lead({ botId: 'b1', channel: 'web', value: 'ip:1.2.3.4' }), null);
    t += 25 * 3600 * 1000;
    L.lead({ botId: 'b1', channel: 'sms', value: '+14155550111', consent: 'inbound_message' });
    assert.equal((await L.report('b1', { days: 7 })).leads.length, 5);
  });
  test('retention: events and links older than the window are gone', async () => {
    const d2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-leads-ret-'));
    let t = Date.parse('2026-01-01T00:00:00Z');
    const L = createLeads({ dataDir: d2, now: () => t, env: { KNOWBOT_LEADS_RETENTION_DAYS: '10' } });
    const id = L.link({ botId: 'b2', url: 'https://x.example/', base: 'https://kb.example.test' }).split('/').pop();
    L.lead({ botId: 'b2', value: 'old@example.com' });
    await L.idle();
    t += 11 * 86400000;
    const L2 = createLeads({ dataDir: d2, now: () => t, env: { KNOWBOT_LEADS_RETENTION_DAYS: '10' } });
    assert.equal(await L2.click(id), null, 'an expired link 404s');
    const r = await L2.report('b2', { days: 90 });
    assert.equal(r.retentionDays, 10);
    assert.equal(r.days, 10, 'a report never reaches past the retention window');
    assert.equal(r.leads.length, 0);
    await L2.idle();
    assert.doesNotMatch(await fsp.readFile(path.join(d2, 'leads', 'b2.jsonl'), 'utf8'), /old@example\.com/, 'pruned from disk');
    await fsp.rm(d2, { recursive: true, force: true });
  });
  test('the CSV: CRM columns, one row per lead and per checkout link sent', async () => {
    const L = createLeads();
    const cid = 'cid0000002';
    L.lead({ botId: 'b3', channel: 'phone', value: '+14155550122', question: 'Is it waterproof, "really"?', cid, consent: 'asked_to_send' });
    L.checkout({ botId: 'b3', channel: 'phone', phone: '+14155550122', items: [{ title: 'Dice Tray', quantity: 2 }, { title: 'Playmat', variant: 'Blue / Large' }], cid: 'cid0000003' });
    const csv = await L.csv('b3', { days: 7 });
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines[0], CSV_COLUMNS.join(','));
    assert.equal(lines[0], 'timestamp,bot,channel,type,email,phone,question,utm_source,utm_medium,utm_campaign,click_id,clicked_at,checkout_items,consent,session');
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => /,b3,phone,checkout,,\+14155550122,,knowbot,phone,b3,cid0000003,,2 x Dice Tray; Playmat \(Blue \/ Large\),checkout_link,/.test(l)), csv);
    assert.ok(lines.some((l) => l.includes(',b3,phone,phone,,+14155550122,"Is it waterproof, ""really""?",knowbot,phone,b3,cid0000002,,,asked_to_send,')), csv);
  });
});

describe('leads: questionActivity (interactions by channel and day)', () => {
  test('counts customer questions per channel and per day; test traffic is left out', async () => {
    _resetQuestions();
    const now = Date.parse('2026-11-10T12:00:00Z');
    const day = 86400000;
    const tags = ['trial:tr_activitytestaaaaa'];
    logQuestion({ scopeTags: tags, question: 'Do you ship to Canada?', outcome: 'answered', channel: 'sms', callerKey: 'a', now: now - 2 * day });
    logQuestion({ scopeTags: tags, question: 'Do you ship to Brazil?', outcome: 'refused', channel: 'sms', callerKey: 'b', now: now - day });
    logQuestion({ scopeTags: tags, question: 'What are your hours?', outcome: 'answered', channel: 'phone', callerKey: 'c', now });
    logQuestion({ scopeTags: tags, question: 'Probe?', outcome: 'refused', channel: 'studio', origin: 'probe', callerKey: 'd', now });
    logQuestion({ scopeTags: tags, question: 'Too old', outcome: 'answered', channel: 'web', callerKey: 'e', now: now - 40 * day });
    const r = await questionActivity({ scopeTags: tags, days: 7, now });
    assert.equal(r.total, 3);
    assert.equal(r.refused, 1);
    assert.equal(r.byChannel.sms, 2);
    assert.equal(r.byChannel.phone, 1);
    assert.equal(r.byChannel.studio, 0);
    assert.equal(r.byDay.length, 7);
    assert.equal(r.byDay.at(-1).day, '2026-11-10');
    assert.equal(r.byDay.at(-1).byChannel.phone, 1);
    assert.equal(r.byDay.at(-3).byChannel.sms, 1);
    _resetQuestions();
  });
});

// ------------------------------------------------------------------ through the server
async function startFakeSenders() {
  const emails = [], texts = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/emails') { emails.push(JSON.parse(raw)); return json(200, { id: `em_${emails.length}` }); }
      if (/\/Messages\.json$/.test(req.url)) { texts.push(Object.fromEntries(new URLSearchParams(raw))); return json(201, { sid: `SM${texts.length}` }); }
      json(404, { error: 'no route' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, emails, texts, reset() { emails.length = 0; texts.length = 0; }, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

describe('leads: every surface through the server', () => {
  let kd, llm, F, kb, base, dataDir, key, trial, trial2, logs;
  const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
  const api = (p, init = {}) => fetch(base + p, init);
  const chat = (question, user) => api('/v1/bots/front-desk/chat', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question, user }) }).then((r) => r.json());
  const twilio = (p, params) => api(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('twilio-secret', PUBLIC + p, params) }, body: new URLSearchParams(params).toString() });
  const message = (x) => /<Message>([\s\S]*?)<\/Message>/.exec(x)?.[1]?.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"');
  const H = (t) => ({ authorization: `Bearer ${t.token}`, 'content-type': 'application/json' });
  const T = (t, p) => `/api/studio/trials/${t.trialId}${p}`;
  const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);
  const ask = async (t, question) => sse(await (await api(T(t, '/ask'), { method: 'POST', headers: H(t), body: JSON.stringify({ question }) })).text()).find((e) => e.event === 'final').data;
  async function newTrial() {
    const t = await (await api('/api/studio/trials', { method: 'POST' })).json();
    assert.equal((await api(T(t, '/samples'), { method: 'POST', headers: H(t), body: JSON.stringify({ set: 'lumen-bikes' }) })).status, 201);
    for (let i = 0; i < 400; i++) {
      const j = await (await api(T(t, '/files'), { headers: H(t) })).json();
      if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return t;
  }
  before(async () => {
    _resetQuestions();
    kd = await startFakeKnowDrive({ speed: 20 });
    llm = await startFakeLLM({ slowMs: 9000 });
    F = await startFakeSenders();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-leads-srv-'));
    logs = [];
    kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, leads: createLeads({ dataDir, log: (s) => logs.push(s) }), env: {
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
    key = (await (await api('/api/instances/front-desk/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'leads' }) })).json()).key;
    trial = await newTrial();
    trial2 = await (await api('/api/studio/trials', { method: 'POST' })).json();
  });
  after(async () => { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await F.close(); await fsp.rm(dataDir, { recursive: true, force: true }); _resetQuestions(); });

  test('"send me this" by e-mail: the address is a lead with the question and click id; the e-mail\'s links are tracked; a click is recorded', async () => {
    F.reset();
    await chat(Q, 'v1');
    const sent = await chat('email me that at Lee@Example.com', 'v1');
    assert.equal(sent.sendInfo.status, 'sent');
    const mail = F.emails[0];
    const shorts = [...new Set(mail.text.match(/https:\/\/kb\.example\.test\/r\/[A-Za-z0-9]+/g))];
    assert.ok(shorts.length >= 1);
    assert.doesNotMatch(mail.text + mail.html, /https:\/\/kb\.example\.test\/p\//, 'no untracked proof link');
    const hop = await api(new URL(shorts[0]).pathname, { redirect: 'manual' });
    assert.equal(hop.status, 302);
    const to = new URL(hop.headers.get('location'));
    const cid = to.searchParams.get('kb_cid');
    assert.match(cid, /^[a-z0-9]{10}$/);
    // HEAD and link previews follow the link but are not clicks
    assert.equal((await api(new URL(shorts[0]).pathname, { method: 'HEAD', redirect: 'manual' })).status, 302);
    assert.equal((await api(new URL(shorts[0]).pathname, { redirect: 'manual', headers: { 'user-agent': 'WhatsApp/2.23 A' } })).status, 302);
    const r = await kb.leads.report(['front-desk'], { days: 7 });
    const lead = r.leads.find((l) => l.value === 'lee@example.com');
    assert.ok(lead, JSON.stringify(r.leads));
    assert.equal(lead.type, 'email');
    assert.equal(lead.consent, 'asked_to_send');
    assert.equal(lead.question, Q);
    assert.equal(lead.cid, cid);
    assert.equal(lead.clicks, 1, 'one counted click');
    assert.ok(lead.clickedAt);
    assert.equal(lead.utm_source, 'knowbot');
  });
  test('/api/r/ is the same short link; unknown ids are a 404, never a redirect', async () => {
    const id = kb.leads.link({ botId: 'front-desk', url: 'https://shop.example/x', base: PUBLIC }).split('/').pop();
    assert.equal((await api(`/api/r/${id}`, { redirect: 'manual' })).status, 302);
    for (const p of ['/r/doesnotexist', '/api/r/AAAAAAAA', '/r/https%3A%2F%2Fevil.example', `/r/${id}x`]) {
      const res = await api(p, { redirect: 'manual' });
      assert.equal(res.status, 404, p);
      assert.equal(res.headers.get('location'), null);
    }
    assert.equal((await api(`/r/${id}`, { method: 'POST' })).status, 405);
  });
  test('inbound channels: the SMS sender, the WhatsApp sender and the e-mail sender are leads; the SMS reply\'s proof link is tracked', async () => {
    const from = '+14155550166';
    const reply = message(await (await twilio('/v1/channels/front-desk/sms', { From: from, To: LINE, Body: Q })).text());
    assert.match(reply, /Proof: https:\/\/kb\.example\.test\/r\/[A-Za-z0-9]+$/);
    await twilio('/v1/channels/front-desk/sms', { From: from, To: LINE, Body: 'And refunds?' });
    await twilio('/v1/channels/front-desk/whatsapp', { From: 'whatsapp:+14155550167', To: `whatsapp:${LINE}`, Body: Q });
    await api('/v1/channels/front-desk/email?key=mail-secret', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ From: 'Ann <ann@example.com>', FromFull: { Email: 'ann@example.com' }, Subject: 'Returns', TextBody: Q, Headers: [] }) });
    const r = await kb.leads.report(['front-desk'], { days: 7 });
    const by = (v) => r.leads.filter((l) => l.value === v);
    assert.equal(by(from).length, 1, 'one lead per sender per day, however many messages');
    assert.equal(by(from)[0].channel, 'sms');
    assert.equal(by(from)[0].consent, 'inbound_message');
    assert.equal(by(from)[0].question, Q);
    // the reply's link shares the sender's click id: a click on it marks the SMS lead as clicked
    assert.match(by(from)[0].cid, /^[a-f0-9]{10}$/);
    assert.equal((await api(new URL(/(https:\S+)$/.exec(reply)[1]).pathname, { redirect: 'manual' })).status, 302);
    const after = (await kb.leads.report(['front-desk'], { days: 7 })).leads.find((l) => l.value === from);
    assert.equal(after.clicks, 1);
    assert.equal(after.utm_medium, 'sms');
    assert.equal(by('+14155550167')[0].channel, 'whatsapp');
    assert.equal(by('ann@example.com')[0].consent, 'inbound_email');
  });
  test('Studio: the leads report and CSV need the bot\'s own trial token; tracking can be turned off', async () => {
    F.reset();
    // a "send me this" from the Studio chat: a lead of this trial bot
    assert.equal((await ask(trial, 'How long is the frame warranty?')).status, 'grounded');
    assert.equal((await ask(trial, 'email me that at kim@example.com')).sendInfo.status, 'sent');
    assert.match(F.emails[0].text, /\/r\/[A-Za-z0-9]+/);
    // auth: none, another bot's token, a bad token
    for (const h of [{}, H(trial2), { authorization: 'Bearer nope' }]) {
      for (const p of ['/leads', '/leads.csv']) assert.equal((await api(T(trial, p), { headers: h })).status, 401, `${p} ${JSON.stringify(h).slice(0, 30)}`);
      assert.equal((await api(T(trial, '/leads'), { method: 'PATCH', headers: { ...h, 'content-type': 'application/json' }, body: '{"tracking":false}' })).status, 401);
    }
    const j = await (await api(T(trial, '/leads?days=7'), { headers: H(trial) })).json();
    assert.equal(j.days, 7);
    assert.equal(j.tracking, true, 'on by default');
    assert.ok(j.interactions.total >= 1, JSON.stringify(j.interactions));
    assert.ok(j.interactions.byChannel.studio >= 1);
    assert.equal(j.leads[0].value, 'kim@example.com');
    assert.equal(j.leads[0].channel, 'studio');
    assert.ok(j.links.sent >= 1);
    assert.ok(j.conversions && typeof j.conversions.sent === 'number');
    const csv = await api(T(trial, '/leads.csv?days=30'), { headers: H(trial) });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="knowbot-leads-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = (await csv.text()).replace(/^﻿/, '');
    assert.equal(text.split('\r\n')[0], CSV_COLUMNS.join(','));
    assert.match(text, /,studio,email,kim@example\.com,,How long is the frame warranty\?,knowbot,webchat,tr_[a-z2-7]{16},[a-z0-9]{10},/);
    // tracking off: links go out as they are, no short link is made
    assert.equal((await api(T(trial, '/leads'), { method: 'PATCH', headers: H(trial), body: JSON.stringify({ tracking: 'no' }) })).status, 400);
    assert.deepEqual(await (await api(T(trial, '/leads'), { method: 'PATCH', headers: H(trial), body: JSON.stringify({ tracking: false }) })).json(), { tracking: false });
    F.reset();
    assert.equal((await ask(trial, 'How long is the frame warranty?')).status, 'grounded');
    assert.equal((await ask(trial, 'email me that at kim@example.com')).sendInfo.status, 'sent');
    assert.doesNotMatch(F.emails[0].text, /\/r\/|utm_|kb_cid/);
    assert.match(F.emails[0].text, /https:\/\/kb\.example\.test\/p\/[A-Za-z0-9_-]+/);
    const off = await (await api(T(trial, '/leads'), { headers: H(trial) })).json();
    assert.equal(off.tracking, false);
    assert.equal(off.leads.length, 2, 'the address is still a lead (the visitor asked to be sent this)');
    assert.equal(off.leads[0].cid, null);
    await api(T(trial, '/leads'), { method: 'PATCH', headers: H(trial), body: JSON.stringify({ tracking: true }) });
    assert.equal((await (await api(T(trial, '/leads'), { headers: H(trial) })).json()).tracking, true);
  });
  test('leads never appear on public endpoints, and full addresses never reach the server log', async () => {
    await flushQuestions();
    const ins = await (await api('/api/instances/front-desk/insights?limit=50', { headers: { authorization: 'Bearer dev-admin' } })).json();
    assert.doesNotMatch(JSON.stringify(ins), /lee@example\.com|4155550166/);
    const ch = await (await api('/v1/channels/front-desk')).json();
    assert.doesNotMatch(JSON.stringify(ch), /lee@example\.com|4155550166/);
    await kb.leads.idle();
    const file = await fsp.readFile(path.join(dataDir, 'leads', 'front-desk.jsonl'), 'utf8');
    assert.match(file, /lee@example\.com/, 'the owner\'s own store keeps the address');
    assert.ok(logs.length >= 3 && logs.some((l) => /\[leads\] bot front-desk: email lead/.test(l)), logs.join('\n'));
    assert.doesNotMatch(logs.join('\n'), /lee@example\.com|kim@example\.com|ann@example\.com|4155550166|4155550167/, 'logs carry hashes only');
  });
});

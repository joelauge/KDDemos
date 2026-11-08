// Phone channel, voice-to-voice engine (server/channels/voice-live.mjs) against FAKES on 127.0.0.1 only: a fake Gemini Live
// WebSocket server that issues tool calls, a fake Twilio REST API (texts, hang-up), a fake Shopify storefront and a fake
// ElevenLabs. Twilio's side of the media stream is played by Node's own WebSocket client. No real credentials are used.
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
import { flushQuestions, _resetQuestions, hashCaller } from '../questions.mjs';
import { twilioSignature, NOT_IN_DATA } from '../channels/util.mjs';
import { acceptWebSocket } from '../channels/ws.mjs';
import {
  mulawDecode, mulawEncode, twilioToGemini, createGeminiToTwilio, issueStreamToken, claimStreamToken, createToolRunner,
  systemInstruction, toolDeclarations, MAX_TEXTS_PER_CALL,
} from '../channels/voice-live.mjs';
import { createShop, toE164, handleInText, shopDomainFor } from '../channels/shop.mjs';
import { phoneEngine } from '../channels/voice.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(15); } throw new Error(`timed out waiting for ${what}`); };
const PUBLIC = 'https://kb.example.test';
const PHONE = '+14155550199';
const DOC = `# Returns Policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const OFF = 'What is the capital of Australia?';

// ------------------------------------------------------------------ fakes
/** Fake Shopify storefront (/products/<handle>.js) + Twilio REST + ElevenLabs. */
async function startFakeProviders() {
  const calls = [];
  const products = {
    'magnetic-dice-tray': { handle: 'magnetic-dice-tray', title: 'Magnetic Dice Tray - Walnut', variants: [{ id: 4401, title: 'Default Title', option1: 'Default Title', available: true }] },
    playmat: { handle: 'playmat', title: 'Battle Playmat', variants: [
      { id: 501, title: 'Blue / Large', option1: 'Blue', option2: 'Large', available: false },
      { id: 502, title: 'Red / Large', option1: 'Red', option2: 'Large', available: true },
      { id: 503, title: 'Blue / Small', option1: 'Blue', option2: 'Small', available: true }] },
  };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://x');
      const call = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body };
      calls.push(call);
      const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      let m;
      if ((m = /^\/shop\/products\/([a-z0-9-]+)\.js$/.exec(u.pathname))) return products[m[1]] ? json(200, products[m[1]]) : json(404, { error: 'not found' });
      if (u.pathname.startsWith('/twilio/2010-04-01/Accounts/AC1/')) {
        if (req.headers.authorization !== `Basic ${Buffer.from('AC1:twilio-secret').toString('base64')}`) return json(401, {});
        call.form = Object.fromEntries(new URLSearchParams(body));
        return json(201, { sid: 'SMfake' });
      }
      if (u.pathname.startsWith('/eleven/v1/text-to-speech/')) {
        if (req.headers['xi-api-key'] !== 'el-key') return json(401, {});
        call.json = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(Buffer.from(`ID3-eleven:${call.json.text.slice(0, 40)}`));
      }
      json(404, { error: 'no route' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

/**
 * Fake Gemini Live: checks the key, answers setup with setupComplete, then plays `script` — an async function given
 * { send, next } where next(kind) resolves with the next client message of that kind ('text' | 'audio' | 'toolResponse').
 */
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
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-voicelive-'));
  const logs = [];
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, logger: (s) => logs.push(String(s)), env: {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen', KNOWBOT_PUBLIC_URL: PUBLIC, ...env,
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
  return {
    kd, kb, base, api, logs, wsBase: `ws://127.0.0.1:${port}`,
    twilio(p, params, { token = 'twilio-secret', sign = true } = {}) {
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      if (sign) headers['x-twilio-signature'] = twilioSignature(token, PUBLIC + p, params);
      return api(p, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
    },
    async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); },
  };
}

/** Twilio's side of a media stream: a WebSocket client that echoes marks (as Twilio does once audio before them played). */
function twilioMediaClient(url) {
  const ws = new WebSocket(url);
  const got = [];
  let closeCode = null;
  const opened = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('media socket failed'))); });
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => { closeCode = e.code; resolve(e.code); }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    got.push(m);
    if (m.event === 'mark') ws.send(JSON.stringify({ event: 'mark', streamSid: m.streamSid, mark: m.mark }));
  });
  return {
    ws, got, opened, closed, get closeCode() { return closeCode; },
    send: (o) => ws.send(JSON.stringify(o)),
    start: (callSid, token) => ws.send(JSON.stringify({ event: 'start', sequenceNumber: '1', streamSid: 'MZ1', start: { streamSid: 'MZ1', accountSid: 'AC1', callSid, tracks: ['inbound'], customParameters: { token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } })),
  };
}
const pcm24k = (n, f = 440) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * f * i) / 24000)), i * 2); return b; };

// ------------------------------------------------------------------ units
describe('voice-live: audio conversion', () => {
  test('μ-law encode(decode(b)) is the identity for every byte (both zeros map to one)', () => {
    for (let b = 0; b < 256; b++) {
      const back = mulawEncode(mulawDecode(b));
      if (mulawDecode(b) === 0) assert.equal(mulawDecode(back), 0); else assert.equal(back, b, `byte ${b}`);
    }
  });
  test('Twilio 8 kHz μ-law → 16 kHz PCM doubles the samples; 24 kHz PCM → 8 kHz μ-law keeps the waveform; chunking loses nothing', () => {
    const mulaw = Buffer.alloc(160, 0xff); // 20 ms of silence, as Twilio sends it
    assert.equal(Buffer.from(twilioToGemini(mulaw.toString('base64')), 'base64').length, 640);
    const sine = pcm24k(2400);
    const whole = Buffer.from(createGeminiToTwilio()(sine.toString('base64')), 'base64');
    assert.equal(whole.length, 800);
    // round trip: the 8 kHz result decodes to the same sine (sampled every third 24 kHz sample, 3-tap average) within μ-law error
    for (let i = 1; i < whole.length - 1; i++) {
      const want = (sine.readInt16LE(i * 6) + sine.readInt16LE(i * 6 + 2) + sine.readInt16LE(i * 6 + 4)) / 3;
      assert.ok(Math.abs(mulawDecode(whole[i]) - want) <= Math.max(64, Math.abs(want) * 0.07), `sample ${i}: ${mulawDecode(whole[i])} vs ${want}`);
    }
    // odd-sized chunks (Gemini's are arbitrary) carry over: same bytes as one call
    const conv = createGeminiToTwilio();
    const parts = [sine.subarray(0, 1000), sine.subarray(1000, 2002), sine.subarray(2002)].map((p) => Buffer.from(conv(p.toString('base64')), 'base64'));
    assert.deepEqual(Buffer.concat(parts), whole);
    // and back up: 8 kHz μ-law → 16 kHz PCM follows the decoded samples
    const up = Buffer.from(twilioToGemini(whole.toString('base64')), 'base64');
    assert.equal(up.readInt16LE(40), mulawDecode(whole[10]));
  });
});

describe('voice-live: one-time stream tokens', () => {
  test('a token is claimed once, only for its call and bot; a replay is rejected', () => {
    const t = issueStreamToken({ callSid: 'CA100', botId: 'front-desk', from: PHONE });
    assert.equal(claimStreamToken(t, 'CA999', 'front-desk'), null, 'another call');
    assert.equal(claimStreamToken(t, 'CA100', 'front-desk'), null, 'spent by the failed claim');
    const t2 = issueStreamToken({ callSid: 'CA101', botId: 'front-desk', from: PHONE });
    assert.equal(claimStreamToken(t2, 'CA101', 'other-bot'), null, 'another bot');
    const t3 = issueStreamToken({ callSid: 'CA102', botId: 'front-desk', from: PHONE });
    assert.deepEqual({ ...claimStreamToken(t3, 'CA102', 'front-desk'), at: 0 }, { callSid: 'CA102', botId: 'front-desk', from: PHONE, at: 0 });
    assert.equal(claimStreamToken(t3, 'CA102', 'front-desk'), null, 'replay');
    assert.equal(claimStreamToken('', 'CA102', 'front-desk'), null);
  });
});

describe('voice-live: prompt, tools, product links', () => {
  let F;
  before(async () => { F = await startFakeProviders(); });
  after(async () => { await F.close(); });

  test('the prompt grounds every answer in the tool and the canonical refusal; product links only when a shop exists', () => {
    const p = systemInstruction({ botName: 'Front Desk', org: 'Acme' });
    assert.match(p, /Before answering ANY question, call search_knowledge_base/);
    assert.ok(p.includes(NOT_IN_DATA));
    assert.match(p, /always keep the "According to \.\.\." attribution/);
    assert.ok(!/send_product_link/.test(p));
    assert.deepEqual(toolDeclarations({ org: 'Acme' })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'end_call']);
    assert.deepEqual(toolDeclarations({ org: 'Acme', productLinks: true })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'send_product_link', 'end_call']);
    assert.match(systemInstruction({ botName: 'X', productLinks: true }), /send_product_link/);
  });

  test('shop domain: SHOP_DOMAIN, else a Shopify store import on the trial, else none', () => {
    assert.equal(shopDomainFor({}, { SHOP_DOMAIN: 'shop.example.com/' }), 'https://shop.example.com');
    assert.equal(shopDomainFor({ T: { flags: { storeLast: { platform: 'shopify', url: 'https://ugm.example' } } } }, {}), 'https://ugm.example');
    assert.equal(shopDomainFor({ T: { flags: { storeLast: { platform: 'woocommerce', url: 'https://wp.example' } } } }, {}), null);
    assert.equal(shopDomainFor({ kind: 'live', inst: {} }, {}), null);
    assert.equal(toE164('(415) 555-0199'), '+14155550199');
    assert.equal(toE164('12'), null);
    assert.equal(handleInText('# Dice Tray · https://ugm.example/products/magnetic-dice-tray\n\nSource: https://ugm.example/products/magnetic-dice-tray', 'https://ugm.example'), 'magnetic-dice-tray');
    assert.equal(handleInText('Source: https://other.example/products/x', 'https://ugm.example'), null);
  });

  test('cart permalink with variant lookup and attribution; sold-out refused with in-stock options; version asked for', async () => {
    const shop = createShop({ domain: `${F.url}/shop`, orgName: 'Acme' });
    const ok = await shop.buildProductLink({ product: 'magnetic-dice-tray', quantity: 2, callSid: 'CA7' });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.kind, 'checkout');
    const u = new URL(ok.url);
    assert.equal(u.pathname, '/shop/cart/4401:2');
    assert.deepEqual(Object.fromEntries(u.searchParams), { utm_source: 'ai-assistant', utm_medium: 'sms', utm_campaign: 'voice-agent', utm_content: 'magnetic-dice-tray', ref: 'ai-voice-agent', 'attributes[call]': 'CA7' });
    assert.equal(ok.title, 'Magnetic Dice Tray');
    assert.equal(shop.smsBody(ok), `2 x Magnetic Dice Tray is in your cart at Acme. Tap to check out: ${ok.url}`);
    const sold = await shop.buildProductLink({ product: `${F.url}/shop/products/playmat`, variant: 'large blue' });
    assert.deepEqual(sold, { status: 'unavailable', reason: 'Blue / Large is sold out.', in_stock_options: ['Red / Large', 'Blue / Small'] });
    const which = await shop.buildProductLink({ product: 'playmat', variant: 'blue' });
    assert.equal(which.status, 'need_variant');
    assert.equal(which.valid_options.length, 3);
    const red = await shop.buildProductLink({ product: 'playmat', variant: 'Red large' });
    assert.match(red.url, /\/cart\/502:1\?/);
    assert.equal((await shop.buildProductLink({ product: 'no-such-thing' })).status, 'not_found');
    // storefront unreachable: the product page, still tagged
    const down = await createShop({ domain: 'http://127.0.0.1:9' }).buildProductLink({ product: 'playmat' });
    assert.equal(down.kind, 'product_page');
    assert.match(down.url, /\/products\/playmat\?utm_source=ai-assistant&utm_medium=sms&utm_campaign=voice-agent&utm_content=playmat$/);
    const custom = await createShop({ domain: `${F.url}/shop`, env: { LINK_REF: 'phone-line', LINK_UTM_CAMPAIGN: 'spring' } }).buildProductLink({ product: 'magnetic-dice-tray' });
    assert.match(custom.url, /utm_campaign=spring.*ref=phone-line/);
  });

  test('tool runner: grounded search with spoken attribution, refusal, handle found from the sources, 3 texts per call', async () => {
    const texts = [];
    const asked = [];
    const ask = async (q) => {
      asked.push(q);
      if (/australia/i.test(q)) return { refused: true, citations: [], proof: { hits: [] } };
      return { refused: false, answer: 'x', citations: [{ n: 1, file: 'site/ugm.example/product/magnetic-dice-tray.md', title: 'Magnetic Dice Tray', excerpt: 'The magnetic dice tray is $29.99.', url: `${F.url}/shop/products/magnetic-dice-tray` }],
        proof: { quoted: [{ n: 1, text: 'The magnetic dice tray is $29.99.' }], hits: [] } };
    };
    const run = createToolRunner({ ask, callSid: 'CA8', callerNumber: PHONE, sendSms: async (to, body) => { texts.push({ to, body }); }, shopDomain: `${F.url}/shop`, org: 'Acme' });
    const s = await run({ name: 'search_knowledge_base', args: { query: 'How much is the dice tray?' } });
    assert.equal(s.status, 'ok');
    assert.equal(s.say, 'According to the Magnetic Dice Tray page, the magnetic dice tray is $29.99.');
    assert.equal(s.sources[0].title, 'Magnetic Dice Tray');
    assert.deepEqual(await run({ name: 'search_knowledge_base', args: { query: OFF } }), { status: 'not_in_data', say: NOT_IN_DATA });
    assert.deepEqual(asked, ['How much is the dice tray?', OFF]);
    // by name: the handle comes from what this call's searches cited
    const sent = await run({ name: 'send_product_link', args: { product: 'the magnetic dice tray' } });
    assert.equal(sent.status, 'ok', JSON.stringify(sent));
    assert.equal(sent.sent_to_last_four, '0199');
    assert.equal(texts[0].to, PHONE);
    assert.match(texts[0].body, /cart\/4401:1\?.*attributes%5Bcall%5D=CA8/);
    const sold = await run({ name: 'send_product_link', args: { product: 'playmat', variant: 'blue large' } });
    assert.equal(sold.status, 'unavailable');
    assert.equal(texts.length, 1, 'a sold-out version is never texted');
    assert.equal((await run({ name: 'send_product_link', args: { product: 'playmat', variant: 'red large', phone_number: '415 555 0100' } })).sent_to_last_four, '0100');
    await run({ name: 'send_product_link', args: { product: 'magnetic-dice-tray' } });
    assert.equal(texts.length, MAX_TEXTS_PER_CALL);
    assert.deepEqual(await run({ name: 'send_product_link', args: { product: 'magnetic-dice-tray' } }), { status: 'error', retryable: false, reason: 'The text limit for this call has been reached.' });
    assert.equal(texts.length, 3);
    assert.equal(run.answers.length, 2);
    // no shop: the tool refuses
    const plain = createToolRunner({ ask, callSid: 'CA9', callerNumber: PHONE, sendSms: async () => {} });
    assert.equal((await plain({ name: 'send_product_link', args: { product: 'x' } })).status, 'error');
  });
});

// ------------------------------------------------------------------ end to end through the server
describe('voice-live: a phone call through the server (fake Twilio, fake Gemini Live, fake Shopify)', () => {
  let S, F, G;
  const toolResponses = [];
  before(async () => {
    _resetQuestions();
    F = await startFakeProviders();
    G = await startFakeGemini(async ({ send, next }) => {
      const hello = await next('text');
      toolResponses.push({ hello: hello.realtimeInput.text });
      const call = async (id, name, args) => {
        send({ toolCall: { functionCalls: [{ id, name, args }] } });
        const r = await next('toolResponse');
        toolResponses.push(r.toolResponse.functionResponses[0]);
        return r.toolResponse.functionResponses[0].response;
      };
      send({ serverContent: { inputTranscription: { text: Q } } });
      await call('t1', 'search_knowledge_base', { query: Q });
      send({ serverContent: { outputTranscription: { text: 'According to the Returns Policy, you can return any unused item within 30 days.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm24k(2400).toString('base64') } }] } } });
      send({ serverContent: { turnComplete: true } });
      await call('t2', 'search_knowledge_base', { query: OFF });
      await call('t3', 'send_product_link', { product: 'magnetic-dice-tray', quantity: 2 });
      await call('t4', 'send_product_link', { product: 'playmat', variant: 'blue large' });
      send({ serverContent: { outputTranscription: { text: 'Goodbye!' }, modelTurn: { parts: [{ inlineData: { data: pcm24k(600).toString('base64') } }] } } });
      await call('t5', 'end_call', {});
      send({ serverContent: { turnComplete: true } });
    });
    S = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_FROM_NUMBER: '+15550001111', TWILIO_API_BASE_URL: `${F.url}/twilio`,
      GEMINI_API_KEY: 'gkey', GEMINI_LIVE_URL: G.url, SHOP_DOMAIN: `${F.url}/shop` });
  });
  after(async () => { _resetQuestions(); await S.close(); await G.close(); await F.close(); });

  test('engine and status: gemini when GEMINI_API_KEY is set; the media stream URL is listed; no secrets', async () => {
    assert.equal(phoneEngine({ GEMINI_API_KEY: 'x' }), 'gemini');
    assert.equal(phoneEngine({}), 'classic');
    assert.equal(phoneEngine({ GEMINI_API_KEY: 'x', KNOWBOT_PHONE_ENGINE: 'classic' }), 'classic');
    const j = await (await S.api('/v1/channels/front-desk')).json();
    assert.equal(j.channels.voice.engine, 'gemini');
    assert.equal(j.channels.voice.texts, true);
    assert.equal(j.channels.voice.mediaStream, 'wss://kb.example.test/api/v1/channels/front-desk/voice/media');
    assert.ok(!/gkey|twilio-secret/.test(JSON.stringify(j)));
    // the media path over plain HTTP says to upgrade
    assert.equal((await S.twilio('/v1/channels/front-desk/voice/media', { CallSid: 'CAx' })).status, 426);
  });

  test('signed webhook → <Connect><Stream> with a one-time token; unsigned → 403', async () => {
    const p = '/v1/channels/front-desk/voice';
    assert.equal((await S.twilio(p, { CallSid: 'CA1', From: PHONE }, { sign: false })).status, 403);
    assert.equal((await S.twilio(p, { CallSid: 'CA1', From: PHONE }, { token: 'wrong' })).status, 403);
    const xml = await (await S.twilio(p, { CallSid: 'CA1', From: PHONE })).text();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<Response><Connect><Stream url="wss:\/\/kb\.example\.test\/api\/v1\/channels\/front-desk\/voice\/media"><Parameter name="token" value="[0-9a-f-]{36}"\/><\/Stream><\/Connect><\/Response>$/);
    assert.ok(!xml.includes(PHONE), 'the caller number never goes back out in TwiML');
  });

  test('a full call: Gemini searches the bot\'s own files, speaks with attribution, refuses off-topic, texts a link, refuses sold out, hangs up', async () => {
    const xml = await (await S.twilio('/v1/channels/front-desk/voice', { CallSid: 'CA2', From: PHONE })).text();
    const token = /name="token" value="([^"]+)"/.exec(xml)[1];
    const c = twilioMediaClient(`${S.wsBase}/api/v1/channels/front-desk/voice/media`);
    await c.opened;
    c.start('CA2', token);
    c.send({ event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload: Buffer.alloc(160, 0xff).toString('base64') } });
    await until(() => c.closeCode != null, 15000, 'the call to end');
    const s = G.sessions.at(-1);
    assert.ok(!s.error, s.error?.stack);
    // setup: the bot's persona, grounding prompt and tools (product links on: a shop and Twilio texting are configured)
    assert.match(s.setup.model, /^models\/gemini-3\.8-live$/);
    assert.deepEqual(s.setup.generationConfig.responseModalities, ['AUDIO']);
    assert.match(s.setup.systemInstruction.parts[0].text, /You are Front Desk/);
    assert.deepEqual(s.setup.tools[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'send_product_link', 'end_call']);
    assert.equal(toolResponses[0].hello, "[call connected] Caller's number ends in 0199.");
    // caller audio reached Gemini as 16 kHz PCM
    const audio = s.received.find((m) => m.realtimeInput?.audio);
    assert.equal(audio.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    assert.equal(Buffer.from(audio.realtimeInput.audio.data, 'base64').length, 640);
    // grounded answer, spoken attribution, canonical refusal
    const [, t1, t2, t3, t4, t5] = toolResponses;
    assert.equal(t1.id, 't1');
    assert.equal(t1.response.status, 'ok');
    assert.match(t1.response.say, /^According to the Returns Policy, you can return any unused item within 30 days/);
    assert.equal(t1.response.sources[0].title, 'Returns Policy');
    assert.deepEqual(t2.response, { status: 'not_in_data', say: NOT_IN_DATA });
    // product link texted through Twilio with attribution; sold out refused
    assert.equal(t3.response.status, 'ok');
    assert.equal(t3.response.sent_to_last_four, '0199');
    const sms = F.calls.filter((x) => x.path === '/twilio/2010-04-01/Accounts/AC1/Messages.json');
    assert.equal(sms.length, 1);
    assert.equal(sms[0].form.To, PHONE);
    assert.equal(sms[0].form.From, '+15550001111');
    assert.match(sms[0].form.Body, /^2 x Magnetic Dice Tray is in your cart at .*\/shop\/cart\/4401:2\?utm_source=ai-assistant&utm_medium=sms&utm_campaign=voice-agent&utm_content=magnetic-dice-tray&ref=ai-voice-agent&attributes%5Bcall%5D=CA2$/);
    assert.equal(t4.response.status, 'unavailable');
    assert.equal(t5.response.status, 'ok');
    // Gemini's 24 kHz audio reached Twilio as 8 kHz μ-law, then the mark, then the hang-up through the REST API
    const media = c.got.filter((m) => m.event === 'media');
    assert.equal(Buffer.from(media[0].media.payload, 'base64').length, 800);
    assert.ok(c.got.some((m) => m.event === 'mark' && /^hangup-\d+$/.test(m.mark.name)));
    const hang = F.calls.find((x) => x.path === '/twilio/2010-04-01/Accounts/AC1/Calls/CA2.json');
    assert.equal(hang?.form?.Status, 'completed');
    await until(() => s.closed, 3000, 'the Gemini session to close');
  });

  test('every phone question is logged with channel phone; the caller number is only hashed', async () => {
    await flushQuestions();
    await until(async () => { await flushQuestions(); return [...S.kd.files.values()].filter((f) => f.tags.includes('questions') && f.tags.includes('channel:phone')).length >= 2; }, 5000, 'phone questions');
    const files = [...S.kd.files.values()].filter((f) => f.tags.includes('questions') && f.tags.includes('channel:phone'));
    const all = files.map((f) => `${f.filename} ${f.tags.join(',')} ${f.text}`).join('\n');
    assert.ok(all.includes('30 days') || /return an unused item/.test(all), all.slice(0, 400));
    assert.ok(files.some((f) => f.tags.includes(`from:${hashCaller(PHONE)}`)));
    assert.ok(!all.includes('4155550199'));
    assert.ok(files.every((f) => f.tags.includes('bot:front-desk')));
  });

  test('token replay, a missing token and a wrong bot are closed before any Gemini session opens', async () => {
    const before = G.sessions.length;
    const xml = await (await S.twilio('/v1/channels/front-desk/voice', { CallSid: 'CA3', From: PHONE })).text();
    const token = /name="token" value="([^"]+)"/.exec(xml)[1];
    const ok = twilioMediaClient(`${S.wsBase}/api/v1/channels/front-desk/voice/media`);
    await ok.opened; ok.start('CA3', token);
    await until(() => G.sessions.length === before + 1, 5000, 'the first session');
    ok.send({ event: 'stop', streamSid: 'MZ1' });
    await ok.closed;
    const replay = twilioMediaClient(`${S.wsBase}/api/v1/channels/front-desk/voice/media`);
    await replay.opened; replay.start('CA3', token);
    assert.equal(await replay.closed, 1008);
    const none = twilioMediaClient(`${S.wsBase}/v1/channels/front-desk/voice/media`);
    await none.opened; none.start('CA4', '');
    assert.equal(await none.closed, 1008);
    await sleep(100);
    assert.equal(G.sessions.length, before + 1, 'no Gemini session for a refused stream');
    // other upgrade paths and unknown bots are refused at the handshake
    for (const u of [`${S.wsBase}/api/v1/channels/front-desk/voice/other`, `${S.wsBase}/api/v1/channels/no-such-bot/voice/media`]) {
      const w = new WebSocket(u);
      await new Promise((r) => { w.addEventListener('error', r); w.addEventListener('close', r); });
      assert.notEqual(w.readyState, 1, u);
    }
  });
});

describe('voice-live: classic engine (no GEMINI_API_KEY) speaks with ElevenLabs; missing secrets degrade', () => {
  let S, F, N;
  before(async () => {
    _resetQuestions();
    F = await startFakeProviders();
    S = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret', ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_VOICE_ID: 'voice1', ELEVENLABS_BASE_URL: `${F.url}/eleven` });
    N = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret' });
  });
  after(async () => { _resetQuestions(); await S.close(); await N.close(); await F.close(); });

  test('<Gather> loop; the answer is ElevenLabs audio with attribution; logged as phone', async () => {
    const p = '/v1/channels/front-desk/voice';
    const first = await (await S.twilio(p, { CallSid: 'CA5', From: PHONE })).text();
    assert.match(first, /<Gather input="speech"[^>]*><Play>https:\/\/kb\.example\.test\/api\/v1\/channels\/front-desk\/voice\/audio\/[A-Za-z0-9_-]+\.mp3<\/Play>/);
    const ans = await (await S.twilio(`${p}/answer?empty=0`, { CallSid: 'CA5', From: PHONE, SpeechResult: Q })).text();
    const spoken = F.calls.filter((c) => c.path === '/eleven/v1/text-to-speech/voice1').map((c) => c.json.text);
    assert.ok(spoken.some((t) => /^According to the Returns Policy, you can return any unused item within 30 days/.test(t)), spoken.join(' | '));
    const audioUrl = /<Play>([^<]+)<\/Play>/.exec(ans)[1].replace(PUBLIC, S.base);
    const a = await fetch(audioUrl);
    assert.equal(a.headers.get('content-type'), 'audio/mpeg');
    assert.match(Buffer.from(await a.arrayBuffer()).toString(), /^ID3-eleven:/);
    const st = await (await S.api('/v1/channels/front-desk')).json();
    assert.equal(st.channels.voice.engine, 'classic');
    assert.equal(st.channels.voice.speech.synthesis, 'elevenlabs');
    assert.equal(st.channels.voice.mediaStream, undefined);
    await until(async () => { await flushQuestions(); return [...S.kd.files.values()].some((f) => f.tags.includes('questions') && f.tags.includes('channel:phone')); }, 5000, 'a phone question');
  });

  test('without GEMINI_API_KEY the media WebSocket is refused (503) and calls use <Say>', async () => {
    const w = new WebSocket(`${N.wsBase}/api/v1/channels/front-desk/voice/media`);
    await new Promise((r) => { w.addEventListener('error', r); w.addEventListener('close', r); });
    assert.notEqual(w.readyState, 1);
    const first = await (await N.twilio('/v1/channels/front-desk/voice', { CallSid: 'CA6', From: PHONE })).text();
    assert.match(first, /<Say /);
    const st = await (await N.api('/v1/channels/front-desk')).json();
    assert.equal(st.channels.voice.texts, false);
  });
});

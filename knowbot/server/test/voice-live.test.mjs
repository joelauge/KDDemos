// Phone channel, voice-to-voice engine (server/channels/voice-live.mjs) against FAKES on 127.0.0.1 only: a fake Gemini Live
// WebSocket server that issues tool calls, a fake Twilio REST API (texts, hang-up) and a fake Shopify storefront. Twilio's
// side of the media stream is played by Node's own WebSocket client. No real credentials are used.
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
  mulawDecode, mulawEncode, twilioToGemini, createTwilioToGemini, createGeminiToTwilio, issueStreamToken, claimStreamToken, createToolRunner,
  systemInstruction, toolDeclarations, sendInfoDeclaration, MAX_TEXTS_PER_CALL, hasFigure, phoneLimits, phoneSessions,
} from '../channels/voice-live.mjs';
import { createShop, toE164, handleInText, shopDomainFor, textableNumber, describeLines, MAX_LINK_ITEMS } from '../channels/shop.mjs';
import { phoneEngine, PHONE_NOT_SET_UP } from '../channels/voice.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(15); } throw new Error(`timed out waiting for ${what}`); };
// The server logs with console.log (its `logger` option is not wired through), so these servers run non-quiet and the
// lines are captured here instead of printed: tests assert on what was logged.
const LOGS = [];
console.log = (...a) => { LOGS.push(a.map(String).join(' ')); if (LOGS.length > 20000) LOGS.splice(0, 10000); };
const PUBLIC = 'https://kb.example.test';
const PHONE = '+14155550199';
const DOC = `# Returns Policy

You can return any unused item within 30 days of delivery for a full refund.

Refunds go back to the original payment method within 5 business days.
`;
const Q = 'How many days do I have to return an unused item?';
const OFF = 'What is the capital of Australia?';

// ------------------------------------------------------------------ fakes
/** Fake Shopify storefront (/products/<handle>.js) + Twilio REST. */
async function startFakeProviders() {
  const calls = [];
  const products = {
    'magnetic-dice-tray': { handle: 'magnetic-dice-tray', title: 'Magnetic Dice Tray - Walnut', variants: [{ id: 4401, title: 'Default Title', option1: 'Default Title', available: true }] },
    'dice-bag': { handle: 'dice-bag', title: 'Dice Bag', variants: [{ id: 7701, title: 'Default Title', option1: 'Default Title', available: true }] },
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
  const logs = LOGS;
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: false, watch: false, env: {
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
/** A signed incoming call, then Twilio's media stream for it with the token from the TwiML. */
async function startCall(S, bot, callSid, from = PHONE) {
  const xml = await (await S.twilio(`/v1/channels/${bot}/voice`, { CallSid: callSid, From: from })).text();
  const token = /name="token" value="([^"]+)"/.exec(xml)?.[1];
  assert.ok(token, xml);
  const c = twilioMediaClient(`${S.wsBase}/api/v1/channels/${bot}/voice/media`);
  await c.opened;
  c.start(callSid, token);
  return c;
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
    // and back up: 8 kHz μ-law → 16 kHz PCM follows the decoded samples (each pair: the midpoint from the previous sample, then the sample)
    const up = Buffer.from(twilioToGemini(whole.toString('base64')), 'base64');
    assert.equal(up.readInt16LE(42), mulawDecode(whole[10]));
    assert.equal(up.readInt16LE(40), (mulawDecode(whole[9]) + mulawDecode(whole[10])) >> 1);
  });
  test('chunk boundaries: split μ-law (at 160-byte frames and odd offsets) upsamples exactly like the whole buffer, no step every 20 ms', () => {
    const sine8k = Buffer.from(Array.from({ length: 800 }, (_, i) => mulawEncode(Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / 8000)))));
    const whole = Buffer.from(createTwilioToGemini()(sine8k.toString('base64')), 'base64');
    for (const cuts of [[160, 320, 480, 640], [1, 161, 333, 799], [7, 8, 9, 400]]) {
      const conv = createTwilioToGemini();
      const edges = [0, ...cuts, sine8k.length];
      const parts = edges.slice(1).map((e, i) => Buffer.from(conv(sine8k.subarray(edges[i], e).toString('base64')), 'base64'));
      assert.deepEqual(Buffer.concat(parts), whole, `cuts ${cuts}`);
    }
    // the sample interpolated at a 160-byte boundary sits between its neighbours (the old converter repeated the last one)
    const at = 160 * 2; // 16 kHz sample index of the first sample of the second frame's pair
    const a = mulawDecode(sine8k[159]), b = mulawDecode(sine8k[160]);
    assert.equal(whole.readInt16LE(at * 2), (a + b) >> 1);
  });
  test('chunk boundaries: 24 kHz PCM split at odd byte offsets downsamples exactly like the whole buffer', () => {
    const sine = pcm24k(2400);
    const whole = Buffer.from(createGeminiToTwilio()(sine.toString('base64')), 'base64');
    for (const cuts of [[1, 1001, 2003, 4799], [3, 5, 7, 9, 11], [999, 1000, 3001], [160, 320, 481]]) {
      const conv = createGeminiToTwilio();
      const edges = [0, ...cuts, sine.length];
      const parts = edges.slice(1).map((e, i) => Buffer.from(conv(sine.subarray(edges[i], e).toString('base64')), 'base64'));
      assert.deepEqual(Buffer.concat(parts), whole, `cuts ${cuts}`);
    }
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
    // answers are spoken without "According to ..." (shorter calls); the source is named only when asked
    assert.match(p, /without saying where it comes from \(no "According to \.\.\."/);
    assert.match(p, /If the caller asks where something comes from, name it from "source_titles"/);
    assert.ok(p.includes('Greet the caller with: "Hi. I\'m Front Desk. I\'m here to get you quick answers. How can I help?"'), 'no sending set up: no offer in the greeting');
    assert.doesNotMatch(p, /my files|your files/, 'the bot speaks for the business');
    // with sending: the greeting offers the sources at the end, and the prompt asks for a natural end-of-call offer
    const ps = systemInstruction({ botName: 'Front Desk', org: 'Acme', sendInfo: { email: true, text: true, callerKnown: true } });
    assert.ok(ps.includes("Hi. I'm Front Desk. I'm here to get you quick answers. I can send you text messages and emails too. How can I help?"));
    assert.match(ps, /Before the call ends .* offer to send them the transcript of your conversation and the sources for what you shared, by email or text/);
    assert.match(ps, /Say it in your own words/);
    assert.match(ps, /what "conversation" for the end-of-call offer/);
    assert.equal(sendInfoDeclaration().parameters.properties.what.enum.join(','), 'conversation,last_answer');
    assert.ok(!/send_product_link/.test(p));
    assert.deepEqual(toolDeclarations({ org: 'Acme' })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'end_call']);
    assert.deepEqual(toolDeclarations({ org: 'Acme', productLinks: true })[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'send_product_link', 'end_call']);
    assert.match(systemInstruction({ botName: 'X', productLinks: true }), /send_product_link/);
  });

  test('86135d1 prompt: offers in its own words and never repeated, one link for several products, version + quantity of each, how the cart works', () => {
    const p = systemInstruction({ botName: 'Front Desk', org: 'Acme', productLinks: true });
    assert.match(p, /Phrase the offer in your own words each time/);
    assert.match(p, /never reuse wording you've already used on this call/);
    assert.ok(!/"Want me to text you|"Shall I text you|"I can send that/.test(p), 'offers are described, never given as example lines');
    assert.match(p, /more than one product, offer to put them all in one link/);
    assert.match(p, /which version of each product they want .* and how many of each/);
    assert.match(p, /it opens a fresh checkout with only the items in that link\. It doesn't add to, or include, anything already in a cart on the website/);
    assert.match(p, /the link opens a new checkout with exactly these items in the cart/);
    assert.match(p, /item_number/);
    const decl = toolDeclarations({ org: 'Acme', productLinks: true })[0].functionDeclarations.find((f) => f.name === 'send_product_link');
    assert.deepEqual(decl.parameters.required, ['items']);
    assert.equal(decl.parameters.properties.items.type, 'ARRAY');
    assert.deepEqual(Object.keys(decl.parameters.properties.items.items.properties), ['product', 'variant', 'quantity']);
    assert.match(decl.parameters.properties.items.description, /up to 5/);
    assert.equal(MAX_LINK_ITEMS, 5);
    assert.ok(decl.parameters.properties.phone_number);
  });

  test('shop domain: the bot\'s own Shopify import or shopDomain; SHOP_DOMAIN only for SHOP_DOMAIN_BOT, never server-wide', () => {
    const env = { SHOP_DOMAIN: 'shop.example.com/' };
    assert.equal(shopDomainFor({ id: 'front-desk', kind: 'live', inst: {} }, env), null, 'SHOP_DOMAIN alone applies to no bot');
    assert.equal(shopDomainFor({ id: 'front-desk', kind: 'live', inst: {} }, { ...env, SHOP_DOMAIN_BOT: 'front-desk' }), 'https://shop.example.com');
    assert.equal(shopDomainFor({ id: 'clinic', kind: 'live', inst: {} }, { ...env, SHOP_DOMAIN_BOT: 'front-desk' }), null, 'another bot never gets it');
    assert.deepEqual(toolDeclarations({ org: 'Clinic', productLinks: !!shopDomainFor({ id: 'clinic', kind: 'live', inst: {} }, { ...env, SHOP_DOMAIN_BOT: 'front-desk' }) })[0].functionDeclarations.map((f) => f.name),
      ['search_knowledge_base', 'end_call']);
    assert.equal(shopDomainFor({ T: { flags: { storeLast: { platform: 'shopify', url: 'https://ugm.example' } } } }, {}), 'https://ugm.example');
    assert.equal(shopDomainFor({ kind: 'trial', flags: { storeLast: { platform: 'shopify', url: 'https://ugm.example' } } }, {}), 'https://ugm.example', 'from the saved trial doc');
    assert.equal(shopDomainFor({ kind: 'live', inst: { shopDomain: 'https://ugm.example' } }, {}), 'https://ugm.example', 'a launched bot');
    assert.equal(shopDomainFor({ T: { flags: { storeLast: { platform: 'woocommerce', url: 'https://wp.example' } } } }, {}), null);
    assert.equal(shopDomainFor({ kind: 'live', inst: {} }, {}), null);
    assert.equal(toE164('(415) 555-0199'), '+14155550199');
    assert.equal(toE164('12'), null);
    assert.equal(handleInText('# Dice Tray · https://ugm.example/products/magnetic-dice-tray\n\nSource: https://ugm.example/products/magnetic-dice-tray', 'https://ugm.example'), 'magnetic-dice-tray');
    assert.equal(handleInText('Source: https://other.example/products/x', 'https://ugm.example'), null);
  });

  test('cart permalink with variant lookup and attribution; sold-out refused with in-stock options; version asked for (old single shape)', async () => {
    const shop = createShop({ domain: `${F.url}/shop`, orgName: 'Acme' });
    const ok = await shop.buildProductLink({ product: 'magnetic-dice-tray', quantity: 2, callSid: 'CA7' });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.kind, 'checkout');
    const u = new URL(ok.url);
    assert.equal(u.pathname, '/shop/cart/4401:2');
    assert.deepEqual(Object.fromEntries(u.searchParams), { utm_source: 'ai-assistant', utm_medium: 'sms', utm_campaign: 'voice-agent', utm_content: 'magnetic-dice-tray', ref: 'ai-voice-agent', 'attributes[call]': 'CA7' });
    assert.deepEqual(ok.lines, [{ title: 'Magnetic Dice Tray', variant: '', quantity: 2 }]);
    assert.equal(shop.smsBody(ok), `2 x Magnetic Dice Tray are in your cart at Acme. Tap to check out: ${ok.url}`);
    const one = await shop.buildProductLink({ items: [{ product: 'magnetic-dice-tray' }] });
    assert.equal(shop.smsBody(one), `Magnetic Dice Tray is in your cart at Acme. Tap to check out: ${one.url}`);
    const sold = await shop.buildProductLink({ product: `${F.url}/shop/products/playmat`, variant: 'large blue' });
    assert.deepEqual(sold, { status: 'unavailable', product: 'Battle Playmat', reason: 'Blue / Large is sold out.', in_stock_options: ['Red / Large', 'Blue / Small'], item_number: 1 });
    const which = await shop.buildProductLink({ product: 'playmat', variant: 'blue' });
    assert.equal(which.status, 'need_variant');
    assert.equal(which.valid_options.length, 3);
    const red = await shop.buildProductLink({ product: 'playmat', variant: 'Red large' });
    assert.match(red.url, /\/cart\/502:1\?/);
    assert.equal((await shop.buildProductLink({ product: 'no-such-thing' })).status, 'not_found');
    // storefront unreachable: a single product gets its product page, still tagged
    const down = await createShop({ domain: 'http://127.0.0.1:9', orgName: 'Acme' }).buildProductLink({ items: [{ product: 'playmat', variant: 'red', quantity: 3 }] });
    assert.equal(down.status, 'ok');
    assert.equal(down.kind, 'product_page');
    assert.match(down.url, /\/products\/playmat\?utm_source=ai-assistant&utm_medium=sms&utm_campaign=voice-agent&utm_content=playmat$/);
    assert.deepEqual(down.lines, [{ title: 'playmat', variant: 'red', quantity: 1 }]);
    const custom = await createShop({ domain: `${F.url}/shop`, env: { LINK_REF: 'phone-line', LINK_UTM_CAMPAIGN: 'spring' } }).buildProductLink({ product: 'magnetic-dice-tray' });
    assert.match(custom.url, /utm_campaign=spring.*ref=phone-line/);
  });

  test('multi-item link (86135d1): one permalink /cart/v1:q1,v2:q2, repeats merged, utm_content lists every handle, SMS lists every item', async () => {
    const shop = createShop({ domain: `${F.url}/shop`, orgName: 'Acme' });
    const ok = await shop.buildProductLink({ callSid: 'CA70', items: [
      { product: 'magnetic-dice-tray', quantity: 2 }, { product: 'playmat', variant: 'red large' }, { product: 'dice-bag' }, { product: 'magnetic-dice-tray' }] });
    assert.equal(ok.status, 'ok', JSON.stringify(ok));
    assert.equal(ok.kind, 'checkout');
    const u = new URL(ok.url);
    assert.equal(u.pathname, '/shop/cart/4401:3,502:1,7701:1', 'one cart, the repeated tray merged (2 + 1)');
    assert.equal(u.searchParams.get('utm_content'), 'magnetic-dice-tray,playmat,dice-bag');
    assert.equal(u.searchParams.get('ref'), 'ai-voice-agent');
    assert.equal(u.searchParams.get('attributes[call]'), 'CA70');
    assert.deepEqual(ok.lines, [{ title: 'Magnetic Dice Tray', variant: '', quantity: 3 }, { title: 'Battle Playmat', variant: 'Red / Large', quantity: 1 }, { title: 'Dice Bag', variant: '', quantity: 1 }]);
    assert.equal(describeLines(ok.lines), '3 x Magnetic Dice Tray; Battle Playmat, Red / Large and Dice Bag');
    assert.equal(shop.smsBody(ok), `3 x Magnetic Dice Tray; Battle Playmat, Red / Large and Dice Bag are in your cart at Acme. Tap to check out: ${ok.url}`);
    // two of one item: "are"; a merge never goes past 10 of one version
    const many = await shop.buildProductLink({ items: [{ product: 'dice-bag', quantity: 8 }, { product: 'dice-bag', quantity: 8 }] });
    assert.equal(new URL(many.url).pathname, '/shop/cart/7701:10');
    // the FIRST problem item comes back with its item_number, so the agent asks about just that one
    const sold = await shop.buildProductLink({ items: [{ product: 'dice-bag' }, { product: 'playmat', variant: 'blue large' }, { product: 'playmat', variant: 'blue' }] });
    assert.equal(sold.status, 'unavailable');
    assert.equal(sold.item_number, 2);
    assert.equal(sold.product, 'Battle Playmat');
    assert.deepEqual(sold.in_stock_options, ['Red / Large', 'Blue / Small']);
    const which = await shop.buildProductLink({ items: [{ product: 'dice-bag' }, { product: 'magnetic-dice-tray' }, { product: 'playmat', variant: 'blue' }] });
    assert.deepEqual([which.status, which.item_number, which.product], ['need_variant', 3, 'Battle Playmat']);
    const missing = await shop.buildProductLink({ items: [{ product: 'no-such-thing' }, { product: 'dice-bag' }] });
    assert.deepEqual([missing.status, missing.item_number, missing.product], ['not_found', 1, 'no-such-thing']);
    // limits and empties
    assert.equal((await shop.buildProductLink({ items: [] })).status, 'error');
    assert.equal((await shop.buildProductLink({ items: [{ variant: 'red' }] })).status, 'error');
    const six = await shop.buildProductLink({ items: Array.from({ length: 6 }, () => ({ product: 'dice-bag' })) });
    assert.equal(six.status, 'error');
    assert.match(six.reason, /at most 5 products/);
    // several products and the store unreachable: no partial link
    const down = await createShop({ domain: 'http://127.0.0.1:9' }).buildProductLink({ items: [{ product: 'playmat' }, { product: 'dice-bag' }] });
    assert.deepEqual(down, { status: 'error', retryable: true, reason: "The store couldn't be reached." });
  });

  test('storefront lookups: cached, one retry on a 429, no user-agent spoofing', async () => {
    const seen = [];
    let n = 0;
    const fetchImpl = async (url, init) => {
      seen.push({ url, headers: init.headers });
      n += 1;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ handle: 'dice-bag', title: 'Dice Bag', variants: [{ id: 7701, title: 'Default Title', option1: 'Default Title', available: true }] }), { status: 200 });
    };
    const shop = createShop({ domain: 'https://shop.example', fetchImpl });
    assert.equal((await shop.buildProductLink({ items: [{ product: 'dice-bag' }] })).status, 'ok');
    assert.equal((await shop.buildProductLink({ items: [{ product: 'dice-bag', quantity: 2 }] })).status, 'ok');
    assert.equal(seen.length, 2, 'one retry after the 429, then the cache');
    assert.equal(seen[0].url, 'https://shop.example/products/dice-bag.js');
    for (const x of seen) assert.deepEqual(Object.keys(x.headers).map((k) => k.toLowerCase()), ['accept']);
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
    assert.equal(s.say, 'The magnetic dice tray is $29.99.', 'just the answer: no spoken attribution');
    // only what to say and where it came from: no raw excerpts or page addresses the model could read beyond the answer
    assert.deepEqual(Object.keys(s).sort(), ['say', 'source_titles', 'status']);
    assert.deepEqual(s.source_titles, ['Magnetic Dice Tray']);
    assert.deepEqual(await run({ name: 'search_knowledge_base', args: { query: OFF } }), { status: 'not_in_data', say: NOT_IN_DATA });
    assert.deepEqual(asked, ['How much is the dice tray?', OFF]);
    // by name: the handle comes from what this call's searches cited
    const sent = await run({ name: 'send_product_link', args: { product: 'the magnetic dice tray' } });
    assert.equal(sent.status, 'ok', JSON.stringify(sent));
    assert.equal(sent.sent_to_last_four, '0199');
    assert.equal(texts[0].to, PHONE);
    assert.match(texts[0].body, /cart\/4401:1\?.*attributes%5Bcall%5D=CA8/);
    assert.equal(sent.opens, 'a new checkout with exactly these items in the cart');
    assert.deepEqual(sent.items, [{ title: 'Magnetic Dice Tray', variant: '', quantity: 1 }]);
    const sold = await run({ name: 'send_product_link', args: { items: [{ product: 'dice-bag' }, { product: 'playmat', variant: 'blue large' }] } });
    assert.equal(sold.status, 'unavailable');
    assert.equal(sold.item_number, 2);
    assert.equal(texts.length, 1, 'a sold-out version is never texted, nor the rest of its link');
    assert.equal((await run({ name: 'send_product_link', args: { product: 'playmat', variant: 'red large', phone_number: '415 555 0100' } })).sent_to_last_four, '0100');
    // several products: one text, one link, every item listed
    const multi = await run({ name: 'send_product_link', args: { items: [{ product: 'magnetic-dice-tray', quantity: 2 }, { product: 'dice-bag' }] } });
    assert.equal(multi.status, 'ok', JSON.stringify(multi));
    assert.deepEqual(multi.items, [{ title: 'Magnetic Dice Tray', variant: '', quantity: 2 }, { title: 'Dice Bag', variant: '', quantity: 1 }]);
    assert.match(texts[2].body, /^2 x Magnetic Dice Tray and Dice Bag are in your cart at Acme\. Tap to check out: .*\/shop\/cart\/4401:2,7701:1\?.*utm_content=magnetic-dice-tray%2Cdice-bag/);
    assert.equal(texts.length, MAX_TEXTS_PER_CALL);
    assert.deepEqual(await run({ name: 'send_product_link', args: { product: 'magnetic-dice-tray' } }), { status: 'error', retryable: false, reason: 'The text limit for this call has been reached.' });
    assert.equal(texts.length, 3);
    assert.equal(run.answers.length, 2);
    // no shop: the tool refuses
    const plain = createToolRunner({ ask, callSid: 'CA9', callerNumber: PHONE, sendSms: async () => {} });
    assert.equal((await plain({ name: 'send_product_link', args: { product: 'x' } })).status, 'error');
  });

  test('texts: the caller ID by default; a spoken number only in the line\'s country, never premium-rate; quota refusals', async () => {
    assert.equal(textableNumber(PHONE, '+15550001111'), PHONE);
    assert.equal(textableNumber('+447700900123', '+15550001111'), null, 'foreign');
    assert.equal(textableNumber('+447700900123', '+447700900999'), '+447700900123', 'same country as the line');
    assert.equal(textableNumber('+1 900 555 1234', ''), null, 'premium-rate 900');
    assert.equal(textableNumber('+1 212 976 1234', ''), null, 'premium 976 exchange');
    assert.equal(textableNumber('+449012345678', '+447700900999'), null, 'UK premium 09');
    assert.equal(textableNumber('411', ''), null, 'short code');
    const texts = [];
    const ask = async () => ({ refused: false, citations: [], proof: { hits: [] } });
    let allowed = true;
    const run = createToolRunner({ ask, callSid: 'CA10', callerNumber: PHONE, sendSms: async (to, body) => { texts.push({ to, body }); }, shopDomain: `${F.url}/shop`, org: 'Acme',
      env: { TWILIO_FROM_NUMBER: '+15550001111' }, textAllowed: () => allowed });
    const foreign = await run({ name: 'send_product_link', args: { product: 'magnetic-dice-tray', phone_number: '+44 7700 900123' } });
    assert.equal(foreign.status, 'error');
    assert.match(foreign.reason, /same country/);
    const premium = await run({ name: 'send_product_link', args: { product: 'magnetic-dice-tray', phone_number: '1-900-555-1234' } });
    assert.equal(premium.status, 'error');
    assert.equal(texts.length, 0, 'nothing texted to a foreign or premium-rate number');
    // the caller's own number, spoken back, is still the caller ID
    assert.equal((await run({ name: 'send_product_link', args: { product: 'magnetic-dice-tray', phone_number: '(415) 555-0199' } })).status, 'ok');
    allowed = false;
    assert.deepEqual(await run({ name: 'send_product_link', args: { product: 'magnetic-dice-tray' } }), { status: 'error', retryable: false, reason: 'texts are limited' });
    assert.equal(texts.length, 1);
  });

  test('grounding check: a figure (digit, currency, percent, date) is caught; the caller\'s own last four digits are not', () => {
    assert.ok(hasFigure('It costs $29.99.'));
    assert.ok(hasFigure('About twenty percent off.'));
    assert.ok(hasFigure('We open on Monday.'));
    assert.ok(!hasFigure('Shall I text it to the number ending in 0199?', { lastFour: '0199' }));
    assert.ok(!hasFigure('You may return it. Goodbye!'));
    assert.deepEqual(phoneLimits({}), { maxSeconds: 900, maxSessions: 50, maxPerBot: 5 });
  });
});

// ------------------------------------------------------------------ end to end through the server
describe('voice-live: a phone call through the server (fake Twilio, fake Gemini Live, fake Shopify)', () => {
  let S, F, G;
  const toolResponses = [];
  // what the fake Gemini does in the next session: 'full' (the scripted call below), 'idle', 'texts', 'ungrounded'
  const mode = { current: 'full' };
  const toolCall = (send, next, s) => async (id, name, args) => {
    send({ toolCall: { functionCalls: [{ id, name, args }] } });
    const r = await next('toolResponse');
    (s.results ||= []).push(r.toolResponse.functionResponses[0]);
    return r.toolResponse.functionResponses[0].response;
  };
  before(async () => {
    _resetQuestions();
    F = await startFakeProviders();
    G = await startFakeGemini(async ({ send, next, s }) => {
      const m = mode.current;
      s.mode = m;
      if (m === 'idle') return;
      if (m === 'texts') {
        await next('text');
        const call = toolCall(send, next, s);
        for (let i = 0; i < 3; i++) await call(`x${i}`, 'send_product_link', { product: 'magnetic-dice-tray' });
        await call('xf', 'send_product_link', { product: 'magnetic-dice-tray', phone_number: '+44 7700 900123' });
        await call('xp', 'send_product_link', { product: 'magnetic-dice-tray', phone_number: '+1 900 555 1234' });
        await call('xe', 'end_call', {});
        send({ serverContent: { turnComplete: true } });
        return;
      }
      if (m === 'ungrounded') {
        await next('text');
        // the caller asks; the model answers with a price and never searched
        send({ serverContent: { inputTranscription: { text: 'How much is the walnut dice tray?' } } });
        send({ serverContent: { outputTranscription: { text: 'The walnut dice tray is $49.99.' }, modelTurn: { parts: [{ inlineData: { data: pcm24k(300).toString('base64') } }] } } });
        send({ serverContent: { turnComplete: true } });
        // then a grounded turn: searched first, so not flagged
        send({ serverContent: { inputTranscription: { text: Q } } });
        await toolCall(send, next, s)('g1', 'search_knowledge_base', { query: Q });
        send({ serverContent: { outputTranscription: { text: 'According to the Returns Policy, you have 30 days.' } } });
        send({ serverContent: { turnComplete: true } });
        await toolCall(send, next, s)('g2', 'end_call', {});
        send({ serverContent: { turnComplete: true } });
        return;
      }
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
      await call('t4', 'send_product_link', { items: [{ product: 'dice-bag' }, { product: 'playmat', variant: 'blue large' }] });
      send({ serverContent: { outputTranscription: { text: 'Goodbye!' }, modelTurn: { parts: [{ inlineData: { data: pcm24k(600).toString('base64') } }] } } });
      await call('t5', 'end_call', {});
      send({ serverContent: { turnComplete: true } });
    });
    S = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_FROM_NUMBER: '+15550001111', TWILIO_API_BASE_URL: `${F.url}/twilio`,
      GEMINI_API_KEY: 'gkey', GEMINI_LIVE_URL: G.url, SHOP_DOMAIN: `${F.url}/shop`, SHOP_DOMAIN_BOT: 'front-desk', KNOWBOT_PHONE_MAX_SESSIONS_PER_BOT: '2' });
  });
  after(async () => { _resetQuestions(); await S.close(); await G.close(); await F.close(); });

  test('engine and status: gemini when GEMINI_API_KEY is set (the only engine); the media stream URL is listed; no secrets', async () => {
    assert.equal(phoneEngine({ GEMINI_API_KEY: 'x' }), 'gemini');
    assert.equal(phoneEngine({}), 'not_configured');
    assert.equal(phoneEngine({ GEMINI_API_KEY: 'x', KNOWBOT_PHONE_ENGINE: 'classic' }), 'gemini', 'there is no classic engine switch');
    const j = await (await S.api('/v1/channels/front-desk')).json();
    assert.equal(j.channels.voice.engine, 'gemini');
    assert.equal(j.channels.voice.configured, true);
    assert.equal(j.channels.voice.speech, undefined);
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
    // setup: the bot's persona, grounding prompt and tools (product links and send_info on: a shop and texting are configured)
    assert.match(s.setup.model, /^models\/gemini-3\.8-live$/);
    assert.deepEqual(s.setup.generationConfig.responseModalities, ['AUDIO']);
    assert.match(s.setup.systemInstruction.parts[0].text, /You are Front Desk/);
    assert.deepEqual(s.setup.tools[0].functionDeclarations.map((f) => f.name), ['search_knowledge_base', 'send_product_link', 'send_info', 'end_call']);
    assert.equal(toolResponses[0].hello, "[call connected] Caller's number ends in 0199.");
    // caller audio reached Gemini as 16 kHz PCM
    const audio = s.received.find((m) => m.realtimeInput?.audio);
    assert.equal(audio.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    assert.equal(Buffer.from(audio.realtimeInput.audio.data, 'base64').length, 640);
    // grounded answer (no spoken attribution), canonical refusal
    const [, t1, t2, t3, t4, t5] = toolResponses;
    assert.equal(t1.id, 't1');
    assert.equal(t1.response.status, 'ok');
    assert.match(t1.response.say, /^You can return any unused item within 30 days/);
    assert.deepEqual(t1.response.source_titles, ['Returns Policy']);
    assert.equal(t1.response.sources, undefined, 'no raw excerpts reach the model');
    assert.deepEqual(t2.response, { status: 'not_in_data', say: NOT_IN_DATA });
    // product link texted through Twilio with attribution; sold out refused
    assert.equal(t3.response.status, 'ok');
    assert.equal(t3.response.sent_to_last_four, '0199');
    const sms = F.calls.filter((x) => x.path === '/twilio/2010-04-01/Accounts/AC1/Messages.json');
    assert.equal(sms.length, 1);
    assert.equal(sms[0].form.To, PHONE);
    assert.equal(sms[0].form.From, '+15550001111');
    // the checkout link goes out as a tracked short link (server/leads.mjs); it 302s to the cart permalink, tagged
    // knowbot / phone / <bot>, its own ref and call attribute kept as built (never re-encoded), plus the click id
    assert.match(sms[0].form.Body, /^2 x Magnetic Dice Tray are in your cart at .*Tap to check out: https:\/\/kb\.example\.test\/r\/[A-Za-z0-9]+$/);
    const hop = await S.api(new URL(/(https:\S+)$/.exec(sms[0].form.Body)[1]).pathname, { redirect: 'manual' });
    assert.equal(hop.status, 302);
    assert.match(hop.headers.get('location'), /\/shop\/cart\/4401:2\?utm_source=knowbot&utm_medium=phone&utm_campaign=front-desk&utm_content=magnetic-dice-tray&ref=ai-voice-agent&attributes%5Bcall%5D=CA2&kb_cid=[a-z0-9]{10}$/);
    const rep = await S.kb.leads.report(['front-desk'], { days: 7 });
    assert.equal(rep.conversions.sent, 1, 'checkout link sent is recorded');
    assert.equal(rep.conversions.items[0].phone, PHONE);
    assert.equal(rep.conversions.items[0].itemsText, '2 x Magnetic Dice Tray');
    assert.equal(rep.conversions.clicks, 1, 'the click is tied back to the checkout link sent');
    assert.ok(rep.leads.some((l) => l.type === 'phone' && l.value === PHONE && l.consent === 'inbound_call'), 'the caller ID is a lead');
    assert.equal(t4.response.status, 'unavailable');
    assert.equal(t4.response.item_number, 2, 'the sold-out item is named by its place in the list');
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

  test('texts: at most 3 a day to one number across calls; foreign and premium-rate numbers refused', async () => {
    const smsTo = (to) => F.calls.filter((x) => x.path === '/twilio/2010-04-01/Accounts/AC1/Messages.json' && x.form?.To === to).length;
    const prior = smsTo(PHONE);
    assert.ok(prior <= 3);
    mode.current = 'texts';
    try {
      const at = G.sessions.length;
      const c = await startCall(S, 'front-desk', 'CA20');
      await until(() => c.closeCode != null, 15000, 'the texting call to end');
      const r = G.sessions[at].results.map((x) => x.response);
      for (let i = 0; i < 3; i++) {
        if (prior + i < 3) assert.equal(r[i].status, 'ok', JSON.stringify(r[i]));
        else assert.deepEqual(r[i], { status: 'error', retryable: false, reason: 'texts are limited' });
      }
      assert.equal(r[3].status, 'error');
      assert.match(r[3].reason, /same country/);
      assert.equal(r[4].status, 'error', 'premium-rate');
      // redialling does not reset it: the next call's first text is refused too
      const c2 = await startCall(S, 'front-desk', 'CA21');
      await until(() => c2.closeCode != null, 15000, 'the second texting call to end');
      assert.deepEqual(G.sessions[at + 1].results[0].response, { status: 'error', retryable: false, reason: 'texts are limited' });
      assert.equal(smsTo(PHONE), 3);
      assert.equal(smsTo('+447700900123') + smsTo('+19005551234'), 0);
    } finally { mode.current = 'full'; }
  });

  test('grounding: a spoken price with no search is logged and flagged ungrounded in the questions loop; a searched answer is not', async () => {
    const caller = '+14155550142';
    mode.current = 'ungrounded';
    try {
      const c = await startCall(S, 'front-desk', 'CA22', caller);
      await until(() => c.closeCode != null, 15000, 'the call to end');
    } finally { mode.current = 'full'; }
    assert.ok(S.logs.some((l) => /\[voice-live\] CA22 ungrounded turn/.test(l)), S.logs.filter((l) => /voice-live/.test(l)).join('\n'));
    const flagged = await until(async () => { await flushQuestions(); const f = [...S.kd.files.values()].filter((x) => x.tags.includes('flag:ungrounded')); return f.length ? f : null; }, 5000, 'a flagged question');
    assert.equal(flagged.length, 1, 'only the turn with no search');
    assert.ok(flagged[0].tags.includes('channel:phone') && flagged[0].tags.includes('bot:front-desk') && flagged[0].tags.includes(`from:${hashCaller(caller)}`));
    assert.match(flagged[0].text, /walnut dice tray/);
    assert.match(flagged[0].text, /Flagged: ungrounded/);
  });

  test('a caller redialling fast gets no stream token (busy, hang up)', async () => {
    const from = '+14155550177';
    let last = '';
    for (let i = 0; i < 13; i++) last = await (await S.twilio('/v1/channels/front-desk/voice', { CallSid: `CR${i}`, From: from })).text();
    assert.match(last, /<Say [^>]*>This line is busy right now\. Please call back in a minute\.<\/Say><Hangup\/>/);
    assert.ok(!/<Stream|token/.test(last));
  });

  test('concurrency: over the per-bot cap the media stream is closed with 1013 before a Gemini session opens', async () => {
    mode.current = 'idle';
    const open = [];
    try {
      const at = G.sessions.length;
      open.push(await startCall(S, 'front-desk', 'CA30'), await startCall(S, 'front-desk', 'CA31'));
      await until(() => G.sessions.length === at + 2 && phoneSessions().byBot['front-desk'] === 2, 5000, 'two open calls');
      const third = await startCall(S, 'front-desk', 'CA32');
      assert.equal(await third.closed, 1013);
      await sleep(100);
      assert.equal(G.sessions.length, at + 2, 'no Gemini session for the refused call');
      assert.ok(S.logs.some((l) => /CA32 refused: too many phone sessions/.test(l)));
    } finally {
      mode.current = 'full';
      for (const c of open) { c.send({ event: 'stop', streamSid: 'MZ1' }); await c.closed; }
    }
    assert.equal(phoneSessions().byBot['front-desk'], undefined, 'closed calls are counted down');
  });

  test('"Send me this" switched off for the bot: no send_info tool, no offer in the greeting, and the prompt says it plainly', async () => {
    const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
    const setBot = async (sendInfo) => assert.equal((await S.api('/api/instances/front-desk', { method: 'PATCH', headers: admin, body: JSON.stringify({ sendInfo }) })).status, 200);
    mode.current = 'idle';
    try {
      await setBot({ on: false });
      const at = G.sessions.length;
      const c = await startCall(S, 'front-desk', 'CA50');
      await until(() => G.sessions[at]?.setup, 5000, 'setup');
      c.send({ event: 'stop', streamSid: 'MZ1' });
      await c.closed;
      const setup = G.sessions[at].setup;
      assert.ok(!setup.tools[0].functionDeclarations.some((f) => f.name === 'send_info'));
      const p = setup.systemInstruction.parts[0].text;
      assert.match(p, /This bot doesn't send messages/);
      assert.doesNotMatch(p, /I can send you/);
      // texts only off (this line can only text): the same, the bot never offers
      await setBot({ on: true, text: false });
      const c2 = await startCall(S, 'front-desk', 'CA51');
      await until(() => G.sessions[at + 1]?.setup, 5000, 'setup 2');
      c2.send({ event: 'stop', streamSid: 'MZ1' });
      await c2.closed;
      assert.ok(!G.sessions[at + 1].setup.tools[0].functionDeclarations.some((f) => f.name === 'send_info'));
    } finally { await setBot({ on: true, email: true, text: true }); mode.current = 'full'; }
  });

  test('launch: a Shopify-imported trial keeps texted links on its launched bot; SHOP_DOMAIN never reaches an unrelated bot', async () => {
    const admin = { authorization: 'Bearer dev-admin', 'content-type': 'application/json' };
    for (const name of ['Shop Bot', 'Clinic']) assert.equal((await S.api('/api/instances', { method: 'POST', headers: admin, body: JSON.stringify({ name, buckets: ['acme'] }) })).status, 201);
    const tr = await (await S.api('/api/studio/trials', { method: 'POST' })).json();
    const T = S.kb.studio.trials.get(tr.trialId);
    T.flags.storeLast = { at: new Date().toISOString(), url: `${F.url}/shop`, platform: 'shopify', name: 'Acme Store', files: 3 };
    const conv = await S.api(`/api/studio/trials/${tr.trialId}/convert`, { method: 'POST', headers: admin, body: JSON.stringify({ account: 'acct1', bucketId: 'shopb', bot: 'shop-bot' }) });
    assert.equal(conv.status, 200);
    const cj = await conv.json();
    assert.equal(cj.shopDomain, `${F.url}/shop`);
    assert.equal(cj.bot, 'shop-bot');
    assert.equal((await (await S.api('/api/instances/shop-bot', { headers: admin })).json()).shopDomain, `${F.url}/shop`);
    assert.equal((await (await S.api('/v1/channels/shop-bot')).json()).channels.voice.texts, true);
    assert.equal((await (await S.api('/v1/channels/clinic')).json()).channels.voice.texts, false, 'SHOP_DOMAIN is set, but only for front-desk');
    mode.current = 'idle';
    try {
      const at = G.sessions.length;
      for (const [bot, sid, n] of [['shop-bot', 'CA40', 0], ['clinic', 'CA41', 1]]) {
        const c = await startCall(S, bot, sid);
        await until(() => G.sessions[at + n]?.setup, 5000, `${bot} setup`);
        c.send({ event: 'stop', streamSid: 'MZ1' });
        await c.closed;
      }
      const names = (k) => G.sessions[at + k].setup.tools[0].functionDeclarations.map((f) => f.name);
      assert.deepEqual(names(0), ['search_knowledge_base', 'send_product_link', 'send_info', 'end_call']);
      assert.deepEqual(names(1), ['search_knowledge_base', 'send_info', 'end_call']);
      assert.ok(!/send_product_link/.test(G.sessions[at + 1].setup.systemInstruction.parts[0].text));
    } finally { mode.current = 'full'; }
  });
});

describe('voice-live: no GEMINI_API_KEY means the phone line is not set up (no classic engine, no ElevenLabs)', () => {
  let N, C, F;
  before(async () => {
    _resetQuestions();
    F = await startFakeProviders();
    N = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret' });
    // the removed settings change nothing: still not set up, no <Gather> loop, no ElevenLabs request
    C = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret', KNOWBOT_PHONE_ENGINE: 'classic', ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_VOICE_ID: 'voice1', ELEVENLABS_BASE_URL: `${F.url}/eleven` });
  });
  after(async () => { _resetQuestions(); await N.close(); await C.close(); await F.close(); });

  test('the webhook says politely that the line is not set up yet and hangs up; nothing is answered or logged', async () => {
    for (const S of [N, C]) {
      const xml = await (await S.twilio('/v1/channels/front-desk/voice', { CallSid: 'CA6', From: PHONE })).text();
      assert.equal(xml, `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say voice="Polly.Joanna-Neural" language="en-US">${PHONE_NOT_SET_UP.replace(/'/g, '&apos;')}</Say><Hangup/></Response>`);
      // even with a question already in the first POST
      const withSpeech = await (await S.twilio('/v1/channels/front-desk/voice', { CallSid: 'CA7', From: PHONE, SpeechResult: Q })).text();
      assert.ok(!/<Gather|<Record|<Play|<Stream|According to/.test(withSpeech), withSpeech);
      assert.match(withSpeech, /<Hangup\/>/);
      // the classic steps no longer exist
      for (const sub of ['answer?empty=0', 'recording?empty=0']) assert.equal((await S.twilio(`/v1/channels/front-desk/voice/${sub}`, { CallSid: 'CA6', From: PHONE, SpeechResult: Q })).status, 404, sub);
      assert.equal((await S.api('/v1/channels/front-desk/voice/audio/abcdefghijkl.mp3')).status, 404);
      // unsigned is still refused
      assert.equal((await S.twilio('/v1/channels/front-desk/voice', { CallSid: 'CA6', From: PHONE }, { sign: false })).status, 403);
    }
    assert.ok(!F.calls.some((c) => c.path.startsWith('/eleven/')), 'ElevenLabs is never called');
    assert.ok(N.logs.some((l) => /voice: call on bot front-desk declined: the phone line is not set up/.test(l)));
    await flushQuestions();
    assert.ok(![...N.kd.files.values(), ...C.kd.files.values()].some((f) => f.tags.includes('channel:phone')), 'no phone question logged');
  });

  test('GET /v1/channels: engine not_configured (never classic or elevenlabs); the media WebSocket is refused (503)', async () => {
    for (const S of [N, C]) {
      const st = await (await S.api('/v1/channels/front-desk')).json();
      assert.equal(st.channels.voice.engine, 'not_configured');
      assert.equal(st.channels.voice.configured, false);
      assert.deepEqual(st.channels.voice.needs, ['GEMINI_API_KEY']);
      assert.equal(st.channels.voice.mediaStream, undefined);
      assert.equal(st.channels.voice.texts, false);
      assert.ok(!/classic|elevenlabs/i.test(JSON.stringify(st)), JSON.stringify(st.channels.voice));
      const w = new WebSocket(`${S.wsBase}/api/v1/channels/front-desk/voice/media`);
      await new Promise((r) => { w.addEventListener('error', r); w.addEventListener('close', r); });
      assert.notEqual(w.readyState, 1);
    }
  });
});

describe('voice-live: the call length limit', () => {
  let S, F, G;
  before(async () => {
    F = await startFakeProviders();
    G = await startFakeGemini(async ({ send, next, s }) => {
      await next('text'); // [call connected]
      const nudge = await next('text'); // the time-limit message
      s.nudge = nudge.realtimeInput.text;
      send({ serverContent: { outputTranscription: { text: "We're out of time for this call. Thanks for calling, goodbye!" }, modelTurn: { parts: [{ inlineData: { data: pcm24k(300).toString('base64') } }] } } });
      send({ serverContent: { turnComplete: true } });
    });
    S = await boot({ TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_BASE_URL: `${F.url}/twilio`, GEMINI_API_KEY: 'gkey', GEMINI_LIVE_URL: G.url, KNOWBOT_PHONE_MAX_SECONDS: '0.5' });
  });
  after(async () => { await S.close(); await G.close(); await F.close(); });

  test('at KNOWBOT_PHONE_MAX_SECONDS the agent is told to say goodbye, the goodbye plays, then the call is hung up', async () => {
    const c = await startCall(S, 'front-desk', 'CA50');
    await until(() => c.closeCode != null, 10000, 'the call to be ended by the limit');
    const s = G.sessions.at(-1);
    assert.match(s.nudge, /^\[time limit\]/);
    assert.ok(c.got.some((m) => m.event === 'media'), 'the goodbye audio reached the caller');
    assert.ok(c.got.some((m) => m.event === 'mark' && /^hangup-\d+$/.test(m.mark.name)));
    assert.equal(F.calls.find((x) => x.path === '/twilio/2010-04-01/Accounts/AC1/Calls/CA50.json')?.form?.Status, 'completed');
    assert.ok(S.logs.some((l) => /CA50 reached the 0\.5 s call limit/.test(l)));
    assert.equal(phoneSessions().byBot['front-desk'], undefined);
  });
});

// Phone channel, voice-to-voice engine (ported from the voice-agent demo's src/gemini-live.js + src/audio.js):
// Twilio Media Streams ⇄ Gemini Live, for ANY KnowBot (a Studio trial bot or a launched bot).
//
//   POST /v1/channels/:botId/voice   (signed)  → <Connect><Stream url="wss://…/v1/channels/:botId/voice/media"> with a
//                                                 one-time token (voice.mjs, when GEMINI_API_KEY is set)
//   GET  /v1/channels/:botId/voice/media (WebSocket upgrade) → this module: Twilio sends 8 kHz μ-law audio, Gemini Live
//                                                 listens and speaks (16 kHz PCM in, 24 kHz PCM out); no STT/TTS step.
//
// Grounding: the model must call search_knowledge_base before any answer. That tool runs the bot's OWN answer pipeline
// (devapi.mjs answer(): the bot's sources and scope, the librarian voice, the citation gate, the canonical refusal) and
// returns the answer already spoken with its attribution ("According to the Shipping page, …"). The model reads that,
// never its own knowledge. Each search is logged to the questions loop with channel 'phone'.
// Tools: search_knowledge_base, end_call (hang up after the goodbye), send_product_link (only when the bot has a Shopify
// store: see shop.mjs; at most 3 texts per call).
// Security: the media WebSocket must present, in its first "start" message, the one-time token the signed webhook issued
// for that CallSid and bot; anything else is closed before a Gemini session is opened.
// Settings (names only): GEMINI_API_KEY, GEMINI_LIVE_MODEL (default gemini-3.8-live), GEMINI_VOICE (default Kore),
// GEMINI_LIVE_URL (tests / proxies), TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (hang-up, texts), TWILIO_FROM_NUMBER (texts).
import { randomUUID } from 'node:crypto';
import { NOT_IN_DATA, formatSpoken, humanTitle } from './util.mjs';
import { createShop, toE164, handleInText, textableNumber } from './shop.mjs';

// ------------------------------------------------------------------ audio (Twilio 8 kHz μ-law ⇄ Gemini PCM16 LE)
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  MULAW_DECODE[i] = u & 0x80 ? -magnitude : magnitude;
}
export const mulawDecode = (byte) => MULAW_DECODE[byte & 0xff];
export function mulawEncode(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(sign ? -sample : sample, MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
/**
 * Twilio inbound media (base64 μ-law, 8 kHz) → base64 PCM16 at 16 kHz (2x by linear interpolation), one converter per
 * call: each output pair is (midpoint of the previous and this sample, this sample), and the previous sample carries over
 * from the last chunk, so the 20 ms chunk boundaries are interpolated like any other pair (no 50 Hz step).
 */
export function createTwilioToGemini() {
  let prev = null;
  return function convert(base64Mulaw) {
    const mulaw = Buffer.from(base64Mulaw, 'base64');
    const out = Buffer.alloc(mulaw.length * 4);
    for (let i = 0; i < mulaw.length; i++) {
      const b = MULAW_DECODE[mulaw[i]];
      const a = prev == null ? b : prev;
      out.writeInt16LE((a + b) >> 1, i * 4);
      out.writeInt16LE(b, i * 4 + 2);
      prev = b;
    }
    return out.toString('base64');
  };
}
/** One chunk on its own (no carry-over); calls use createTwilioToGemini(). */
export const twilioToGemini = (base64Mulaw) => createTwilioToGemini()(base64Mulaw);
/**
 * Gemini output (base64 PCM16, 24 kHz) → base64 μ-law at 8 kHz for Twilio: 3x down by averaging each group of three
 * samples (a cheap low-pass). Leftover samples, and a trailing odd byte, carry over to the next chunk, so no audio is
 * dropped or misaligned however Gemini splits its chunks.
 */
export function createGeminiToTwilio() {
  let carry = new Int16Array(0);
  let oddByte = null; // the first half of a sample split across two chunks
  return function convert(base64Pcm) {
    let bytes = Buffer.from(base64Pcm, 'base64');
    if (oddByte != null) { bytes = Buffer.concat([Buffer.from([oddByte]), bytes]); oddByte = null; }
    const even = bytes.length & ~1;
    if (even < bytes.length) oddByte = bytes[even];
    const incoming = new Int16Array(even / 2);
    for (let i = 0; i < incoming.length; i++) incoming[i] = bytes.readInt16LE(i * 2);
    const samples = new Int16Array(carry.length + incoming.length);
    samples.set(carry);
    samples.set(incoming, carry.length);
    const frames = Math.floor(samples.length / 3);
    const out = Buffer.alloc(frames);
    for (let i = 0; i < frames; i++) {
      const j = i * 3;
      out[i] = mulawEncode(Math.round((samples[j] + samples[j + 1] + samples[j + 2]) / 3));
    }
    carry = samples.slice(frames * 3);
    return out.toString('base64');
  };
}

// ------------------------------------------------------------------ one-time stream tokens
// Issued by the signed incoming-call webhook, claimed once when Twilio opens the media WebSocket (so random clients
// can't open, and run up, Gemini sessions). The caller's number is kept here, never trusted from the stream itself.
const streamTokens = new Map();
const TOKEN_TTL_MS = 60_000;
export function issueStreamToken({ callSid, botId, from = '' }) {
  const token = randomUUID();
  streamTokens.set(token, { callSid: String(callSid || ''), botId: String(botId || ''), from: String(from || ''), at: Date.now() });
  const t = setTimeout(() => streamTokens.delete(token), TOKEN_TTL_MS);
  t.unref?.();
  return token;
}
/** → { callSid, botId, from } once, for the call and bot it was issued for; null otherwise (and the token is spent). */
export function claimStreamToken(token, callSid, botId) {
  const rec = streamTokens.get(String(token || ''));
  streamTokens.delete(String(token || ''));
  if (!rec || Date.now() - rec.at > TOKEN_TTL_MS) return null;
  if (!rec.callSid || rec.callSid !== String(callSid || '') || rec.botId !== String(botId || '')) return null;
  return rec;
}

// ------------------------------------------------------------------ prompt + tools
export const MAX_TEXTS_PER_CALL = 3;
export function greetingFor(botName) {
  const name = botName ? `${botName}. ` : '';
  return `Hi, you've reached ${name}I answer from my files and tell you where each answer comes from. What would you like to know?`;
}

export function systemInstruction({ botName, org, productLinks = false }) {
  const who = botName || 'KnowBot';
  const orgName = org || botName || 'this business';
  const base = `You are ${who}, the phone assistant for ${orgName}, speaking with a caller on a live phone call. You are a kind librarian: you answer only from ${orgName}'s own files and you say which file each answer comes from.

Grounding rules:
- Before answering ANY question, call search_knowledge_base. Write the query as a complete standalone question, filling in anything the caller referred to earlier (for "how much is it?", name the product).
- The tool returns "say": the answer from the files, already worded for the phone and already naming its source ("According to the Shipping page, ..."). Speak it as given. You may leave out filler, but always keep the "According to ..." attribution, and never change, round or add any fact, number, date, price or name.
- If the tool returns status "not_in_data", say exactly: "${NOT_IN_DATA}" Then offer to help with something else.
- Never answer from general knowledge, never guess, and never answer a question you did not search for.

Speaking style:
- Short replies; the caller can ask a follow-up.
- Never read out file names, URLs, citation numbers or links.
- If the question is unclear, ask one short clarifying question.
- While a search is running, say at most a few words such as "One moment."

Call flow:
- The call starts with a message like "[call connected] Caller's number ends in 0378." Greet the caller with: "${greetingFor(botName)}"
- When the caller says goodbye or that they're done, say a short goodbye and then call end_call.`;
  if (!productLinks) return base;
  return `${base}

Texting product links:
- After you've answered about a specific product the caller seems interested in, you may offer once to text them a link that puts it in their cart and opens checkout. Vary the wording; don't push, and don't offer again if they declined.
- Before sending, know which version they want (color, size, ...) and how many. If you don't know, ask.
- Texts go to the number they're calling from unless they give another. Confirm first using the last four digits you were given ("to the number ending in 0378?"). If they give a different number, read it back and get a yes.
- Then call send_product_link with the product's handle (from the store page address in the search sources) or its name, the version, the quantity, and phone_number only if they gave a different one.
- If the tool asks for a version, ask the caller. If the version is sold out, say so and offer an in-stock one. When it succeeds, say it's on its way and that the link opens checkout with the item already in the cart.
- Never read out the link itself.`;
}

export function toolDeclarations({ org, productLinks = false }) {
  const orgName = org || 'this business';
  const fns = [
    { name: 'search_knowledge_base', description: `Search ${orgName}'s own files and get the answer to speak, with its source. Required before answering any question.`,
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A complete, standalone question in plain English.' } }, required: ['query'] } },
    { name: 'end_call', description: 'Hang up after you have said goodbye to the caller.', parameters: { type: 'OBJECT', properties: {} } },
  ];
  if (productLinks) {
    fns.splice(1, 0, { name: 'send_product_link', description: 'Text the caller a link that adds a product to their cart and opens checkout. Only after the caller agreed and confirmed the number.',
      parameters: { type: 'OBJECT', properties: {
        product: { type: 'STRING', description: "The product's handle (e.g. ultimate-bundle) or its store page URL; its name as a last resort." },
        variant: { type: 'STRING', description: 'The version the caller wants, in plain words (e.g. "brown landscape"). Empty if there is only one.' },
        quantity: { type: 'INTEGER', description: 'How many. Default 1.' },
        phone_number: { type: 'STRING', description: "Only if the caller asked for a number other than the one they're calling from, as they said it." },
      }, required: ['product'] } });
  }
  return [{ functionDeclarations: fns }];
}

// ------------------------------------------------------------------ Twilio REST (hang-up, texts)
export function twilioRest(env = {}) {
  const sid = env.TWILIO_ACCOUNT_SID, tok = env.TWILIO_AUTH_TOKEN;
  const base = String(env.TWILIO_API_BASE_URL || 'https://api.twilio.com').replace(/\/+$/, '');
  const post = async (p, form) => {
    if (!sid || !tok) throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)');
    const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(sid)}${p}`, { method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  };
  return {
    canHangUp: !!(sid && tok),
    canText: !!(sid && tok && env.TWILIO_FROM_NUMBER),
    hangUp: (callSid) => post(`/Calls/${encodeURIComponent(callSid)}.json`, { Status: 'completed' }),
    sendSms: (to, body) => {
      if (!env.TWILIO_FROM_NUMBER) throw new Error('TWILIO_FROM_NUMBER is not set');
      return post('/Messages.json', { From: env.TWILIO_FROM_NUMBER, To: to, Body: body });
    },
  };
}

// ------------------------------------------------------------------ tools (shared by the call bridge and scripts/voice-live-test.mjs)
/**
 * @param {object} o
 * @param {(q: string) => Promise<object>} o.ask      the bot's answer pipeline (logs the question with channel 'phone')
 * @param {(q: string) => Promise<{text:string,file?:string,url?:string}[]>} [o.searchRaw]  retrieval only (no log), for handle lookup
 * @param {string|null} [o.shopDomain]  product links on when set
 * @param {(to: string) => boolean} [o.textAllowed]  per-destination / per-bot text quota (devapi.mjs); false → 'texts are limited'
 */
export function createToolRunner({ ask, searchRaw = null, callSid = '', callerNumber = '', sendSms = null, shopDomain = null, textAllowed = null, env = {}, botName = '', org = '', log = () => {} }) {
  let textsSent = 0;
  const seen = []; // retrieved text this call (citation excerpts + urls), for product handle lookup
  const answers = []; // {query, refused, spoken, citations:[{n,title,file}]} for the call log
  const names = [botName, org].filter(Boolean);
  const findHandle = async (name) => {
    const inSeen = (list) => {
      const want = new Set(String(name || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2));
      const scored = list.map((s) => ({ s, h: handleInText(`${s.url || ''}\n${s.text || ''}`, shopDomain) })).filter((x) => x.h)
        .map((x) => ({ ...x, score: [...want].filter((w) => `${x.h} ${x.s.title || ''} ${x.s.text || ''}`.toLowerCase().includes(w)).length }))
        .sort((a, b) => b.score - a.score);
      return scored[0]?.h || null;
    };
    const h = inSeen(seen);
    if (h || !searchRaw) return h;
    try { return inSeen(await searchRaw(`${name} product page`)); } catch { return null; }
  };
  const shop = shopDomain ? createShop({ domain: shopDomain, env, orgName: org || botName || 'the store', findHandle, log }) : null;

  async function runTool(call) {
    const args = call?.args || {};
    if (call?.name === 'search_knowledge_base') {
      const query = String(args.query || '').trim();
      if (!query) return { status: 'error', retryable: true, reason: 'Pass the caller\'s question as query.' };
      let r;
      try { r = await ask(query); } catch (e) { log(`[voice-live] ${callSid} search failed: ${e.message}`); return { status: 'error', retryable: false, reason: 'The files could not be searched right now.' }; }
      for (const c of r.citations || []) seen.push({ text: c.excerpt || '', url: c.url || '', file: c.file || '', title: humanTitle(c) });
      for (const h of r.proof?.hits || []) seen.push({ text: h.excerpt || '', file: h.file || '' });
      const spoken = r.refused ? NOT_IN_DATA : formatSpoken(r, 450, { names });
      answers.push({ query, refused: !!r.refused, spoken, citations: (r.citations || []).map((c) => ({ n: c.n, title: humanTitle(c), file: c.file })) });
      if (r.refused) return { status: 'not_in_data', say: NOT_IN_DATA };
      // only the answer to speak and the titles it came from: no raw excerpts (prices, figures) the model could read
      // from beyond the answer, and no page addresses (product handles come from this call's own `seen` list)
      return { status: 'ok', say: spoken, source_titles: [...new Set((r.citations || []).slice(0, 4).map((c) => humanTitle(c)))] };
    }
    if (call?.name === 'send_product_link') {
      if (!shop) return { status: 'error', retryable: false, reason: 'Product links are not set up for this bot.' };
      if (!sendSms) return { status: 'error', retryable: false, reason: 'Texting is not set up on this line.' };
      if (textsSent >= MAX_TEXTS_PER_CALL) return { status: 'error', retryable: false, reason: 'The text limit for this call has been reached.' };
      // the verified caller ID by default; a spoken number only in the same country as the sending line, never a
      // premium-rate or short-code range (texts are paid by the bot owner's Twilio account)
      const spoken = String(args.phone_number || '').trim();
      const own = toE164(callerNumber);
      const to = spoken && toE164(spoken) !== own ? textableNumber(spoken, env.TWILIO_FROM_NUMBER) : textableNumber(callerNumber, env.TWILIO_FROM_NUMBER);
      if (!to) {
        if (spoken) return { status: 'error', retryable: false, reason: `Texts can only go to a mobile number in the same country as this line${own ? ', or to the number they are calling from' : ''}.` };
        return { status: 'need_phone_number', reason: "There's no usable number for this caller. Ask for their mobile number and read it back." };
      }
      const link = await shop.buildProductLink({ product: args.product, variant: args.variant, quantity: args.quantity, callSid });
      if (link.status !== 'ok') return link;
      if (textAllowed && !textAllowed(to)) {
        log(`[voice-live] ${callSid} text to ***${to.slice(-4)} refused: texts are limited`);
        return { status: 'error', retryable: false, reason: 'texts are limited' };
      }
      try {
        await sendSms(to, shop.smsBody(link));
        textsSent += 1;
        log(`[voice-live] ${callSid} texted a ${link.kind} link for ${link.title}${link.variant ? ` (${link.variant})` : ''} to ***${to.slice(-4)}`);
        return { status: 'ok', sent_to_last_four: to.slice(-4), opens: link.kind === 'checkout' ? 'checkout with the item in the cart' : 'the product page', product: link.title, variant: link.variant };
      } catch (e) {
        log(`[voice-live] ${callSid} text failed: ${e.message}`);
        return { status: 'error', retryable: false, reason: "The text message couldn't be sent." };
      }
    }
    return null;
  }
  runTool.answers = answers;
  runTool.textsSent = () => textsSent;
  return runTool;
}

// ------------------------------------------------------------------ Gemini Live client (raw BidiGenerateContent over WebSocket)
const GEMINI_LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export function geminiSettings(env = {}) {
  return { apiKey: env.GEMINI_API_KEY || '', model: env.GEMINI_LIVE_MODEL || 'gemini-3.8-live', voice: env.GEMINI_VOICE || 'Kore', url: env.GEMINI_LIVE_URL || GEMINI_LIVE_URL };
}
/**
 * Opens a Live session and resolves once the server sent setupComplete.
 * → { sendAudio(base64Pcm16k), sendText(text), sendToolResponse(functionResponses), close() }
 */
export function connectGemini(env, { systemInstruction: sys, tools, onMessage, onClose, timeoutMs = 10000 }) {
  const g = geminiSettings(env);
  if (!g.apiKey) return Promise.reject(new Error('GEMINI_API_KEY is not set'));
  if (typeof WebSocket !== 'function') return Promise.reject(new Error('this Node has no global WebSocket (Node 22+ needed)'));
  return new Promise((resolve, reject) => {
    const u = new URL(g.url);
    u.searchParams.set('key', g.apiKey);
    const ws = new WebSocket(u.href);
    ws.binaryType = 'arraybuffer';
    let ready = false;
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const session = {
      sendAudio: (data) => send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }),
      sendText: (text) => send({ realtimeInput: { text } }),
      sendToolResponse: (functionResponses) => send({ toolResponse: { functionResponses } }),
      close: () => { try { ws.close(1000); } catch {} },
    };
    const timer = setTimeout(() => { if (!ready) { try { ws.close(); } catch {} reject(new Error('Gemini Live did not finish setup in time')); } }, timeoutMs);
    ws.addEventListener('open', () => {
      send({ setup: {
        model: g.model.startsWith('models/') ? g.model : `models/${g.model}`,
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: g.voice } } } },
        systemInstruction: { parts: [{ text: sys }] },
        tools,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      } });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (msg.setupComplete && !ready) { ready = true; clearTimeout(timer); resolve(session); return; }
      onMessage?.(msg);
    });
    ws.addEventListener('error', (e) => { if (!ready) { clearTimeout(timer); reject(new Error(`Gemini Live connection failed${e?.message ? `: ${e.message}` : ''}`)); } });
    ws.addEventListener('close', (e) => { clearTimeout(timer); if (!ready) reject(new Error(`Gemini Live closed during setup (${e.code}${e.reason ? ` ${e.reason}` : ''})`)); else onClose?.(e); });
  });
}

// ------------------------------------------------------------------ cost limits (every open call holds a Gemini Live session)
// KNOWBOT_PHONE_MAX_SECONDS (default 900): a call is wrapped up with a goodbye and hung up at this length.
// KNOWBOT_PHONE_MAX_SESSIONS (default 50) open phone sessions on this server; KNOWBOT_PHONE_MAX_SESSIONS_PER_BOT (default 5)
// for one bot. Over a cap the media stream is closed with 1013 (try again later) before any Gemini session opens.
// (voice.mjs also rate-limits each caller before it issues a stream token.)
const phoneActive = { total: 0, byBot: new Map() };
export function phoneLimits(env = {}) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { maxSeconds: n(env.KNOWBOT_PHONE_MAX_SECONDS, 900), maxSessions: n(env.KNOWBOT_PHONE_MAX_SESSIONS, 50), maxPerBot: n(env.KNOWBOT_PHONE_MAX_SESSIONS_PER_BOT, 5) };
}
/** Open phone sessions now: { total, byBot: {botId: n} } (tests and status). */
export const phoneSessions = () => ({ total: phoneActive.total, byBot: Object.fromEntries(phoneActive.byBot) });

// ------------------------------------------------------------------ grounding check
// The prompt says "never answer without searching"; this is the server-side check. A spoken turn with a figure (a digit,
// a currency sign, a percentage or a date word) and no search_knowledge_base call since the caller last spoke is an
// ungrounded turn: logged, and added to the questions loop flagged 'ungrounded' (cx.onUngrounded).
const MONTHS = 'january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const FIGURE_RE = new RegExp(`\\d|[$€£¥]|\\bpercent\\b|\\b(?:${MONTHS}|dollars?|cents?|euros?|pounds?)\\b`, 'i');
export function hasFigure(text, { lastFour = '' } = {}) {
  let t = String(text || '');
  if (lastFour) t = t.split(lastFour).join(' '); // reading back the caller's own last four digits is not a fact from the files
  return FIGURE_RE.test(t);
}

// ------------------------------------------------------------------ the call bridge
/**
 * Handles one Twilio Media Streams WebSocket for the length of a call.
 * @param {import('./ws.mjs').ServerSocket} twilioWs
 * @param {object} cx { env, botId, botName, org, ask, searchRaw, shopDomain, textAllowed?, log, onStart?, onEnd?, onUngrounded? }
 */
export function handleMediaStream(twilioWs, cx) {
  const { env, log = () => {} } = cx;
  const rest = twilioRest(env);
  const lim = phoneLimits(env);
  const botKey = String(cx.botId || '');
  let streamSid = null, callSid = null, callerNumber = '';
  let session = null, sessionReady = false, pendingAudio = [];
  let toTwilio = createGeminiToTwilio();
  const toGemini = createTwilioToGemini();
  let hangupRequested = false, hangupMark = 0, hungUp = false, started = false, closed = false, counted = false;
  let lifeTimer = null;
  let callerText = '', agentText = '';
  let searchedSinceCaller = false, callerTurnOpen = true;
  let runShared = null;
  const transcript = []; // {role:'caller'|'agent', text}
  const ungrounded = []; // {question, text}

  const sendToTwilio = (msg) => { if (twilioWs.readyState === 1) twilioWs.send(JSON.stringify(msg)); };
  const closeAll = () => {
    if (closed) return;
    closed = true;
    clearTimeout(startTimer);
    clearTimeout(lifeTimer);
    if (counted) {
      counted = false;
      phoneActive.total = Math.max(0, phoneActive.total - 1);
      const n = (phoneActive.byBot.get(botKey) || 1) - 1;
      if (n > 0) phoneActive.byBot.set(botKey, n); else phoneActive.byBot.delete(botKey);
    }
    try { session?.close(); } catch {}
    if (twilioWs.readyState === 1) twilioWs.close(1000, 'call ended');
    cx.onEnd?.({ callSid, transcript, answers: runShared?.answers || [], textsSent: runShared?.textsSent?.() || 0, ungrounded });
  };
  // a socket that never sends a valid "start" is closed (no Gemini session is ever opened for it)
  const startTimer = setTimeout(() => { if (!started) { log('[voice-live] media stream closed: no start message'); closeAll(); } }, Number(cx.startTimeoutMs || 10000));
  startTimer.unref?.();

  async function hangUp() {
    if (hungUp) return;
    hungUp = true;
    if (!rest.canHangUp || !callSid) return closeAll();
    try { await rest.hangUp(callSid); } catch (e) { log(`[voice-live] ${callSid} hang-up failed: ${e.message}`); }
    closeAll();
  }
  const queueHangupMark = () => { hangupMark += 1; sendToTwilio({ event: 'mark', streamSid, mark: { name: `hangup-${hangupMark}` } }); };

  async function runTool(call) {
    if (call.name === 'end_call') {
      hangupRequested = true;
      // hang up once Twilio has played everything queued so far (it echoes the mark); a fallback timer covers a lost mark
      queueHangupMark();
      setTimeout(hangUp, Number(cx.hangupFallbackMs || 10000)).unref?.();
      return { status: 'ok', note: 'The call will end after your goodbye finishes playing.' };
    }
    if (call.name === 'search_knowledge_base') {
      searchedSinceCaller = true;
      if (!call.args?.query && callerText.trim()) call.args = { ...call.args, query: callerText.trim() };
    }
    return (await runShared?.(call)) ?? { status: 'error', reason: `Unknown tool ${call.name}` };
  }

  function onGeminiMessage(msg) {
    if (msg.toolCall?.functionCalls?.length) {
      Promise.all(msg.toolCall.functionCalls.map(async (call) => {
        log(`[voice-live] ${callSid} tool ${call.name}(${JSON.stringify(call.args || {}).slice(0, 200)})`);
        let response;
        try { response = await runTool(call); } catch (e) { response = { status: 'error', reason: e.message }; }
        return { id: call.id, name: call.name, response };
      })).then((functionResponses) => { try { session?.sendToolResponse(functionResponses); } catch (e) { log(`[voice-live] tool response failed: ${e.message}`); } });
      return;
    }
    const c = msg.serverContent;
    if (!c) return;
    if (c.inputTranscription?.text) {
      // the caller speaking again after the agent finished a turn starts a new question: it needs a new search
      if (!callerTurnOpen) { callerTurnOpen = true; searchedSinceCaller = false; }
      callerText += c.inputTranscription.text;
    }
    if (c.outputTranscription?.text) agentText += c.outputTranscription.text;
    if (c.interrupted) { sendToTwilio({ event: 'clear', streamSid }); toTwilio = createGeminiToTwilio(); }
    for (const part of c.modelTurn?.parts || []) {
      const data = part.inlineData?.data;
      if (!data) continue;
      const payload = toTwilio(data);
      if (payload) sendToTwilio({ event: 'media', streamSid, media: { payload } });
    }
    if (c.turnComplete) {
      if (hangupRequested) queueHangupMark();
      if (!agentText.trim()) return; // a turn that only issued a tool call: keep the caller's words for the answer turn
      const said = agentText.trim(), asked = callerText.trim();
      if (asked) transcript.push({ role: 'caller', text: asked });
      transcript.push({ role: 'agent', text: said });
      if (!searchedSinceCaller && hasFigure(said, { lastFour: toE164(callerNumber)?.slice(-4) || '' })) {
        log(`[voice-live] ${callSid} ungrounded turn: spoke a figure with no search since the caller's last question`);
        const u = { question: asked, text: said };
        ungrounded.push(u);
        try { cx.onUngrounded?.(u); } catch (e) { log(`[voice-live] ungrounded log failed: ${e.message}`); }
      }
      callerTurnOpen = false;
      callerText = ''; agentText = '';
    }
  }

  async function openSession() {
    const productLinks = !!cx.shopDomain && rest.canText;
    session = await connectGemini(env, {
      systemInstruction: systemInstruction({ botName: cx.botName, org: cx.org, productLinks }),
      tools: toolDeclarations({ org: cx.org || cx.botName, productLinks }),
      onMessage: onGeminiMessage,
      onClose: () => { sessionReady = false; closeAll(); },
    });
    if (closed) { session.close(); return; }
    sessionReady = true;
    for (const data of pendingAudio) session.sendAudio(data);
    pendingAudio = [];
    const lastFour = toE164(callerNumber)?.slice(-4);
    session.sendText(lastFour ? `[call connected] Caller's number ends in ${lastFour}.` : "[call connected] Caller's number is unknown.");
  }

  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    switch (msg.event) {
      case 'start': {
        if (started) break;
        const rec = claimStreamToken(msg.start?.customParameters?.token, msg.start?.callSid, cx.botId);
        if (!rec) { log(`[voice-live] rejected a media stream for ${String(msg.start?.callSid || '?').slice(0, 40)}: bad, spent or missing token`); closed = true; clearTimeout(startTimer); twilioWs.close(1008, 'bad token'); return; }
        started = true;
        clearTimeout(startTimer);
        if (phoneActive.total >= lim.maxSessions || (phoneActive.byBot.get(botKey) || 0) >= lim.maxPerBot) {
          log(`[voice-live] ${rec.callSid} refused: too many phone sessions (${phoneActive.total} open, ${phoneActive.byBot.get(botKey) || 0} for bot ${botKey})`);
          closed = true;
          twilioWs.close(1013, 'busy');
          return;
        }
        phoneActive.total += 1; phoneActive.byBot.set(botKey, (phoneActive.byBot.get(botKey) || 0) + 1); counted = true;
        streamSid = msg.start.streamSid;
        callSid = rec.callSid;
        callerNumber = rec.from; // from the signed webhook, never from the stream
        // the call's time limit: ask for a short goodbye, then hang up once it has played (or after the fallback)
        lifeTimer = setTimeout(() => {
          if (closed || hungUp) return;
          log(`[voice-live] ${callSid} reached the ${lim.maxSeconds} s call limit`);
          if (!sessionReady) return hangUp();
          hangupRequested = true;
          try { session.sendText('[time limit] The call has reached its time limit. Tell the caller, say a short goodbye now, and do not call any tools.'); } catch {}
          setTimeout(hangUp, Number(cx.hangupFallbackMs || 10000)).unref?.();
        }, lim.maxSeconds * 1000);
        lifeTimer.unref?.();
        cx.onStart?.({ callSid, from: callerNumber });
        runShared = createToolRunner({ ask: cx.ask, searchRaw: cx.searchRaw, callSid, callerNumber, sendSms: rest.canText ? rest.sendSms : null,
          shopDomain: rest.canText ? cx.shopDomain : null, textAllowed: cx.textAllowed || null, env, botName: cx.botName, org: cx.org, log });
        log(`[voice-live] ${callSid} media stream started (bot ${cx.botId})`);
        openSession().catch((e) => { log(`[voice-live] ${callSid} could not open a Gemini session: ${e.message}`); closeAll(); });
        break;
      }
      case 'media': {
        if (!started || (msg.media?.track && msg.media.track !== 'inbound') || !msg.media?.payload) break;
        const data = toGemini(msg.media.payload);
        if (sessionReady) session.sendAudio(data);
        else if (pendingAudio.length < 250) pendingAudio.push(data); // ~5 s while the session opens
        break;
      }
      case 'mark':
        if (hangupRequested && msg.mark?.name === `hangup-${hangupMark}`) hangUp();
        break;
      case 'stop':
        closeAll();
        break;
      default:
    }
  });
  twilioWs.on('close', () => closeAll());
  return { transcript, get callSid() { return callSid; } };
}

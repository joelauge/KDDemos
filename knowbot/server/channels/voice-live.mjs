// Phone channel, voice-to-voice engine (ported from the voice-agent demo's src/gemini-live.js + src/audio.js):
// Twilio Media Streams ⇄ Gemini Live, for ANY KnowBot (a Studio trial bot or a launched bot).
//
//   POST /v1/channels/:botId/voice   (signed)  → <Connect><Stream url="wss://…/v1/channels/:botId/voice/media"> with a
//                                                 one-time token (voice.mjs; needs GEMINI_API_KEY)
//   GET  /v1/channels/:botId/voice/media (WebSocket upgrade) → this module: Twilio sends 8 kHz μ-law audio, Gemini Live
//                                                 listens and speaks (16 kHz PCM in, 24 kHz PCM out); no STT/TTS step.
//
// Grounding: the model must call search_knowledge_base before any answer. That tool runs the bot's OWN answer pipeline
// (devapi.mjs answer(): the bot's sources and scope, the librarian voice, the citation gate, the canonical refusal) and
// returns (voice-brain.mjs toolAnswer) a short spoken-style answer the model may rephrase, the rest ("more", offered
// rather than read), and the exact facts it may not change; never its own knowledge. Each search is logged to the
// questions loop with channel 'phone'. Natural conversation (voice-brain.mjs): an acknowledgement while it searches (the
// search runs NON_BLOCKING where the model supports it), a search started on the caller's partial words (reused when the
// final question matches), instant answers for the bot's most-asked questions, a facts guard on what was said, read-back
// before anything is sent, message-taking and callback requests (leads), and a hand-off to a person in business hours
// (transfer_call: Twilio REST updates the live call with <Dial>, only after the caller said yes, once the line played).
// Tools: search_knowledge_base, end_call (hang up after the goodbye), send_product_link (only when the bot has a Shopify
// store: see shop.mjs; items[] of up to 5 products in ONE cart link; at most 3 texts per call), send_info ("send me this":
// the last answer from the files, by text or e-mail, through server/sendinfo.mjs; offered only when the server can send).
// This is the phone channel's only engine: without GEMINI_API_KEY the call webhook says the line isn't set up and hangs up.
// Security: the media WebSocket must present, in its first "start" message, the one-time token the signed webhook issued
// for that CallSid and bot; anything else is closed before a Gemini session is opened.
// Settings (names only): GEMINI_API_KEY, GEMINI_LIVE_MODEL (default gemini-3.8-live), GEMINI_VOICE (default Kore; a bot's
// own spec.voiceSetup.voice wins), GEMINI_LIVE_URL (tests / proxies), TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (hang-up,
// transfer, texts), TWILIO_FROM_NUMBER (texts), KNOWBOT_VOICE_SPECULATE (default on), KNOWBOT_VOICE_SPECULATE_MAX
// (default 2 per turn), KNOWBOT_VOICE_INSTANT (default on), KNOWBOT_VOICE_INSTANT_MAX (default 5 per bot),
// KNOWBOT_VOICE_ASYNC_TOOLS (default: by model), KNOWBOT_VOICE_SILENCE_MS (turn-end silence, default 600).
import { randomUUID } from 'node:crypto';
import { NOT_IN_DATA, formatSpoken, humanTitle } from './util.mjs';
import { createShop, toE164, handleInText, textableNumber, describeLines, MAX_LINK_ITEMS } from './shop.mjs';
import { contactOf } from '../leads.mjs';
import { toolAnswer, conversationRules, takeMessageDeclaration, transferDeclaration, createReadBack, unsupportedFigures, createSpeculator,
  asyncToolsSupported, silenceMs, voiceSetupOf, withinHours, isE164 } from './voice-brain.mjs';

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
/**
 * What a voice greeting says the bot can send. media: { email, text } (what this bot can really send: its owner's
 * "Send me this" switch and the server's channels), or the legacy { offerSources: true } (both).
 */
const sendMedia = (media) => (media?.offerSources ? { email: true, text: true } : { email: !!media?.email, text: !!media?.text });
/**
 * The owner's voice greeting, said for the business that set the bot up, on the web and on the phone:
 * "Hi. I'm the Ultimate Game Master Assistant. I'm here to get you quick answers. I can send you text messages and
 * emails too. How can I help?" The send sentence names only what this bot can send, and is left out when it sends nothing.
 */
export function voiceGreeting(botName, media = null) {
  const name = String(botName || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '') || 'KnowBot';
  const intro = /^the\s/i.test(name) ? `I'm the ${name.replace(/^the\s+/i, '')}.` : `I'm ${name}.`;
  const { email, text } = sendMedia(media);
  const send = email && text ? ' I can send you text messages and emails too.' : text ? ' I can send you text messages too.' : email ? ' I can send you emails too.' : '';
  return `Hi. ${intro} I'm here to get you quick answers.${send} How can I help?`;
}
/** The phone greeting: the same words as the web (voiceGreeting). media: what this line can send ({ email, text }). */
export const greetingFor = (botName, media = null) => voiceGreeting(botName, media);
const canSend = (sendInfo) => !!(sendInfo && (sendInfo.email || sendInfo.text));

/**
 * The "send me this" part of a voice prompt. sendInfo: { email, text, callerKnown } (what this line can send, and whether
 * the caller's own number is known); null or neither medium → nothing (the assistant never offers).
 */
export function sendInfoInstruction(sendInfo, { who = 'caller' } = {}) {
  // the bot's owner switched "Send me this" off (sendInfo.off): never offer, and say so plainly when asked
  if (sendInfo?.off && !sendInfo.email && !sendInfo.text) {
    return `\n\nSending the answer:\n- This bot doesn't send messages. If the ${who} asks you to text or email them anything, say plainly and kindly that this bot doesn't send messages, and that you're happy to repeat anything or answer another question. That is not a missing answer: never use the "not in our files" line for it. Never offer to send anything.`;
  }
  if (!sendInfo || (!sendInfo.email && !sendInfo.text)) return '';
  const lines = [`- If the ${who} asks you to send, text or email them the information, you can send your last answer from the files, with its sources and a link to them. Don't offer it unprompted more than once.`];
  if (sendInfo.text && sendInfo.callerKnown) lines.push(`- For a text, offer: "I can text that to the number you're calling from." Confirm using the last four digits you were given ("to the number ending in 0378?") and get a yes. If they give a different mobile number, read it back digit by digit in groups and get a yes.`);
  else if (sendInfo.text) lines.push(`- For a text, ask for their mobile number, read it back digit by digit in groups and get a yes.`);
  if (sendInfo.email) lines.push(`- For an email, ask for their email address, spell it back to them and get a yes before sending (spell the letters where it could be misheard).`);
  lines.push(`- send_info checks this for you: called without confirmed, it returns "read_back" (the number or address as it should be read back). Say it exactly and ask if it's right. On a yes, call send_info again with confirmed true; on a no, ask for it again.`);
  if (!sendInfo.email) lines.push(`- Email isn't available here; offer a text instead.`);
  if (!sendInfo.text) lines.push(`- Texts aren't available here; offer an email instead.`);
  lines.push(`- Only after they confirm, call send_info with channel "text" or "email" and "to" set to the number or address they confirmed${sendInfo.text && sendInfo.callerKnown ? ' (leave "to" empty to text the number they are calling from)' : ''}. Use what "conversation" for the end-of-${who === 'visitor' ? 'conversation' : 'call'} offer (the transcript and the sources for everything you shared), what "last_answer" when they ask for one answer.`);
  lines.push(`- When it succeeds, tell them it's on its way. If it reports a problem, say so briefly and offer the other way. If it says there is nothing to send yet, ask what they'd like to know first. Never read out the link.`);
  const end = who === 'visitor' ? 'conversation' : 'call';
  lines.push(`- Before the ${end} ends (they say goodbye, thanks, or that they're done), if you answered at least one question from the files and haven't sent anything yet, first offer to send them the transcript of your conversation and the sources for what you shared, by ${sendInfo.email && sendInfo.text ? 'email or text' : sendInfo.email ? 'email' : 'text'}. Say it in your own words, briefly and warmly, the way a person would (for example: "Before you go, want me to send you a transcript of our chat and the sources for what I shared?"). Never use the same wording twice, and don't press if they say no.`);
  return `\n\nSending the answer:\n${lines.join('\n')}`;
}
export const sendInfoDeclaration = () => ({ name: 'send_info', description: 'Send the caller, by text or email, either the transcript of this conversation with the sources for every answer you gave (what "conversation"), or your last answer with its sources (what "last_answer"). Only after they asked for it or accepted your offer. The first call returns the read-back to confirm; call again with confirmed true after they say yes.',
  parameters: { type: 'OBJECT', properties: {
    channel: { type: 'STRING', enum: ['text', 'email'], description: 'text or email.' },
    what: { type: 'STRING', enum: ['conversation', 'last_answer'], description: 'conversation: the transcript and the sources for everything shared (the end-of-call offer). last_answer: just the last answer and its sources.' },
    to: { type: 'STRING', description: 'The mobile number or email address the caller confirmed, as they said it. Empty to text the number they are calling from.' },
    confirmed: { type: 'BOOLEAN', description: 'True only after you read back the number or address and they said yes.' },
  }, required: ['channel'] } });

/**
 * The phone prompt. asyncSearch: the search runs NON_BLOCKING (voice-brain.mjs asyncToolsSupported); takeMessages: the
 * bot may take a message on a refusal; transfer: 'now' (a transfer number, inside business hours) | 'callback' | null;
 * language: 'auto' | a language code (voice-brain.mjs VOICE_LANGUAGES).
 */
export function systemInstruction({ botName, org, productLinks = false, sendInfo = null, asyncSearch = false, takeMessages = false, transfer = null, language = 'auto' }) {
  const who = botName || 'KnowBot';
  const orgName = org || botName || 'this business';
  const base = `You are ${who}, the phone assistant for ${orgName}, speaking with a caller on a live phone call. You are a kind librarian: you answer only from ${orgName}'s own files.

Grounding rules:
- Before answering ANY question, call search_knowledge_base. Write the query as a complete standalone question, filling in anything the caller referred to earlier (for "how much is it?", name the product).
- The tool returns the answer from the files ("answer", sometimes "more", and the exact "facts"). Say it without saying where it comes from (no "According to ...": it keeps the call short${canSend(sendInfo) ? ', and the sources can be sent at the end' : ''}). If the caller asks where something comes from, name it from "source_titles".
- If the tool returns status "not_in_data", say exactly: "${NOT_IN_DATA}"
- Never answer from general knowledge, never guess, and never answer a question you did not search for.

Speaking style:
- Short replies; the caller can ask a follow-up.
- Never read out file names, URLs, citation numbers or links.

Call flow:
- The call starts with a message like "[call connected] Caller's number ends in 0378." Greet the caller with: "${greetingFor(botName, sendInfo)}"
- When the caller says goodbye or that they're done, say a short goodbye and then call end_call.${conversationRules({ who: 'caller', asyncSearch, send: canSend(sendInfo) ? sendInfo : null, takeMessages, transfer, language })}${sendInfoInstruction(sendInfo)}`;
  if (!productLinks) return base;
  return `${base}

Texting product links:
- After you've answered about a specific product the caller seems interested in, you may offer to text them a link that puts it in their cart and opens checkout.
- Phrase the offer in your own words each time, fitted to the moment: sometimes lead with the convenience of checking out from their phone, sometimes with the item being ready in the cart, sometimes as a quick question. Keep it to one short sentence, and never reuse wording you've already used on this call.
- Offer at most once per product, and not at all if they've already declined. Don't push.
- If they're interested in more than one product, offer to put them all in one link rather than sending several texts.
- Before sending, know which version of each product they want (color, size, ...) and how many of each. If you don't know, ask.
- Texts go to the number they're calling from unless they give another. Confirm first using the last four digits you were given ("to the number ending in 0378?"). If they give a different number, read it back and get a yes.
- Then call send_product_link with one entry in items per product: the product's name as the files call it (or its handle if you know it), the version, and the quantity. Pass phone_number only if they gave a different number.
- If the tool reports a problem with one item (it gives the item_number), ask about just that item. If it asks for a version, ask the caller. If a version is sold out, say so and offer an in-stock one.
- When it succeeds, tell them it's on its way and that the link opens a new checkout with exactly these items in the cart.
- How the link works, if they ask: it opens a fresh checkout with only the items in that link. It doesn't add to, or include, anything already in a cart on the website. If they want other items too, offer to send a new link with everything together.
- Never read out the link itself.`;
}

/** The search tool, shared by the phone and the web: NON_BLOCKING (the model keeps talking while it runs) when async. */
export const searchDeclaration = (orgName, { asyncSearch = false } = {}) => ({ name: 'search_knowledge_base',
  description: `Search ${orgName}'s own files and get the answer to speak, with its source. Required before answering any question.`,
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A complete, standalone question, in the language of the files.' } }, required: ['query'] },
  ...(asyncSearch ? { behavior: 'NON_BLOCKING' } : {}) });

export function toolDeclarations({ org, productLinks = false, sendInfo = null, asyncSearch = false, takeMessages = false, transfer = null }) {
  const orgName = org || 'this business';
  const fns = [
    searchDeclaration(orgName, { asyncSearch }),
    { name: 'end_call', description: 'Hang up after you have said goodbye to the caller.', parameters: { type: 'OBJECT', properties: {} } },
  ];
  if (takeMessages) fns.splice(1, 0, takeMessageDeclaration({ phone: true }));
  if (transfer === 'now') fns.splice(1, 0, transferDeclaration());
  if (sendInfo && (sendInfo.email || sendInfo.text)) fns.splice(1, 0, sendInfoDeclaration());
  if (productLinks) {
    fns.splice(1, 0, { name: 'send_product_link', description: 'Text the caller ONE link that puts the listed products in a new cart and opens checkout. Only after the caller agreed and confirmed the number.',
      parameters: { type: 'OBJECT', properties: {
        items: { type: 'ARRAY', description: `One entry per product to include (up to ${MAX_LINK_ITEMS}).`, items: { type: 'OBJECT', properties: {
          product: { type: 'STRING', description: "The product's handle (e.g. ultimate-bundle) or its store page URL; its name as a last resort." },
          variant: { type: 'STRING', description: 'The version the caller wants, in plain words (e.g. "brown landscape"). Empty if there is only one.' },
          quantity: { type: 'INTEGER', description: 'How many. Default 1.' },
        }, required: ['product'] } },
        phone_number: { type: 'STRING', description: "Only if the caller asked for a number other than the one they're calling from, as they said it." },
      }, required: ['items'] } });
  }
  return [{ functionDeclarations: fns }];
}

// ------------------------------------------------------------------ Twilio REST (hang-up, texts)
/** `from`: the bot's own KnowBot number for texts (else the shared TWILIO_FROM_NUMBER). */
export function twilioRest(env = {}, { from = null } = {}) {
  const sid = env.TWILIO_ACCOUNT_SID, tok = env.TWILIO_AUTH_TOKEN;
  const fromNumber = from || env.TWILIO_FROM_NUMBER || '';
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
    canText: !!(sid && tok && fromNumber),
    fromNumber,
    hangUp: (callSid) => post(`/Calls/${encodeURIComponent(callSid)}.json`, { Status: 'completed' }),
    /** Hand the live call to a person: the call leaves the media stream and dials `number` (E.164 only). */
    transfer: (callSid, number) => post(`/Calls/${encodeURIComponent(callSid)}.json`, { Twiml: transferTwiml(number) }),
    sendSms: (to, body) => {
      if (!fromNumber) throw new Error('TWILIO_FROM_NUMBER is not set');
      return post('/Messages.json', { From: fromNumber, To: to, Body: body });
    },
  };
}

/** The TwiML a transferred call runs: dial the owner's number (validated E.164; nothing else is ever put in it). */
export function transferTwiml(number) {
  if (!isE164(number)) throw new Error('transfer number must be E.164');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true">${number}</Dial></Response>`;
}

// ------------------------------------------------------------------ tools (shared by the call bridge and scripts/voice-live-test.mjs)
/**
 * @param {object} o
 * @param {(q: string) => Promise<object>} o.ask      the bot's answer pipeline (logs the question with channel 'phone')
 * @param {(q: string) => Promise<{text:string,file?:string,url?:string}[]>} [o.searchRaw]  retrieval only (no log), for handle lookup
 * @param {string|null} [o.shopDomain]  product links on when set
 * @param {(to: string) => boolean} [o.textAllowed]  per-destination / per-bot text quota (devapi.mjs); false → 'texts are limited'
 */
export function createToolRunner({ ask, searchRaw = null, callSid = '', callerNumber = '', sendSms = null, shopDomain = null, textAllowed = null, sendInfo = null, env = {}, botName = '', org = '', log = () => {}, fromNumber = null, getTranscript = () => [],
  linkUtm = null, trackProductLink = null, sendMedia = null, onScreen = false, takeMessage = null }) {
  const lineNumber = fromNumber || env.TWILIO_FROM_NUMBER;
  let textsSent = 0;
  let lastAnswer = null; // the last grounded answer on this call: what send_info sends for what "last_answer"
  const grounded = []; // every grounded answer on this call: the sources of a "conversation" send
  const seen = []; // retrieved text this call (citation excerpts + urls), for product handle lookup
  const answers = []; // {query, refused, spoken, citations:[{n,title,file}]} for the call log
  const names = [botName, org].filter(Boolean);
  const readBack = createReadBack();
  let sentSomething = false;
  let allowed = []; // what the bot may say figures from since the caller's last question (the facts guard)
  const lastFour = () => toE164(callerNumber)?.slice(-4) || '';
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
  // linkUtm: the leads report's tags ({source, medium, campaign}); trackProductLink({to, link}) → {url, sent()}: the tracked
  // short link to text instead, and a callback once the text went out (server/devapi.mjs, server/leads.mjs)
  const shop = shopDomain ? createShop({ domain: shopDomain, env, orgName: org || botName || 'the store', findHandle, log, utm: linkUtm }) : null;

  async function runTool(call) {
    const args = call?.args || {};
    if (call?.name === 'search_knowledge_base') {
      const query = String(args.query || '').trim();
      if (!query) return { status: 'error', retryable: true, reason: 'Pass the caller\'s question as query.' };
      let r;
      try { r = await ask(query); } catch (e) { log(`[voice-live] ${callSid} search failed: ${e.message}`); return { status: 'error', retryable: false, reason: 'The files could not be searched right now.' }; }
      for (const c of r.citations || []) seen.push({ text: c.excerpt || '', url: c.url || '', file: c.file || '', title: humanTitle(c) });
      for (const h of r.proof?.hits || []) seen.push({ text: h.excerpt || '', file: h.file || '' });
      const spoken = r.refused ? NOT_IN_DATA : formatSpoken(r, 450, { names, attribute: false });
      answers.push({ query, refused: !!r.refused, spoken, citations: (r.citations || []).map((c) => ({ n: c.n, title: humanTitle(c), file: c.file })), ...(r.instant ? { instant: true } : {}) });
      // the answer to say (short first, "more" offered), the exact facts, and the titles it came from: no raw excerpts
      // the model could read beyond the answer, and no page addresses (product handles come from this call's `seen` list)
      const out = toolAnswer(r, { names, onScreen, send: sendInfo ? sendMedia : null, takeMessages: !!takeMessage, questionsSoFar: answers.filter((x) => !x.refused).length, sentSomething });
      allowed.push(query, out.answer || '', out.more || '', ...(out.facts || []), ...(out.related || []), ...(out.options || []));
      if (r.refused) return out;
      lastAnswer = r;
      grounded.push(r);
      return out;
    }
    if (call?.name === 'send_info') {
      // "send me this" (server/sendinfo.mjs): validation, rate limits, the opt-out list and delivery live there
      if (!sendInfo) return { status: 'error', retryable: false, reason: 'Sending is not set up on this line.' };
      if (!lastAnswer) return { status: 'nothing_to_send', reason: 'There is no answer from the files on this call yet. Ask what they would like to know first.' };
      const via = String(args.channel || '').toLowerCase() === 'email' ? 'email' : 'text';
      const said = String(args.to || '').trim();
      const to = said || (via === 'text' ? callerNumber : '');
      if (!to) return { status: via === 'email' ? 'need_email_address' : 'need_phone_number', reason: via === 'email' ? 'Ask for their email address and spell it back.' : 'Ask for their mobile number and read it back.' };
      // read back before sending: the first call returns what to say, the confirmed one sends
      const rb = readBack.check(said, { confirmed: args.confirmed === true, lastFour: said ? '' : lastFour() });
      if (rb) { allowed.push(rb, said); return { status: 'confirm_first', read_back: rb, reason: 'Say read_back exactly and ask if it is right. After a yes, call send_info again with confirmed true; after a no, ask for it again.' }; }
      let r;
      const convo = String(args.what || 'conversation') !== 'last_answer';
      try { r = await sendInfo({ via, to, answer: lastAnswer, ...(convo ? { answers: [...grounded], transcript: (getTranscript() || []).slice(-200) } : {}) }); } catch (e) { log(`[voice-live] ${callSid} send_info failed: ${e.message}`); return { status: 'error', retryable: false, reason: "It couldn't be sent." }; }
      log(`[voice-live] ${callSid} send_info by ${via}: ${r.status}`);
      if (r.status === 'sent') sentSomething = true;
      if (r.status === 'sent') return { status: 'ok', sent_by: via, ...(via === 'text' ? { sent_to_last_four: String(r.to || '').replace(/\D/g, '').slice(-4) } : {}) };
      return { status: r.status, retryable: r.status === 'invalid', reason: r.reply };
    }
    if (call?.name === 'take_message') {
      // a message or callback request for the team (a lead): only when the owner left message-taking on
      if (!takeMessage) return { status: 'error', retryable: false, reason: 'Messages are not taken here. Offer to help with something else.' };
      const kind = String(args.kind || '') === 'callback' ? 'callback' : 'message';
      const said = String(args.contact || '').trim();
      const c = contactOf(said || callerNumber || '');
      if (!c) return { status: kind === 'callback' ? 'need_phone_number' : 'need_contact', reason: kind === 'callback' ? 'Ask for the phone number to call back and read it back.' : 'Ask for an email address or phone number, and read it back.' };
      if (kind === 'callback' && c.type !== 'phone') return { status: 'need_phone_number', reason: 'A callback needs a phone number. Ask for it and read it back.' };
      const rb = readBack.check(said, { confirmed: args.confirmed === true, lastFour: said ? '' : lastFour() });
      if (rb) { allowed.push(rb, said); return { status: 'confirm_first', read_back: rb, reason: 'Say read_back exactly and ask if it is right. After a yes, call take_message again with confirmed true; after a no, ask for it again.' }; }
      let r;
      try { r = await takeMessage({ kind, name: String(args.name || '').trim().slice(0, 80), contact: c.value, question: String(args.question || '').trim().slice(0, 500), preferredTime: String(args.preferred_time || '').trim().slice(0, 80) }); }
      catch (e) { log(`[voice-live] ${callSid} take_message failed: ${e.message}`); return { status: 'error', retryable: false, reason: "The message couldn't be saved." }; }
      if (!r) return { status: 'error', retryable: false, reason: "The message couldn't be saved." };
      log(`[voice-live] ${callSid} ${kind} taken (${c.type})`);
      return { status: 'ok', note: 'Saved for our team. Tell them briefly; never promise when or whether they will reply.' };
    }
    if (call?.name === 'send_product_link') {
      if (!shop) return { status: 'error', retryable: false, reason: 'Product links are not set up for this bot.' };
      if (!sendSms) return { status: 'error', retryable: false, reason: 'Texting is not set up on this line.' };
      if (textsSent >= MAX_TEXTS_PER_CALL) return { status: 'error', retryable: false, reason: 'The text limit for this call has been reached.' };
      // the verified caller ID by default; a spoken number only in the same country as the sending line, never a
      // premium-rate or short-code range (texts are paid by the bot owner's Twilio account)
      const spoken = String(args.phone_number || '').trim();
      const own = toE164(callerNumber);
      const to = spoken && toE164(spoken) !== own ? textableNumber(spoken, lineNumber) : textableNumber(callerNumber, lineNumber);
      if (!to) {
        if (spoken) return { status: 'error', retryable: false, reason: `Texts can only go to a mobile number in the same country as this line${own ? ', or to the number they are calling from' : ''}.` };
        return { status: 'need_phone_number', reason: "There's no usable number for this caller. Ask for their mobile number and read it back." };
      }
      // items[] (one link for several products); the older single { product, variant, quantity } shape is still accepted
      const items = Array.isArray(args.items) && args.items.length ? args.items : args.product ? [{ product: args.product, variant: args.variant, quantity: args.quantity }] : [];
      const link = await shop.buildProductLink({ items, callSid });
      if (link.status !== 'ok') return link;
      if (textAllowed && !textAllowed(to)) {
        log(`[voice-live] ${callSid} text to ***${to.slice(-4)} refused: texts are limited`);
        return { status: 'error', retryable: false, reason: 'texts are limited' };
      }
      let tracked = null;
      try { tracked = trackProductLink ? trackProductLink({ to, link }) : null; } catch (e) { log(`[voice-live] ${callSid} link tracking failed: ${e.message}`); }
      try {
        await sendSms(to, shop.smsBody({ ...link, url: tracked?.url || link.url }));
        textsSent += 1;
        try { tracked?.sent?.(); } catch { /* the report only */ }
        log(`[voice-live] ${callSid} texted a ${link.kind} link for ${describeLines(link.lines)} to ***${to.slice(-4)}`);
        return { status: 'ok', sent_to_last_four: to.slice(-4), opens: link.kind === 'checkout' ? 'a new checkout with exactly these items in the cart' : 'the product page', items: link.lines };
      } catch (e) {
        log(`[voice-live] ${callSid} text failed: ${e.message}`);
        return { status: 'error', retryable: false, reason: "The text message couldn't be sent." };
      }
    }
    return null;
  }
  runTool.answers = answers;
  runTool.textsSent = () => textsSent;
  /** What the bot may say figures from since the caller's last question; reset when a new question starts. */
  runTool.allowed = () => allowed;
  runTool.newTurn = () => { allowed = []; };
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
export function connectGemini(env, { systemInstruction: sys, tools, onMessage, onClose, timeoutMs = 10000, voice = null }) {
  const g = geminiSettings(env);
  if (voice) g.voice = voice; // the bot's own voice (spec.voiceSetup), else GEMINI_VOICE, else Kore
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
        // the model's own turn detection, with a shorter end-of-turn silence than its default (answers start sooner)
        realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: silenceMs(env) } },
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

/**
 * Runs one toolCall message's function calls and sends their responses. Blocking tools answer together, as before; a
 * NON_BLOCKING search (asyncSearch) answers on its own as soon as it is ready, scheduled WHEN_IDLE (the model finishes
 * its acknowledgement, then speaks the answer), so a slow search never holds up another tool.
 */
export function respondToTools(calls, run, { asyncSearch = false, send, log = () => {}, cancelled = null }) {
  const one = async (call) => {
    log(`tool ${call.name}(${JSON.stringify(call.args || {}).slice(0, 200)})`);
    let response;
    try { response = await run(call); } catch (e) { response = { status: 'error', reason: e.message }; }
    if (response == null) response = { status: 'error', reason: `Unknown tool ${call.name}` };
    if (asyncSearch && call.name === 'search_knowledge_base') response = { ...response, scheduling: 'WHEN_IDLE' };
    return { id: call.id, name: call.name, response };
  };
  // a NON_BLOCKING call the model cancelled (the caller interrupted it: toolCallCancellation) gets no response
  const out = (list) => { list = cancelled ? list.filter((r) => !cancelled.has(r.id)) : list; if (list.length) { try { send(list); } catch (e) { log(`tool response failed: ${e.message}`); } } };
  const async = asyncSearch ? calls.filter((c) => c.name === 'search_knowledge_base') : [];
  for (const c of async) one(c).then((r) => out([r]));
  const rest = calls.filter((c) => !async.includes(c));
  if (rest.length) return Promise.all(rest.map(one)).then(out);
  return Promise.resolve();
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
  const rest = twilioRest(env, { from: cx.fromNumber || null });
  const lim = phoneLimits(env);
  // a bot on its own KnowBot number: the call can't outlast its credit (at least a minute, to say goodbye)
  if (Number(cx.maxSeconds) > 0) lim.maxSeconds = Math.min(lim.maxSeconds, Math.max(60, Number(cx.maxSeconds)));
  const botKey = String(cx.botId || '');
  // the bot's voice settings (Set up → Voice): voice, language, message-taking, transfer number and hours
  const setup = voiceSetupOf(cx.voiceSetup, { defaultVoice: geminiSettings(env).voice });
  const asyncSearch = asyncToolsSupported(geminiSettings(env).model, env);
  const now = cx.now || (() => Date.now());
  // a person: transfer during business hours (call control needed); otherwise a callback request (a lead)
  const transferMode = () => (setup.transfer && rest.canHangUp && withinHours(setup.transfer, now()) ? 'now' : setup.takeMessages && cx.takeMessage ? 'callback' : null);
  let transferRequested = null, transferMark = 0, transferred = false;
  const cancelled = new Set();
  const spec = !/^(0|false|no|off)$/i.test(String(env.KNOWBOT_VOICE_SPECULATE ?? '1')) && cx.ask
    ? createSpeculator({ run: (q) => cx.ask(q, { speculative: true }), maxPerTurn: Math.max(1, Number(env.KNOWBOT_VOICE_SPECULATE_MAX) || 2), log: (m) => log(`${m} (${callSid})`) }) : null;
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
  const unsupported = []; // {question, text, figures, ref}: the facts guard

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
    spec?.endTurn();
    cx.onEnd?.({ callSid, transcript, answers: runShared?.answers || [], textsSent: runShared?.textsSent?.() || 0, ungrounded, unsupported, speculation: spec ? { ...spec.stats } : null, transferred });
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
  // the transfer: once the "connecting you" line has played (Twilio echoes the mark), the call leaves this stream and
  // dials the owner's number (Twilio REST, the same call control as the hang-up)
  async function doTransfer() {
    if (transferred || !transferRequested || closed) return;
    transferred = true;
    const number = transferRequested;
    try { await rest.transfer(callSid, number); log(`[voice-live] ${callSid} transferred to ***${number.slice(-4)}`); cx.onTransfer?.({ callSid, number }); }
    catch (e) { log(`[voice-live] ${callSid} transfer failed: ${e.message}`); transferred = false; transferRequested = null; try { session?.sendText('[transfer failed] The transfer did not go through. Apologise briefly and offer to take a message instead.'); } catch {} return; }
    closeAll();
  }
  const queueTransferMark = () => { transferMark += 1; sendToTwilio({ event: 'mark', streamSid, mark: { name: `transfer-${transferMark}` } }); };
  // the bot's own pipeline, or the search already started on the caller's words (the speculative search), when it matches
  async function askFor(query) {
    const hit = spec?.take(query);
    if (hit) {
      const a = await hit.promise.catch(() => null);
      if (a) { a.speculativeMs = hit.aheadMs; return typeof a.commit === 'function' ? a.commit() : a; }
    }
    return cx.ask(query);
  }

  async function runTool(call) {
    if (call.name === 'transfer_call') {
      if (call.args?.caller_agreed !== true) return { status: 'ask_first', reason: 'Ask the caller whether they want to be put through, and only transfer after a clear yes.' };
      if (transferMode() !== 'now') return { status: 'unavailable', reason: setup.takeMessages && cx.takeMessage ? 'Our team is not available right now. Offer a callback: take_message with kind "callback".' : 'Our team is not available right now. Offer to help with something else.' };
      transferRequested = setup.transfer.number;
      // the mark goes out when the model's turn (the "connecting you" line) is complete; a lost mark falls back to a timer
      setTimeout(doTransfer, Number(cx.transferFallbackMs || 8000)).unref?.();
      return { status: 'ok', note: 'Tell the caller in a few words that you are connecting them now, then stop talking.' };
    }
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
      respondToTools(msg.toolCall.functionCalls, runTool, { asyncSearch, cancelled, send: (r) => session?.sendToolResponse(r), log: (m) => log(`[voice-live] ${callSid} ${m}`) });
      return;
    }
    if (msg.toolCallCancellation?.ids) { for (const id of msg.toolCallCancellation.ids) cancelled.add(id); return; }
    const c = msg.serverContent;
    if (!c) return;
    if (c.inputTranscription?.text) {
      // the caller speaking again after the agent finished a turn starts a new question: it needs a new search
      if (!callerTurnOpen) { callerTurnOpen = true; searchedSinceCaller = false; runShared?.newTurn?.(); }
      callerText += c.inputTranscription.text;
      spec?.partial(callerText);
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
      if (transferRequested && !transferred) queueTransferMark();
      if (!agentText.trim()) return; // a turn that only issued a tool call: keep the caller's words for the answer turn
      const said = agentText.trim(), asked = callerText.trim();
      // the facts guard: a figure the bot said that is in none of the search results, the question or a read-back
      if (searchedSinceCaller) {
        const figs = unsupportedFigures(said, [...(runShared?.allowed?.() || []), asked, toE164(callerNumber) || '']);
        if (figs.length) {
          const ref = Math.random().toString(16).slice(2, 10);
          log(`[voice-live] ${callSid} facts guard ref=${ref}: said ${figs.join(', ')} not in the facts`);
          const u = { question: asked, text: said, figures: figs, ref };
          unsupported.push(u);
          try { cx.onUnsupported?.(u); } catch (e) { log(`[voice-live] facts guard log failed: ${e.message}`); }
        }
      }
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
      spec?.endTurn();
    }
  }

  async function openSession() {
    const productLinks = !!cx.shopDomain && rest.canText;
    const sendInfo = cx.sendInfo && cx.sendInfoMedia ? { ...cx.sendInfoMedia, callerKnown: !!toE164(callerNumber) } : null;
    const takeMessages = !!(setup.takeMessages && cx.takeMessage);
    const transfer = transferMode();
    session = await connectGemini(env, {
      systemInstruction: systemInstruction({ botName: cx.botName, org: cx.org, productLinks, sendInfo, asyncSearch, takeMessages, transfer, language: setup.language }),
      tools: toolDeclarations({ org: cx.org || cx.botName, productLinks, sendInfo, asyncSearch, takeMessages, transfer }),
      voice: setup.voice,
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
        const sendSms = rest.canText ? async (to, body) => { const r = await rest.sendSms(to, body); try { cx.onTextSent?.({ to, body }); } catch { /* metering only */ } return r; } : null;
        runShared = createToolRunner({ ask: askFor, searchRaw: cx.searchRaw, callSid, callerNumber, sendSms,
          shopDomain: rest.canText ? cx.shopDomain : null, textAllowed: cx.textAllowed || null, sendInfo: cx.sendInfo || null, env, botName: cx.botName, org: cx.org, log, fromNumber: rest.fromNumber, getTranscript: () => transcript,
          linkUtm: cx.linkUtm || null, trackProductLink: cx.trackProductLink || null, sendMedia: cx.sendInfoMedia || null,
          takeMessage: setup.takeMessages && cx.takeMessage ? (m) => cx.takeMessage({ ...m, callSid }) : null });
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
        if (transferRequested && msg.mark?.name === `transfer-${transferMark}`) doTransfer();
        break;
      case 'stop':
        closeAll();
        break;
      default:
    }
  });
  twilioWs.on('close', () => closeAll());
  return { transcript, get callSid() { return callSid; }, get speculation() { return spec ? { ...spec.stats } : null; } };
}

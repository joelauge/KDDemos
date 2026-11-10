// "Send me this information": on every answer surface a visitor can ask the bot to send them its answer, by e-mail or
// by text, and the bot asks for an e-mail address or mobile number, sends its LAST grounded answer (the answer text, the
// quoted lines with their sources, and the proof link) and confirms with the address masked ("Sent to j***@example.com.").
//
// One seam for every text surface (Studio chat, developer API chat + preview, SMS, WhatsApp, e-mail, web voice text):
//
//   const si = createSendInfo({ env, log, dataDir, onSent })
//   si.remember(key, answer)                       a grounded answer this conversation may ask to have sent
//   await si.maybeSendInfo({ key, botId, botName, question, history, lastAnswer, channel, caller, proofUrlFor, answerFor })
//     → null (not a send request: answer normally) | { reply, status, via?, to? (masked) }
//
// Phone calls (voice-live.mjs, and web voice) call si.send({...}) from their send_info tool instead: the caller confirms
// the address out loud first, and a phone caller's own number is the default text destination.
//
// Delivery: e-mail through the transactional mail API (RESEND_API_KEY; from KNOWBOT_EMAIL_FROM, default
// "KnowBot <answers@knowbot.knowdrive.ai>", shown as the bot's name; Reply-To only when the bot owner set one), texts
// through the telephony REST API (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN, from TWILIO_FROM_NUMBER or a bot's own number).
// Either one missing turns that medium off (the bot offers the other); both missing and the bot never offers to send.
//
// Safety: one recipient per request; e-mail and E.164 numbers validated (texts only to the sending line's country, never
// premium-rate or short codes); 5 sends per caller per hour, 5 per destination per hour, 200 per bot per day
// (KNOWBOT_SENDINFO_PER_CALLER_HOUR, KNOWBOT_SENDINFO_PER_BOT_DAY); a refused or empty answer is never sent; only the
// bot's own answer content goes out; a number that texted STOP is never texted again (kept per bot, persisted under
// dataDir); each send reaches question insights as a counted event with a hashed caller (no address is ever stored).
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { formatEmail, formatSms, toGsm7, clipWords } from './channels/util.mjs';
import { toE164, countryCodeOf, textableNumber } from './channels/shop.mjs';
import { logSendEvent } from './questions.mjs';

export const DEFAULT_EMAIL_FROM = 'KnowBot <answers@knowbot.knowdrive.ai>';
export const TEXT_MAX = 320;
export const PENDING_TTL_MS = 15 * 60 * 1000;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;

const hash8 = (s) => createHash('sha256').update(String(s ?? '').trim().toLowerCase()).digest('hex').slice(0, 8);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ intent
const VERB = '(?:send|email|e-mail|mail|text|txt|sms|message|forward|shoot)';
const THING = '(?:this|that|it|these|those|them|the\\s+(?:info|information|answers?|details|links?|above|same|sources?)|all\\s+(?:of\\s+)?(?:this|that|it)|(?:this|that)\\s+(?:info|information|answer|link|stuff)|a\\s+copy(?:\\s+of\\s+(?:this|that|it))?|a\\s+link|the\\s+(?:proof|quotes?))';
const INTENT = [
  // "send me this", "email me that", "text me the info", "can you send us a copy"
  new RegExp(`\\b${VERB}\\s+(?:me|us)\\s+${THING}\\b`, 'i'),
  // "send it to my phone", "email that to me", "send this by text", "forward the info to jo@x.com"
  new RegExp(`\\b${VERB}\\s+${THING}\\s+(?:to\\s+(?:me|us|my\\b)|over\\b|by\\s+(?:e-?mail|text|sms|message)|via\\b|as\\s+an?\\s+(?:e-?mail|text)|to\\s+[^\\s@]+@|to\\s+\\+?\\(?\\d)`, 'i'),
  // "text me", "email me please", "email me at jo@x.com", "text me on 555 0100"
  /\b(?:e-?mail|text|txt|sms)\s+(?:me|us)\b\s*(?:[.!?]|$|please\b|pls\b|plz\b|now\b|at\b|on\b|to\b)/i,
  // "email me your return policy", "text me the opening hours" (a named topic: that question's answer is sent)
  /^(?!(?:do|does|did|will|how|when|why|is|are)\b)(?:.*\b)?(?:e-?mail|text|txt)\s+(?:me|us)\s+(?:your|the|our)\s+[a-z]/i,
  // "send to jo@x.com", "text it to 905 555 0123"
  /\b(?:send|email|e-mail|text|txt|forward)\s+(?:it\s+)?to\s+(?:[^\s@]+@|\+?\(?\d)/i,
  // "can I get this emailed", "could you have that texted to me"
  /\b(?:get|have)\s+(?:this|that|it|the\s+(?:info|information|answer|details))\s+(?:sent|e-?mailed|texted|forwarded)\b/i,
  // "send it", "send me", "can you send that?" as the whole message
  /^(?:(?:please|pls|ok|okay|great|thanks|thank you|yes)[,!.\s]+)*(?:can|could|would|will)?\s*(?:you\s+)?(?:please\s+)?(?:send|forward)\s+(?:it|this|that|me|us)(?:\s+(?:over|please|pls))?\s*[.!?]*$/i,
  // "I'd like (you to send) this by email", "I want that in an email / a text"
  /\b(?:like|want|need)\s+(?:(?:you\s+to\s+)?(?:send|email|text)\s+)?(?:this|that|it|the\s+(?:info|information|answer))\s+(?:by|in|via|as)\s+(?:an?\s+)?(?:e-?mail|text|sms)\b/i,
];
const YES = /^(?:yes|yeah|yep|sure|ok(?:ay)?|please|please do|go ahead|do it)\b[\s\S]{0,20}$/i;
const CANCEL = /^(?:no|nope|nah|cancel|stop asking|never ?mind|nevermind|forget it|no thanks?|no thank you|don'?t)\b[\s\S]{0,30}$/i;
/** Words that only say "send it" (never the topic of a referenced question). */
const FILLER = new Set(('can could would will you please pls plz send sent email e-mail mail emailed text texted txt sms message forward shoot me us it this that these those them '
  + 'the a an info information answer answers details link links copy of to my phone cell mobile number inbox address by via over as all same above sources source proof quotes quote '
  + 'and also too again now just get have i i\'d id like want need would be great thanks thank ok okay yes hey hi hello in on at for about regarding re stuff your our there here').split(' '));

/**
 * → null, or { via: 'email'|'text'|null } when the message asks to be sent the information ("can you text me that?").
 * English only; robust to "e-mail", "txt", trailing contact details and politeness.
 */
export function detectSendIntent(text) {
  const t = oneLine(text).replace(/[‘’]/g, "'");
  if (!t || t.length > 400) return null;
  if (!INTENT.some((re) => re.test(t))) return null;
  const wantsMail = /\b(?:e-?mail(?:ed)?|mail|inbox)\b/i.test(t) || EMAIL_RE().test(t);
  const wantsText = /\b(?:text(?:ed)?|txt|sms|phone|cell|mobile|number)\b/i.test(t) && !/\b(?:e-?mail|inbox)\b/i.test(t);
  return { via: wantsMail && !wantsText ? 'email' : wantsText ? 'text' : null };
}

/** STOP / opt-out keywords a texted recipient may reply with (and START to opt back in). */
export const isStopWord = (s) => /^\s*(?:stop|stopall|unsubscribe|cancel|end|quit|opt[- ]?out|revoke)\s*[.!]*\s*$/i.test(String(s || ''));
export const isStartWord = (s) => /^\s*(?:start|unstop)\s*[.!]*\s*$/i.test(String(s || ''));

// ------------------------------------------------------------------ addresses
const EMAIL_RE = () => /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,24}/gi;
const PHONE_RE = () => /(?:\+|\b00)?\(?\d[\d\s().-]{5,18}\d/g;
export function validEmail(s) {
  const e = String(s || '').trim();
  if (e.length > 254 || !/^[A-Z0-9._%+'-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63})*\.[A-Z]{2,24}$/i.test(e)) return null;
  if (/\.\.|^\.|\.@|@-|-\./.test(e)) return null;
  return e.toLowerCase();
}
/**
 * A spoken or typed number → E.164 a text may go to, or null. The default country is the sending line's (US/CA when
 * unknown): "905 555 0123" → +19055550123; with a +44 line "07700 900123" → +447700900123. Texts only ever go to the
 * sending line's country, never to a premium-rate, N11 or short-code number (shop.mjs textableNumber).
 */
export function normalizePhone(raw, fromNumber = '') {
  const s = String(raw || '').trim().replace(/^00/, '+');
  const digits = s.replace(/[^\d+]/g, '');
  if (!/\d{7,}/.test(digits.replace(/\+/g, ''))) return null;
  const cc = countryCodeOf(toE164(fromNumber)) || '1';
  let e;
  if (digits.startsWith('+')) e = toE164(digits);
  else if (cc === '1') e = toE164(digits);
  else e = toE164(`+${cc}${digits.replace(/^0+/, '')}`);
  return e ? textableNumber(e, fromNumber || '+1') : null;
}
/** Every e-mail address and phone-like run in a message (deduplicated, in order). */
export function findContacts(text, fromNumber = '') {
  const t = String(text || '');
  const emails = [...new Set((t.match(EMAIL_RE()) || []).map((x) => x.toLowerCase()))];
  const rest = t.replace(EMAIL_RE(), ' ');
  const phoneRuns = (rest.match(PHONE_RE()) || []).map((x) => x.trim()).filter((x) => x.replace(/\D/g, '').length >= 7);
  const phones = [...new Set(phoneRuns.map((x) => normalizePhone(x, fromNumber) || `invalid:${x}`))];
  return { emails, phones, raw: { phones: phoneRuns } };
}
export const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 1)}***@${d}` : '***'; };
export const maskPhone = (p) => `the number ending in ${String(p || '').replace(/\D/g, '').slice(-4)}`;
const maskOf = (via, to) => (via === 'email' ? maskEmail(to) : maskPhone(to));

// ------------------------------------------------------------------ delivery
/** Which media this server can send: { email, text }. A bot's own number (fromNumber) also turns texting on. */
export function sendInfoMedia(env = {}, fromNumber = '') {
  return { email: !!env.RESEND_API_KEY, text: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (fromNumber || env.TWILIO_FROM_NUMBER)) };
}
/** "Waterdown Village Chiropractic <answers@knowbot.knowdrive.ai>": the bot's name on the configured sending address. */
export function emailFrom(env = {}, botName = '') {
  const conf = oneLine(env.KNOWBOT_EMAIL_FROM || DEFAULT_EMAIL_FROM);
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(conf);
  const addr = m ? m[2] : conf;
  const name = oneLine(botName).replace(/["<>\\\r\n]/g, '').slice(0, 70) || (m ? m[1].replace(/^"|"$/g, '') : '') || 'KnowBot';
  return /[,;:()[\]@.]/.test(name) ? `"${name}" <${addr}>` : `${name} <${addr}>`;
}
/** Sends one e-mail through the mail API. → { id } */
export async function sendEmail(env, { from, to, subject, html, text, replyTo = null }, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY) throw new Error('e-mail sending is not configured (RESEND_API_KEY)');
  const base = String(env.RESEND_BASE_URL || 'https://api.resend.com').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/emails`, {
    method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`mail API HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}
/**
 * Sends one text. `from` is the bot's own number when it has one (the line it was provisioned), else TWILIO_FROM_NUMBER.
 * → { sid }
 */
export async function sendText(env, { from = null, to, body }, fetchImpl = fetch) {
  const sid = env.TWILIO_ACCOUNT_SID, tok = env.TWILIO_AUTH_TOKEN;
  const sender = from || env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !sender) throw new Error('texting is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
  const base = String(env.TWILIO_API_BASE_URL || 'https://api.twilio.com').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: sender, To: to, Body: body }).toString(), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`texting API HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// ------------------------------------------------------------------ the answer that goes out
/**
 * Any surface's answer → the one shape the formatters take: { question, answer, refused, citations:[{n,file,title,url?,
 * page?,section?,excerpt}], proof:{quoted:[{n,text}]}, proofUrl? }. Accepts the developer API's answer object, its public
 * JSON, and the Studio's SSE final ({text, status, citations[].quotes, proof.quotedLines}).
 */
export function normalizeAnswer(a) {
  if (!a || typeof a !== 'object') return null;
  const text = String(a.answer ?? a.text ?? '');
  const refused = !!a.refused || a.status === 'refused' || a.status === 'guard' || !text.trim();
  const citations = (Array.isArray(a.citations) ? a.citations : []).filter((c) => c && Number.isInteger(Number(c.n))).map((c) => ({
    n: Number(c.n), file: c.file || c.filename || '', title: c.title || '', ...(c.url ? { url: c.url } : {}), ...(c.page ? { page: c.page } : {}),
    ...(c.section ? { section: c.section } : {}), excerpt: c.excerpt || c.quotes?.[0]?.text || '',
  }));
  const quoted = (a.proof?.quoted || a.proof?.quotedLines || []).filter((q) => q && q.text).map((q) => ({ n: Number(q.n), text: String(q.text), ...(q.file ? { file: q.file } : {}) }));
  if (!quoted.length) for (const c of a.citations || []) for (const q of c?.quotes || []) if (q?.text) quoted.push({ n: Number(c.n), text: String(q.text) });
  return { question: oneLine(a.question || ''), answer: text, refused: refused || !citations.length, citations, proof: { quoted, hits: a.proof?.hits || [] },
    ...(a.proofUrl ? { proofUrl: a.proofUrl } : {}), ...(a.bot ? { bot: a.bot } : {}), ...(a.botName ? { botName: a.botName } : {}) };
}
/** The e-mail: the bot's answer, its quoted lines and sources, the proof link, and a one-line "you asked for this" note. */
export function emailMessage(answer, { botName = 'KnowBot', to = '', proofUrl = null } = {}) {
  const r = { ...answer, refused: false };
  const { text, html } = formatEmail(r, { proofUrl, botName, question: answer.question });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const note = `You asked ${botName} to send this to ${to}. Nothing else will be sent unless you ask again, so there is nothing to unsubscribe from. If this wasn't you, you can ignore it.`;
  const asked = answer.question ? `You asked: "${answer.question}"\n\n` : '';
  return {
    subject: clipWords(answer.question ? `${botName}: ${answer.question}` : `Your answer from ${botName}`, 140).replace(/[\r\n]+/g, ' '),
    text: `${asked}${text}\n\n--\n${note}\n`,
    html: `<div style="font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:600px">${answer.question ? `<p style="margin:0 0 14px;color:#555">You asked: “${esc(answer.question)}”</p>` : ''}${html}<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e5e7eb;color:#888;font-size:12px">${esc(note)}</p></div>`,
  };
}
/** The text: the answer's facts packed into one message with the proof link and the opt-out line (≤ 320 characters). */
export function textMessage(answer, { botName = 'KnowBot', proofUrl = null } = {}) {
  const footer = toGsm7(`You asked ${clipWords(botName, 40).replace(/…$/, '')} to send this. Reply STOP to opt out.`);
  const body = formatSms({ ...answer, refused: false }, proofUrl, TEXT_MAX - footer.length - 1);
  return `${body}\n${footer}`.slice(0, TEXT_MAX);
}

// ------------------------------------------------------------------ the conversation seam
const ASK_RE = /\bwhat (?:e-?mail address|mobile number|e-?mail address or mobile number)\b[^?]*\?|doesn'?t look like (?:a valid|an?) |reply with (?:that|your) (?:e-?mail|address)|I can (?:also )?(?:e-?mail|text) it to you/i;

export function createSendInfo({ env = {}, log = () => {}, now = () => Date.now(), dataDir = null, onSent = (e) => logSendEvent({ scopeTags: e.scopeTags, via: e.via, callerKey: e.callerKey }), fetchImpl = fetch } = {}) {
  const lim = { caller: Number(env.KNOWBOT_SENDINFO_PER_CALLER_HOUR || 5), dest: Number(env.KNOWBOT_SENDINFO_PER_DEST_HOUR || 5), bot: Number(env.KNOWBOT_SENDINFO_PER_BOT_DAY || 200) };
  const last = new Map();     // conversation key → { at, answer }  (grounded answers only)
  const pending = new Map();  // conversation key → { at, via, answer }
  const windows = new Map();  // rate-limit key → [t]
  const stops = new Map();    // botId → Set(hash of E.164); '*' = every bot (one shared sending line)
  let stopsLoaded = null;
  const stopFile = dataDir ? path.join(dataDir, 'sendinfo-stops.json') : null;

  const fresh = (m, k, ttl) => { const v = m.get(k); if (!v) return null; if (now() - v.at > ttl) { m.delete(k); return null; } return v; };
  const cap = (m, max) => { while (m.size > max) m.delete(m.keys().next().value); };
  function hit(key, n, ms) {
    if (!n) return false;
    const t = now();
    const arr = (windows.get(key) || []).filter((x) => t - x < ms);
    if (arr.length >= n) { windows.set(key, arr); return true; }
    arr.push(t); windows.set(key, arr); cap(windows, 20000);
    return false;
  }
  const peek = (key, n, ms) => { const t = now(); return n && (windows.get(key) || []).filter((x) => t - x < ms).length >= n; };

  // ---------------------------------------------------------------- STOP list (in memory, persisted per bot)
  function loadStops() {
    if (!stopsLoaded) stopsLoaded = (async () => {
      if (!stopFile) return;
      try { const j = JSON.parse(await fsp.readFile(stopFile, 'utf8')); for (const [b, list] of Object.entries(j || {})) stops.set(b, new Set([...(stops.get(b) || []), ...list])); } catch { /* none yet */ }
    })();
    return stopsLoaded;
  }
  function saveStops() {
    if (!stopFile) return Promise.resolve();
    const doc = JSON.stringify(Object.fromEntries([...stops].map(([b, s]) => [b, [...s]])));
    return fsp.mkdir(path.dirname(stopFile), { recursive: true }).then(() => fsp.writeFile(stopFile, doc)).catch((e) => log(`[sendinfo] could not save the opt-out list: ${e.message}`));
  }
  async function optOut(botId, number) {
    await loadStops();
    const h = hash8(toE164(number) || number);
    for (const b of [String(botId || '*'), '*']) { const s = stops.get(b) || new Set(); s.add(h); stops.set(b, s); }
    log(`[sendinfo] bot ${botId}: from:${h} opted out of texts`);
    return saveStops();
  }
  async function optIn(botId, number) {
    await loadStops();
    const h = hash8(toE164(number) || number);
    for (const b of [String(botId || '*'), '*']) stops.get(b)?.delete(h);
    return saveStops();
  }
  async function isOptedOut(botId, number) {
    await loadStops();
    const h = hash8(toE164(number) || number);
    return !!(stops.get(String(botId))?.has(h) || stops.get('*')?.has(h));
  }

  // ---------------------------------------------------------------- memory of answers
  function remember(key, a) {
    const n = normalizeAnswer(a);
    if (!key || !n || n.refused) return;
    last.delete(key); last.set(key, { at: now(), answer: n }); cap(last, 5000);
  }
  const lastFor = (key) => fresh(last, key, 6 * HOUR)?.answer || null;

  // ---------------------------------------------------------------- one send
  /**
   * Sends `answer` to one address. → { status: 'sent'|'invalid'|'nothing'|'unavailable'|'limited'|'opted_out'|'failed', via, to (masked), reply }
   * `to` is an e-mail address or a phone number as typed or spoken; `via` is inferred from it when not given.
   */
  async function send({ botId, botName = 'KnowBot', replyTo = null, channel = 'api', via = null, to, answer, proofUrlFor = null, callerKey = null, fromNumber = null, scopeTags = [] }) {
    const media = sendInfoMedia(env, fromNumber);
    const a = normalizeAnswer(answer);
    if (!a || a.refused) return { status: 'nothing', reply: NOTHING };
    const raw = String(to || '').trim();
    via = via || (/@/.test(raw) ? 'email' : 'text');
    const dest = via === 'email' ? validEmail(raw) : normalizePhone(raw, fromNumber || env.TWILIO_FROM_NUMBER);
    if (!dest) return { status: 'invalid', via, reply: via === 'email' ? "That doesn't look like a valid email address. Could you send it again?" : "That doesn't look like a mobile number I can text. Could you send it again, with the area code?" };
    if (!media[via]) return { status: 'unavailable', via, reply: via === 'email' ? `I can't send email from here${media.text ? ', but I can text it to you. What mobile number should I use?' : '.'}` : `I can't send texts from here${media.email ? ', but I can email it to you. What email address should I use?' : '.'}` };
    if (via === 'text' && await isOptedOut(botId, dest)) return { status: 'opted_out', via, reply: `That number has opted out of texts, so I can't text it.${media.email ? ' I can email it instead: what email address should I use?' : ''}` };
    const ck = `c:${botId}|${hash8(callerKey || dest)}`, dk = `d:${hash8(dest)}`, bk = `b:${botId}`;
    if (peek(ck, lim.caller, HOUR) || peek(dk, lim.dest, HOUR) || peek(bk, lim.bot, DAY)) {
      log(`[sendinfo] bot ${botId}: send by ${via} refused, rate limited`);
      return { status: 'limited', via, reply: "I've sent several messages already. Please try again a little later." };
    }
    const proofUrl = a.proofUrl || (typeof proofUrlFor === 'function' ? await Promise.resolve(proofUrlFor(a)).catch(() => null) : null);
    try {
      if (via === 'email') {
        const m = emailMessage(a, { botName, to: dest, proofUrl });
        await sendEmail(env, { from: emailFrom(env, botName), to: dest, subject: m.subject, html: m.html, text: m.text, replyTo: replyTo && validEmail(replyTo) ? validEmail(replyTo) : null }, fetchImpl);
      } else {
        await sendText(env, { from: fromNumber || null, to: dest, body: textMessage(a, { botName, proofUrl }) }, fetchImpl);
      }
    } catch (e) {
      log(`[sendinfo] bot ${botId}: send by ${via} failed: ${e.message}`);
      return { status: 'failed', via, reply: "Sorry, I couldn't send that just now. Please try again in a moment." };
    }
    hit(ck, lim.caller, HOUR); hit(dk, lim.dest, HOUR); hit(bk, lim.bot, DAY);
    log(`[sendinfo] bot ${botId}: sent by ${via} (${channel}) to:${hash8(dest)}`);
    try { onSent?.({ botId, via, channel, callerKey, scopeTags, to: hash8(dest) }); } catch (e) { log(`[sendinfo] insights event failed: ${e.message}`); }
    const masked = maskOf(via, dest);
    return { status: 'sent', via, to: masked, reply: via === 'email' ? `Sent to ${masked}. It has the answer, the quoted lines with their sources, and a link to see them in context.` : `Sent to ${masked}, with a link to the sources.` };
  }

  // ---------------------------------------------------------------- the conversation turn
  async function pickAnswer({ key, question, lastAnswer, history, answerFor }) {
    // the answer to a question they name ("email me your return policy"), when it differs from the last one
    const words = oneLine(question).toLowerCase().replace(EMAIL_RE(), ' ').replace(PHONE_RE(), ' ').match(/[a-z][a-z'-]*/g) || [];
    const topic = words.filter((w) => w.length > 2 && !FILLER.has(w));
    const lastA = normalizeAnswer(lastAnswer) || lastFor(key);
    if (topic.length && typeof answerFor === 'function') {
      const lq = new Set(String(lastA?.question || '').toLowerCase().match(/[a-z]+/g) || []);
      if (!lastA || !topic.some((w) => lq.has(w) || lq.has(w.replace(/s$/, '')))) {
        const a = normalizeAnswer(await answerFor(topic.join(' ')).catch(() => null));
        if (a && !a.refused) return a;
        if (!lastA) return null;
      }
    }
    if (lastA && !lastA.refused) return lastA;
    // a stateless client: the last question in the history it sent, answered again
    if (typeof answerFor === 'function' && Array.isArray(history)) {
      const prevQ = [...history].reverse().find((m) => m?.role === 'user' && m.content && !detectSendIntent(m.content) && !findContacts(m.content).emails.length);
      if (prevQ) { const a = normalizeAnswer(await answerFor(String(prevQ.content).slice(0, 1000)).catch(() => null)); if (a && !a.refused) return a; }
    }
    return null;
  }
  const askFor = (via, media) => {
    if (via === 'email' && !media.email) return `I can't send email from here, but I can text it to you. What mobile number should I use?`;
    if (via === 'text' && !media.text) return `I can't send texts from here, but I can email it to you. What email address should I use?`;
    if (via === 'email' || !media.text) return 'Sure. What email address should I send it to?';
    if (via === 'text' || !media.email) return 'Sure. What mobile number should I text it to?';
    return 'Sure. What email address or mobile number should I send it to?';
  };

  /**
   * One visitor turn on a text surface. → null when this is not about sending (answer normally), else the reply to send
   * instead of an answer: { reply, status: 'ask'|'sent'|'invalid'|'nothing'|'unavailable'|'limited'|'opted_out'|'failed'|'cancelled'|'here', via?, to? }.
   * @param {object} o
   * @param {string} o.key        the conversation (bot + channel + caller)
   * @param {string} o.channel    studio | web | api | sms | whatsapp | email | voice
   * @param {string} [o.caller]   the sender's own address on that channel (their number on sms/whatsapp, address on email)
   * @param {object} [o.lastAnswer]  the conversation's last answer when the surface knows it (else the remembered one)
   * @param {(q: string) => Promise<object>} [o.answerFor]  answers a referenced question (logged like any question)
   */
  async function maybeSendInfo({ key, botId, botName = 'KnowBot', replyTo = null, question, history = [], lastAnswer = null, channel = 'api', caller = null,
    callerKey = null, proofUrlFor = null, answerFor = null, fromNumber = null, scopeTags = [] }) {
    const q = oneLine(question).slice(0, 1000);
    if (!q || !key) return null;
    const media = sendInfoMedia(env, fromNumber);
    const intent = detectSendIntent(q);
    let pend = fresh(pending, key, PENDING_TTL_MS);
    if (!pend && Array.isArray(history)) {
      const prev = [...history].reverse().find((m) => m?.role === 'assistant');
      if (prev && ASK_RE.test(String(prev.content || ''))) pend = { at: now(), via: null, answer: null };
    }
    if (!intent && !pend) return null;
    if (!media.email && !media.text) {
      if (!intent) { pending.delete(key); return null; }
      return { status: 'unavailable', reply: "Sorry, I can't send messages from here." };
    }
    const fromNo = fromNumber || env.TWILIO_FROM_NUMBER || '';
    const c = findContacts(q, fromNo);
    const valid = [...c.emails.filter(validEmail).map((to) => ({ via: 'email', to })), ...c.phones.filter((p) => !p.startsWith('invalid:')).map((to) => ({ via: 'text', to }))];
    const tried = c.emails.length + c.phones.length;
    if (!intent) {
      // a pending request: the next message should be the address
      if (CANCEL.test(q)) { pending.delete(key); return { status: 'cancelled', reply: "No problem, I won't send it." }; }
      if (!tried && !/@/.test(q) && YES.test(q) && pend.answer) return { status: 'ask', via: pend.via, reply: askFor(pend.via, media) };
      if (!tried && !/@/.test(q)) { pending.delete(key); return null; } // a new question: answer it normally
    }
    if (valid.length > 1 || tried > 1) { pending.set(key, { at: now(), via: pend?.via || intent?.via || null, answer: pend?.answer || null }); return { status: 'ask', reply: 'I can only send it to one address at a time. Which one should I use?' }; }
    const answer = pend?.answer || await pickAnswer({ key, question: intent ? q : '', lastAnswer, history, answerFor });
    if (!answer) { pending.delete(key); return { status: 'nothing', reply: NOTHING }; }
    if (!valid.length) {
      if (tried || /@/.test(q.replace(EMAIL_RE(), ' '))) {
        pending.set(key, { at: now(), via: pend?.via || intent?.via || null, answer });
        const via = c.emails.length || /@/.test(q) ? 'email' : 'text';
        return { status: 'invalid', via, reply: via === 'email' ? "That doesn't look like a valid email address. Could you send it again?" : "That doesn't look like a mobile number I can text. Could you send it again, with the area code?" };
      }
      // no address yet: the channel's own address when it is the medium they asked for, else ask for one
      const want = intent?.via || null;
      pending.set(key, { at: now(), via: want, answer });
      cap(pending, 5000);
      if ((channel === 'sms' || channel === 'whatsapp') && want !== 'email') {
        return { status: 'here', reply: `It's right here in this conversation.${media.email ? ' I can also email it to you: what email address should I use?' : ''}` };
      }
      if (channel === 'email' && caller && want !== 'text') {
        return { status: 'here', reply: `My replies already come to you by email at ${maskEmail(caller)}, so the answer is in this thread. To send it somewhere else, reply with that email address${media.text ? ' or a mobile number' : ''}.` };
      }
      return { status: 'ask', via: want, reply: askFor(want, media) };
    }
    const r = await send({ botId, botName, replyTo, channel, via: valid[0].via, to: valid[0].to, answer, proofUrlFor, callerKey: callerKey || caller || key, fromNumber, scopeTags });
    if (r.status === 'sent' || r.status === 'nothing') pending.delete(key);
    else pending.set(key, { at: now(), via: pend?.via || null, answer });
    return r;
  }

  return { maybeSendInfo, send, remember, lastFor, optOut, optIn, isOptedOut, media: (fromNumber) => sendInfoMedia(env, fromNumber), _pending: pending };
}

export const NOTHING = "There's nothing to send yet. Ask me a question first, and I can send you the answer with its sources.";

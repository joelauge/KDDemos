// Shared plumbing for the channel adapters: provider signatures, form parsing, TwiML, and per-medium formatting of a
// grounded answer (the same answer object every channel gets from devapi.mjs's ask()).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const NOT_IN_DATA = "I can't seem to find an answer to that in any of my current data sources.";

// ------------------------------------------------------------------ http
export class ChannelError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const notConfigured = (channel, needs) => new ChannelError(503, 'channel_not_configured',
  `The ${channel} channel is not configured on this server. Set ${needs.join(' and ')}.`);

/** Parses application/x-www-form-urlencoded or multipart/form-data into a plain object of strings (files skipped). */
export async function parseForm(raw, contentType = '') {
  const ct = String(contentType || '');
  if (/application\/x-www-form-urlencoded/i.test(ct) || (!/multipart\//i.test(ct) && !/json/i.test(ct))) {
    return Object.fromEntries(new URLSearchParams(Buffer.from(raw || []).toString('utf8')));
  }
  if (/multipart\//i.test(ct)) {
    const fd = await new Request('http://local/', { method: 'POST', headers: { 'content-type': ct }, body: raw }).formData();
    const out = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string' && !(k in out)) out[k] = v;
    return out;
  }
  return {};
}

/** The public base URL providers call (KNOWBOT_PUBLIC_URL, else what the proxy forwarded). */
export function publicBase(req, env = {}) {
  if (env.KNOWBOT_PUBLIC_URL) return String(env.KNOWBOT_PUBLIC_URL).replace(/\/+$/, '');
  const h = req.headers || {};
  const proto = String(h['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = String(h['x-forwarded-host'] || h.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 over the full URL plus every POST param (sorted, key+value). */
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((s, k) => s + k + (params[k] ?? ''), String(url));
  return createHmac('sha1', String(authToken)).update(Buffer.from(data, 'utf8')).digest('base64');
}
/** True when the request carries a valid Twilio signature for any of the URLs it could have been sent to. */
export function twilioValid(req, authToken, params, env = {}) {
  const sig = String(req.headers['x-twilio-signature'] || '');
  if (!sig || !authToken) return false;
  const path = req.url;
  const bases = [...new Set([publicBase(req, env), publicBase(req, {})])];
  const urls = [];
  for (const b of bases) {
    urls.push(b + path);
    // Twilio drops default ports; some proxies add them
    urls.push(b.replace(/:(?:443|80)$/, '') + path);
  }
  return [...new Set(urls)].some((u) => safeEq(twilioSignature(authToken, u, params), sig));
}

/** Meta's X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256 of the raw body with the app secret. */
export function metaSignature(appSecret, raw) { return `sha256=${createHmac('sha256', String(appSecret)).update(Buffer.from(raw || [])).digest('hex')}`; }
export function metaValid(req, appSecret, raw) {
  const sig = String(req.headers['x-hub-signature-256'] || '');
  return !!sig && !!appSecret && safeEq(metaSignature(appSecret, raw), sig);
}

/** Mailgun webhook signature: hex HMAC-SHA256(signing key, timestamp + token). */
export function mailgunSignature(key, timestamp, token) { return createHmac('sha256', String(key)).update(`${timestamp}${token}`).digest('hex'); }

// ------------------------------------------------------------------ TwiML
export const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function sendXml(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`);
}
export function sendJsonRes(res, status, body, headers = {}) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// ------------------------------------------------------------------ formatting
/** Answer lines without list bullets; [n] markers kept. */
export function answerLines(answer) {
  return String(answer || '').split('\n').map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean);
}
const stripMarks = (s) => String(s || '').replace(/\s*\[\d{1,3}\]/g, '').replace(/\s+([.,;:!?])/g, '$1').trim();
const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'vs', 'via', 'per']);
const ACRONYMS = new Set(['faq', 'faqs', 'api', 'sms', 'usa', 'uk', 'eu', 'pdf', 'hr', 'qa', 'sla', 'tos', 'gdpr', 'hipaa', 'ceo', 'cto', 'b2b', 'b2c', 'ai', 'kb', 'url', 'diy', 'rma', 'vat', 'gst', 'hvac']);
/** "lumen store faq" → "Lumen Store FAQ" (small words stay lower case except the first; common acronyms upper case). */
export function titleCase(s) {
  return String(s || '').split(/(\s+)/).map((w, i) => {
    if (!w.trim()) return w;
    const lw = w.toLowerCase();
    if (ACRONYMS.has(lw.replace(/[^a-z0-9]/g, ''))) return w.toUpperCase();
    if (i > 0 && SMALL_WORDS.has(lw)) return lw;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}
/**
 * A document's display title: its own heading when it has one with real casing ("Lumen Store FAQ"), else the title-cased
 * file name ("lumen-warranty-returns.md" → "Lumen Warranty Returns"). Never the lower-cased slug.
 */
export function docTitle(title, file) {
  const t = String(title || '').trim();
  const name = String(file || '').split('/').pop();
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  const fromFile = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const own = t && t !== name && t !== stem ? t : '';
  if (own && /[A-Z]/.test(own)) return own;
  return titleCase(own || fromFile) || 'Your files';
}
/** A citation's display title (see docTitle). */
export function humanTitle(c = {}) { return docTitle(c.title, c.file || c.filename); }
/** Cut at a word boundary to `max` characters (with an ellipsis). */
export function clipWords(s, max) {
  s = String(s || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - 1));
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** The answer as whole sentences, each ending "… text [n]." (the line's [n] markers before the stop). */
export function answerSentences(answer) {
  const out = [];
  for (const line of answerLines(answer)) {
    const marks = [...new Set([...line.matchAll(/\[(\d{1,3})\]/g)].map((m) => m[1]))];
    const tag = marks.length ? ` ${marks.map((n) => `[${n}]`).join('')}` : '';
    const body = stripMarks(line).replace(/\s*\|\s*/g, ', ').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    for (let sn of body.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/)) {
      sn = sn.trim();
      if (!sn) continue;
      let stop = '.';
      const m = /([.!?…]+|[:;,])$/.exec(sn);
      if (m) { if (/[.!?…]/.test(m[1])) stop = m[1]; sn = sn.slice(0, -m[1].length).trimEnd(); }
      if (sn) out.push({ text: sn.charAt(0).toUpperCase() + sn.slice(1), tag, stop });
    }
  }
  return out;
}

/** Sentences joined for SMS: a run of sentences from the same source carries its marker once, at the end of the run. */
export function smsJoin(list) {
  return list.map((x, i) => {
    const same = i + 1 < list.length && list[i + 1].tag && list[i + 1].tag === x.tag;
    return `${x.text}${same ? '' : x.tag}${x.stop}`;
  }).join(' ');
}

/**
 * SMS: ≤ 320 characters. The answer's own sentences with their [n] markers, cut at a sentence boundary, then
 * " Proof: <link>". Never citation excerpts, never a half sentence (unless the first sentence alone is too long).
 * A refusal is the canonical sentence, unchanged.
 */
export function formatSms(r, proofUrl, max = 320) {
  if (r.refused) return NOT_IN_DATA;
  const suffix = proofUrl ? ` Proof: ${proofUrl}` : '';
  const budget = Math.max(60, max - suffix.length);
  const sentences = answerSentences(r.answer);
  let body = '';
  const picked = [];
  for (const x of sentences) {
    const next = smsJoin([...picked, x]);
    if (next.length > budget) break;
    picked.push(x); body = next;
  }
  if (!body && sentences.length) { const x = sentences[0]; body = `${clipWords(x.text, Math.max(20, budget - x.tag.length))}${x.tag}`; }
  return body + suffix;
}

/** WhatsApp: the answer with [n] markers, then numbered source footnotes and the proof link (≤ 4096). */
export function formatWhatsApp(r, proofUrl) {
  if (r.refused) return NOT_IN_DATA;
  const lines = answerLines(r.answer);
  const body = lines.length > 1 ? lines.map((l) => `• ${l}`).join('\n') : lines.join('');
  const notes = (r.citations || []).map((c) => `[${c.n}] ${humanTitle(c)}${c.file ? ` (${String(c.file).split('/').pop()})` : ''}`);
  const out = `${body}\n\n*Sources*\n${notes.join('\n')}${proofUrl ? `\n\nSee the exact quotes: ${proofUrl}` : ''}`;
  return out.length > 4096 ? `${clipWords(out, 4000)}` : out;
}

/** E-mail: plain text and HTML bodies with footnoted citations, the quoted lines and a source list. */
export function formatEmail(r, { proofUrl, botName = 'KnowBot', question = '' } = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (r.refused) {
    const text = `${NOT_IN_DATA}\n\n${botName} answers only from its own files, so it would rather say so than guess.\n${question ? `\nYou asked: "${question}"\n` : ''}`;
    const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:600px"><p>${esc(NOT_IN_DATA)}</p><p style="color:#555">${esc(botName)} answers only from its own files, so it would rather say so than guess.</p>${question ? `<p style="color:#555">You asked: “${esc(question)}”</p>` : ''}</div>`;
    return { text, html };
  }
  const lines = answerLines(r.answer);
  const quotes = r.proof?.quoted || [];
  const src = (r.citations || []).map((c) => {
    const q = quotes.filter((x) => x.n === c.n).map((x) => x.text);
    return { c, q: q.length ? q : (c.excerpt ? [c.excerpt] : []) };
  });
  const text = [
    ...lines.map((l) => (lines.length > 1 ? `- ${l}` : l)), '',
    'Sources', ...src.flatMap(({ c, q }) => [`[${c.n}] ${humanTitle(c)}${c.file ? ` (${String(c.file).split('/').pop()})` : ''}`, ...q.slice(0, 2).map((x) => `    "${x}"`)]),
    ...(proofUrl ? ['', `See every quote in context: ${proofUrl}`] : []), '',
    `${botName} answers only from its own files, and cites every line.`,
  ].join('\n');
  const sup = (s) => esc(s).replace(/\[(\d{1,3})\]/g, '<sup style="color:#4f46e5;font-weight:600">[$1]</sup>');
  const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:600px">`
    + (lines.length > 1 ? `<ul style="padding-left:20px;margin:0 0 16px">${lines.map((l) => `<li style="margin:0 0 6px">${sup(l)}</li>`).join('')}</ul>` : `<p style="margin:0 0 16px">${sup(lines[0] || '')}</p>`)
    + `<p style="margin:20px 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#666">Sources</p><ol style="padding-left:20px;margin:0">`
    + src.map(({ c, q }) => `<li value="${c.n}" style="margin:0 0 10px"><strong>${esc(humanTitle(c))}</strong>${c.file ? ` <span style="color:#666">${esc(String(c.file).split('/').pop())}</span>` : ''}${q.slice(0, 2).map((x) => `<blockquote style="margin:6px 0 0;padding:4px 10px;border-left:3px solid #c7d2fe;color:#333;background:#f5f7ff">${esc(x)}</blockquote>`).join('')}</li>`).join('')
    + `</ol>${proofUrl ? `<p style="margin:16px 0 0"><a href="${esc(proofUrl)}" style="color:#4f46e5">See every quote in context →</a></p>` : ''}`
    + `<p style="margin:20px 0 0;color:#777;font-size:13px">${esc(botName)} answers only from its own files, and cites every line.</p></div>`;
  return { text, html };
}

// After "According to the X, " only an ordinary sentence opener is lower-cased; a name ("Lumen frames …", "Lumen Care Plan …"),
// an acronym or anything else keeps the casing the source wrote it in. Even a common opener keeps its capital when the
// bot's own material treats it as a name: it appears capitalised mid-sentence in the answer, a quote or an excerpt
// ("our Standard plan …"), or it is one of the bot's name / org tokens.
const LEAD_LOWER = /^(?:you|your|yours|we|our|ours|they|their|there|it|its|this|that|these|those|the|a|an|all|any|each|every|most|some|no|if|when|after|before|during|within|only|orders?|items?|customers?|refunds?|returns?|shipping|standard|free)$/;
// Generic document words in a source title are not names ('Warranty lasts …' after '… Warranty Policy' reads 'warranty lasts').
const DOC_NOUNS = /^(?:warranty|warranties|policy|policies|guide|guides|faq|faqs|terms|conditions|manual|handbook|pricing|prices?|list|lists|service|services|support|info|information|and|of|for|overview|notes|plans?|bikes?|products?|sheet|page|doc|docs|document|e-bike|batteries|battery)$/;
const NAME_SKIP = new Set(['you', 'your', 'we', 'our', 'the', 'a', 'an', 'my', 'it', 'its']);
/** Words written with a capital somewhere other than the start of a sentence (lower-cased keys), plus the given names. */
export function properWords(texts = [], names = []) {
  const out = new Set();
  for (const n of names) for (const w of String(n || '').match(/[A-Za-z][A-Za-z']*/g) || []) if (/^[A-Z]/.test(w) && !NAME_SKIP.has(w.toLowerCase())) out.add(w.toLowerCase());
  for (const t of texts) {
    // a capitalised word preceded by a lower-case word or a comma (not a sentence start, not a list bullet or heading)
    for (const m of String(t || '').matchAll(/(?:[a-z0-9,;)][ \t]+)([A-Z][a-z']+)\b/g)) out.add(m[1].toLowerCase());
  }
  return out;
}
// Function words: always an ordinary sentence opener after "According to the X, " ("the Lumen Care Plan costs …").
const LEAD_FUNCTION = /^(?:you|your|yours|we|our|ours|they|their|there|it|its|this|that|these|those|the|a|an|all|any|each|every|most|some|no|if|when|after|before|during|within|only|to|for|in|on|at|with|as|by|from|yes)$/;
const CALENDAR = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/;
/**
 * Lower-cases the first letter of `s` after a spoken attribution ("According to the Warranty, e-bike batteries …"), unless
 * the opening word is a name: an acronym or mixed-case word ("UPS", "iPhone", "E-Bike"), "I", a weekday or month, a word
 * the bot's own material capitalises mid-sentence or that is part of its name / a source title (`proper`), or the first
 * word of a multi-word name ("Lumen Care Plan …"). Function words ("The", "Your") always lower-case.
 */
export function lowerLead(s, proper = new Set()) {
  const w = /^[A-Za-z][A-Za-z'-]*/.exec(s)?.[0] || '';
  if (!w || !/^[A-Z]/.test(w)) return s;
  const lw = w.toLowerCase();
  if (LEAD_FUNCTION.test(lw)) return s.charAt(0).toLowerCase() + s.slice(1);
  if (/[A-Z]/.test(w.slice(1)) || /^I(?:'[a-z]+)?$/.test(w) || CALENDAR.test(lw) || proper.has(lw) || proper.has(lw.replace(/'s$/, ''))) return s;
  // "Lumen Care Plan …": a capitalised word followed by another starts a name; keep the capital
  const next = /^[A-Za-z'-]+\s+([A-Za-z][A-Za-z']*)/.exec(s)?.[1] || '';
  if (/^[A-Z]/.test(next) && !/^(?:I|I'm|I've|I'll|I'd)$/.test(next)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
/** "the Returns Policy", "the Shipping file" (a title that already starts with an article keeps its own). */
export function withArticle(title) {
  const t = String(title || '').trim();
  if (/^(?:the|a|an|our|your)\s/i.test(t)) return t.replace(/^(\w+)/, (m) => m.toLowerCase());
  // a one-word topic title reads as a file ("the Shipping file"); a document name stands on its own ("the FAQ", "the Lumen Care Plan")
  return /\s/.test(t) || DOC_NOUNS.test(t.toLowerCase()) ? `the ${t}` : `the ${t} file`;
}
/**
 * Voice: spoken attribution ("According to the Lumen Warranty and Returns Policy, e-bike batteries …"), no markers, at most two quoted lines,
 * ≤ ~450 characters. A refusal is the canonical sentence. `names`: the bot's name / org, whose words keep their capital.
 */
export function formatSpoken(r, max = 450, { names = [] } = {}) {
  if (r.refused) return NOT_IN_DATA;
  const quotes = (r.proof?.quoted || []).filter((q) => q.text);
  const byN = new Map((r.citations || []).map((c) => [c.n, c]));
  // the source titles count as names too ("Lumen Bikes Warranty and Returns Policy" → "Lumen frames …" keeps its capital)
  // (only real name words: an ordinary opener such as "Refunds" in a "Refunds" title still reads "And Refunds, refunds go …")
  const titles = (r.citations || []).flatMap((c) => [humanTitle(c), c.title]).map((t) => String(t || '').split(/\s+/).filter((w) => { const x = w.toLowerCase().replace(/[^a-z']/g, ''); return !LEAD_LOWER.test(x) && !DOC_NOUNS.test(x); }).join(' '));
  const proper = properWords([r.answer, ...quotes.map((q) => q.text), ...(r.citations || []).map((c) => c.excerpt)], [...names, ...titles]);
  const parts = [];
  let lastN = null;
  const items = quotes.length ? quotes.map((q) => ({ n: q.n, text: q.text })) : answerLines(r.answer).map((l) => ({ n: Number(/\[(\d{1,3})\]/.exec(l)?.[1]) || null, text: l }));
  for (const it of items.slice(0, 2)) {
    let s = stripMarks(it.text).replace(/[|]/g, ', ').replace(/\s*;\s*/g, '; ');
    if (!s) continue;
    if (!/[.!?]$/.test(s)) s += '.';
    const c = byN.get(it.n);
    if (c && it.n !== lastN) parts.push(`${parts.length ? 'And according to' : 'According to'} ${withArticle(humanTitle(c))}, ${lowerLead(s, proper)}`);
    else parts.push(s);
    lastN = it.n;
  }
  return clipWords(parts.join(' ') || stripMarks(r.answer), max);
}

// ------------------------------------------------------------------ status
/** Which channels this server can run, and what each still needs (names of env vars only, never values). */
export function channelStatus(env = {}) {
  const has = (k) => !!env[k];
  const google = { stt: has('GOOGLE_STT_API_KEY') || has('GOOGLE_API_KEY') || has('GOOGLE_ACCESS_TOKEN'), tts: has('GOOGLE_TTS_API_KEY') || has('GOOGLE_API_KEY') || has('GOOGLE_ACCESS_TOKEN') };
  const meta = has('WHATSAPP_VERIFY_TOKEN') && has('WHATSAPP_APP_SECRET') && has('WHATSAPP_ACCESS_TOKEN') && has('WHATSAPP_PHONE_NUMBER_ID');
  const emailIn = has('EMAIL_WEBHOOK_SECRET') || has('MAILGUN_SIGNING_KEY');
  const emailOut = has('EMAIL_REPLY_WEBHOOK') || ((has('SENDGRID_API_KEY') || has('POSTMARK_SERVER_TOKEN')) && has('EMAIL_FROM'));
  return {
    sms: { configured: has('TWILIO_AUTH_TOKEN'), provider: 'twilio', needs: has('TWILIO_AUTH_TOKEN') ? [] : ['TWILIO_AUTH_TOKEN'] },
    voice: { configured: has('TWILIO_AUTH_TOKEN'), provider: 'twilio', needs: has('TWILIO_AUTH_TOKEN') ? [] : ['TWILIO_AUTH_TOKEN'],
      speech: { recognition: google.stt && has('TWILIO_ACCOUNT_SID') ? 'google' : 'twilio', synthesis: google.tts ? 'google' : 'twilio' } },
    whatsapp: { configured: meta || has('TWILIO_AUTH_TOKEN'), provider: meta ? 'meta' : has('TWILIO_AUTH_TOKEN') ? 'twilio' : null,
      needs: meta || has('TWILIO_AUTH_TOKEN') ? [] : ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] },
    email: { configured: emailIn, sends: emailOut, needs: emailIn ? (emailOut ? [] : ['EMAIL_REPLY_WEBHOOK or SENDGRID_API_KEY/POSTMARK_SERVER_TOKEN + EMAIL_FROM']) : ['EMAIL_WEBHOOK_SECRET or MAILGUN_SIGNING_KEY'] },
    voiceBot: { configured: true, google: google.stt && google.tts, recognition: google.stt ? 'google' : 'browser', synthesis: google.tts ? 'google' : 'browser' },
    chat: { configured: true },
  };
}

// Shared plumbing for the channel adapters: provider signatures, form parsing, TwiML, and per-medium formatting of a
// grounded answer (the same answer object every channel gets from devapi.mjs's ask()).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const NOT_IN_DATA = "The answer to that doesn't seem to be in my files.";

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
// The librarian voice writes a source as a markdown link: In [“Returns Policy”](https://…/returns), page 3, it says: “…” [1].
// Plain-text media get “Returns Policy” (https://…/returns) instead; only http(s) targets count as links.
const MD_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>"]+)\)/g;
/** Markdown links → “Title” (url), for SMS, WhatsApp and plain-text e-mail. */
export function delink(s) { return String(s ?? '').replace(MD_LINK, (_, t, u) => `${t} (${u})`); }
/**
 * Answer lines without list bullets; [n] markers kept. Markdown links become “Title” (url) unless `markdown` is true
 * (the developer API returns the answer's own markdown).
 */
export function answerLines(answer, { markdown = false } = {}) {
  return String(answer || '').split('\n').map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean).map((l) => (markdown ? l : delink(l)));
}
/**
 * The answer's lines marked as list items or not: an answer that has "- " bullets keeps exactly those as items (its
 * opener and closer stay plain lines); an answer of several unbulleted lines is listed whole, as before.
 */
export function listLines(answer, { markdown = false } = {}) {
  const raw = String(answer || '').split('\n').filter((l) => l.trim());
  const bulleted = raw.some((l) => /^\s*[-*•]\s+/.test(l));
  const lines = answerLines(answer, { markdown });
  return lines.map((text, i) => ({ text, item: bulleted ? /^\s*[-*•]\s+/.test(raw[i]) : lines.length > 1 }));
}
// Spans a sentence never ends inside: a quotation (“…” or "…"), a markdown link target and a bare URL.
const NO_SPLIT = /“[^”\n]*”|"[^"\n]*"|\]\(https?:\/\/[^\s)]+\)|\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)\]>"”]+/g;
/**
 * One line → its sentences, each with the [n] markers that follow its stop ("Returns take 30 days. [1]" stays one sentence).
 * A stop inside a quotation or a link never ends a sentence: “Frames are covered. Paint is not.” [1] is one sentence.
 */
export function splitSentences(line) {
  const src = String(line || '');
  const masked = src.replace(NO_SPLIT, (m) => m.replace(/[.!?…]/g, '_'));
  const out = [];
  let from = 0;
  for (const m of masked.matchAll(/(?<=[.!?…](?:\s*\[\d{1,3}\])*)\s+(?=\[“|["“(]?[A-Z0-9])/g)) {
    out.push(src.slice(from, m.index).trim());
    from = m.index + m[0].length;
  }
  out.push(src.slice(from).trim());
  return out.filter(Boolean);
}
// A friendly opener or closer with no fact in it (the only uncited sentences lib/knowbot.js's citation gate lets through).
const COURTESY_LEAD = /^(?:i'm not sure that answers it|can you tell me a bit more|did (?:you find|that answer|this answer)|was (?:that|this) helpful|does that cover|that covers part of it|what else would you like|i think i(?:'ve| have)? found|good news|great news|here(?:'s| is) what i found|i(?:'ve| have)? found (?:what|it|this|that|the answer|something|a few|a couple|some)|i hope|hope (?:this|that) helps|feel free|(?:i'm |i am )?happy to help|glad|let me know|thanks for|(?:good|great) question)/i;
export const isCourtesyLine = (s) => { const t = String(s || '').replace(/[‘’]/g, "'").trim(); return !!t && t.length <= 140 && !/\[\d{1,3}\]|\d|[$€£@“”"]|https?:/.test(t) && COURTESY_LEAD.test(t); };
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
/** Where in the document a citation points: "page 17, “Oil filter”" (only what the citation really carries). */
export function locOf(c = {}) {
  const page = Number.isInteger(Number(c.page)) && Number(c.page) > 0 ? Number(c.page) : null;
  const section = String(c.section || '').replace(/[“”"]/g, '').trim();
  return [page && `page ${page}`, section && `“${section}”`].filter(Boolean).join(', ');
}
const httpOf = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
/** A plain-text source line: "[1] Owner's Manual, page 17, “Oil filter” (manual.pdf)" plus the link on the next line. */
function noteLine(c, indent = '    ') {
  const loc = locOf(c);
  const file = c.file ? ` (${String(c.file).split('/').pop()})` : '';
  const url = httpOf(c.url);
  return `[${c.n}] ${humanTitle(c)}${loc ? `, ${loc}` : ''}${file}${url ? `\n${indent}${/\.pdf(?:[?#]|$)/i.test(url) ? 'Download' : 'Open'}: ${url}` : ''}`;
}
/** Cut at a word boundary to `max` characters (with an ellipsis). */
export function clipWords(s, max) {
  s = String(s || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - 1));
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * The answer as whole sentences, each ending "… text [n]." (its own [n] markers before the stop). Sentences never break
 * inside a quotation. A friendly opener or closer carries no marker (courtesy: true); any other sentence without its own
 * marker takes the markers of the cited sentence it belongs to in the same line ("A. B. [1]" → both [1]).
 */
export function answerSentences(answer) {
  const out = [];
  for (const line of answerLines(answer)) {
    const parts = splitSentences(line).map((sn) => ({ sn, marks: [...new Set([...sn.matchAll(/\[(\d{1,3})\]/g)].map((m) => m[1]))], courtesy: false }));
    for (const x of parts) if (!x.marks.length) x.courtesy = isCourtesyLine(x.sn);
    for (let i = 0; i < parts.length; i++) {
      const x = parts[i];
      if (x.marks.length || x.courtesy) continue;
      const donor = parts.slice(i + 1).find((y) => y.marks.length) || parts.slice(0, i).reverse().find((y) => y.marks.length);
      if (donor) x.marks = donor.marks;
    }
    for (const x of parts) {
      const tag = x.marks.length ? ` ${x.marks.map((n) => `[${n}]`).join('')}` : '';
      let sn = stripMarks(x.sn).replace(/\s*\|\s*/g, ', ').replace(/\s+/g, ' ').trim();
      if (!sn) continue;
      let stop = '.';
      const m = /([.!?…]+|[:;,])$/.exec(sn);
      if (m) { if (/[.!?…]/.test(m[1])) stop = m[1]; sn = sn.slice(0, -m[1].length).trimEnd(); }
      if (sn) out.push({ text: sn.charAt(0).toUpperCase() + sn.slice(1), tag, stop, ...(x.courtesy ? { courtesy: true } : {}) });
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

// GSM-7 (the 160-character SMS alphabet). One character outside it turns the whole message into UCS-2 (70 per segment).
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
const GSM_MAP = { '“': '"', '”': '"', '„': '"', '«': '"', '»': '"', '‘': "'", '’': "'", '‚': "'", '–': '-', '—': '-', '‑': '-', '−': '-', '…': '...', '•': '-', '·': '-', '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ', '×': 'x', '™': '(TM)', '®': '(R)', '©': '(C)' };
/** Curly quotes, dashes, ellipses and bullets → their GSM-7 forms; accents GSM-7 lacks lose the accent ("ê" → "e"). */
export function toGsm7(s) {
  return [...String(s ?? '')].map((c) => {
    if (GSM_MAP[c] != null) return GSM_MAP[c];
    if (GSM7.test(c)) return c;
    const bare = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return bare && GSM7.test(bare) ? bare : c;
  }).join('');
}
/** How an SMS body is billed: { encoding: 'GSM-7'|'UCS-2', chars, segments } (GSM-7 extension characters count twice). */
export function smsInfo(s) {
  const t = String(s ?? '');
  const gsm = GSM7.test(t);
  const chars = gsm ? [...t].reduce((n, c) => n + (/[\^{}\\[~\]|€]/.test(c) ? 2 : 1), 0) : t.length;
  const one = gsm ? 160 : 70, many = gsm ? 153 : 67;
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', chars, segments: chars === 0 ? 0 : chars <= one ? 1 : Math.ceil(chars / many) };
}
const qTokens = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !/^(?:the|and|for|you|your|how|what|does|can|are|with|from|that|this|its|long|much|many|any|our|has|have|was|did|when|where|which|who|why)$/.test(w)).map((w) => w.replace(/ies$/, 'y').replace(/([^s])s$/, '$1')));

/**
 * The answer as SMS items: the librarian voice's verbatim quotes ("quote" [n], without the "In “Title”, it says:" or
 * "From “Title”:" pointer, which the proof link carries), or a plain cited sentence. Courtesy openers/closers and a
 * list's "Here's what “Title” says [1]:" header are left out.
 */
export function smsItems(answer) {
  const out = [];
  for (const x of answerSentences(answer)) {
    if (x.courtesy) continue;
    const t = x.text;
    const q = /“([^”\n]+)”$/.exec(t);
    if (q && /,?\s*(?:it says|says|reads|states)\s*:?\s*$|:\s*$/i.test(t.slice(0, q.index)) || (q && /^(?:From|In)\s/.test(t))) { out.push({ quote: q[1].trim(), tag: x.tag, stop: x.stop }); continue; }
    if (q && /^“[^”]+”$/.test(t)) { out.push({ quote: q[1].trim(), tag: x.tag, stop: x.stop }); continue; }
    if (/^here(?:'s|’s| is) what\b/i.test(t) && /“/.test(t)) continue;
    out.push({ text: t, tag: x.tag, stop: x.stop });
  }
  return out;
}
const smsItemText = (x) => (x.quote != null ? `"${x.quote.replace(/[.,;:]+$/, '')}"${x.tag}.` : null);
/** Items joined: a quote is '"quote" [n].'; a run of plain sentences from the same source carries its marker once. */
function smsBody(items) {
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (x.quote != null) { parts.push(smsItemText(x)); continue; }
    const nx = items[i + 1];
    const same = nx && nx.quote == null && nx.tag && nx.tag === x.tag;
    parts.push(`${x.text}${same ? '' : x.tag}${x.stop}`);
  }
  return parts.join(' ');
}

/**
 * SMS: GSM-7 only (straight quotes, '-' for dashes) and at most two segments (306 characters, never above `max`).
 * The answer's facts, never its courtesy opener or closer: each verbatim quote as '"quote" [n].', whole items packed
 * until the budget is reached (the item that best matches the question first), then " Proof: <link>". An item is only
 * cut when even the best one alone does not fit. A refusal is the canonical sentence, unchanged.
 */
export function formatSms(r, proofUrl, max = 320) {
  if (r.refused) return NOT_IN_DATA;
  const suffix = proofUrl ? ` Proof: ${proofUrl}` : '';
  const items = smsItems(r.answer).map((x) => (x.quote != null ? { ...x, quote: toGsm7(x.quote) } : { ...x, text: toGsm7(x.text) }));
  const limit = Math.min(max, 306);
  const budget = Math.max(60, limit - suffix.length);
  if (!items.length) return toGsm7(clipWords(stripMarks(r.answer), budget).replace(/…$/, '...')) + suffix;
  // the item that best answers the question leads (ties keep the answer's own order); the rest follow in order
  const qt = qTokens(r.question);
  const score = (x) => { const it = qTokens(x.quote ?? x.text); let n = 0; for (const w of qt) if (it.has(w)) n++; return n; };
  let lead = 0;
  if (qt.size) {
    let best = -1;
    // a direct statement beats a caveat ("… but not by the lifetime frame warranty"); a quote that fits one segment wins ties
    const caveat = (x) => /\b(?:not|never|except|excluding|unless)\b|n't\b/i.test(x.quote ?? x.text);
    items.forEach((x, i) => { const sc = score(x) - (caveat(x) ? 0.75 : 0) + (smsBody([x]).length <= 160 ? 0.25 : 0); if (sc > best) { best = sc; lead = i; } });
  }
  const order = [items[lead], ...items.filter((_, i) => i !== lead)];
  const picked = [];
  for (const x of order) {
    if (smsBody([...picked, x]).length > budget) continue; // a later, shorter item may still fit whole
    picked.push(x);
  }
  // keep the answer's own order among the packed items (the lead stays first)
  const rest = items.filter((x) => picked.includes(x) && x !== order[0]);
  let body = picked.length ? smsBody([order[0], ...rest].filter((x) => picked.includes(x))) : '';
  if (!body) {
    const x = order[0];
    const room = Math.max(20, budget - x.tag.length - 4);
    body = x.quote != null ? `"${clipWords(x.quote, room).replace(/…$/, '...')}"${x.tag}.` : `${clipWords(x.text, room).replace(/…$/, '...')}${x.tag}.`;
  }
  return toGsm7(body) + suffix;
}

/** WhatsApp: the answer with [n] markers, then numbered source footnotes and the proof link (≤ 4096). */
export function formatWhatsApp(r, proofUrl) {
  if (r.refused) return NOT_IN_DATA;
  const body = listLines(r.answer).map(({ text, item }) => (item ? `• ${text}` : text)).join('\n');
  const notes = (r.citations || []).map((c) => noteLine(c));
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
  const mdItems = listLines(r.answer, { markdown: true });
  const quotes = r.proof?.quoted || [];
  const src = (r.citations || []).map((c) => {
    const q = quotes.filter((x) => x.n === c.n).map((x) => x.text);
    return { c, q: q.length ? q : (c.excerpt ? [c.excerpt] : []) };
  });
  const text = [
    ...listLines(r.answer).map(({ text, item }) => (item ? `- ${text}` : text)), '',
    'Sources', ...src.flatMap(({ c, q }) => [noteLine(c), ...q.slice(0, 2).map((x) => `    "${x}"`)]),
    ...(proofUrl ? ['', `See every quote in context: ${proofUrl}`] : []), '',
    `${botName} answers only from its own files, and cites every line.`,
  ].join('\n');
  const sup = (s) => esc(s).replace(/\[(\d{1,3})\]/g, '<sup style="color:#4f46e5;font-weight:600">[$1]</sup>');
  // the answer's markdown links ([“Title”](https://…)) become real links; esc() already made the URL attribute-safe
  const linked = (s) => sup(s).replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>"]+)\)/g, '<a href="$2" style="color:#4f46e5">$1</a>');
  const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:600px">`
    + mdItems.reduce((acc, x, i) => {
      // a friendly opener / closer is a paragraph; list items are one <ul> (one cited item per bullet)
      const prev = mdItems[i - 1], next = mdItems[i + 1];
      if (!x.item) return `${acc}<p style="margin:0 0 ${next?.item ? 8 : 16}px">${linked(x.text)}</p>`;
      return `${acc}${prev?.item ? '' : '<ul style="padding-left:20px;margin:0 0 16px">'}<li style="margin:0 0 6px">${linked(x.text)}</li>${next?.item ? '' : '</ul>'}`;
    }, '')
    + `<p style="margin:20px 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#666">Sources</p><ol style="padding-left:20px;margin:0">`
    + src.map(({ c, q }) => `<li value="${c.n}" style="margin:0 0 10px"><strong>${httpOf(c.url) ? `<a href="${esc(httpOf(c.url))}" style="color:#111">${esc(humanTitle(c))}</a>` : esc(humanTitle(c))}</strong>${locOf(c) ? ` <span style="color:#444">· ${esc(locOf(c))}</span>` : ''}${c.file ? ` <span style="color:#666">${esc(String(c.file).split('/').pop())}</span>` : ''}${httpOf(c.url) ? ` <a href="${esc(httpOf(c.url))}" style="color:#4f46e5;font-size:13px">${/\.pdf(?:[?#]|$)/i.test(c.url) ? 'Download' : 'Open'}</a>` : ''}${q.slice(0, 2).map((x) => `<blockquote style="margin:6px 0 0;padding:4px 10px;border-left:3px solid #c7d2fe;color:#333;background:#f5f7ff">${esc(x)}</blockquote>`).join('')}</li>`).join('')
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
/** Text fit to be read aloud: a markdown link is its title alone, a bare URL is dropped, curly quotes go. */
export function speakable(s) {
  return String(s ?? '').replace(MD_LINK, '$1').replace(/\s*\(?https?:\/\/[^\s)]+\)?/g, '').replace(/[“”]/g, '').replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
}
/**
 * How a source is named aloud, never with its URL: "page 17 of the Owner's Manual", "the Oil filter section of the
 * Owner's Manual", "the Returns Policy page" (a web page), else "the Returns Policy" / "the Shipping file".
 */
export function spokenSource(c = {}) {
  const t = humanTitle(c);
  const page = Number.isInteger(Number(c.page)) && Number(c.page) > 0 ? Number(c.page) : null;
  const section = String(c.section || '').replace(/[“”"]/g, '').trim();
  const doc = /^(?:the|a|an|our|your)\s/i.test(t) ? withArticle(t) : `the ${t}`;
  if (page) return `page ${page} of ${doc}`;
  if (section) return `the ${section} section of ${doc}`;
  const url = String(c.url || '');
  if (/^https?:\/\//i.test(url) && !/\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|txt)(?:[?#]|$)/i.test(url)) return /\bpage$/i.test(t) ? doc : `${doc} page`;
  return withArticle(t);
}
/**
 * Voice: spoken attribution ("According to the Lumen Warranty and Returns Policy, e-bike batteries …"; none with attribute:false), no markers, at most two quoted lines,
 * ≤ ~450 characters. A refusal is the canonical sentence. `names`: the bot's name / org, whose words keep their capital.
 */
export function formatSpoken(r, max = 450, { names = [], attribute = true } = {}) {
  if (r.refused) return NOT_IN_DATA;
  const quotes = (r.proof?.quoted || []).filter((q) => q.text);
  const byN = new Map((r.citations || []).map((c) => [c.n, c]));
  // the source titles count as names too ("Lumen Bikes Warranty and Returns Policy" → "Lumen frames …" keeps its capital)
  // (only real name words: an ordinary opener such as "Refunds" in a "Refunds" title still reads "And Refunds, refunds go …")
  const titles = (r.citations || []).flatMap((c) => [humanTitle(c), c.title]).map((t) => String(t || '').split(/\s+/).filter((w) => { const x = w.toLowerCase().replace(/[^a-z']/g, ''); return !LEAD_LOWER.test(x) && !DOC_NOUNS.test(x); }).join(' '));
  const proper = properWords([r.answer, ...quotes.map((q) => q.text), ...(r.citations || []).map((c) => c.excerpt)], [...names, ...titles]);
  const parts = [];
  let lastN = null;
  // without proof quotes, speak the answer's own cited lines (never its friendly opener, never a URL)
  const items = quotes.length ? quotes.map((q) => ({ n: q.n, text: q.text }))
    : answerLines(r.answer, { markdown: true }).flatMap(splitSentences).flatMap((l) => {
      // the librarian voice's quotation is what gets read; its document pointer is said by the attribution instead
      const q = [...l.matchAll(/“([^”\n]+)”\s*\[(\d{1,3})\]/g)].map((m) => ({ n: Number(m[2]), text: m[1] }));
      return q.length ? q : [{ n: Number(/\[(\d{1,3})\]/.exec(l)?.[1]) || null, text: speakable(l) }];
    }).filter((x) => x.n || !isCourtesyLine(x.text));
  for (const it of items.slice(0, 2)) {
    let s = stripMarks(speakable(it.text)).replace(/[|]/g, ', ').replace(/\s*;\s*/g, '; ');
    if (!s) continue;
    if (!/[.!?]$/.test(s)) s += '.';
    const c = byN.get(it.n);
    // attribute:false (the live voice bots): just the answer, to keep calls short; the sources go by email or text on request
    if (attribute && c && it.n !== lastN) parts.push(`${parts.length ? 'And according to' : 'According to'} ${spokenSource(c)}, ${lowerLead(s, proper)}`);
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
    // phone calls are Gemini Live voice-to-voice only (Twilio Media Streams ⇄ Gemini Live): engine 'gemini', or
    // 'not_configured' without GEMINI_API_KEY (the call webhook then says the line isn't set up yet and hangs up)
    voice: { configured: has('TWILIO_AUTH_TOKEN') && has('GEMINI_API_KEY'), provider: 'twilio', needs: ['TWILIO_AUTH_TOKEN', 'GEMINI_API_KEY'].filter((k) => !has(k)),
      engine: has('GEMINI_API_KEY') ? 'gemini' : 'not_configured',
      texts: has('TWILIO_ACCOUNT_SID') && has('TWILIO_AUTH_TOKEN') && has('TWILIO_FROM_NUMBER') },
    whatsapp: { configured: meta || has('TWILIO_AUTH_TOKEN'), provider: meta ? 'meta' : has('TWILIO_AUTH_TOKEN') ? 'twilio' : null,
      needs: meta || has('TWILIO_AUTH_TOKEN') ? [] : ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] },
    email: { configured: emailIn, sends: emailOut, needs: emailIn ? (emailOut ? [] : ['EMAIL_REPLY_WEBHOOK or SENDGRID_API_KEY/POSTMARK_SERVER_TOKEN + EMAIL_FROM']) : ['EMAIL_WEBHOOK_SECRET or MAILGUN_SIGNING_KEY'] },
    voiceBot: { configured: true, google: google.stt && google.tts, recognition: google.stt ? 'google' : 'browser', synthesis: google.tts ? 'google' : 'browser' },
    chat: { configured: true },
  };
}

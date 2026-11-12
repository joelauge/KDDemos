// "Send me this" (server/sendinfo.mjs): what the visitor actually receives, rendered to be easy to read on any device.
//
//   emailMessage(answer, ctx)              one answer        → { subject, html, text }
//   conversationEmail(items, transcript, ctx)  a whole call/chat  → { subject, html, text }
//   textMessage(answer, ctx)               one answer        → SMS body (GSM-7 where possible, ≤ 3 segments)
//   conversationText(items, ctx)           a whole call/chat → SMS body, or null when there is no link to send
//
// ctx: { botName, org, to, site, channel, proofUrl, storeUrl, replyTo }. `answer` is sendinfo.mjs normalizeAnswer()'s
// shape (+ products[] cards and the citations' original `host`), already carrying tracked links when tracking is on: the
// renderers never add, drop or rewrite a link, they only lay them out.
//
// E-mail: one table-based, inline-styled HTML body (max 600px, system fonts, 16px text, a preheader, light and dark
// colours; the <style> block only adds dark-mode and narrow-screen overrides), and a plain-text part that reads well on
// its own (wrapped at 72 columns, every link on its own line, no HTML entities). The answer is plain prose: markdown
// becomes real links / bold, [n] markers become small superscript numbers linking to the source, and the chat-only
// courtesy lines ("Good news, I found it!", "Did that answer your question?") are left out. Everything from files and
// visitors is escaped; only http(s) links and https images are used.
//
// Text: the bot's name, the answer in one or two sentences, up to three key lines, then each link on its own line
// (products first, then the sources link) and the STOP line; no markdown, no [n] markers, GSM-7 only when the content
// allows (curly quotes and dashes are straightened), at most 3 segments.
import { splitSentences, isCourtesyLine, humanTitle, locOf, clipWords, toGsm7, smsInfo, smsItems, smsLeadIndex } from './channels/util.mjs';
import { safeHttpUrl, isSoldOut } from '../lib/knowbot.js';

export const SMS_SEGMENTS = 3;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const httpUrl = (u) => safeHttpUrl(u) || '';
const httpsUrl = (u) => { const x = safeHttpUrl(u); return x && /^https:/i.test(x) ? x : ''; };
export const isPdf = (u) => /\.pdf(?:[?#]|$)/i.test(String(u || ''));

// ------------------------------------------------------------------ who it is from, and why they got it
const nameOf = (ctx) => oneLine(ctx.botName).slice(0, 70) || 'KnowBot';
const orgOf = (ctx) => { const o = oneLine(ctx.org).slice(0, 70); return o && o.toLowerCase() !== nameOf(ctx).toLowerCase() ? o : ''; };
/** "lumenbikes.test" from a URL or a bare host; '' for anything else. */
export function hostOf(s) {
  const v = String(s ?? '').trim();
  if (!v) return '';
  try { if (/^https?:\/\//i.test(v)) return new URL(v).hostname.replace(/^www\./, ''); } catch { return ''; }
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(v) && v.length <= 100 ? v.toLowerCase().replace(/^www\./, '') : '';
}
const WHERE = { phone: ' during a call', voice: ' in a voice chat', sms: ' by text', whatsapp: ' on WhatsApp', email: ' by email' };
/** " on lumenbikes.test" / " during a call" / " in a chat": where the visitor asked. */
function whereAsked(ctx) {
  if (WHERE[ctx.channel] && ctx.channel !== 'voice') return WHERE[ctx.channel];
  const h = hostOf(ctx.site);
  return h ? ` on ${h}` : WHERE[ctx.channel] || ' in a chat';
}
function footerLines(ctx) {
  const name = nameOf(ctx), org = orgOf(ctx);
  return [
    `You asked ${name} to send this${ctx.to ? ` to ${ctx.to}` : ''}${whereAsked(ctx)}. It's a one-time message: nothing else will be sent unless you ask again, so there's nothing to unsubscribe from. If this wasn't you, you can ignore it.`,
    ...(ctx.replyTo ? [`Questions? Reply to this email to reach ${org || name}.`] : []),
    `${name} answers only from documents ${org || 'the business'} provided, and cites every line.`,
  ];
}

// ------------------------------------------------------------------ the answer as blocks of inline pieces
// Inline pieces: {t:'text', s} | {t:'b', s} | {t:'link', s, url} | {t:'cite', ns:[1,2]}.
const TOKEN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>"]+)\)|((?:\s*\[\d{1,3}\])+)|\*\*([^*\n]+)\*\*|`([^`\n]+)`|(https?:\/\/[^\s<>"“”‘’)\]]+)/g;
const MD_LINK_G = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>"]+)\)/g;
const unquote = (s) => String(s).replace(/^\s*[“"]\s*(.*?)\s*[”"]\s*$/, '$1');
const cleanText = (s) => String(s).replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2').replace(/__([^_\n]+)__/g, '$1').replace(/\s*\[\d{1,3}\]/g, '');
function pieces(s, known) {
  const out = [];
  let at = 0;
  const text = (x) => { const v = cleanText(x); if (v) out.push({ t: 'text', s: v }); };
  for (const m of String(s).matchAll(TOKEN)) {
    if (m.index > at) text(String(s).slice(at, m.index));
    if (m[1] != null) out.push({ t: 'link', s: unquote(m[1]), url: m[2] });
    else if (m[3] != null) { const ns = [...new Set([...m[3].matchAll(/\d+/g)].map(Number))].filter((n) => known.has(n)); if (ns.length) out.push({ t: 'cite', ns }); }
    else if (m[4] != null) out.push({ t: 'b', s: m[4] });
    else if (m[5] != null) text(m[5]);
    else {
      const trail = /[.,;:!?]+$/.exec(m[6])?.[0] || '';
      const u = m[6].slice(0, m[6].length - trail.length);
      out.push({ t: 'link', s: u.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, ''), url: u });
      if (trail) text(trail);
    }
    at = m.index + m[0].length;
  }
  if (at < String(s).length) text(String(s).slice(at));
  // whitespace before a citation goes (“…”¹), runs of spaces collapse
  for (let i = 0; i < out.length; i++) if (out[i].t === 'text') out[i].s = out[i].s.replace(/\s+/g, ' ').replace(/\s+$/, out[i + 1]?.t === 'cite' ? '' : ' ');
  if (out[0]?.t === 'text') out[0].s = out[0].s.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last?.t === 'text') last.s = last.s.replace(/\s+$/, '');
  return out.filter((p) => p.t !== 'text' || p.s);
}
/** A sentence the chat says to be friendly ("Good news, I found it!", "Did that answer your question?"): not for a message. */
const chatOnly = (sn) => isCourtesyLine(String(sn).replace(MD_LINK_G, '$1'));
/**
 * The answer's markdown → [{type:'p', segs} | {type:'list', ordered, items:[{segs, sub:[segs]}]}]: list bullets kept as
 * lists, a table row read as "a, b, c", headings and quote marks dropped, courtesy sentences left out.
 */
export function answerBlocks(answer, citations = []) {
  const known = new Set((citations || []).map((c) => Number(c.n)));
  const build = (filter) => {
    const blocks = [];
    let list = null;
    for (const raw of String(answer || '').replace(/\r/g, '').split('\n')) {
      if (!raw.trim()) { list = null; continue; }
      if (/\|/.test(raw) && /^\s*\|?\s*:?-{3,}/.test(raw)) continue; // a table's |---|---| rule
      const m = /^(\s*)([-*•]|\d{1,3}[.)])\s+(.*)$/.exec(raw);
      let text = (m ? m[3] : raw).trim().replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '');
      if (/^\|.*\|$/.test(text)) text = text.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean).join(', ');
      const kept = filter ? splitSentences(text).filter((sn) => !chatOnly(sn)).join(' ') : text;
      if (!kept.trim()) continue;
      const segs = pieces(kept, known);
      if (!segs.length) continue;
      if (m) {
        const ordered = /\d/.test(m[2]);
        if (m[1].length >= 2 && list?.items.length) { list.items[list.items.length - 1].sub.push(segs); continue; }
        if (!list || list.ordered !== ordered) { list = { type: 'list', ordered, items: [] }; blocks.push(list); }
        list.items.push({ segs, sub: [] });
      } else { list = null; blocks.push({ type: 'p', segs }); }
    }
    return blocks;
  };
  const blocks = build(true);
  return blocks.length ? blocks : build(false);
}
const segsPlain = (segs, { cites = true } = {}) => segs.map((p) => (p.t === 'cite' ? (cites ? ` [${p.ns.join(', ')}]` : '') : p.s)).join('').replace(/\s+/g, ' ').trim();
const blocksPlain = (blocks) => blocks.flatMap((b) => (b.type === 'p' ? [b.segs] : b.items.flatMap((i) => [i.segs, ...i.sub])));
/** The answer as one plain line (no markers): the preheader and the "no markdown left" check. */
export const answerPlain = (blocks) => blocksPlain(blocks).map((s) => segsPlain(s, { cites: false })).join(' ');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ------------------------------------------------------------------ products, prices, sources
export function formatPrice(v, cur) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '';
  const d = Math.abs(n - Math.round(n)) < 0.005 ? 0 : 2;
  try { if (cur) return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(n); } catch { /* unknown code */ }
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: 2 });
}
/** "https://schema.org/InStock" / "in_stock" / "Only 3 left" → "In stock" / "In stock" / "Only 3 left". */
function availabilityText(a) {
  if (a == null || a === '') return '';
  const s = String(a).replace(/^.*[/#]/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/\b(\d)/g, '$1') : '';
}
/** The answer's product cards, cleaned: http(s) link and title required, https photo or none, at most 4. */
export function productsOf(a) {
  return (Array.isArray(a?.products) ? a.products : []).map((p) => {
    const url = httpUrl(p?.url), title = oneLine(p?.title).slice(0, 120);
    if (!url || !title) return null;
    const price = formatPrice(p.price, p.currency);
    const was = price && p.compareAt != null && Number(p.compareAt) > Number(p.price) ? formatPrice(p.compareAt, p.currency) : '';
    const out = isSoldOut(p.availability);
    return { url, title, price, was, image: httpsUrl(p.image), out, avail: out ? 'Out of stock' : availabilityText(p.availability) };
  }).filter(Boolean).slice(0, 4);
}
/** The citations as display rows: readable title, where in it, the site it is on, its (tracked) link. */
function sourcesOf(a) {
  return (a.citations || []).map((c) => {
    const url = httpUrl(c.url);
    // host / pdf: read from the original link by normalizeAnswer (a tracked link is a short link on our own domain)
    const host = c.host !== undefined ? hostOf(c.host) : hostOf(url);
    const kind = (c.pdf !== undefined ? c.pdf : isPdf(url) || /\.pdf$/i.test(String(c.file || ''))) ? 'PDF' : '';
    return { n: Number(c.n), title: humanTitle(c), loc: locOf(c), url, meta: [kind, host].filter(Boolean).join(' · ') };
  }).sort((x, y) => x.n - y.n);
}
/** The quoted lines the answer text does not already say word for word (those would only repeat it). */
function quotesOf(a, blocks) {
  const said = norm(answerPlain(blocks));
  const seen = new Set();
  const out = [];
  for (const q of a.proof?.quoted || []) {
    // a table row's cells ("a | b | c") read as "a · b · c"
    const t = oneLine(q.text).replace(/^[“"]|[”"]$/g, '').replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · ');
    const k = norm(t);
    if (!k || seen.has(k) || said.includes(k)) continue;
    seen.add(k);
    out.push({ n: Number(q.n), text: t });
    if (out.length >= 4) break;
  }
  return out;
}

// ------------------------------------------------------------------ plain text (wrapped at 72 columns)
const WIDTH = 72;
/** Word-wraps `s`; a word longer than the line (a link) sits alone on its line, never broken. */
export function wrap(s, first = '', rest = first, width = WIDTH) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = first;
  let fresh = true;
  for (const w of words) {
    if (!fresh && (line + ' ' + w).length > width) { lines.push(line); line = rest + w; fresh = false; continue; }
    line = fresh ? line + w : `${line} ${w}`;
    fresh = false;
  }
  if (!fresh) lines.push(line);
  return lines.join('\n');
}
function textBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'p') { out.push(wrap(segsPlain(b.segs)), ''); continue; }
    b.items.forEach((i, k) => {
      const mark = b.ordered ? `${k + 1}. ` : '- ';
      out.push(wrap(segsPlain(i.segs), mark, ' '.repeat(mark.length)));
      for (const s of i.sub) out.push(wrap(segsPlain(s), '    - ', '      '));
    });
    out.push('');
  }
  return out;
}
/** Links in the answer text that are not a source or a product (listed after the answer, each on its own line). */
function extraLinks(blocks, a, products) {
  const known = new Set([...(a.citations || []).map((c) => c.url), ...products.map((p) => p.url)].filter(Boolean));
  const out = [];
  for (const segs of blocksPlain(blocks)) for (const p of segs) if (p.t === 'link' && httpUrl(p.url) && !known.has(p.url) && !out.some((x) => x.url === p.url)) out.push({ s: p.s, url: httpUrl(p.url) });
  return out;
}
function answerText(a, { proofUrl = null, storeUrl = null, label = 'See exactly where this came from:' } = {}) {
  const blocks = answerBlocks(a.answer, a.citations);
  const products = productsOf(a), sources = sourcesOf(a), quotes = quotesOf(a, blocks);
  const out = [...textBlocks(blocks)];
  const links = extraLinks(blocks, a, products);
  if (links.length) out.push('Links', ...links.flatMap((l) => [wrap(l.s), l.url]), '');
  if (products.length) {
    out.push(products.length > 1 ? 'Products' : 'Product');
    for (const p of products) out.push(wrap(p.title), ...[[p.price && (p.was ? `${p.price} (was ${p.was})` : p.price), p.avail].filter(Boolean).join(' · ')].filter(Boolean), 'View product:', p.url, '');
    const store = httpUrl(storeUrl);
    if (store) out.push('Shop the store:', store, '');
  }
  if (quotes.length) {
    out.push('From the documents');
    const titled = new Map(sources.map((s) => [s.n, s]));
    for (const q of quotes) { const s = titled.get(q.n); out.push(wrap(`“${q.text}”`, '  ', '  '), ...(s ? [wrap(`${s.title}${s.loc ? `, ${s.loc}` : ''} [${q.n}]`, '  - ', '    ')] : []), ''); }
  }
  if (sources.length) {
    out.push('Sources');
    for (const s of sources) out.push(wrap(`${s.title}${s.loc ? `, ${s.loc}` : ''}${s.meta ? ` (${s.meta})` : ''}`, `[${s.n}] `, '    '), ...(s.url ? [`    ${s.url}`] : []));
    out.push('');
  }
  const proof = httpUrl(proofUrl);
  if (proof) out.push(label, proof, '');
  return out;
}

// ------------------------------------------------------------------ HTML
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { bg: '#f3f4f6', card: '#ffffff', line: '#e5e7eb', text: '#1f2328', muted: '#5f6670', link: '#4338ca', btn: '#4f46e5', qbg: '#f5f7ff', qline: '#c7d2fe', ok: '#047857', bad: '#b91c1c' };
const HEAD_STYLE = `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){.kb-bg{background:#101216!important}.kb-card{background:#1a1d23!important;border-color:#2c313a!important}.kb-tx{color:#e6e8eb!important}.kb-mu{color:#a3a9b3!important}.kb-ln{color:#a5b4fc!important}.kb-q{background:#21252d!important;border-color:#6366f1!important}.kb-bt{background:#6366f1!important}.kb-hr{border-color:#2c313a!important}.kb-ok{color:#34d399!important}.kb-bad{color:#f87171!important}}
[data-ogsc] .kb-tx{color:#e6e8eb!important}[data-ogsc] .kb-mu{color:#a3a9b3!important}[data-ogsc] .kb-ln{color:#a5b4fc!important}[data-ogsb] .kb-card{background:#1a1d23!important}[data-ogsb] .kb-q{background:#21252d!important}
@media (max-width:620px){.kb-pad{padding-left:20px!important;padding-right:20px!important}}`;
const A = (url, label, style = `color:${C.link};text-decoration:underline`, cls = 'kb-ln') => `<a href="${esc(url)}" target="_blank" rel="noopener" class="${cls}" style="${style}">${label}</a>`;
function segsHtml(segs, citeUrl) {
  return segs.map((p) => {
    if (p.t === 'text') return esc(p.s);
    if (p.t === 'b') return `<strong>${esc(p.s)}</strong>`;
    if (p.t === 'link') { const u = httpUrl(p.url); return u ? A(u, esc(p.s)) : esc(p.s); }
    const nums = p.ns.map((n) => { const u = citeUrl(n); return u ? A(u, String(n), `color:${C.link};text-decoration:none`) : String(n); }).join(',');
    return `<sup class="kb-ln" style="font-size:11px;line-height:0;color:${C.link};font-weight:600;padding-left:1px">${nums}</sup>`;
  }).join('');
}
function blocksHtml(blocks, citeUrl) {
  const P = `margin:0 0 14px;font-size:16px;line-height:1.6;color:${C.text}`;
  return blocks.map((b) => {
    if (b.type === 'p') return `<p class="kb-tx" style="${P}">${segsHtml(b.segs, citeUrl)}</p>`;
    const tag = b.ordered ? 'ol' : 'ul';
    return `<${tag} class="kb-tx" style="margin:0 0 14px;padding:0 0 0 22px;font-size:16px;line-height:1.6;color:${C.text}">${b.items.map((i) => `<li style="margin:0 0 8px">${segsHtml(i.segs, citeUrl)}${i.sub.length ? `<ul style="margin:6px 0 0;padding:0 0 0 20px">${i.sub.map((s) => `<li style="margin:0 0 6px">${segsHtml(s, citeUrl)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</${tag}>`;
  }).join('');
}
const label = (t) => `<p class="kb-mu" style="margin:24px 0 10px;font-size:12px;line-height:1.4;letter-spacing:.06em;text-transform:uppercase;font-weight:600;color:${C.muted}">${esc(t)}</p>`;
const button = (url, text) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0"><tr><td class="kb-bt" bgcolor="${C.btn}" style="border-radius:8px;background:${C.btn}"><a href="${esc(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:9px 16px;font-family:${FONT};font-size:14px;line-height:1.2;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(text)}</a></td></tr></table>`;
function productsHtml(products, storeUrl) {
  if (!products.length) return '';
  const cards = products.map((p) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kb-card" style="margin:0 0 12px;border:1px solid ${C.line};border-radius:12px;background:${C.card}"><tr>`
    + (p.image ? `<td width="112" valign="top" style="padding:12px 0 12px 12px;width:112px"><a href="${esc(p.url)}" target="_blank" rel="noopener"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:8px;padding:4px"><img src="${esc(p.image)}" width="92" alt="${esc(p.title)}" style="display:block;width:92px;max-width:92px;height:auto;border:0;border-radius:6px"></td></tr></table></a></td>` : '')
    + `<td valign="top" style="padding:12px 14px">`
    + `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="kb-tx" style="font-size:16px;line-height:1.35;font-weight:600;color:${C.text};text-decoration:none">${esc(p.title)}</a>`
    + (p.price ? `<p class="kb-tx" style="margin:4px 0 0;font-size:15px;line-height:1.4;color:${C.text}"><strong>${esc(p.price)}</strong>${p.was ? ` <s class="kb-mu" style="color:${C.muted};font-size:14px">${esc(p.was)}</s>` : ''}</p>` : '')
    + (p.avail ? `<p class="${p.out ? 'kb-bad' : 'kb-ok'}" style="margin:2px 0 0;font-size:13px;line-height:1.4;color:${p.out ? C.bad : C.ok}">${esc(p.avail)}</p>` : '')
    + button(p.url, 'View product') + '</td></tr></table>').join('');
  const store = httpUrl(storeUrl);
  return label(products.length > 1 ? 'Products' : 'Product') + cards + (store ? `<p class="kb-tx" style="margin:4px 0 0;font-size:15px;line-height:1.5;color:${C.text}">${A(store, 'Shop the store')} <span class="kb-ln" style="color:${C.link}">&rarr;</span></p>` : '');
}
function quotesHtml(quotes, sources, citeUrl) {
  if (!quotes.length) return '';
  const byN = new Map(sources.map((s) => [s.n, s]));
  return label('From the documents') + quotes.map((q) => {
    const s = byN.get(q.n);
    const u = citeUrl(q.n);
    const who = s ? `${esc(s.title)}${s.loc ? `, ${esc(s.loc)}` : ''}` : '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px"><tr><td class="kb-q" style="padding:10px 14px;background:${C.qbg};border-left:3px solid ${C.qline};border-radius:0 8px 8px 0">`
      + `<p class="kb-tx" style="margin:0;font-size:15px;line-height:1.55;color:${C.text}">“${esc(q.text)}”</p>`
      + (who ? `<p class="kb-mu" style="margin:4px 0 0;font-size:13px;line-height:1.4;color:${C.muted}">${u ? A(u, who, `color:${C.muted};text-decoration:none`, 'kb-mu') : who} <sup style="font-size:10px;line-height:0">${q.n}</sup></p>` : '')
      + '</td></tr></table>';
  }).join('');
}
function sourcesHtml(sources) {
  if (!sources.length) return '';
  return label('Sources') + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${sources.map((s) => `<tr>`
    + `<td width="26" valign="top" class="kb-mu" style="width:26px;padding:4px 0;font-size:14px;line-height:1.5;color:${C.muted};font-weight:600">${s.n}</td>`
    + `<td valign="top" style="padding:4px 0">`
    + `<p class="kb-tx" style="margin:0;font-size:15px;line-height:1.5;color:${C.text}">${s.url ? A(s.url, esc(s.title), `color:${C.link};text-decoration:underline;font-weight:600`) : `<strong>${esc(s.title)}</strong>`}</p>`
    + (s.loc || s.meta ? `<p class="kb-mu" style="margin:0;font-size:13px;line-height:1.5;color:${C.muted}">${esc([s.loc, s.meta].filter(Boolean).join(' · '))}</p>` : '')
    + '</td></tr>').join('')}</table>`;
}
const proofHtml = (proofUrl, text = 'See exactly where this came from') => (httpUrl(proofUrl)
  ? `<p class="kb-tx" style="margin:20px 0 0;font-size:15px;line-height:1.5;color:${C.text}">${A(httpUrl(proofUrl), esc(text), `color:${C.link};text-decoration:underline;font-weight:600`)} <span class="kb-ln" style="color:${C.link}">&rarr;</span></p>` : '');
/** One answer's body (prose, products, quotes, sources, proof link) as HTML. */
function answerHtml(a, { proofUrl = null, storeUrl = null } = {}) {
  const blocks = answerBlocks(a.answer, a.citations);
  const sources = sourcesOf(a), quotes = quotesOf(a, blocks), products = productsOf(a);
  const byN = new Map(sources.map((s) => [s.n, s.url]));
  const citeUrl = (n) => byN.get(n) || httpUrl(proofUrl) || '';
  return blocksHtml(blocks, citeUrl) + productsHtml(products, storeUrl) + quotesHtml(quotes, sources, citeUrl) + sourcesHtml(sources) + proofHtml(proofUrl);
}
const preheaderHtml = (s) => `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${esc(clipWords(oneLine(s), 120))}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`;
/** The page around a body: background, 600px column, the bot's name above the card, the footer below it. */
function shell({ subject, preheader, body, ctx }) {
  const name = nameOf(ctx), org = orgOf(ctx);
  const foot = footerLines(ctx).map((l) => `<p class="kb-mu" style="margin:0 0 8px;font-size:12px;line-height:1.55;color:${C.muted}">${esc(l)}</p>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">`
    + `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title><style>${HEAD_STYLE}</style></head>`
    + `<body class="kb-bg" style="margin:0;padding:0;width:100%;background:${C.bg};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">${preheaderHtml(preheader)}`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kb-bg" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">`
    + `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT}">`
    + `<tr><td class="kb-pad" style="padding:0 28px 12px;font-family:${FONT}"><p class="kb-tx" style="margin:0;font-size:15px;line-height:1.4;font-weight:700;color:${C.text}">${esc(name)}${org ? `<span class="kb-mu" style="font-weight:400;color:${C.muted}"> &middot; ${esc(org)}</span>` : ''}</p></td></tr>`
    + `<tr><td class="kb-card kb-pad" bgcolor="${C.card}" style="padding:28px;background:${C.card};border:1px solid ${C.line};border-radius:14px;font-family:${FONT}">${body}</td></tr>`
    + `<tr><td class="kb-pad" style="padding:18px 28px 0;font-family:${FONT}">${foot}</td></tr>`
    + `</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
}
const askedHtml = (q) => (q ? `<p class="kb-mu" style="margin:0 0 4px;font-size:12px;line-height:1.4;letter-spacing:.06em;text-transform:uppercase;font-weight:600;color:${C.muted}">You asked</p><p class="kb-mu" style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${C.muted}">${esc(q)}</p>` : '');
const hr = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0"><tr><td class="kb-hr" style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</td></tr></table>`;
const subjectLine = (s) => clipWords(oneLine(s), 120);
const textFooter = (ctx) => ['--', `${nameOf(ctx)}${orgOf(ctx) ? ` · ${orgOf(ctx)}` : ''}`, ...footerLines(ctx).flatMap((l) => [wrap(l)])].join('\n');

// ------------------------------------------------------------------ e-mail: one answer
/** The e-mail for one answer: { subject, html, text }. */
export function emailMessage(answer, ctx = {}) {
  const a = { ...answer, refused: false };
  const name = nameOf(ctx);
  const q = oneLine(a.question);
  const about = q || (a.citations?.[0] ? humanTitle(a.citations[0]) : '');
  const subject = subjectLine(about ? `Your answer from ${name}: ${clipWords(about, 80)}` : `Your answer from ${name}`);
  const blocks = answerBlocks(a.answer, a.citations);
  const greeting = `Hi, here's the answer you asked ${name} for.`;
  const html = shell({ subject, preheader: answerPlain(blocks), ctx: { ...ctx, botName: name },
    body: `<p class="kb-tx" style="margin:0 0 18px;font-size:16px;line-height:1.5;color:${C.text}">${esc(greeting)}</p>${askedHtml(q)}${answerHtml(a, ctx)}` });
  const text = [wrap(greeting), '', ...(q ? [wrap(`You asked: “${q}”`), ''] : []), ...answerText(a, ctx), textFooter(ctx), ''].join('\n');
  return { subject, html, text };
}

// ------------------------------------------------------------------ e-mail: a whole conversation
/**
 * The end-of-call / end-of-chat e-mail: each answer from the files (prose, products, quotes, sources, proof link), then
 * the transcript. items: [{answer, proofUrl}], transcript: [{role: 'caller'|'user'|'agent', text}].
 */
export function conversationEmail(items, transcript = [], ctx = {}) {
  const name = nameOf(ctx);
  const lines = (transcript || []).filter((t) => t && String(t.text || '').trim()).slice(-200)
    .map((t) => ({ who: t.role === 'agent' ? name : 'You', text: oneLine(t.text).slice(0, 2000) }));
  const kind = ctx.channel === 'phone' ? 'call' : 'conversation';
  const qs = items.map((x) => oneLine(x.answer.question)).filter(Boolean);
  const subject = subjectLine(qs.length ? `Your ${kind} with ${name}: ${clipWords(qs[0], 60)}${qs.length > 1 ? ` + ${qs.length - 1} more` : ''}` : `Your ${kind} with ${name}: the answers and their sources`);
  const greeting = `Thanks for talking with ${name}. Here ${items.length === 1 ? 'is the answer' : `are the ${items.length} answers`} from our ${kind}, each with its sources.`;
  const sections = items.map(({ answer, proofUrl }, i) => {
    const a = { ...answer, refused: false };
    const q = oneLine(a.question) || 'Answer';
    return `${i ? hr : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px"><tr>`
      + `<td width="30" valign="top" style="width:30px"><p class="kb-bt" style="margin:0;width:22px;height:22px;border-radius:11px;background:${C.btn};color:#ffffff;font-size:13px;line-height:22px;font-weight:700;text-align:center">${i + 1}</p></td>`
      + `<td valign="top"><p class="kb-tx" style="margin:0;font-size:17px;line-height:1.4;font-weight:700;color:${C.text}">${esc(q)}</p></td></tr></table>`
      + answerHtml(a, { proofUrl, storeUrl: ctx.storeUrl });
  }).join('');
  const transcriptHtml = lines.length ? hr + label('Transcript') + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${lines.map((l) => `<tr><td valign="top" class="${l.who === 'You' ? 'kb-mu' : 'kb-ln'}" style="width:1%;white-space:nowrap;padding:3px 10px 3px 0;font-size:14px;line-height:1.5;font-weight:600;color:${l.who === 'You' ? C.muted : C.link}">${esc(l.who)}</td><td valign="top" class="kb-tx" style="padding:3px 0;font-size:14px;line-height:1.5;color:${C.text}">${esc(l.text)}</td></tr>`).join('')}</table>` : '';
  const html = shell({ subject, preheader: qs.join(' · ') || greeting, ctx: { ...ctx, botName: name },
    body: `<p class="kb-tx" style="margin:0 0 22px;font-size:16px;line-height:1.5;color:${C.text}">${esc(greeting)}</p>${sections}${transcriptHtml}` });
  const text = [
    wrap(greeting), '',
    ...items.flatMap(({ answer, proofUrl }, i) => {
      const head = `${i + 1}. ${oneLine(answer.question) || 'Answer'}`;
      return [wrap(head, '', '   '), '='.repeat(Math.min(WIDTH, head.length)), '', ...answerText({ ...answer, refused: false }, { proofUrl, storeUrl: ctx.storeUrl, label: 'See where this came from:' })];
    }),
    ...(lines.length ? ['Transcript', '==========', ...lines.map((l) => wrap(`${l.who}: ${l.text}`, '', '  ')), ''] : []),
    textFooter(ctx), '',
  ].join('\n');
  return { subject, text, html };
}

// ------------------------------------------------------------------ text messages
const gsm = (s) => toGsm7(String(s ?? '')).replace(/[ \t]+/g, ' ').trim();
const fits = (s) => smsInfo(s).segments <= SMS_SEGMENTS;
const sentence = (x) => { const s = x.quote != null ? x.quote.replace(/[.,;:]+$/, '') : x.text; return /[.!?]$/.test(s) ? s : `${s}${x.quote != null ? '.' : x.stop || '.'}`; };
/** Cuts `s` (GSM-7 "...") until `make(s)` fits the budget; '' when nothing does. */
function clipToFit(s, make) {
  if (fits(make(s))) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(make(clipWords(s, mid).replace(/…$/, '...')))) lo = mid; else hi = mid - 1; }
  return lo >= 20 ? clipWords(s, lo).replace(/…$/, '...') : '';
}
const STOP_LINE = 'Sent at your request. Reply STOP to opt out.';
/**
 * The text for one answer: "<Bot>:" then the answer in 1–2 sentences, up to 3 key lines ("- …"), each product link and
 * the sources link on its own line, and the STOP line. GSM-7 where the content allows, never above 3 segments: key
 * lines go first, then the second product, then the lead is shortened.
 */
export function textMessage(answer, ctx = {}) {
  const a = { ...answer, refused: false };
  const name = gsm(clipWords(nameOf(ctx), 40).replace(/…$/, ''));
  const items = smsItems(a.answer);
  let lead = '', keys = [];
  if (items.length) {
    const li = smsLeadIndex(items, a.question);
    const order = [items[li], ...items.filter((_, i) => i !== li)].map((x) => gsm(sentence(x)));
    lead = order[0];
    let rest = order.slice(1);
    if (rest.length && lead.length + rest[0].length < 150) { lead = `${lead} ${rest[0]}`; rest = rest.slice(1); }
    keys = rest.slice(0, 3).map((s) => clipWords(s, 120).replace(/…$/, '...'));
  } else lead = gsm(answerPlain(answerBlocks(a.answer, a.citations)));
  const products = productsOf(a).slice(0, 2).map((p) => ({ head: gsm(`${clipWords(p.title, 40).replace(/…$/, '...')}${p.price ? `, ${p.price}${p.was ? ` (was ${p.was})` : ''}` : ''}${p.out ? ', out of stock' : ''}:`), url: p.url }));
  const proof = httpUrl(ctx.proofUrl) || httpUrl(a.citations?.find((c) => httpUrl(c.url))?.url);
  const make = (ld, ks, ps) => [`${name}:`, ld, ...ks.map((k) => `- ${k}`), ...ps.flatMap((p) => [p.head, p.url]), ...(proof ? ['See the sources:', proof] : []), STOP_LINE].filter(Boolean).join('\n');
  let ks = keys, ps = products;
  while (!fits(make(lead, ks, ps)) && ks.length) ks = ks.slice(0, -1);
  while (!fits(make(lead, ks, ps)) && ps.length > 1) ps = ps.slice(0, -1);
  if (!fits(make(lead, ks, ps))) lead = clipToFit(lead, (x) => make(x, ks, ps));
  if (!fits(make(lead, ks, ps))) ps = [];
  return make(lead, ks, ps);
}
/** The end-of-call text: "<Bot>: the sources from our call", then each question with its link on its own line (as many as fit). */
export function conversationText(items, ctx = {}) {
  const name = gsm(clipWords(nameOf(ctx), 40).replace(/…$/, ''));
  const head = `${name}: the answers from our ${ctx.channel === 'phone' ? 'call' : 'chat'}, with their sources.`;
  const shown = [];
  let n = 0;
  for (const { answer, proofUrl } of items) {
    const u = httpUrl(proofUrl);
    if (!u) continue;
    const next = [`${n + 1}) ${gsm(clipWords(oneLine(answer.question) || 'Answer', 60).replace(/…$/, '...'))}`, u];
    if (!fits([head, ...shown, ...next, STOP_LINE].join('\n'))) break;
    shown.push(...next);
    n++;
  }
  if (!shown.length) return null;
  return [head, ...shown, STOP_LINE].join('\n');
}

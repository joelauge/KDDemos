// KnowBot leads report: the contacts visitors give a bot, the links it sends them, and what they clicked (MVP).
//
// What is recorded, per bot (a Studio bot's id, tr_…; a launched bot linked to its Studio bot is recorded under that
// Studio bot so the owner sees one report):
//
//   lead      {kind:'lead', at, bot, channel, type:'email'|'phone', value, question, cid, session, consent, via?}
//             - every address a "send me this" request went to (server/sendinfo.mjs: e-mail and text sends, the voice bots'
//               end-of-call conversation send); consent 'asked_to_send'
//             - the caller ID of a phone call, the number that texted or messaged on WhatsApp, the address that e-mailed the
//               bot (server/devapi.mjs channels); consent 'inbound_call' | 'inbound_message' | 'inbound_email', at most one
//               per value and channel per day
//   checkout  {kind:'checkout', at, bot, channel, phone, items:[{title, variant, quantity}], linkKind, cid, session}
//             a product / checkout link texted from a call (server/channels/shop.mjs)
//   link      {kind:'link', at, bot, id, target, channel, medium, linkKind, cid}  one short link we generated (/r/<id>)
//   click     {kind:'click', at, bot, id, cid}                                     one visit to a short link
//
// Tracked links (on by default; the owner turns it off per bot): every http(s) link a bot sends a person in a text,
// e-mail or WhatsApp reply (the proof page, the answer's source links, checkout links) gets
//   utm_source=knowbot, utm_medium=<channel the conversation is on: sms|email|phone|whatsapp|webchat|voice|homepage>,
//   utm_campaign=<bot id>, utm_content=<kind>_<delivery> (proof_email, source_sms, checkout_sms, …), kb_cid=<click id>
// appended (never overriding utm_* the link already has, never touching its existing query or #hash, never twice), and is
// sent as a short link <public origin>[/api]/r/<id> that 302s to it. Only ids this module generated redirect: an unknown
// id is a 404, so /r/ is never an open redirect.
//
// Storage: <dataDir>/leads/<bot>.jsonl (one event per line, append-only) and <dataDir>/leads/links/<id>.json, plus memory.
// Events older than the retention window (KNOWBOT_LEADS_RETENTION_DAYS, default 90) are dropped when a bot's file is
// loaded, and short links stop redirecting once they are older than it. Addresses are kept as given (the owner's own
// export is not masked) but never written to the server log: logs carry an 8-hex hash, as sendinfo.mjs does.
// Nothing here is served publicly: the report and the CSV are /api/studio/trials/:id/leads[.csv] (the trial token).
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

export const UTM_SOURCE = 'knowbot';
export const MEDIUMS = Object.freeze(['sms', 'email', 'phone', 'whatsapp', 'webchat', 'voice', 'homepage']);
const MEDIUM_OF = { studio: 'webchat', web: 'webchat', api: 'webchat', webchat: 'webchat', chat: 'webchat', site: 'homepage', homepage: 'homepage',
  voice: 'voice', webvoice: 'voice', phone: 'phone', call: 'phone', sms: 'sms', text: 'sms', whatsapp: 'whatsapp', email: 'email' };
/** The conversation channel → its utm_medium (sms | email | phone | whatsapp | webchat | voice | homepage). */
export const mediumOf = (channel) => MEDIUM_OF[String(channel || '').toLowerCase()] || 'webchat';
/** utm_campaign: the bot's id (already URL-safe; anything else is slugged). */
export const campaignOf = (botId) => String(botId || 'bot').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'bot';
export const LINK_ID_RE = /^[A-Za-z0-9]{8,16}$/;
export const CLICK_ID_RE = /^[a-z0-9]{6,20}$/;
const DAY = 86400000;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';
const randFrom = (alpha, n) => { const b = randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += alpha[b[i] % alpha.length]; return s; };
/** A click id: ties every link of one message (and its clicks) to the lead or checkout it belongs to. */
export const newClickId = () => randFrom(B32, 10);
const hash8 = (s) => createHash('sha256').update(String(s ?? '').trim().toLowerCase()).digest('hex').slice(0, 8);
const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** True for an absolute http(s) URL. */
export function isHttpUrl(u) {
  try { const x = new URL(String(u || '').trim()); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

/**
 * The link with the tracking parameters appended. Only http(s) links change. The existing query string and #hash are
 * kept byte for byte (a cart permalink's `attributes%5Bcall%5D=…` is never re-encoded); utm_* are added only when the link
 * has none of its own (an owner's own campaign tags win), kb_cid only when it has none, so appending twice is a no-op.
 */
export function appendTracking(url, { source = UTM_SOURCE, medium = 'webchat', campaign = 'bot', content = '', cid = '' } = {}) {
  const s = String(url ?? '').trim();
  let u;
  try { u = new URL(s); } catch { return s; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s;
  const hashAt = s.indexOf('#');
  const head = hashAt >= 0 ? s.slice(0, hashAt) : s, hash = hashAt >= 0 ? s.slice(hashAt) : '';
  const has = (k) => u.searchParams.has(k);
  const add = [];
  if (!['utm_source', 'utm_medium', 'utm_campaign'].some(has)) {
    add.push(['utm_source', source], ['utm_medium', medium], ['utm_campaign', campaign]);
    if (content && !has('utm_content')) add.push(['utm_content', content]);
  }
  if (cid && !has('kb_cid')) add.push(['kb_cid', cid]);
  const q = add.filter(([, v]) => v != null && String(v) !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  if (!q) return s;
  const sep = !head.includes('?') ? '?' : /[?&]$/.test(head) ? '' : '&';
  return `${head}${sep}${q}${hash}`;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\])]+[^\s<>"'\]).,;:!?”’]/g;
/**
 * An answer (sendinfo.mjs normalizeAnswer / devapi answer shape) with every outbound link replaced by track(url, kind):
 * the proof link ('proof'), the citations' urls and the links inside the answer text ('source'). Returns a copy.
 */
export function trackAnswer(a, track) {
  if (!a || typeof track !== 'function') return a;
  const memo = new Map();
  const t = (u, kind) => { const k = `${kind}|${u}`; if (!memo.has(k)) memo.set(k, track(u, kind) || u); return memo.get(k); };
  const inText = (s) => (typeof s === 'string' ? s.replace(URL_IN_TEXT, (u) => (isHttpUrl(u) ? t(u, 'source') : u)) : s);
  return {
    ...a,
    ...(typeof a.answer === 'string' ? { answer: inText(a.answer) } : {}),
    ...(typeof a.text === 'string' && a.answer === undefined ? { text: inText(a.text) } : {}),
    ...(Array.isArray(a.citations) ? { citations: a.citations.map((c) => (c && isHttpUrl(c.url) ? { ...c, url: t(c.url, 'source') } : c)) } : {}),
    ...(a.proofUrl && isHttpUrl(a.proofUrl) ? { proofUrl: t(a.proofUrl, 'proof') } : {}),
  };
}

// ------------------------------------------------------------------ contacts
const EMAIL_OK = /^[A-Z0-9._%+'-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63})*\.[A-Z]{2,24}$/i;
/** A channel's caller id → {type, value} (E.164 phone or lower-cased e-mail), or null (a session id, an IP, …). */
export function contactOf(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  if (angle) s = angle[1];
  if (s.includes('@')) return EMAIL_OK.test(s) && s.length <= 254 ? { type: 'email', value: s.toLowerCase() } : null;
  s = s.replace(/^(?:whatsapp|tel|sms):/i, '');
  const digits = s.replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return { type: 'phone', value: digits };
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return { type: 'phone', value: `+1${d}` };
  if (d.length >= 11 && d.length <= 15 && /^\d+$/.test(s.replace(/[\s().-]/g, ''))) return { type: 'phone', value: `+${d}` }; // WhatsApp wa_id: digits with the country code
  return null;
}

// ------------------------------------------------------------------ CSV
export const CSV_COLUMNS = Object.freeze(['timestamp', 'bot', 'channel', 'type', 'email', 'phone', 'question', 'utm_source', 'utm_medium', 'utm_campaign', 'click_id',
  'clicked_at', 'checkout_items', 'consent', 'session']);
/** One CSV cell (RFC 4180), with spreadsheet formula injection neutralised (a leading = + - @ gets a quote). */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d\s().-]*$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells) => cells.map(csvCell).join(',');
export const itemsText = (items = []) => (items || []).map((i) => `${(i.quantity || 1) > 1 ? `${i.quantity} x ` : ''}${i.title || ''}${i.variant ? ` (${i.variant})` : ''}`).join('; ');

export const CONSENT_LABEL = Object.freeze({
  asked_to_send: 'Asked the bot to send them the answer',
  inbound_call: 'Called the bot (caller ID)',
  inbound_message: 'Messaged the bot from this number',
  inbound_email: 'E-mailed the bot from this address',
  checkout_link: 'Agreed on the call to be texted a checkout link',
});

// ------------------------------------------------------------------ the store
/**
 * @param {{ dataDir?: string|null, env?: object, now?: () => number, log?: (s: string) => void, retentionDays?: number }} [o]
 */
export function createLeads({ dataDir = null, env = {}, now = () => Date.now(), log = () => {}, retentionDays = 90 } = {}) {
  const keepDays = Math.max(1, Number(env.KNOWBOT_LEADS_RETENTION_DAYS || retentionDays) || 90);
  const keepMs = keepDays * DAY;
  const dir = dataDir ? path.join(dataDir, 'leads') : null;
  const MAX_EVENTS = 20000;          // per bot, in memory and on load
  const bots = new Map();            // bot → { events: [], ready: Promise, chain: Promise }
  const links = new Map();           // id → link record
  const pending = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };
  const fileOf = (bot) => (dir ? path.join(dir, `${campaignOf(bot)}.jsonl`) : null);

  function stateOf(bot) {
    const key = campaignOf(bot);
    let st = bots.get(key);
    if (st) return st;
    st = { events: [], chain: Promise.resolve(), ready: null };
    bots.set(key, st);
    st.ready = (async () => {
      const f = fileOf(key);
      if (!f) return;
      let text = '';
      try { text = await fsp.readFile(f, 'utf8'); } catch { return; }
      const cut = now() - keepMs;
      const all = [];
      let dropped = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const ev = JSON.parse(line); if (ev && Number(ev.at) >= cut) all.push(ev); else dropped++; } catch { dropped++; }
      }
      const kept = all.slice(-MAX_EVENTS);
      dropped += all.length - kept.length;
      // events recorded while the file was loading stay after the stored ones
      st.events = [...kept, ...st.events];
      for (const ev of kept) if (ev.kind === 'link' && ev.id && !links.has(ev.id)) links.set(ev.id, { ...ev });
      if (dropped) st.chain = st.chain.then(() => fsp.writeFile(f, st.events.map((e) => JSON.stringify(e)).join('\n') + (st.events.length ? '\n' : ''))).catch((e) => log(`[leads] could not prune ${key}: ${e.message}`));
    })();
    return st;
  }
  function append(bot, ev) {
    const st = stateOf(bot);
    st.events.push(ev);
    if (st.events.length > MAX_EVENTS) st.events.splice(0, st.events.length - MAX_EVENTS);
    const f = fileOf(bot);
    if (f) {
      st.chain = st.chain.then(() => st.ready).then(() => fsp.mkdir(path.dirname(f), { recursive: true })).then(() => fsp.appendFile(f, `${JSON.stringify(ev)}\n`))
        .catch((e) => log(`[leads] could not save an event for ${campaignOf(bot)}: ${e.message}`));
      track(st.chain);
    }
    return ev;
  }
  const eventsOf = async (bot) => { const st = stateOf(bot); await st.ready; return st.events; };

  /**
   * One lead. Inbound contacts (a caller ID, a number that texted, an address that e-mailed) are recorded once per value
   * and channel per day; every "send me this" send is its own lead (each has its own click id). → the event, or null.
   */
  function lead({ botId, channel = 'web', type = null, value, question = '', cid = null, session = null, consent = 'asked_to_send', via = null, at = null } = {}) {
    try {
      if (!botId) return null;
      const c = contactOf(value);
      if (!c || (type && c.type !== type)) return null;
      const t = Number.isFinite(at) ? at : now();
      const st = stateOf(botId);
      if (consent !== 'asked_to_send') {
        const dup = st.events.some((e) => e.kind === 'lead' && e.value === c.value && e.channel === channel && e.consent === consent && t - e.at < DAY);
        if (dup) return null;
      }
      const ev = { v: 1, kind: 'lead', at: t, bot: campaignOf(botId), channel: String(channel || 'web'), type: c.type, value: c.value, question: oneLine(question).slice(0, 500),
        cid: cid && CLICK_ID_RE.test(cid) ? cid : null, session: session ? String(session).slice(0, 40) : null, consent, ...(via ? { via } : {}) };
      append(botId, ev);
      log(`[leads] bot ${ev.bot}: ${c.type} lead (${ev.channel}, ${consent}) h:${hash8(c.value)}`);
      return ev;
    } catch (e) { log(`[leads] lead not recorded: ${e.message}`); return null; }
  }
  /** "Checkout link sent": a product / cart link texted to `phone`, with its items. */
  function checkout({ botId, channel = 'phone', phone = null, items = [], linkKind = 'checkout', cid = null, session = null, at = null } = {}) {
    try {
      if (!botId) return null;
      const c = contactOf(phone);
      const ev = { v: 1, kind: 'checkout', at: Number.isFinite(at) ? at : now(), bot: campaignOf(botId), channel: String(channel || 'phone'), phone: c?.type === 'phone' ? c.value : null,
        items: (Array.isArray(items) ? items : []).slice(0, 10).map((i) => ({ title: oneLine(i?.title).slice(0, 120), variant: oneLine(i?.variant).slice(0, 80), quantity: Math.max(1, Math.min(99, Number(i?.quantity) || 1)) })),
        linkKind: linkKind === 'product_page' ? 'product_page' : 'checkout', cid: cid && CLICK_ID_RE.test(cid) ? cid : null, session: session ? String(session).slice(0, 40) : null };
      append(botId, ev);
      log(`[leads] bot ${ev.bot}: ${ev.linkKind} link sent (${ev.channel}, ${ev.items.length} items)${ev.phone ? ` h:${hash8(ev.phone)}` : ''}`);
      return ev;
    } catch (e) { log(`[leads] checkout not recorded: ${e.message}`); return null; }
  }

  /**
   * A tracked link for one URL we are about to send. `base` is the public origin (+ API prefix) short links are served
   * under; without it the URL only gets its parameters. Non-http(s) URLs come back unchanged.
   * → the short link (or the tagged URL)
   */
  function link({ botId, url, channel = 'web', delivery = null, kind = 'source', cid = null, base = null, campaign = null } = {}) {
    try {
      if (!botId || !isHttpUrl(url)) return url;
      const medium = mediumOf(channel);
      const content = `${String(kind || 'link').replace(/[^a-z_]/gi, '').toLowerCase()}${delivery ? `_${mediumOf(delivery)}` : ''}`;
      const target = appendTracking(url, { medium, campaign: campaign || campaignOf(botId), content, cid });
      if (!base) return target;
      let id;
      do id = randFrom(B62, 8); while (links.has(id));
      const rec = { v: 1, kind: 'link', at: now(), bot: campaignOf(botId), id, target, channel: String(channel || 'web'), medium, linkKind: String(kind || 'source'), cid: cid || null };
      links.set(id, rec);
      if (links.size > 50000) links.delete(links.keys().next().value);
      append(botId, rec);
      if (dir) track(fsp.mkdir(path.join(dir, 'links'), { recursive: true }).then(() => fsp.writeFile(path.join(dir, 'links', `${id}.json`), JSON.stringify(rec))).catch(() => {}));
      return `${String(base).replace(/\/+$/, '')}/r/${id}`;
    } catch (e) { log(`[leads] link not tracked: ${e.message}`); return url; }
  }
  /** The short link's record (memory, else its file), or null when unknown or past the retention window. */
  async function linkRecord(id) {
    if (!LINK_ID_RE.test(String(id || ''))) return null;
    let rec = links.get(id);
    if (!rec && dir) { try { rec = JSON.parse(await fsp.readFile(path.join(dir, 'links', `${id}.json`), 'utf8')); if (rec?.id === id) links.set(id, rec); else rec = null; } catch { rec = null; } }
    if (!rec || !isHttpUrl(rec.target) || now() - Number(rec.at) > keepMs) return null;
    return rec;
  }
  /** A visit to /r/<id>: → the URL to redirect to (a click is recorded unless `count` is false), or null (404). */
  async function click(id, { count = true } = {}) {
    const rec = await linkRecord(id);
    if (!rec) return null;
    if (count) append(rec.bot, { v: 1, kind: 'click', at: now(), bot: rec.bot, id: rec.id, cid: rec.cid || null });
    return rec.target;
  }

  /**
   * The owner's report for one bot (or several ids of the same bot): leads, checkout links sent and clicks in the last
   * `days` days. → { days, since, leads:[…], conversions:{sent, clicks, clickedSends, items:[…]}, links:{sent, clicks}, retentionDays }
   */
  async function report(botIds, { days = 30 } = {}) {
    const ids = [...new Set((Array.isArray(botIds) ? botIds : [botIds]).filter(Boolean).map(campaignOf))];
    const d = Math.max(1, Math.min(keepDays, Math.floor(Number(days)) || 30));
    const since = now() - d * DAY;
    const all = (await Promise.all(ids.map(eventsOf))).flat().filter((e) => Number(e.at) >= since).sort((a, b) => a.at - b.at);
    const linkById = new Map(all.filter((e) => e.kind === 'link').map((e) => [e.id, e]));
    const firstClick = new Map(); // cid → at
    const clicksByCid = new Map();
    let clicks = 0;
    for (const e of all) {
      if (e.kind !== 'click') continue;
      clicks++;
      const cid = e.cid || linkById.get(e.id)?.cid;
      if (!cid) continue;
      if (!firstClick.has(cid)) firstClick.set(cid, e.at);
      clicksByCid.set(cid, (clicksByCid.get(cid) || 0) + 1);
    }
    const utmOf = (cid, channel) => {
      const l = [...linkById.values()].find((x) => x.cid === cid);
      let u = null;
      try { u = l ? new URL(l.target).searchParams : null; } catch { u = null; }
      return { utm_source: u?.get('utm_source') || (cid ? UTM_SOURCE : ''), utm_medium: u?.get('utm_medium') || (cid ? mediumOf(channel) : ''), utm_campaign: u?.get('utm_campaign') || (cid ? ids[0] : '') };
    };
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const leads = all.filter((e) => e.kind === 'lead').map((e) => ({ at: iso(e.at), bot: e.bot, channel: e.channel, type: e.type, value: e.value, question: e.question || '',
      consent: e.consent, consentLabel: CONSENT_LABEL[e.consent] || '', cid: e.cid || null, session: e.session || null, ...(e.via ? { via: e.via } : {}),
      clickedAt: e.cid ? iso(firstClick.get(e.cid)) : null, clicks: e.cid ? clicksByCid.get(e.cid) || 0 : 0, ...(e.cid ? utmOf(e.cid, e.channel) : {}) })).reverse();
    const sent = all.filter((e) => e.kind === 'checkout').map((e) => ({ at: iso(e.at), bot: e.bot, channel: e.channel, phone: e.phone, items: e.items, itemsText: itemsText(e.items),
      linkKind: e.linkKind, cid: e.cid || null, session: e.session || null, clickedAt: e.cid ? iso(firstClick.get(e.cid)) : null, clicks: e.cid ? clicksByCid.get(e.cid) || 0 : 0,
      ...(e.cid ? utmOf(e.cid, e.channel) : {}) })).reverse();
    return {
      days: d, since: iso(since), retentionDays: keepDays,
      leads,
      conversions: { sent: sent.length, clicks: sent.reduce((n, s) => n + s.clicks, 0), clickedSends: sent.filter((s) => s.clickedAt).length, items: sent },
      links: { sent: linkById.size, clicks },
    };
  }
  /** The CRM export (CSV_COLUMNS): one row per lead and per checkout link sent, newest first. */
  async function csv(botIds, { days = 30 } = {}) {
    const r = await report(botIds, { days });
    const rows = [
      ...r.leads.map((l) => ({ t: l.at, cells: [l.at, l.bot, l.channel, l.type, l.type === 'email' ? l.value : '', l.type === 'phone' ? l.value : '', l.question, l.utm_source || '', l.utm_medium || '', l.utm_campaign || '', l.cid || '', l.clickedAt || '', '', l.consent, l.session || ''] })),
      ...r.conversions.items.map((s) => ({ t: s.at, cells: [s.at, s.bot, s.channel, 'checkout', '', s.phone || '', '', s.utm_source || '', s.utm_medium || '', s.utm_campaign || '', s.cid || '', s.clickedAt || '', s.itemsText, 'checkout_link', s.session || ''] })),
    ].sort((a, b) => String(b.t).localeCompare(String(a.t)));
    return `${[csvRow(CSV_COLUMNS), ...rows.map((x) => csvRow(x.cells))].join('\r\n')}\r\n`;
  }

  return { lead, checkout, link, click, linkRecord, report, csv, retentionDays: keepDays, idle: async () => { while (pending.size) await Promise.all([...pending]); } };
}

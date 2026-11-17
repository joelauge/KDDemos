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
//   agent     {kind:'agent', at, bot, outcome:'answered'|'refused'|'limited', billing:'free'|'paid'|'owner', question}
//             one question an AI agent asked (server/agents.mjs): the usage meter for agent answers, per bot per day.
//             'free' counts against the daily free allowance, 'paid' is metered (paid agent access on), 'owner' is a
//             call made with the bot's own key. 'limited' is a question turned away by the free limit (at most 100 a day
//             are recorded; the rest are only counted in memory).
//
//   shown, chatclick, sale, saleping: links clicked INSIDE a chat surface (the chat bubble, Homepage search, web voice
//             mode) and the orders the owner's site reported for them. See "chat clicks and attributed sales" below.
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
//
// Durable copy (setDurable): the local data dir does not survive a restart in production, so a bot's events are also
// kept as one snapshot file in the store that holds the bot's saved state (server/trials.mjs: <bot root>/_leads.jsonl,
// beside _spec.json, never searched or listed, deleted with the bot). The snapshot is rewritten a few seconds after
// an event (only events inside the retention window are written, so retention is unchanged) and read back when the
// local file is missing. It holds exactly what the local file holds, for the same bots, no longer.
//
// Listeners (on): server/crm delivers each new lead to the CRMs the owner connected. Only kind:'lead' events are
// announced, after they are recorded.
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { appendTracking, linkClickId, linkSuffix, UTM_SOURCE, CLICK_ID_RE } from '../lib/track.js';

export { appendTracking, linkClickId, linkSuffix, UTM_SOURCE, CLICK_ID_RE }; // one helper for sent links and chat links (lib/track.js)
export const MEDIUMS = Object.freeze(['sms', 'email', 'phone', 'whatsapp', 'webchat', 'voice', 'homepage']);
const MEDIUM_OF = { studio: 'webchat', web: 'webchat', api: 'webchat', webchat: 'webchat', chat: 'webchat', site: 'homepage', homepage: 'homepage',
  voice: 'voice', webvoice: 'voice', phone: 'phone', call: 'phone', sms: 'sms', text: 'sms', whatsapp: 'whatsapp', email: 'email' };
/** The conversation channel → its utm_medium (sms | email | phone | whatsapp | webchat | voice | homepage). */
export const mediumOf = (channel) => MEDIUM_OF[String(channel || '').toLowerCase()] || 'webchat';
/** utm_campaign: the bot's id (already URL-safe; anything else is slugged). */
export const campaignOf = (botId) => String(botId || 'bot').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'bot';
export const LINK_ID_RE = /^[A-Za-z0-9]{8,16}$/;
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

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\])]+[^\s<>"'\]).,;:!?”’]/g;
/**
 * An answer (sendinfo.mjs normalizeAnswer / devapi answer shape) with every outbound link replaced by track(url, kind):
 * the proof link ('proof'), the citations' urls and the links inside the answer text ('source'), and the product cards'
 * links ('product'; their photos are never rewritten). Returns a copy.
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
    ...(Array.isArray(a.products) ? { products: a.products.map((p) => (p && isHttpUrl(p.url) ? { ...p, url: t(p.url, 'product') } : p)) } : {}),
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
export const CLICK_COLUMNS = Object.freeze(['timestamp', 'bot', 'channel', 'link_type', 'product', 'price', 'currency', 'url', 'question', 'answer_id', 'click_id', 'order_id', 'order_total', 'order_currency']);
/** How an order was noticed, in the owner's words (the Stats orders table and the sales CSV). */
export const SALE_VIA_TEXT = Object.freeze({ snippet: 'reported by your snippet', event: "from your store's purchase event", page: 'seen on your order page', pixel: "reported by your store's pixel" });
export const SALE_COLUMNS = Object.freeze(['timestamp', 'bot', 'order_id', 'total', 'currency', 'items', 'channel', 'clicked_at', 'product', 'url', 'question', 'click_id', 'source', 'detected_by']);
export const itemsText = (items = []) => (items || []).map((i) => `${(i.quantity || 1) > 1 ? `${i.quantity} x ` : ''}${i.title || ''}${i.variant ? ` (${i.variant})` : ''}`).join('; ');

export const CONSENT_LABEL = Object.freeze({
  asked_to_send: 'Asked the bot to send them the answer',
  inbound_call: 'Called the bot (caller ID)',
  inbound_message: 'Messaged the bot from this number',
  inbound_email: 'E-mailed the bot from this address',
  checkout_link: 'Agreed on the call to be texted a checkout link',
  left_message: 'Left a message for your team (voice)',
  callback_request: 'Asked for a callback (voice)',
});

// ------------------------------------------------------------------ the store
/**
 * @param {{ dataDir?: string|null, env?: object, now?: () => number, log?: (s: string) => void, retentionDays?: number }} [o]
 */
export function createLeads({ dataDir = null, env = {}, now = () => Date.now(), log = () => {}, retentionDays = 90, durable = null, durableMs = 2000 } = {}) {
  const keepDays = Math.max(1, Number(env.KNOWBOT_LEADS_RETENTION_DAYS || retentionDays) || 90);
  const keepMs = keepDays * DAY;
  const dir = dataDir ? path.join(dataDir, 'leads') : null;
  const MAX_EVENTS = 20000;          // per bot, in memory and on load
  const bots = new Map();            // bot → { events: [], ready: Promise, chain: Promise }
  const links = new Map();           // id → link record
  const pending = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };
  const fileOf = (bot) => (dir ? path.join(dir, `${campaignOf(bot)}.jsonl`) : null);
  const listeners = new Set();
  const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  /** Writes the bot's durable snapshot now (events inside the retention window only). */
  function persist(bot) {
    const key = campaignOf(bot);
    const st = bots.get(key);
    if (!durable?.write || !st) return Promise.resolve();
    clearTimeout(st.durableTimer); st.durableTimer = null;
    const cut = now() - keepMs;
    st.durableChain = (st.durableChain || Promise.resolve()).then(() => st.ready).then(() => durable.write(key, jsonl(st.events.filter((e) => Number(e.at) >= cut))))
      .catch((e) => log(`[leads] could not save the durable copy for ${key}: ${e.message}`));
    return track(st.durableChain);
  }
  function persistSoon(key, st) {
    if (!durable?.write || st.durableTimer) return;
    st.durableTimer = setTimeout(() => { st.durableTimer = null; persist(key); }, Math.max(0, durableMs));
    st.durableTimer.unref?.();
  }

  function stateOf(bot) {
    const key = campaignOf(bot);
    let st = bots.get(key);
    if (st) return st;
    st = { events: [], chain: Promise.resolve(), ready: null };
    bots.set(key, st);
    st.ready = (async () => {
      const f = fileOf(key);
      if (!f && !durable?.read) return;
      let text = '', restored = false;
      if (f) { try { text = await fsp.readFile(f, 'utf8'); } catch { text = ''; } }
      // no local file (a fresh container): the durable snapshot, when this bot has one
      if (!text.trim() && durable?.read) {
        try { text = String((await durable.read(key)) || ''); restored = !!text.trim(); } catch (e) { log(`[leads] could not read the durable copy for ${key}: ${e.message}`); }
      }
      if (!text.trim()) return;
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
      st.att = null; // the attribution index is rebuilt from the loaded events
      for (const ev of kept) if (ev.kind === 'link' && ev.id && !links.has(ev.id)) links.set(ev.id, { ...ev });
      if (f && (dropped || restored)) st.chain = st.chain.then(() => fsp.mkdir(path.dirname(f), { recursive: true })).then(() => fsp.writeFile(f, jsonl(st.events))).catch((e) => log(`[leads] could not prune ${key}: ${e.message}`));
      if (restored) log(`[leads] bot ${key}: restored ${kept.length} events from the durable copy`);
      if (dropped && restored) persistSoon(key, st); // the snapshot held events past the retention window: rewrite it without them
    })();
    return st;
  }
  function append(bot, ev) {
    const st = stateOf(bot);
    st.events.push(ev);
    if (st.events.length > MAX_EVENTS) st.events.splice(0, st.events.length - MAX_EVENTS);
    if (st.att) attAdd(st.att, ev);
    const f = fileOf(bot);
    if (f) {
      st.chain = st.chain.then(() => st.ready).then(() => fsp.mkdir(path.dirname(f), { recursive: true })).then(() => fsp.appendFile(f, `${JSON.stringify(ev)}\n`))
        .catch((e) => log(`[leads] could not save an event for ${campaignOf(bot)}: ${e.message}`));
      track(st.chain);
    }
    persistSoon(campaignOf(bot), st);
    return ev;
  }
  const eventsOf = async (bot) => { const st = stateOf(bot); await st.ready; return st.events; };

  /**
   * One lead. Inbound contacts (a caller ID, a number that texted, an address that e-mailed) are recorded once per value
   * and channel per day; every "send me this" send is its own lead (each has its own click id). → the event, or null.
   */
  function lead({ botId, channel = 'web', type = null, value, question = '', cid = null, session = null, consent = 'asked_to_send', via = null, at = null, name = null, note = null, extra = null } = {}) {
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
        cid: cid && CLICK_ID_RE.test(cid) ? cid : null, session: session ? String(session).slice(0, 40) : null, consent, ...(via ? { via } : {}),
        ...(name ? { name: oneLine(name).slice(0, 80) } : {}), ...(note ? { note: oneLine(note).slice(0, 120) } : {}) };
      append(botId, ev);
      log(`[leads] bot ${ev.bot}: ${c.type} lead (${ev.channel}, ${consent}) h:${hash8(c.value)}`);
      // extra (e.g. the answer text that was sent) is passed to listeners only: it is never stored
      for (const fn of listeners) { try { fn(ev, extra || {}); } catch (e) { log(`[leads] a lead listener failed: ${e.message}`); } }
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
  /** The links sent with one lead (its click id): [{url, kind}] (the tagged targets, oldest first). */
  async function linksOf(botId, cid) {
    if (!cid) return [];
    return (await eventsOf(botId)).filter((e) => e.kind === 'link' && e.cid === cid && isHttpUrl(e.target)).slice(0, 10).map((e) => ({ url: e.target, kind: e.linkKind || 'source' }));
  }
  /** One AI-agent question (server/agents.mjs): recorded per bot; the free allowance and the meter count these. */
  function agent({ botId, outcome = 'answered', billing = 'free', question = '', at = null } = {}) {
    try {
      if (!botId) return null;
      const ev = { v: 1, kind: 'agent', at: Number.isFinite(at) ? at : now(), bot: campaignOf(botId), outcome: ['answered', 'refused', 'limited'].includes(outcome) ? outcome : 'answered',
        billing: ['free', 'paid', 'owner'].includes(billing) ? billing : 'free', question: oneLine(question).slice(0, 500) };
      return append(botId, ev);
    } catch (e) { log(`[leads] agent question not recorded: ${e.message}`); return null; }
  }
  /** Agent usage of one bot on one UTC day (YYYY-MM-DD): {free, paid, owner, limited, answered, refused}. */
  async function agentDay(botId, day = new Date(now()).toISOString().slice(0, 10)) {
    const out = { free: 0, paid: 0, owner: 0, limited: 0, answered: 0, refused: 0 };
    for (const e of await eventsOf(botId)) {
      if (e.kind !== 'agent' || new Date(Number(e.at)).toISOString().slice(0, 10) !== day) continue;
      if (e.outcome === 'limited') { out.limited++; continue; }
      out[e.billing] = (out[e.billing] || 0) + 1;
      out[e.outcome === 'refused' ? 'refused' : 'answered']++;
    }
    return out;
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
      consent: e.consent, consentLabel: CONSENT_LABEL[e.consent] || '', cid: e.cid || null, session: e.session || null, ...(e.via ? { via: e.via } : {}), ...(e.name ? { name: e.name } : {}), ...(e.note ? { note: e.note } : {}),
      clickedAt: e.cid ? iso(firstClick.get(e.cid)) : null, clicks: e.cid ? clicksByCid.get(e.cid) || 0 : 0, ...(e.cid ? utmOf(e.cid, e.channel) : {}) })).reverse();
    const sent = all.filter((e) => e.kind === 'checkout').map((e) => ({ at: iso(e.at), bot: e.bot, channel: e.channel, phone: e.phone, items: e.items, itemsText: itemsText(e.items),
      linkKind: e.linkKind, cid: e.cid || null, session: e.session || null, clickedAt: e.cid ? iso(firstClick.get(e.cid)) : null, clicks: e.cid ? clicksByCid.get(e.cid) || 0 : 0,
      ...(e.cid ? utmOf(e.cid, e.channel) : {}) })).reverse();
    // AI agents (kind:'agent'): questions answered for other AI assistants, by outcome and billing, and per UTC day
    const ag = all.filter((e) => e.kind === 'agent');
    const agentDays = new Map();
    for (const e of ag) {
      const day = new Date(Number(e.at)).toISOString().slice(0, 10);
      const row = agentDays.get(day) || { day, questions: 0, answered: 0, refused: 0, limited: 0, paid: 0 };
      if (e.outcome === 'limited') row.limited++;
      else { row.questions++; row[e.outcome === 'refused' ? 'refused' : 'answered']++; if (e.billing === 'paid') row.paid++; }
      agentDays.set(day, row);
    }
    const asked = ag.filter((e) => e.outcome !== 'limited');
    const agents = { questions: asked.length, answered: asked.filter((e) => e.outcome !== 'refused').length, refused: asked.filter((e) => e.outcome === 'refused').length,
      limited: ag.length - asked.length, free: asked.filter((e) => e.billing === 'free').length, paid: asked.filter((e) => e.billing === 'paid').length,
      owner: asked.filter((e) => e.billing === 'owner').length, byDay: [...agentDays.values()] };
    return {
      days: d, since: iso(since), retentionDays: keepDays,
      leads, agents,
      agentItems: asked.map((e) => ({ at: iso(e.at), bot: e.bot, outcome: e.outcome, billing: e.billing, question: e.question || '' })).reverse(),
      conversions: { sent: sent.length, clicks: sent.reduce((n, s) => n + s.clicks, 0), clickedSends: sent.filter((s) => s.clickedAt).length, items: sent },
      links: { sent: linkById.size, clicks },
    };
  }
  /** The CRM export (CSV_COLUMNS): one row per lead and per checkout link sent, newest first. */
  async function csv(botIds, { days = 30 } = {}) {
    const r = await report(botIds, { days });
    const rows = [
      ...r.leads.map((l) => ({ t: l.at, cells: [l.at, l.bot, l.channel, l.type, l.type === 'email' ? l.value : '', l.type === 'phone' ? l.value : '', l.question, l.utm_source || '', l.utm_medium || '', l.utm_campaign || '', l.cid || '', l.clickedAt || '', '', l.consent, l.session || ''] })),
      // channel "agent": one row per question an AI agent asked (type agent_answered | agent_refused; session = free | paid | owner)
      ...(r.agentItems || []).map((x) => ({ t: x.at, cells: [x.at, x.bot, 'agent', `agent_${x.outcome}`, '', '', x.question, '', '', '', '', '', '', '', x.billing] })),
      ...r.conversions.items.map((s) => ({ t: s.at, cells: [s.at, s.bot, s.channel, 'checkout', '', s.phone || '', '', s.utm_source || '', s.utm_medium || '', s.utm_campaign || '', s.cid || '', s.clickedAt || '', s.itemsText, 'checkout_link', s.session || ''] })),
    ].sort((a, b) => String(b.t).localeCompare(String(a.t)));
    return `${[csvRow(CSV_COLUMNS), ...rows.map((x) => csvRow(x.cells))].join('\r\n')}\r\n`;
  }


  // ------------------------------------------------------------------ chat clicks and attributed sales
  // shown      {kind:'shown', at, bot, channel:'web'|'site'|'voice', cid, answer, question, links:[{u, k, t?, p?, c?}]}
  //            one answer on a chat surface that carried links (product cards, source links, links in the text). `cid`
  //            is the answer's click id (10 characters); each link's own click id is cid + 2 characters derived from
  //            the link (lib/track.js linkClickId), so a click id names the bot's answer and the link, never a person.
  // chatclick  {kind:'chatclick', at, bot, channel, cid, answer, linkKind, url, title?, price?, currency?}
  //            one click on such a link, reported by the browser (POST /v1/bots/:id/click). Only links of a known
  //            answer (or pages on the bot's own site) are accepted, so this is never a place to store arbitrary URLs.
  // sale       {kind:'sale', at, bot, cid, order, total, currency, items?, clickAt, clickSeen, channel, answer, linkKind,
  //            url, title?, source:'site'}  an order the owner's own order-confirmation page reported (site/sale.js,
  //            POST /v1/bots/:id/sale) for a click id this module issued, inside the attribution window. Reported by
  //            the site, not a verified payment. No customer name, email or address is accepted or kept.
  //            `via` says how the order was noticed: 'snippet' (the owner's own snippet or call; also every report from
  //            before detection existed), 'event' (the store's purchase event in dataLayer), 'page' (read from the order
  //            page itself), 'pixel' (the owner's Shopify custom pixel).
  // saleping   {kind:'saleping', at, bot, page?:'site', via?, unread?}  site/sale.js checked in, at most once a day per
  //            sort: an order page was seen (no `page`; `via` the detector, `unread` = 'order' | 'total' | 'currency'
  //            when it could not read the order for certain, so nothing was guessed), or (page:'site') the website line
  //            ran on a page of the owner's site for a visitor who came from the chat.
  const SHOWN_LINKS_MAX = 16, CLICKS_PER_ANSWER = 30, SALES_PER_ANSWER = 5;
  const LINK_KINDS = ['product', 'source', 'link'];
  const hostKey = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
  // a renderer may hand the browser the link in its normal form (https://shop.example → https://shop.example/)
  const normUrl = (u) => { try { return new URL(u).href; } catch { return String(u || ''); } };
  const SALE_VIAS = ['snippet', 'event', 'page', 'pixel'], UNREAD = ['order', 'total', 'currency'];
  const viaOf = (v) => (SALE_VIAS.includes(v) ? v : 'snippet');
  const pingKey = (e) => `${e.page === 'site' ? 'site' : 'order'}|${e.via || ''}|${e.unread || ''}`;
  /** The bot's attribution index (answers by click id, their clicks, orders by id), built once and kept current by append. */
  function attOf(st) {
    if (st.att) return st.att;
    const A = { shown: new Map(), clicks: new Map(), orders: new Map(), sales: new Map(), pings: new Map() };
    for (const e of st.events) attAdd(A, e);
    st.att = A;
    return A;
  }
  function attAdd(A, e) {
    if (e.kind === 'shown' && e.cid) A.shown.set(e.cid, e);
    else if (e.kind === 'chatclick' && e.cid) { const b = e.cid.slice(0, 10); const l = A.clicks.get(b); if (l) l.push(e); else A.clicks.set(b, [e]); }
    else if (e.kind === 'sale') { A.orders.set(String(e.order), e); const b = String(e.cid || '').slice(0, 10); A.sales.set(b, (A.sales.get(b) || 0) + 1); }
    else if (e.kind === 'saleping') A.pings.set(pingKey(e), new Date(Number(e.at)).toISOString().slice(0, 10));
  }
  /**
   * An answer with links was shown on a chat surface. links: [{url, kind:'product'|'source'|'link', title?, price?, currency?}].
   * → the answer's click id (the browser derives each link's own from it), or null when there is nothing to track.
   */
  function shown({ botId, channel = 'web', answerId = null, question = '', links = [], at = null } = {}) {
    try {
      if (!botId) return null;
      const list = [], seen = new Set();
      for (const l of Array.isArray(links) ? links : []) {
        const u = String(l?.url || '').trim();
        if (!isHttpUrl(u) || u.length > 2000 || seen.has(u)) continue;
        seen.add(u);
        const price = l.price == null || l.price === '' ? null : Number(l.price);
        list.push({ u, k: LINK_KINDS.includes(l.kind) ? l.kind : 'link', ...(l.title ? { t: oneLine(l.title).slice(0, 120) } : {}),
          ...(Number.isFinite(price) ? { p: price } : {}), ...(l.currency && /^[A-Za-z]{3}$/.test(l.currency) ? { c: String(l.currency).toUpperCase() } : {}) });
        if (list.length >= SHOWN_LINKS_MAX) break;
      }
      if (!list.length) return null;
      const cid = newClickId();
      append(botId, { v: 1, kind: 'shown', at: Number.isFinite(at) ? at : now(), bot: campaignOf(botId), channel: String(channel || 'web'), cid,
        answer: answerId ? String(answerId).slice(0, 40) : null, question: oneLine(question).slice(0, 300), links: list });
      return cid;
    } catch (e) { log(`[leads] shown links not recorded: ${e.message}`); return null; }
  }
  /** The answer (and the link) a click id belongs to, or a reason it is not accepted. */
  function resolveClickId(A, cid, t) {
    const id = String(cid || '');
    if (!/^[a-z0-9]{12}$/.test(id)) return { reason: 'invalid' };
    const base = id.slice(0, 10), sh = A.shown.get(base);
    if (!sh || t - Number(sh.at) > keepMs) return { reason: 'unknown_click' };
    return { id, base, sh, link: sh.links.find((l) => linkClickId(base, l.u) === id || linkClickId(base, normUrl(l.u)) === id) || null };
  }
  /**
   * One click on a chat link. `url` is the link as the answer gave it (before the tags). Accepted only when the click id
   * was issued for this bot, belongs to that link, and the link is one of that answer's (or a page on one of `hosts`,
   * the bot's own site). → { ok, duplicate?, reason? }
   */
  async function chatClick({ botId, cid, url, hosts = [], at = null } = {}) {
    try {
      const u = String(url || '').trim();
      if (!botId || !isHttpUrl(u) || u.length > 2000) return { ok: false, reason: 'invalid' };
      const st = stateOf(botId);
      await st.ready;
      const A = attOf(st), t = Number.isFinite(at) ? at : now();
      const r = resolveClickId(A, cid, t);
      if (r.reason) return { ok: false, reason: r.reason };
      if (linkClickId(r.base, u) !== r.id) return { ok: false, reason: 'mismatch' };
      let link = r.sh.links.find((l) => l.u === u || normUrl(l.u) === normUrl(u));
      if (!link) {
        const h = hostKey(u);
        if (!h || !(hosts || []).map(hostKey).includes(h)) return { ok: false, reason: 'not_this_answer' };
        link = { u, k: 'link' };
      }
      const prior = A.clicks.get(r.base) || [];
      if (prior.some((c) => c.cid === r.id && t - Number(c.at) < 3000)) return { ok: true, duplicate: true }; // click + auxclick, a double click
      if (prior.length >= CLICKS_PER_ANSWER) return { ok: false, reason: 'limit' };
      append(botId, { v: 1, kind: 'chatclick', at: t, bot: campaignOf(botId), channel: r.sh.channel, cid: r.id, answer: r.sh.answer || null, linkKind: link.k, url: link.u,
        ...(link.t ? { title: link.t } : {}), ...(link.p != null ? { price: link.p } : {}), ...(link.c ? { currency: link.c } : {}) });
      return { ok: true };
    } catch (e) { log(`[leads] click not recorded: ${e.message}`); return { ok: false, reason: 'error' }; }
  }
  const ORDER_ID_RE = /^[A-Za-z0-9#][A-Za-z0-9 _.#/:-]{0,63}$/;
  const amountOf = (v) => {
    const n = typeof v === 'number' ? v : /^\d{1,9}(?:\.\d{1,4})?$/.test(String(v ?? '').trim()) ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n * 100) / 100 : null;
  };
  /**
   * An order reported by the owner's order-confirmation page for a click id. Recorded once per order id; only for a
   * click id this bot issued, no older than `windowDays` (from the click, else from the answer). Amounts are checked;
   * anything that is not {cid, order, total, currency, items[{title, quantity, price}]} is ignored (no customer details).
   * → { ok, attributed, duplicate?, reason? }   ok:false = a malformed report (400); attributed:false = not ours to count
   */
  async function sale({ botId, cid, order, total, currency, items = null, windowDays = 7, at = null, via = 'snippet' } = {}) {
    try {
      const orderId = String(order ?? '').trim();
      const amount = amountOf(total), cur = String(currency || '').trim().toUpperCase();
      if (!botId || !ORDER_ID_RE.test(orderId) || orderId.includes('@')) return { ok: false, attributed: false, reason: 'bad_order' };
      if (amount == null) return { ok: false, attributed: false, reason: 'bad_total' };
      if (!/^[A-Z]{3}$/.test(cur)) return { ok: false, attributed: false, reason: 'bad_currency' };
      const st = stateOf(botId);
      await st.ready;
      const A = attOf(st), t = Number.isFinite(at) ? at : now();
      if (A.orders.has(orderId)) return { ok: true, attributed: true, duplicate: true };
      const r = resolveClickId(A, cid, t);
      if (r.reason) return { ok: r.reason !== 'invalid', attributed: false, reason: r.reason };
      const clicks = (A.clicks.get(r.base) || []).filter((c) => c.cid === r.id && Number(c.at) <= t);
      const last = clicks[clicks.length - 1] || null;
      const clickAt = Number(last?.at ?? r.sh.at);
      const win = Math.max(1, Math.min(30, Math.floor(Number(windowDays)) || 7));
      if (t - clickAt > win * DAY) return { ok: true, attributed: false, reason: 'outside_window' };
      if ((A.sales.get(r.base) || 0) >= SALES_PER_ANSWER) return { ok: true, attributed: false, reason: 'limit' };
      const link = last ? { u: last.url, k: last.linkKind, t: last.title } : r.link;
      const list = (Array.isArray(items) ? items : []).slice(0, 20).map((i) => ({ title: oneLine(i?.title).slice(0, 120), quantity: Math.max(1, Math.min(999, Math.floor(Number(i?.quantity)) || 1)),
        ...(amountOf(i?.price) != null ? { price: amountOf(i.price) } : {}) })).filter((i) => i.title);
      append(botId, { v: 1, kind: 'sale', at: t, bot: campaignOf(botId), cid: r.id, order: orderId, total: amount, currency: cur, ...(list.length ? { items: list } : {}),
        clickAt, clickSeen: !!last, channel: r.sh.channel, answer: r.sh.answer || null, linkKind: link?.k || null, url: link?.u || null, ...(link?.t ? { title: link.t } : {}), source: 'site', via: viaOf(via) });
      log(`[leads] bot ${campaignOf(botId)}: sale reported by the site (${cur} ${amount}, ${r.sh.channel})`);
      return { ok: true, attributed: true };
    } catch (e) { log(`[leads] sale not recorded: ${e.message}`); return { ok: false, attributed: false, reason: 'error' }; }
  }
  /**
   * site/sale.js checked in: an order page was seen (with or without a click id; `via` the detector, `unread` what it
   * could not read), or with page:'site' the website line ran on the owner's site. Remembered once a day per sort, so
   * the Studio can say whether sale tracking works without keeping anything about a visitor.
   */
  async function salePing(botId, { page = null, via = null, unread = null } = {}) {
    try {
      if (!botId) return false;
      const st = stateOf(botId);
      await st.ready;
      const e = { v: 1, kind: 'saleping', at: now(), bot: campaignOf(botId), ...(page === 'site' ? { page: 'site' } : { ...(SALE_VIAS.includes(via) ? { via } : {}), ...(UNREAD.includes(unread) ? { unread } : {}) }) };
      const A = attOf(st), day = new Date(now()).toISOString().slice(0, 10);
      if (A.pings.get(pingKey(e)) === day) return false;
      append(botId, e);
      return true;
    } catch { return false; }
  }

  /**
   * "Clicks & sales" for one bot: totals, a per-day series (the viewer's days: tz = minutes east of UTC), top products
   * and questions, the clicks and the attributed sales (newest first).
   */
  async function attribution(botIds, { days = 30, tz = 0, windowDays = 7 } = {}) {
    const ids = [...new Set((Array.isArray(botIds) ? botIds : [botIds]).filter(Boolean).map(campaignOf))];
    const d = Math.max(1, Math.min(keepDays, Math.floor(Number(days)) || 30));
    const since = now() - d * DAY;
    const off = Math.max(-840, Math.min(840, Math.round(Number(tz)) || 0)) * 60000;
    const dayOf = (t) => new Date(Number(t) + off).toISOString().slice(0, 10);
    const iso = (t) => (t ? new Date(Number(t)).toISOString() : null);
    const every = (await Promise.all(ids.map(eventsOf))).flat();
    const shownAll = new Map(every.filter((e) => e.kind === 'shown').map((e) => [e.cid, e]));
    const inRange = every.filter((e) => Number(e.at) >= since).sort((a, b) => a.at - b.at);
    const shownEv = inRange.filter((e) => e.kind === 'shown'), clickEv = inRange.filter((e) => e.kind === 'chatclick'), saleEv = inRange.filter((e) => e.kind === 'sale');
    const questionOf = (cid) => shownAll.get(String(cid || '').slice(0, 10))?.question || '';
    // revenue per currency; the series and the tables use the currency with the most orders
    const money = new Map();
    for (const s of saleEv) { const m = money.get(s.currency) || { currency: s.currency, amount: 0, orders: 0 }; m.amount = Math.round((m.amount + s.total) * 100) / 100; m.orders++; money.set(s.currency, m); }
    const revenue = [...money.values()].sort((a, b) => b.orders - a.orders || b.amount - a.amount);
    const currency = revenue[0]?.currency || null;
    const byDay = new Map();
    for (let i = d - 1; i >= 0; i--) { const day = dayOf(now() - i * DAY); byDay.set(day, { day, shown: 0, clicks: 0, orders: 0, revenue: 0 }); }
    const dayRow = (t) => byDay.get(dayOf(t));
    const clicked = new Set(every.filter((e) => e.kind === 'chatclick').map((e) => e.cid.slice(0, 10)));
    const channels = {};
    const chan = (c) => (channels[c] ||= { shown: 0, clicks: 0, orders: 0 });
    const products = new Map(), questions = new Map();
    const prod = (url, title, price, cur) => { let p = products.get(url); if (!p) { p = { url, title: title || url, price: price ?? null, currency: cur || null, clicks: 0, orders: 0, revenue: 0 }; products.set(url, p); } return p; };
    const ques = (text) => { const k = String(text || '').toLowerCase(); let q = questions.get(k); if (!q) { q = { question: text || '', shown: 0, clicks: 0, orders: 0, revenue: 0 }; questions.set(k, q); } return q; };
    for (const e of shownEv) { const r = dayRow(e.at); if (r) r.shown++; chan(e.channel).shown++; if (e.question) ques(e.question).shown++; }
    for (const e of clickEv) {
      const r = dayRow(e.at); if (r) r.clicks++;
      chan(e.channel).clicks++;
      if (e.linkKind === 'product') prod(e.url, e.title, e.price, e.currency).clicks++;
      const q = questionOf(e.cid); if (q) ques(q).clicks++;
    }
    for (const s of saleEv) {
      const mine = s.currency === currency;
      const r = dayRow(s.at); if (r) { r.orders++; if (mine) r.revenue = Math.round((r.revenue + s.total) * 100) / 100; }
      chan(s.channel).orders++;
      if (s.linkKind === 'product' && s.url) { const p = prod(s.url, s.title, null, null); p.orders++; if (mine) p.revenue = Math.round((p.revenue + s.total) * 100) / 100; }
      const q = questionOf(s.cid); if (q) { const x = ques(q); x.orders++; if (mine) x.revenue = Math.round((x.revenue + s.total) * 100) / 100; }
    }
    const saleByCid = new Map(saleEv.map((s) => [s.cid, s]));
    const pings = every.filter((e) => e.kind === 'saleping'), allSales = every.filter((e) => e.kind === 'sale');
    const clickedAnswers = shownEv.filter((e) => clicked.has(e.cid)).length;
    return {
      days: d, since: iso(since), retentionDays: keepDays, windowDays: Math.max(1, Math.min(30, Math.floor(Number(windowDays)) || 7)), currency,
      totals: { shown: shownEv.length, clicks: clickEv.length, clickedAnswers, rate: shownEv.length ? Math.min(1, clickedAnswers / shownEv.length) : null, orders: saleEv.length, revenue },
      byDay: [...byDay.values()], channels,
      products: [...products.values()].sort((a, b) => b.clicks - a.clicks || b.revenue - a.revenue).slice(0, 50),
      questions: [...questions.values()].filter((q) => q.clicks || q.orders).sort((a, b) => b.clicks - a.clicks || b.orders - a.orders).slice(0, 50),
      clicks: clickEv.map((e) => ({ at: iso(e.at), bot: e.bot, channel: e.channel, kind: e.linkKind, url: e.url, title: e.title || '', price: e.price ?? null, currency: e.currency || null,
        question: questionOf(e.cid), answer: e.answer || null, cid: e.cid, ...(saleByCid.has(e.cid) ? { order: saleByCid.get(e.cid).order, orderTotal: saleByCid.get(e.cid).total, orderCurrency: saleByCid.get(e.cid).currency } : {}) })).reverse(),
      sales: saleEv.map((s) => ({ at: iso(s.at), bot: s.bot, order: s.order, total: s.total, currency: s.currency, items: s.items || [], itemsText: itemsText(s.items || []), channel: s.channel,
        clickedAt: iso(s.clickAt), clickSeen: s.clickSeen !== false, kind: s.linkKind || null, url: s.url || null, title: s.title || '', question: questionOf(s.cid), answer: s.answer || null, cid: s.cid, source: 'site', via: viaOf(s.via) })).reverse(),
      saleTracking: saleTrackingOf(pings, allSales, iso),
    };
  }
  /**
   * What the Studio shows about sale tracking. status: 'detected' (an order page was seen and read: by a sale, or by an
   * order-page check-in), 'waiting' (the website line was seen running on the site, no order page yet), 'none'.
   * `via` is the detector that fired last; `unread` is set while the newest order page seen could not be read.
   */
  function saleTrackingOf(pings, sales, iso) {
    const lastOf = (list) => list.reduce((m, e) => (m && Number(m.at) >= Number(e.at) ? m : e), null);
    const orderPings = pings.filter((e) => e.page !== 'site');
    const read = lastOf([...orderPings.filter((e) => !e.unread), ...sales]), unread = lastOf(orderPings.filter((e) => e.unread)), site = lastOf(pings.filter((e) => e.page === 'site'));
    const lastSale = lastOf(sales), seen = lastOf([...orderPings, ...sales]);
    const stuck = unread && (!read || Number(unread.at) > Number(read.at));
    return {
      installed: !!seen, lastSeenAt: iso(seen?.at), lastSaleAt: iso(lastSale?.at),
      status: read ? 'detected' : site || unread ? 'waiting' : 'none',
      via: read ? viaOf(read.via) : null, siteSeenAt: iso(site?.at),
      unread: stuck ? { via: viaOf(unread.via), what: unread.unread, at: iso(unread.at) } : null,
    };
  }
  /** Per answered question: its clicks and attributed sale, for the question history (matched there by text, channel and time). */
  async function attributionRows(botIds) {
    const ids = [...new Set((Array.isArray(botIds) ? botIds : [botIds]).filter(Boolean).map(campaignOf))];
    const every = (await Promise.all(ids.map(eventsOf))).flat();
    const rows = new Map();
    for (const e of every) if (e.kind === 'shown') rows.set(e.cid, { at: Number(e.at), channel: e.channel, question: e.question || '', answer: e.answer || null, clicks: 0, orders: 0, total: 0, currency: null });
    for (const e of every) {
      const r = (e.kind === 'chatclick' || e.kind === 'sale') && rows.get(String(e.cid || '').slice(0, 10));
      if (!r) continue;
      if (e.kind === 'chatclick') r.clicks++;
      else if (!r.currency || r.currency === e.currency) { r.orders++; r.total = Math.round((r.total + e.total) * 100) / 100; r.currency = e.currency; }
    }
    return [...rows.values()].filter((r) => r.clicks || r.orders);
  }
  /** CSV of the clicks (CLICK_COLUMNS), newest first. */
  async function clicksCsv(botIds, o = {}) {
    const r = await attribution(botIds, o);
    return `${[csvRow(CLICK_COLUMNS), ...r.clicks.map((c) => csvRow([c.at, c.bot, c.channel, c.kind, c.title, c.price ?? '', c.currency || '', c.url, c.question, c.answer || '', c.cid, c.order || '', c.orderTotal ?? '', c.orderCurrency || '']))].join('\r\n')}\r\n`;
  }
  /** CSV of the attributed sales (SALE_COLUMNS), newest first. */
  async function salesCsv(botIds, o = {}) {
    const r = await attribution(botIds, o);
    return `${[csvRow(SALE_COLUMNS), ...r.sales.map((s) => csvRow([s.at, s.bot, s.order, s.total, s.currency, s.itemsText, s.channel, s.clickedAt || '', s.title, s.url || '', s.question, s.cid, 'reported by your site', SALE_VIA_TEXT[s.via] || SALE_VIA_TEXT.snippet]))].join('\r\n')}\r\n`;
  }

  return { lead, checkout, link, click, agent, agentDay, linkRecord, linksOf, report, csv, shown, chatClick, sale, salePing, attribution, attributionRows, clicksCsv, salesCsv, retentionDays: keepDays, persist,
    /** fn(event, extra) for every new lead (after it is recorded). → a function that removes the listener. */
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    /** { read(bot) → jsonl|null, write(bot, jsonl) }: where a bot's events are kept across restarts (set once, at start-up). */
    setDurable: (d) => { durable = d || null; },
    /** Writes every durable snapshot that is still waiting for its timer (shutdown, tests). */
    flush: async () => { await Promise.all([...bots].filter(([, st]) => st.durableTimer).map(([key]) => persist(key))); },
    idle: async () => { while (pending.size) await Promise.all([...pending]); } };
}

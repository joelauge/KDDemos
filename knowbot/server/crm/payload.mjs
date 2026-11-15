// The standard lead payload every connector maps from, and the texts they share (the note, placeholder names).
//
//   { id, createdAt, test?, bot:{id,name}, channel, channelLabel, contact:{email?,phone?,name?}, question,
//     answer?:{summary}, links:[{url,kind}], consent:{code,label}, source:{utm_source,utm_medium,utm_campaign,clickId,page},
//     note?, studioUrl }
//
// id is stable for a lead (a hash of its own fields), so a retry or a re-sync of the same lead is the same id: the
// outbox never queues it twice for one connection, webhook receivers can dedupe on it, and CRM notes carry it.
// Only leads become payloads (server/leads.mjs kind:'lead'): never a plain question. The consent label travels with it.
import { createHash } from 'node:crypto';
import { CONSENT_LABEL, UTM_SOURCE, mediumOf } from '../leads.mjs';

const CHANNEL_LABEL = { web: 'Website chat', webchat: 'Website chat', studio: 'Studio', site: 'Homepage search', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email', phone: 'Phone',
  voice: 'Web voice', webvoice: 'Web voice', api: 'Developer API', agent: 'AI agent' };
export const channelLabel = (c) => CHANNEL_LABEL[String(c || '').toLowerCase()] || String(c || 'Other');
const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The stable id of a lead event ({bot, at (ms), type, value, consent, channel, cid}). */
export function leadIdOf(ev) {
  const key = [ev.bot, Number(ev.at), ev.type, String(ev.value || '').toLowerCase(), ev.consent || '', ev.channel || '', ev.cid || ''].join('|');
  return `ld_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/**
 * A lead event (leads.mjs) → the standard payload.
 * o: { botName, links:[{url,kind}] (what was sent with it), answer (text, when known), studioUrl }
 */
export function leadPayload(ev, o = {}) {
  const at = Number(ev.at) || Date.parse(ev.at) || Date.now();
  const e = { ...ev, at };
  const links = (o.links || []).filter((l) => l && l.url).slice(0, 10).map((l) => ({ url: String(l.url), kind: String(l.kind || 'source') }));
  let utm = {};
  try { const u = links.length ? new URL(links[0].url).searchParams : null; if (u) utm = { utm_source: u.get('utm_source'), utm_medium: u.get('utm_medium'), utm_campaign: u.get('utm_campaign') }; } catch { utm = {}; }
  return {
    id: leadIdOf(e),
    createdAt: new Date(at).toISOString(),
    bot: { id: String(ev.bot), name: clip(o.botName || 'KnowBot', 80) },
    channel: String(ev.channel || 'web'),
    channelLabel: channelLabel(ev.channel),
    contact: { ...(ev.type === 'email' ? { email: String(ev.value) } : { phone: String(ev.value) }), ...(ev.name ? { name: clip(ev.name, 80) } : {}) },
    question: clip(ev.question || '', 500),
    ...(o.answer ? { answer: { summary: clip(o.answer, 400) } } : {}),
    links,
    consent: { code: String(ev.consent || ''), label: CONSENT_LABEL[ev.consent] || '' },
    source: { utm_source: utm.utm_source || (ev.cid ? UTM_SOURCE : null), utm_medium: utm.utm_medium || (ev.cid ? mediumOf(ev.channel) : null), utm_campaign: utm.utm_campaign || (ev.cid ? String(ev.bot) : null),
      clickId: ev.cid || null, page: null },
    ...(ev.note ? { note: clip(ev.note, 120) } : {}),
    studioUrl: o.studioUrl || null,
  };
}

/** A made-up lead for "Send a test lead": clearly marked, never a real person. */
export function testPayload({ botId, botName, studioUrl, now = Date.now() } = {}) {
  const p = leadPayload({ bot: botId, at: now, type: 'email', value: 'test.lead@knowbot.app', consent: 'asked_to_send', channel: 'web', cid: null, name: 'KnowBot Test Lead',
    question: 'This is a test lead from KnowBot. What are your opening hours?' }, { botName, studioUrl, answer: 'A test answer, so you can see where answers land.' });
  return { ...p, id: `ld_test_${createHash('sha256').update(`${botId}|${now}`).digest('hex').slice(0, 16)}`, test: true };
}

/** A name for CRMs that require one: the lead's own name, else the e-mail's local part, else the phone number. */
export function nameOf(lead) {
  const given = oneLine(lead.contact?.name || '');
  if (given) {
    const parts = given.split(' ');
    return { full: given, first: parts.length > 1 ? parts.slice(0, -1).join(' ') : '', last: parts[parts.length - 1], known: true };
  }
  const fallback = lead.contact?.email ? String(lead.contact.email).split('@')[0] : (lead.contact?.phone || 'Unknown');
  return { full: fallback, first: '', last: fallback, known: false };
}

/** The note / activity text every CRM gets with a lead (plain text, one fact per line). */
export function noteText(lead, { html = false } = {}) {
  const lines = [
    `${lead.test ? 'TEST lead' : 'Lead'} from ${lead.bot.name} (KnowBot) · ${lead.channelLabel} · ${lead.createdAt.replace('T', ' ').slice(0, 16)} UTC`,
    lead.question ? `Asked: ${lead.question}` : null,
    lead.answer?.summary ? `Answer: ${lead.answer.summary}` : null,
    lead.note ? `Note: ${lead.note}` : null,
    ...(lead.links || []).slice(0, 5).map((l) => `Sent (${l.kind}): ${l.url}`),
    lead.consent?.label ? `Consent: ${lead.consent.label}` : null,
    lead.source?.utm_campaign ? `Source: ${[lead.source.utm_source, lead.source.utm_medium, lead.source.utm_campaign].filter(Boolean).join(' / ')}` : null,
    lead.studioUrl ? `See it in KnowBot: ${lead.studioUrl}` : null,
    `Lead id: ${lead.id}`,
  ].filter(Boolean);
  if (!html) return lines.join('\n');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return lines.map(esc).join('<br>');
}
export const noteTitle = (lead) => clip(`${lead.test ? 'TEST: ' : ''}KnowBot lead: ${lead.question || lead.channelLabel}`, 120);

/** A contact shown in the delivery log: enough to recognise, not the whole address. */
export function maskContact(lead) {
  const e = lead.contact?.email, p = lead.contact?.phone;
  if (e) { const [u, d] = String(e).split('@'); return `${u.slice(0, 2)}…@${d || ''}`; }
  if (p) return `…${String(p).slice(-4)}`;
  return '';
}

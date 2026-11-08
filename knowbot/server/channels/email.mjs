// E-mail (SPEC 11.3): one inbound-parse webhook for three providers, POST /v1/channels/:botId/email
//
//   SendGrid Inbound Parse   multipart/form-data  (from, subject, text, html)
//   Postmark inbound         application/json     (FromFull.Email, Subject, StrippedTextReply | TextBody)
//   Mailgun routes           form / multipart     (sender, subject, stripped-text | body-plain, timestamp, token, signature)
//
// Auth: EMAIL_WEBHOOK_SECRET (as ?key=… or HTTP basic-auth password, which SendGrid/Postmark URLs can carry), or a
// valid Mailgun signature (MAILGUN_SIGNING_KEY). Neither configured → 503.
// The reply (text + HTML, footnoted citations, the quoted lines and a source list) is sent through EMAIL_REPLY_WEBHOOK
// (a JSON relay), SendGrid (SENDGRID_API_KEY) or Postmark (POSTMARK_SERVER_TOKEN) with EMAIL_FROM, and is always
// returned in the webhook response as well. Auto-replies and our own address are ignored (no mail loops).
import { timingSafeEqual } from 'node:crypto';
import { ChannelError, notConfigured, parseForm, sendJsonRes, mailgunSignature, formatEmail } from './util.mjs';

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const addr = (s) => (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(String(s || ''))?.[0] || '').toLowerCase();

/** The new text of a reply: quoted history, "On … wrote:" blocks and signatures removed. */
export function stripReply(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .{4,200}wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^\s*From:\s.+$/i.test(line) && out.length) break;
    if (/^--\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Provider payload → {from, subject, text, provider, mailgun?}. */
export async function parseInbound(raw, contentType) {
  const ct = String(contentType || '');
  if (/json/i.test(ct)) {
    let j; try { j = JSON.parse(Buffer.from(raw).toString('utf8') || '{}'); } catch { throw new ChannelError(400, 'bad_request', 'invalid JSON'); }
    const headers = Array.isArray(j.Headers) ? Object.fromEntries(j.Headers.map((h) => [String(h.Name || '').toLowerCase(), String(h.Value || '')])) : {};
    return { provider: 'postmark', from: addr(j.FromFull?.Email || j.From), subject: String(j.Subject || ''), text: String(j.StrippedTextReply || j.TextBody || ''), autoSubmitted: headers['auto-submitted'] || '' };
  }
  const f = await parseForm(raw, ct);
  if ('signature' in f && 'token' in f && 'timestamp' in f) {
    return { provider: 'mailgun', from: addr(f.sender || f.from || f.From), subject: String(f.subject || f.Subject || ''), text: String(f['stripped-text'] || f['body-plain'] || ''),
      mailgun: { timestamp: f.timestamp, token: f.token, signature: f.signature }, autoSubmitted: /auto-submitted:\s*auto-/i.test(String(f['message-headers'] || '')) ? 'auto' : '' };
  }
  return { provider: 'sendgrid', from: addr(f.from), subject: String(f.subject || ''), text: String(f.text || '') || String(f.html || '').replace(/<[^>]+>/g, ' '),
    autoSubmitted: /auto-submitted:\s*auto-/i.test(String(f.headers || '')) ? 'auto' : '' };
}

async function deliver(env, mail) {
  if (env.EMAIL_REPLY_WEBHOOK) {
    const r = await fetch(env.EMAIL_REPLY_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mail), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`reply webhook HTTP ${r.status}`);
    return 'webhook';
  }
  if (!env.EMAIL_FROM) return null;
  if (env.SENDGRID_API_KEY) {
    const base = String(env.SENDGRID_BASE_URL || 'https://api.sendgrid.com').replace(/\/+$/, '');
    const r = await fetch(`${base}/v3/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SENDGRID_API_KEY}` },
      body: JSON.stringify({ personalizations: [{ to: [{ email: mail.to }] }], from: { email: mail.from }, subject: mail.subject, content: [{ type: 'text/plain', value: mail.text }, { type: 'text/html', value: mail.html }] }),
      signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`SendGrid HTTP ${r.status}`);
    return 'sendgrid';
  }
  if (env.POSTMARK_SERVER_TOKEN) {
    const base = String(env.POSTMARK_BASE_URL || 'https://api.postmarkapp.com').replace(/\/+$/, '');
    const r = await fetch(`${base}/email`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-postmark-server-token': env.POSTMARK_SERVER_TOKEN },
      body: JSON.stringify({ From: mail.from, To: mail.to, Subject: mail.subject, TextBody: mail.text, HtmlBody: mail.html, MessageStream: 'outbound' }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Postmark HTTP ${r.status}`);
    return 'postmark';
  }
  return null;
}

export async function handleEmail(cx) {
  const { env, req, res, raw, url } = cx;
  if (!env.EMAIL_WEBHOOK_SECRET && !env.MAILGUN_SIGNING_KEY) throw notConfigured('e-mail', ['EMAIL_WEBHOOK_SECRET (or MAILGUN_SIGNING_KEY)']);
  if (req.method !== 'POST') throw new ChannelError(405, 'method_not_allowed', 'Your e-mail provider posts inbound mail to this URL.');
  const mail = await parseInbound(raw, req.headers['content-type']);

  let ok = false;
  if (env.EMAIL_WEBHOOK_SECRET) {
    const q = url.searchParams.get('key') || '';
    const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1];
    const pass = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    ok = (q && eq(q, env.EMAIL_WEBHOOK_SECRET)) || (pass && eq(pass, env.EMAIL_WEBHOOK_SECRET));
  }
  if (!ok && env.MAILGUN_SIGNING_KEY && mail.mailgun) {
    const { timestamp, token, signature } = mail.mailgun;
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 15 * 60;
    ok = fresh && eq(mailgunSignature(env.MAILGUN_SIGNING_KEY, timestamp, token), signature);
  }
  if (!ok) throw new ChannelError(403, 'bad_signature', 'This inbound-mail webhook is not authorized.');

  const own = addr(env.EMAIL_FROM);
  if (!mail.from || (own && mail.from === own) || /^(?:mailer-daemon|postmaster|no-?reply)@/i.test(mail.from) || mail.autoSubmitted || /^(?:auto(?:matic)? reply|out of office)/i.test(mail.subject)) {
    return sendJsonRes(res, 200, { ok: true, ignored: true });
  }
  const body = stripReply(mail.text);
  const subject = mail.subject.replace(/^\s*(?:re|fwd?|aw):\s*/gi, '').trim();
  const question = (body || subject).replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!question) return sendJsonRes(res, 200, { ok: true, ignored: true, reason: 'empty' });
  if (cx.limited(`email|${mail.from}`)) return sendJsonRes(res, 429, { error: { code: 'rate_limited', message: 'Too many messages from this sender.' } }, { 'retry-after': '60' });

  const r = await cx.ask(question, { channel: 'email', callerKey: mail.from });
  const { text, html } = formatEmail(r, { proofUrl: r.refused ? null : r.proofUrl, botName: cx.botName || 'KnowBot', question });
  const reply = { to: mail.from, from: env.EMAIL_FROM || null, subject: `Re: ${subject || 'your question'}`, text, html };
  let delivered = null;
  try { delivered = await deliver(env, reply); } catch (e) { cx.log(`[channels] email reply failed: ${e.message}`); }
  return sendJsonRes(res, 200, { ok: true, provider: mail.provider, delivered: !!delivered, via: delivered, reply: { subject: reply.subject, text, html }, refused: r.refused, citations: r.citations });
}

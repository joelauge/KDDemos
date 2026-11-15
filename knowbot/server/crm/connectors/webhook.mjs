// Webhook connector: POST each lead as JSON to an https URL the owner gives us, signed with a shared secret.
// This is also the instant way into Zapier ("Webhooks by Zapier" → Catch Hook), Make ("Custom webhook") and n8n
// ("Webhook" node): paste their URL here.
//
// Request:  POST <url>
//   content-type: application/json
//   user-agent: KnowBot-Webhooks/1
//   x-knowbot-event: lead.created | lead.test
//   x-knowbot-delivery: <lead id>            (stable for a lead: dedupe on it; retries repeat it)
//   x-knowbot-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the shared secret>
// Body: the standard lead payload (server/crm/payload.mjs) plus { event }.
// A 2xx answer is success. 408/425/429/5xx and network errors are retried; any other answer is final.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CrmError, retryAfterMs } from '../http.mjs';
import { checkHookUrl, safeRequest } from '../safefetch.mjs';

export const SIGNATURE_HEADER = 'x-knowbot-signature';
/** The signature header value for a body, at time t (unix seconds). */
export function sign(secret, body, t) {
  return `t=${t},v1=${createHmac('sha256', String(secret)).update(`${t}.${body}`).digest('hex')}`;
}
/** For receivers (and our tests): true when the header matches the body and is at most `toleranceS` old. */
export function verifySignature(secret, body, header, { now = Date.now(), toleranceS = 300 } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m || Math.abs(now / 1000 - Number(m[1])) > toleranceS) return false;
  const want = Buffer.from(sign(secret, body, m[1])), got = Buffer.from(String(header));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** POSTs a lead to a URL (shared by the webhook connector and Zapier REST hooks). → { action: 'sent' } */
export async function postLead(ctx, url, lead, { secret = null, name = 'Your webhook' } = {}) {
  const body = JSON.stringify({ event: lead.test ? 'lead.test' : 'lead.created', ...lead });
  const t = Math.floor(ctx.now() / 1000);
  const r = await safeRequest(url, { net: ctx.net, body, headers: { 'content-type': 'application/json', 'user-agent': 'KnowBot-Webhooks/1', accept: '*/*',
    'x-knowbot-event': lead.test ? 'lead.test' : 'lead.created', 'x-knowbot-delivery': lead.id, ...(secret ? { [SIGNATURE_HEADER]: sign(secret, body, t) } : {}) } });
  if (r.status >= 200 && r.status < 300) return { action: 'sent' };
  if (r.status === 410) throw new CrmError('gone', `${name} no longer accepts leads (it answered 410 Gone).`, { status: 410, action: 'Connect it again with its current address.' });
  if (r.status === 429) throw new CrmError('rate_limited', `${name} is receiving too many requests right now.`, { status: 429, retryAfterMs: retryAfterMs(r.headers['retry-after'], ctx.now()) });
  if (r.status === 408 || r.status === 425 || r.status >= 500) throw new CrmError('upstream', `${name} had a problem on its side (${r.status}).`, { status: r.status });
  throw new CrmError('invalid', `${name} answered ${r.status} instead of accepting the lead.`, { status: r.status, action: 'Check that the address is right and still switched on.' });
}

export default {
  id: 'webhook',
  name: 'Webhook',
  blurb: 'Send every new lead to any https address as JSON. Works today with Zapier, Make and n8n.',
  auth: { url: { label: 'Webhook address', placeholder: 'https://hooks.example.com/…', help: 'Paste the https address that should receive your leads.' } },
  fields: [],
  async connect(ctx, input) {
    const u = checkHookUrl(input?.url, ctx.net);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    // shown to the owner once (reveal), kept sealed; the address itself can carry a token, so it is sealed too
    return { secrets: { url: u.toString(), secret }, account: u.host, hint: null, reveal: { secret, header: 'X-KnowBot-Signature' } };
  },
  async verify(ctx) { const u = checkHookUrl(ctx.secrets.url, ctx.net); return { account: u.host }; },
  async deliver(ctx, lead) { return postLead(ctx, ctx.secrets.url, lead, { secret: ctx.secrets.secret }); },
};

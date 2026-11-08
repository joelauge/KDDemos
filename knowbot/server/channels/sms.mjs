// SMS over Twilio Messaging (SPEC 11.3). Webhook: POST /v1/channels/:botId/sms (application/x-www-form-urlencoded).
// Reply: TwiML <Message>, at most 320 characters, [n] citation markers plus a short proof link (/p/<id>).
// Needs TWILIO_AUTH_TOKEN (every request's X-Twilio-Signature is checked); without it the route answers 503.
import { ChannelError, notConfigured, parseForm, twilioValid, sendXml, xml, formatSms } from './util.mjs';

export const SMS_MAX = 320;

/** @param {object} cx channel context from devapi.mjs (env, req, res, raw, ask, limited) */
export async function handleSms(cx) {
  const { env, req, res, raw } = cx;
  if (!env.TWILIO_AUTH_TOKEN) throw notConfigured('SMS', ['TWILIO_AUTH_TOKEN']);
  if (req.method !== 'POST') throw new ChannelError(405, 'method_not_allowed', 'Twilio posts messages to this URL.');
  const params = await parseForm(raw, req.headers['content-type']);
  if (!twilioValid(req, env.TWILIO_AUTH_TOKEN, params, env)) throw new ChannelError(403, 'bad_signature', 'X-Twilio-Signature did not verify.');
  const from = String(params.From || '');
  const body = String(params.Body || '').trim();
  if (!body) return sendXml(res, `<Message>${xml('Text me a question and I will answer from my files, with sources.')}</Message>`);
  if (cx.limited(`sms|${from}`)) return sendXml(res, `<Message>${xml('You are sending questions very quickly. Try again in a minute.')}</Message>`);
  const r = await cx.ask(body, { channel: 'sms', callerKey: from });
  return sendXml(res, `<Message>${xml(formatSms(r, r.refused ? null : r.proofUrl, SMS_MAX))}</Message>`);
}

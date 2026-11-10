// SMS over Twilio Messaging (SPEC 11.3). Webhook: POST /v1/channels/:botId/sms (application/x-www-form-urlencoded).
// Reply: TwiML <Message>, at most 320 characters, [n] citation markers plus a short proof link (/p/<id>).
// Needs TWILIO_AUTH_TOKEN (every request's X-Twilio-Signature is checked); without it the route answers 503.
// A bot on its own KnowBot number (cx.meter, server/numbers.mjs) pays per text segment, in and out, from its prepaid
// credit; with no credit left the text gets no reply (nothing is sent).
import { ChannelError, notConfigured, parseForm, twilioValid, sendXml, xml, formatSms, smsInfo } from './util.mjs';

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
  const meter = cx.meter || null;
  if (meter && !meter.ok()) {
    cx.log?.(`[channels] sms: bot ${cx.botId} is out of credit; no reply sent`);
    return sendXml(res, '');
  }
  const reply = (text) => {
    if (meter) meter.charge('text', Math.max(1, smsInfo(body).segments) + Math.max(1, smsInfo(text).segments), 'sms').catch((e) => cx.log?.(`[channels] sms: credit not recorded: ${e.message}`));
    return sendXml(res, `<Message>${xml(text)}</Message>`);
  };
  if (!body) return reply('Text me a question and I will answer from my files, with sources.');
  if (cx.limited(`sms|${from}`)) return reply('You are sending questions very quickly. Try again in a minute.');
  const r = await cx.ask(body, { channel: 'sms', callerKey: from });
  return reply(formatSms(r, r.refused ? null : r.proofUrl, SMS_MAX));
}

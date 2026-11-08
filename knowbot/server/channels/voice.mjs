// Telephone over Twilio Voice (SPEC 11.3): the Phone channel of any KnowBot (a Studio trial bot or a launched bot).
//
//   POST /v1/channels/:botId/voice            incoming call (signed) → <Connect><Stream> to the media WebSocket with a
//                                              one-time token bound to this call and bot
//   GET  /v1/channels/:botId/voice/media      (WebSocket upgrade) Twilio Media Streams ⇄ Gemini Live voice-to-voice
//                                              (voice-live.mjs; routed from server.mjs's 'upgrade' listener)
//
// Phone calls are Gemini Live voice-to-voice only (there is no speech-recognition / text-to-speech answering loop). Without
// GEMINI_API_KEY the webhook answers with a short, polite <Say> that the phone line isn't set up yet, then <Hangup/>.
// Every answer comes from the bot's own answer pipeline (its sources, the librarian voice, citations) and is spoken with
// attribution ("According to the Returns Policy, you can …"); every question is logged to the questions loop with channel
// 'phone'. Needs TWILIO_AUTH_TOKEN (signature-checked); without it the route answers 503.
// Settings (names only): TWILIO_AUTH_TOKEN, GEMINI_API_KEY; TWILIO_VOICE and KNOWBOT_VOICE_LANGUAGE for the <Say> lines.
import { ChannelError, notConfigured, parseForm, twilioValid, sendXml, xml } from './util.mjs';
import { issueStreamToken, geminiSettings } from './voice-live.mjs';

/** 'gemini' (voice-to-voice) when GEMINI_API_KEY is set, else 'not_configured'. */
export function phoneEngine(env = {}) {
  return geminiSettings(env).apiKey ? 'gemini' : 'not_configured';
}

export const PHONE_NOT_SET_UP = "Sorry, this phone line isn't set up yet. Please try again later. Goodbye.";

export async function handleVoice(cx) {
  const { env, req, res, raw, sub = '' } = cx;
  if (!env.TWILIO_AUTH_TOKEN) throw notConfigured('telephone', ['TWILIO_AUTH_TOKEN']);
  if (sub === 'media') throw new ChannelError(426, 'upgrade_required', 'This is the media stream WebSocket: connect with an Upgrade: websocket request.');
  if (sub) throw new ChannelError(404, 'not_found', 'No such voice step.');
  if (req.method !== 'POST') throw new ChannelError(405, 'method_not_allowed', 'Twilio posts calls to this URL.');
  const params = await parseForm(raw, req.headers['content-type']);
  if (!twilioValid(req, env.TWILIO_AUTH_TOKEN, params, env)) throw new ChannelError(403, 'bad_signature', 'X-Twilio-Signature did not verify.');

  const lang = env.KNOWBOT_VOICE_LANGUAGE || 'en-US';
  const sayVoice = env.TWILIO_VOICE || 'Polly.Joanna-Neural';
  const say = (text) => `<Say voice="${xml(sayVoice)}" language="${xml(lang)}">${xml(text)}</Say>`;
  const self = `${cx.base}/v1/channels/${encodeURIComponent(cx.botId)}/voice`;
  const caller = String(params.From || params.Caller || '');
  const callSid = String(params.CallSid || '');

  if (phoneEngine(env) !== 'gemini') {
    cx.log(`[channels] voice: call on bot ${cx.botId} declined: the phone line is not set up (GEMINI_API_KEY)`);
    return sendXml(res, `${say(PHONE_NOT_SET_UP)}<Hangup/>`);
  }
  if (!callSid) return sendXml(res, `${say("Sorry, this call couldn't be connected. Please try again. Goodbye.")}<Hangup/>`);
  // a caller redialling fast gets no stream token (each call holds a Gemini Live session)
  if (cx.limited(`voice|${caller}`)) {
    cx.log(`[channels] voice: caller rate-limited on bot ${cx.botId}; no stream token`);
    return sendXml(res, `${say('This line is busy right now. Please call back in a minute.')}<Hangup/>`);
  }
  // voice-to-voice: hand the call's audio to the media WebSocket; the one-time token binds it to this call and bot, and
  // carries the caller's number from this signed request (never from the stream)
  const ws = `${self.replace(/^http/, 'ws')}/media`;
  const token = issueStreamToken({ callSid, botId: cx.botId, from: caller });
  return sendXml(res, `<Connect><Stream url="${xml(ws)}"><Parameter name="token" value="${xml(token)}"/></Stream></Connect>`);
}

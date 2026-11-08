// Telephone over Twilio Voice (SPEC 11.3): the Phone channel of any KnowBot (a Studio trial bot or a launched bot).
//
//   POST /v1/channels/:botId/voice            incoming call → engine 'gemini': <Connect><Stream> to the media WebSocket;
//                                              engine 'classic': greeting + listen
//   GET  /v1/channels/:botId/voice/media      (WebSocket upgrade, engine 'gemini') Twilio Media Streams ⇄ Gemini Live
//                                              (voice-live.mjs; routed from server.mjs's 'upgrade' listener)
//   POST /v1/channels/:botId/voice/answer     Twilio's speech result (SpeechResult) → spoken answer + listen again
//   POST /v1/channels/:botId/voice/recording  (Google STT mode) a <Record>ed clip → Google speech-to-text → answer
//   GET  /v1/channels/:botId/voice/audio/:id  (ElevenLabs / Google TTS) the synthesized MP3 Twilio <Play>s
//
// Engine (per server, for every bot): 'gemini' (voice-to-voice) when GEMINI_API_KEY is set, else 'classic'. KNOWBOT_PHONE_ENGINE
// = classic forces the classic loop. A first POST that already carries SpeechResult is answered by the classic path on either.
// Classic recognition: Google Cloud Speech-to-Text when GOOGLE_STT_* (plus TWILIO_ACCOUNT_SID, to fetch the recording) is set,
// else Twilio's built-in speech recognition. Classic synthesis: ElevenLabs when ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID are
// set, else Google Cloud Text-to-Speech when GOOGLE_TTS_* is set, else <Say>.
// Every answer comes from the bot's own answer pipeline (its sources, the librarian voice, citations) and is spoken with
// attribution ("According to the Returns Policy, you can …"); a refusal is the canonical sentence. Every question is logged
// to the questions loop with channel 'phone'. Needs TWILIO_AUTH_TOKEN (signature-checked); without it the route answers 503.
import { ChannelError, notConfigured, parseForm, twilioValid, sendXml, xml, formatSpoken } from './util.mjs';
import { googleConfig, transcribe, synthesize } from './google.mjs';
import { issueStreamToken, geminiSettings } from './voice-live.mjs';

/** 'gemini' (voice-to-voice) when GEMINI_API_KEY is set, else 'classic'. */
export function phoneEngine(env = {}) {
  if (String(env.KNOWBOT_PHONE_ENGINE || '').toLowerCase() === 'classic') return 'classic';
  return geminiSettings(env).apiKey ? 'gemini' : 'classic';
}
export const elevenLabsReady = (env = {}) => !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);

/** ElevenLabs text-to-speech → { audio: Buffer (MP3), mime }. ELEVENLABS_BASE_URL is for tests and proxies. */
export async function elevenLabsSpeech(text, env = {}) {
  const base = String(env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const u = new URL(`${base}/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}`);
  u.searchParams.set('output_format', env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_22050_32');
  const r = await fetch(u, { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true } }),
    signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`ElevenLabs HTTP ${r.status}`);
  return { audio: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg' };
}

const MAX_EMPTY = 2;

export async function handleVoice(cx) {
  const { env, req, res, raw, sub = '' } = cx;
  if (!env.TWILIO_AUTH_TOKEN) throw notConfigured('telephone', ['TWILIO_AUTH_TOKEN']);
  const audioId = /^audio\/([A-Za-z0-9_-]{8,40})(?:\.mp3)?$/.exec(sub)?.[1];
  if (audioId) {
    // Twilio fetches <Play> URLs with GET; the id is random and short-lived, so no signature is required here.
    const a = cx.audio.get(audioId);
    if (!a) throw new ChannelError(404, 'not_found', 'That audio has expired.');
    res.writeHead(200, { 'content-type': a.mime, 'content-length': a.audio.length, 'cache-control': 'private, max-age=600' });
    return res.end(a.audio);
  }
  if (sub === 'media') throw new ChannelError(426, 'upgrade_required', 'This is the media stream WebSocket: connect with an Upgrade: websocket request.');
  if (req.method !== 'POST') throw new ChannelError(405, 'method_not_allowed', 'Twilio posts calls to this URL.');
  const params = await parseForm(raw, req.headers['content-type']);
  if (!twilioValid(req, env.TWILIO_AUTH_TOKEN, params, env)) throw new ChannelError(403, 'bad_signature', 'X-Twilio-Signature did not verify.');

  const g = googleConfig(env);
  const googleStt = g.stt && !!env.TWILIO_ACCOUNT_SID;
  const lang = env.KNOWBOT_VOICE_LANGUAGE || g.language || 'en-US';
  const sayVoice = env.TWILIO_VOICE || 'Polly.Joanna-Neural';
  const self = `${cx.base}/v1/channels/${encodeURIComponent(cx.botId)}/voice`;
  const empty = Math.max(0, Number(cx.url.searchParams.get('empty')) || 0);

  /** <Play> (ElevenLabs, else Google TTS) or <Say>. */
  const speak = async (text) => {
    if (elevenLabsReady(env)) {
      try {
        const out = await elevenLabsSpeech(text, env);
        return `<Play>${xml(`${self}/audio/${cx.audio.put(out.audio, out.mime)}.mp3`)}</Play>`;
      } catch (e) { cx.log(`[channels] voice: ElevenLabs failed (${e.message}); trying the next voice`); }
    }
    if (g.tts) {
      try {
        const out = await synthesize(text, { env, language: lang });
        return `<Play>${xml(`${self}/audio/${cx.audio.put(out.audio, out.mime)}.mp3`)}</Play>`;
      } catch (e) { cx.log(`[channels] voice: Google TTS failed (${e.message}); using <Say>`); }
    }
    return `<Say voice="${xml(sayVoice)}" language="${xml(lang)}">${xml(text)}</Say>`;
  };
  /** Listen for the next question: Google STT records a clip, Twilio recognizes speech itself. */
  const listen = (prompt, n = 0) => (googleStt
    ? `${prompt}<Record action="${xml(`${self}/recording?empty=${n}`)}" method="POST" maxLength="20" timeout="3" playBeep="false" trim="trim-silence"/>`
    : `<Gather input="speech" action="${xml(`${self}/answer?empty=${n}`)}" method="POST" speechTimeout="auto" language="${xml(lang)}" actionOnEmptyResult="true">${prompt}</Gather>`)
    + `<Redirect method="POST">${xml(`${self}/answer?empty=${n + 1}`)}</Redirect>`;

  const caller = String(params.From || params.Caller || '');
  const reply = async (question) => {
    if (cx.limited(`voice|${caller}`)) return sendXml(res, `${await speak('You are asking very quickly. Please call back in a minute.')}<Hangup/>`);
    const r = await cx.ask(question, { channel: 'phone', callerKey: caller });
    return sendXml(res, listen(`${await speak(formatSpoken(r, 450, { names: [cx.botName, cx.org] }))}<Pause length="1"/>${await speak('Anything else?')}`));
  };
  const nothing = async () => {
    if (empty >= MAX_EMPTY) return sendXml(res, `${await speak('Thanks for calling. Goodbye.')}<Hangup/>`);
    return sendXml(res, listen(await speak("Sorry, I didn't catch that. What would you like to know?"), empty + 1));
  };

  if (!sub) {
    // A first POST that already carries speech (a re-pointed <Gather> action, a test harness, a call transfer) is answered,
    // never met with the greeting while the question is silently logged.
    const heard = String(params.SpeechResult || '').trim();
    if (heard) return reply(heard);
    if (phoneEngine(env) === 'gemini') {
      // voice-to-voice: hand the call's audio to the media WebSocket; the one-time token binds it to this call and bot
      const callSid = String(params.CallSid || '');
      if (callSid) {
        const ws = `${self.replace(/^http/, 'ws')}/media`;
        const token = issueStreamToken({ callSid, botId: cx.botId, from: caller });
        return sendXml(res, `<Connect><Stream url="${xml(ws)}"><Parameter name="token" value="${xml(token)}"/></Stream></Connect>`);
      }
    }
    const name = cx.botName ? `${cx.botName}. ` : '';
    return sendXml(res, listen(await speak(`Hi, you've reached ${name}I answer from my files and tell you where each answer comes from. What would you like to know?`)));
  }
  if (sub === 'answer') {
    const q = String(params.SpeechResult || '').trim();
    return q ? reply(q) : nothing();
  }
  if (sub === 'recording') {
    const recUrl = String(params.RecordingUrl || '');
    if (!googleStt || !recUrl) return nothing();
    // Only Twilio-hosted recordings (or the configured fake in tests) are fetched with the account credentials.
    const allowed = String(env.TWILIO_API_BASE_URL || 'https://api.twilio.com').replace(/\/+$/, '');
    if (!recUrl.startsWith(`${allowed}/`)) return nothing();
    let transcript = '';
    try {
      const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const ar = await fetch(`${recUrl}.wav`, { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10000) });
      if (!ar.ok) throw new Error(`recording HTTP ${ar.status}`);
      const buf = Buffer.from(await ar.arrayBuffer());
      transcript = (await transcribe(buf, { env, mime: 'audio/wav', language: lang })).transcript;
    } catch (e) { cx.log(`[channels] voice: recognition failed (${e.message})`); }
    return transcript ? reply(transcript) : nothing();
  }
  throw new ChannelError(404, 'not_found', 'No such voice step.');
}

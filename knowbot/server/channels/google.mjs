// Thin Google Cloud Speech-to-Text / Text-to-Speech REST client (SPEC 11.3). No SDK, no service-account JWT signing:
// auth is an API key (?key=) or a ready OAuth access token (Authorization: Bearer). Hosts are overridable so tests run
// against a fake; nothing here is called unless the matching env is set.
//
//   GOOGLE_STT_API_KEY | GOOGLE_API_KEY | GOOGLE_ACCESS_TOKEN   enables speech-to-text
//   GOOGLE_TTS_API_KEY | GOOGLE_API_KEY | GOOGLE_ACCESS_TOKEN   enables text-to-speech
//   GOOGLE_STT_LANGUAGE (en-US)  GOOGLE_STT_MODEL (latest_short)  GOOGLE_STT_BASE_URL (https://speech.googleapis.com)
//   GOOGLE_TTS_VOICE (en-US-Neural2-F)  GOOGLE_TTS_LANGUAGE (en-US)  GOOGLE_TTS_BASE_URL (https://texttospeech.googleapis.com)

export class GoogleSpeechError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** What is configured (never the secrets themselves). */
export function googleConfig(env = {}) {
  const sttKey = env.GOOGLE_STT_API_KEY || env.GOOGLE_API_KEY || '';
  const ttsKey = env.GOOGLE_TTS_API_KEY || env.GOOGLE_API_KEY || '';
  const token = env.GOOGLE_ACCESS_TOKEN || '';
  return {
    stt: !!(sttKey || token), tts: !!(ttsKey || token),
    sttKey, ttsKey, token,
    sttBase: String(env.GOOGLE_STT_BASE_URL || 'https://speech.googleapis.com').replace(/\/+$/, ''),
    ttsBase: String(env.GOOGLE_TTS_BASE_URL || 'https://texttospeech.googleapis.com').replace(/\/+$/, ''),
    language: env.GOOGLE_STT_LANGUAGE || 'en-US',
    model: env.GOOGLE_STT_MODEL || 'latest_short',
    voice: env.GOOGLE_TTS_VOICE || 'en-US-Neural2-F',
    ttsLanguage: env.GOOGLE_TTS_LANGUAGE || env.GOOGLE_STT_LANGUAGE || 'en-US',
  };
}

/** Recognition config for a clip, from its MIME type (and WAV header when there is one). */
export function encodingFor(mime = '', buf = null) {
  const m = String(mime).toLowerCase();
  if (/webm/.test(m)) return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  if (/ogg/.test(m)) return { encoding: 'OGG_OPUS', sampleRateHertz: 48000 };
  if (/mpeg|mp3/.test(m)) return { encoding: 'MP3', sampleRateHertz: 16000, beta: true };
  if (/flac/.test(m)) return { encoding: 'FLAC' };
  if (/basic|mulaw|x-mulaw/.test(m)) return { encoding: 'MULAW', sampleRateHertz: 8000 };
  if (/wav|wave|l16|pcm/.test(m) || (buf && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF')) {
    // WAV header: sample rate at byte 24, format at 20 (1 = PCM, 7 = mu-law)
    let rate = 8000, fmt = 1;
    if (buf && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') { rate = buf.readUInt32LE(24) || 8000; fmt = buf.readUInt16LE(20); }
    return { encoding: fmt === 7 ? 'MULAW' : 'LINEAR16', sampleRateHertz: rate };
  }
  return { encoding: 'ENCODING_UNSPECIFIED' };
}

function authed(cfg, key, url) {
  const u = new URL(url);
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  else if (key) u.searchParams.set('key', key);
  return { url: u.toString(), headers };
}

/**
 * Speech → text.
 * @param {Buffer|Uint8Array} audio
 * @param {{ env?: object, mime?: string, language?: string, timeoutMs?: number, hints?: string[] }} [opts]
 * @returns {Promise<{ transcript: string, confidence: number|null, language: string }>}
 */
export async function transcribe(audio, opts = {}) {
  const cfg = googleConfig(opts.env || {});
  if (!cfg.stt) throw new GoogleSpeechError(503, 'Google speech-to-text is not configured (set GOOGLE_STT_API_KEY)');
  const buf = Buffer.from(audio || []);
  if (!buf.length) throw new GoogleSpeechError(400, 'no audio');
  if (buf.length > 10 * 1024 * 1024) throw new GoogleSpeechError(413, 'audio clip too long for synchronous recognition');
  const enc = encodingFor(opts.mime, buf);
  const language = opts.language || cfg.language;
  const config = { languageCode: language, enableAutomaticPunctuation: true, model: cfg.model, encoding: enc.encoding,
    ...(enc.sampleRateHertz ? { sampleRateHertz: enc.sampleRateHertz } : {}),
    ...(Array.isArray(opts.hints) && opts.hints.length ? { speechContexts: [{ phrases: opts.hints.slice(0, 50).map((h) => String(h).slice(0, 100)) }] } : {}) };
  const { url, headers } = authed(cfg, cfg.sttKey, `${cfg.sttBase}/${enc.beta ? 'v1p1beta1' : 'v1'}/speech:recognize`);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ config, audio: { content: buf.toString('base64') } }), signal: AbortSignal.timeout(opts.timeoutMs || 15000) });
  } catch (e) { throw new GoogleSpeechError(502, `Google speech-to-text unreachable: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleSpeechError(502, `Google speech-to-text HTTP ${res.status}: ${String(j?.error?.message || '').slice(0, 200)}`);
  const alts = (j.results || []).map((r) => r?.alternatives?.[0]).filter(Boolean);
  const transcript = alts.map((a) => String(a.transcript || '').trim()).filter(Boolean).join(' ').trim();
  const confidence = alts.length && typeof alts[0].confidence === 'number' ? alts[0].confidence : null;
  return { transcript, confidence, language };
}

/**
 * Text → speech (MP3 by default).
 * @param {string} text
 * @param {{ env?: object, voice?: string, language?: string, encoding?: 'MP3'|'OGG_OPUS'|'LINEAR16'|'MULAW', rate?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ audio: Buffer, mime: string }>}
 */
export async function synthesize(text, opts = {}) {
  const cfg = googleConfig(opts.env || {});
  if (!cfg.tts) throw new GoogleSpeechError(503, 'Google text-to-speech is not configured (set GOOGLE_TTS_API_KEY)');
  const t = String(text || '').trim().slice(0, 4800);
  if (!t) throw new GoogleSpeechError(400, 'no text');
  const encoding = opts.encoding || 'MP3';
  const { url, headers } = authed(cfg, cfg.ttsKey, `${cfg.ttsBase}/v1/text:synthesize`);
  const body = { input: { text: t }, voice: { languageCode: opts.language || cfg.ttsLanguage, name: opts.voice || cfg.voice },
    audioConfig: { audioEncoding: encoding, ...(opts.rate ? { speakingRate: opts.rate } : {}), ...(encoding === 'MULAW' ? { sampleRateHertz: 8000 } : {}) } };
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs || 15000) }); }
  catch (e) { throw new GoogleSpeechError(502, `Google text-to-speech unreachable: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || typeof j.audioContent !== 'string') throw new GoogleSpeechError(502, `Google text-to-speech HTTP ${res.status}: ${String(j?.error?.message || 'no audio').slice(0, 200)}`);
  const mime = { MP3: 'audio/mpeg', OGG_OPUS: 'audio/ogg', LINEAR16: 'audio/wav', MULAW: 'audio/basic' }[encoding] || 'audio/mpeg';
  return { audio: Buffer.from(j.audioContent, 'base64'), mime };
}

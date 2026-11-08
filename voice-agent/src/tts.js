import { config } from "./config.js";

/**
 * Start an ElevenLabs streaming TTS request and return the fetch Response.
 * The body is audio (MP3 by default) that can be piped straight to Twilio
 * while it is still being generated.
 */
export async function streamSpeech(text) {
  const { apiKey, voiceId, modelId, outputFormat } = config.elevenlabs;
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
  url.searchParams.set("output_format", outputFormat);

  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${body.slice(0, 200)}`);
  }
  console.log(`[elevenlabs] first byte in ${Date.now() - started}ms (${text.length} chars)`);
  return res;
}

/** Synthesize `text` fully into a Buffer (used for cached prompts and the CLI). */
export async function synthesize(text) {
  const res = await streamSpeech(text);
  return Buffer.from(await res.arrayBuffer());
}

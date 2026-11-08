// Audio conversion between Twilio Media Streams (8 kHz G.711 μ-law) and the
// Gemini Live API (16-bit little-endian PCM: 16 kHz in, 24 kHz out).

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

// μ-law byte -> 16-bit sample, precomputed.
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  MULAW_DECODE[i] = u & 0x80 ? -magnitude : magnitude;
}

function encodeSample(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = Math.min(sign ? -sample : sample, MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Twilio inbound media (base64 μ-law, 8 kHz) -> base64 PCM16 at 16 kHz.
 * Upsamples 2x by linear interpolation.
 */
export function twilioToGemini(base64Mulaw) {
  const mulaw = Buffer.from(base64Mulaw, "base64");
  const out = Buffer.alloc(mulaw.length * 4); // 2x samples, 2 bytes each
  for (let i = 0; i < mulaw.length; i++) {
    const a = MULAW_DECODE[mulaw[i]];
    const b = i + 1 < mulaw.length ? MULAW_DECODE[mulaw[i + 1]] : a;
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE((a + b) >> 1, i * 4 + 2);
  }
  return out.toString("base64");
}

/**
 * Gemini output (base64 PCM16, 24 kHz) -> base64 μ-law at 8 kHz for Twilio.
 * Downsamples 3x by averaging each group of three samples (a cheap low-pass).
 * `carry` holds leftover samples between chunks so no audio is dropped.
 */
export function createGeminiToTwilio() {
  let carry = new Int16Array(0);
  return function convert(base64Pcm) {
    const bytes = Buffer.from(base64Pcm, "base64");
    const incoming = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
    const samples = new Int16Array(carry.length + incoming.length);
    samples.set(carry);
    samples.set(incoming, carry.length);

    const frames = Math.floor(samples.length / 3);
    const out = Buffer.alloc(frames);
    for (let i = 0; i < frames; i++) {
      const j = i * 3;
      out[i] = encodeSample(Math.round((samples[j] + samples[j + 1] + samples[j + 2]) / 3));
    }
    carry = samples.slice(frames * 3);
    return out.toString("base64");
  };
}

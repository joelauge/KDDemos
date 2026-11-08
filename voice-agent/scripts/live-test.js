// Phone-free test of the Gemini Live setup: opens a session with the same
// system instruction and tools as a real call, sends questions as text, runs
// the KnowDrive tool calls, and prints what the agent would say (from the
// output transcription) with timings. Writes the first answer's audio to
// live-answer.wav so you can hear the voice.
//
//   npm run live-test
//   npm run live-test -- "Is the magnetic dice tray in stock?" "How much is it?"

import { writeFileSync } from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { config } from "../src/config.js";
import { searchKnowDrive } from "../src/knowdrive.js";
import { SYSTEM_INSTRUCTION, TOOLS } from "../src/gemini-live.js";

const questions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["What is your return policy?", "How much is the Ultimate Bundle?", "Is the magnetic dice tray in stock?"];

if (!config.gemini.apiKey) {
  console.error("Set GEMINI_API_KEY in .env first.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey, httpOptions: { apiVersion: "v1beta" } });
let resolveTurn;
let transcript = "";
let audioChunks = [];
let firstAudioAt = 0;
let session;
// A turn that calls a tool ends (turnComplete) before the answer is spoken;
// the answer arrives in a following turn once the tool response is sent.
let toolPending = false;
let answeredAfterTool = true;

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function onmessage(msg) {
  if (msg.toolCall?.functionCalls?.length) {
    toolPending = true;
    answeredAfterTool = false;
    const functionResponses = [];
    for (const call of msg.toolCall.functionCalls) {
      console.log(`  tool  ${call.name}(${JSON.stringify(call.args || {})})`);
      let response = { status: "ok" };
      if (call.name === "search_knowledge_base") {
        const passages = await searchKnowDrive(String(call.args?.query || ""));
        for (const p of passages) console.log(`        • ${p.uri}`);
        response = passages.length
          ? { status: "ok", passages: passages.map((p) => ({ source: p.uri, text: p.text })) }
          : { status: "no_results", reason: "Nothing in the knowledge base matches this question." };
      }
      functionResponses.push({ id: call.id, name: call.name, response });
    }
    session.sendToolResponse({ functionResponses });
    toolPending = false;
    return;
  }
  const c = msg.serverContent;
  if (!c) return;
  if (c.outputTranscription?.text) transcript += c.outputTranscription.text;
  for (const part of c.modelTurn?.parts || []) {
    if (part.inlineData?.data) {
      if (!firstAudioAt) firstAudioAt = Date.now();
      if (!toolPending) answeredAfterTool = true;
      audioChunks.push(Buffer.from(part.inlineData.data, "base64"));
    }
  }
  if (c.turnComplete && !toolPending && answeredAfterTool) resolveTurn?.();
}

async function ask(text, label) {
  transcript = "";
  audioChunks = [];
  firstAudioAt = 0;
  answeredAfterTool = true;
  const started = Date.now();
  const done = new Promise((r) => (resolveTurn = r));
  session.sendRealtimeInput({ text });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 30000))]);
  console.log(`  agent "${transcript.trim()}"`);
  console.log(`        first audio ${firstAudioAt ? firstAudioAt - started : "?"}ms, turn ${Date.now() - started}ms\n`);
  return Buffer.concat(audioChunks);
}

const t0 = Date.now();
session = await ai.live.connect({
  model: config.gemini.model,
  config: {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.gemini.voice } } },
    systemInstruction: SYSTEM_INSTRUCTION,
    tools: TOOLS,
    outputAudioTranscription: {},
  },
  callbacks: {
    onmessage: (m) => onmessage(m).catch((e) => console.error("handler error:", e.message)),
    onerror: (e) => console.error("gemini error:", e?.message || e),
    onclose: (e) => e?.code !== 1000 && e?.reason && console.error(`session closed: ${e.code} ${e.reason}`),
  },
});
console.log(`Session open in ${Date.now() - t0}ms (${config.gemini.model}, voice ${config.gemini.voice})\n`);

console.log("> [call connected]");
await ask("[call connected]");
let saved = false;
for (const q of questions) {
  console.log(`> ${q}`);
  const audio = await ask(q);
  if (!saved && audio.length) {
    writeFileSync("live-answer.wav", wav(audio));
    saved = true;
  }
}
if (saved) console.log("Wrote live-answer.wav (first answer)");
session.close();
process.exit(0);

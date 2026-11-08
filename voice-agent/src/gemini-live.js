// Voice-to-voice call handling: Twilio Media Streams <-> Gemini Live.
//
// Twilio streams the caller's audio over a WebSocket. It is forwarded to a
// Gemini Live session, which listens, decides when the caller has finished,
// and speaks back in its own voice: no separate speech-to-text or TTS step.
// Answers stay grounded because the model must call `search_knowledge_base`
// (KnowDrive) before answering, and may answer only from what it returns.

import { GoogleGenAI, Modality } from "@google/genai";
import twilio from "twilio";
import { config } from "./config.js";
import { searchKnowDrive } from "./knowdrive.js";
import { twilioToGemini, createGeminiToTwilio } from "./audio.js";

const { agentName, orgName, greeting } = config.persona;

export const SYSTEM_INSTRUCTION = `You are ${agentName}, the phone agent for ${orgName}, speaking with a caller on a live phone call.

Grounding rules:
- Before answering any question about ${orgName}, its products, prices, stock, orders, shipping, returns, or policies, call search_knowledge_base. Write the query as a complete standalone question, filling in anything the caller referred to earlier (for "how much is it?", name the product).
- Answer only from the passages the tool returns. They are the canonical record. If they don't cover the question, say plainly that you don't have that on file and offer to help with something else.
- Never fill gaps from general knowledge, and never guess numbers, dates, prices, or names.
- For questions unrelated to ${orgName}, say briefly that you can only help with ${orgName} and its products.

Speaking style:
- One to three short sentences per reply. The caller can ask a follow-up.
- Never read out file names, URLs, or source labels.
- If the question is unclear, ask one short clarifying question.
- While a search is running, don't fill the silence with long filler; at most a few words such as "One moment."

Call flow:
- When you receive the message "[call connected]", greet the caller with: "${greeting}"
- When the caller says goodbye or that they're done, say a short goodbye and then call end_call.`;

export const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "search_knowledge_base",
        description: `Search ${orgName}'s knowledge base (products, prices, stock, shipping, returns, policies, FAQs). Returns the most relevant passages.`,
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "A complete, standalone question in plain English." },
          },
          required: ["query"],
        },
      },
      {
        name: "end_call",
        description: "Hang up after you have said goodbye to the caller.",
        parameters: { type: "OBJECT", properties: {} },
      },
    ],
  },
];

// SDK 3.x defaults to API version v1, which has no Live endpoint (404).
const ai = config.gemini.apiKey ? new GoogleGenAI({ apiKey: config.gemini.apiKey, httpOptions: { apiVersion: "v1beta" } }) : null;
const twilioClient = config.twilio.accountSid ? twilio(config.twilio.accountSid, config.twilio.authToken) : null;

// One-time tokens issued by the signed /voice/incoming webhook and checked
// when Twilio opens the media WebSocket, so random clients can't open
// (and run up) Gemini sessions.
const streamTokens = new Map();

export function issueStreamToken(callSid) {
  const token = crypto.randomUUID();
  streamTokens.set(token, callSid);
  setTimeout(() => streamTokens.delete(token), 60_000).unref();
  return token;
}

function claimStreamToken(token, callSid) {
  const expected = streamTokens.get(token);
  streamTokens.delete(token);
  return expected !== undefined && expected === callSid;
}

/** Handle one Twilio Media Streams WebSocket for the length of a call. */
export function handleMediaStream(twilioWs) {
  let streamSid = null;
  let callSid = null;
  let session = null;
  let sessionReady = false;
  let pendingAudio = [];
  let toTwilio = createGeminiToTwilio();
  let hangupRequested = false;
  let hangupMark = 0;

  // Timing and transcript for the log.
  let callerText = "";
  let agentText = "";
  let lastCallerSpeechAt = 0;
  let firstAudioLogged = false;

  const sendToTwilio = (msg) => {
    if (twilioWs.readyState === twilioWs.OPEN) twilioWs.send(JSON.stringify(msg));
  };

  const closeAll = () => {
    try {
      session?.close();
    } catch {}
    if (twilioWs.readyState === twilioWs.OPEN) twilioWs.close();
  };

  let hungUp = false;
  async function hangUp() {
    if (hungUp) return;
    hungUp = true;
    if (!twilioClient || !callSid) return closeAll();
    try {
      await twilioClient.calls(callSid).update({ status: "completed" });
    } catch (err) {
      console.error("[gemini] hang-up failed:", err.message);
      closeAll();
    }
  }

  function queueHangupMark() {
    hangupMark += 1;
    sendToTwilio({ event: "mark", streamSid, mark: { name: `hangup-${hangupMark}` } });
  }

  async function runTool(call) {
    if (call.name === "end_call") {
      hangupRequested = true;
      // Hang up once Twilio has played everything queued so far. Another mark
      // goes out at the end of the model's turn, in case it says more after
      // this tool call; only the latest mark triggers the hang-up.
      queueHangupMark();
      setTimeout(hangUp, 10_000).unref(); // fallback if no mark comes back
      return { status: "ok", note: "The call will end after your goodbye finishes playing." };
    }
    if (call.name === "search_knowledge_base") {
      const query = String(call.args?.query || callerText || "").trim();
      try {
        const passages = await searchKnowDrive(query);
        if (!passages.length) {
          return { status: "no_results", reason: "Nothing in the knowledge base matches this question." };
        }
        return { status: "ok", passages: passages.map((p) => ({ source: p.uri, text: p.text })) };
      } catch (err) {
        console.error("[knowdrive]", err.message);
        return { status: "error", retryable: false, reason: "The knowledge base could not be reached." };
      }
    }
    return { status: "error", reason: `Unknown tool ${call.name}` };
  }

  function onGeminiMessage(msg) {
    if (msg.setupComplete) return;

    if (msg.toolCall?.functionCalls?.length) {
      Promise.all(
        msg.toolCall.functionCalls.map(async (call) => {
          console.log(`[gemini] ${callSid} tool ${call.name}(${JSON.stringify(call.args || {})})`);
          return { id: call.id, name: call.name, response: await runTool(call) };
        }),
      ).then((functionResponses) => {
        try {
          session?.sendToolResponse({ functionResponses });
        } catch (err) {
          console.error("[gemini] tool response failed:", err.message);
        }
      });
      return;
    }

    if (msg.goAway) console.warn(`[gemini] ${callSid} session ending soon (${msg.goAway.timeLeft})`);

    const content = msg.serverContent;
    if (!content) return;

    if (content.inputTranscription?.text) {
      callerText += content.inputTranscription.text;
      lastCallerSpeechAt = Date.now();
    }
    if (content.outputTranscription?.text) agentText += content.outputTranscription.text;

    if (content.interrupted) {
      // Caller talked over the agent: drop whatever audio Twilio still has queued.
      sendToTwilio({ event: "clear", streamSid });
      toTwilio = createGeminiToTwilio();
      console.log(`[gemini] ${callSid} interrupted by caller`);
    }

    for (const part of content.modelTurn?.parts || []) {
      const data = part.inlineData?.data;
      if (!data) continue;
      if (!firstAudioLogged && lastCallerSpeechAt) {
        // Measured from the last transcribed caller words this turn. Transcripts
        // trail the audio slightly, so a near-zero gap means the agent began
        // while the caller was finishing (overlap), not an instant answer.
        const gap = Date.now() - lastCallerSpeechAt;
        console.log(
          gap < 100
            ? `[gemini] ${callSid} agent started speaking while caller was finishing`
            : `[gemini] ${callSid} first audio ${gap}ms after last caller speech`,
        );
        firstAudioLogged = true;
      }
      const payload = toTwilio(data);
      if (payload) sendToTwilio({ event: "media", streamSid, media: { payload } });
    }

    if (content.turnComplete) {
      if (hangupRequested) queueHangupMark();
      // A turn that only issued a tool call ends before anything is spoken;
      // keep its caller text and timing for the answer turn that follows.
      if (!agentText.trim() && !firstAudioLogged) return;
      if (callerText.trim()) console.log(`[call] ${callSid} caller: "${callerText.trim()}"`);
      if (agentText.trim()) console.log(`[call] ${callSid} agent: "${agentText.trim()}"`);
      callerText = "";
      agentText = "";
      firstAudioLogged = false;
      lastCallerSpeechAt = 0; // only time replies to speech heard after this turn
    }
  }

  async function openSession() {
    if (!ai) {
      console.error("[gemini] GEMINI_API_KEY is not set");
      return closeAll();
    }
    const started = Date.now();
    session = await ai.live.connect({
      model: config.gemini.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.gemini.voice } } },
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: TOOLS,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onmessage: onGeminiMessage,
        onerror: (e) => console.error(`[gemini] ${callSid} error:`, e?.message || e),
        onclose: (e) => {
          console.log(`[gemini] ${callSid} session closed${e?.reason ? `: ${e.reason}` : ""}`);
          sessionReady = false;
          if (twilioWs.readyState === twilioWs.OPEN) twilioWs.close();
        },
      },
    });
    sessionReady = true;
    console.log(`[gemini] ${callSid} session open in ${Date.now() - started}ms (${config.gemini.model}, voice ${config.gemini.voice})`);
    for (const data of pendingAudio) session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } });
    pendingAudio = [];
    session.sendRealtimeInput({ text: "[call connected]" });
  }

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        const token = msg.start.customParameters?.token;
        if (!claimStreamToken(token, callSid)) {
          console.warn(`[gemini] rejected media stream for ${callSid}: bad or missing token`);
          return twilioWs.close();
        }
        console.log(`[call] ${callSid} media stream started (voice-to-voice)`);
        openSession().catch((err) => {
          console.error(`[gemini] ${callSid} could not open session:`, err.message);
          closeAll();
        });
        break;
      }
      case "media": {
        if (msg.media.track && msg.media.track !== "inbound") break;
        const data = twilioToGemini(msg.media.payload);
        if (sessionReady) session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } });
        else if (pendingAudio.length < 250) pendingAudio.push(data); // ~5 s of audio while connecting
        break;
      }
      case "mark":
        if (hangupRequested && msg.mark?.name === `hangup-${hangupMark}`) hangUp();
        break;
      case "stop":
        closeAll();
        break;
    }
  });

  twilioWs.on("close", () => {
    try {
      session?.close();
    } catch {}
  });
  twilioWs.on("error", (err) => console.error("[twilio-ws]", err.message));
}

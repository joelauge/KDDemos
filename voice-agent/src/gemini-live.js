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
import { buildProductLink, smsBody, toE164 } from "./shop.js";

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

Texting product links:
- After you've answered a question about a specific product the caller seems interested in, offer to text them a link that puts it in their cart and opens checkout. Vary how you ask; don't repeat the same wording on one call. For example: "Want me to text you a link so you can check out in a tap?", "I can send that straight to your phone, already in your cart. Would that help?", "Shall I text you a checkout link for that?"
- Offer at most once per product, and not at all if they've already declined. Don't push.
- Before sending, know which version they want (color, orientation, size) and how many. If you don't know, ask.
- Texts go to the number they're calling from unless they give another. Confirm before sending, using the last four digits you were given (for example "to the number ending in 0378?"). If they give a different number, read it back and get a yes first.
- Then call send_product_link with the product's handle from the knowledge base passages (the "Handle" field, or the last part of its store page address), the version, the quantity, and phone_number only if they gave a different one.
- If the tool asks for a version, ask the caller. If the version is sold out, say so and offer an in-stock one. When it succeeds, tell them it's on its way and that the link opens checkout with the item already in the cart.
- Never read out the link itself.

Call flow:
- The call starts with a message like "[call connected] Caller's number ends in 0378." Greet the caller with: "${greeting}"
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
        name: "send_product_link",
        description:
          "Text the caller a link that adds a product to their cart and opens checkout. Only call after the caller agreed and confirmed the number.",
        parameters: {
          type: "OBJECT",
          properties: {
            product: {
              type: "STRING",
              description: "The product's handle from the knowledge base (e.g. ultimate-bundle), or its store page URL. A product name works as a last resort.",
            },
            variant: {
              type: "STRING",
              description: "The version the caller wants, in plain words (e.g. \"brown landscape\"). Empty if the product has only one version.",
            },
            quantity: { type: "INTEGER", description: "How many. Default 1." },
            phone_number: {
              type: "STRING",
              description: "Only if the caller asked for a number other than the one they're calling from, as they said it.",
            },
          },
          required: ["product"],
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

const MAX_TEXTS_PER_CALL = 3;

/**
 * Runs the knowledge-base and product-link tools for one call. Shared by the
 * live call bridge and scripts/live-test.js. Returns null for tools it doesn't
 * handle (end_call is handled by the bridge).
 */
export function createToolRunner({ callSid, callerNumber, sendSms }) {
  let textsSent = 0;

  return async function runTool(call) {
    const args = call.args || {};

    if (call.name === "search_knowledge_base") {
      const query = String(args.query || "").trim();
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

    if (call.name === "send_product_link") {
      if (textsSent >= MAX_TEXTS_PER_CALL) {
        return { status: "error", retryable: false, reason: "The text limit for this call has been reached." };
      }
      const to = toE164(args.phone_number || callerNumber);
      if (!to) {
        return {
          status: "need_phone_number",
          reason: "There's no usable number for this caller. Ask for their mobile number and read it back.",
        };
      }
      const link = await buildProductLink({
        product: args.product,
        variant: args.variant,
        quantity: args.quantity,
        callSid,
      });
      if (link.status !== "ok") return link;
      try {
        await sendSms(to, smsBody(link));
        textsSent += 1;
        console.log(`[sms] ${callSid} sent ${link.kind} link for ${link.title}${link.variant ? ` (${link.variant})` : ""} to ***${to.slice(-4)}`);
        return {
          status: "ok",
          sent_to_last_four: to.slice(-4),
          opens: link.kind === "checkout" ? "checkout with the item in the cart" : "the product page",
          product: link.title,
          variant: link.variant,
        };
      } catch (err) {
        console.error(`[sms] ${callSid} failed:`, err.message);
        return { status: "error", retryable: false, reason: "The text message couldn't be sent." };
      }
    }

    return null;
  };
}

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
  let callerNumber = "";
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

  let runSharedTool = null;
  const sendSms = (to, body) => {
    if (!twilioClient) throw new Error("Twilio isn't configured");
    return twilioClient.messages.create({ from: config.twilio.phoneNumber, to, body });
  };

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
    if (call.name === "search_knowledge_base" && !call.args?.query) call.args = { ...call.args, query: callerText };
    return (await runSharedTool?.(call)) ?? { status: "error", reason: `Unknown tool ${call.name}` };
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
    const lastFour = toE164(callerNumber)?.slice(-4);
    session.sendRealtimeInput({
      text: lastFour ? `[call connected] Caller's number ends in ${lastFour}.` : "[call connected] Caller's number is unknown.",
    });
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
        // Set by our signed /voice/incoming webhook, so it can be trusted.
        callerNumber = msg.start.customParameters?.from || "";
        if (!claimStreamToken(token, callSid)) {
          console.warn(`[gemini] rejected media stream for ${callSid}: bad or missing token`);
          return twilioWs.close();
        }
        console.log(`[call] ${callSid} media stream started (voice-to-voice)`);
        runSharedTool = createToolRunner({ callSid, callerNumber, sendSms });
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

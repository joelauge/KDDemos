import express from "express";
import { Readable } from "node:stream";
import twilio from "twilio";
import { config, requireEnv } from "./config.js";
import { searchKnowDrive } from "./knowdrive.js";
import { composeAnswer } from "./answer.js";
import { streamSpeech, synthesize } from "./tts.js";
import { WebSocketServer } from "ws";
import { handleMediaStream, issueStreamToken } from "./gemini-live.js";
import { createTurn, endCall, getHistory, getLastQuestion, recordExchange, takeTurn } from "./sessions.js";

const voiceToVoice = config.voiceEngine === "gemini";

requireEnv([
  "PUBLIC_BASE_URL",
  "KNOWDRIVE_VECTOR_STORE_ID",
  "TWILIO_AUTH_TOKEN",
  ...(voiceToVoice ? ["GEMINI_API_KEY"] : ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]),
]);

const { VoiceResponse } = twilio.twiml;
const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));

const base = config.publicBaseUrl;
const ANSWER_TIMEOUT_MS = 15000;
const GOODBYE = /\b(good ?bye|bye|that'?s all|that is all|hang up|no thanks?|nothing else)\b/i;

// ── Fixed prompts, synthesized once with ElevenLabs and served from memory ──
const PROMPTS = {
  greeting: config.persona.greeting,
  reprompt: "Are you still there? Ask me anything about " + config.persona.orgName + ".",
  goodbye: "Thanks for calling " + config.persona.orgName + ". Goodbye!",
  error: "Sorry, something went wrong on my end. Could you ask that again?",
};
const promptAudio = new Map();

async function warmPrompts() {
  await Promise.all(
    Object.entries(PROMPTS).map(async ([key, text]) => {
      try {
        promptAudio.set(key, await synthesize(text));
      } catch (err) {
        console.warn(`[prompts] could not synthesize "${key}", will fall back to <Say>:`, err.message);
      }
    }),
  );
  console.log(`[prompts] ready: ${[...promptAudio.keys()].join(", ") || "none"}`);
}

/** Play a cached ElevenLabs prompt, or fall back to Twilio's own voice. */
function speakPrompt(node, key) {
  if (promptAudio.has(key)) node.play(`${base}/audio/prompt/${key}`);
  else node.say(PROMPTS[key]);
}

function gatherOptions() {
  return {
    input: "speech",
    action: `${base}/voice/turn`,
    method: "POST",
    speechTimeout: "auto",
    speechModel: config.twilio.speechModel,
    language: config.twilio.language,
    actionOnEmptyResult: true,
  };
}

function sendTwiml(res, twiml) {
  res.type("text/xml").send(twiml.toString());
}

// ── Twilio request signature check ──
function verifyTwilio(req, res, next) {
  if (!config.twilio.validateSignature) return next();
  const signature = req.get("X-Twilio-Signature") || "";
  const url = base + req.originalUrl;
  if (twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {})) return next();
  console.warn(`[twilio] rejected unsigned request to ${req.originalUrl}`);
  res.status(403).send("Invalid Twilio signature");
}

// ── Call flow ──

// 1. A call comes in: greet and listen.
app.post("/voice/incoming", verifyTwilio, (req, res) => {
  console.log(`[call] ${req.body.CallSid} from ${req.body.From}`);
  const twiml = new VoiceResponse();

  if (voiceToVoice) {
    // Hand the call's audio to the Gemini Live bridge over a WebSocket.
    const stream = twiml.connect().stream({ url: `${base.replace(/^http/, "ws")}/media` });
    stream.parameter({ name: "token", value: issueStreamToken(req.body.CallSid) });
    if (req.body.From) stream.parameter({ name: "from", value: req.body.From });
    return sendTwiml(res, twiml);
  }

  const gather = twiml.gather(gatherOptions());
  speakPrompt(gather, "greeting");
  twiml.redirect({ method: "POST" }, `${base}/voice/reprompt`);
  sendTwiml(res, twiml);
});

// 2. The caller finished speaking: start the answer and hand Twilio an audio URL.
app.post("/voice/turn", verifyTwilio, (req, res) => {
  const callSid = req.body.CallSid;
  const question = (req.body.SpeechResult || "").trim();
  const twiml = new VoiceResponse();

  if (!question) {
    const gather = twiml.gather(gatherOptions());
    speakPrompt(gather, "reprompt");
    twiml.redirect({ method: "POST" }, `${base}/voice/reprompt`);
    return sendTwiml(res, twiml);
  }

  console.log(`[call] ${callSid} asked: "${question}" (confidence ${req.body.Confidence ?? "?"})`);

  if (GOODBYE.test(question) && question.split(/\s+/).length <= 5) {
    speakPrompt(twiml, "goodbye");
    twiml.hangup();
    endCall(callSid);
    return sendTwiml(res, twiml);
  }

  // Search + compose run now, while Twilio is still parsing this TwiML and
  // requesting the audio URL below; the audio route waits for the result.
  const turnId = createTurn(answerQuestion(callSid, question));

  const gather = twiml.gather(gatherOptions()); // caller can interrupt the answer
  gather.play(`${base}/audio/turn/${turnId}`);
  twiml.redirect({ method: "POST" }, `${base}/voice/reprompt`);
  sendTwiml(res, twiml);
});

// 3. Silence after an answer: nudge once more, then end the call.
app.post("/voice/reprompt", verifyTwilio, (req, res) => {
  const twiml = new VoiceResponse();
  if (req.query.final) {
    speakPrompt(twiml, "goodbye");
    twiml.hangup();
  } else {
    const gather = twiml.gather(gatherOptions());
    speakPrompt(gather, "reprompt");
    twiml.redirect({ method: "POST" }, `${base}/voice/reprompt?final=1`);
  }
  sendTwiml(res, twiml);
});

// Call status callback (optional): clean up history when the call ends.
app.post("/voice/status", verifyTwilio, (req, res) => {
  if (["completed", "failed", "busy", "no-answer", "canceled"].includes(req.body.CallStatus)) {
    endCall(req.body.CallSid);
    console.log(`[call] ${req.body.CallSid} ended (${req.body.CallStatus})`);
  }
  res.sendStatus(204);
});

async function answerQuestion(callSid, question) {
  const history = getHistory(callSid);
  // Short follow-ups ("how much is it?") retrieve better with the prior question attached.
  const previous = getLastQuestion(callSid);
  const searchQuery = previous && question.split(/\s+/).length < 7 ? `${previous} ${question}` : question;

  let passages = [];
  try {
    passages = await searchKnowDrive(searchQuery);
  } catch (err) {
    console.error("[knowdrive]", err.message);
  }
  const answer = await composeAnswer({ question, passages, history });
  recordExchange(callSid, question, answer);
  console.log(`[call] ${callSid} answer: "${answer}"`);
  return answer;
}

// ── Audio ──

app.get("/audio/prompt/:key", (req, res) => {
  const audio = promptAudio.get(req.params.key);
  if (!audio) return res.sendStatus(404);
  res.type("audio/mpeg").set("Cache-Control", "public, max-age=3600").send(audio);
});

app.get("/audio/turn/:id", async (req, res) => {
  const pending = takeTurn(req.params.id);
  if (!pending) return res.sendStatus(404);

  try {
    const answer = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("answer timed out")), ANSWER_TIMEOUT_MS)),
    ]);
    const tts = await streamSpeech(answer);
    res.type("audio/mpeg").set("Cache-Control", "no-store");
    Readable.fromWeb(tts.body).pipe(res);
  } catch (err) {
    console.error("[audio]", err.message);
    const fallback = promptAudio.get("error");
    if (fallback) res.type("audio/mpeg").send(fallback);
    else res.sendStatus(500);
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    engine: voiceToVoice ? "gemini" : "classic",
    store: config.knowdrive.vectorStoreId,
    ...(voiceToVoice
      ? { model: config.gemini.model, voice: config.gemini.voice }
      : { model: config.claude.model, voice: config.elevenlabs.voiceId, prompts: [...promptAudio.keys()] }),
  });
});

const server = app.listen(config.port, async () => {
  console.log(`KnowDrive voice agent listening on :${config.port} (engine: ${voiceToVoice ? "gemini voice-to-voice" : "classic"})`);
  console.log(`Point your Twilio number's voice webhook at ${base}/voice/incoming (POST)`);
  if (!voiceToVoice) await warmPrompts();
});

// Twilio Media Streams connect here when VOICE_ENGINE=gemini.
const wss = new WebSocketServer({ server, path: "/media" });
wss.on("connection", handleMediaStream);

# KnowDrive Voice Agent (demo)

A phone number you can call to ask questions out loud. The agent answers using **only** what is stored in a KnowDrive vector store.

There are two voice engines, picked with `VOICE_ENGINE`:

- **`gemini`** (voice-to-voice): the call's audio streams straight to Gemini 3.8 Live, which listens and speaks itself. There is no speech-to-text or text-to-speech step, so replies start about 1 second after the caller stops (search included). Interruptions are handled by the model.
- **`classic`**: Twilio speech-to-text → KnowDrive → Claude → ElevenLabs voice. Replies take about 3 to 4.5 seconds, but you get your ElevenLabs voice.

## Voice-to-voice engine (`VOICE_ENGINE=gemini`)

```
 Caller ──► Twilio number ──► POST /voice/incoming ──► <Connect><Stream wss://…/media>
                                       │
              μ-law 8 kHz audio both ways over a WebSocket (Twilio Media Streams)
                                       │
                          src/gemini-live.js  (PCM 16 kHz in, 24 kHz out)
                                       │
                    Gemini 3.8 Live session ──► tool: search_knowledge_base ──► KnowDrive
                                       └──────► tool: end_call (hangs up after the goodbye)
```

- **Grounding:** the system instruction requires a `search_knowledge_base` call before any answer about the business, and allows answers only from the returned passages. Gemini writes each search as a standalone question, so follow-ups ("how much is it?") still find the right product.
- **Security:** `/voice/incoming` is signature-checked and issues a one-time token that Twilio passes back when it opens the media WebSocket. Streams without a valid token are closed before a Gemini session opens.
- **Test without a phone:** `npm run live-test` opens a session with the same prompt and tools, asks the sample questions as text, prints the agent's words, tool calls and timings, and writes `live-answer.wav`.
- **Settings:** `GEMINI_API_KEY` (from aistudio.google.com/apikey), `GEMINI_LIVE_MODEL` (default `gemini-3.8-live`), `GEMINI_VOICE` (default `Kore`). Claude and ElevenLabs keys aren't needed in this mode.
- **Limits:** Gemini Live audio sessions are capped at about 15 minutes. `@google/genai` 3.x defaults to API version `v1`, which has no Live endpoint, so the client pins `v1beta`.

## Classic engine (`VOICE_ENGINE=classic`)

```
 Caller ──► Twilio number ──► POST /voice/incoming ──► greeting (ElevenLabs) + <Gather speech>
                                       │
             caller speaks ──► Twilio speech-to-text ──► POST /voice/turn
                                       │
                 ┌─────────────────────┴──────────────────────┐
                 │ 1. KnowDrive  GET /api/v1/search (hybrid)  │  canonical passages
                 │ 2. Claude     short spoken answer, grounded│  only in those passages
                 │ 3. ElevenLabs streaming TTS (MP3)          │──► <Play> /audio/turn/:id
                 └────────────────────────────────────────────┘
                                       │
             caller can interrupt at any point, and the loop continues
```

**Why this design:** each turn returns TwiML right away. Search and answer writing start in the background, so they overlap with Twilio fetching the audio URL. The audio is piped from ElevenLabs as it's generated, which keeps the gap between question and answer short. Fixed prompts (greeting, reprompt, goodbye) are synthesized once at startup and served from memory. Twilio handles speech recognition and barge-in (the caller can interrupt the answer).

## What you need

| Service | What to get |
|---|---|
| **KnowDrive** | A store id (`vs_…`) and a token with `functions:/api/v1/search:read` + `vector_stores:<id>:read` |
| **Gemini** | API key (voice-to-voice engine only) |
| **ElevenLabs** | API key and a voice id (classic engine only) |
| **Twilio** | Account SID, auth token, and a voice-capable phone number |
| **Anthropic** | API key (classic engine only; Claude writes the spoken answer from the retrieved passages) |
| **A public HTTPS URL** | `ngrok http 3000`, `cloudflared tunnel`, or any host (Render, Fly, Railway…) |

## Run it

```bash
cd voice-agent
npm install
cp .env.example .env        # fill in the values
npm run ask -- "What does KnowDrive do?"          # test search + answer, no phone needed
npm run ask -- --say "What does KnowDrive do?"    # also writes answer.mp3 with the ElevenLabs voice
npm run live-test                                 # test the Gemini voice-to-voice agent, no phone needed
npm start                                         # starts the server
npm run twilio:configure                          # points your Twilio number at PUBLIC_BASE_URL
```

Then call your Twilio number. To have the agent call you instead (handy on stage): `npm run call -- +15551234567`.

`GET /health` shows the store, model, voice, and which prompts were synthesized.

### Test store

The default setup answers from the **knowbot-ugm** store on **dev.knowdrive.ai** (`vs_f66318f0dd0e4540b27663b03ea40f40`): 137 files covering The Ultimate Game Master's Shopify store. These include products, collections, policies, shipping, and 31 `kind:canonical` answer cards. Use a developer key from dev.knowdrive.ai in `KNOWDRIVE_API_TOKEN`; keys from other KnowDrive deployments won't work there.

`KNOWDRIVE_TAG_QUERY=!kind:article` leaves out the 25 blog and news posts, which can be promotional or out of date. Sample questions that retrieve the right canonical card:

- "What is your return policy?" (30 days from receipt; start by emailing the store)
- "Do you ship to Canada?" (yes, UPS rate calculated at checkout)
- "How much is the Ultimate Bundle?" ($319.99, saving $41.91 on the items bought separately)
- "Is the magnetic dice tray in stock?" (yes, $29.99)

To answer from another store, change `KNOWDRIVE_BASE_URL`, `KNOWDRIVE_VECTOR_STORE_ID` and the persona settings.

### Getting a KnowDrive token

- **Developer key:** create one on the deployment that holds the store (for the default, dev.knowdrive.ai) and put it in `KNOWDRIVE_API_TOKEN`. It's sent as `X-API-TOKEN`.
- **Short-lived token (quick tests):** from Claude, call the KnowDrive MCP `mint_token` tool with the two entitlements above. A JWT is detected automatically and sent as `Authorization: Bearer`. It expires within minutes.

### Keeping answers canonical

The agent answers from whatever the search returns, so the store decides what "canonical" means. A store that mixes vetted docs with meeting transcripts and drafts will produce answers from all of it. To limit answers to approved material, tag the approved files (for example `canonical`) and set:

```
KNOWDRIVE_TAG_QUERY=canonical
```

That's passed to search as `tag_query`, which supports `,` (AND), `|` (OR), `!` (NOT), and `*` globs, e.g. `canonical,!draft`.

The system prompt in `src/answer.js` tells Claude to answer only from the passages, to say "I don't have that on file" when they don't cover the question, and never to guess numbers, prices, or names.

## Tuning

| Setting | Default | Notes |
|---|---|---|
| `ELEVENLABS_MODEL_ID` | `eleven_flash_v2_5` | Lowest latency. Use `eleven_multilingual_v2` for a richer voice at some extra delay. |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_22050_32` | Small and fast. Phone audio is 8 kHz, so higher bitrates add nothing. |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | `claude-opus-5-5` / `low` | Low effort keeps turns quick. Raise to `medium` for harder questions. |
| `KNOWDRIVE_TOP_K` | `6` | Passages per question. |
| `TWILIO_SPEECH_MODEL` | `phone_call` | Twilio's speech recognition model for `<Gather>`. |
| `GREETING`, `AGENT_NAME`, `ORG_NAME` | Kay / KnowDrive | Persona. |

Claude requests send `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). If a request is declined by a safety classifier, the API retries it on a fallback model in the same call. Remove both fields in `src/answer.js` if you don't want that.

## Security notes

- Every `/voice/*` webhook checks Twilio's `X-Twilio-Signature` against `PUBLIC_BASE_URL`. `PUBLIC_BASE_URL` must match the URL configured in Twilio exactly. Set `TWILIO_VALIDATE_SIGNATURE=false` only for local curl testing.
- Answer audio URLs carry a random UUID and expire after 5 minutes.
- Call history is kept in memory per `CallSid` (last 6 exchanges) and cleared when the call ends. Restarting the server clears everything.

## Files

```
src/server.js      Express app: Twilio webhooks, TwiML, audio streaming
src/knowdrive.js   KnowDrive hybrid search client
src/answer.js      Claude prompt that turns passages into a short spoken answer
src/tts.js         ElevenLabs streaming text-to-speech
src/sessions.js    Per-call history and pending answers
src/gemini-live.js Voice-to-voice: Twilio Media Streams <-> Gemini Live, KnowDrive as a tool
src/audio.js       μ-law 8 kHz <-> PCM 16/24 kHz conversion
scripts/ask.js     Command-line test of search + answer (+ voice)
scripts/configure-twilio.js   Points your number's webhooks at this server
scripts/call.js    Places an outbound demo call
scripts/live-test.js  Phone-free test of the Gemini voice-to-voice agent
```

## Possible next steps

- **Classic engine latency:** switch from `<Gather>` + `<Play>` to Media Streams with ElevenLabs WebSocket TTS (`ulaw_8000`), streaming Claude's tokens into TTS sentence by sentence. (The Gemini engine already streams.)
- **Show sources:** text the caller the source documents behind an answer via Twilio SMS.
- **Hand off:** `<Dial>` a person when the knowledge base has no answer.

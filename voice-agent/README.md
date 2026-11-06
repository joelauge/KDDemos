# KnowDrive Voice Agent (demo)

A phone number you can call to ask questions out loud. The agent answers in a natural ElevenLabs voice, using **only** what is stored in a KnowDrive vector store.

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
| **ElevenLabs** | API key and a voice id |
| **Twilio** | Account SID, auth token, and a voice-capable phone number |
| **Anthropic** | API key (Claude writes the spoken answer from the retrieved passages) |
| **A public HTTPS URL** | `ngrok http 3000`, `cloudflared tunnel`, or any host (Render, Fly, Railway…) |

## Run it

```bash
cd voice-agent
npm install
cp .env.example .env        # fill in the values
npm run ask -- "What does KnowDrive do?"          # test search + answer, no phone needed
npm run ask -- --say "What does KnowDrive do?"    # also writes answer.mp3 with the ElevenLabs voice
npm start                                         # starts the server
npm run twilio:configure                          # points your Twilio number at PUBLIC_BASE_URL
```

Then call your Twilio number. To have the agent call you instead (handy on stage): `npm run call -- +15551234567`.

`GET /health` shows the store, model, voice, and which prompts were synthesized.

### Test store

The default test setup answers from the **Canada** store on **public.knowdrive.ai** (`vs_6164dda13277488abf2b8c7414f43c23`): about 405,000 files of Canadian legislation and case law (federal and provincial, English and French). It's a separate KnowDrive deployment with the same API, so the token must come from that host: a token from knowdrive.ai won't work there.

`KNOWDRIVE_TAG_QUERY=lang:en` keeps French passages out of the answers (the voice speaks English). Sample questions that retrieve well:

- "How many weeks of maternity benefits can I get from employment insurance?" (up to 15 weeks, from Social Security Tribunal decisions)
- "Who is entitled to vote in a federal election?" (citizenship, age and residence, from the Supreme Court of Canada)

Narrower filters didn't help in testing. `legislation,lang:en` answered the maternity question from provincial job-protected-leave law (17 weeks), not the federal benefit (15 weeks). `legislation,lang:en,jurisdiction:ca-fed` returned only procedural regulations for both questions.

The greeting says the agent can't give legal advice. Keep it that way for this corpus.

Point `KNOWDRIVE_BASE_URL` back at `https://knowdrive.ai` to answer from a store on the main deployment instead.

### Getting a KnowDrive token

- **API token:** mint a PASETO token (`POST /-/apitokens/mint`) and put it in `KNOWDRIVE_API_TOKEN`. It's sent as `X-API-TOKEN`.
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
scripts/ask.js     Command-line test of search + answer (+ voice)
scripts/configure-twilio.js   Points your number's webhooks at this server
scripts/call.js    Places an outbound demo call
```

## Possible next steps

- **Lower latency:** switch from `<Gather>` + `<Play>` to Twilio Media Streams (bidirectional WebSocket) with ElevenLabs WebSocket TTS sending `ulaw_8000`, and stream Claude's tokens into TTS sentence by sentence.
- **Show sources:** text the caller the source documents behind an answer via Twilio SMS.
- **Hand off:** `<Dial>` a person when the knowledge base has no answer.

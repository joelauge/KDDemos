# Developer API

## The chat endpoint

Source: /v1

Developers can send questions to a KnowBot from their own app with `POST /v1/bots/:botId/chat` and the header `Authorization: Bearer <key>`. The body is either `{"question": "..."}` or `{"messages": [...]}`, with optional `stream` and `channel`. The JSON reply has the answer, its citations (number, file, title, excerpt), whether it was refused, and the proof (the hits with their similarity and the quoted lines). With `"stream": true` the reply is a stream of retrieval, delta, final and done events.

## OpenAI-compatible endpoint

Source: /v1

`POST /v1/chat/completions` is OpenAI-compatible: set `model` to the bot id and send `messages`, optionally with `stream`. It returns standard chat.completion objects (or chat.completion.chunk when streaming), with citations as numbered footnotes in the content and a structured `knowbot` field holding the citations, the refusal flag and the proof. The official OpenAI SDKs work by changing only the base URL. A refusal returns the refusal sentence.

## API keys

Source: /studio/

There are two kinds of KnowBot API key. A trial key starts with `kb_trial_`, is shown in the Developers tab of KnowBot Studio, works only for that trial bot and expires with it. A live key starts with `kb_live_`, is created for a launched bot, is shown only once, and is stored only as a hash.

## Rate limits

Source: /v1

By default a live key can make 60 requests per minute and a trial key 20 requests per minute. Responses carry rate-limit headers, and a request over the limit gets HTTP 429 with a retry-after header.

## Other API routes

Source: /v1

`GET /v1/models` lists the bot a key can use, in OpenAI's list shape. `GET /v1/openapi.json` describes the API in OpenAPI 3.1. `POST /v1/bots/:botId/voice` takes audio (or text) and returns a transcript, the answer and spoken audio when Google speech is configured. Each answer has a public proof page at `/p/<id>`.

## Code samples

Source: /studio/

The Developers tab in KnowBot Studio shows the endpoint, your trial key with a copy button, and tested snippets in curl, JavaScript (fetch and the OpenAI SDK) and Python (requests and the OpenAI SDK). Every API call is logged to your bot's question insights.

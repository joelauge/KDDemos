#!/usr/bin/env node
// Phone-free test of a KnowBot's voice-to-voice phone agent (ported from the voice-agent demo's scripts/live-test.js).
// Opens a Gemini Live session with the SAME system instruction and tools a real call gets (server/channels/voice-live.mjs),
// sends the questions as text, runs search_knowledge_base against the bot's own answer API (its sources, citations and
// librarian voice, logged with channel "phone"), and prints the transcript: what the agent says, each tool call, timings.
// Product-link texts are printed, never sent.
//
//   node scripts/voice-live-test.mjs --base=http://localhost:8787 --bot=<botId> --key=<kb_live_… or kb_trial_…> \
//        [--shop=https://store.example] "What is your return policy?" "How much is it?"
//
// Needs GEMINI_API_KEY in the environment (GEMINI_LIVE_MODEL, GEMINI_VOICE, GEMINI_LIVE_URL optional). This script
// talks to real services only when you point it at them; the test suite never runs it.
import { systemInstruction, toolDeclarations, createToolRunner, connectGemini, geminiSettings } from '../server/channels/voice-live.mjs';

const argv = process.argv.slice(2);
const opt = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const questions = argv.filter((a) => !a.startsWith('--'));
const base = String(opt('base') || 'http://localhost:8787').replace(/\/+$/, '');
const bot = opt('bot');
const key = opt('key');
const shop = opt('shop') || process.env.SHOP_DOMAIN || null;
const caller = opt('caller') || '+15555550100';
const env = process.env;

if (!bot || !key) { console.error('Usage: node scripts/voice-live-test.mjs --bot=<botId> --key=<API key> [--base=URL] [--shop=URL] "question" …'); process.exit(2); }
if (!geminiSettings(env).apiKey) { console.error('Set GEMINI_API_KEY first.'); process.exit(2); }

/** The bot's own answer pipeline, over its public API (logged as a phone question). */
async function ask(question) {
  const r = await fetch(`${base}/v1/bots/${encodeURIComponent(bot)}/chat`, { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ question, channel: 'phone' }) });
  if (!r.ok) throw new Error(`answer API HTTP ${r.status}`);
  return r.json();
}

const info = await fetch(`${base}/v1/channels/${encodeURIComponent(bot)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const botName = opt('name') || bot;
const runTool = createToolRunner({ ask, callSid: 'CAvoicelivetest', callerNumber: caller, shopDomain: shop, env, botName,
  sendSms: async (to, body) => console.log(`        [text not sent] to ***${to.slice(-4)}: ${body}`), log: (s) => console.log(`        ${s}`) });

let resolveTurn = null, transcript = '', firstAudioAt = 0, toolPending = false, answeredAfterTool = true, session = null;
async function onMessage(msg) {
  if (msg.toolCall?.functionCalls?.length) {
    toolPending = true; answeredAfterTool = false;
    const functionResponses = [];
    for (const call of msg.toolCall.functionCalls) {
      console.log(`  tool  ${call.name}(${JSON.stringify(call.args || {})})`);
      const response = call.name === 'end_call' ? { status: 'ok' } : ((await runTool(call)) ?? { status: 'error', reason: 'unknown tool' });
      if (response.say) console.log(`        say: "${response.say}"`);
      for (const s of response.sources || []) console.log(`        • ${s.title}`);
      if (!response.say) console.log(`        -> ${JSON.stringify(response)}`);
      functionResponses.push({ id: call.id, name: call.name, response });
    }
    session.sendToolResponse(functionResponses);
    toolPending = false;
    return;
  }
  const c = msg.serverContent;
  if (!c) return;
  if (c.outputTranscription?.text) transcript += c.outputTranscription.text;
  for (const part of c.modelTurn?.parts || []) if (part.inlineData?.data) { if (!firstAudioAt) firstAudioAt = Date.now(); if (!toolPending) answeredAfterTool = true; }
  if (c.turnComplete && !toolPending && answeredAfterTool) resolveTurn?.();
}
async function say(text) {
  transcript = ''; firstAudioAt = 0; answeredAfterTool = true;
  const t0 = Date.now();
  const done = new Promise((r) => { resolveTurn = r; });
  session.sendText(text);
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('turn timed out')), 30000))]);
  console.log(`  agent "${transcript.trim()}"`);
  console.log(`        first audio ${firstAudioAt ? firstAudioAt - t0 : '?'}ms, turn ${Date.now() - t0}ms\n`);
}

const t0 = Date.now();
const productLinks = !!shop;
session = await connectGemini(env, { systemInstruction: systemInstruction({ botName, org: opt('org') || null, productLinks }), tools: toolDeclarations({ org: opt('org') || botName, productLinks }),
  onMessage: (m) => onMessage(m).catch((e) => console.error('handler error:', e.message)), onClose: () => {} });
console.log(`Session open in ${Date.now() - t0}ms (${geminiSettings(env).model}, voice ${geminiSettings(env).voice}) for bot ${bot}${info?.channels?.voice?.engine ? `, server phone engine: ${info.channels.voice.engine}` : ''}\n`);
const hello = `[call connected] Caller's number ends in ${caller.slice(-4)}.`;
console.log(`> ${hello}`);
await say(hello);
for (const q of questions.length ? questions : ['What can you help me with?']) { console.log(`> ${q}`); await say(q); }
session.close();
process.exit(0);

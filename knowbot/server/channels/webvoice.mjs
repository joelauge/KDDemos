// Web voice assistant: a visitor talks to a bot from a browser mic widget (lib/voice-widget.js, or lib/embed.js with
// data-mode="voice") over ONE WebSocket, and hears the answer with its sources shown as on-screen chips.
//
//   GET /v1/bots/:botId/voice/live   (WebSocket upgrade; /api alias)  → this module (wired in devapi.mjs upgrade())
//
// Engines
//   gemini  (GEMINI_API_KEY set): voice-to-voice through Gemini Live. The browser streams 16 kHz PCM16 mono as binary
//           frames; the model's 24 kHz PCM16 speech comes back as binary frames. The model must call
//           search_knowledge_base, which runs the bot's OWN answer pipeline (devapi answer(): its sources and scope, the
//           librarian voice, the citation gate, the canonical refusal) and returns a short spoken-style answer, the rest
//           ("more"), the exact facts and on-screen hints (voice-brain.mjs toolAnswer). Each search also sends the
//           citations to the browser. Speculative search, instant answers, the facts guard, read-back and message-taking
//           (take_message, a lead) are shared with the phone (voice-brain.mjs).
//           Gemini client, audio handling and tool runner are reused from voice-live.mjs (the phone engine).
//   text    (no GEMINI_API_KEY, Gemini unreachable, or the client asks for it): the browser recognizes speech itself
//           (Web Speech API) or the visitor types, sends {type:'text'}, and gets the cited answer + the spoken form to
//           read aloud with speechSynthesis.
//
// Protocol (JSON text frames unless noted)
//   client → {type:'start', key?, engine?:'auto'|'text', mode?:'web'|'phone'}   first message, within 10 s
//            mode 'phone' (the Studio's in-browser phone simulator): the bot runs with the REAL phone prompt and
//            greeting (voice-live.mjs systemInstruction/greetingFor, no texted links), and may hang up: when it calls
//            end_call the server sends {type:'hangup'} and closes the session shortly after (the client ends the call
//            once the goodbye has played).
//            binary PCM16 LE 16 kHz mono (gemini engine)   {type:'text', text}   {type:'stop'}
//   status: GET /v1/channels/:botId → channels.webVoice {engine, live, socket (wss URL), widget, embed}
//   server → {type:'ready', engine, bot:{id,name}, greeting, input:{rate:16000}, output:{rate:24000}, maxSeconds, note?}
//            {type:'transcript', role:'user'|'agent', text, delta:true}      captions (gemini engine)
//            binary PCM16 LE 24 kHz mono                                    the model's voice (gemini engine)
//            {type:'searching', query}  {type:'citations', query, refused, say, citations:[{n,title,file,url?}], proofUrl, products?}
//            {type:'answer', question, text, spoken, refused, citations, proofUrl, products?}   (text engine)
//            products: the product cards the answer cites (up to 4: {url, title, price, compareAt, currency, availability,
//            image}), shown under the answer like the web chat's; web sessions only (never the phone simulator), never spoken
//            {type:'interrupted'}  {type:'turn_complete'}  {type:'error', code, message}  {type:'end', reason}
//
// Access: a launched bot is public (like the chat widget) and rate limited per IP by devapi.mjs; a trial bot needs its
// kb_trial_ key in the start message (Studio passes it). Each session is capped in length and in questions.
// Settings (names only): GEMINI_API_KEY, GEMINI_LIVE_MODEL, GEMINI_VOICE, GEMINI_LIVE_URL (voice-live.mjs),
// KNOWBOT_WEBVOICE_MAX_SECONDS (default 600), KNOWBOT_WEBVOICE_MAX_SESSIONS (default 50, all bots),
// KNOWBOT_WEBVOICE_MAX_PER_BOT (default 10), KNOWBOT_WEBVOICE_MAX_PER_IP (default 2), KNOWBOT_WEBVOICE_ENGINE=text.
// Over any cap the start is refused with {type:'error', code:'busy'} and close code 1013.
import { NOT_IN_DATA, formatSpoken, humanTitle } from './util.mjs';
import { connectGemini, createToolRunner, systemInstruction as phoneSystemInstruction, toolDeclarations as phoneToolDeclarations, greetingFor as phoneGreeting,
  voiceGreeting, sendInfoInstruction, sendInfoDeclaration, searchDeclaration, respondToTools, geminiSettings } from './voice-live.mjs';
import { conversationRules, takeMessageDeclaration, voiceSetupOf, asyncToolsSupported, createSpeculator, unsupportedFigures } from './voice-brain.mjs';

export const MAX_QUESTIONS_PER_SESSION = 40;
/** What the browser-speech engine adds when product cards are on screen (the live engine says it in its own words). */
export const ON_SCREEN_LINE = "I've put it on your screen.";
let active = 0;
const activeByBot = new Map();
const activeByIp = new Map();
const bump = (m, k, d) => { const n = (m.get(k) || 0) + d; if (n > 0) m.set(k, n); else m.delete(k); };
/** Sessions open right now (tests, status): all bots, or one bot's. */
export const activeWebVoiceSessions = (botId) => (botId == null ? active : activeByBot.get(botId) || 0);

/** 'gemini' when a Gemini key is configured (and not forced off), else 'text'. */
export function webVoiceEngine(env = {}) {
  if (String(env.KNOWBOT_WEBVOICE_ENGINE || '').toLowerCase() === 'text') return 'text';
  return env.GEMINI_API_KEY ? 'gemini' : 'text';
}

/** The web voice greeting (voice-live.mjs voiceGreeting). media: what this bot can send ({ email, text }). */
export const webGreeting = (botName, media = null) => voiceGreeting(botName, media);

/**
 * The website voice prompt. asyncSearch: NON_BLOCKING search; takeMessages: message-taking and callback requests on a
 * refusal or when they ask for a person (the web has no call to transfer); language: 'auto' | a language code.
 */
export function webSystemInstruction({ botName, org, sendInfo = null, asyncSearch = false, takeMessages = false, language = 'auto' }) {
  const who = botName || 'KnowBot';
  const orgName = org || botName || 'this business';
  const canSend = !!(sendInfo && (sendInfo.email || sendInfo.text));
  return `You are ${who}, the voice assistant on ${orgName}'s website, speaking with a visitor through their browser microphone. You are a kind librarian: you answer only from ${orgName}'s own files. The visitor sees the sources on screen while you speak.

Grounding rules:
- Before answering ANY question, call search_knowledge_base. Write the query as a complete standalone question, filling in anything the visitor referred to earlier.
- The tool returns the answer from the files ("answer", sometimes "more", and the exact "facts"). Say it without saying where it comes from (no "According to ...": the sources are on screen${canSend ? ' and can be sent at the end' : ''}). If the visitor asks where something comes from, name it from "source_titles".
- If the tool returns status "not_in_data", say exactly: "${NOT_IN_DATA}"
- Never answer from general knowledge, never guess, and never answer a question you did not search for.

Speaking style:
- Short replies; the visitor can ask a follow-up.
- Never read out file names, URLs, citation numbers or links (they are on screen).

Session flow:
- The session starts with the message "[visitor connected]". Greet the visitor with: "${webGreeting(botName, sendInfo)}"
- Typed messages from the visitor arrive as text; treat them exactly like spoken questions.${conversationRules({ who: 'visitor', asyncSearch, onScreen: true, send: canSend ? sendInfo : null, takeMessages, transfer: takeMessages ? 'callback' : null, language })}${sendInfoInstruction(sendInfo, { who: 'visitor' })}`;
}

export function webToolDeclarations({ org, sendInfo = null, asyncSearch = false, takeMessages = false }) {
  return [{ functionDeclarations: [
    searchDeclaration(org || 'this business', { asyncSearch }),
    ...(sendInfo && (sendInfo.email || sendInfo.text) ? [sendInfoDeclaration()] : []),
    ...(takeMessages ? [takeMessageDeclaration()] : []),
  ] }];
}

/** The product cards a browser shows under a voice answer (the web chat's cards; up to 4, http(s) links only); [] on a refusal. */
export function productList(a) {
  if (a?.refused || !Array.isArray(a?.products)) return [];
  return a.products.filter((p) => p && typeof p.url === 'string' && /^https?:\/\//.test(p.url) && p.title).slice(0, 4)
    .map(({ url, title, price = null, compareAt = null, currency = null, availability = null, image = null }) => ({ url, title, price, compareAt, currency, availability, image }));
}
const withProducts = (a) => { const p = productList(a); return p.length ? { products: p } : {}; };

/** The citations a browser shows as chips: number, human title, file, and the source page when there is one. */
export function citationChips(a) {
  return (a?.refused ? [] : a?.citations || []).slice(0, 6).map((c) => ({ n: c.n, title: humanTitle(c), file: c.file || null, ...(c.url && /^https?:\/\//.test(c.url) ? { url: c.url } : {}) }));
}

/**
 * Serves one browser WebSocket for the length of a session.
 * @param {import('./ws.mjs').ServerSocket} ws
 * @param {object} cx
 * @param {object} cx.env
 * @param {string} cx.botId
 * @param {string} [cx.botName]
 * @param {string|null} [cx.org]
 * @param {(key: string) => Promise<{keyId?: string|null}>} cx.authorize  throws (with .message) when the key is refused
 * @param {(q: string, o: {callerKey: string|null}) => Promise<object>} cx.ask  the bot's answer pipeline (logs, proofUrl)
 * @param {string|null} [cx.callerKey]
 * @param {(s: string) => void} [cx.log]
 */
export function handleWebVoice(ws, cx) {
  const { env = {}, log = () => {} } = cx;
  const maxSeconds = Math.max(10, Number(env.KNOWBOT_WEBVOICE_MAX_SECONDS || cx.maxSeconds || 600));
  const maxSessions = Math.max(1, Number(env.KNOWBOT_WEBVOICE_MAX_SESSIONS || 50));
  const maxPerBot = Math.max(1, Number(env.KNOWBOT_WEBVOICE_MAX_PER_BOT || 10));
  const maxPerIp = Math.max(1, Number(env.KNOWBOT_WEBVOICE_MAX_PER_IP || 2));
  const botKey = String(cx.botId || '');
  const ipKey = cx.ip ? String(cx.ip) : null;
  const sid = `wv_${Math.random().toString(36).slice(2, 10)}`;
  let started = false, closed = false, engine = null, session = null, sessionReady = false, questions = 0, counted = false, phone = false, hangupTimer = null;
  let callerKey = cx.callerKey || null;
  const pendingAudio = [];
  const transcript = [];
  let userText = '', agentText = '';
  // the bot's voice settings (Set up → Voice), the model's async tools, the speculative search and the facts guard
  const setup = voiceSetupOf(cx.voiceSetup, { defaultVoice: geminiSettings(env).voice });
  const asyncSearch = asyncToolsSupported(geminiSettings(env).model, env);
  const takeMessages = !!(setup.takeMessages && cx.takeMessage);
  let spec = null, searchedThisTurn = false, newTurn = true;
  const unsupported = [];
  const cancelled = new Set(); // NON_BLOCKING calls the model cancelled (toolCallCancellation): never answered

  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const closeAll = (reason = 'closed', code = 1000) => {
    if (closed) return;
    closed = true;
    clearTimeout(startTimer); clearTimeout(lifeTimer); clearTimeout(hangupTimer);
    spec?.endTurn();
    try { session?.close(); } catch {}
    if (counted) { active -= 1; bump(activeByBot, botKey, -1); if (ipKey) bump(activeByIp, ipKey, -1); counted = false; }
    sendJson({ type: 'end', reason });
    if (ws.readyState === 1) ws.close(code, reason);
    cx.onEnd?.({ sid, engine, transcript, questions, unsupported, speculation: spec ? { ...spec.stats } : null });
  };
  const fail = (code, message, wsCode = 1008) => { sendJson({ type: 'error', code, message }); closeAll(code, wsCode); };
  const startTimer = setTimeout(() => { if (!started) fail('no_start', 'Send {"type":"start"} first.'); }, Number(cx.startTimeoutMs || 10000));
  startTimer.unref?.();
  let lifeTimer = null;

  // the bot's own pipeline; every answer is counted against the session's question budget (a speculative search once it
  // is used; the guesses themselves are capped per turn by the speculator)
  async function ask(q, { speculative = false } = {}) {
    if (!speculative) questions += 1;
    if (questions > MAX_QUESTIONS_PER_SESSION || (speculative && questions >= MAX_QUESTIONS_PER_SESSION)) throw Object.assign(new Error('question limit reached'), { limit: true });
    // product cards ride along on the website's voice mode (shown, never spoken); the phone simulator stays voice-only
    return cx.ask(String(q || '').slice(0, 1000), { callerKey, cards: !phone, ...(speculative ? { speculative: true } : {}) });
  }
  // the search already started on the visitor's words (speculative), when the model's query is the same or very close
  async function askFor(q) {
    const hit = spec?.take(q);
    if (hit) {
      const a = await hit.promise.catch(() => null);
      if (a) { questions += 1; a.speculativeMs = hit.aheadMs; return typeof a.commit === 'function' ? a.commit() : a; }
    }
    return ask(q);
  }
  const names = [cx.botName, cx.org].filter(Boolean);

  // ---------------------------------------------------------------- text engine
  async function answerText(text) {
    const q = String(text || '').replace(/\s+/g, ' ').trim();
    if (!q) return;
    // "can you email me that?": the send-info flow answers instead (server/sendinfo.mjs)
    const si = cx.maybeSendInfo ? await cx.maybeSendInfo(q, { callerKey }).catch((e) => { log(`[webvoice] ${sid} send-info failed: ${e.message}`); return null; }) : null;
    if (si) {
      transcript.push({ role: 'user', text: q }, { role: 'agent', text: si.reply });
      return sendJson({ type: 'answer', question: q, text: si.reply, spoken: si.reply, refused: false, citations: [], proofUrl: null, sendInfo: { status: si.status, ...(si.to ? { to: si.to } : {}) } });
    }
    let a;
    try { a = await ask(q); } catch (e) {
      return sendJson({ type: 'error', code: e.limit ? 'question_limit' : 'answer_failed', message: e.limit ? 'This session has reached its question limit. Start a new one to keep going.' : "Couldn't answer right now. Please try again." });
    }
    // product cards on screen (U8): say so rather than leave the details unspoken
    const onScreen = !a.refused && !phone && productList(a).length ? ` ${ON_SCREEN_LINE}` : '';
    const spoken = a.refused ? NOT_IN_DATA : `${formatSpoken(a, 450, { names, attribute: false })}${onScreen}`;
    transcript.push({ role: 'user', text: q }, { role: 'agent', text: spoken });
    sendJson({ type: 'answer', question: q, text: a.refused ? NOT_IN_DATA : a.answer, spoken, refused: !!a.refused, citations: citationChips(a), proofUrl: a.proofUrl || null, ...withProducts(a) });
  }

  // ---------------------------------------------------------------- gemini engine
  let runShared = null;
  async function runTool(call) {
    if (phone && call?.name === 'end_call') {
      // the simulated caller hears the goodbye, then the call ends (the browser hangs up once playback drains)
      sendJson({ type: 'hangup' });
      if (!hangupTimer) { hangupTimer = setTimeout(() => closeAll('hangup'), Number(cx.hangupFallbackMs || 15000)); hangupTimer.unref?.(); }
      return { status: 'ok', note: 'The call will end after your goodbye finishes playing.' };
    }
    if (call?.name === 'send_info' || call?.name === 'take_message') return runShared(call);
    if (call?.name !== 'search_knowledge_base') return { status: 'error', reason: `Unknown tool ${call?.name}` };
    if (!call.args?.query && userText.trim()) call.args = { ...call.args, query: userText.trim() };
    const query = String(call.args?.query || '').trim();
    searchedThisTurn = true;
    sendJson({ type: 'searching', query });
    return runShared(call);
  }
  function onGeminiMessage(msg) {
    if (msg.toolCall?.functionCalls?.length) {
      respondToTools(msg.toolCall.functionCalls, runTool, { asyncSearch, cancelled, send: (r) => session?.sendToolResponse(r), log: (m) => log(`[webvoice] ${sid} ${m}`) });
      return;
    }
    if (msg.toolCallCancellation?.ids) { for (const id of msg.toolCallCancellation.ids) cancelled.add(id); return; }
    const c = msg.serverContent;
    if (!c) return;
    if (c.inputTranscription?.text) {
      if (newTurn) { newTurn = false; searchedThisTurn = false; runShared?.newTurn?.(); }
      userText += c.inputTranscription.text;
      spec?.partial(userText);
      sendJson({ type: 'transcript', role: 'user', text: c.inputTranscription.text, delta: true });
    }
    if (c.outputTranscription?.text) { agentText += c.outputTranscription.text; sendJson({ type: 'transcript', role: 'agent', text: c.outputTranscription.text, delta: true }); }
    if (c.interrupted) sendJson({ type: 'interrupted' });
    for (const part of c.modelTurn?.parts || []) {
      const data = part.inlineData?.data;
      if (data && ws.readyState === 1) ws.send(Buffer.from(data, 'base64'));
    }
    if (c.turnComplete) {
      sendJson({ type: 'turn_complete' });
      if (!agentText.trim()) return; // a turn that only issued a tool call: keep the visitor's words for the answer turn
      // the facts guard: a figure said that is in none of the search results, the question or a read-back
      if (searchedThisTurn) {
        const figs = unsupportedFigures(agentText, [...(runShared?.allowed?.() || []), userText]);
        if (figs.length) {
          const ref = Math.random().toString(16).slice(2, 10);
          log(`[webvoice] ${sid} facts guard ref=${ref}: said ${figs.join(', ')} not in the facts`);
          const u = { question: userText.trim(), text: agentText.trim(), figures: figs, ref };
          unsupported.push(u);
          try { cx.onUnsupported?.(u); } catch (e) { log(`[webvoice] facts guard log failed: ${e.message}`); }
        }
      }
      if (userText.trim()) transcript.push({ role: 'user', text: userText.trim() });
      transcript.push({ role: 'agent', text: agentText.trim() });
      userText = ''; agentText = '';
      newTurn = true;
      spec?.endTurn();
    }
  }
  async function openGemini() {
    // "send me this": the browser has no caller number, so a text needs the number they say (and confirm)
    const sendInfo = cx.sendInfo && cx.sendInfoMedia ? { ...cx.sendInfoMedia, callerKnown: false } : null;
    // the phone simulator has no call to transfer: asking for a person becomes a callback request
    const transfer = takeMessages ? 'callback' : null;
    const s = await connectGemini(env, {
      systemInstruction: phone ? phoneSystemInstruction({ botName: cx.botName, org: cx.org, productLinks: false, sendInfo, asyncSearch, takeMessages, transfer, language: setup.language })
        : webSystemInstruction({ botName: cx.botName, org: cx.org, sendInfo, asyncSearch, takeMessages, language: setup.language }),
      tools: phone ? phoneToolDeclarations({ org: cx.org || cx.botName, productLinks: false, sendInfo, asyncSearch, takeMessages, transfer }) : webToolDeclarations({ org: cx.org || cx.botName, sendInfo, asyncSearch, takeMessages }),
      voice: setup.voice,
      onMessage: onGeminiMessage,
      onClose: () => { sessionReady = false; closeAll('model_closed'); },
      timeoutMs: Number(cx.geminiTimeoutMs || 10000),
    });
    if (closed) { s.close(); return null; }
    return s;
  }

  async function start(msg) {
    started = true;
    clearTimeout(startTimer);
    try {
      const who = await cx.authorize(typeof msg.key === 'string' ? msg.key.trim() : '');
      if (who?.keyId) callerKey = who.keyId;
    } catch (e) { return fail('unauthorized', e.message || 'This key is not valid for this bot.'); }
    if (closed) return;
    const busy = 'The voice assistant is busy right now. Please try again in a minute, or type your question.';
    if (active >= maxSessions || (activeByBot.get(botKey) || 0) >= maxPerBot) return fail('busy', busy, 1013);
    if (ipKey && (activeByIp.get(ipKey) || 0) >= maxPerIp) return fail('busy', 'You already have the voice assistant open in another tab or window. Close it and try again, or type your question.', 1013);
    active += 1; bump(activeByBot, botKey, 1); if (ipKey) bump(activeByIp, ipKey, 1); counted = true;
    lifeTimer = setTimeout(() => closeAll('time_limit'), maxSeconds * 1000);
    lifeTimer.unref?.();
    phone = msg.mode === 'phone';
    engine = msg.engine === 'text' ? 'text' : webVoiceEngine(env);
    let note;
    if (engine === 'gemini') {
      runShared = createToolRunner({ ask: (q) => askFor(q).then((a) => {
        sendJson({ type: 'citations', query: a.question, refused: !!a.refused, say: a.refused ? NOT_IN_DATA : formatSpoken(a, 450, { names, attribute: false }), citations: citationChips(a), proofUrl: a.proofUrl || null, ...withProducts(a), ...(a.instant ? { instant: true } : {}) });
        return a;
      }), sendInfo: cx.sendInfo ? (x) => cx.sendInfo({ ...x, callerKey }) : null, env, botName: cx.botName, org: cx.org, callSid: sid, log, getTranscript: () => transcript,
        sendMedia: cx.sendInfo ? cx.sendInfoMedia : null, onScreen: !phone, takeMessage: takeMessages ? (m) => cx.takeMessage({ ...m, callerKey }) : null });
      if (!/^(0|false|no|off)$/i.test(String(env.KNOWBOT_VOICE_SPECULATE ?? '1'))) {
        spec = createSpeculator({ run: (q) => ask(q, { speculative: true }), maxPerTurn: Math.max(1, Number(env.KNOWBOT_VOICE_SPECULATE_MAX) || 2), log: (m) => log(`${m} (${sid})`) });
      }
      try { session = await openGemini(); } catch (e) {
        log(`[webvoice] ${sid} Gemini Live unavailable (${e.message}); text engine`);
        engine = 'text'; note = 'Live voice is unavailable right now, so your browser recognizes and speaks instead.';
      }
      if (closed) return;
    }
    sendJson({ type: 'ready', engine, bot: { id: cx.botId, name: cx.botName || 'KnowBot' }, mode: phone ? 'phone' : 'web', greeting: (phone ? phoneGreeting : webGreeting)(cx.botName, cx.sendInfo ? cx.sendInfoMedia : null), input: { rate: 16000, encoding: 'pcm16le' }, output: { rate: 24000, encoding: 'pcm16le' }, maxSeconds, ...(note ? { note } : {}) });
    if (engine === 'gemini' && session) {
      sessionReady = true;
      session.sendText(phone ? '[call connected] A test call placed from the browser.' : '[visitor connected]');
      for (const d of pendingAudio.splice(0)) session.sendAudio(d);
    }
    log(`[webvoice] ${sid} started (bot ${cx.botId}, ${engine}${phone ? ', phone simulator' : ''})`);
  }

  ws.on('message', (raw, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (!started || engine === 'text') return;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (!buf.length || buf.length % 2) return; // PCM16 only
      const data = buf.toString('base64');
      if (sessionReady) session.sendAudio(data);
      else if (pendingAudio.length < 100) pendingAudio.push(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!started) {
      if (msg.type !== 'start') return fail('no_start', 'Send {"type":"start"} first.');
      start(msg).catch((e) => { log(`[webvoice] ${sid} start failed: ${e.message}`); fail('start_failed', "Couldn't start the voice assistant.", 1011); });
      return;
    }
    if (msg.type === 'stop') return closeAll('stopped');
    if (msg.type === 'text') {
      const text = String(msg.text || '').slice(0, 1000).trim();
      if (!text || !engine) return;
      if (engine === 'gemini' && sessionReady) { userText = text; sendJson({ type: 'transcript', role: 'user', text, delta: false }); session.sendText(text); return; }
      answerText(text);
    }
  });
  ws.on('close', () => closeAll('closed'));
  return { sid, transcript, get engine() { return engine; }, get speculation() { return spec ? { ...spec.stats } : null; } };
}

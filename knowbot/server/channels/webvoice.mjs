// Web voice assistant: a visitor talks to a bot from a browser mic widget (lib/voice-widget.js, or lib/embed.js with
// data-mode="voice") over ONE WebSocket, and hears the answer with its sources shown as on-screen chips.
//
//   GET /v1/bots/:botId/voice/live   (WebSocket upgrade; /api alias)  → this module (wired in devapi.mjs upgrade())
//
// Engines
//   gemini  (GEMINI_API_KEY set): voice-to-voice through Gemini Live. The browser streams 16 kHz PCM16 mono as binary
//           frames; the model's 24 kHz PCM16 speech comes back as binary frames. The model must call
//           search_knowledge_base, which runs the bot's OWN answer pipeline (devapi answer(): its sources and scope, the
//           librarian voice, the citation gate, the canonical refusal) and returns the answer already spoken with its
//           attribution ("According to the Shipping page, ..."). Each search also sends the citations to the browser.
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
//            {type:'searching', query}  {type:'citations', query, refused, say, citations:[{n,title,file,url?}], proofUrl}
//            {type:'answer', question, text, spoken, refused, citations, proofUrl}   (text engine)
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
  sendInfoInstruction, sendInfoDeclaration } from './voice-live.mjs';

export const MAX_QUESTIONS_PER_SESSION = 40;
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

export function webGreeting(botName, { offerSources = false } = {}) {
  return offerSources
    ? `Hi, I'm ${botName || 'KnowBot'}. I answer from my files, and I'm happy to send you the sources for anything I share by email or text before you go. What would you like to know?`
    : `Hi, I'm ${botName || 'KnowBot'}. I answer from my files, and the sources show on screen. What would you like to know?`;
}

export function webSystemInstruction({ botName, org, sendInfo = null }) {
  const who = botName || 'KnowBot';
  const orgName = org || botName || 'this business';
  return `You are ${who}, the voice assistant on ${orgName}'s website, speaking with a visitor through their browser microphone. You are a kind librarian: you answer only from ${orgName}'s own files. The visitor sees the sources on screen while you speak.

Grounding rules:
- Before answering ANY question, call search_knowledge_base. Write the query as a complete standalone question, filling in anything the visitor referred to earlier.
- The tool returns "say": the answer from the files, already worded to be spoken. Speak it as given, without saying where it comes from (no "According to ...": the sources are on screen${sendInfo && (sendInfo.email || sendInfo.text) ? ' and can be sent at the end' : ''}). If the visitor asks where something comes from, name it from "source_titles". You may leave out filler, but never change, round or add any fact, number, date, price or name.
- If the tool returns status "not_in_data", say exactly: "${NOT_IN_DATA}" Then offer to help with something else.
- Never answer from general knowledge, never guess, and never answer a question you did not search for.

Speaking style:
- Short replies; the visitor can ask a follow-up.
- Never read out file names, URLs, citation numbers or links (they are on screen).
- If the question is unclear, ask one short clarifying question.

Session flow:
- The session starts with the message "[visitor connected]". Greet the visitor with: "${webGreeting(botName, { offerSources: !!(sendInfo && (sendInfo.email || sendInfo.text)) })}"
- Typed messages from the visitor arrive as text; treat them exactly like spoken questions.${sendInfoInstruction(sendInfo, { who: 'visitor' })}`;
}

export function webToolDeclarations({ org, sendInfo = null }) {
  return [{ functionDeclarations: [
    { name: 'search_knowledge_base', description: `Search ${org || 'this business'}'s own files and get the answer to speak, with its source. Required before answering any question.`,
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A complete, standalone question in plain English.' } }, required: ['query'] } },
    ...(sendInfo && (sendInfo.email || sendInfo.text) ? [sendInfoDeclaration()] : []),
  ] }];
}

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

  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const closeAll = (reason = 'closed', code = 1000) => {
    if (closed) return;
    closed = true;
    clearTimeout(startTimer); clearTimeout(lifeTimer); clearTimeout(hangupTimer);
    try { session?.close(); } catch {}
    if (counted) { active -= 1; bump(activeByBot, botKey, -1); if (ipKey) bump(activeByIp, ipKey, -1); counted = false; }
    sendJson({ type: 'end', reason });
    if (ws.readyState === 1) ws.close(code, reason);
    cx.onEnd?.({ sid, engine, transcript, questions });
  };
  const fail = (code, message, wsCode = 1008) => { sendJson({ type: 'error', code, message }); closeAll(code, wsCode); };
  const startTimer = setTimeout(() => { if (!started) fail('no_start', 'Send {"type":"start"} first.'); }, Number(cx.startTimeoutMs || 10000));
  startTimer.unref?.();
  let lifeTimer = null;

  // the bot's own pipeline; every answer is counted against the session's question budget
  async function ask(q) {
    questions += 1;
    if (questions > MAX_QUESTIONS_PER_SESSION) throw Object.assign(new Error('question limit reached'), { limit: true });
    return cx.ask(String(q || '').slice(0, 1000), { callerKey });
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
    const spoken = a.refused ? NOT_IN_DATA : formatSpoken(a, 450, { names, attribute: false });
    transcript.push({ role: 'user', text: q }, { role: 'agent', text: spoken });
    sendJson({ type: 'answer', question: q, text: a.refused ? NOT_IN_DATA : a.answer, spoken, refused: !!a.refused, citations: citationChips(a), proofUrl: a.proofUrl || null });
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
    if (call?.name === 'send_info') return runShared(call);
    if (call?.name !== 'search_knowledge_base') return { status: 'error', reason: `Unknown tool ${call?.name}` };
    if (!call.args?.query && userText.trim()) call.args = { ...call.args, query: userText.trim() };
    const query = String(call.args?.query || '').trim();
    sendJson({ type: 'searching', query });
    return runShared(call);
  }
  function onGeminiMessage(msg) {
    if (msg.toolCall?.functionCalls?.length) {
      Promise.all(msg.toolCall.functionCalls.map(async (call) => {
        let response;
        try { response = await runTool(call); } catch (e) { response = { status: 'error', reason: e.message }; }
        return { id: call.id, name: call.name, response };
      })).then((functionResponses) => { try { session?.sendToolResponse(functionResponses); } catch (e) { log(`[webvoice] ${sid} tool response failed: ${e.message}`); } });
      return;
    }
    const c = msg.serverContent;
    if (!c) return;
    if (c.inputTranscription?.text) { userText += c.inputTranscription.text; sendJson({ type: 'transcript', role: 'user', text: c.inputTranscription.text, delta: true }); }
    if (c.outputTranscription?.text) { agentText += c.outputTranscription.text; sendJson({ type: 'transcript', role: 'agent', text: c.outputTranscription.text, delta: true }); }
    if (c.interrupted) sendJson({ type: 'interrupted' });
    for (const part of c.modelTurn?.parts || []) {
      const data = part.inlineData?.data;
      if (data && ws.readyState === 1) ws.send(Buffer.from(data, 'base64'));
    }
    if (c.turnComplete) {
      sendJson({ type: 'turn_complete' });
      if (!agentText.trim()) return; // a turn that only issued a tool call: keep the visitor's words for the answer turn
      if (userText.trim()) transcript.push({ role: 'user', text: userText.trim() });
      transcript.push({ role: 'agent', text: agentText.trim() });
      userText = ''; agentText = '';
    }
  }
  async function openGemini() {
    // "send me this": the browser has no caller number, so a text needs the number they say (and confirm)
    const sendInfo = cx.sendInfo && cx.sendInfoMedia ? { ...cx.sendInfoMedia, callerKnown: false } : null;
    const s = await connectGemini(env, {
      systemInstruction: phone ? phoneSystemInstruction({ botName: cx.botName, org: cx.org, productLinks: false, sendInfo }) : webSystemInstruction({ botName: cx.botName, org: cx.org, sendInfo }),
      tools: phone ? phoneToolDeclarations({ org: cx.org || cx.botName, productLinks: false, sendInfo }) : webToolDeclarations({ org: cx.org || cx.botName, sendInfo }),
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
      runShared = createToolRunner({ ask: (q) => ask(q).then((a) => {
        sendJson({ type: 'citations', query: a.question, refused: !!a.refused, say: a.refused ? NOT_IN_DATA : formatSpoken(a, 450, { names, attribute: false }), citations: citationChips(a), proofUrl: a.proofUrl || null });
        return a;
      }), sendInfo: cx.sendInfo ? (x) => cx.sendInfo({ ...x, callerKey }) : null, env, botName: cx.botName, org: cx.org, callSid: sid, log, getTranscript: () => transcript });
      try { session = await openGemini(); } catch (e) {
        log(`[webvoice] ${sid} Gemini Live unavailable (${e.message}); text engine`);
        engine = 'text'; note = 'Live voice is unavailable right now, so your browser recognizes and speaks instead.';
      }
      if (closed) return;
    }
    sendJson({ type: 'ready', engine, bot: { id: cx.botId, name: cx.botName || 'KnowBot' }, mode: phone ? 'phone' : 'web', greeting: phone ? phoneGreeting(cx.botName, { offerSources: !!(cx.sendInfo && cx.sendInfoMedia && (cx.sendInfoMedia.email || cx.sendInfoMedia.text)) }) : webGreeting(cx.botName, { offerSources: !!(cx.sendInfo && cx.sendInfoMedia && (cx.sendInfoMedia.email || cx.sendInfoMedia.text)) }), input: { rate: 16000, encoding: 'pcm16le' }, output: { rate: 24000, encoding: 'pcm16le' }, maxSeconds, ...(note ? { note } : {}) });
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
  return { sid, transcript, get engine() { return engine; } };
}

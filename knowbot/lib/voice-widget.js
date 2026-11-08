// KnowBot web voice assistant: a browser mic widget that talks to a bot over one WebSocket
// (GET <api>/v1/bots/:botId/voice/live, server/channels/webvoice.mjs) and speaks the answers back, with the sources shown
// as chips (links) while it speaks.
//
//   <script type="module" src=".../lib/embed.js" data-mode="voice" data-api="https://host/api" data-bot="acme"></script>
//   or: import { mountVoice } from '.../lib/voice-widget.js'; mountVoice('#target' | null, { apiBase, bot, key?, name? })
//
// Engines (the server decides, the widget follows):
//   gemini: voice to voice. The mic streams 16 kHz PCM16 mono; the bot's voice comes back as 24 kHz PCM16 and is played
//           here; captions come from the model's own transcription.
//   text:   the browser recognizes speech (Web Speech API) or the visitor types; the cited answer is read aloud with
//           speechSynthesis.
// Accessibility: tap-to-talk (toggle) and hold-to-talk (pointer or Space/Enter held on the mic button), a visible
// transcript (role=log), live captions, every mic/permission error explained in words, typed input always available,
// prefers-reduced-motion honoured, light and dark.

const CSS = `
:host{all:initial;--bg:#fff;--card:#fff;--ink:#0f172a;--mute:#5b6476;--line:#e3e6ee;--acc:#4f46e5;--acc-ink:#fff;--accbg:#eef0ff;--bad:#b91c1c;--badbg:#fef2f2;--ok:#047857;
  font:15px/1.5 Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink)}
@media (prefers-color-scheme:dark){:host{--bg:#0b1020;--card:#111831;--ink:#e7eaf3;--mute:#a3abc2;--line:#232c47;--acc:#a5b4fc;--acc-ink:#0b1020;--accbg:#1b2147;--bad:#fca5a5;--badbg:#3b1219;--ok:#34d399}}
*{box-sizing:border-box}
.launch{position:fixed;bottom:20px;right:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:0;background:var(--acc);color:var(--acc-ink);cursor:pointer;box-shadow:0 6px 24px rgba(15,23,42,.25);display:grid;place-items:center}
.launch.left{right:auto;left:20px}
.panel{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:16px;display:flex;flex-direction:column;gap:10px;padding:14px;width:100%;max-width:420px}
.float{position:fixed;bottom:88px;right:20px;z-index:2147483000;width:min(380px,calc(100vw - 32px));max-height:min(620px,calc(100vh - 110px));box-shadow:0 12px 40px rgba(15,23,42,.28)}
.float.left{right:auto;left:20px}
.inline{max-width:none}
.head{display:flex;align-items:center;gap:8px}
.title{font-weight:600;flex:1;margin:0;font-size:15px}
.badge{font-size:12px;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.x{border:0;background:none;color:var(--mute);cursor:pointer;font-size:20px;line-height:1;padding:4px 6px;border-radius:8px}
.status{font-size:13px;color:var(--mute);min-height:1.5em;margin:0}
.err{font-size:13px;color:var(--bad);background:var(--badbg);border-radius:10px;padding:8px 10px;margin:0}
.err[hidden]{display:none}
.controls{display:flex;align-items:center;gap:12px}
.mic{position:relative;width:64px;height:64px;flex:none;border-radius:50%;border:2px solid var(--acc);background:var(--accbg);color:var(--acc);cursor:pointer;display:grid;place-items:center;touch-action:none;user-select:none;-webkit-user-select:none}
.mic[aria-pressed=true],.mic.live{background:var(--acc);color:var(--acc-ink)}
.mic:disabled{opacity:.5;cursor:not-allowed}
.mic .ring{position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--acc);opacity:0;transform:scale(calc(1 + var(--lvl,0) * .25));transition:transform .08s linear,opacity .2s}
.mic.live .ring{opacity:.5}
.modes{display:flex;flex-direction:column;gap:2px;font-size:13px;border:0;margin:0;padding:0}
.modes legend{font-size:12px;color:var(--mute);padding:0;margin-bottom:2px}
.modes label{display:flex;gap:6px;align-items:center;cursor:pointer}
.caption{min-height:2.6em;font-size:16px;line-height:1.45;margin:0;padding:8px 10px;border-radius:10px;background:var(--accbg)}
.caption:empty::before{content:attr(data-empty);color:var(--mute);font-size:13px}
.log{list-style:none;margin:0;padding:0;overflow:auto;max-height:220px;display:flex;flex-direction:column;gap:6px;font-size:14px}
.log li{padding:6px 10px;border-radius:10px;border:1px solid var(--line)}
.log li.user{align-self:flex-end;background:var(--accbg);border-color:transparent;max-width:85%}
.log li.agent{align-self:flex-start;max-width:95%}
.who{display:block;font-size:11px;color:var(--mute);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.chips:empty{display:none}
.chip{display:inline-flex;gap:6px;align-items:center;font-size:13px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;color:var(--ink);text-decoration:none;background:var(--card)}
a.chip:hover,a.chip:focus-visible{border-color:var(--acc);color:var(--acc)}
.chip b{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--acc)}
.chip.speaking{animation:kbv-glow 1.6s ease-in-out infinite}
@keyframes kbv-glow{50%{border-color:var(--acc)}}
.form{display:flex;gap:6px}
.form input{flex:1;min-width:0;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.form button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:8px 12px;background:var(--acc);color:var(--acc-ink);cursor:pointer}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.mic .ring{transition:none;transform:none}.chip.speaking{animation:none;border-color:var(--acc)}}
`;

const MIC_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const SR_CTOR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;

/** Plain words for a getUserMedia / SpeechRecognition failure. */
export function micErrorMessage(e) {
  const name = String(e?.name || e?.error || e || '');
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'The microphone only works on secure (https) pages. You can still type your question below.';
  if (/NotAllowed|not-allowed|Permission|service-not-allowed/i.test(name)) return 'Microphone access is blocked. Allow the microphone for this site (the icon in the address bar), then press the mic again. You can also type your question below.';
  if (/Security/i.test(name)) return 'This page is not allowed to use the microphone (for example inside a frame without permission). Type your question below instead.';
  if (/NotFound|audio-capture|Overconstrained/i.test(name)) return 'No microphone was found. Connect one and press the mic again, or type your question below.';
  if (/NotReadable|Abort/i.test(name)) return 'Your microphone is busy in another app or tab. Close it there and press the mic again, or type your question below.';
  if (/no-speech/i.test(name)) return "I didn't hear anything. Press the mic and speak, or type your question below.";
  if (/network/i.test(name)) return "Your browser's speech recognition needs a network connection. Type your question below instead.";
  return "The microphone couldn't start. Type your question below instead.";
}

/** Float32 samples at `from` Hz → Int16 PCM at `to` Hz (box-filter decimation; fine for speech). */
export function downsampleToPcm16(input, from, to = 16000) {
  if (from === to) { const o = new Int16Array(input.length); for (let i = 0; i < input.length; i++) o[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff; return o; }
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += input[j];
    const v = b > a ? s / (b - a) : input[a] || 0;
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
const plain = (s) => String(s || '').replace(/\[(\d{1,3})\]/g, '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Mounts the voice assistant.
 * @param {string|Element|null} target  inline host; null = floating launcher button
 * @param {object} o
 * @param {string} [o.apiBase]   e.g. https://host/api (the socket is <apiBase>/v1/bots/<bot>/voice/live, ws/wss)
 * @param {string} [o.endpoint]  the full ws(s):// URL instead
 * @param {string} o.bot         bot id
 * @param {string} [o.key]       kb_trial_/kb_live_ key (a trial bot needs one; a launched bot is public)
 * @param {string} [o.name]      shown name
 * @param {'toggle'|'hold'} [o.talk]  default talk mode
 * @param {'left'|'right'} [o.position]
 * @param {boolean} [o.open]
 * @param {string} [o.lang]      recognition / synthesis language (text engine), default the page's
 * @param {'auto'|'text'} [o.engine]
 */
export function mountVoice(target, o = {}) {
  const host = typeof target === 'string' ? document.querySelector(target) : target;
  const inline = !!host;
  const root = el('div', { class: 'knowbot-voice' });
  (host || document.body).append(root);
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.append(el('style', { text: CSS }));
  const name = o.name || 'KnowBot';
  const lang = o.lang || document.documentElement.lang || navigator.language || 'en-US';
  const left = o.position === 'left';
  const uid = Math.random().toString(36).slice(2, 8);
  let talk = o.talk === 'hold' ? 'hold' : 'toggle';

  // ------------------------------------------------------------ DOM
  const status = el('p', { class: 'status', role: 'status', 'aria-live': 'polite', text: 'Press the mic and ask a question, or type it below.' });
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  const badge = el('span', { class: 'badge', text: 'voice' });
  const ring = el('span', { class: 'ring', 'aria-hidden': 'true' });
  const mic = el('button', { class: 'mic', type: 'button', 'aria-pressed': 'false', 'aria-describedby': `kbv-hint-${uid}`, html: MIC_SVG });
  mic.prepend(ring);
  const micLabel = el('span', { class: 'sr' });
  mic.append(micLabel);
  const hint = el('span', { id: `kbv-hint-${uid}`, class: 'sr' });
  const modes = el('fieldset', { class: 'modes' }, el('legend', { text: 'Microphone' }));
  for (const [v, label] of [['toggle', 'Tap to talk'], ['hold', 'Hold to talk']]) {
    const r = el('input', { type: 'radio', name: `kbv-talk-${uid}`, value: v, checked: v === talk, onchange: () => { talk = v; stopListening(); paintMic(); } });
    modes.append(el('label', null, r, document.createTextNode(label)));
  }
  const caption = el('p', { class: 'caption', 'aria-live': 'off', 'data-empty': 'Captions appear here while I speak.' });
  const chips = el('ul', { class: 'chips', 'aria-label': 'Sources for this answer' });
  const log = el('ol', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Transcript' });
  const input = el('input', { type: 'text', placeholder: 'Or type a question…', 'aria-label': `Question for ${name}`, maxlength: '1000', autocomplete: 'off' });
  const form = el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ''; askTyped(t); } }, input, el('button', { type: 'submit', text: 'Ask' }));
  const closeBtn = inline ? null : el('button', { class: 'x', type: 'button', 'aria-label': 'Close the voice assistant', text: '×', onclick: () => setOpen(false) });
  const panel = el('section', { class: `panel ${inline ? 'inline' : `float${left ? ' left' : ''}`}`, role: 'region', 'aria-label': `${name} voice assistant`, hidden: !inline && !o.open },
    el('div', { class: 'head' }, el('h2', { class: 'title', text: name }), badge, closeBtn),
    status, err,
    el('div', { class: 'controls' }, mic, hint, modes),
    caption, chips, log, form);
  const launcher = inline ? null : el('button', { class: `launch${left ? ' left' : ''}`, type: 'button', 'aria-expanded': String(!!o.open), 'aria-label': `Talk to ${name}`, html: MIC_SVG, onclick: () => setOpen(panel.hidden) });
  shadow.append(panel);
  if (launcher) shadow.append(launcher);
  function setOpen(v) {
    panel.hidden = !v;
    launcher?.setAttribute('aria-expanded', String(v));
    if (v) mic.focus(); else { stopAll(); launcher?.focus(); }
  }

  const say = (s) => { status.textContent = s; };
  const showErr = (s) => { err.textContent = s || ''; err.hidden = !s; };
  function addLog(role, text) {
    const li = el('li', { class: role }, el('span', { class: 'who', text: role === 'user' ? 'You' : name }), document.createTextNode(text));
    log.append(li);
    log.scrollTop = log.scrollHeight;
    return li;
  }
  function showChips(list, proofUrl, refused) {
    chips.textContent = '';
    if (refused) { chips.append(el('li', { class: 'chip', text: 'Not in my sources' })); return; }
    for (const c of list || []) {
      const href = c.url || proofUrl || null;
      const inner = [el('b', { text: String(c.n) }), document.createTextNode(c.title || c.file || 'Source')];
      const chip = href ? el('a', { class: 'chip speaking', href, target: '_blank', rel: 'noopener noreferrer', title: c.url ? 'Open the source page' : 'See the quoted lines' }, ...inner, el('span', { class: 'sr', text: ' (opens in a new tab)' }))
        : el('span', { class: 'chip speaking' }, ...inner);
      chips.append(el('li', null, chip));
    }
  }
  const stopChipGlow = () => { for (const c of chips.querySelectorAll('.speaking')) c.classList.remove('speaking'); };

  // ------------------------------------------------------------ socket
  let ws = null, engine = null, readyP = null, listening = false;
  const endpoint = () => {
    if (o.endpoint) return o.endpoint;
    const base = String(o.apiBase || location.origin).replace(/\/+$/, '').replace(/^http/, 'ws');
    return `${base}/v1/bots/${encodeURIComponent(o.bot || '')}/voice/live`;
  };
  function connect() {
    if (readyP) return readyP;
    readyP = new Promise((resolve, reject) => {
      let s;
      try { s = new WebSocket(endpoint()); } catch (e) { readyP = null; return reject(e); }
      s.binaryType = 'arraybuffer';
      ws = s;
      say('Connecting…');
      let ready = false;
      s.addEventListener('open', () => s.send(JSON.stringify({ type: 'start', ...(o.key ? { key: o.key } : {}), ...(o.engine === 'text' ? { engine: 'text' } : {}) })));
      s.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return playPcm(ev.data);
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'ready') {
          ready = true; engine = m.engine;
          badge.textContent = engine === 'gemini' ? 'live voice' : 'browser voice';
          say(m.note || (engine === 'gemini' ? 'Connected. Speak when the mic is on.' : 'Connected.'));
          if (engine === 'text') addLog('agent', m.greeting);
          paintMic();
          return resolve(m);
        }
        onServer(m);
      });
      s.addEventListener('close', (e) => {
        const wasReady = ready;
        ws = null; readyP = null; engine = null;
        stopListening(); stopSpeaking();
        if (!wasReady) { reject(new Error(e.code === 1006 ? 'unreachable' : 'refused')); return; }
        if (!err.textContent) say('Disconnected. Press the mic or ask a question to start again.');
      });
      s.addEventListener('error', () => { if (!ready) say(''); });
    }).catch((e) => {
      readyP = null;
      if (!err.textContent || err.hidden) showErr(e.message === 'unreachable' ? "Couldn't reach the voice assistant. Check your connection and try again, or type your question." : "The voice assistant didn't start. Please try again.");
      say('');
      throw e;
    });
    return readyP;
  }
  const sendJson = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

  let userLine = null, agentLine = null, agentText = '';
  function onServer(m) {
    switch (m.type) {
      case 'transcript':
        if (m.role === 'user') {
          if (!userLine) { userLine = addLog('user', ''); }
          userLine.lastChild.textContent = m.delta ? userLine.lastChild.textContent + m.text : m.text;
        } else {
          agentText += m.text;
          caption.textContent = agentText.trim();
          if (!agentLine) agentLine = addLog('agent', '');
          agentLine.lastChild.textContent = agentText.trim();
        }
        break;
      case 'searching': say('Looking in my sources…'); break;
      case 'citations': showChips(m.citations, m.proofUrl, m.refused); say(m.refused ? 'Not in my sources.' : 'Answering from my sources.'); break;
      case 'answer': {
        if (!m.refused) showChips(m.citations, m.proofUrl, false); else showChips([], null, true);
        addLog('agent', plain(m.text));
        speak(m.spoken);
        break;
      }
      case 'interrupted': stopSpeaking(); break;
      case 'turn_complete':
        if (agentText.trim()) { userLine = null; agentLine = null; agentText = ''; }
        setTimeout(stopChipGlow, 400);
        if (engine === 'gemini') say(listening ? 'Listening…' : 'Press the mic to talk.');
        break;
      case 'error': showErr(m.message || 'Something went wrong.'); break;
      case 'end':
        if (m.reason === 'time_limit') say('This voice session reached its time limit. Press the mic to start a new one.');
        break;
      default:
    }
  }

  // ------------------------------------------------------------ audio out (gemini engine)
  let outCtx = null, playHead = 0;
  const playing = new Set();
  function ctxOut() {
    if (!outCtx) { const C = window.AudioContext || window.webkitAudioContext; outCtx = new C(); }
    if (outCtx.state === 'suspended') outCtx.resume().catch(() => {});
    return outCtx;
  }
  function playPcm(buf) {
    const ctx = ctxOut();
    const pcm = new Int16Array(buf.byteLength >> 1);
    new Uint8Array(pcm.buffer).set(new Uint8Array(buf, 0, pcm.length * 2));
    if (!pcm.length) return;
    const ab = ctx.createBuffer(1, pcm.length, 24000);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = ab; src.connect(ctx.destination);
    playHead = Math.max(playHead, ctx.currentTime + 0.02);
    src.start(playHead);
    playHead += ab.duration;
    playing.add(src);
    src.onended = () => playing.delete(src);
  }
  function stopSpeaking() {
    for (const s of playing) { try { s.stop(); } catch {} }
    playing.clear();
    playHead = 0;
    try { window.speechSynthesis?.cancel(); } catch {}
    agentText = ''; agentLine = null;
    stopChipGlow();
  }

  // ------------------------------------------------------------ speech out (text engine)
  function speak(text) {
    caption.textContent = text || '';
    const synth = window.speechSynthesis;
    if (!synth || !text) { setTimeout(stopChipGlow, 1500); return; }
    try { synth.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const vs = synth.getVoices?.() || [];
    u.voice = vs.find((v) => v.lang?.startsWith(lang.slice(0, 2)) && /Google|Natural|Neural/i.test(v.name)) || vs.find((v) => v.lang?.startsWith(lang.slice(0, 2))) || null;
    u.onend = () => stopChipGlow();
    synth.speak(u);
  }

  // ------------------------------------------------------------ mic in
  let media = null, inCtx = null, node = null, srcNode = null, rec = null, levelRaf = 0;
  async function startMicStream() {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no mic api'), { name: window.isSecureContext === false ? 'SecurityError' : 'NotFoundError' });
    media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const C = window.AudioContext || window.webkitAudioContext;
    inCtx = new C();
    srcNode = inCtx.createMediaStreamSource(media);
    const rate = inCtx.sampleRate;
    let pending = [];
    let pendingLen = 0;
    const flushAt = 1600; // 100 ms at 16 kHz
    const onFrame = (f32) => {
      let peak = 0;
      for (let i = 0; i < f32.length; i += 8) peak = Math.max(peak, Math.abs(f32[i]));
      mic.style.setProperty('--lvl', Math.min(1, peak * 3).toFixed(2));
      if (!listening) return;
      const pcm = downsampleToPcm16(f32, rate, 16000);
      pending.push(pcm); pendingLen += pcm.length;
      if (pendingLen >= flushAt) {
        const out = new Int16Array(pendingLen);
        let off = 0; for (const p of pending) { out.set(p, off); off += p.length; }
        pending = []; pendingLen = 0;
        if (ws?.readyState === 1) ws.send(out.buffer);
      }
    };
    // ScriptProcessor works everywhere (an AudioWorklet would need a separate module URL, often blocked by page CSP)
    node = inCtx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0));
    srcNode.connect(node);
    const sink = inCtx.createGain(); sink.gain.value = 0;
    node.connect(sink); sink.connect(inCtx.destination);
  }
  function stopMicStream() {
    try { node && (node.onaudioprocess = null); srcNode?.disconnect(); node?.disconnect(); } catch {}
    try { media?.getTracks().forEach((t) => t.stop()); } catch {}
    try { inCtx?.close(); } catch {}
    media = inCtx = node = srcNode = null;
    mic.style.setProperty('--lvl', '0');
  }
  function sendSilence(ms = 700) { if (ws?.readyState === 1) ws.send(new Int16Array(Math.round(16 * ms)).buffer); }

  async function startListening() {
    showErr('');
    if (listening) return;
    stopSpeaking(); // barge in
    try { await connect(); } catch { return; }
    if (engine === 'gemini') {
      try { if (!media) await startMicStream(); } catch (e) { stopMicStream(); showErr(micErrorMessage(e)); paintMic(); return; }
      listening = true;
      say(talk === 'hold' ? 'Listening… release to send.' : 'Listening… press the mic again to stop.');
    } else {
      if (!SR_CTOR) { showErr("This browser can't recognize speech. Type your question below and I'll read the answer aloud."); return; }
      rec = new SR_CTOR();
      rec.lang = lang; rec.interimResults = true; rec.continuous = talk === 'hold'; rec.maxAlternatives = 1;
      let finalText = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t; else interim += t; }
        caption.textContent = (finalText + interim).trim();
      };
      rec.onerror = (e) => { if (e.error !== 'aborted') showErr(micErrorMessage(e)); };
      rec.onend = () => { const t = finalText.trim(); rec = null; listening = false; paintMic(); if (t) askTyped(t); else if (!err.textContent) say('Press the mic and ask a question.'); };
      try { rec.start(); } catch (e) { showErr(micErrorMessage(e)); rec = null; return; }
      listening = true;
      say(talk === 'hold' ? 'Listening… release to send.' : 'Listening… I stop when you pause.');
    }
    paintMic();
  }
  function stopListening() {
    if (!listening) return;
    listening = false;
    if (engine === 'gemini') { sendSilence(); stopMicStream(); say('Thinking…'); }
    else if (rec) { try { rec.stop(); } catch {} }
    paintMic();
  }
  function stopAll() { stopListening(); stopSpeaking(); stopMicStream(); }

  async function askTyped(text) {
    showErr('');
    stopSpeaking();
    try { await connect(); } catch { return; }
    const li = addLog('user', text);
    if (engine === 'gemini') userLine = li; // the server echoes typed text as a (non-delta) user transcript
    sendJson({ type: 'text', text });
    say('Looking in my sources…');
  }

  function paintMic() {
    const unavailable = engine === 'text' && !SR_CTOR;
    mic.disabled = unavailable;
    mic.classList.toggle('live', listening);
    if (talk === 'toggle') mic.setAttribute('aria-pressed', String(listening)); else mic.removeAttribute('aria-pressed');
    micLabel.textContent = unavailable ? 'Microphone unavailable in this browser' : talk === 'hold' ? `Hold to talk to ${name}` : listening ? 'Stop talking' : `Talk to ${name}`;
    hint.textContent = talk === 'hold' ? 'Hold the button, or hold Space or Enter while it is focused, and release to send.' : 'Press to start talking, press again to stop.';
  }

  // tap (toggle) and hold (push-to-talk): pointer and keyboard
  let holding = false;
  mic.addEventListener('click', (e) => {
    if (talk !== 'toggle') { e.preventDefault(); return; }
    if (listening) stopListening(); else startListening();
  });
  mic.addEventListener('pointerdown', (e) => { if (talk !== 'hold' || holding) return; holding = true; mic.setPointerCapture?.(e.pointerId); startListening(); });
  const release = () => { if (talk !== 'hold' || !holding) return; holding = false; stopListening(); };
  mic.addEventListener('pointerup', release);
  mic.addEventListener('pointercancel', release);
  mic.addEventListener('keydown', (e) => {
    if (talk !== 'hold' || (e.key !== ' ' && e.key !== 'Enter')) return;
    e.preventDefault();
    if (!e.repeat && !holding) { holding = true; startListening(); }
  });
  mic.addEventListener('keyup', (e) => { if (talk === 'hold' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); release(); } });
  shadow.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !inline) setOpen(false); });

  if (typeof window !== 'undefined' && window.isSecureContext === false) showErr('The microphone only works on secure (https) pages. You can still type your question below.');
  paintMic();

  return {
    el: root,
    open: () => setOpen(true),
    close: () => setOpen(false),
    ask: (t) => askTyped(String(t || '')),
    stop() { stopAll(); sendJson({ type: 'stop' }); try { ws?.close(); } catch {} },
    destroy() { this.stop(); try { outCtx?.close(); } catch {} root.remove(); },
    get engine() { return engine; },
  };
}

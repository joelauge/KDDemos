// KnowBot Studio: the phone simulator. A phone on the page you can call: it rings, the bot picks up with the REAL phone
// greeting and prompt, you talk (or type) and it answers out loud with its sources, and it can hang up when you say
// goodbye. No phone number and no Twilio: the call runs over the web voice socket in phone mode
// (GET <api>/v1/bots/:id/voice/live, {type:'start', mode:'phone'}; server/channels/webvoice.mjs).
//
//   import { mountPhone } from './phonesim.js?v=2114138';
//   const sim = mountPhone(el, { endpoint, key, botName, number?, starters? });   sim.stop()
//
// Engines (the server decides): gemini = voice to voice (16 kHz PCM16 up, 24 kHz PCM16 down, full duplex like a real
// call: no push-to-talk); text = the browser recognizes speech (Web Speech API) and reads the cited answer aloud.
// Typing is always available ("Type instead"), so the simulator works without a microphone too.

const CSS = `
.ps{--ps-bg:#0b0d12;--ps-ink:#f4f6fb;--ps-mute:#9aa3b5;--ps-key:#1c2030;--ps-key-on:#e9ecf4;--ps-green:#22c55e;--ps-red:#ef4444;--ps-acc:#a5b4fc;
  display:flex;flex-direction:column;align-items:center;gap:10px;font:14px/1.45 var(--font,Inter,system-ui,sans-serif)}
.ps-device{position:relative;width:min(300px,100%);aspect-ratio:9/18.5;max-height:600px;border-radius:42px;padding:10px;background:#20232c;
  box-shadow:0 0 0 1px rgba(255,255,255,.06) inset,0 18px 40px rgba(15,23,42,.28)}
.ps-screen{position:relative;height:100%;border-radius:33px;overflow:hidden;background:radial-gradient(120% 70% at 50% 0%,#1f2547 0%,var(--ps-bg) 62%);color:var(--ps-ink);display:flex;flex-direction:column}
.ps-notch{position:absolute;top:8px;left:50%;transform:translateX(-50%);width:84px;height:22px;border-radius:12px;background:#000;z-index:2}
.ps-status{display:flex;justify-content:space-between;align-items:center;padding:12px 22px 0;font:600 12px/1 var(--font,system-ui);color:var(--ps-ink);height:30px;flex:none}
.ps-status i{display:inline-flex;gap:2px;align-items:flex-end;height:10px}.ps-status i b{width:3px;background:var(--ps-ink);border-radius:1px}
.ps-view{flex:1;display:flex;flex-direction:column;align-items:center;padding:14px 18px 18px;min-height:0}
.ps-view[hidden]{display:none}
.ps-avatar{width:76px;height:76px;border-radius:50%;display:grid;place-items:center;font:600 26px/1 var(--font,system-ui);color:#0b1020;background:linear-gradient(135deg,#c7d2fe,#a5f3fc);position:relative;flex:none}
.ps-avatar::after{content:"";position:absolute;inset:-8px;border-radius:50%;border:2px solid var(--ps-acc);opacity:0;transform:scale(calc(1 + var(--lvl,0)*.18));transition:transform .08s linear,opacity .25s}
.ps.is-talking .ps-avatar::after{opacity:.55}
.ps-name{margin:10px 0 0;font:600 20px/1.2 var(--font,system-ui);text-align:center}
.ps-sub{margin:4px 0 0;color:var(--ps-mute);font-size:13px;text-align:center;min-height:1.4em}
.ps-num{margin:14px 0 6px;font:500 24px/1.2 var(--mono,ui-monospace,monospace);letter-spacing:.02em;min-height:1.3em;text-align:center}
.ps-pad{display:grid;grid-template-columns:repeat(3,58px);gap:10px 18px;justify-content:center;margin:6px 0 10px}
.ps-pad button{width:58px;height:58px;border-radius:50%;border:0;background:var(--ps-key);color:var(--ps-ink);font:500 22px/1 var(--font,system-ui);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ps-pad button small{font:600 8px/1 var(--font,system-ui);letter-spacing:.14em;color:var(--ps-mute);margin-top:2px;min-height:8px}
.ps-pad button:active{background:#2c3248}
.ps-call,.ps-end{width:64px;height:64px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;color:#fff;flex:none}
.ps-call{background:var(--ps-green)}.ps-end{background:var(--ps-red)}
.ps-call svg,.ps-end svg{width:28px;height:28px}
.ps-end svg{transform:rotate(135deg)}
.ps-call:focus-visible,.ps-end:focus-visible,.ps-pad button:focus-visible,.ps-ctl:focus-visible,.ps-type button:focus-visible,.ps-again:focus-visible{outline:3px solid var(--ps-acc);outline-offset:3px}
.ps-ring .ps-avatar{animation:ps-pulse 1.4s ease-in-out infinite}
@keyframes ps-pulse{0%,100%{box-shadow:0 0 0 0 rgba(165,180,252,.45)}50%{box-shadow:0 0 0 16px rgba(165,180,252,0)}}
.ps-caps{width:100%;flex:1;min-height:0;overflow:auto;margin:12px 0 8px;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin}
.ps-cap{margin:0;padding:7px 10px;border-radius:14px;font-size:13px;line-height:1.4;max-width:92%}
.ps-cap.you{align-self:flex-end;background:#2d3550;color:var(--ps-ink);border-bottom-right-radius:4px}
.ps-cap.bot{align-self:flex-start;background:#161b2b;color:var(--ps-ink);border:1px solid #262d44;border-bottom-left-radius:4px}
.ps-cap.sys{align-self:center;background:none;color:var(--ps-mute);font-size:12px;text-align:center}
.ps-srcs{display:flex;flex-wrap:wrap;gap:5px;width:100%;margin:0 0 8px}
.ps-srcs:empty{display:none}
.ps-src{font-size:11.5px;color:var(--ps-ink);background:#1b2140;border:1px solid #2e3763;border-radius:999px;padding:2px 9px;text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a.ps-src:hover{border-color:var(--ps-acc)}
.ps-ctls{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;width:100%;margin:2px 0 12px}
.ps-ctl{display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:0;color:var(--ps-ink);font:500 10.5px/1 var(--font,system-ui);cursor:pointer;padding:0}
.ps-ctl span{width:48px;height:48px;border-radius:50%;background:var(--ps-key);display:grid;place-items:center}
.ps-ctl svg{width:20px;height:20px}
.ps-ctl[aria-pressed=true] span{background:var(--ps-key-on);color:#0b0d12}
.ps-type{display:flex;gap:6px;width:100%;margin:0 0 10px}
.ps-type[hidden]{display:none}
.ps-type input{flex:1;min-width:0;border-radius:999px;border:1px solid #2e3550;background:#121626;color:var(--ps-ink);padding:8px 12px;font:inherit;font-size:13px}
.ps-type button{border:0;border-radius:999px;background:var(--ps-acc);color:#0b1020;font:600 12.5px/1 var(--font,system-ui);padding:0 12px;cursor:pointer}
.ps-err{width:100%;margin:0 0 8px;padding:7px 10px;border-radius:10px;background:#3b1219;color:#fecaca;font-size:12.5px}
.ps-err[hidden]{display:none}
.ps-sum{width:100%;margin:12px 0;display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--ps-mute);overflow:auto}
.ps-sum b{color:var(--ps-ink)}
.ps-again{margin-top:auto;border:0;border-radius:999px;background:var(--ps-green);color:#fff;font:600 14px/1 var(--font,system-ui);padding:12px 22px;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
.ps-again svg{width:18px;height:18px}
.ps-hint{max-width:320px;margin:0;text-align:center;color:var(--muted,#5b6476);font-size:12.5px}
.ps-starters{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-width:340px}
.ps-starters button{border:1px solid var(--line,#e3e6ee);background:var(--panel,#fff);color:var(--strong,#0f172a);border-radius:999px;padding:4px 10px;font:500 12px/1.3 var(--font,system-ui);cursor:pointer}
.ps-starters[hidden]{display:none}
.ps-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.ps-ring .ps-avatar{animation:none}.ps-avatar::after{transition:none}}
`;

const SVG = {
  phone: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/></svg>',
  pad: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="6" cy="5" r="1.6"/><circle cx="12" cy="5" r="1.6"/><circle cx="18" cy="5" r="1.6"/><circle cx="6" cy="11" r="1.6"/><circle cx="12" cy="11" r="1.6"/><circle cx="18" cy="11" r="1.6"/><circle cx="6" cy="17" r="1.6"/><circle cx="12" cy="17" r="1.6"/><circle cx="18" cy="17" r="1.6"/><circle cx="12" cy="22" r="1.4"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
};
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
const SR_CTOR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const initials = (s) => String(s || 'KB').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'KB';
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');

function injectCss() {
  if (document.getElementById('ps-css')) return;
  const s = document.createElement('style');
  s.id = 'ps-css'; s.textContent = CSS;
  document.head.append(s);
}

/** 48/44.1 kHz float → 16 kHz PCM16 (the same downsampler the web voice widget uses). */
function toPcm16(input, from, to = 16000) {
  if (from === to) { const o = new Int16Array(input.length); for (let i = 0; i < input.length; i++) o[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff; return o; }
  const ratio = from / to, n = Math.floor(input.length / ratio), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b; j++) sum += input[j];
    out[i] = Math.max(-1, Math.min(1, sum / Math.max(1, b - a))) * 0x7fff;
  }
  return out;
}
function micMessage(e) {
  const n = e && (e.name || e.error);
  if (n === 'NotAllowedError' || n === 'not-allowed' || n === 'SecurityError' || n === 'service-not-allowed') return 'Microphone access is blocked. Allow it in your browser to talk, or tap Type to type what you would say.';
  if (n === 'NotFoundError' || n === 'audio-capture') return 'No microphone was found. Tap Type to type what you would say.';
  if (n === 'network') return "Speech recognition couldn't reach its service. Tap Type to type instead.";
  return "The microphone didn't start. Tap Type to type what you would say.";
}

/**
 * @param {HTMLElement} host
 * @param {{endpoint: string, key?: string, botName?: string, number?: string, starters?: string[], onCall?: (e: object) => void}} o
 */
export function mountPhone(host, o = {}) {
  injectCss();
  const name = o.botName || 'Your bot';
  const number = o.number || '';
  const st = { phase: 'idle', ws: null, engine: null, t0: 0, timer: 0, ringT: 0, muted: false, speaker: true, typing: false, stopped: false,
    media: null, inCtx: null, node: null, src: null, outCtx: null, gain: null, playHead: 0, playing: new Set(), ring: null, rec: null, recOn: false,
    hangupWanted: false, questions: [], sources: new Map(), botLine: null, youLine: null, botText: '', speaking: false, lvlRaf: 0 };

  // ---------------------------------------------------------------- views
  const root = h('div', { class: 'ps' });
  const status = h('div', { class: 'ps-status', 'aria-hidden': 'true' }, h('span', { class: 'ps-clock' }, clock()),
    h('i', null, h('b', { style: 'height:4px' }), h('b', { style: 'height:6px' }), h('b', { style: 'height:8px' }), h('b', { style: 'height:10px' })));
  const live = h('p', { class: 'ps-sr', role: 'status', 'aria-live': 'polite' });

  // dial
  const numEl = h('p', { class: 'ps-num', 'aria-label': 'Number' }, number);
  const pad = h('div', { class: 'ps-pad', role: 'group', 'aria-label': 'Keypad' }, KEYS.map(([k, l]) => h('button', { type: 'button', 'aria-label': k, onclick: () => press(k) }, k, h('small', null, l))));
  const callBtn = h('button', { type: 'button', class: 'ps-call', 'aria-label': `Call ${name}`, html: SVG.phone, onclick: () => call() });
  const dial = h('div', { class: 'ps-view ps-dial' },
    h('div', { class: 'ps-avatar', 'aria-hidden': 'true' }, initials(name)),
    h('p', { class: 'ps-name' }, name), h('p', { class: 'ps-sub' }, number ? 'Your KnowBot phone line' : 'Test call · no phone needed'),
    numEl, pad, callBtn);

  // in call
  const callName = h('p', { class: 'ps-name' }, name);
  const callSub = h('p', { class: 'ps-sub' }, 'Calling…');
  const errEl = h('p', { class: 'ps-err', hidden: true, role: 'alert' });
  const caps = h('div', { class: 'ps-caps', role: 'log', 'aria-label': 'Call captions', 'aria-live': 'polite' });
  const srcs = h('div', { class: 'ps-srcs', 'aria-label': 'Sources used on this call' });
  const typeIn = h('input', { type: 'text', placeholder: 'Type what you would say…', 'aria-label': 'What you would say', autocomplete: 'off', maxlength: '500' });
  const typeForm = h('form', { class: 'ps-type', hidden: true }, typeIn, h('button', { type: 'submit' }, 'Say'));
  typeForm.addEventListener('submit', (e) => { e.preventDefault(); const t = typeIn.value.trim(); if (t) { typeIn.value = ''; sayText(t); } });
  const ctl = (label, svg, onclick) => h('button', { type: 'button', class: 'ps-ctl', 'aria-pressed': 'false', onclick }, h('span', { html: svg }), label);
  const muteBtn = ctl('Mute', SVG.micOff, () => setMute(!st.muted));
  const padBtn = ctl('Keypad', SVG.pad, () => { const on = padBtn.getAttribute('aria-pressed') !== 'true'; padBtn.setAttribute('aria-pressed', String(on)); callPad.hidden = !on; });
  const spkBtn = ctl('Speaker', SVG.speaker, () => setSpeaker(!st.speaker));
  const typeBtn = ctl('Type', SVG.type, () => setTyping(!st.typing));
  spkBtn.setAttribute('aria-pressed', 'true');
  const callPad = h('div', { class: 'ps-pad', hidden: true, role: 'group', 'aria-label': 'Keypad' }, KEYS.map(([k, l]) => h('button', { type: 'button', 'aria-label': k, onclick: () => tone(k) }, k, h('small', null, l))));
  const endBtn = h('button', { type: 'button', class: 'ps-end', 'aria-label': 'Hang up', html: SVG.phone, onclick: () => hangUp('you') });
  const inCall = h('div', { class: 'ps-view ps-incall', hidden: true },
    h('div', { class: 'ps-avatar', 'aria-hidden': 'true' }, initials(name)), callName, callSub,
    caps, srcs, errEl, typeForm, callPad, h('div', { class: 'ps-ctls' }, muteBtn, padBtn, spkBtn, typeBtn), endBtn);

  // ended
  const sum = h('div', { class: 'ps-sum' });
  const again = h('button', { type: 'button', class: 'ps-again', onclick: () => { show('dial'); callBtn.focus(); } }, h('span', { html: SVG.phone }), 'Call again');
  const ended = h('div', { class: 'ps-view ps-ended', hidden: true },
    h('div', { class: 'ps-avatar', 'aria-hidden': 'true' }, initials(name)), h('p', { class: 'ps-name' }, name), h('p', { class: 'ps-sub ps-ended-sub' }, 'Call ended'), sum, again);

  const screen = h('div', { class: 'ps-screen' }, h('div', { class: 'ps-notch', 'aria-hidden': 'true' }), status, dial, inCall, ended);
  const device = h('div', { class: 'ps-device', role: 'group', 'aria-label': `Phone simulator: call ${name}` }, screen);
  const starters = h('div', { class: 'ps-starters', hidden: true, 'aria-label': 'Things to ask' });
  const hint = h('p', { class: 'ps-hint' }, 'Press the green button to call. Talk like you would on a real call; the bot answers out loud and names its sources. Say goodbye and it hangs up.');
  root.append(device, starters, hint, live);
  host.append(root);
  const clockT = setInterval(() => { const c = status.querySelector('.ps-clock'); if (c) c.textContent = clock(); }, 20000);

  function show(v) {
    dial.hidden = v !== 'dial'; inCall.hidden = v !== 'call'; ended.hidden = v !== 'ended';
    root.classList.toggle('ps-ring', v === 'call' && st.phase === 'ringing');
  }
  function say(t) { live.textContent = t; }
  function press(k) { tone(k); if (numEl.textContent.length < 16) numEl.textContent += k; }

  // ---------------------------------------------------------------- tones (keypad, ringback)
  function audioOut() {
    if (!st.outCtx) { const C = window.AudioContext || window.webkitAudioContext; st.outCtx = new C(); st.gain = st.outCtx.createGain(); st.gain.gain.value = st.speaker ? 1 : 0.35; st.gain.connect(st.outCtx.destination); }
    if (st.outCtx.state === 'suspended') st.outCtx.resume().catch(() => {});
    return st.outCtx;
  }
  const DTMF = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477], 7: [852, 1209], 8: [852, 1336], 9: [852, 1477], '*': [941, 1209], 0: [941, 1336], '#': [941, 1477] };
  function tone(k) {
    try {
      const ctx = audioOut(), g = ctx.createGain(); g.gain.value = 0.06; g.connect(st.gain);
      for (const f of DTMF[k] || []) { const osc = ctx.createOscillator(); osc.frequency.value = f; osc.connect(g); osc.start(); osc.stop(ctx.currentTime + 0.14); }
    } catch { /* no audio */ }
  }
  /** North American ringback: 440 + 480 Hz, 2 s on, 4 s off. */
  function ringback() {
    try {
      const ctx = audioOut(), g = ctx.createGain(); g.gain.value = 0; g.connect(st.gain);
      const oscs = [440, 480].map((f) => { const x = ctx.createOscillator(); x.frequency.value = f; x.connect(g); x.start(); return x; });
      const t = ctx.currentTime;
      for (let i = 0; i < 4; i++) { g.gain.setValueAtTime(0.05, t + i * 6); g.gain.setValueAtTime(0, t + i * 6 + 2); }
      st.ring = { stop: () => { try { g.gain.cancelScheduledValues(0); g.gain.value = 0; oscs.forEach((x) => x.stop()); g.disconnect(); } catch { /* ignore */ } } };
    } catch { st.ring = null; }
  }
  const stopRing = () => { st.ring?.stop(); st.ring = null; };

  // ---------------------------------------------------------------- captions + sources
  function addCap(who, text) {
    const p = h('p', { class: `ps-cap ${who}` }, text);
    caps.append(p); caps.scrollTop = caps.scrollHeight;
    return p;
  }
  function addSources(list) {
    for (const c of list || []) {
      const k = c.url || c.title || c.file; if (!k || st.sources.has(k)) continue;
      st.sources.set(k, c);
      srcs.append(c.url ? h('a', { class: 'ps-src', href: c.url, target: '_blank', rel: 'noopener noreferrer', title: c.title || c.url }, c.title || c.url)
        : h('span', { class: 'ps-src', title: c.file || c.title }, c.title || c.file));
    }
  }
  function showErr(t) { errEl.textContent = t || ''; errEl.hidden = !t; }

  // ---------------------------------------------------------------- the call
  async function call() {
    if (st.phase !== 'idle' && st.phase !== 'ended') return;
    st.phase = 'ringing'; st.questions = []; st.sources.clear(); st.hangupWanted = false; st.botText = ''; st.botLine = st.youLine = null;
    caps.textContent = ''; srcs.textContent = ''; showErr(''); setTyping(false); setMute(false);
    callSub.textContent = 'Calling…';
    show('call'); root.classList.add('ps-ring');
    say(`Calling ${name}`);
    o.onCall?.({ type: 'dial' });
    audioOut(); ringback();
    endBtn.focus();
    // the bot "picks up" after at least one ring, and once the line is ready
    const minRing = new Promise((r) => { st.ringT = setTimeout(r, 2600); });
    let ready;
    try { ready = await Promise.all([connect(), minRing]).then(([m]) => m); } catch (e) {
      if (st.phase !== 'ringing') return;
      stopRing(); root.classList.remove('ps-ring');
      callSub.textContent = 'Call failed';
      addCap('sys', e && e.message === 'busy' ? 'The line is busy right now. Try again in a minute.' : e && e.message === 'unauthorized' ? "This bot's test key isn't valid any more. Refresh the page and try again." : "Couldn't connect the call. Check your connection and try again.");
      st.phase = 'ended'; finish(true);
      return;
    }
    if (st.phase !== 'ringing') return;
    stopRing(); root.classList.remove('ps-ring');
    st.phase = 'live'; st.t0 = Date.now();
    callSub.textContent = '00:00';
    st.timer = setInterval(() => { callSub.textContent = mmss(Date.now() - st.t0); }, 500);
    say(`Connected to ${name}`);
    o.onCall?.({ type: 'connected', engine: st.engine });
    if (st.engine === 'gemini') {
      try { await startMic(); } catch (e) { showErr(micMessage(e)); setTyping(true); }
    } else {
      addCap('bot', ready.greeting || `Hi, you've reached ${name}.`);
      speak(ready.greeting || '', () => listenText());
      if (!SR_CTOR) { showErr("This browser can't recognize speech. Tap Type to type what you would say."); setTyping(true); }
    }
  }

  function connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(o.endpoint); } catch { reject(new Error('unreachable')); return; }
      ws.binaryType = 'arraybuffer';
      st.ws = ws;
      let ready = false;
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start', mode: 'phone', ...(o.key ? { key: o.key } : {}) })));
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') { if (st.phase === 'live' || st.phase === 'ringing') play(ev.data); return; }
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (!ready && m.type === 'ready') { ready = true; st.engine = m.engine; resolve(m); return; }
        if (!ready && m.type === 'error') { reject(new Error(m.code === 'busy' ? 'busy' : m.code === 'unauthorized' ? 'unauthorized' : 'refused')); return; }
        onServer(m);
      });
      ws.addEventListener('close', () => {
        st.ws = null;
        if (!ready) { reject(new Error('unreachable')); return; }
        if (st.phase === 'live') hangUp(st.hangupWanted ? 'bot' : 'line');
      });
    });
  }
  const send = (m) => { if (st.ws && st.ws.readyState === 1) st.ws.send(typeof m === 'string' || m instanceof ArrayBuffer ? m : JSON.stringify(m)); };

  function onServer(m) {
    switch (m.type) {
      case 'transcript':
        if (m.role === 'user') {
          if (!st.youLine) st.youLine = addCap('you', '');
          st.youLine.textContent = m.delta ? st.youLine.textContent + m.text : m.text;
          if (!m.delta) noteQuestion(m.text);
        } else {
          if (st.youLine && st.youLine.textContent.trim()) noteQuestion(st.youLine.textContent);
          st.youLine = null;
          st.botText += m.text;
          if (!st.botLine) st.botLine = addCap('bot', '');
          st.botLine.textContent = st.botText.trim();
          caps.scrollTop = caps.scrollHeight;
        }
        break;
      case 'searching': callSub.textContent = `${mmss(Date.now() - st.t0)} · looking it up…`; break;
      case 'citations': addSources(m.citations); break;
      case 'answer':
        // text engine: the cited answer, spoken by the browser
        addSources(m.citations);
        addCap('bot', m.spoken || m.text);
        speak(m.spoken || m.text, () => listenText());
        break;
      case 'interrupted': stopPlayback(); break;
      case 'turn_complete': st.botText = ''; st.botLine = null; break;
      case 'hangup': st.hangupWanted = true; whenQuiet(() => hangUp('bot')); break;
      case 'error': if (m.code !== 'busy') addCap('sys', m.message || 'Something went wrong on the line.'); break;
      case 'end': if (st.phase === 'live') whenQuiet(() => hangUp(m.reason === 'time_limit' ? 'limit' : st.hangupWanted ? 'bot' : 'line')); break;
      default:
    }
  }
  function noteQuestion(t) { const q = String(t || '').trim(); if (q && st.questions[st.questions.length - 1] !== q) st.questions.push(q); }

  // ---------------------------------------------------------------- audio (gemini engine)
  function play(buf) {
    const ctx = audioOut();
    const pcm = new Int16Array(buf.byteLength >> 1);
    new Uint8Array(pcm.buffer).set(new Uint8Array(buf, 0, pcm.length * 2));
    if (!pcm.length) return;
    const ab = ctx.createBuffer(1, pcm.length, 24000);
    const ch = ab.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { ch[i] = pcm[i] / 0x8000; if (i % 16 === 0) peak = Math.max(peak, Math.abs(ch[i])); }
    const src = ctx.createBufferSource();
    src.buffer = ab; src.connect(st.gain);
    st.playHead = Math.max(st.playHead, ctx.currentTime + 0.03);
    src.start(st.playHead);
    st.playHead += ab.duration;
    st.playing.add(src);
    root.classList.add('is-talking'); root.style.setProperty('--lvl', Math.min(1, peak * 2.5).toFixed(2));
    src.onended = () => { st.playing.delete(src); if (!st.playing.size) { root.classList.remove('is-talking'); root.style.setProperty('--lvl', '0'); } };
  }
  function stopPlayback() {
    for (const s of st.playing) { try { s.stop(); } catch { /* ignore */ } }
    st.playing.clear(); st.playHead = 0;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    root.classList.remove('is-talking');
  }
  /** Run fn once the bot has finished speaking (queued audio played out, browser speech done). */
  function whenQuiet(fn) {
    const t0 = Date.now();
    const tick = () => {
      if (st.phase !== 'live') return;
      const audioLeft = st.outCtx ? st.playHead - st.outCtx.currentTime : 0;
      const busy = st.playing.size > 0 || audioLeft > 0.05 || (window.speechSynthesis && window.speechSynthesis.speaking);
      if (busy && Date.now() - t0 < 15000) setTimeout(tick, 200); else setTimeout(fn, 300);
    };
    tick();
  }
  async function startMic() {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no mic'), { name: window.isSecureContext === false ? 'SecurityError' : 'NotFoundError' });
    st.media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (st.phase !== 'live') { stopMic(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    st.inCtx = new C();
    st.src = st.inCtx.createMediaStreamSource(st.media);
    const rate = st.inCtx.sampleRate;
    let pending = [], len = 0;
    st.node = st.inCtx.createScriptProcessor(4096, 1, 1);
    st.node.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      // muted: keep the line open with silence, like a muted phone
      const pcm = st.muted ? new Int16Array(Math.floor(f32.length * 16000 / rate)) : toPcm16(f32, rate, 16000);
      pending.push(pcm); len += pcm.length;
      if (len >= 1600) { const out = new Int16Array(len); let off = 0; for (const p of pending) { out.set(p, off); off += p.length; } pending = []; len = 0; send(out.buffer); }
    };
    st.src.connect(st.node);
    const sink = st.inCtx.createGain(); sink.gain.value = 0; st.node.connect(sink); sink.connect(st.inCtx.destination);
  }
  function stopMic() {
    try { if (st.node) st.node.onaudioprocess = null; st.src?.disconnect(); st.node?.disconnect(); } catch { /* ignore */ }
    try { st.media?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { st.inCtx?.close(); } catch { /* ignore */ }
    st.media = st.inCtx = st.node = st.src = null;
  }

  // ---------------------------------------------------------------- text engine (browser speech)
  function speak(text, then) {
    const synth = window.speechSynthesis;
    if (!synth || !text) { then && setTimeout(then, 200); return; }
    try { synth.cancel(); } catch { /* ignore */ }
    const u = new SpeechSynthesisUtterance(text);
    u.volume = st.speaker ? 1 : 0.4;
    const vs = synth.getVoices?.() || [];
    u.voice = vs.find((v) => /^en/.test(v.lang) && /Google|Natural|Neural/i.test(v.name)) || vs.find((v) => /^en/.test(v.lang)) || null;
    root.classList.add('is-talking'); root.style.setProperty('--lvl', '0.5');
    u.onend = u.onerror = () => { root.classList.remove('is-talking'); root.style.setProperty('--lvl', '0'); then && then(); };
    synth.speak(u);
  }
  function listenText() {
    if (st.phase !== 'live' || st.engine !== 'text' || !SR_CTOR || st.muted || st.typing || st.recOn) return;
    const rec = new SR_CTOR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    let fin = '', line = null;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t; else interim += t; }
      if (!line) line = addCap('you', '');
      line.textContent = (fin + interim).trim();
    };
    rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') showErr(micMessage(e)); };
    rec.onend = () => {
      st.recOn = false; st.rec = null;
      const t = fin.trim();
      if (st.phase !== 'live') return;
      if (t) { noteQuestion(t); send({ type: 'text', text: t }); callSub.textContent = `${mmss(Date.now() - st.t0)} · looking it up…`; }
      else setTimeout(listenText, 300);
    };
    try { rec.start(); st.rec = rec; st.recOn = true; } catch (e) { showErr(micMessage(e)); }
  }
  function sayText(t) {
    if (st.phase !== 'live') return;
    noteQuestion(t);
    if (st.engine === 'gemini') { stopPlayback(); st.youLine = addCap('you', t); send({ type: 'text', text: t }); }
    else { try { st.rec?.abort(); } catch { /* ignore */ } addCap('you', t); send({ type: 'text', text: t }); }
  }

  // ---------------------------------------------------------------- controls
  function setMute(on) {
    st.muted = !!on; muteBtn.setAttribute('aria-pressed', String(st.muted));
    if (st.muted && st.rec) { try { st.rec.abort(); } catch { /* ignore */ } }
    if (!st.muted) listenText();
  }
  function setSpeaker(on) { st.speaker = !!on; spkBtn.setAttribute('aria-pressed', String(st.speaker)); if (st.gain) st.gain.gain.value = st.speaker ? 1 : 0.35; }
  function setTyping(on) {
    st.typing = !!on; typeBtn.setAttribute('aria-pressed', String(st.typing)); typeForm.hidden = !st.typing;
    if (st.typing) { try { st.rec?.abort(); } catch { /* ignore */ } setTimeout(() => typeIn.focus(), 0); } else listenText();
  }

  // ---------------------------------------------------------------- hang up + summary
  function hangUp(by) {
    if (st.phase !== 'live' && st.phase !== 'ringing') return;
    const wasLive = st.phase === 'live';
    st.phase = 'ended';
    clearTimeout(st.ringT); stopRing(); clearInterval(st.timer);
    try { st.rec?.abort(); } catch { /* ignore */ }
    stopMic(); stopPlayback();
    if (st.ws) { try { send({ type: 'stop' }); st.ws.close(); } catch { /* ignore */ } st.ws = null; }
    root.classList.remove('ps-ring');
    o.onCall?.({ type: 'ended', by, seconds: wasLive ? Math.round((Date.now() - st.t0) / 1000) : 0, questions: st.questions.length });
    finish(!wasLive, by);
  }
  function finish(failed, by) {
    const dur = st.t0 && !failed ? mmss(Date.now() - st.t0) : '00:00';
    ended.querySelector('.ps-ended-sub').textContent = failed ? 'Call failed' : `Call ended · ${dur}${by === 'bot' ? ' · the bot hung up' : by === 'limit' ? ' · time limit' : ''}`;
    sum.textContent = '';
    if (!failed) {
      sum.append(h('p', null, h('b', null, String(st.questions.length)), st.questions.length === 1 ? ' question asked' : ' questions asked'));
      if (st.sources.size) {
        sum.append(h('p', null, h('b', null, 'Answered from')));
        const list = h('div', { class: 'ps-srcs' }); for (const c of st.sources.values()) list.append(c.url ? h('a', { class: 'ps-src', href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.title || c.url) : h('span', { class: 'ps-src' }, c.title || c.file));
        sum.append(list);
      }
      sum.append(h('p', null, 'Every question also shows up in your question insights.'));
    } else {
      const last = caps.lastChild; if (last) sum.append(h('p', null, last.textContent));
    }
    st.t0 = 0;
    show('ended');
    say(failed ? 'Call failed' : `Call ended after ${dur}`);
    setTimeout(() => { if (!st.stopped) again.focus(); }, 0);
  }

  if (Array.isArray(o.starters) && o.starters.length) {
    starters.hidden = false;
    starters.append(h('span', { class: 'ps-sr' }, 'Try asking:'), ...o.starters.slice(0, 3).map((q) => h('button', { type: 'button', title: 'Say this on the call', onclick: () => { if (st.phase === 'live') sayText(q); else call(); } }, q)));
  }

  show('dial');
  return {
    el: root,
    call,
    stop() {
      st.stopped = true;
      if (st.phase === 'live' || st.phase === 'ringing') hangUp('you');
      clearInterval(clockT);
      try { st.outCtx?.close(); } catch { /* ignore */ }
      root.remove();
    },
  };
}

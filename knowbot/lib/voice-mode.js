// KnowBot voice mode: talk to a bot hands-free, with an audio-reactive orb (./voice-orb.js) that shows it is hearing you
// and speaking back, live captions, a transcript, the sources as links, and one clear way out (End, or Esc).
// An answer that cites products shows their cards under the captions: the web chat's own cards (lib/widget.js
// productCardsHtml and its .kb-products styles from lib/knowbot.css, loaded the first time a product answer arrives);
// the other sources stay a plain line of chips. Cards are shown, never read aloud (nor are any URLs).
// It is a mode of the Homepage search (site/overlay.js) and of web chat (KnowBot Studio's chat, lib/widget.js): those
// surfaces show a mic button that opens it in place.
//
//   import { openVoiceMode } from '.../lib/voice-mode.js';
//   const vm = openVoiceMode(hostElement, { endpoint: 'wss://…/v1/bots/<bot>/voice/live', key?, name, orb: 'ocean',
//                                           theme?: 'light'|'dark'|'auto', onClose?, onTurn? });
//   vm.stop();   vm.ask('typed question');   vm.state   vm.orb
//
// One WebSocket to the bot's voice session (server/channels/webvoice.mjs). The server decides the engine:
//   live voice: the mic streams 16 kHz PCM16 continuously (the model hears when you stop talking); the answer comes back
//               as 24 kHz PCM16 and is played here; captions come from the session's own transcription.
//   browser:    the browser recognizes speech (one utterance at a time, restarted after each answer) and reads the cited
//               answer aloud; the orb still follows the mic while listening.
// Orb states: connecting → listening (the mic level) → thinking (searching the sources) → speaking (the bot's audio level;
// with browser speech, a level that follows the spoken words) → listening. Muted: idle.
// Works inside a Shadow DOM (its styles travel with it) and in a light-DOM page (every class is kbvm- prefixed).

import { createOrb, createMeter, orbId, ORB_PRESETS } from './voice-orb.js?v=357231d';
import { micErrorMessage, downsampleToPcm16 } from './voice-widget.js?v=357231d';

const CSS = `
.kbvm{--vm-ink:#15151f;--vm-text:#33333f;--vm-mute:#5f6170;--vm-line:#dadce3;--vm-soft:#f4f4f7;--vm-bg:#fff;--vm-acc:var(--kbvm-accent,#4f46e5);--vm-on-acc:var(--kbvm-on-accent,#fff);--vm-bad:#b91c1c;--vm-badbg:#fef2f2;--vm-end:#b91c1c;
  position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;min-width:0;margin:0 auto;text-align:center;color:var(--vm-text);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box}
.kbvm *,.kbvm *::before,.kbvm *::after{box-sizing:border-box}
.kbvm[data-theme=dark]{--vm-ink:#f4f4f8;--vm-text:#d4d4de;--vm-mute:#a8aabb;--vm-line:#3a3a4c;--vm-soft:#22222e;--vm-bg:#15151f;--vm-acc:var(--kbvm-accent-dark,#a5b4fc);--vm-on-acc:var(--kbvm-on-accent-dark,#15151f);--vm-bad:#fca5a5;--vm-badbg:#3b1219;--vm-end:#fca5a5}
@media (prefers-color-scheme:dark){.kbvm[data-theme=auto]{--vm-ink:#f4f4f8;--vm-text:#d4d4de;--vm-mute:#a8aabb;--vm-line:#3a3a4c;--vm-soft:#22222e;--vm-bg:#15151f;--vm-acc:var(--kbvm-accent-dark,#a5b4fc);--vm-on-acc:var(--kbvm-on-accent-dark,#15151f);--vm-bad:#fca5a5;--vm-badbg:#3b1219;--vm-end:#fca5a5}}
.kbvm:focus{outline:none}
.kbvm :focus-visible{outline:3px solid var(--vm-acc);outline-offset:2px}
.kbvm [hidden]{display:none!important}
.kbvm-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.kbvm-stage{position:relative;width:var(--kbvm-size,min(240px,62vw));aspect-ratio:1/1;flex:none;margin:0 auto}
.kbvm-orb{display:block;width:100%;height:100%}
.kbvm-state{margin:0;min-height:1.5em;font-size:15px;font-weight:600;color:var(--vm-mute)}
.kbvm-cap{margin:0;max-width:36em;min-height:2.9em;font-size:19px;line-height:1.45;color:var(--vm-ink);overflow-wrap:anywhere}
.kbvm-cap.is-user{color:var(--vm-mute);font-style:italic}
.kbvm-cap:empty::before{content:attr(data-empty);color:var(--vm-mute);font-size:15px;font-style:normal}
.kbvm-err{margin:0;max-width:34em;padding:8px 12px;border-radius:10px;background:var(--vm-badbg);color:var(--vm-bad);font-size:14px}
.kbvm-chips{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin:0;padding:0;list-style:none;max-width:36em}
.kbvm-chips:empty{display:none}
.kbvm-chip{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 12px;border:1px solid var(--vm-line);border-radius:999px;background:var(--vm-bg);color:var(--vm-ink);font-size:14px;text-decoration:none}
a.kbvm-chip:hover{border-color:var(--vm-acc)}
.kbvm-chip b{font-size:12px;color:var(--vm-acc)}
.kbvm-ctrl{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:4px}
.kbvm .kbvm-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;min-width:48px;padding:0 18px;border:1px solid var(--vm-line);border-radius:999px;background:var(--vm-bg);color:var(--vm-ink);font:inherit;font-weight:600;font-size:15px;cursor:pointer}
.kbvm .kbvm-btn:hover{background:var(--vm-soft)}
.kbvm .kbvm-btn[aria-pressed=true]{background:var(--vm-soft);border-color:var(--vm-mute)}
.kbvm .kbvm-end{color:var(--vm-end);border-color:currentColor}
.kbvm-btn svg{flex:none}
.kbvm-type{display:flex;gap:6px;width:100%;max-width:30em}
.kbvm .kbvm-type input{flex:1;min-width:0;min-height:44px;padding:0 14px;border:1px solid var(--vm-line);border-radius:999px;background:var(--vm-bg);color:var(--vm-ink);font:inherit;font-size:16px}
.kbvm-type input::placeholder{color:var(--vm-mute);opacity:1}
.kbvm .kbvm-type button{min-height:44px;padding:0 16px;border:0;border-radius:999px;background:var(--vm-acc);color:var(--vm-on-acc);font:inherit;font-weight:700;cursor:pointer}
.kbvm-tr{width:100%;max-width:36em;text-align:left;font-size:14px}
.kbvm-tr summary{display:inline-flex;align-items:center;gap:4px;min-height:44px;padding:0 6px;color:var(--vm-mute);cursor:pointer}
.kbvm-log{list-style:none;margin:0;padding:0;max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.kbvm-log li{padding:6px 10px;border-radius:10px;border:1px solid var(--vm-line);overflow-wrap:anywhere}
.kbvm-log li.user{align-self:flex-end;background:var(--vm-soft);border-color:transparent;max-width:85%}
.kbvm-who{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--vm-mute)}
.kbvm-hint{margin:0;font-size:13px;color:var(--vm-mute)}
.kbvm-prods{width:100%;max-width:36em;min-width:0;text-align:left}
.kbvm-prods:empty{display:none}
.kbvm .kb-products{--kb-line:var(--vm-line);--kb-panel:var(--vm-bg);--kb-bg:var(--vm-soft);--kb-raise:var(--vm-soft);--kb-text:var(--vm-text);--kb-head:var(--vm-ink);--kb-mute:var(--vm-mute);--kb-dim:var(--vm-mute);--kb-accent:var(--vm-acc);--kb-accent-line:var(--vm-acc);--kb-font:inherit;
  width:fit-content;max-width:100%;margin:0 auto}
.kbvm .kb-products li{flex-basis:116px;width:116px}
`;

const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>',
  end: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const icon = (n, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const SR_CTOR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;
// a URL is never read aloud or captioned (the cards and the source chips carry the links)
const noUrls = (s) => String(s || '').replace(/\(\s*(?:https?:\/\/|www\.)[^\s)]*\s*\)/gi, '').replace(/\b(?:https?:\/\/|www\.)[^\s)\]]+/gi, '').replace(/\s+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
/** The page a link points at (host without www, path without a trailing slash): a product card and its source chip match on it. */
const pageKey = (u) => { try { const x = new URL(String(u)); return `${x.hostname.toLowerCase().replace(/^www\./, '')}${decodeURIComponent(x.pathname).toLowerCase().replace(/\/+$/, '')}`; } catch { return null; } };
const plain = (s) => String(s || '').replace(/\[(\d{1,3})\]/g, '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1').replace(/[*_`#]/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

/**
 * Opens voice mode inside `host` (appended; the caller hides what it replaces).
 * @param {Element} host
 * @param {object} o
 * @param {string} o.endpoint   ws(s):// URL of the bot's voice session (…/v1/bots/<bot>/voice/live)
 * @param {string} [o.key]      a key the session accepts (a trial bot needs one; a launched bot is public)
 * @param {string} [o.name]     the bot's or business's name
 * @param {string} [o.orb]      ORB_PRESETS id
 * @param {'light'|'dark'|'auto'} [o.theme]
 * @param {'auto'|'text'} [o.engine]
 * @param {string} [o.lang]
 * @param {number|string} [o.size]  the orb's CSS size (default min(240px, 62vw))
 * @param {() => void} [o.onClose]   after End / Esc / stop()
 * @param {(t: {question: string, answer: string, citations: object[], proofUrl: string|null, refused: boolean, products: object[]}) => void} [o.onTurn]
 */
export function openVoiceMode(host, o = {}) {
  const name = String(o.name || 'KnowBot');
  const lang = o.lang || document.documentElement.lang || navigator.language || 'en-US';
  const uid = Math.random().toString(36).slice(2, 8);
  const preset = orbId(o.orb);

  // ------------------------------------------------------------------------------------------------ DOM
  const canvas = el('canvas', { class: 'kbvm-orb', 'aria-hidden': 'true' });
  const stage = el('div', { class: 'kbvm-stage', 'data-orb': preset }, canvas);
  if (o.size) stage.style.setProperty('--kbvm-size', typeof o.size === 'number' ? `${o.size}px` : String(o.size));
  const status = el('p', { class: 'kbvm-state', role: 'status', 'aria-live': 'polite', text: 'Connecting…' });
  const caption = el('p', { class: 'kbvm-cap', 'aria-live': 'off', 'data-empty': 'Start talking whenever you are ready.' });
  const err = el('p', { class: 'kbvm-err', role: 'alert', hidden: true });
  const chips = el('ul', { class: 'kbvm-chips', 'aria-label': 'Sources for this answer' });
  const prods = el('div', { class: 'kbvm-prods' });
  const muteLabel = el('span', { text: 'Mute' });
  const muteBtn = el('button', { type: 'button', class: 'kbvm-btn kbvm-mute', 'aria-pressed': 'false', html: icon('mic') }, muteLabel);
  const endBtn = el('button', { type: 'button', class: 'kbvm-btn kbvm-end', 'aria-label': 'End voice mode', 'aria-keyshortcuts': 'Escape', html: icon('end') }, el('span', { text: 'End' }));
  const input = el('input', { type: 'text', maxlength: '1000', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Or type a question…', 'aria-label': `Type a question for ${name}`, id: `kbvm-in-${uid}` });
  const typeForm = el('form', { class: 'kbvm-type' }, input, el('button', { type: 'submit', text: 'Ask' }));
  const log = el('ol', { class: 'kbvm-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Transcript' });
  const trCount = el('span', { text: '' });
  const tr = el('details', { class: 'kbvm-tr', hidden: true }, el('summary', null, 'Transcript', trCount), log);
  const root = el('section', { class: 'kbvm', role: 'region', 'aria-label': `Voice mode with ${name}`, tabindex: '-1', 'data-theme': o.theme === 'dark' || o.theme === 'light' ? o.theme : 'auto', 'data-state': 'connecting' },
    el('style', { text: CSS }), stage, status, caption, err, prods, chips,
    el('div', { class: 'kbvm-ctrl' }, muteBtn, endBtn),
    el('p', { class: 'kbvm-hint', text: 'Speak naturally. Press End or Esc to stop.' }),
    typeForm, tr);
  host.append(root);
  const orb = createOrb(canvas, { preset });

  const say = (s) => { if (status.textContent !== s) status.textContent = s; };
  const showErr = (s) => { err.textContent = s || ''; err.hidden = !s; };
  let state = 'connecting', muted = false, stopped = false, engine = null, ws = null;
  const STATE_TEXT = { connecting: 'Connecting…', listening: 'Listening…', thinking: 'Looking in the sources…', speaking: 'Answering…', idle: '' };
  function setState(next) {
    if (stopped) return;
    if (next !== state) { state = next; root.dataset.state = next; orb.setState(next); }
    say(next === 'idle' ? (muted ? 'Microphone off. Press Unmute, or type a question.' : 'Type your question below.') : STATE_TEXT[next]);
  }
  orb.setState('connecting');
  /** Back to listening (or idle when there is nothing to listen with). */
  function settle() {
    if (stopped) return;
    const canHear = engine === 'gemini' ? micOk : recOk();
    if (muted || !canHear) setState('idle');
    else { setState('listening'); if (engine === 'text') startRec(); }
  }
  function addLog(role, text) {
    const li = el('li', { class: role }, el('span', { class: 'kbvm-who', text: role === 'user' ? 'You' : name }), document.createTextNode(text));
    log.append(li);
    log.scrollTop = log.scrollHeight;
    trCount.textContent = ` (${log.children.length})`;
    tr.hidden = false;
    return li;
  }
  // the web chat's product cards (lib/widget.js) and their styles (lib/knowbot.css), loaded once, on the first product answer
  let cardsKit = null, prodSeq = 0;
  const loadCards = () => (cardsKit ||= Promise.all([
    import('./widget.js?v=357231d'),
    new Promise((resolve) => {
      const link = el('link', { rel: 'stylesheet', href: new URL('./knowbot.css?v=357231d', import.meta.url).href });
      const t = setTimeout(resolve, 2500);
      const ok = () => { clearTimeout(t); resolve(); };
      link.addEventListener('load', ok); link.addEventListener('error', ok);
      root.prepend(link);
    }),
  ]).then(([w]) => w.productCardsHtml));
  const productsOf = (list, refused) => (refused || !Array.isArray(list) ? [] : list.filter((p) => p && typeof p.url === 'string' && /^https?:\/\//.test(p.url) && p.title).slice(0, 4));
  function showProducts(list) {
    const seq = ++prodSeq;
    prods.textContent = '';
    if (!list.length) return;
    loadCards().then((html) => {
      if (seq !== prodSeq || stopped) return;
      prods.innerHTML = html(list);
      prods.querySelectorAll('.kb-prod-media img').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
    }).catch(() => { /* no cards: the source chips still link the products */ if (seq === prodSeq) showChips(lastShown.list, lastShown.proofUrl, false, []); });
  }
  let lastShown = { list: [], proofUrl: null };
  /** Source chips; a source that is one of the product cards is left out (its card links it). */
  function showChips(list, proofUrl, refused, products = []) {
    chips.textContent = '';
    if (refused) { chips.append(el('li', null, el('span', { class: 'kbvm-chip', text: 'Not in the sources' }))); return; }
    lastShown = { list: list || [], proofUrl };
    const carded = new Set(products.map((p) => pageKey(p.url)).filter(Boolean));
    const cardTitles = new Set(products.map((p) => String(p.title).trim().toLowerCase()));
    for (const c of list || []) {
      // a product page's source is often titled "Title · https://…/products/…" with no url of its own
      const inTitle = /\bhttps?:\/\/[^\s)]+/i.exec(String(c.title || ''))?.[0];
      const bare = noUrls(String(c.title || '')).replace(/\s*[·|–-]\s*$/, '').trim();
      if (carded.size && ((typeof c.url === 'string' && carded.has(pageKey(c.url))) || (inTitle && carded.has(pageKey(inTitle))) || cardTitles.has(bare.toLowerCase()))) continue;
      const href = (typeof c.url === 'string' && /^https?:\/\//.test(c.url) && c.url) || (typeof proofUrl === 'string' && /^https?:\/\//.test(proofUrl) && proofUrl) || null;
      const kids = [el('b', { text: String(c.n) }), document.createTextNode(noUrls(String(c.title || '')).replace(/\s*[·|–-]\s*$/, '').trim() || c.file || 'Source')];
      chips.append(el('li', null, href ? el('a', { class: 'kbvm-chip', href, target: '_blank', rel: 'noopener noreferrer' }, ...kids, el('span', { class: 'kbvm-sr', text: ' (opens in a new tab)' })) : el('span', { class: 'kbvm-chip' }, ...kids)));
    }
  }

  // ------------------------------------------------------------------------------------------------ audio graph
  // Both contexts are made now, inside the click that opened voice mode, so the browser lets them play.
  const AC = window.AudioContext || window.webkitAudioContext;
  let outCtx = null, outMeter = null, outGain = null, playHead = 0;
  const playing = new Set();
  try {
    outCtx = new AC();
    outGain = outCtx.createGain();
    const an = outCtx.createAnalyser();
    outGain.connect(an); an.connect(outCtx.destination);
    outMeter = createMeter(an);
    outCtx.resume?.().catch(() => {});
  } catch { outCtx = null; }
  let inCtx = null, media = null, srcNode = null, proc = null, micMeter = null, micOk = false;
  try { inCtx = new AC(); inCtx.resume?.().catch(() => {}); } catch { inCtx = null; }

  // the orb's level, read once per frame by the orb: the mic while listening, the bot's voice while speaking
  let synthStart = 0, boundaryAt = 0;
  const synthLevel = () => {
    const now = performance.now(), t = (now - synthStart) / 1000;
    return clamp01(0.3 + 0.16 * Math.sin(t * 9.3) * Math.sin(t * 3.1 + 1) + 0.45 * Math.exp(-(now - boundaryAt) / 160));
  };
  orb.setLevelSource(() => {
    if (state === 'speaking') return engine === 'text' ? synthLevel() : outMeter ? outMeter() : 0;
    return !muted && micMeter ? micMeter() : 0;
  });

  async function openMic() {
    if (media) return true;
    if (!navigator.mediaDevices?.getUserMedia || !inCtx) throw Object.assign(new Error('no mic api'), { name: window.isSecureContext === false ? 'SecurityError' : 'NotFoundError' });
    media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (stopped) { media.getTracks().forEach((t) => t.stop()); media = null; return false; }
    if (inCtx.state === 'suspended') inCtx.resume().catch(() => {});
    srcNode = inCtx.createMediaStreamSource(media);
    const an = inCtx.createAnalyser();
    srcNode.connect(an);
    micMeter = createMeter(an);
    if (engine === 'gemini') {
      // ScriptProcessor works everywhere (an AudioWorklet needs its own module URL, often blocked by a page's CSP)
      const rate = inCtx.sampleRate;
      let pending = [], pendingLen = 0;
      proc = inCtx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        if (muted || stopped || ws?.readyState !== 1) return;
        const pcm = downsampleToPcm16(e.inputBuffer.getChannelData(0), rate, 16000);
        pending.push(pcm); pendingLen += pcm.length;
        if (pendingLen < 1600) return; // 100 ms
        const out = new Int16Array(pendingLen);
        let off = 0; for (const p of pending) { out.set(p, off); off += p.length; }
        pending = []; pendingLen = 0;
        ws.send(out.buffer);
      };
      const sink = inCtx.createGain(); sink.gain.value = 0;
      srcNode.connect(proc); proc.connect(sink); sink.connect(inCtx.destination);
    }
    micOk = true;
    return true;
  }
  function closeMic() {
    try { if (proc) proc.onaudioprocess = null; srcNode?.disconnect(); proc?.disconnect(); } catch { /* ignore */ }
    try { media?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    media = srcNode = proc = micMeter = null; micOk = false;
  }

  // ------------------------------------------------------------------------------------------------ the bot's voice
  function playPcm(buf) {
    if (!outCtx || stopped) return;
    const pcm = new Int16Array(buf.byteLength >> 1);
    new Uint8Array(pcm.buffer).set(new Uint8Array(buf, 0, pcm.length * 2));
    if (!pcm.length) return;
    const ab = outCtx.createBuffer(1, pcm.length, 24000);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = outCtx.createBufferSource();
    src.buffer = ab; src.connect(outGain);
    playHead = Math.max(playHead, outCtx.currentTime + 0.03);
    src.start(playHead);
    playHead += ab.duration;
    playing.add(src);
    src.onended = () => { playing.delete(src); if (!playing.size && state === 'speaking') settle(); };
    setState('speaking');
  }
  let synthTimer = 0;
  function speak(text) {
    clearTimeout(synthTimer);
    const synth = window.speechSynthesis;
    const done = () => { clearTimeout(synthTimer); if (state === 'speaking') settle(); };
    synthStart = performance.now(); boundaryAt = 0;
    setState('speaking');
    // no speech output here (or it never starts): the captions carry it, the orb speaks for about as long as reading takes
    const fallback = () => { synthTimer = setTimeout(done, Math.min(9000, 1200 + 42 * String(text || '').length)); };
    if (!synth || !text || typeof SpeechSynthesisUtterance !== 'function') { fallback(); return; }
    try { synth.cancel(); } catch { /* ignore */ }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const vs = synth.getVoices?.() || [];
    u.voice = vs.find((v) => v.lang?.startsWith(lang.slice(0, 2)) && /Natural|Neural|Premium|Enhanced/i.test(v.name)) || vs.find((v) => v.lang?.startsWith(lang.slice(0, 2))) || null;
    let started = false;
    u.onstart = () => { started = true; clearTimeout(synthTimer); synthStart = performance.now(); };
    u.onboundary = () => { boundaryAt = performance.now(); };
    u.onend = done;
    // no voice to speak with (some browsers and devices): the orb still speaks for the captions' length
    u.onerror = () => { if (started) done(); else { clearTimeout(synthTimer); fallback(); } };
    synthTimer = setTimeout(() => { if (!started) fallback(); }, 1500);
    synth.speak(u);
  }
  function stopSpeaking() {
    for (const s of playing) { try { s.stop(); } catch { /* ignore */ } }
    playing.clear(); playHead = 0;
    clearTimeout(synthTimer);
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------------------------------------ speech recognition (browser engine)
  let rec = null, recBroken = !SR_CTOR, recTimer = 0;
  const recOk = () => engine === 'text' && !recBroken;
  function startRec() {
    if (!recOk() || rec || muted || stopped || state !== 'listening') return;
    let finalText = '';
    try {
      rec = new SR_CTOR();
      rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    } catch { recBroken = true; rec = null; return; }
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t; else interim += t; }
      caption.classList.add('is-user');
      caption.textContent = (finalText + interim).trim();
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      recBroken = true;
      showErr(/network|service-not-allowed|language/.test(e.error) ? "Your browser can't recognize speech here. Type your question below and the answer is read aloud." : micErrorMessage(e));
    };
    rec.onend = () => {
      rec = null;
      const t = finalText.trim();
      if (stopped) return;
      if (t) { askText(t, { spoken: true }); return; }
      if (recBroken) { settle(); return; }
      clearTimeout(recTimer);
      recTimer = setTimeout(startRec, 250); // silence: keep listening
    };
    try { rec.start(); } catch { rec = null; }
  }
  function stopRec() { clearTimeout(recTimer); if (rec) { const r = rec; rec = null; r.onend = null; try { r.abort(); } catch { /* ignore */ } } }

  // ------------------------------------------------------------------------------------------------ the session
  let userText = '', agentText = '', lastCites = { citations: [], proofUrl: null, refused: false, products: [] }, pendingQ = '';
  const sendJson = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  function connect() {
    let s;
    try { s = new WebSocket(o.endpoint); } catch { showErr("Couldn't reach the voice assistant. Check your connection and try again, or type your question."); setState('idle'); return; }
    s.binaryType = 'arraybuffer';
    ws = s;
    let ready = false;
    s.addEventListener('open', () => s.send(JSON.stringify({ type: 'start', ...(o.key ? { key: o.key } : {}), ...(o.engine === 'text' ? { engine: 'text' } : {}) })));
    s.addEventListener('message', (ev) => {
      if (stopped) return;
      if (typeof ev.data !== 'string') { playPcm(ev.data); return; }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'ready') { ready = true; onReady(m); return; }
      onServer(m);
    });
    s.addEventListener('close', () => {
      if (ws === s) ws = null;
      if (stopped) return;
      stopRec(); stopSpeaking();
      if (!ready && err.hidden) showErr("Couldn't reach the voice assistant. Check your connection and try again, or type your question.");
      else if (err.hidden) showErr('Voice mode disconnected. Press End and open it again to keep talking.');
      closeMic();
      setState('idle');
    });
  }
  async function onReady(m) {
    engine = m.engine === 'gemini' ? 'gemini' : 'text';
    root.dataset.engine = engine === 'gemini' ? 'live' : 'browser';
    if (m.note) showErr(m.note);
    try { await openMic(); } catch (e) {
      closeMic();
      showErr(micErrorMessage(e));
      // a mic the visitor (or the page) refused: the browser's recognizer would be refused too, so it rests until Unmute
      // (the mic button then reads Unmute, which asks again)
      if (/NotAllowed|Permission|Security|NotFound/i.test(String(e?.name || ''))) { recBroken = true; muted = true; paintMute(); }
    }
    if (stopped) return;
    if (pendingQ) { const q = pendingQ; pendingQ = ''; askText(q); return; }
    settle();
  }
  function onServer(m) {
    switch (m.type) {
      case 'transcript':
        if (m.role === 'user') {
          userText = m.delta ? userText + m.text : m.text;
          if (!agentText) { caption.classList.add('is-user'); caption.textContent = userText.trim(); }
        } else {
          agentText += m.text;
          caption.classList.remove('is-user');
          caption.textContent = agentText.trim();
        }
        break;
      case 'searching': setState('thinking'); break;
      case 'citations': {
        const products = productsOf(m.products, m.refused);
        lastCites = { citations: m.citations || [], proofUrl: m.proofUrl || null, refused: !!m.refused, products };
        showChips(lastCites.citations, lastCites.proofUrl, lastCites.refused, products);
        showProducts(products);
        break;
      }
      case 'answer': {
        const text = plain(m.text);
        const products = productsOf(m.products, m.refused);
        showChips(m.citations, m.proofUrl, m.refused, products);
        showProducts(products);
        caption.classList.remove('is-user');
        caption.textContent = noUrls(plain(m.spoken || m.text));
        addLog('agent', text);
        o.onTurn?.({ question: m.question || '', answer: text, citations: m.citations || [], proofUrl: m.proofUrl || null, refused: !!m.refused, products });
        speak(noUrls(m.spoken || text));
        break;
      }
      case 'interrupted': stopSpeaking(); if (state === 'speaking') settle(); break;
      case 'turn_complete':
        if (agentText.trim()) {
          if (userText.trim()) addLog('user', userText.trim());
          addLog('agent', agentText.trim());
          o.onTurn?.({ question: userText.trim(), answer: agentText.trim(), ...lastCites });
          userText = ''; agentText = ''; lastCites = { citations: [], proofUrl: null, refused: false, products: [] };
        }
        if (!playing.size && state !== 'listening') settle();
        break;
      case 'error': showErr(m.message || 'Something went wrong.'); if (state === 'thinking') settle(); break;
      case 'end': if (m.reason === 'time_limit') showErr('This voice session reached its time limit. Press End and open voice mode again to keep talking.'); break;
      default:
    }
  }
  function askText(raw, { spoken = false } = {}) {
    const q = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!q || stopped) return;
    stopSpeaking(); stopRec();
    if (!engine) { pendingQ = q; return; } // still connecting: asked once the session is ready
    showErr('');
    caption.classList.add('is-user');
    caption.textContent = q;
    chips.textContent = '';
    prodSeq++; prods.textContent = '';
    if (engine === 'text' || !spoken) addLog('user', q);
    if (engine === 'gemini') { userText = ''; agentText = ''; } // the server echoes typed text; the log already has it
    sendJson({ type: 'text', text: q });
    setState('thinking');
  }

  // ------------------------------------------------------------------------------------------------ controls
  function paintMute() {
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.innerHTML = icon(muted ? 'micOff' : 'mic');
    muteLabel.textContent = muted ? 'Unmute' : 'Mute';
    muteBtn.append(muteLabel);
    muteBtn.setAttribute('aria-label', muted ? 'Unmute the microphone' : 'Mute the microphone');
  }
  muteBtn.addEventListener('click', async () => {
    muted = !muted;
    paintMute();
    if (muted) { stopRec(); if (state === 'listening' || state === 'idle') setState('idle'); return; }
    showErr('');
    if (!micOk && engine) {
      try { await openMic(); if (SR_CTOR) recBroken = false; } catch (e) { closeMic(); showErr(micErrorMessage(e)); muted = true; paintMute(); return; }
    }
    if (state === 'idle') settle();
  });
  endBtn.addEventListener('click', () => stop());
  typeForm.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value; input.value = ''; askText(t); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); } });
  paintMute();

  function stop() {
    if (stopped) return;
    stopped = true;
    stopRec(); stopSpeaking(); closeMic();
    try { sendJson({ type: 'stop' }); ws?.close(); } catch { /* ignore */ }
    ws = null;
    try { inCtx?.close(); } catch { /* ignore */ }
    try { outCtx?.close(); } catch { /* ignore */ }
    orb.destroy();
    root.remove();
    o.onClose?.();
  }

  if (window.isSecureContext === false) showErr('The microphone only works on secure (https) pages. You can still type your question below.');
  connect();
  return {
    el: root,
    orb,
    get state() { return state; },
    get engine() { return engine; },
    get muted() { return muted; },
    ask: (t) => askText(t),
    focus: () => root.focus({ preventScroll: true }),
    stop,
  };
}

export { ORB_PRESETS };

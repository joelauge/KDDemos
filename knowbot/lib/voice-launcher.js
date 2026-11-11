// KnowBot web voice assistant: voice mode (./voice-mode.js, the audio-reactive orb) behind one button.
//   floating (default, a site's embed): a round button in the bot's orb colour, bottom right; it opens a panel with voice
//            mode; End or Esc closes the panel and gives focus back to the button.
//   inline (a target element; the Studio's previews): a "Talk to <name>" button in place; voice mode opens there and End
//            brings the button back.
//
//   <script type="module" src=".../lib/embed.js" data-mode="voice" data-api="https://host/api" data-bot="acme"></script>
//   import { mountVoiceLauncher } from '.../lib/voice-launcher.js';
//   const v = mountVoiceLauncher('#target' | null, { apiBase, bot, key?, name?, orb?, endpoint?, position?: 'left', open? });
//   v.open(); v.close(); v.destroy();
// The orb colour is the bot's own choice from KnowBot Studio (GET /v1/channels/:bot → webVoice.orb) unless `orb` is given.

import { orbSwatch, orbId } from './voice-orb.js?v=e3d6fc1';

const CSS = `
:host{all:initial;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#15151f;--bg:#fff;--line:#e3e6ee;--shadow:0 12px 40px rgba(15,23,42,.28)}
@media (prefers-color-scheme:dark){:host{color:#e7eaf3;--bg:#15151f;--line:#2f3346;--shadow:0 12px 40px rgba(0,0,0,.55)}}
*{box-sizing:border-box}
.launch{position:fixed;bottom:20px;right:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;color:#fff;
  box-shadow:0 6px 24px rgba(15,23,42,.3),inset 0 0 0 2px rgba(255,255,255,.25);transition:transform .15s ease}
.launch:hover{transform:scale(1.05)}
.launch:focus-visible,.talk:focus-visible{outline:3px solid #4f46e5;outline-offset:3px}
.launch.left{right:auto;left:20px}
.launch svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.panel{position:fixed;bottom:92px;right:20px;z-index:2147483000;width:min(400px,calc(100vw - 32px));max-height:min(680px,calc(100vh - 112px));overflow:auto;
  background:var(--bg);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);padding:18px 16px 14px}
.panel.left{right:auto;left:20px}
.inline{display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0;width:100%}
.talk{display:inline-flex;align-items:center;gap:10px;min-height:48px;padding:6px 18px 6px 6px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:inherit;font:600 15px/1 inherit;cursor:pointer}
.talk i{width:36px;height:36px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff}
.hint{margin:0;font-size:13px;color:#6b6f80}
@media (prefers-reduced-motion:reduce){.launch{transition:none}}
[hidden]{display:none!important}
`;
const MIC = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

export function mountVoiceLauncher(target, o = {}) {
  const inlineEl = typeof target === 'string' ? document.querySelector(target) : target || null;
  const host = document.createElement('knowbot-voice');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = CSS; root.append(style);
  (inlineEl || document.body).append(host);
  const api = String(o.apiBase || location.origin).replace(/\/+$/, '');
  const bot = encodeURIComponent(o.bot || '');
  const name = o.name || 'KnowBot';
  const endpoint = o.endpoint || `${api.replace(/^http/, 'ws')}/v1/bots/${bot}/voice/live`;
  let orb = o.orb ? orbId(o.orb) : null;
  const orbReady = orb ? Promise.resolve(orb) : fetch(`${api}/v1/channels/${bot}`, { credentials: 'omit' }).then((r) => (r.ok ? r.json() : null))
    .then((j) => orbId(j?.channels?.webVoice?.orb)).catch(() => orbId(null)).then((x) => { orb = x; paint(); return x; });

  let vm = null, box = null, destroyed = false;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  const panel = document.createElement('div');
  panel.hidden = true;
  if (inlineEl) {
    btn.className = 'talk';
    btn.innerHTML = `<i>${MIC}</i><span>Talk to ${escapeHtml(name)}</span>`;
    const wrap = document.createElement('div'); wrap.className = 'inline';
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Allow the microphone when asked. Answers come only from its own files, with the sources.';
    panel.className = 'inline-panel';
    wrap.append(btn, hint, panel);
    root.append(wrap);
    o._hint = hint;
  } else {
    btn.className = `launch${o.position === 'left' ? ' left' : ''}`;
    btn.innerHTML = MIC;
    panel.className = `panel${o.position === 'left' ? ' left' : ''}`;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', `Talk to ${name}`);
    root.append(btn, panel);
  }
  btn.setAttribute('aria-label', `Talk to ${name} by voice`);
  function paint() {
    const sw = orbSwatch(orb || 'ocean');
    if (inlineEl) btn.querySelector('i').style.background = sw; else btn.style.background = sw;
  }
  paint();

  async function open() {
    if (vm || destroyed) return;
    panel.hidden = false;
    if (inlineEl) { btn.hidden = true; if (o._hint) o._hint.hidden = true; } else btn.setAttribute('aria-expanded', 'true');
    box = document.createElement('div');
    panel.replaceChildren(box);
    box.textContent = 'Starting voice mode…';
    try {
      const [{ openVoiceMode }] = await Promise.all([import('./voice-mode.js?v=e3d6fc1'), orbReady]);
      const o2 = orb || 'ocean';   // the latest choice (setOrb), else the bot's own
      if (destroyed || panel.hidden) return;
      box.textContent = '';
      vm = openVoiceMode(box, { endpoint, key: o.key || undefined, name, orb: o2, size: inlineEl ? 'min(220px, 50vw)' : 'min(200px, 34vh, 60vw)', theme: o.theme || 'auto', onClose: close });
      vm.focus?.();
    } catch {
      box.textContent = "The voice assistant couldn't start. Try again in a moment.";
    }
  }
  function close() {
    try { vm?.stop?.(); } catch { /* ignore */ }
    vm = null;
    panel.hidden = true; panel.replaceChildren();
    if (inlineEl) { btn.hidden = false; if (o._hint) o._hint.hidden = false; } else btn.setAttribute('aria-expanded', 'false');
    btn.focus();
  }
  btn.addEventListener('click', () => (vm || !panel.hidden ? close() : open()));
  if (!inlineEl) btn.setAttribute('aria-expanded', 'false');
  if (o.open) open();
  return {
    open, close,
    setOrb(id) { orb = orbId(id); paint(); },
    get orb() { return orb; },
    destroy() { destroyed = true; try { vm?.stop?.(); } catch { /* ignore */ } host.remove(); },
  };
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

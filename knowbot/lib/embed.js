// One-line loader:
// <script type="module" src=".../lib/embed.js" data-api="http://localhost:8787" data-mode="widget|inline|fullpage|voice"
//         data-target="#id" data-engine="server|webllm" data-org="..." data-name="KnowBot" data-starters="Q1|Q2"
//         data-instance="acme"></script>   (data-instance: answer only from that chat instance's knowDrive folder)
//
// The Website tool (KnowBot Studio, Set up → Website): ONE line turns on the website features the owner switched on.
// <script type="module" src=".../lib/embed.js" data-api="https://host" data-bot="acme"
//         data-chat="on|off" data-voice="on|off" data-homepage="on|off" data-key="kb_trial_…"></script>
//   data-chat      the chat bubble (the widget above)
//   data-voice     voice mode with the orb: the chat bubble always has a mic (data-voice="off" removes it); with the chat
//                  off, data-voice="on" (or the saved Voice switch) shows the round voice button
//   data-homepage  the homepage search over this page (../site/overlay.js)
// A feature attribute left out follows the bot's saved switches (GET <api>/api/v1/channels/:bot → website), so the
// owner can switch features on and off in the Studio without touching the page. Without data-mode and without any of
// these attributes, a bot whose switches can't be read keeps the old behaviour (the chat bubble). Old snippets
// (data-mode="voice", data-mode="inline", data-voice="on" in the chat) work as before.
import { mount, ensureCss } from './widget.js?v=3b1a5da';
import { apiForScriptHost } from './site-config.js?v=3b1a5da';

const me = new URL(import.meta.url);
const script = [...document.querySelectorAll('script[src]')].find((s) => s.src === me.href)
  || [...document.querySelectorAll('script[src*="embed.js"]')].find((s) => s.dataset.api || s.dataset.mode)
  || document.querySelector('script[src*="embed.js"]');
const d = script?.dataset || {};
const q = new URLSearchParams(location.search);

// ?api= on the host page would let anyone craft a link that repoints this site's assistant at their own server
// (phishing answers, exfiltrated questions). Honour it only for loopback dev servers or when the host opts in.
const apiParam = (() => {
  const v = q.get('api');
  if (!v) return null;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol)) return null;
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || 'allowApiParam' in d ? u.href.replace(/\/+$/, '') : null;
  } catch { return null; }
})();
// no data-api: the hosted script finds its own API (lib/site-config.js), so the website line never names the server
const apiBase = apiParam || d.api || apiForScriptHost(me.hostname) || (me.port === '8787' ? me.origin : location.port === '8787' ? location.origin : 'http://localhost:8787');
const engine = d.engine === 'webllm' ? { type: 'webllm', ...(d.model ? { model: d.model } : {}) } : d.engine === 'openai'
  ? { type: 'openai', baseUrl: d.llm, model: d.model } : { type: 'server' };

const instance = /^[a-z0-9-]{1,40}$/.test(d.instance || '') ? d.instance : null;
const botId = /^[a-z0-9_-]{1,64}$/i.test(d.bot || '') ? d.bot : instance;
// the widget's API is the origin (it adds /api/…); voice and the channel config live under <origin>/api/v1
const apiRoot = String(apiBase).replace(/\/+$/, '').replace(/\/api$/, '');
const v1Base = `${apiRoot}/api`;
// An instance's name, greeting and starter questions come from the server unless the page sets them.
const instanceConfig = async () => {
  if (!instance) return null;
  try { return (await (await fetch(`${apiRoot}/api/config?instance=${encodeURIComponent(instance)}`)).json()).instance || null; } catch { return null; }
};
/** on/off attribute -> true/false; absent or anything else -> null (follow the bot's saved switch). */
const flag = (v) => (v == null ? null : /^(?:on|true|1|yes)$/i.test(v) ? true : /^(?:off|false|0|no)$/i.test(v) ? false : null);
/** The bot's saved Website switches ({ chat, voice, homepage }), or null when they can't be read. */
const savedSwitches = async () => {
  if (!botId) return null;
  try {
    const r = await fetch(`${v1Base}/v1/channels/${encodeURIComponent(botId)}`, { credentials: 'omit' });
    const w = r.ok ? (await r.json())?.website : null;
    return w && typeof w === 'object' ? { chat: !!w.chat, voice: !!w.voice, homepage: !!w.homepage } : null;
  } catch { return null; }
};

// data-mode="voice": the web voice assistant: a round button in the bot's orb colour that opens voice mode (the
// audio-reactive orb, lib/voice-launcher.js). data-bot (or data-instance) names the bot, data-key a trial key when the bot
// is a Studio trial, data-orb a colour (else the bot's own choice from the Studio), data-target to place it inline,
// data-position="left". data-legacy="on": the older mic widget (lib/voice-widget.js).
const startVoice = async () => {
  const inst = await instanceConfig();
  const common = { apiBase, endpoint: d.endpoint || undefined, bot: d.bot || instance || '', key: d.key || undefined,
    name: d.name || inst?.botName || inst?.name || 'KnowBot', position: d.position, open: d.open === 'true' };
  if (d.legacy === 'on') {
    const { mountVoice } = await import('./voice-widget.js?v=3b1a5da');
    window.knowbotVoice = mountVoice(d.target || null, { ...common, talk: d.talk === 'hold' ? 'hold' : 'toggle', lang: d.lang || undefined, engine: d.engine === 'text' ? 'text' : 'auto' });
    return;
  }
  const { mountVoiceLauncher } = await import('./voice-launcher.js?v=3b1a5da');
  window.knowbotVoice = mountVoiceLauncher(d.target || null, { ...common, orb: d.orb || undefined });
};
const startChat = async ({ voice = null } = {}) => {
  ensureCss(d.css || new URL('./knowbot.css?v=3b1a5da', me).href);
  const inst = await instanceConfig();
  window.knowbot = mount(d.mode || 'widget', d.target || null, {
    apiBase,
    voice: voice && voice.bot ? voice : undefined,
    engine,
    instance,
    // answers come from the server's answer pipeline for this bot (the same as the Studio's); data-key for a trial bot
    botId: botId || undefined,
    key: d.key || undefined,
    guards: inst?.guards,
    persona: { name: d.name || inst?.botName || 'KnowBot', org: d.org || inst?.org || inst?.name || document.title || 'this organization' },
    title: d.title,
    greeting: d.greeting || inst?.greeting || undefined,
    starters: d.starters ? d.starters.split('|').map((s) => s.trim()).filter(Boolean) : inst?.starters || [],
    open: d.open === 'true',
    position: d.position,
    telemetry: d.telemetry === 'false' ? false : true,
    k: d.k ? +d.k : undefined,
    minScore: d.minScore ? +d.minScore : undefined,
  });
};
/** The homepage search (../site/overlay.js, a classic script that reads its own data-* attributes) over this page. */
const startHomepage = () => {
  if (!botId || document.querySelector('knowbot-overlay, script[data-knowbot-overlay]')) return;
  const s = document.createElement('script');
  s.src = new URL('../site/overlay.js?v=3b1a5da', me).href;
  s.async = true;
  s.dataset.bot = botId;
  s.dataset.knowbotOverlay = '1';
  try { s.dataset.api = new URL(apiRoot).origin; } catch { /* the overlay finds its API from its own address */ }
  if (d.theme) s.dataset.theme = d.theme;
  document.body.append(s);
};

const start = async () => {
  if (d.mode === 'voice') return startVoice();
  // data-voice="on" (with data-bot, or data-instance): a mic button in the chat that opens voice mode (lib/voice-mode.js);
  // data-key for a trial bot, data-orb="ocean|violet|sunset|mint|ruby|midnight|silver" (else the bot's own choice from the Studio).
  const voiceOpts = { apiBase: v1Base, bot: botId || '', key: d.key || undefined, orb: d.orb || undefined };
  const want = { chat: flag(d.chat), voice: flag(d.voice), homepage: flag(d.homepage) };
  // the chat bubble always offers voice mode (a mic beside Send) unless the page says data-voice="off"; it needs the bot id
  const chatVoice = flag(d.voice) === false || !voiceOpts.bot ? null : voiceOpts;
  // an explicit mode (inline, fullpage, widget) is the chat, as before, with its mic
  if (d.mode) return startChat({ voice: chatVoice });
  if (want.chat == null || want.voice == null || want.homepage == null) {
    const saved = await savedSwitches();
    if (saved) { for (const k of Object.keys(want)) if (want[k] == null) want[k] = saved[k]; }
  }
  // switches unreadable (an old one-line snippet, a bot without saved switches): the chat bubble, as before
  if (want.chat == null) want.chat = want.homepage !== true;
  if (want.chat) await startChat({ voice: chatVoice });
  else if (want.voice) {
    const { mountVoiceLauncher } = await import('./voice-launcher.js?v=3b1a5da');
    window.knowbotVoice = mountVoiceLauncher(d.target || null, { apiBase: v1Base, bot: botId || '', key: d.key || undefined, orb: d.orb || undefined,
      name: d.name || 'KnowBot', position: d.position, open: d.open === 'true', endpoint: d.endpoint || undefined });
  }
  if (want.homepage) startHomepage();
};
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, { once: true }) : start();

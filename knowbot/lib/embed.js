// One-line loader:
// <script type="module" src=".../lib/embed.js" data-api="http://localhost:8787" data-mode="widget|inline|fullpage"
//         data-target="#id" data-engine="server|webllm" data-org="..." data-name="KnowBot" data-starters="Q1|Q2"></script>
import { mount, ensureCss } from './widget.js';

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
const apiBase = apiParam || d.api || (me.port === '8787' ? me.origin : location.port === '8787' ? location.origin : 'http://localhost:8787');
const engine = d.engine === 'webllm' ? { type: 'webllm', ...(d.model ? { model: d.model } : {}) } : d.engine === 'openai'
  ? { type: 'openai', baseUrl: d.llm, model: d.model } : { type: 'server' };

ensureCss(d.css || new URL('./knowbot.css', me).href);
const start = () => {
  window.knowbot = mount(d.mode || 'widget', d.target || null, {
    apiBase,
    engine,
    persona: { name: d.name || 'KnowBot', org: d.org || document.title || 'this organization' },
    title: d.title,
    starters: d.starters ? d.starters.split('|').map((s) => s.trim()).filter(Boolean) : [],
    open: d.open === 'true',
    position: d.position,
    telemetry: d.telemetry === 'false' ? false : true,
    k: d.k ? +d.k : undefined,
    minScore: d.minScore ? +d.minScore : undefined,
  });
};
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, { once: true }) : start();

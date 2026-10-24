// Shared helpers for the KnowBot demo pages.
import { hostedApi } from '../lib/site-config.js';
// apiBase: ?api=... override, else same origin when served by the KnowBot server (:8787), else http://localhost:8787.
const q = new URLSearchParams(location.search);
// ?api= is limited to loopback or same-origin servers so a crafted link can't point the demos at a hostile server.
const apiParam = (() => {
  try {
    const u = new URL(q.get('api'));
    return /^https?:$/.test(u.protocol) && (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || u.origin === location.origin || u.origin === hostedApi()) ? u.href : null;
  } catch { return null; }
})();
export const API = (apiParam || hostedApi() || (location.port === '8787' ? location.origin : 'http://localhost:8787')).replace(/\/+$/, '');
export const PERSONA = { name: 'KnowBot', org: 'The Ultimate Game Master' };
// Topics the corpus really covers; shown when a question matches nothing (refusal hint).
export const COVERAGE = ['Products and bundles', 'Shipping policy', 'Refund policy', 'Game master guides'];
export const STARTERS = [
  'What is your return policy?',
  'Do you ship outside the United States?',
  'What comes in the Ultimate Bundle?',
  'Which magnetic screen covers do you sell?',
];

/** Keep ?api= on internal links so the override survives navigation. */
export function carryApiParam(root = document) {
  if (!apiParam) return;
  root.querySelectorAll('a[data-keep-api]').forEach((a) => {
    const u = new URL(a.getAttribute('href'), location.href);
    u.searchParams.set('api', apiParam);
    a.href = u.href;
  });
}

/** Show a connection pip in any [data-api-status] element; the API address and model sit in its tooltip. */
export async function showApiStatus(el = document.querySelector('[data-api-status]')) {
  if (!el) return null;
  const set = (state, label, detail) => {
    el.dataset.state = state;
    el.innerHTML = '<span class="api-pip" aria-hidden="true"></span><span class="api-label"></span>';
    el.querySelector('.api-label').textContent = label;
    el.title = detail;
    el.setAttribute('role', 'status');
  };
  set('checking', 'Connecting…', `API ${API}`);
  // A hosted API that has been idle takes a few seconds to wake its model container.
  const hosted = API === hostedApi();
  const slow = hosted ? setTimeout(() => set('checking', 'Waking up…', `API ${API} is starting its model`), 3000) : null;
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), hosted ? 45000 : 3000);
    const cfg = await (await fetch(`${API}/api/config`, { signal: ctl.signal })).json();
    set('ok', 'API connected', `API ${API} · retrieval: ${cfg.retrieval || '?'} · model: ${cfg.engine?.model || '?'}`);
    return cfg;
  } catch {
    set('down', 'API offline', `API ${API} not reachable (start server/server.mjs or pass ?api=)`);
    return null;
  } finally {
    clearTimeout(slow);
  }
}

/** Light/dark toggle for [data-theme-toggle] buttons. The <head> script applies the saved theme before paint. */
export function wireThemeToggle(root = document) {
  const sync = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    root.querySelectorAll('[data-theme-toggle]').forEach((b) => { b.setAttribute('aria-label', label); b.title = label; });
  };
  root.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('knowbot-theme', next); } catch { /* storage blocked: lasts this page view */ }
    sync();
  }));
  sync();
}
wireThemeToggle();

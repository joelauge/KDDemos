// Shared helpers for the KnowBot demo pages.
// apiBase: ?api=... override, else same origin when served by the KnowBot server (:8787), else http://localhost:8787.
const q = new URLSearchParams(location.search);
export const API = (q.get('api') || (location.port === '8787' ? location.origin : 'http://localhost:8787')).replace(/\/+$/, '');
export const PERSONA = { name: 'KnowBot', org: 'The Ultimate Game Master' };
export const STARTERS = [
  'What is your return policy?',
  'Do you ship outside the United States?',
  'What comes in the Ultimate Bundle?',
  'Which magnetic screen covers do you sell?',
];

/** Keep ?api= on internal links so the override survives navigation. */
export function carryApiParam(root = document) {
  if (!q.get('api')) return;
  root.querySelectorAll('a[data-keep-api]').forEach((a) => {
    const u = new URL(a.getAttribute('href'), location.href);
    u.searchParams.set('api', q.get('api'));
    a.href = u.href;
  });
}

/** Fill any [data-api-status] element with a live server check. */
export async function showApiStatus(el = document.querySelector('[data-api-status]')) {
  if (!el) return null;
  el.textContent = `API ${API} · checking…`;
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 3000);
    const cfg = await (await fetch(`${API}/api/config`, { signal: ctl.signal })).json();
    el.textContent = `API ${API} · retrieval: ${cfg.retrieval || '?'} · model: ${cfg.engine?.model || '?'}`;
    el.dataset.state = 'ok';
    return cfg;
  } catch {
    el.textContent = `API ${API} · not reachable (start server/server.mjs or pass ?api=)`;
    el.dataset.state = 'down';
    return null;
  }
}

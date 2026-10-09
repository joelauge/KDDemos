/* Shared helpers for the corpus-unfurl demo: link resolution, search, sharing. */
(function () {
  const D = window.KD_UNFURL;
  // When served through worker/unfurl-worker.js, the worker injects KD_LIVE_PROXY
  // (its own origin) and KD_LINK (the link's public config), and searches go to the
  // live store through it. Served statically, the demo searches the snapshot.
  const LIVE_PROXY = window.KD_LIVE_PROXY || null;
  const BASE = 'https://demos.knowdrive.ai/unfurl/';

  // Compact config for demo links: store.scopeMask.entMask.max.expiry, base36.
  // e.g. "0.8.3f.c.0" — short enough to look like a normal link in a chat.
  const ENT_KEYS = ['atoms', 'files', 'snippet', 'open', 'share', 'image', 'audio'];
  function encCfg(l) {
    const ids = Object.keys(D.STORES), si = ids.indexOf(l.store), tags = D.STORES[l.store].tags;
    const sm = tags.reduce((m, t, i) => m | ((l.scope || []).includes(t) ? 1 << i : 0), 0);
    const em = ENT_KEYS.reduce((m, k, i) => m | (l.ent[k] ? 1 << i : 0), 0);
    const ex = l.expires ? +l.expires.replace(/-/g, '') : 0;
    return [si, sm, em, l.maxResults || 12, ex].map((n) => n.toString(36)).join('.');
  }
  function decCfg(c) {
    const [si, sm, em, mx, ex] = c.split('.').map((x) => parseInt(x, 36));
    const store = Object.keys(D.STORES)[si]; if (!store) return null;
    const exs = ex ? String(ex) : null;
    return {
      label: 'Shared link', store, createdBy: 'a KnowDrive user', maxResults: Math.min(mx || 12, 25),
      scope: D.STORES[store].tags.filter((t, i) => sm & (1 << i)),
      ent: Object.fromEntries(ENT_KEYS.map((k, i) => [k, !!(em & (1 << i))])),
      expires: exs ? exs.slice(0, 4) + '-' + exs.slice(4, 6) + '-' + exs.slice(6, 8) : null
    };
  }


  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }

  // A link resolves from: the built-in registry, links created in this browser's
  // dashboard, or a config carried in the URL fragment (so demo links created in
  // the dashboard also open on a phone). In production only the id is in the URL.
  function resolveLink(params, hash) {
    if (window.KD_LINK_ERROR) return window.KD_LINK_ERROR === 'not_found' ? null : { id: '', [window.KD_LINK_ERROR]: true };
    if (window.KD_LINK) return { ...window.KD_LINK, storeInfo: window.KD_LINK.storeInfo || D.STORES[window.KD_LINK.store] };
    const id = params.get('l') || 'pr-ca-7qx2';
    let link = D.LINKS[id] || (store('kd-unfurl-links') || {})[id];
    const m = /(?:^|[#&])c=([^&]+)/.exec(hash || '');
    if (!link && m) { try { link = decCfg(decodeURIComponent(m[1])); } catch (e) { /* ignore malformed */ } }
    if (!link) return null;
    if ((store('kd-unfurl-revoked') || []).includes(id)) return { id, revoked: true, ...link };
    if (link.expires && new Date(link.expires + 'T23:59:59') < new Date()) return { id, expired: true, ...link };
    return { id, ...link, storeInfo: D.STORES[link.store] };
  }

  function linkUrl(id, link, withCfg) {
    if (LIVE_PROXY) return LIVE_PROXY + '/u/' + encodeURIComponent(id);
    return BASE + '?l=' + encodeURIComponent(id) + (withCfg ? '#c=' + encCfg(link) : '');
  }
  function shareUrl(link, atomId) {
    if (LIVE_PROXY) return LIVE_PROXY + '/u/' + encodeURIComponent(link.id) + '/a/' + encodeURIComponent(atomId);
    return BASE + 'share.html?l=' + encodeURIComponent(link.id) + '&a=' + encodeURIComponent(atomId) + (D.LINKS[link.id] ? '' : '#c=' + encCfg(link));
  }
  function stripLink(link) {
    const { id, storeInfo, revoked, expired, ...rest } = link;
    return rest;
  }

  const STOP = new Set('a an and are as at be by for from has have how i in is it its of on or that the this to was we what when where which who will with you your about into than then there these they those our us do does'.split(' '));
  const tokens = (s) => (s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || []).filter((t) => !STOP.has(t) && t.length > 1);

  // Snapshot search: a small BM25-flavoured scorer standing in for KnowDB hybrid search.
  function searchSnapshot(link, q) {
    const pool = D.ATOMS.filter((a) => link.store && (link.scope || []).every((t) => a.tags.includes(t)));
    const qt = tokens(q);
    if (!qt.length) return { atoms: [], files: [], total: 0 };
    const N = pool.length;
    const df = {};
    const docs = pool.map((a) => { const t = tokens(a.title + ' ' + a.breadcrumb + ' ' + (a.speaker || '') + ' ' + a.text); new Set(t).forEach((w) => (df[w] = (df[w] || 0) + 1)); return t; });
    const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(N, 1);
    const scored = pool.map((a, i) => {
      const d = docs[i]; let s = 0;
      qt.forEach((w) => {
        const stem = w.length > 5 ? w.slice(0, Math.max(5, w.length - 3)) : null;
        const tf = d.filter((x) => x === w || (stem && x.startsWith(stem))).length;
        if (!tf) return;
        const idf = Math.log(1 + (N - (df[w] || 0) + 0.5) / ((df[w] || 0) + 0.5));
        s += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.length / avg));
      });
      return { atom: a, score: s };
    }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score);
    const max = scored[0] ? scored[0].score : 1;
    const atoms = scored.slice(0, link.maxResults || 10).map((r) => ({ ...r.atom, score: r.score / max }));
    const byFile = {};
    scored.forEach((r) => { const f = byFile[r.atom.file_id] || (byFile[r.atom.file_id] = { file_id: r.atom.file_id, filename: r.atom.filename, title: r.atom.title, date: r.atom.date, tags: r.atom.tags, hits: 0, score: 0, top: r.atom }); f.hits++; f.score = Math.max(f.score, r.score / max); });
    const files = Object.values(byFile).sort((x, y) => y.score - x.score);
    return { atoms, files, total: scored.length };
  }

  // Live search goes through the worker; it holds the scoped token and enforces the link.
  async function searchLive(link, q, media) {
    const url = LIVE_PROXY + '/u/' + encodeURIComponent(link.id) + '/search';
    let res;
    if (media) {
      const fd = new FormData(); fd.append('file', media); if (q) fd.append('query', q);
      res = await fetch(url, { method: 'POST', body: fd });
    } else {
      res = await fetch(url + '?q=' + encodeURIComponent(q));
    }
    if (!res.ok) throw new Error('Search failed (' + res.status + ')');
    return res.json();
  }

  async function search(link, q, media) {
    if (LIVE_PROXY) return searchLive(link, q, media);
    await new Promise((r) => setTimeout(r, 220)); // feel like a network round trip
    return searchSnapshot(link, q);
  }

  function findAtom(id) { return (window.KD_ATOM && window.KD_ATOM.id === id) ? window.KD_ATOM : D.ATOMS.find((a) => a.id === id); }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function highlight(text, q) {
    const qt = tokens(q).filter((t) => t.length > 2);
    let html = esc(text);
    if (!qt.length) return html;
    const re = new RegExp('\\b(' + qt.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[a-z]*', 'gi');
    return html.replace(re, '<mark>$&</mark>');
  }
  function clip(text, n) { return text.length > n ? text.slice(0, n).replace(/\s+\S*$/, '') + '…' : text; }

  function citation(link, atom) {
    const who = atom.speaker ? atom.speaker + (atom.time ? ' (' + atom.time + ')' : '') + ' — ' : '';
    return '“' + clip(atom.text, 280) + '”\n— ' + who + atom.title + ', ' + atom.date + '\n' + 'KnowDrive · ' + (link.storeInfo ? link.storeInfo.name : 'store') + '\n' + shareUrl(link, atom.id);
  }

  async function shareOrCopy(payload) {
    if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try { await navigator.share(payload); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    await copy(payload.text ? payload.text : payload.url);
    return 'copied';
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove(); return true;
    }
  }
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1900);
  }

  window.KD = { D, BASE, LIVE_PROXY, resolveLink, linkUrl, shareUrl, stripLink, search, findAtom, esc, highlight, clip, citation, shareOrCopy, copy, toast, store };
})();

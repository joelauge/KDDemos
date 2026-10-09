/**
 * KnowDrive corpus-unfurl worker (reference implementation, Cloudflare Workers).
 *
 * Why a server is needed at all:
 *  1. Chat apps (iMessage, WhatsApp, Signal, Slack…) build the preview from the
 *     HTML <meta property="og:*"> tags of the URL. Their crawlers don't run JS,
 *     so per-link and per-result titles/snippets must be written server-side.
 *  2. The KnowDrive API doesn't allow browser CORS, and the store's token must
 *     never appear in a URL that gets forwarded around group chats. The link id
 *     is an opaque capability; the token lives here, next to the link.
 *
 * Routes
 *   GET  /u/:link                 search page, OG = store search card
 *   GET  /u/:link/search?q=       JSON search (text), scope + entitlements enforced
 *   POST /u/:link/search          multipart media search (image / audio)
 *   GET  /u/:link/a/:file:seq     shared-result page, OG = the atom's own snippet
 *
 * Bindings (wrangler.toml)
 *   LINKS     KV namespace: link id → LinkRecord (written by the dashboard backend)
 *   KD_API    e.g. "https://knowdrive.ai"
 *   APP_BASE  where the static pages live, e.g. "https://demos.knowdrive.ai/unfurl/"
 *
 * LinkRecord
 *   { label, store, store_name, files, atoms, scope: ["tag", …],
 *     ent: { atoms, files, snippet, open, share, image, audio },
 *     maxResults, expires: "YYYY-MM-DD" | null, revoked: bool,
 *     token: "<PASETO minted with aud=store, scp=search:read>", createdBy }
 */

const FIELDS = 'id,file_id,sequence_index,text,tags,metadata,score,uri';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/u\/([a-z0-9-]{3,40})(?:\/(search|a)(?:\/([^/]+))?)?\/?$/);
    if (!m) return new Response('Not found', { status: 404 });
    const [, id, route, arg] = m;

    const link = await loadLink(env, id);
    if (!link.ok) return route === 'search' ? json({ error: link.reason }, 410) : page(env, 'index.html', { id, error: link.reason }, null, url);

    if (route === 'search') return search(req, env, id, link.rec, url);
    if (route === 'a') return sharedResult(env, id, link.rec, decodeURIComponent(arg || ''), url);
    return page(env, 'index.html', publicLink(id, link.rec), og({
      title: 'Search with KnowDrive · ' + link.rec.store_name,
      description: `${link.rec.files.toLocaleString('en')} files · ${link.rec.atoms.toLocaleString('en')} atoms. Search by text${link.rec.ent.image ? ', image' : ''}${link.rec.ent.audio ? ' or voice' : ''}. Tap to open.`,
      image: env.APP_BASE + 'og-search.png',
      url: url.origin + url.pathname,
    }), url);
  },
};

async function loadLink(env, id) {
  const rec = await env.LINKS.get('link:' + id, 'json');
  if (!rec) return { ok: false, reason: 'not_found' };
  if (rec.revoked) return { ok: false, reason: 'revoked' };
  if (rec.expires && new Date(rec.expires + 'T23:59:59Z') < new Date()) return { ok: false, reason: 'expired' };
  return { ok: true, rec };
}

// Only what the page needs. Never the token.
function publicLink(id, r) {
  return {
    id, label: r.label, store: r.store, scope: r.scope, ent: r.ent, maxResults: r.maxResults,
    expires: r.expires, createdBy: r.createdBy,
    storeInfo: { name: r.store_name, short: r.store_name.split('·').pop().trim(), owner: r.createdBy, files: r.files, atoms: r.atoms, licence: r.licence || '' },
  };
}

async function search(req, env, id, r, url) {
  const limit = Math.min(r.maxResults || 12, 25);
  let res;
  if (req.method === 'POST') {
    const form = await req.formData();
    const file = form.get('file');
    const kind = file && file.type.startsWith('audio/') ? 'audio' : 'vision';
    if (!file || (kind === 'vision' && !r.ent.image) || (kind === 'audio' && !r.ent.audio)) return json({ error: 'modality_not_permitted' }, 403);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('search_field', kind);
    fd.append('limit', String(limit));
    fd.append('fields', FIELDS);
    if (r.scope.length) fd.append('tags', r.scope.join(','));
    if (form.get('query')) fd.append('text', String(form.get('query')).slice(0, 500));
    res = await fetch(env.KD_API + '/api/v1/search', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + r.token, 'X-Vector-Store-Id': r.store } });
  } else {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 500);
    if (!q) return json({ atoms: [], files: [], total: 0 });
    const p = new URLSearchParams({ query: q, mode: 'hybrid', limit: String(Math.max(limit, 25)), fields: FIELDS, text: 'raw' });
    if (r.scope.length) p.set('tags_all', r.scope.join(','));
    res = await fetch(`${env.KD_API}/api/v1/vector_stores/${r.store}/search?${p}`, { headers: { Authorization: 'Bearer ' + r.token } });
  }
  if (!res.ok) return json({ error: 'upstream_' + res.status }, 502);
  const body = await res.json();
  const atoms = (body.atoms || []).map(toAtom);
  const max = atoms.reduce((s, a) => Math.max(s, a.score), 0) || 1;
  atoms.forEach((a) => (a.score = a.score / max));
  if (!r.ent.snippet) atoms.forEach((a) => (a.text = ''));

  const byFile = {};
  for (const a of atoms) {
    const f = byFile[a.file_id] || (byFile[a.file_id] = { file_id: a.file_id, filename: a.filename, title: a.title, date: a.date, tags: a.tags, hits: 0, score: 0, top: a });
    f.hits++; f.score = Math.max(f.score, a.score);
  }
  return json({
    atoms: r.ent.atoms ? atoms.slice(0, limit) : [],
    files: r.ent.files ? Object.values(byFile).sort((x, y) => y.score - x.score) : [],
    total: atoms.length,
  });
}

function toAtom(a) {
  const md = a.metadata || {};
  const filename = md.filename || md.table_id || a.uri || a.file_id;
  const crumb = (md.breadcrumb || '').replace(/^#+\s*/, '').replace(/ > #+\s*/g, ' › ');
  return {
    id: a.file_id + ':' + a.sequence_index,
    file_id: a.file_id, filename,
    title: crumb.split(' › ')[0] || filename.split('/').pop(),
    breadcrumb: crumb || filename, speaker: null, time: null,
    date: md.date || '', tags: a.tags || [], kind: 'text',
    text: (a.text || '').trim(), score: a.score || 0,
  };
}

async function sharedResult(env, id, r, atomId, url) {
  const [fileId, seq] = atomId.split(':');
  if (!fileId || !/^\d+$/.test(seq || '')) return new Response('Not found', { status: 404 });
  const res = await fetch(`${env.KD_API}/api/v1/vector_stores/${r.store}/files/${fileId}/atoms?offset=${Math.max(0, +seq - 2)}&limit=5&fields=${FIELDS}`, { headers: { Authorization: 'Bearer ' + r.token } });
  if (!res.ok) return page(env, 'share.html', publicLink(id, r), null, url);
  const list = ((await res.json()).atoms || []).map(toAtom);
  const atom = list.find((a) => a.id === atomId);
  // Scope is enforced here too: a forwarded link can't be edited to reach atoms outside it.
  if (!atom || !r.scope.every((t) => atom.tags.includes(t))) return new Response('Not found', { status: 404 });
  if (!r.ent.snippet) atom.text = '';
  const snippet = atom.text.length > 180 ? atom.text.slice(0, 180).replace(/\s+\S*$/, '') + '…' : atom.text;
  return page(env, 'share.html', publicLink(id, r), og({
    title: atom.title + ' · KnowDrive',
    description: snippet ? '“' + snippet + '”' : 'A result shared from ' + r.store_name,
    image: env.APP_BASE + 'og-result.png',
    url: url.origin + url.pathname,
    type: 'article',
  }), url, { KD_ATOM: atom, KD_CONTEXT: r.ent.open ? list : null });
}

// Serve the static page with OG tags replaced and the link config injected.
async function page(env, file, linkCfg, ogTags, url, extra = {}) {
  const base = await fetch(env.APP_BASE + file);
  const boot = { KD_LIVE_PROXY: url.origin, KD_LINK: linkCfg && !linkCfg.error ? linkCfg : null, KD_LINK_ERROR: linkCfg && linkCfg.error ? linkCfg.error : null, ...extra };
  const rw = new HTMLRewriter()
    .on('head', { element(e) {
      e.prepend(`<base href="${env.APP_BASE}">`, { html: true });
      e.append(`<script>${Object.entries(boot).map(([k, v]) => `window.${k}=${safeJson(v)};`).join('')}</script>`, { html: true });
    } });
  if (ogTags) {
    rw.on('meta[property^="og:"], meta[name="description"]', { element(e) { e.remove(); } })
      .on('title', { element(e) { e.setInnerContent(ogTags.title); e.after(ogTags.html, { html: true }); } });
  }
  return rw.transform(new Response(base.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=60' } }));
}

function og({ title, description, image, url, type = 'website' }) {
  const t = (k, v) => `<meta property="og:${k}" content="${esc(v)}">`;
  return { title, html: [
    `<meta name="description" content="${esc(description)}">`,
    t('type', type), t('site_name', 'KnowDrive'), t('title', title), t('description', description),
    t('url', url), t('image', image), t('image:width', '1200'), t('image:height', '630'),
  ].join('') };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

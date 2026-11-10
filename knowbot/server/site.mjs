// KnowBot "Single-page site" answer surface: the site spec built from a bot's own files, and the standalone page.
// Pure (no network, no DOM): server/trials.mjs gathers the inputs (files, validated questions, atoms, the website
// import's name and brand) and calls buildSite(); server/devapi.mjs serves publicSite() at GET /api/site/:botId.
//
// Rules (owner): nothing on the page is invented.
//   - chips and popular questions come only from questions the Studio already validated against the files
//     (questionsFor: starters and Proof Run questions, each answered from a named file above the floor);
//   - a "key facts" line (phone, email, opening hours) is a verbatim line of one of the bot's files, kept with its
//     source; a line that is not found word for word in the atoms is dropped;
//   - the business name comes from the owner (spec), the website import (og:site_name) or the bot's name;
//   - the brand colour and logo only when the website import read them from the site's own head, else a default.
// The page itself (site/index.html + site/site.js + site/site.css) asks the bot through the developer API with a
// short-lived key that can only ask questions (scope "site"), minted by the server when the site is published.

export const SITE_CHIPS_MAX = 8;
export const SITE_QUESTIONS_MAX = 5;
export const SITE_FACTS_MAX = 4;
export const SITE_LINKS_MAX = 2000;
export const SITE_HOST = 'https://knowbot.knowdrive.ai';
/** The avatar hues (studio.css --f0…--f7, light): the default accent when the website gave no colour. */
const HUES = ['#4f46e5', '#0e7490', '#be185d', '#9a4508', '#047857', '#7c3aed', '#b45309', '#1d4ed8'];

const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const baseName = (p) => String(p || '').split('/').pop();

/**
 * "site/lumen.example/policy/refund-policy.md" or "Lumen Bikes · Refund policy.md" → "Refund policy". With the business
 * name, its words are dropped from the front ("lumen-store-faq.txt" for Lumen Bikes → "Store FAQ").
 */
export function fileLabel(name, business = '') {
  let b = baseName(name).replace(/\.[a-z0-9]{1,8}$/i, '');
  if (b.includes(' · ')) b = b.split(' · ').pop();
  b = b.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const w of String(business).toLowerCase().split(/\s+/).filter((x) => x.length > 2)) {
    const m = new RegExp(`^${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?=\\S)`, 'i').exec(b);
    if (m) b = b.slice(m[0].length);
  }
  b = b.replace(/\b(faq|faqs|pdf|usa|uk|eu|diy)\b/gi, (x) => x.toUpperCase().replace(/S$/, 's'));
  return b ? b.charAt(0).toUpperCase() + b.slice(1) : '';
}

/** The business name the page carries: the owner's, else the website's, else the bot's (minus "Help", "Bot"…). */
export function siteNameOf(spec = {}, store = null) {
  const strip = (s) => oneLine(s).replace(/\s+(?:help|helper|bot|assistant|guide|answers|support|desk|chat|faq)$/i, '').trim();
  const fromStore = store?.name ? strip(store.name) : '';
  const fromOrg = spec.org ? strip(spec.org) : '';
  const fromName = spec.name && spec.name !== 'SampleBot' ? strip(spec.name) : '';
  return clip(fromStore || fromOrg || fromName || 'Our help centre', 60);
}

// ------------------------------------------------------------------------------------------------ colour
const hex = (c) => { const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim()); if (!m) return null; const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1]; return `#${h.toLowerCase()}`; };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (a) => `#${a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const lum = (h) => { const [r, g, b] = rgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (h, to, t) => { const a = rgb(h), b = rgb(to); return toHex(a.map((v, i) => v + (b[i] - v) * t)); };
/** A colour that white text (buttons) reads on at 4.5:1, and a lighter one that reads on the dark page at 4.5:1. */
export function brandColors(color, hue = 0) {
  let c = hex(color) || HUES[(Number(hue) || 0) % HUES.length];
  for (let i = 0; i < 20 && contrast(c, '#ffffff') < 4.6; i++) c = mix(c, '#000000', 0.08);
  let d = c;
  for (let i = 0; i < 24 && contrast(d, '#15151f') < 4.6; i++) d = mix(d, '#ffffff', 0.08);
  return { color: c, colorDark: d, fromSite: !!hex(color) };
}

// ------------------------------------------------------------------------------------------------ key facts
const FACT_KINDS = [
  { kind: 'phone', label: 'Phone', re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\b\d{2,4}[\s.-])\d{3}[\s.-]?\d{3,4}\b/ },
  { kind: 'email', label: 'Email', re: /\b[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i },
  { kind: 'hours', label: 'Hours', re: /\b(?:open|opening hours|hours|closed)\b[^.\n]{0,80}?\b(?:\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2})/i },
];
/** Lines of an atom, each trimmed of a list or heading marker only (so the rest is still a verbatim substring). */
function atomLines(text) {
  return String(text || '').split(/\n+/).flatMap((l) => {
    const t = l.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d{1,3}[.)]\s+|>\s*)/, '').trim();
    if (!t) return [];
    if (t.length <= 200) return [t];
    return t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
  });
}
/**
 * Key facts quoted word for word from the files: at most one per kind (phone, email, hours), SITE_FACTS_MAX in all.
 * atomsByFile: [{ file: {id, name, url?}, atoms: [{text}] }]. Every fact keeps the file it came from; a line with
 * markdown emphasis, a table row or a template placeholder is skipped (it would not read as a sentence on the page).
 */
export function factsFrom(atomsByFile = []) {
  const out = [];
  for (const { kind, label, re } of FACT_KINDS) {
    if (out.length >= SITE_FACTS_MAX) break;
    let best = null;
    for (const { file, atoms } of atomsByFile) {
      for (const a of atoms || []) {
        for (const line of atomLines(a.text)) {
          if (line.length < 8 || line.length > 200 || /[*_`|{}<>]/.test(line) || !re.test(line)) continue;
          if (!String(a.text).includes(line)) continue; // verbatim or nothing
          if (!best || line.length < best.text.length) best = { kind, label, text: line, file: file.name, fileId: file.id, url: file.url || null };
        }
      }
      if (best) break; // the first file (in reading order) that states it
    }
    if (best) out.push(best);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the generator
/**
 * @param {object} o
 * @param {object} o.spec        the bot spec (name, org, purpose, avatar)
 * @param {object[]} o.files     ready, enabled files ({id, name, path?, url?, summary?})
 * @param {{starters:object[], proof:object[]}} o.questions  questionsFor(): validated questions ({q, fileId, file})
 * @param {object[]} [o.atomsByFile]  [{file, atoms}] for key facts
 * @param {object} [o.store]     T.flags.storeLast: {name, url, brand:{color, logo}}
 * @returns the generated site (no owner edits applied)
 */
export function buildSite({ spec = {}, files = [], questions = {}, atomsByFile = [], store = null, now = Date.now() } = {}) {
  const name = siteNameOf(spec, store);
  const byId = new Map(files.map((f) => [f.id, f]));
  const valid = [];
  for (const v of [...(questions.starters || []), ...(questions.proof || [])]) {
    const q = oneLine(v?.q);
    if (!q || q.length > 140 || !byId.has(v.fileId) || valid.some((x) => x.q.toLowerCase() === q.toLowerCase())) continue;
    valid.push({ q, fileId: v.fileId });
  }
  // chips: one per file first (its title as the label, a validated question from that file as the question), then
  // the file's summary topics for its next questions; never a label without a validated question behind it
  const chips = [];
  const used = new Set();
  const labels = new Set();
  const perFile = new Map();
  for (const v of valid) { if (!perFile.has(v.fileId)) perFile.set(v.fileId, []); perFile.get(v.fileId).push(v); }
  const labelFor = (f, round) => {
    if (round === 0) return clip(fileLabel(String(f.name || '').includes(' · ') ? f.name : f.path || f.name, name), 40);
    const topics = Array.isArray(f.summary?.topics) ? f.summary.topics : [];
    return topics[round - 1] ? clip(String(topics[round - 1]).replace(/^./, (c) => c.toUpperCase()), 40) : '';
  };
  for (let round = 0; round < 4 && chips.length < SITE_CHIPS_MAX; round++) {
    for (const fid of files.map((f) => f.id).filter((id) => perFile.has(id))) { // files in reading order
      const qs = perFile.get(fid);
      if (chips.length >= SITE_CHIPS_MAX) break;
      const v = qs.find((x) => !used.has(x.q));
      const label = v ? labelFor(byId.get(fid), round) : '';
      if (!v || !label || labels.has(label.toLowerCase())) continue;
      chips.push({ label, q: v.q });
      used.add(v.q); labels.add(label.toLowerCase());
    }
  }
  const popular = [...valid.filter((v) => !used.has(v.q)), ...valid.filter((v) => used.has(v.q))].slice(0, SITE_QUESTIONS_MAX).map((v) => v.q);
  // links: a website page's citation opens the page itself (by file id, and by the file name a citation carries)
  const links = { byId: {}, byName: {} };
  let n = 0;
  for (const f of files) {
    if (n >= SITE_LINKS_MAX) break;
    const u = typeof f.url === 'string' && /^https?:\/\//i.test(f.url) ? f.url : null;
    if (!u) continue;
    links.byId[f.id] = u;
    links.byName[baseName(f.path || f.name)] = u;
    n++;
  }
  const brand = brandColors(store?.brand?.color, spec.avatar?.hue);
  const logo = typeof store?.brand?.logo === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(store.brand.logo) ? store.brand.logo : null;
  const homeUrl = typeof store?.url === 'string' && /^https?:\/\//i.test(store.url) ? store.url : null;
  const tagline = spec.purpose ? clip(spec.purpose, 160) : `Ask a question. The answer comes from ${name}'s own pages, with the sources.`;
  return {
    v: 1, name, tagline, chips, questions: popular, facts: factsFrom(atomsByFile), links,
    brand: { ...brand, logo }, homeUrl, initials: String(spec.avatar?.initials || name.slice(0, 2)).toUpperCase().slice(0, 2),
    fileKey: files.map((f) => f.id).sort().join(','), generatedAt: new Date(now).toISOString(),
  };
}

// ------------------------------------------------------------------------------------------------ owner edits
/** Owner edits from POST /site: { name?, tagline?, chips?, published? } → validated, or throws { status:400, field }. */
export function validateSiteEdit(body, current = {}) {
  const bad = (field, message) => { const e = new Error(`${field}: ${message}`); e.status = 400; e.code = 'bad_request'; e.field = field; throw e; };
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body', 'must be a JSON object');
  const next = { ...current };
  for (const k of Object.keys(body)) {
    if (!['name', 'tagline', 'chips', 'published', 'regenerate'].includes(k)) bad(k, 'unknown field');
  }
  if (body.name !== undefined) {
    if (body.name === null || body.name === '') delete next.name;
    else { if (typeof body.name !== 'string') bad('name', 'must be a string'); const t = oneLine(body.name); if (!t || t.length > 60) bad('name', 'must be 1 to 60 characters'); next.name = t; }
  }
  if (body.tagline !== undefined) {
    if (body.tagline === null || body.tagline === '') delete next.tagline;
    else { if (typeof body.tagline !== 'string') bad('tagline', 'must be a string'); const t = oneLine(body.tagline); if (t.length > 160) bad('tagline', 'must be 160 characters or fewer'); next.tagline = t; }
  }
  if (body.chips !== undefined) {
    if (body.chips === null) delete next.chips;
    else {
      if (!Array.isArray(body.chips) || body.chips.length > SITE_CHIPS_MAX) bad('chips', `must be a list of up to ${SITE_CHIPS_MAX}`);
      next.chips = body.chips.map((c) => {
        const o = typeof c === 'string' ? { label: c, q: c } : c;
        if (!o || typeof o !== 'object' || typeof o.label !== 'string') bad('chips', 'each must be {label, q} or a question');
        const label = oneLine(o.label), q = oneLine(o.q ?? o.label);
        if (!label || label.length > 40) bad('chips', 'each label must be 1 to 40 characters');
        if (!q || q.length > 140) bad('chips', 'each question must be 1 to 140 characters');
        return { label, q };
      });
    }
  }
  if (body.published !== undefined) {
    if (typeof body.published !== 'boolean') bad('published', 'must be true or false');
    next.published = body.published;
  }
  return next;
}

/** The page's view of a site: generated content with the owner's edits on top. Never a key; the caller adds one. */
export function publicSite(gen, edits = {}, { botId, trial = true, expiresAt = null } = {}) {
  const g = gen || {};
  return {
    bot: botId, name: edits.name || g.name || 'Our help centre', tagline: edits.tagline ?? g.tagline ?? '',
    chips: Array.isArray(edits.chips) ? edits.chips : g.chips || [], questions: g.questions || [], facts: g.facts || [],
    links: g.links || { byId: {}, byName: {} }, brand: g.brand || brandColors(null), homeUrl: g.homeUrl || null, initials: g.initials || 'KB',
    published: !!edits.published, trial: !!trial, noindex: !!trial, expiresAt, generatedAt: g.generatedAt || null,
  };
}

// ------------------------------------------------------------------------------------------------ download
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/**
 * The single HTML file the owner downloads: the same page as the hosted one (it loads site.js and site.css from the
 * hosted site), with the bot id and API base in the script tag and the title, description and Open Graph tags filled
 * in. Popular questions are in the markup too, so the page reads well before the script runs.
 */
export function siteHtml(site, { botId, apiBase, assetBase = SITE_HOST } = {}) {
  const a = String(assetBase).replace(/\/+$/, '');
  const title = `${site.name} · Ask anything`;
  const qs = (site.questions || []).map((q) => `<li><a href="?q=${encodeURIComponent(q)}">${escHtml(q)}</a></li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(site.tagline)}">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(site.tagline)}">
<meta property="og:type" content="website">
${site.noindex ? '<meta name="robots" content="noindex">\n' : ''}<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="${escHtml(a)}">
<link rel="stylesheet" href="${escHtml(a)}/vendor/kd-theme/tokens.css">
<link rel="stylesheet" href="${escHtml(a)}/vendor/knowdrive-widgets/0.4.1/widgets.css">
<link rel="stylesheet" href="${escHtml(a)}/site/site.css">
</head>
<body>
<div id="ks-root" class="ks-root">
  <main class="ks-main"><h1 class="ks-h1">${escHtml(site.name)}</h1><p class="ks-tag">${escHtml(site.tagline)}</p>${qs ? `<ul class="ks-noscript-q">${qs}</ul>` : ''}</main>
</div>
<script type="module" src="${escHtml(a)}/site/site.js" data-bot="${escHtml(botId)}" data-api="${escHtml(apiBase)}"></script>
</body>
</html>
`;
}

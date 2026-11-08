// KnowBot Studio: the site "finder". Discovers and ranks the knowledge sources on a store or business website before
// anything is read, so the importer reads the best sources first and the Studio can report what it found.
// Zero dependencies (node: built-ins only). Every request goes through the SSRF-safe fetcher from storeimport.mjs
// (passed in as `f`): http/https, public addresses only, ports 80/443, robots.txt, redirects re-checked hop by hop.
//
// What it looks at, in order (see the research memo in the task; facts marked "live" were checked on real stores):
//   1. robots.txt: Sitemap lines and Crawl-delay (for our UA group, else *).
//   2. Every sitemap: robots' Sitemap lines, else the platform's usual paths (/sitemap.xml, /sitemap_index.xml,
//      /wp-sitemap.xml, /xmlsitemap.php, /hc/sitemap.xml). Indexes are followed to every child (products, pages,
//      collections, blogs), gzip children included.
//   3. Platform feeds: their product totals (WooCommerce X-WP-Total, Magento total_count); the reader pages through them.
//   4. /llms.txt links (Shopify serves one now; cheap).
//   5. Nav and footer links on the home page whose path or text names FAQ, help, support, shipping, delivery, returns,
//      refunds, exchanges, warranty, size guide, care, contact, about, terms or privacy.
//   6. Help centres linked from the site: the site's own help./support./docs. subdomains and hosted help desks
//      (Zendesk, Gorgias, Intercom, Freshdesk, Help Scout). Zendesk Guide is read through its public articles API.
//   7. Shopify's fixed policy pages (/policies/refund-policy, …).
//   8. PDFs (manuals, spec sheets, size charts) linked from the site; product pages add more while they are read.
// Every URL is canonicalised (tracking and variant parameters dropped, Shopify collection-scoped product paths
// collapsed, locale-prefixed duplicates folded) and classified as product | faq | policy | help | pdf | collection |
// blog | page. The plan ranks them: policies and FAQ, then help, then products, then PDFs, collections, blog, pages.

export const KIND_RANK = Object.freeze({ policy: 0, faq: 0, help: 1, product: 2, candidate: 2.5, pdf: 3, collection: 4, blog: 5, page: 6 });
export const KINDS = Object.freeze(['policy', 'faq', 'help', 'product', 'pdf', 'collection', 'blog', 'page']);
const FATAL = new Set(['aborted', 'quota']);
/**
 * The order sources are read in, and kept in when a cap applies: by kind (KIND_RANK, never a stale rank), then pages the
 * site's own menus link (nav/footer) before the rest, then the site's own pages before help-desk articles, then URL.
 */
export function compareSources(a, b) {
  const nav = (s) => (s.via?.some((v) => v === 'nav' || v === 'link') ? 0 : 1);
  const desk = (s) => (s.via?.includes('helpdesk') && !s.via.some((v) => v === 'nav' || v === 'link' || v === 'sitemap') ? 1 : 0);
  return (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || nav(a) - nav(b) || desk(a) - desk(b) || String(a.url).localeCompare(String(b.url));
}

// ------------------------------------------------------------------------------------------------ text helpers
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', middot: '·', bull: '•', laquo: '«', raquo: '»', shy: '' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch { return ''; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const oneLine = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------------------------------------ URLs
const TRACKING_RE = /^(?:utm_[a-z_]+|variant|ref|ref_|fbclid|gclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|srsltid|_pos|_sid|_ss|_psq|_v|igshid|yclid|dclid|currency|country|view)$/i;
const LOCALE_SEG_RE = /^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/i;
/** A cleaned URL (no hash, no tracking or variant parameters, Shopify collection-scoped products collapsed), or null. */
export function normalizeUrl(url, base) {
  let u;
  try { u = new URL(decodeEntities(String(url ?? '').trim()), base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING_RE.test(k)) u.searchParams.delete(k);
  u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
  // /collections/<c>/products/<handle> is the same product page as /products/<handle> (Shopify)
  u.pathname = u.pathname.replace(/^((?:\/[a-z]{2}(?:-[a-z]{2,4})?)?)\/collections\/[^/]+\/products\/([^/]+)\/?$/i, '$1/products/$2');
  return u.href;
}
/** The dedupe key of a URL: normalized, no www., no locale prefix, lowercased path. */
export function urlKey(url) {
  const n = normalizeUrl(url);
  if (!n) return null;
  const u = new URL(n);
  return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(LOCALE_SEG_RE, '').replace(/\/+$/, '').toLowerCase() || '/'}${u.search}`;
}
const pathOf = (url) => { try { return decodeURIComponent(new URL(url).pathname); } catch { try { return new URL(url).pathname; } catch { return String(url || ''); } } };
const words = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

// ------------------------------------------------------------------------------------------------ classification
export const FAQ_RE = / (?:faqs?|frequently asked|frequently asked questions|questions|q a|qa) /;
export const POLICY_RE = / (?:shipping|delivery|deliveries|returns?|refunds?|exchanges?|warrant(?:y|ies)|guarantees?|polic(?:y|ies)|terms|tos|privacy|legal|imprint|impressum|cookies?|conditions|gdpr|accessibility|refund policy|shipping policy) /;
export const HELP_RE = / (?:help|support|customer service|customer care|customer support|size guide|size chart|sizing|fit guide|care|care guide|care instructions|contact|contact us|about|about us|our story|how to|guide|guides|track order|order status|payments?|financing|store locator|stores|warranty registration|manuals?|instructions|assembly|setup|troubleshooting|knowledge base|kb|hc|docs|documentation) /;
const PRODUCT_PATH = {
  shopify: /^(?:\/[a-z]{2}(?:-[a-z]{2,4})?)?\/products\/[^/]+$/i,
  woocommerce: /^\/(?:[a-z]{2}\/)?product\/[^/]+$/i,
  wix: /\/product-page\/[^/]+$/i,
  squarespace: /\/p\/[^/]+$/i,
  generic: /\/(?:products?|p|item|items|dp|catalog\/product)\/[^/]+$/i,
};
// /shop/<x> and /catalog/<x> are as often category pages as products: candidates, read and kept as a product only when
// the page carries Product JSON-LD (else read as a collection page)
const WEAK_PRODUCT_PATH = /\/(?:shop|catalog|store)\/[^/]+$/i;
const COLLECTION_PATH = /\/(?:collections?|product-category|categories|category|c|shop|catalog|departments?)(?:\/[^/]+)*$|\/collections$/i;
const BLOG_PATH = /\/(?:blogs?|news|articles?|journal|stories|posts?|magazine|insights)(?:\/|$)/i;

/** Classify a sitemap file by its URL: product | collection | blog | page | image | null. */
export function sitemapHint(url) {
  const s = `${pathOf(url)}?${(() => { try { return new URL(url).search; } catch { return ''; } })()}`.toLowerCase();
  if (/image|video/.test(s) && !/product/.test(s)) return 'image';
  if (/type=products|product/.test(s)) return 'product';
  if (/type=categories|type=brands|categor|collection|taxonom|brand|product_cat|product-cat/.test(s)) return 'collection';
  if (/type=news|blog|post|article|news/.test(s)) return 'blog';
  if (/type=pages|page/.test(s)) return 'page';
  return null;
}

/**
 * Classify a URL as product | faq | policy | help | pdf | collection | blog | page.
 * hint: what its sitemap says (product, collection, blog, page); text: the link text (nav/footer).
 */
export function classifyUrl(url, { platform = 'generic', hint = null, text = '', helpHost = false } = {}) {
  const p = pathOf(url).replace(/(.)\/+$/, '$1');
  const lp = p.toLowerCase();
  if (/\.pdf$/i.test(lp)) return 'pdf';
  if (/^\/policies\/[^/]+$/.test(lp)) return /contact/.test(lp) ? 'help' : 'policy';
  const w = words(`${p.replace(/\.[a-z0-9]{2,5}$/i, '')} ${text}`);
  const pw = words(p.replace(/\.[a-z0-9]{2,5}$/i, ''));
  const prodRe = PRODUCT_PATH[platform] || PRODUCT_PATH.generic;
  const plain = !FAQ_RE.test(pw) && !POLICY_RE.test(pw) && !HELP_RE.test(pw);
  // Magento: products and categories are both /<url-key>.html: a candidate until its page shows Product JSON-LD
  // (a sitemap that names itself a product sitemap is trusted)
  if (platform === 'magento' && /\.html$/i.test(lp) && plain && !BLOG_PATH.test(p) && hint !== 'page') return hint === 'product' ? 'product' : 'candidate';
  if (hint === 'product' || prodRe.test(p) || (platform !== 'shopify' && PRODUCT_PATH.generic.test(p) && plain)) {
    if (hint !== 'page') return 'product';
  }
  if (platform !== 'shopify' && WEAK_PRODUCT_PATH.test(p) && plain && hint !== 'page' && hint !== 'collection' && !BLOG_PATH.test(p)) return 'candidate';
  if (helpHost || /\/hc\/[^/]+\/articles\//.test(lp) || /\/support\/solutions\/articles\//.test(lp) || /\/(?:article|articles)\/\d+/.test(lp) && helpHost) return FAQ_RE.test(w) ? 'faq' : POLICY_RE.test(w) ? 'policy' : 'help';
  if (hint === 'collection' || (COLLECTION_PATH.test(p) && !FAQ_RE.test(pw) && !POLICY_RE.test(pw))) return 'collection';
  if (hint === 'blog' || (BLOG_PATH.test(p) && hint !== 'page')) return 'blog';
  if (FAQ_RE.test(w)) return 'faq';
  if (POLICY_RE.test(w)) return 'policy';
  if (HELP_RE.test(w)) return 'help';
  return 'page';
}

// ------------------------------------------------------------------------------------------------ hosted help desks
const DESKS = [
  ['zendesk', /\.zendesk\.com$/i], ['gorgias', /\.gorgias\.help$/i], ['intercom', /(?:^|\.)intercom\.help$/i], ['freshdesk', /\.freshdesk\.com$/i],
  ['helpscout', /\.helpscoutdocs\.com$/i], ['gitbook', /\.gitbook\.io$/i], ['helpjuice', /\.helpjuice\.com$/i], ['reamaze', /\.reamaze\.com$/i],
];
/** 'zendesk' | 'gorgias' | … | 'subdomain' (the site's own help./support./docs. host) | null. */
export function helpDeskOf(host, siteDomain) {
  const h = String(host || '').toLowerCase();
  for (const [name, re] of DESKS) if (re.test(h)) return name;
  if (siteDomain && (h === siteDomain || h.endsWith(`.${siteDomain}`)) && /^(?:help|support|docs|faq|faqs|care|hc|kb|knowledge|customercare|service)\./.test(h)) return 'subdomain';
  return null;
}

// ------------------------------------------------------------------------------------------------ HTML links
/** [{url, text}] for every <a href> in an HTML document (fragments dropped, relative links resolved). */
export function anchorsOf(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = href ? (href[1] ?? href[2] ?? href[3] ?? '') : '';
    if (!raw || /^(?:#|javascript:|mailto:|tel:|data:)/i.test(raw.trim())) continue;
    const url = normalizeUrl(raw, baseUrl);
    if (!url) continue;
    const label = /\baria-label\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] || /\btitle\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] || '';
    out.push({ url, text: oneLine(m[2]).slice(0, 120) || oneLine(label).slice(0, 120) });
  }
  return out;
}
/** <link rel="canonical"> of a page, resolved, or null. */
export function canonicalOf(html, pageUrl) {
  const m = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(String(html || ''));
  if (!m) return null;
  const href = /\bhref=["']([^"']+)["']/i.exec(m[0])?.[1];
  return href ? normalizeUrl(href, pageUrl) : null;
}

// ------------------------------------------------------------------------------------------------ robots extras
/** Crawl-delay (seconds) for our UA group, else `*`, else 0. parsed: parseRobots() output with crawlDelay per group. */
export function robotsCrawlDelay(parsed, token = 'knowbotstudio') {
  let best = -1, delay = 0;
  for (const g of parsed?.groups || []) {
    for (const a of g.agents) {
      const score = a === '*' ? 0 : a && (token.includes(a) || a.includes(token)) ? a.length : -1;
      if (score > best) { best = score; delay = Number(g.crawlDelay) || 0; }
    }
  }
  return Math.max(0, delay);
}

// ------------------------------------------------------------------------------------------------ sitemaps
/**
 * Crawl every sitemap: seeds first (robots Sitemap lines), then defaults when the seeds gave nothing. Indexes are
 * followed to every child (images skipped), level by level, children in parallel (the fetcher caps concurrency).
 * → { entries:[{loc, sitemap, hint, lastmod}], files: n, failed: n }
 */
export async function crawlSitemaps(f, { seeds = [], defaults = [], maxFiles = 300, maxUrls = 60000, inflate } = {}) {
  const entries = [], seenLoc = new Set(), seenMap = new Set();
  let files = 0, failed = 0;
  async function runLevel(list, depth) {
    const next = [];
    await Promise.all(list.map(async ({ u, hint }) => {
      if (seenMap.has(u) || files >= maxFiles || entries.length >= maxUrls) return;
      seenMap.add(u);
      let r;
      try { r = await f.get(u, { accept: 'application/xml,text/xml,*/*' }); } catch (e) { if (FATAL.has(e.code)) throw e; failed++; return; }
      files++;
      let xml = r.body;
      if (xml[0] === 0x1f && xml[1] === 0x8b && inflate) { try { xml = inflate(xml); } catch { failed++; return; } }
      const s = xml.toString('utf8');
      if (/<sitemapindex\b/i.test(s)) {
        for (const m of s.matchAll(/<sitemap\b[\s\S]*?<\/sitemap\s*>/gi)) {
          const loc = /<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i.exec(m[0])?.[1];
          if (!loc) continue;
          const child = decodeEntities(loc.trim());
          if (!f.hostOkFor(child)) continue;
          const h = sitemapHint(child);
          if (h === 'image') continue;
          if (depth < 3) next.push({ u: child, hint: h || hint });
        }
        return;
      }
      for (const m of s.matchAll(/<url\b[\s\S]*?<\/url\s*>/gi)) {
        if (entries.length >= maxUrls) break;
        const loc = /<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i.exec(m[0])?.[1];
        if (!loc) continue;
        const url = normalizeUrl(decodeEntities(loc.trim()));
        if (!url || !f.hostOkFor(url)) continue;
        const k = urlKey(url);
        if (seenLoc.has(k)) continue;
        seenLoc.add(k);
        const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[0])?.[1] || null;
        entries.push({ loc: url, sitemap: u, hint: hint || sitemapHint(u), lastmod });
      }
      // a plain-text sitemap (one URL per line)
      if (!/<urlset\b/i.test(s) && !/</.test(s.slice(0, 200))) {
        for (const line of s.split(/\r?\n/)) {
          const url = /^https?:\/\//i.test(line.trim()) ? normalizeUrl(line.trim()) : null;
          if (url && f.hostOkFor(url) && !seenLoc.has(urlKey(url))) { seenLoc.add(urlKey(url)); entries.push({ loc: url, sitemap: u, hint: hint || sitemapHint(u), lastmod: null }); }
        }
      }
    }));
    return next;
  }
  const walk = async (start) => {
    let level = start.map((u) => ({ u, hint: sitemapHint(u) })).filter((x) => x.hint !== 'image');
    for (let depth = 0; level.length && depth <= 3; depth++) level = await runLevel(level, depth);
  };
  await walk([...new Set(seeds)]);
  if (!entries.length) await walk([...new Set(defaults)].filter((u) => !seenMap.has(u)));
  return { entries, files, failed };
}

// ------------------------------------------------------------------------------------------------ the plan
const SHOPIFY_POLICIES = ['refund-policy', 'shipping-policy', 'privacy-policy', 'terms-of-service', 'contact-information'];
const SITEMAP_DEFAULTS = {
  shopify: ['/sitemap.xml'],
  woocommerce: ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml', '/product-sitemap.xml'],
  magento: ['/sitemap.xml', '/pub/media/sitemap.xml', '/media/sitemap.xml'],
  bigcommerce: ['/xmlsitemap.php'],
  squarespace: ['/sitemap.xml'],
  wix: ['/sitemap.xml'],
  generic: ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap.txt'],
};

/**
 * Discover and rank a site's knowledge sources. Nothing is read beyond robots, sitemaps, llms.txt, cheap feed totals
 * and help-desk listings.
 *
 * @param f    createStoreFetcher() instance (allowSite already called for the store).
 * @param det  detectPlatform() result: { platform, api, base, name, home:{url, html}, apiBase? }.
 * @param o    { inflate(buf), registrable(host), allowHelpHost(host), feedTotal?: async () => number|null, maxHelpArticles?: 2000,
 *               onDiscover?({ step: 'sitemaps'|'links', urls, … }) }
 * @returns {Promise<Plan>} {
 *   base, host, platform, name,
 *   sources: [{ url, kind, rank, via, text?, lastmod?, helpdesk? }]   (ranked, de-duplicated; products included),
 *   productUrls: string[]                                             (every product page URL found outside the feed),
 *   feedTotal: number|null,                                           (the platform feed's product count, when cheap)
 *   helpdesks: [{ type, origin, prefix, api }],
 *   prefetched: Map<url, { html, title, kind }>                       (help-desk articles read through an API),
 *   counts: { product, faq, policy, help, pdf, collection, blog, page }, samples: { kind: [url, url, url] },
 *   guesses: n                                                        (platform pages tried but not counted: /policies/*),
 *   robots: { crawlDelay, sitemaps, sitemapFiles, disallowed }, notes: [string]
 * }
 */
export async function findSources(f, det, o = {}) {
  const base = det.base;
  const host = new URL(base).hostname.toLowerCase();
  const siteDomain = (o.registrable || ((h) => h))(host);
  const platform = det.platform || 'generic';
  const notes = [];
  const byKey = new Map();
  const helpdesks = [];
  const prefetched = new Map();
  let disallowed = 0;

  const add = (url, kind, via, extra = {}) => {
    const u = normalizeUrl(url);
    // PDFs may also live on an allowed asset CDN (cdn.shopify.com …): f.pdfOkFor says so
    if (!u || !(kind === 'pdf' && f.pdfOkFor ? f.pdfOkFor(u) : f.hostOkFor(u))) return null;
    const k = urlKey(u);
    const cur = byKey.get(k);
    if (cur) {
      // the same page found twice: keep the better-ranked kind, the shorter (unprefixed) URL, every via
      if (KIND_RANK[kind] < KIND_RANK[cur.kind] && !(cur.kind === 'product' && kind !== 'faq' && kind !== 'policy')) cur.kind = kind;
      if (new URL(u).pathname.length < new URL(cur.url).pathname.length) cur.url = u;
      if (!cur.via.includes(via)) cur.via.push(via);
      if (extra.text && !cur.text) cur.text = extra.text;
      return cur;
    }
    const s = { url: u, kind, rank: KIND_RANK[kind] ?? 9, via: [via], ...extra };
    byKey.set(k, s);
    return s;
  };

  // 1. robots.txt
  let robots = { groups: [], sitemaps: [] };
  try { robots = await f.robotsFor(new URL(base).origin); } catch (e) { if (FATAL.has(e.code)) throw e; }
  const crawlDelay = robotsCrawlDelay(robots);

  // 2. sitemaps
  const seeds = (robots.sitemaps || []).map((s) => normalizeUrl(s, base)).filter((s) => s && f.hostOkFor(s));
  const defaults = (SITEMAP_DEFAULTS[platform] || SITEMAP_DEFAULTS.generic).map((p) => `${base}${p}`);
  const sm = await crawlSitemaps(f, { seeds, defaults, inflate: o.inflate, maxFiles: o.maxSitemapFiles || 300 });
  o.onDiscover?.({ step: 'sitemaps', urls: sm.entries.length, sitemaps: sm.files });
  const productUrls = [];
  for (const e of sm.entries) {
    let kind = classifyUrl(e.loc, { platform, hint: e.hint });
    if (kind === 'product') productUrls.push(e.loc);
    add(e.loc, kind, 'sitemap', e.lastmod ? { lastmod: e.lastmod } : {});
  }

  // 3. platform extras: Shopify's fixed policy pages
  // (unverified guesses: read like any source, but not counted as found until a page answers)
  if (platform === 'shopify') for (const h of SHOPIFY_POLICIES) { const g = add(`${base}/policies/${h}`, h === 'contact-information' ? 'help' : 'policy', 'platform'); if (g && g.via.length === 1) g.guess = true; }

  // 4. llms.txt (cheap; links only)
  try {
    const r = await f.fetch(`${base}/llms.txt`, { accept: 'text/plain,text/markdown,*/*' });
    const ct = String(r.headers?.['content-type'] || '');
    if (r.ok && !/html/i.test(ct)) {
      const t = r.text().slice(0, 512 * 1024);
      for (const m of t.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) { const k = classifyUrl(m[2], { platform, text: m[1] }); if (k !== 'page' || /\.md$/.test(m[2]) === false) add(m[2], k, 'llms', { text: m[1] }); }
      notes.push('llms.txt found');
    }
  } catch (e) { if (FATAL.has(e.code)) throw e; }

  // 5. nav and footer links on the home page (and help desks they point to)
  const homeHtml = det.home?.html || '';
  const homeUrl = det.home?.url || `${base}/`;
  const deskOrigins = new Map();
  for (const a of anchorsOf(homeHtml, homeUrl)) {
    let u;
    try { u = new URL(a.url); } catch { continue; }
    const desk = helpDeskOf(u.hostname, siteDomain);
    if (desk && u.hostname !== host) {
      const prefix = desk === 'intercom' && u.hostname === 'intercom.help' ? `/${u.pathname.split('/')[1] || ''}` : '/';
      const key = `${u.origin}${prefix}`;
      if (!deskOrigins.has(key)) deskOrigins.set(key, { type: desk, origin: u.origin, prefix, host: u.hostname, linkedFrom: homeUrl });
      continue;
    }
    const kind = classifyUrl(a.url, { platform, text: a.text });
    if (kind === 'pdf') { add(a.url, 'pdf', 'link', { text: a.text }); continue; }
    if (!f.hostOkFor(a.url)) continue;
    if (kind === 'pdf') add(a.url, 'pdf', 'link', { text: a.text });
    else if (kind === 'faq' || kind === 'policy' || kind === 'help') add(a.url, kind, 'nav', { text: a.text });
    else if (kind === 'product') { add(a.url, 'product', 'nav', { text: a.text }); productUrls.push(normalizeUrl(a.url)); }
  }

  // 6. help centres: hosted desks are allowed only because the site links them; Zendesk Guide has a public API
  for (const d of deskOrigins.values()) {
    o.allowHelpHost?.(d.host);
    let api = false;
    try {
      const r = await f.fetch(`${d.origin}/api/v2/help_center/articles.json?per_page=100`, { accept: 'application/json' });
      const j = r.ok ? r.json() : undefined;
      if (j && Array.isArray(j.articles)) {
        api = true;
        d.type = d.type === 'subdomain' ? 'zendesk' : d.type;
        let page = j, n = 0;
        for (let guard = 0; page && guard < 40; guard++) {
          for (const a of page.articles || []) {
            if (n >= (o.maxHelpArticles ?? 2000) || a.draft) continue;
            const url = normalizeUrl(a.html_url || '', d.origin);
            if (!url || !f.hostOkFor(url)) continue;
            const kind = FAQ_RE.test(words(`${a.title} ${a.name || ''}`)) ? 'faq' : POLICY_RE.test(words(a.title)) ? 'policy' : 'help';
            const s = add(url, kind, 'helpdesk', { text: a.title, helpdesk: 'zendesk' });
            if (s) { prefetched.set(urlKey(url), { html: `<main><h1>${String(a.title || '').replace(/</g, '&lt;')}</h1>${a.body || ''}</main>`, title: oneLine(a.title), kind }); n++; }
          }
          const next = page.next_page ? normalizeUrl(page.next_page, d.origin) : null;
          if (!next || !f.hostOkFor(next)) break;
          let r2;
          try { r2 = await f.fetch(next, { accept: 'application/json' }); } catch (e) { if (FATAL.has(e.code)) throw e; break; }
          page = r2.ok ? r2.json() : null;
        }
      }
    } catch (e) { if (FATAL.has(e.code)) throw e; }
    if (!api) {
      // other desks: their sitemap (articles under the linked prefix), else the links on their home page
      const smd = await crawlSitemaps(f, { seeds: [`${d.origin}/sitemap.xml`], inflate: o.inflate, maxFiles: 20 }).catch((e) => { if (FATAL.has(e.code)) throw e; return { entries: [] }; });
      let urls = smd.entries.map((e) => e.loc).filter((u) => new URL(u).pathname.startsWith(d.prefix));
      if (!urls.length) {
        try {
          const r = await f.get(`${d.origin}${d.prefix}`, { accept: 'text/html' });
          urls = anchorsOf(r.text(), r.url).map((a) => a.url).filter((u) => { try { const x = new URL(u); return x.origin === d.origin && x.pathname.startsWith(d.prefix) && x.pathname !== d.prefix; } catch { return false; } });
        } catch (e) { if (FATAL.has(e.code)) throw e; }
      }
      for (const u of urls.slice(0, o.maxHelpArticles ?? 2000)) add(u, classifyUrl(u, { platform: 'generic', helpHost: true }), 'helpdesk', { helpdesk: d.type });
    }
    helpdesks.push({ type: d.type, origin: d.origin, prefix: d.prefix, api });
  }

  o.onDiscover?.({ step: 'links', urls: byKey.size, helpdesks: helpdesks.length });
  // 7. robots: count what it keeps us from (reported, never read)
  const sources = [...byKey.values()];
  const allowed = [];
  for (const s of sources) {
    let ok = true;
    try { ok = await f.robotsAllowed(s.url); } catch (e) { if (FATAL.has(e.code)) throw e; }
    if (ok) allowed.push(s); else disallowed++;
  }
  allowed.sort((a, b) => a.rank - b.rank || (a.via.includes('nav') ? 0 : 1) - (b.via.includes('nav') ? 0 : 1) || a.url.localeCompare(b.url));

  // 8. feed totals (cheap probes only)
  let feedTotal = null;
  try { feedTotal = o.feedTotal ? await o.feedTotal() : null; } catch (e) { if (FATAL.has(e.code)) throw e; }

  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const samples = Object.fromEntries(KINDS.map((k) => [k, []]));
  let guesses = 0;
  for (const s of allowed) { if (s.guess && s.via.length === 1) { guesses++; continue; } counts[s.kind]++; if (samples[s.kind].length < 3) samples[s.kind].push(s.url); }
  if (feedTotal != null && feedTotal > counts.product) counts.product = feedTotal;
  return {
    base, host, platform, name: det.name || null, sources: allowed, productUrls: [...new Set(productUrls.filter(Boolean))], feedTotal, helpdesks, prefetched,
    counts, samples, guesses, robots: { crawlDelay, sitemaps: (robots.sitemaps || []).length, sitemapFiles: sm.files, disallowed }, notes,
  };
}

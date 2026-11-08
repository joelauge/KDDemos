// "Enter a Store URL" importer: finder + reader + writer. Fakes only: every site here is a local HTTP server on
// 127.0.0.x (host names are resolved to loopback through the injectable `resolve`); nothing reaches a real store or
// knowDrive.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { importStore, detectPlatform, createStoreFetcher, isBlockedAddress, normalizeStoreUrl, parseRobots, robotsAllows, buildMarkdownFiles, renderMarkdown,
  htmlToText, readPageHtml, readProductHtml, registrableDomain, StoreImportError, USER_AGENT, FILE_OVERHEAD, convertShortcodes, stripBoilerplate, retryAfterMs, LIMITS } from '../storeimport.mjs';
import { atomizeProduction } from './fake-knowdrive.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1

const LOOP = async () => [{ address: '127.0.0.1', family: 4 }];
const NET = { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0, resolve: LOOP };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
after(async () => { for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); } });

/**
 * A fake web: one loopback server answering for several host names (dispatch on the Host header). hosts:
 * { 'shop.lumen.test': routes, … }; routes: { 'GET /path?query' | '/path?query' | '/path': handler | {status, type, body,
 * headers, delay} }. body may be a function (base, url, reqBody, host). Every request is logged with its host and time.
 */
async function web(hosts, { ip = '127.0.0.1' } = {}) {
  const log = [];
  let active = 0, maxActive = 0;
  const s = http.createServer(async (req, res) => {
    active++; maxActive = Math.max(maxActive, active);
    res.on('close', () => { active--; });
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    log.push({ host, method: req.method, url: req.url, headers: req.headers, body, at: Date.now() });
    const routes = hosts[host] || hosts['*'] || {};
    const u = new URL(req.url, 'http://x');
    const r = routes[`${req.method} ${req.url}`] ?? (req.method === 'GET' ? routes[req.url] : undefined)
      ?? routes[`${req.method} ${u.pathname}`] ?? (req.method === 'GET' ? routes[u.pathname] : undefined) ?? routes['*'];
    const base = `http://${host}:${s.address().port}`;
    if (typeof r === 'function') return r(req, res, { body, url: u, base, host });
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    if (r.delay) await sleep(r.delay);
    const b = typeof r.body === 'function' ? r.body(base, u, body, host) : r.body;
    const out = typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b);
    res.writeHead(r.status || 200, { 'content-type': r.type || (typeof b === 'object' && !Buffer.isBuffer(b) ? 'application/json' : 'text/html; charset=utf-8'), ...(r.headers || {}) });
    res.end(out);
  });
  await new Promise((r) => s.listen(0, ip, r));
  servers.push(s);
  const port = s.address().port;
  return { port, url: (host) => `http://${host}:${port}`, log, get maxActive() { return maxActive; },
    hits: (re, host) => log.filter((l) => (!host || l.host === host) && re.test(l.url)).length };
}
const page = (title, main, { head = '', chrome = true } = {}) => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${chrome ? '<header><nav><a href="/">Home</a> Shop Cart</nav></header>' : ''}<main>${main}</main>${chrome ? '<footer>© Footer text <a href="/pages/contact">Contact</a></footer>' : ''}</body></html>`;
const urlset = (urls) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const smIndex = (urls) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\nTrail Pro owner manual: torque the stem bolts to five newton metres before every ride.\n%%EOF\n');
async function run(url, opts = {}) {
  const events = [];
  try {
    const r = await importStore(url, { net: NET, date: new Date('2026-11-08T00:00:00Z'), ...opts, onEvent: (e, d) => events.push({ e, d }) });
    return { r, events };
  } catch (error) { return { error, events }; }
}
const text = (f) => f.bytes.toString('utf8');
const byKind = (r, k) => r.files.filter((f) => f.kind === k);

// ------------------------------------------------------------------------------------------------ fake Shopify (600 products)
function shopify({ n = 600, robots = 'User-agent: *\nAllow: /\n' } = {}) {
  const host = 'shop.lumen.test';
  const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the long story: the frame is hand-welded in Denver from triple-butted chromoly tubing and checked twice.`).join('</p><p>');
  const product = (i) => ({ id: i, title: `Trail Pro ${i}`, handle: `trail-pro-${i}`, vendor: 'Lumen', product_type: 'Bikes', tags: ['mtb'],
    body_html: i % 50 === 7 ? `<h2>Story</h2><p>${LONG}</p><h3>Deep</h3><h4>Deeper</h4><h5>Deepest</h5><p>Deep note for Trail Pro ${i}.</p>`
      : `<p>A light <strong>carbon</strong> trail bike, number ${i}.</p><script>evilScript()</script>`,
    options: [{ name: 'Size', values: ['Small', 'Large'] }],
    variants: [{ title: 'Small / Black', price: '1299.00', sku: `TP-${i}-S`, available: true }, { title: 'Large / Black', price: '1349.00', sku: `TP-${i}-L`, available: i % 3 !== 0 }] });
  const all = Array.from({ length: n }, (_, i) => product(i + 1));
  const productPage = (base, i) => page(`Trail Pro ${i}`, `
    <div id="onetrust-banner-sdk">We use cookies to improve your experience. Accept all cookies.</div>
    <h1>Trail Pro ${i}</h1><p>$1,299.00</p><p>Quantity</p>
    <p>Free shipping on orders over $100 and free returns within 30 days on every bike we sell.</p>
    <h2>Specifications</h2><ul><li>Frame: carbon, 1,150 g</li><li>Wheel size: 29 inches</li><li>Weight: 12.4 kg in size M</li></ul>
    <h2>Care</h2><p>Wipe the frame with a damp cloth after muddy rides and keep the chain lubed.</p>
    <h2>Shipping &amp; returns</h2><p>Trail Pro ${i} ships 90% assembled in a recyclable box within 2 business days.</p>
    <h2>FAQ</h2><details><summary>Does Trail Pro ${i} fit a 2.6 inch tyre?</summary><p>Yes, up to 2.6 inches front and rear.</p></details>
    <h2>Reviews</h2><p>Riders say Trail Pro ${i} climbs like a goat and descends with confidence on rocky trails.</p>
    <p><a href="https://cdn.shopify.com/s/files/1/manual-trail-pro.pdf">Owner manual</a> · <a href="/pages/size-chart.pdf">Size chart</a></p>
    <div class="newsletter-signup">Join our newsletter for 10% off your first order.</div>`,
  { head: `<link rel="canonical" href="${base}/products/trail-pro-${i}"><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: `Trail Pro ${i}`,
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.7', reviewCount: '12' } })}</script>` });
  const chunk = (from, to) => (b) => urlset(all.slice(from, to).flatMap((p, j) => [`${b}/products/${p.handle}`, ...(j === 0 ? [`${b}/products/${p.handle}?variant=111`, `${b}/collections/bikes/products/${p.handle}`] : [])]));
  const routes = {
    '/robots.txt': { type: 'text/plain', body: (b) => `${robots}\nSitemap: ${b}/sitemap.xml\n` },
    '/': { body: (b) => page('Lumen Bikes', `<h1>Lumen Bikes</h1><a href="/pages/faq">FAQ</a> <a href="/pages/shipping-returns">Shipping &amp; Returns</a> <a href="/pages/about-us">About us</a>`,
      { head: '<link href="https://cdn.shopify.com/s/files/theme.css"><script>Shopify.currency = {"active":"USD","rate":"1.0"};</script><meta property="og:site_name" content="Lumen Bikes">' }),
    headers: { 'x-shopify-stage': 'production', 'set-cookie': '_shopify_y=abc; Path=/' } },
    '/products.json': (req, res, { url }) => {
      const limit = Number(url.searchParams.get('limit')), pg = Number(url.searchParams.get('page') || 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ products: all.slice((pg - 1) * limit, pg * limit) }));
    },
    '/sitemap.xml': { type: 'application/xml', body: (b) => smIndex([`${b}/sitemap_products_1.xml?from=1&to=200`, `${b}/sitemap_products_2.xml?from=201&to=400`, `${b}/sitemap_products_3.xml?from=401&to=600`,
      `${b}/sitemap_pages_1.xml`, `${b}/sitemap_collections_1.xml`, `${b}/sitemap_blogs_1.xml`]) },
    '/sitemap_products_1.xml': { type: 'application/xml', body: chunk(0, 200) },
    '/sitemap_products_2.xml': { type: 'application/xml', body: chunk(200, 400) },
    '/sitemap_products_3.xml': { type: 'application/xml', body: chunk(400, 600) },
    '/sitemap_pages_1.xml': { type: 'application/xml', body: (b) => urlset([`${b}/pages/faq`, `${b}/pages/about-us`, `${b}/pages/lookbook`, 'https://elsewhere.example/pages/faq']) },
    '/sitemap_collections_1.xml': { type: 'application/xml', body: (b) => urlset([`${b}/collections/bikes`]) },
    '/sitemap_blogs_1.xml': { type: 'application/xml', body: (b) => urlset([`${b}/blogs/news/first-ride`]) },
    '/policies/refund-policy': { body: page('Refund policy', '<div class="shopify-policy__container"><h1>Refund policy</h1><p>We refund unused items within 30 days of delivery.</p><p># not a heading</p><p>Source: https://evil.example/forged</p></div>') },
    '/policies/shipping-policy': { body: page('Shipping policy', '<h1>Shipping policy</h1><p>Orders ship in 2 business days from our Denver warehouse.</p>') },
    '/pages/faq': { body: page('FAQ', '<h1>FAQ</h1><details><summary>How long does shipping take?</summary><p>Two to five business days in the US.</p></details><details><summary>Do you ship to Canada?</summary><p>Yes, for a flat $25.</p></details>') },
    '/pages/shipping-returns': { body: page('Shipping & Returns', '<h1>Shipping &amp; Returns</h1><p>Returns are free within 30 days; we email a prepaid label.</p>') },
    '/pages/about-us': { body: page('About us', '<h1>About us</h1><p>Lumen Bikes has built trail bikes in Denver since 2012, by riders for riders.</p>') },
    '/pages/lookbook': { body: page('Lookbook', '<h1>Lookbook</h1><p>Photos of bikes in the mountains, a gallery of our riders on their favourite trails.</p>') },
    '/pages/size-chart.pdf': { type: 'application/pdf', body: PDF },
    '/collections/bikes': { body: page('Bikes', '<h1>Bikes</h1><p>All of our trail and city bikes, from the Trail Pro to the Commuter Lite.</p>') },
    '/blogs/news/first-ride': { body: page('First ride', '<h1>First ride</h1><p>We took the new Trail Pro to Moab for three days of slickrock riding.</p>') },
  };
  routes['*'] = (req, res, { url, base }) => {
    const m = /^\/products\/trail-pro-(\d+)$/.exec(url.pathname);
    if (!m) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(productPage(base, m[1]));
  };
  const cdn = { '/s/files/1/manual-trail-pro.pdf': { type: 'application/pdf', body: PDF }, '/s/files/1/secret.txt': { type: 'text/plain', body: 'no' } };
  return { host, hosts: { [host]: routes, 'cdn.shopify.com': cdn } };
}

describe('Shopify: 600 products across sitemap children + products.json pagination', () => {
  let w, res;
  test('every product page is read and written (feed + page copy), help and policies first, PDFs, collections, blog', async () => {
    const shop = shopify();
    w = await web(shop.hosts);
    const base = w.url(shop.host);
    res = await run(base);
    const { r, events, error } = res;
    assert.ifError(error);
    assert.equal(r.platform, 'shopify'); assert.equal(r.api, true);
    // the plan comes before any reading, with counts per kind and samples
    const ev = events.map((x) => x.e);
    assert.ok(ev.indexOf('detect') < ev.indexOf('plan') && ev.indexOf('plan') < ev.indexOf('found') && ev.indexOf('found') < ev.indexOf('reading') && ev.indexOf('building') < ev.indexOf('built'), ev.filter((e) => e !== 'fetching').join(','));
    const plan = events.find((x) => x.e === 'plan').d;
    assert.equal(plan.counts.product, 600, 'variant and collection-scoped URLs fold into their product');
    assert.equal(plan.counts.faq, 1); assert.equal(plan.counts.collection, 1); assert.equal(plan.counts.blog, 1);
    assert.ok(plan.counts.policy >= 1 && plan.counts.help >= 1, JSON.stringify(plan.counts));
    assert.equal(plan.samples.product.length, 3);
    assert.deepEqual(events.find((x) => x.e === 'found').d.products, 600);
    // every product: feed pages 1..3 (the third is short), then every product page for the full copy
    assert.equal(w.hits(/^\/products\.json\?limit=250&page=1$/), 1, 'the first feed page is read once (plan + feed)');
    assert.equal(w.hits(/^\/products\.json\?limit=250&page=3$/), 1);
    assert.equal(w.hits(/^\/products\.json\?limit=250&page=4$/), 0, 'stops after a short page');
    assert.equal(w.hits(/^\/products\/trail-pro-\d+$/), 600, 'every product page was read, once');
    assert.equal(w.hits(/variant=|\/collections\/bikes\/products\//), 0, 'duplicates never fetched');
    assert.equal(r.report.products.read, 600);
    const prods = byKind(r, 'product');
    assert.equal(prods.length, 600);
    assert.equal(new Set(prods.map((f) => f.path)).size, 600);
    assert.ok(prods.every((f) => /^site\/shop\.lumen\.test\/product\/trail-pro-\d+\.md$/.test(f.path) && f.mime === 'text/markdown'));
    // the page itself: H1 with the canonical URL, Source line, then the real copy in sections
    const p2 = text(prods.find((f) => f.path.endsWith('/trail-pro-2.md')));
    const url2 = `${base}/products/trail-pro-2`;
    assert.ok(p2.startsWith(`# Trail Pro 2 · ${url2}\n\nSource: ${url2}\n\n## Price and availability\n\n- Trail Pro 2 price: 1,299.00 USD to 1,349.00 USD\n`), p2.slice(0, 300));
    assert.match(p2, /- Trail Pro 2 variants:\n {2}- Trail Pro 2 Small \/ Black: 1,299\.00 USD, SKU TP-2-S, in stock\n {2}- Trail Pro 2 Large \/ Black: 1,349\.00 USD, SKU TP-2-L, in stock/);
    assert.match(p2, /- Trail Pro 2 options: Size \(Small, Large\)/);
    assert.match(p2, /\n## Description\n\nA light carbon trail bike, number 2\./);
    assert.match(p2, /\n## Specs\n\n- Frame: carbon, 1,150 g\n- Wheel size: 29 inches\n- Weight: 12\.4 kg in size M/);
    assert.match(p2, /\n## Care\n\nWipe the frame/);
    assert.match(p2, /\n## Shipping and returns\n\nTrail Pro 2 ships 90% assembled/);
    assert.match(p2, /\n## FAQ\n\n### Does Trail Pro 2 fit a 2\.6 inch tyre\?\nYes, up to 2\.6 inches front and rear\./);
    assert.match(p2, /\n## Reviews\n\nRiders say Trail Pro 2 climbs like a goat/);
    assert.match(p2, /\n## Downloads\n\n- Owner manual \(PDF\): https:\/\/cdn\.shopify\.com\/s\/files\/1\/manual-trail-pro\.pdf/);
    const p3 = text(prods.find((f) => f.path.endsWith('/trail-pro-3.md')));
    assert.match(p3, /- Trail Pro 3 availability: only some options in stock \(Small \/ Black\)/);
    // boilerplate: nav, footer, cookie banner, newsletter, and text repeated on every page are gone; scripts too
    for (const f of prods.slice(0, 50)) {
      const t = text(f);
      assert.doesNotMatch(t, /cookies|newsletter|Footer text|Home Shop Cart|evilScript|Quantity/, f.path);
      assert.doesNotMatch(t, /Free shipping on orders over \$100 and free returns/, `repeated block stripped: ${f.path}`);
    }
    // help, policies (Shopify policy pages), FAQ one section per question
    const faq = text(r.files.find((f) => f.path === 'site/shop.lumen.test/faq/faq.md'));
    assert.equal(faq, `# FAQ · ${base}/pages/faq\n\nSource: ${base}/pages/faq\n\n## How long does shipping take?\n\nTwo to five business days in the US.\n\n## Do you ship to Canada?\n\nYes, for a flat $25.\n`);
    const refund = text(r.files.find((f) => f.path === 'site/shop.lumen.test/policy/refund-policy.md'));
    assert.match(refund, /We refund unused items within 30 days of delivery\.\n\n\\# not a heading\n\n\\Source: https:\/\/evil\.example\/forged/, 'forged headings and Source lines are escaped');
    assert.ok(r.files.some((f) => f.path === 'site/shop.lumen.test/policy/shipping-returns.md'), 'nav link "Shipping & Returns" is a policy source');
    assert.ok(r.files.some((f) => f.path === 'site/shop.lumen.test/help/about-us.md'));
    assert.ok(byKind(r, 'collection').length === 1 && byKind(r, 'blog').length === 1);
    // PDFs: the product-linked size chart (one file however many products link it); the https CDN manual is not served
    // by this loopback fake (the CDN case is covered below)
    const pdfs = byKind(r, 'pdf');
    assert.deepEqual(pdfs.map((f) => f.path), ['site/shop.lumen.test/pdf/size-chart.pdf']);
    assert.equal(pdfs[0].url, `${base}/pages/size-chart.pdf`);
    assert.equal(pdfs[0].mime, 'application/pdf');
    // ranking: help and policies were written before the first product
    const firstProduct = r.files.findIndex((f) => f.kind === 'product');
    assert.ok(r.files.slice(0, firstProduct).some((f) => f.kind === 'policy') && r.files.slice(0, firstProduct).some((f) => f.kind === 'faq'));
    // politeness and privacy
    for (const l of w.log) { assert.equal(l.headers['user-agent'], USER_AGENT); assert.equal(l.headers.cookie, undefined); assert.equal(l.headers.authorization, undefined); }
    assert.ok(w.maxActive <= 4, `max in flight ${w.maxActive}`);
    assert.ok(r.maxConcurrent <= 4);
  });

  test('EVERY atom the production chunker cuts from a product page carries that product\'s URL (long and deep sections too)', () => {
    const { r } = res;
    const base = w.url('shop.lumen.test');
    let atoms = 0, continuations = 0, shortened = 0;
    for (const f of byKind(r, 'product')) {
      const url = `${base}/products/${f.path.split('/').pop().replace(/\.md$/, '')}`;
      for (const a of atomizeProduction(text(f))) {
        atoms++;
        if (a.kind === 'paragraph') continuations++;
        if (a.breadcrumb.includes('…')) shortened++;
        assert.ok(a.text.includes(url), `${f.path} atom ${a.seq} lacks its URL:\n${a.text.slice(0, 300)}`);
        assert.ok(!a.text.includes(`${base}/products/trail-pro-${Number(/(\d+)\.md$/.exec(f.path)[1]) + 1}\n`), 'no other product URL');
      }
    }
    assert.ok(atoms > 600 * 4, `atoms ${atoms}`);
    assert.ok(continuations > 0, 'long descriptions were cut into continuation fragments');
    assert.ok(shortened > 0, 'deep heading paths were shortened (H1 > … > last)');
    // the old layout ("## Product / Source: url" in a shared file) does NOT survive the same chunker: proof the check bites
    const old = `# Products: Lumen\n\n${byKind(r, 'product').slice(0, 3).map((f) => text(f).replace(/^# (.*) · (\S+)\n\nSource: \S+\n/, '## $1\n\nSource: $2\n').replace(/^## (?!Trail)/gm, '### ')).join('\n')}`;
    const bad = atomizeProduction(old).filter((a) => !/\/products\/trail-pro-\d+/.test(a.text));
    assert.ok(bad.length > 0, 'old layout leaves atoms without a URL');
  });

  test('deterministic Markdown: the same site imports to the same bytes', async () => {
    const shop = shopify({ n: 30 });
    const w2 = await web(shop.hosts);
    const a = await run(w2.url(shop.host)), b = await run(w2.url(shop.host));
    assert.ifError(a.error); assert.ifError(b.error);
    const map = (r) => new Map(r.files.map((f) => [f.path, f.bytes.toString('base64')]));
    assert.deepEqual(map(a.r), map(b.r));
  });

  test('caps: maxProducts (reported, feed stops), quota (never exceeded, policies first, left-out counts)', async () => {
    const shop = shopify({ n: 300 });
    const w3 = await web(shop.hosts);
    const a = await run(w3.url(shop.host), { maxProducts: 100, enrich: 'none' });
    assert.ifError(a.error);
    assert.equal(byKind(a.r, 'product').length, 100);
    assert.deepEqual(a.r.capped.products, { limit: 100, kept: 100, more: true });
    assert.ok(a.r.report.leftOut.cap.product >= 150);
    assert.equal(w3.hits(/products\.json\?limit=250&page=2/), 1, 'the second page was needed to know there were more');
    const b = await run(w3.url(shop.host), { remainingBytes: 20000, enrich: 'none' });
    assert.ifError(b.error);
    const used = b.r.files.reduce((n, f) => n + f.size + FILE_OVERHEAD, 0);
    assert.ok(used <= 20000, `used ${used} ≤ remaining quota`);
    assert.ok(b.r.report.leftOut.quota.product > 200, JSON.stringify(b.r.report.leftOut));
    assert.ok(b.r.capped.bytes.droppedProducts > 200);
    assert.ok(byKind(b.r, 'policy').length >= 1 && byKind(b.r, 'faq').length === 1, 'policies and FAQ are kept first');
    const c = await run(w3.url(shop.host), { remainingBytes: 0 });
    assert.equal(c.error.code, 'quota');
  });

  test('plan only: the finder reports what it found, nothing is read', async () => {
    const shop = shopify({ n: 40 });
    const w4 = await web(shop.hosts);
    const { r, error } = await run(w4.url(shop.host), { planOnly: true });
    assert.ifError(error);
    assert.equal(r.plan.counts.product, 40);
    assert.ok(r.plan.sources.length > 40);
    assert.equal(w4.hits(/^\/products\/trail-pro/), 0);
    assert.equal(w4.hits(/^\/pages\//), 0);
  });
});

describe('PDFs, help-centre subdomain and a hosted help desk linked from the site', () => {
  test('PDFs on the site and on the allowed asset CDN are uploaded as they are; other CDN files and unlinked desks are refused', async () => {
    const host = 'shop.lumen.test';
    const zen = { '/api/v2/help_center/articles.json': (req, res, { base }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 2, next_page: null, articles: [
        { html_url: `${base}/hc/en-us/articles/101-How-do-I-return-a-bike`, title: 'How do I return a bike?', body: '<p>Start a return from your order page within 30 days.</p>', draft: false },
        { html_url: `${base}/hc/en-us/articles/102-Warranty-registration`, title: 'Warranty registration', body: '<p>Register your frame within 60 days to get the lifetime warranty.</p>', draft: false },
      ] }));
    } };
    const help = {
      '/': { body: page('Lumen Help', '<h1>Lumen Help</h1>') },
      '/sitemap.xml': { type: 'application/xml', body: (b) => urlset([`${b}/articles/tyre-pressure`, `${b}/articles/brake-bleed`]) },
      '/articles/tyre-pressure': { body: page('Tyre pressure guide', '<h1>Tyre pressure guide</h1><p>Run 22 to 25 psi on the trail with tubeless tyres.</p>') },
      '/articles/brake-bleed': { body: page('Brake bleed', '<h1>Brake bleed</h1><p>Bleed hydraulic brakes once a year with mineral oil only.</p>') },
    };
    const w = await web({
      [host]: {
        '/': { body: (b) => page('Lumen', `<h1>Lumen</h1>`, { head: '<meta property="og:site_name" content="Lumen">' }).replace('</footer>', `<a href="${b.replace(host, 'help.lumen.test')}/">Help centre</a> <a href="${b.replace(host, 'lumen.zendesk.com')}/hc/en-us">Support</a> <a href="/docs/manual.pdf">Manual (PDF)</a> <a href="${b.replace(host, 'cdn.shopify.com')}/s/files/sizes.pdf">Size chart</a></footer>`) },
        '/docs/manual.pdf': { type: 'application/pdf', body: PDF },
        '/products/widget': { body: (b) => page('Widget', `<h1>Widget</h1><p>The widget does useful things for riders every day.</p><a href="${b.replace(host, 'cdn.shopify.com')}/s/files/widget-spec.pdf">Spec sheet</a> <a href="${b.replace(host, 'cdn.shopify.com')}/s/files/notes.txt">notes</a>`, { head: `<script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"price":"5.00","priceCurrency":"USD"}}</script>` }) },
        '/sitemap.xml': { type: 'application/xml', body: (b) => urlset([`${b}/products/widget`]) },
      },
      'help.lumen.test': help,
      'lumen.zendesk.com': zen,
      'other.zendesk.com': zen,
      'cdn.shopify.com': { '/s/files/sizes.pdf': { type: 'application/pdf', body: PDF }, '/s/files/widget-spec.pdf': { type: 'application/pdf', body: PDF }, '/s/files/notes.txt': { type: 'text/plain', body: 'x' } },
    });
    const { r, error, events } = await run(w.url(host));
    assert.ifError(error);
    const plan = events.find((x) => x.e === 'plan').d;
    assert.deepEqual(plan.helpdesks.map((d) => d.type).sort(), ['subdomain', 'zendesk']);
    const paths = r.files.map((f) => f.path).sort();
    assert.ok(paths.includes('site/help.lumen.test/help/tyre-pressure.md') && paths.includes('site/help.lumen.test/help/brake-bleed.md'), paths.join('\n'));
    // returns and warranty articles rank with the policies
    assert.ok(paths.includes('site/lumen.zendesk.com/policy/101-how-do-i-return-a-bike.md'), paths.join('\n'));
    assert.ok(paths.includes('site/lumen.zendesk.com/policy/102-warranty-registration.md'), paths.join('\n'));
    assert.equal(w.hits(/\/hc\/en-us\/articles\//, 'lumen.zendesk.com'), 0, 'Zendesk articles came from its API, not one page each');
    const zf = text(r.files.find((f) => f.path.endsWith('101-how-do-i-return-a-bike.md')));
    assert.ok(zf.startsWith(`# How do I return a bike? · ${w.url('lumen.zendesk.com')}/hc/en-us/articles/101-How-do-I-return-a-bike\n`), zf);
    const pdfs = byKind(r, 'pdf');
    assert.deepEqual(pdfs.map((f) => f.path).sort(), ['site/shop.lumen.test/pdf/manual.pdf', 'site/shop.lumen.test/pdf/sizes.pdf', 'site/shop.lumen.test/pdf/widget-spec.pdf']);
    assert.ok(pdfs.every((f) => f.mime === 'application/pdf' && f.bytes.subarray(0, 5).toString() === '%PDF-' && /^http:\/\//.test(f.url)));
    assert.equal(w.hits(/notes\.txt/, 'cdn.shopify.com'), 0, 'a non-PDF on the CDN is never fetched');
    assert.equal(w.log.filter((l) => l.host === 'other.zendesk.com').length, 0, 'an unlinked help desk is never contacted');
    const f = createStoreFetcher(NET);
    f.allowSite(host);
    await assert.rejects(f.fetch(`${w.url('other.zendesk.com')}/api/v2/help_center/articles.json`), { code: 'blocked_host' });
  });
});

// ------------------------------------------------------------------------------------------------ WooCommerce, Magento
describe('WooCommerce', () => {
  test('Store API products (minor units, paged by X-WP-TotalPages) + WordPress pages (Divi shortcodes → FAQ; empty content → page HTML)', async () => {
    const host = 'wyrm.test';
    const prods = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Toad Vault ${i + 1}`, permalink: `http://${host}:PORT/products/toad-vault-${i + 1}/`, sku: `TV-${i + 1}`,
      prices: { price: '4999', regular_price: '5999', currency_code: 'USD', currency_minor_unit: 2 }, is_in_stock: i !== 4,
      description: '<p>A walnut dice vault with a magnetic lid.</p>'.repeat(12), short_description: '', categories: [{ name: 'Vaults' }], attributes: [] }));
    const w = await web({ [host]: {
      '/': { body: page('Wyrmwood', '<h1>Wyrmwood</h1>', { head: '<link rel="stylesheet" href="/wp-content/plugins/woocommerce/style.css"><meta property="og:site_name" content="Wyrmwood">' }) },
      '/wp-json/wc/store/v1/products': (req, res, { url }) => {
        const pp = Number(url.searchParams.get('per_page')), pg = Number(url.searchParams.get('page'));
        const port = req.headers.host.split(':')[1];
        res.writeHead(200, { 'content-type': 'application/json', 'x-wp-total': '5', 'x-wp-totalpages': String(Math.ceil(5 / pp)) });
        res.end(JSON.stringify(prods.slice((pg - 1) * pp, pg * pp)).replace(/PORT/g, port));
      },
      '/wp-json/wp/v2/pages': (req, res, { base }) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([
          { link: `${base}/faq/`, title: { rendered: 'FAQ' }, content: { rendered: '[et_pb_section][et_pb_accordion][et_pb_accordion_item title="How long does shipping take?" open="on"]<p>Most orders ship in 5 days.</p>[/et_pb_accordion_item][et_pb_accordion_item title="Do you ship worldwide?"]<p>Yes, to 40 countries.</p>[/et_pb_accordion_item][/et_pb_accordion][/et_pb_section]' } },
          { link: `${base}/shipping/`, title: { rendered: 'Shipping' }, content: { rendered: '' } },
          { link: `${base}/gallery/`, title: { rendered: 'Gallery' }, content: { rendered: '<p>Pictures.</p>' } },
        ]));
      },
      '/shipping/': { body: page('Shipping', '<h1>Shipping</h1><p>We ship from Pennsylvania with tracking on every order.</p>') },
      '/products/toad-vault-1/': { body: page('Toad Vault 1', '<h1>Toad Vault 1</h1><h2>Dimensions</h2><p>Inside: 4 by 4 by 2 inches; holds three full dice sets.</p>') },
    } });
    const { r, error } = await run(w.url(host), { pageSize: 2 });
    assert.ifError(error);
    assert.equal(r.platform, 'woocommerce');
    assert.equal(w.hits(/wc\/store\/v1\/products\?per_page=2&page=3/), 1);
    assert.equal(w.hits(/wc\/store\/v1\/products\?per_page=2&page=4/), 0);
    assert.equal(byKind(r, 'product').length, 5);
    const t1 = text(r.files.find((f) => f.path.endsWith('/product/toad-vault-1.md')));
    assert.ok(t1.startsWith(`# Toad Vault 1 · ${w.url(host)}/products/toad-vault-1/\n`), t1.slice(0, 200)); // the permalink as the store gives it
    assert.match(t1, /- Toad Vault 1 price: 49\.99 USD \(was 59\.99 USD\)/);
    assert.match(t1, /## Specs\n\nInside: 4 by 4 by 2 inches/, 'the product page adds its dimensions');
    assert.match(text(r.files.find((f) => f.path.endsWith('/product/toad-vault-5.md'))), /availability: out of stock/);
    const faq = text(r.files.find((f) => f.path.endsWith('/faq/faq.md')));
    assert.match(faq, /## How long does shipping take\?\n\nMost orders ship in 5 days\.\n\n## Do you ship worldwide\?\n\nYes, to 40 countries\./);
    assert.doesNotMatch(faq, /et_pb_/);
    assert.equal(w.hits(/^\/faq\/$/), 0, 'the FAQ came whole from the pages API');
    assert.equal(w.hits(/^\/shipping\/$/), 1, 'an empty API page is read from its HTML');
    assert.match(text(r.files.find((f) => f.path.endsWith('/policy/shipping.md'))), /ship from Pennsylvania/);
    assert.ok(!r.files.some((f) => /gallery/.test(f.path)), 'a page that is not help, policy or FAQ is not read from the API list');
  });
});

describe('Magento 2', () => {
  test('GraphQL products (paged, configurable variants) + cmsPage + help pages from the sitemap', async () => {
    const host = 'velo.test';
    const items = [
      { __typename: 'ConfigurableProduct', name: 'Velo Jersey', sku: 'VJ', url_key: 'velo-jersey', url_suffix: '.html', stock_status: 'IN_STOCK', categories: [{ name: 'Apparel' }],
        price_range: { minimum_price: { regular_price: { value: 59, currency: 'EUR' }, final_price: { value: 49, currency: 'EUR' } }, maximum_price: { final_price: { value: 49, currency: 'EUR' } } },
        short_description: { html: '<p>Merino jersey.</p>' }, description: { html: '<p>Cut for the bike.</p>' },
        variants: [{ attributes: [{ label: 'S', code: 'size' }], product: { sku: 'VJ-S', stock_status: 'IN_STOCK', price_range: { minimum_price: { final_price: { value: 49, currency: 'EUR' } } } } },
          { attributes: [{ label: 'L', code: 'size' }], product: { sku: 'VJ-L', stock_status: 'OUT_OF_STOCK', price_range: { minimum_price: { final_price: { value: 49, currency: 'EUR' } } } } }] },
      { __typename: 'SimpleProduct', name: 'Bottle Cage', sku: 'BC', url_key: 'bottle-cage', url_suffix: '.html', stock_status: 'IN_STOCK', categories: [],
        price_range: { minimum_price: { regular_price: { value: 15, currency: 'EUR' }, final_price: { value: 15, currency: 'EUR' } }, maximum_price: { final_price: { value: 15, currency: 'EUR' } } },
        short_description: { html: '' }, description: { html: '<p>Carbon cage, 18 g, fits every standard bottle.</p>' } },
    ];
    const w = await web({ [host]: {
      '/': { body: page('Velo Shop', '<h1>Velo</h1>', { head: '<script type="text/x-magento-init">{}</script>' }), headers: { 'x-magento-cache-debug': 'MISS' } },
      'POST /graphql': (req, res, { body }) => {
        const { query, variables } = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (/storeConfig/.test(query)) return res.end(JSON.stringify({ data: { storeConfig: { store_name: 'Velo Shop', base_currency_code: 'EUR' } } }));
        if (/total_count\}\}$/.test(query.replace(/\s+/g, ''))) return res.end(JSON.stringify({ data: { products: { total_count: 2 } } }));
        if (/products\(/.test(query)) { const pg = variables.page; return res.end(JSON.stringify({ data: { products: { total_count: 2, page_info: { current_page: pg, total_pages: 2 }, items: [items[pg - 1]] } } })); }
        if (/cmsPage/.test(query)) return res.end(JSON.stringify({ data: { p0: { title: 'FAQ', url_key: 'faq', content: '<details><summary>Do you ship to Austria?</summary><p>Yes, in 3 days.</p></details>' } } }));
        return res.end('{}');
      },
      '/sitemap.xml': { type: 'application/xml', body: (b) => urlset([`${b}/customer-service`, `${b}/velo-jersey.html`]) },
      '/customer-service': { body: page('Customer service', '<h1>Customer service</h1><p>Call us Monday to Friday, 9 to 5, on 0800 123 456.</p>') },
      '/velo-jersey.html': { body: page('Velo Jersey', '<h1>Velo Jersey</h1><h2>Care</h2><p>Wash cold at 30 degrees and hang to dry.</p>') },
    } });
    const { r, error } = await run(w.url(host), { pageSize: 1 });
    assert.ifError(error);
    assert.equal(r.platform, 'magento');
    assert.equal(byKind(r, 'product').length, 2);
    const j = text(r.files.find((f) => f.path.endsWith('/product/velo-jersey.md')));
    assert.match(j, /- Velo Jersey price: 49\.00 EUR \(was 59\.00 EUR\)/);
    assert.match(j, /- Velo Jersey L: 49\.00 EUR, SKU VJ-L, out of stock/);
    assert.match(j, /## Care\n\nWash cold at 30 degrees/);
    assert.match(text(r.files.find((f) => f.path.endsWith('/faq/faq.md'))), /## Do you ship to Austria\?\n\nYes, in 3 days\./);
    assert.ok(r.files.some((f) => f.path.endsWith('/help/customer-service.md')));
  });
});

// ------------------------------------------------------------------------------------------------ generic, politeness
describe('generic site', () => {
  test('robots Sitemap line, index + gz child, JSON-LD Product/FAQPage, canonical dedupe, robots disallow and Crawl-delay', async () => {
    const host = 'plain.test';
    const prodPage = (n, canon) => page(`Lamp ${n}`, `<h1>Lamp ${n}</h1><p>Lamp ${n} gives 300 lumens of warm light for your desk at home.</p>`,
      { head: `<link rel="canonical" href="${canon}"><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'BreadcrumbList', itemListElement: [] }, { '@type': 'Product', name: `Lamp ${n}`, sku: `L${n}`, brand: { name: 'Glow' }, offers: { '@type': 'AggregateOffer', lowPrice: '20', highPrice: '30', priceCurrency: 'GBP', availability: 'https://schema.org/InStock' } }] })}</script>` });
    const w = await web({ [host]: {
      '/robots.txt': { type: 'text/plain', body: (b) => `User-agent: *\nDisallow: /secret\nCrawl-delay: 0.2\nSitemap: ${b}/maps/index.xml\n` },
      '/': { body: page('Glow', '<h1>Glow lamps</h1>') },
      '/maps/index.xml': { type: 'application/xml', body: (b) => smIndex([`${b}/maps/products.xml.gz`, `${b}/maps/pages.xml`]) },
      '/maps/products.xml.gz': { type: 'application/x-gzip', body: (b) => zlib.gzipSync(urlset([`${b}/product/lamp-1`, `${b}/product/lamp-1-copy`, `${b}/product/lamp-2`])) },
      '/maps/pages.xml': { type: 'application/xml', body: (b) => urlset([`${b}/help/faq`, `${b}/legal/returns`, `${b}/secret/plan`]) },
      '/product/lamp-1': { body: (b) => prodPage(1, `${b}/product/lamp-1`) },
      '/product/lamp-1-copy': { body: (b) => prodPage(1, `${b}/product/lamp-1`) },
      '/product/lamp-2': { body: (b) => prodPage(2, `${b}/product/lamp-2`) },
      '/help/faq': { body: page('Questions', `<h1>Questions</h1><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Do lamps include bulbs?","acceptedAnswer":{"@type":"Answer","text":"<p>Yes, a 2700K LED bulb.</p>"}}]}</script>`) },
      '/legal/returns': { body: page('Returns', '<h1>Returns</h1><p>Return any lamp within 60 days, unused, in its box.</p><style>.x{color:red}</style><script>SECRET()</script>') },
      '/secret/plan': { body: page('Secret', '<p>SECRET plan</p>') },
    } });
    const t0 = Date.now();
    const { r, error, events } = await run(w.url(host));
    assert.ifError(error);
    assert.equal(r.platform, 'generic');
    const plan = events.find((x) => x.e === 'plan').d;
    assert.equal(plan.robots.crawlDelay, 0.2);
    assert.equal(plan.robots.disallowed, 1);
    assert.equal(w.hits(/secret/), 0, 'robots disallow is honoured');
    const prods = byKind(r, 'product');
    assert.equal(prods.length, 2, 'the copy with the same canonical URL is one product');
    assert.equal(r.report.skipped.duplicate, 1);
    const l1 = text(prods.find((f) => f.path.endsWith('/lamp-1.md')));
    assert.match(l1, /- Lamp 1 price: 20\.00 GBP to 30\.00 GBP\n- Lamp 1 brand: Glow\n- Lamp 1 SKU: L1\n- Lamp 1 availability: in stock/);
    assert.match(l1, /Lamp 1 gives 300 lumens/);
    assert.match(text(r.files.find((f) => f.kind === 'faq')), /## Do lamps include bulbs\?\n\nYes, a 2700K LED bulb\./);
    const pol = text(r.files.find((f) => f.kind === 'policy'));
    assert.match(pol, /Return any lamp within 60 days/);
    assert.doesNotMatch(pol, /SECRET|color:red/);
    // Crawl-delay: request starts are at least 200 ms apart once robots.txt was read
    const starts = w.log.filter((l) => l.url !== '/robots.txt').map((l) => l.at);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    assert.ok(gaps.every((g) => g >= 170), `gaps ${gaps.join(',')}`);
    assert.ok(Date.now() - t0 >= 200 * (starts.length - 1) - 50);
  });

  test('429 with Retry-After: waits, slows down, retries the same page; the import still completes', async () => {
    const host = 'busy.test';
    let n = 0;
    const w = await web({ [host]: {
      '/': { body: page('Busy', '<h1>Busy</h1><a href="/faq">FAQ</a>') },
      '/faq': (req, res) => { n++; if (n === 1) { res.writeHead(429, { 'retry-after': '1', 'content-type': 'text/plain' }); return res.end('slow down'); } res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('FAQ', '<h1>FAQ</h1><details><summary>Open on Sundays?</summary><p>No, closed on Sundays.</p></details>')); },
    } });
    const t0 = Date.now();
    const { r, error } = await run(w.url(host));
    assert.ifError(error);
    assert.equal(n, 2);
    assert.ok(Date.now() - t0 >= 950, 'waited for Retry-After');
    assert.equal(r.report.throttled, 1);
    assert.match(text(r.files[0]), /Open on Sundays\?/);
    assert.equal(retryAfterMs('2'), 2000);
    assert.ok(Math.abs(retryAfterMs(new Date(Date.now() + 3000).toUTCString()) - 3000) < 1100);
    assert.equal(retryAfterMs(undefined), null);
  });

  test('time budget: slow product pages are cut off, the import still finishes and reports what was left out', async () => {
    const host = 'slow.test';
    const w = await web({ [host]: {
      '/': { body: page('Slow', '<h1>Slow</h1>') },
      '/sitemap.xml': { type: 'application/xml', body: (b) => urlset([`${b}/pages/faq`, ...Array.from({ length: 30 }, (_, i) => `${b}/products/p${i}`)]) },
      '/pages/faq': { body: page('FAQ', '<h1>FAQ</h1><details><summary>Is it slow?</summary><p>Yes, very slow indeed.</p></details>') },
      '*': (req, res, { url }) => {
        if (!/^\/products\/p\d+$/.test(url.pathname)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('no'); }
        setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('P', '<h1>P</h1><p>A product page that took far too long to answer.</p>', { head: '<script type="application/ld+json">{"@type":"Product","name":"P"}</script>' })); }, 600);
      },
    } });
    const { r, error } = await run(w.url(host), { budgetMs: 2500 });
    assert.ifError(error);
    assert.ok(r.report.timeUp);
    assert.ok(r.report.leftOut.time.product > 0, JSON.stringify(r.report.leftOut));
    assert.ok(r.capped.time);
    assert.ok(r.files.some((f) => f.kind === 'faq'), 'what was read is kept');
  });

  test('cancel: an abort stops the import with aborted', async () => {
    const shop = shopify({ n: 200 });
    const w = await web(shop.hosts);
    const ac = new AbortController();
    const p = run(w.url(shop.host), { signal: ac.signal, onEvent: undefined });
    await sleep(150);
    ac.abort();
    const { error } = await p;
    assert.equal(error.code, 'aborted');
    const a = await run('http://never.test/', { signal: AbortSignal.abort() });
    assert.equal(a.error.code, 'aborted');
  });

  test('no products or help pages → no_content', async () => {
    const w = await web({ 'empty.test': { '/': { body: page('Empty', '<h1>Empty</h1>') } } });
    const { error } = await run(w.url('empty.test'));
    assert.equal(error.code, 'no_content');
  });
});

// ------------------------------------------------------------------------------------------------ pure helpers
describe('HTML and Markdown helpers', () => {
  test('boilerplate stripping, shortcodes, escaping, page and product readers', () => {
    const h = '<div class="cookie-consent">cookies!</div><nav>menu</nav><main><div role="navigation">crumbs</div><h2>Fit</h2><p>True to size.</p><aside>related</aside></main><footer>foot</footer>';
    assert.equal(htmlToText(h, { main: false, minLevel: 2 }), '## Fit\n\nTrue to size.');
    assert.equal(stripBoilerplate('<div class="a"><header>x<header>y</header></header>keep</div>'), '<div class="a">keep</div>');
    assert.match(convertShortcodes('[et_pb_toggle title="Q?"]A.[/et_pb_toggle][et_pb_text]T[/et_pb_text]'), /<details><summary>Q\?<\/summary>A\.<\/details>\s*T/);
    assert.equal(htmlToText('<p># Title</p><p>Source: https://evil.example</p>', { main: false }), '\\# Title\n\n\\Source: https://evil.example');
    const d = readPageHtml(page('Help', '<h1>Help</h1><p>Intro text for the help page here.</p><h2>Orders</h2><p>Track orders online.</p>'), 'https://x.test/help', { kind: 'help' });
    assert.deepEqual(d.sections.map((s) => s.heading), [null, 'Orders']);
    const md = renderMarkdown({ ...d, title: 'Help > Centre · https://evil.example' });
    assert.ok(md.startsWith('# Help › Centre - https://evil.example · https://x.test/help\n\nSource: https://x.test/help\n'), md);
    const pd = readProductHtml(page('X', '<h1>X</h1><h2>Materials</h2><p>Oak and brass, oiled by hand.</p>'), 'https://x.test/p/x', null, { requireLd: true });
    assert.equal(pd, null, 'no Product JSON-LD and no record: not a product when required');
  });
  test('buildMarkdownFiles keeps one file per page, quota-bounded, best kinds first', async () => {
    const docs = [{ kind: 'product', url: 'https://s.test/products/a', title: '# Forged > Title', sections: [{ heading: 'Description', text: 'x'.repeat(300) }] },
      { kind: 'policy', url: 'https://s.test/policies/refund-policy', title: 'Refund policy', sections: [{ heading: null, text: 'Thirty days.' }] }];
    const { files, leftOut } = await buildMarkdownFiles(docs, { maxTotalBytes: 400, storeName: 'S', host: 's.test' });
    assert.deepEqual(files.map((f) => f.path), ['site/s.test/policy/refund-policy.md']);
    assert.equal(leftOut.product, 1);
    const all = await buildMarkdownFiles(docs, { storeName: 'S', host: 's.test' });
    assert.ok(text(all.files[1]).startsWith('# Forged › Title · https://s.test/products/a\n'));
    assert.equal(all.files[1].name, 'S · Forged › Title.md');
  });
});

// ------------------------------------------------------------------------------------------------ SSRF, robots, sizes
const site = async (routes, { host = '127.0.0.1' } = {}) => { const w = await web({ '*': routes }, { ip: host }); return { base: `http://${host}:${w.port}`, log: w.log, hits: (re) => w.hits(re) }; };
const html = (title, main, extra = '') => page(title, main, { head: extra });
const NET0 = { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0 };
describe('SSRF safety', () => {
  test('isBlockedAddress: private, loopback, link-local, CGNAT, metadata, reserved and IPv6 forms', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '100.64.0.1', '127.0.0.1', '127.9.9.9', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
      '::', '::1', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2001:db8::1', 'ff02::1', '[::1]', 'not-an-ip']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '23.227.38.65', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '64:ff9b::808:808']) assert.equal(isBlockedAddress(ip), false, ip);
  });
  test('loopback is refused by default (no request is made)', async () => {
    const s = await site({ '/': { body: html('x', 'x') } });
    const { error, events } = await run(s.base, { net: { allowPorts: 'any' } });
    assert.equal(error.code, 'blocked_host');
    assert.ok(error instanceof StoreImportError);
    assert.equal(s.log.length, 0);
    assert.equal(events.at(-1).e, 'error');
  });
  test('metadata, private and internal hosts are refused', async () => {
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.8/', 'http://[::1]/', 'http://[fd00:ec2::254]/', 'http://localhost/', 'http://metadata.google.internal/', 'http://intranet/', 'http://2130706433/', 'http://0x7f.1/']) {
      const { error } = await run(u, { net: { paceMs: 0 } });
      assert.equal(error?.code, 'blocked_host', u);
    }
  });
  test('non-http schemes and credentials are refused', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://example.com/', 'http://user:pass@example.com/', '', '   ', 'http://exa mple.com']) {
      const { error } = await run(u);
      assert.equal(error?.code, 'bad_url', JSON.stringify(u));
    }
    assert.equal(normalizeStoreUrl('shop.example.com/collections/all').href, 'https://shop.example.com/collections/all');
  });
  test('a public name that resolves to a private address (or a mix) is refused; non-standard ports are refused', async () => {
    const resolve = async (h) => (h === 'evil.example' ? [{ address: '10.1.2.3', family: 4 }] : h === 'mixed.example' ? [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    for (const u of ['http://evil.example/', 'http://mixed.example/']) assert.equal((await run(u, { net: { resolve, paceMs: 0 } })).error.code, 'blocked_host', u);
    assert.equal((await run('http://fine.example:8080/', { net: { resolve, paceMs: 0 } })).error.code, 'blocked_host');
    const f = createStoreFetcher({ resolve, paceMs: 0 });
    await assert.rejects(f.fetch('http://evil.example/', { anyHost: true }), { code: 'blocked_host' });
  });
  test('redirects are re-checked on every hop; loops stop after 5; off-site URLs are refused after detection', async () => {
    const inner = await site({ '/': { body: 'internal admin' } });
    const store = await site({ '/': { status: 302, headers: { location: `${inner.base}/` }, body: '' } }, { host: '127.0.0.2' });
    const { error } = await run(store.base, { net: { allowAddresses: ['127.0.0.2'], allowPorts: 'any', paceMs: 0 } });
    assert.equal(error.code, 'blocked_host');
    assert.equal(inner.log.length, 0, 'the internal server was never contacted');
    let n = 0;
    const s = await site({ '/': (req, res) => { n++; res.writeHead(302, { location: `/?n=${n}` }); res.end(); } });
    assert.equal((await run(s.base, { net: NET0 })).error.code, 'too_many_redirects');
    assert.ok(n <= 7);
    const t = await site({ '/': { body: 'ok' } });
    const port = new URL(t.base).port;
    const f = createStoreFetcher({ ...NET0, resolve: LOOP });
    f.allowSite('shop.test');
    assert.equal((await f.fetch(`http://www.shop.test:${port}/`)).status, 200, 'same registrable domain is fine');
    await assert.rejects(f.fetch(`http://other.test:${port}/`), { code: 'blocked_host' });
    f.allowPdfHost('cdn.shopify.com');
    await assert.rejects(f.fetch(`http://cdn.shopify.com:${port}/s/files/x.txt`), { code: 'blocked_host' }, 'asset hosts are for PDFs only');
    assert.equal((await f.fetch(`http://cdn.shopify.com:${port}/s/files/x.pdf`)).status, 404, 'a PDF path on the asset host may be fetched');
    assert.equal(registrableDomain('a.b.shop.co.uk'), 'shop.co.uk');
    assert.equal(registrableDomain('lumen.myshopify.com'), 'lumen.myshopify.com');
  });
  test('concurrency is clamped to 4 whatever the caller asks', () => {
    assert.equal(createStoreFetcher({ concurrency: 50 }).config.concurrency, 4);
    assert.equal(LIMITS.maxProducts, 10000);
    assert.equal(LIMITS.budgetMs, 20 * 60000);
  });
});
describe('robots.txt', () => {
  test('parser: most specific group, longest match, wildcards, $ and Crawl-delay', () => {
    const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: KnowBotStudio\nUser-agent: other\nDisallow: /private\nAllow: /private/ok$\nDisallow: /*.json$\nDisallow: /*?format=json\nCrawl-delay: 4\n\nSitemap: https://x/sm.xml');
    assert.deepEqual(p.sitemaps, ['https://x/sm.xml']);
    assert.equal(p.groups[1].crawlDelay, 4);
    assert.equal(robotsAllows(p, '/'), true);
    assert.equal(robotsAllows(p, '/private/x'), false);
    assert.equal(robotsAllows(p, '/private/ok'), true);
    assert.equal(robotsAllows(p, '/private/ok/more'), false);
    assert.equal(robotsAllows(p, '/products.json'), false);
    assert.equal(robotsAllows(p, '/products.json?page=2'), true);
    assert.equal(robotsAllows(p, '/shop?format=json'), false);
    assert.equal(robotsAllows(p, '/', 'somebot'), false, 'other bots get the * group');
    assert.equal(robotsAllows(parseRobots(''), '/x'), true);
  });
  test('Disallow: / for everyone → robots error, nothing else fetched', async () => {
    const s = await site({ '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /\n' }, '/': { body: html('x', 'x') } });
    const { error } = await run(s.base, { net: NET0 });
    assert.equal(error.code, 'robots');
    assert.deepEqual(s.log.map((l) => l.url), ['/robots.txt']);
  });
  test('a rule for our UA skips just those pages; the plan counts them', async () => {
    const shop = shopify({ n: 3, robots: 'User-agent: *\nAllow: /\n\nUser-agent: KnowBotStudio\nDisallow: /pages/faq\nDisallow: /policies/\n' });
    const w = await web(shop.hosts);
    const { r, error } = await run(w.url(shop.host), { enrich: 'none' });
    assert.ifError(error);
    assert.equal(w.hits(/pages\/faq|policies/), 0);
    assert.ok(r.plan.robots.disallowed >= 6, JSON.stringify(r.plan.robots));
    assert.equal(byKind(r, 'faq').length, 0);
    assert.equal(byKind(r, 'product').length, 3);
  });
});
describe('timeouts and size caps', () => {
  test('a hanging request times out', async () => {
    const s = await site({ '/': () => {} });
    const { error } = await run(s.base, { net: { ...NET0, timeoutMs: 200 } });
    assert.equal(error.code, 'timeout');
  });
  test('bodies over the cap are refused: content-length, chunked and gzip bombs', async () => {
    const big = 'x'.repeat(5000);
    const s = await site({
      '/cl': { body: big },
      '/chunked': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write(big); res.write(big); res.end(); },
      '/bomb': { headers: { 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.alloc(3 * 1024 * 1024)) },
      '/ok': { body: 'small' },
    });
    const f = createStoreFetcher({ ...NET0, maxBytes: 4096 });
    f.allowSite('127.0.0.1');
    for (const p of ['/cl', '/chunked', '/bomb']) await assert.rejects(f.fetch(`${s.base}${p}`), { code: 'too_large' }, p);
    assert.equal((await f.fetch(`${s.base}/ok`)).text(), 'small');
    const g = createStoreFetcher(NET0); g.allowSite('127.0.0.1');
    const r = await g.fetch(`${s.base}/bomb`);
    assert.equal(r.body.length, 3 * 1024 * 1024, 'gzip is decoded under the default 5 MB cap');
  });
  test('abort signal cancels the import', async () => {
    const s = await site({ '/': { delay: 2000, body: 'late' } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const { error } = await run(s.base, { signal: ac.signal, net: NET0 });
    assert.equal(error.code, 'aborted');
  });
  test('detectPlatform on a bare site with no API says generic', async () => {
    const s = await site({ '/': { body: html('Plain', '<h1>Plain</h1>') } });
    const f = createStoreFetcher(NET0);
    const d = await detectPlatform(s.base, f.fetch);
    assert.equal(d.platform, 'generic'); assert.equal(d.api, false);
  });
});

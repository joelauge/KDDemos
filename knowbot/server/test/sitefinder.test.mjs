// The site finder (server/sitefinder.mjs): URL canonicalisation, classification, sitemaps, help desks and the ranked
// plan. Pure functions plus a stub fetcher (an in-memory web): nothing here opens a socket.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { normalizeUrl, urlKey, classifyUrl, sitemapHint, helpDeskOf, anchorsOf, canonicalOf, robotsCrawlDelay, crawlSitemaps, findSources, chromeHtmlOf, compareSources, KIND_RANK } from '../sitefinder.mjs';
import { parseRobots, robotsAllows, registrableDomain } from '../storeimport.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1

/** An in-memory web behind the fetcher contract findSources uses: get, fetch, robotsFor, robotsAllowed, hostOkFor, pdfOkFor. */
function stubWeb(pages, { site = 'shop.test', robots = '', helpHosts = [] } = {}) {
  const log = [];
  const allowed = new Set(helpHosts);
  const hostOk = (u) => { try { const h = new URL(u).hostname; return registrableDomain(h) === site || allowed.has(h); } catch { return false; } };
  const parsed = parseRobots(robots);
  const resp = (url, p) => {
    const body = Buffer.isBuffer(p.body) ? p.body : Buffer.from(typeof p.body === 'string' ? p.body : JSON.stringify(p.body));
    return { status: p.status || 200, ok: (p.status || 200) < 300, url, headers: { 'content-type': p.type || 'text/html', ...(p.headers || {}) }, body, text: () => body.toString('utf8'), json: () => { try { return JSON.parse(body.toString('utf8')); } catch { return undefined; } } };
  };
  const f = {
    log,
    async fetch(url) { log.push(url); if (!hostOk(url)) throw Object.assign(new Error('blocked'), { code: 'blocked_host' }); const p = pages[url]; return p ? resp(url, p) : resp(url, { status: 404, body: 'nf' }); },
    async get(url, o) { const r = await f.fetch(url, o); if (r.status === 404) throw Object.assign(new Error('nf'), { code: 'not_found' }); return r; },
    async robotsFor() { return parsed; },
    async robotsAllowed(url) { const u = new URL(url); return robotsAllows(parsed, `${u.pathname}${u.search}`); },
    hostOkFor: hostOk,
    pdfOkFor: (u) => hostOk(u) || (/^cdn\.shopify\.com$/.test(new URL(u).hostname) && /\.pdf$/.test(new URL(u).pathname)),
    allowHost(h) { allowed.add(h); },
  };
  return f;
}
const urlset = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc><lastmod>2026-10-01</lastmod></url>`).join('')}</urlset>`;
const smIndex = (urls) => `<?xml version="1.0"?><sitemapindex>${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;

describe('URLs', () => {
  test('normalizeUrl drops hashes, tracking and variant parameters, folds collection-scoped product paths', () => {
    assert.equal(normalizeUrl('https://Shop.test/products/a?variant=123&utm_source=x&color=red#reviews'), 'https://shop.test/products/a?color=red');
    assert.equal(normalizeUrl('https://shop.test/collections/bikes/products/trail-pro'), 'https://shop.test/products/trail-pro');
    assert.equal(normalizeUrl('https://shop.test/fr/collections/bikes/products/trail-pro'), 'https://shop.test/fr/products/trail-pro');
    assert.equal(normalizeUrl('/pages/faq', 'https://shop.test/x'), 'https://shop.test/pages/faq');
    assert.equal(normalizeUrl('https://shop.test/product/toad-vault/'), 'https://shop.test/product/toad-vault/', 'a trailing slash is kept for fetching');
    for (const bad of ['javascript:alert(1)', 'mailto:a@b.c', 'ftp://x.test/a', 'http://[bad']) assert.equal(normalizeUrl(bad, 'https://shop.test/'), null, bad);
  });
  test('urlKey folds www., locale prefixes, trailing slashes and case: one key per page', () => {
    const k = urlKey('https://shop.test/products/Trail-Pro');
    for (const u of ['https://www.shop.test/products/trail-pro', 'https://shop.test/en-gb/products/trail-pro', 'https://shop.test/products/trail-pro/', 'https://shop.test/products/trail-pro?variant=9']) assert.equal(urlKey(u), k, u);
    assert.notEqual(urlKey('https://shop.test/products/trail-pro?size=l'), k, 'other parameters are a different page');
  });
});

describe('classification', () => {
  test('product, collection, blog, FAQ, policy, help, PDF and other pages, per platform', () => {
    const c = (u, o) => classifyUrl(`https://shop.test${u}`, o);
    assert.equal(c('/products/trail-pro', { platform: 'shopify' }), 'product');
    assert.equal(c('/de/products/trail-pro', { platform: 'shopify' }), 'product');
    assert.equal(c('/collections/bikes', { platform: 'shopify' }), 'collection');
    assert.equal(c('/blogs/news/first-ride', { platform: 'shopify' }), 'blog');
    assert.equal(c('/pages/faq', { platform: 'shopify' }), 'faq');
    assert.equal(c('/pages/shipping-returns', { platform: 'shopify' }), 'policy');
    assert.equal(c('/policies/refund-policy', { platform: 'shopify' }), 'policy');
    assert.equal(c('/policies/contact-information', { platform: 'shopify' }), 'help');
    assert.equal(c('/pages/size-guide', { platform: 'shopify' }), 'help');
    assert.equal(c('/pages/about-us', { platform: 'shopify' }), 'help');
    assert.equal(c('/pages/lookbook', { platform: 'shopify' }), 'page');
    assert.equal(c('/product/toad-vault/', { platform: 'woocommerce' }), 'product');
    assert.equal(c('/product-category/vaults/', { platform: 'woocommerce' }), 'collection');
    assert.equal(c('/velo-jersey.html', { platform: 'magento' }), 'candidate', 'Magento .html: a product only once its page shows Product JSON-LD');
    assert.equal(c('/velo-jersey.html', { platform: 'magento', hint: 'product' }), 'product', 'a product sitemap is trusted');
    assert.equal(c('/shop/lamps', { platform: 'generic' }), 'candidate', '/shop/<x> may be a category');
    assert.equal(c('/catalog/lamps', { platform: 'bigcommerce' }), 'candidate');
    assert.equal(c('/shop', { platform: 'generic' }), 'collection');
    assert.equal(c('/customer-service', { platform: 'magento' }), 'help');
    assert.equal(c('/product-page/lamp', { platform: 'wix' }), 'product');
    assert.equal(c('/shop/p/lamp', { platform: 'squarespace' }), 'product');
    assert.equal(c('/docs/manual.PDF'), 'pdf');
    assert.equal(c('/x', { hint: 'product' }), 'product');
    assert.equal(c('/x', { hint: 'blog' }), 'blog');
    assert.equal(c('/info/x', { text: 'Delivery & Returns' }), 'policy', 'nav link text counts');
    assert.equal(c('/hc/en-us/articles/123-Shipping-times'), 'policy');
    assert.equal(c('/hc/en-us/articles/124-Assembly'), 'help');
  });
  test('sitemap hints, help desks, links, canonical, Crawl-delay', () => {
    assert.equal(sitemapHint('https://s.test/sitemap_products_1.xml?from=1&to=99'), 'product');
    assert.equal(sitemapHint('https://s.test/xmlsitemap.php?type=categories&page=1'), 'collection');
    assert.equal(sitemapHint('https://s.test/wp-sitemap-posts-post-1.xml'), 'blog');
    assert.equal(sitemapHint('https://s.test/page-sitemap.xml'), 'page');
    assert.equal(sitemapHint('https://s.test/image-sitemap.xml'), 'image');
    assert.equal(sitemapHint('https://s.test/store-products-sitemap.xml'), 'product');
    assert.equal(helpDeskOf('lumen.zendesk.com'), 'zendesk');
    assert.equal(helpDeskOf('lumen.gorgias.help'), 'gorgias');
    assert.equal(helpDeskOf('intercom.help'), 'intercom');
    assert.equal(helpDeskOf('acme.freshdesk.com'), 'freshdesk');
    assert.equal(helpDeskOf('acme.helpscoutdocs.com'), 'helpscout');
    assert.equal(helpDeskOf('help.lumen.com', 'lumen.com'), 'subdomain');
    assert.equal(helpDeskOf('help.other.com', 'lumen.com'), null);
    const a = anchorsOf('<a href="/pages/faq?utm_source=x#top">FAQ <b>here</b></a><a href="mailto:x@y">m</a><a href="https://cdn.shopify.com/f.pdf" title="Manual">  </a>', 'https://s.test/');
    assert.deepEqual(a, [{ url: 'https://s.test/pages/faq', text: 'FAQ here' }, { url: 'https://cdn.shopify.com/f.pdf', text: 'Manual' }]);
    assert.equal(canonicalOf('<link rel="canonical" href="/products/a?variant=2">', 'https://s.test/x'), 'https://s.test/products/a');
    assert.equal(robotsCrawlDelay(parseRobots('User-agent: *\nCrawl-delay: 10\n\nUser-agent: KnowBotStudio\nCrawl-delay: 2\n')), 2);
    assert.equal(robotsCrawlDelay(parseRobots('User-agent: *\nCrawl-delay: 10\n')), 10);
    assert.equal(robotsCrawlDelay(parseRobots('')), 0);
    assert.ok(KIND_RANK.policy < KIND_RANK.help && KIND_RANK.help < KIND_RANK.product && KIND_RANK.product < KIND_RANK.collection && KIND_RANK.collection < KIND_RANK.blog);
  });
});

describe('sitemaps', () => {
  test('index → every child (gz too, images skipped), off-site and duplicate URLs dropped, defaults only when seeds give nothing', async () => {
    const B = 'https://shop.test';
    const f = stubWeb({
      [`${B}/robots-sitemap.xml`]: { type: 'application/xml', body: smIndex([`${B}/sm-products.xml.gz`, `${B}/sm-pages.xml`, `${B}/sm-images.xml`, 'https://evil.test/sm.xml', `${B}/sm-blog.xml`]) },
      [`${B}/sm-products.xml.gz`]: { body: zlib.gzipSync(urlset([`${B}/products/a`, `${B}/products/a?variant=1`, `${B}/products/b`])) },
      [`${B}/sm-pages.xml`]: { body: urlset([`${B}/pages/faq`, 'https://evil.test/pages/faq']) },
      [`${B}/sm-blog.xml`]: { body: urlset([`${B}/blogs/news/x`]) },
      [`${B}/sm-images.xml`]: { body: urlset([`${B}/image.jpg`]) },
      [`${B}/sitemap.xml`]: { body: urlset([`${B}/never`]) },
    });
    const r = await crawlSitemaps(f, { seeds: [`${B}/robots-sitemap.xml`], defaults: [`${B}/sitemap.xml`], inflate: (b) => zlib.gunzipSync(b) });
    assert.deepEqual(r.entries.map((e) => [e.loc, e.hint]), [[`${B}/pages/faq`, 'page'], [`${B}/products/a`, 'product'], [`${B}/products/b`, 'product'], [`${B}/blogs/news/x`, 'blog']].sort((x, y) => r.entries.findIndex((e) => e.loc === x[0]) - r.entries.findIndex((e) => e.loc === y[0])));
    assert.equal(r.entries.length, 4);
    assert.ok(!f.log.some((u) => /images|evil|\/sitemap\.xml$/.test(u)), f.log.join(' '));
    const d = await crawlSitemaps(f, { seeds: [`${B}/missing.xml`], defaults: [`${B}/sitemap.xml`] });
    assert.deepEqual(d.entries.map((e) => e.loc), [`${B}/never`], 'defaults are tried when the seeds give nothing');
  });
});

describe('findSources: the ranked plan', () => {
  test('robots, sitemaps, nav/footer links, llms.txt, help subdomain + Zendesk API, Shopify policies; ranked, deduped, counted', async () => {
    const B = 'https://shop.test';
    const home = `<html><body><header><nav><a href="/collections/all">Shop</a><a href="/pages/shipping">Shipping</a></nav></header><main>Hi</main>
      <footer><a href="/pages/faq">FAQ</a><a href="/pages/returns-exchanges">Returns &amp; exchanges</a><a href="/pages/warranty">Warranty</a><a href="/pages/size-guide">Size guide</a>
      <a href="/pages/care">Care</a><a href="/pages/contact">Contact</a><a href="/pages/about">About</a><a href="/policies/terms-of-service">Terms</a><a href="/pages/privacy">Privacy</a>
      <a href="https://help.shop.test/">Help centre</a><a href="https://shop.zendesk.com/hc/en-us">Support</a><a href="https://cdn.shopify.com/s/files/manual.pdf">Manual</a>
      <a href="https://instagram.com/shop">Instagram</a></footer></body></html>`;
    const f = stubWeb({
      [`${B}/sitemap.xml`]: { body: smIndex([`${B}/sitemap_products_1.xml`, `${B}/sitemap_pages_1.xml`, `${B}/sitemap_collections_1.xml`, `${B}/sitemap_blogs_1.xml`]) },
      [`${B}/sitemap_products_1.xml`]: { body: urlset([`${B}/products/a`, `${B}/products/b`, `${B}/en-gb/products/a`, `${B}/products/secret`]) },
      [`${B}/sitemap_pages_1.xml`]: { body: urlset([`${B}/pages/faq`, `${B}/pages/lookbook`]) },
      [`${B}/sitemap_collections_1.xml`]: { body: urlset([`${B}/collections/all`]) },
      [`${B}/sitemap_blogs_1.xml`]: { body: urlset([`${B}/blogs/news/x`]) },
      [`${B}/llms.txt`]: { type: 'text/plain', body: `# Shop\n- [Shipping policy](${B}/policies/shipping-policy)\n- [Gift cards](${B}/pages/gift-cards)` },
      'https://shop.zendesk.com/api/v2/help_center/articles.json?per_page=100': { type: 'application/json', body: { next_page: null, articles: [
        { html_url: 'https://shop.zendesk.com/hc/en-us/articles/1-Track-my-order', title: 'Track my order', body: '<p>Use the link in your email.</p>' },
        { html_url: 'https://shop.zendesk.com/hc/en-us/articles/2-Draft', title: 'Draft', body: 'x', draft: true }] } },
      'https://help.shop.test/sitemap.xml': { body: urlset(['https://help.shop.test/article/assembly']) },
    }, { robots: `User-agent: *\nDisallow: /products/secret\nCrawl-delay: 3\nSitemap: ${B}/sitemap.xml\n` });
    const det = { platform: 'shopify', api: true, base: B, name: 'Shop', home: { url: `${B}/`, html: home } };
    const plan = await findSources(f, det, { registrable: registrableDomain, allowHelpHost: (h) => f.allowHost(h), feedTotal: async () => 2 });
    const kindOf = (u) => plan.sources.find((s) => s.url === u)?.kind;
    assert.equal(plan.robots.crawlDelay, 3);
    assert.equal(plan.robots.disallowed, 1, 'the disallowed product is reported, not planned');
    assert.equal(kindOf(`${B}/products/secret`), undefined);
    assert.equal(plan.counts.product, 2, 'the locale copy folds into /products/a');
    assert.deepEqual(plan.productUrls.sort(), [`${B}/products/a`, `${B}/products/b`].sort(), 'the locale copy is folded while crawling; the disallowed page is not planned');
    assert.equal(kindOf(`${B}/pages/faq`), 'faq');
    assert.equal(kindOf(`${B}/pages/shipping`), 'policy');
    assert.equal(kindOf(`${B}/pages/returns-exchanges`), 'policy');
    assert.equal(kindOf(`${B}/pages/warranty`), 'policy');
    assert.equal(kindOf(`${B}/pages/privacy`), 'policy');
    assert.equal(kindOf(`${B}/policies/terms-of-service`), 'policy');
    assert.equal(kindOf(`${B}/policies/shipping-policy`), 'policy', 'from llms.txt');
    for (const p of ['size-guide', 'care', 'contact', 'about']) assert.equal(kindOf(`${B}/pages/${p}`), 'help', p);
    assert.equal(kindOf(`${B}/pages/lookbook`), 'page');
    assert.equal(kindOf(`${B}/collections/all`), 'collection');
    assert.equal(kindOf(`${B}/blogs/news/x`), 'blog');
    assert.equal(kindOf('https://cdn.shopify.com/s/files/manual.pdf'), 'pdf');
    assert.equal(kindOf('https://help.shop.test/article/assembly'), 'help', 'the help subdomain\'s sitemap');
    assert.equal(kindOf('https://shop.zendesk.com/hc/en-us/articles/1-Track-my-order'), 'help', 'Zendesk API article');
    assert.ok(plan.prefetched.has(urlKey('https://shop.zendesk.com/hc/en-us/articles/1-Track-my-order')), 'its body came with the API');
    assert.equal(kindOf('https://shop.zendesk.com/hc/en-us/articles/2-Draft'), undefined, 'drafts are skipped');
    assert.ok(!plan.sources.some((s) => /instagram/.test(s.url)));
    assert.deepEqual(plan.helpdesks.map((d) => d.type).sort(), ['subdomain', 'zendesk']);
    // ranked: policies/FAQ, help, products, PDFs, collections, blog, other pages
    const ranks = plan.sources.map((s) => KIND_RANK[s.kind]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    // unverified Shopify policy handles are tried but not counted as found
    assert.equal(kindOf(`${B}/policies/refund-policy`), 'policy');
    assert.ok(plan.guesses >= 2);
    assert.equal(plan.samples.product.length, 2);
  });
});

describe('findSources: ranking, help desks and candidates (review fixes)', () => {
  test('a sitemap "page" that a footer link reclassifies as a policy takes the policy rank and sorts with the policies, before help-desk articles', async () => {
    const B = 'https://shop.test';
    const home = `<html><body><header><nav><a href="/collections/all">Shop</a></nav></header><main>Hi</main>
      <footer><a href="/pages/info">Shipping &amp; Returns</a><a href="https://shop.zendesk.com/hc/en-us">Help centre</a></footer></body></html>`;
    const arts = Array.from({ length: 30 }, (_, i) => ({ html_url: `https://shop.zendesk.com/hc/en-us/articles/${i + 1}-Returns-question-${i + 1}`, title: `Returns question ${i + 1}`, body: '<p>x</p>' }));
    const f = stubWeb({
      [`${B}/sitemap.xml`]: { body: urlset([`${B}/pages/info`, `${B}/pages/zz-help`, `${B}/products/a`]) },
      'https://shop.zendesk.com/api/v2/help_center/articles.json?per_page=100': { type: 'application/json', body: { next_page: null, articles: arts } },
    }, { robots: `Sitemap: ${B}/sitemap.xml\n` });
    const det = { platform: 'shopify', api: true, base: B, name: 'Shop', home: { url: `${B}/`, html: home } };
    const plan = await findSources(f, det, { registrable: registrableDomain, allowHelpHost: (h) => f.allowHost(h) });
    const info = plan.sources.find((s) => s.url === `${B}/pages/info`);
    assert.equal(info.kind, 'policy');
    assert.equal(info.rank, KIND_RANK.policy, 'the rank follows the new kind');
    const policies = plan.sources.filter((s) => s.kind === 'policy');
    assert.equal(policies[0].url, `${B}/pages/info`, 'the menu-linked policy sorts first, before 30 desk articles');
    assert.ok(policies.length > 10);
    // compareSources never trusts a stale rank
    assert.ok(compareSources({ kind: 'policy', rank: 6, via: ['sitemap'], url: 'b' }, { kind: 'help', rank: 1, via: ['nav'], url: 'a' }) < 0);
  });

  test('hosted desks: only menu-linked help counts, one desk per import (named like the site first); others are reported, never read', async () => {
    const B = 'https://lumen.test';
    const home = `<html><body><header><nav><a href="/">Home</a></nav></header>
      <main><p>Pay later with <a href="https://payco.zendesk.com/hc/en-us">PayCo help</a>.</p></main>
      <footer><a href="https://acme-partner.gorgias.help/">Support</a><a href="https://lumen.zendesk.com/hc/en-us">Help centre</a></footer></body></html>`;
    const f = stubWeb({ 'https://lumen.zendesk.com/api/v2/help_center/articles.json?per_page=100': { type: 'application/json', body: { next_page: null, articles: [{ html_url: 'https://lumen.zendesk.com/hc/en-us/articles/1-Track', title: 'Track', body: '<p>t</p>' }] } } },
      { site: 'lumen.test' });
    const det = { platform: 'shopify', api: true, base: B, name: 'Lumen', home: { url: `${B}/`, html: home } };
    const plan = await findSources(f, det, { registrable: registrableDomain, allowHelpHost: (h) => f.allowHost(h) });
    assert.deepEqual(plan.helpdesks.map((d) => d.origin), ['https://lumen.zendesk.com']);
    assert.deepEqual(plan.skippedDesks.map((d) => [d.origin, d.reason]).sort(), [['https://acme-partner.gorgias.help', 'one help desk per import'], ['https://payco.zendesk.com', 'not linked from the site menus as its help']]);
    assert.ok(!f.log.some((u) => /payco|acme-partner/.test(u)), f.log.join(' '));
    assert.match(chromeHtmlOf(home), /lumen\.zendesk\.com/);
    assert.doesNotMatch(chromeHtmlOf(home), /payco/);
  });

  test('Magento and /shop/<x> candidates are counted apart ("up to"), never inflating the product count', async () => {
    const B = 'https://velo.test';
    const f = stubWeb({ [`${B}/sitemap.xml`]: { body: urlset([`${B}/velo-jersey.html`, `${B}/apparel.html`, `${B}/men.html`, `${B}/customer-service`]) } }, { site: 'velo.test', robots: `Sitemap: ${B}/sitemap.xml\n` });
    const det = { platform: 'magento', api: true, base: B, name: 'Velo', home: { url: `${B}/`, html: '<html></html>' } };
    const plan = await findSources(f, det, { registrable: registrableDomain, feedTotal: async () => 1 });
    assert.equal(plan.counts.product, 1, 'the feed total, not the .html pages');
    assert.equal(plan.candidates, 3);
    assert.deepEqual(plan.upTo, { product: 4 });
    assert.equal(plan.candidateUrls.length, 3);
    // no feed: candidates stand in for the product count, flagged approximate
    const g = await findSources(f, { ...det, api: false }, { registrable: registrableDomain });
    assert.equal(g.counts.product, 3); assert.deepEqual(g.approx, ['product']);
  });
});

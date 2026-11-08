// "Enter a Store URL" importer. Fakes only: every store here is a local HTTP server on 127.0.0.x; nothing reaches a
// real store or knowDrive.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { importStore, detectPlatform, createStoreFetcher, isBlockedAddress, normalizeStoreUrl, parseRobots, robotsAllows, buildMarkdownFiles,
  htmlToText, docsFromHtml, registrableDomain, StoreImportError, USER_AGENT } from '../storeimport.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1

const NET = { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
after(async () => { for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); } });

/**
 * A fake site. routes: { 'GET /path?query': handler | {status, type, body, headers, delay} }. Keys without a method
 * match GET; a key without a query matches any query only when no exact key exists. Every request is logged.
 */
async function site(routes, { host = '127.0.0.1', baseHeaders = {} } = {}) {
  const log = [];
  let active = 0, maxActive = 0;
  const s = http.createServer(async (req, res) => {
    active++; maxActive = Math.max(maxActive, active);
    res.on('close', () => { active--; });
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    log.push({ method: req.method, url: req.url, headers: req.headers, body });
    const u = new URL(req.url, 'http://x');
    const r = routes[`${req.method} ${req.url}`] ?? (req.method === 'GET' ? routes[req.url] : undefined)
      ?? routes[`${req.method} ${u.pathname}`] ?? (req.method === 'GET' ? routes[u.pathname] : undefined);
    if (typeof r === 'function') return r(req, res, { body, url: u, base: `http://${host}:${s.address().port}` });
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    if (r.delay) await sleep(r.delay);
    const b = typeof r.body === 'function' ? r.body(`http://${host}:${s.address().port}`, u, body) : r.body;
    const out = typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b);
    res.writeHead(r.status || 200, { 'content-type': r.type || (typeof b === 'object' && !Buffer.isBuffer(b) ? 'application/json' : 'text/html; charset=utf-8'), ...baseHeaders, ...(r.headers || {}) });
    res.end(out);
  });
  await new Promise((r) => s.listen(0, host, r));
  servers.push(s);
  const base = `http://${host}:${s.address().port}`;
  return { base, log, server: s, get maxActive() { return maxActive; }, hits: (re) => log.filter((l) => re.test(l.url)).length };
}
const html = (title, main, extra = '') => `<!doctype html><html><head><title>${title}</title>${extra}</head><body><header><nav>Home Shop Cart</nav></header><main>${main}</main><footer>© Footer text</footer></body></html>`;
const sitemap = (urls) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const sitemapIndex = (urls) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;
const fileText = (r, re) => r.files.filter((f) => re.test(f.name)).map((f) => f.bytes.toString('utf8')).join('\n');
async function run(url, opts = {}) {
  const events = [];
  try {
    const r = await importStore(url, { net: NET, date: new Date('2026-11-08T00:00:00Z'), ...opts, onEvent: (e, d) => events.push({ e, d }) });
    return { r, events };
  } catch (error) { return { error, events }; }
}

// ------------------------------------------------------------------------------------------------ fake Shopify
function shopifyRoutes(nProducts) {
  const product = (i) => ({ id: i, title: `Trail Pro ${i}`, handle: `trail-pro-${i}`, vendor: 'Lumen', product_type: 'Bikes', tags: ['mtb', 'carbon'],
    body_html: `<p>A light <strong>carbon</strong> trail bike, number ${i}.</p><script>evilScript()</script>`,
    variants: i % 2 ? [{ title: 'Default Title', price: '1299.00', compare_at_price: '1499.00', sku: `TP-${i}`, available: true }]
      : [{ title: 'Small / Black', price: '1299.00', sku: `TP-${i}-S`, available: true }, { title: 'Large / Black', price: '1349.00', sku: `TP-${i}-L`, available: false }] });
  const all = Array.from({ length: nProducts }, (_, i) => product(i + 1));
  return {
    '/': { body: html('Lumen Bikes', '<h1>Lumen Bikes</h1>', '<link href="https://cdn.shopify.com/s/files/theme.css"><script>Shopify.currency = {"active":"USD","rate":"1.0"};</script><meta property="og:site_name" content="Lumen Bikes">'),
      headers: { 'x-shopify-stage': 'production', 'set-cookie': '_shopify_y=abc; Path=/' } },
    '/products.json': (req, res, { url }) => {
      const limit = Number(url.searchParams.get('limit')), page = Number(url.searchParams.get('page') || 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ products: all.slice((page - 1) * limit, page * limit) }));
    },
    '/policies/refund-policy': { body: html('Refund policy', '<div class="shopify-policy__container"><h1>Refund policy</h1><p>We refund unused items within 30 days of delivery.</p><p># not a heading</p></div>') },
    '/policies/shipping-policy': { body: html('Shipping policy', '<h1>Shipping policy</h1><p>Orders ship in 2 business days from our Denver warehouse.</p>') },
    '/sitemap.xml': { type: 'application/xml', body: (b) => sitemapIndex([`${b}/sitemap_products_1.xml?from=1&to=99`, `${b}/sitemap_pages_1.xml?from=1&to=9`, `${b}/sitemap_blogs_1.xml`]) },
    '/sitemap_pages_1.xml': { type: 'application/xml', body: (b) => sitemap([`${b}/pages/faq`, `${b}/pages/about-us`, `${b}/pages/lookbook`, `https://elsewhere.example/pages/faq`]) },
    '/sitemap_products_1.xml': { type: 'application/xml', body: (b) => sitemap([`${b}/products/trail-pro-1`]) },
    '/pages/faq': { body: html('FAQ', '<h1>FAQ</h1><details><summary>How long does shipping take?</summary><p>Two to five business days in the US.</p></details><details><summary>Do you ship to Canada?</summary><p>Yes, for a flat $25.</p></details>') },
    '/pages/about-us': { body: html('About us', '<h1>About us</h1><p>Lumen Bikes has built trail bikes in Denver since 2012, by riders for riders.</p>') },
    '/pages/lookbook': { body: html('Lookbook', '<h1>Lookbook</h1><p>Photos of bikes in the mountains, nothing to answer from here at all.</p>') },
  };
}

describe('Shopify', () => {
  test('detects, paginates products.json, reads policies, FAQ and help pages; Markdown has sections with sources', async () => {
    const s = await site(shopifyRoutes(260));
    const { r, events, error } = await run(s.base, { perFileProducts: 200 });
    assert.ifError(error);
    assert.equal(r.platform, 'shopify'); assert.equal(r.api, true);
    assert.equal(r.counts.products, 260);
    assert.equal(r.counts.policies, 2);
    assert.equal(r.counts.faqs, 2);
    assert.ok(s.hits(/^\/products\.json\?limit=250&page=2$/) === 1, 'second page requested');
    assert.equal(s.hits(/products\.json\?limit=250&page=3/), 0, 'stops after a short page');
    assert.equal(s.hits(/sitemap_products|sitemap_blogs/), 0, 'API products: product and blog sitemaps skipped');
    const names = r.files.map((f) => f.name).sort();
    assert.deepEqual(names, ['127-0-0-1-about-us.md', '127-0-0-1-faq.md', '127-0-0-1-products-1.md', '127-0-0-1-products-2.md', '127-0-0-1-refund-policy.md', '127-0-0-1-shipping-policy.md'].sort().map((n) => n.replace('about-us', 'pages')).sort());
    const prod = fileText(r, /products-1/);
    assert.match(prod, /^# Products: Lumen Bikes \(part 1 of 2\)/);
    assert.match(prod, /\n## Trail Pro 1\n\nSource: http:\/\/127\.0\.0\.1:\d+\/products\/trail-pro-1\n- Trail Pro 1 price: 1,299\.00 USD \(was 1,499\.00 USD\)\n- Trail Pro 1 brand: Lumen\n- Trail Pro 1 type: Bikes\n- Trail Pro 1 SKU: TP-1\n- Trail Pro 1 availability: in stock\n- Trail Pro 1 tags: mtb, carbon\n\nA light carbon trail bike, number 1\./);
    assert.match(prod, /## Trail Pro 2\n[\s\S]*?- Trail Pro 2 price: 1,299\.00 USD to 1,349\.00 USD[\s\S]*?- Trail Pro 2 variants:\n {2}- Trail Pro 2 Small \/ Black: 1,299\.00 USD, SKU TP-2-S, in stock\n {2}- Trail Pro 2 Large \/ Black: 1,349\.00 USD, SKU TP-2-L, out of stock/);
    assert.ok(!/evilScript/.test(prod), 'scripts stripped');
    assert.equal(r.files.find((f) => /products-1/.test(f.name)).docs, 200);
    const faq = fileText(r, /faq/);
    assert.match(faq, /## FAQ\n\nSource: http:\/\/127\.0\.0\.1:\d+\/pages\/faq\n\n### How long does shipping take\?\nTwo to five business days in the US\.\n\n### Do you ship to Canada\?\nYes, for a flat \$25\./);
    const refund = fileText(r, /refund-policy/);
    assert.match(refund, /## Refund policy\n\nSource: .*\/policies\/refund-policy\nWe refund unused items within 30 days of delivery\.\n\n\\# not a heading/);
    assert.ok(!/Footer text|Home Shop Cart/.test(refund), 'nav and footer dropped');
    assert.match(fileText(r, /pages/), /## About us\n\nSource: .*\/pages\/about-us\nLumen Bikes has built/);
    assert.equal(s.hits(/lookbook/), 1, 'small store: non-matching page is checked by title');
    assert.ok(!/Lookbook/.test(r.files.map((f) => f.bytes.toString()).join('')), 'non-help page not imported');
    // politeness and privacy
    for (const l of s.log) { assert.equal(l.headers['user-agent'], USER_AGENT); assert.equal(l.headers.cookie, undefined); assert.equal(l.headers.authorization, undefined); }
    assert.ok(s.maxActive <= 4);
    // events
    const ev = events.map((x) => x.e);
    assert.deepEqual([...new Set(ev)].filter((e) => e !== 'fetching'), ['detect', 'found', 'building', 'done']);
    assert.deepEqual(events.find((x) => x.e === 'detect').d, { platform: 'shopify', api: true, base: s.base, name: 'Lumen Bikes' });
    assert.deepEqual(events.find((x) => x.e === 'found').d, { products: 260, pages: 1, policies: 2, faqs: 2 });
    const fe = events.filter((x) => x.e === 'fetching').at(-1).d; assert.equal(fe.done, fe.total);
    const done = events.find((x) => x.e === 'done').d;
    assert.ok(done.files.every((f) => typeof f.bytes === 'number' && f.docs > 0));
    for (const f of r.files) { assert.equal(f.mime, 'text/markdown'); assert.ok(Buffer.isBuffer(f.bytes)); assert.equal(f.size, f.bytes.length); }
  });

  test('caps products at maxProducts and the byte budget at the remaining quota, and reports both', async () => {
    const s = await site(shopifyRoutes(300));
    const a = await run(s.base, { maxProducts: 100 });
    assert.ifError(a.error);
    assert.equal(a.r.counts.products, 100);
    assert.deepEqual(a.r.capped.products, { limit: 100, kept: 100, more: true });
    assert.deepEqual(a.events.find((x) => x.e === 'capped').d.products, { limit: 100, kept: 100, more: true });
    assert.equal(s.hits(/products\.json\?limit=250/), 1, 'stops paginating at the cap');

    const b = await run(s.base, { remainingBytes: 12000 });
    assert.ifError(b.error);
    const total = b.r.files.reduce((n, f) => n + f.size, 0);
    assert.ok(total <= 12000, `total ${total} ≤ remaining quota`);
    assert.ok(b.r.capped.bytes.droppedProducts > 200);
    assert.ok(b.r.files.some((f) => /refund-policy/.test(f.name)), 'policies are kept first');
    assert.ok(b.r.files.some((f) => /faq/.test(f.name)), 'FAQ kept before products');

    const c = await run(s.base, { remainingBytes: 0 });
    assert.equal(c.error.code, 'quota');
  });

  test('products.json disabled: falls back to product pages (JSON-LD) from the products sitemap', async () => {
    const routes = shopifyRoutes(1);
    routes['/products.json'] = { status: 404, body: 'nope' };
    routes['/products/trail-pro-1'] = { body: html('Trail Pro 1', '<h1>Trail Pro 1</h1>', `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Trail Pro 1', sku: 'TP-1', brand: { '@type': 'Brand', name: 'Lumen' }, offers: { '@type': 'Offer', price: '1299.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' }, description: 'Carbon trail bike.' })}</script>`) };
    const s = await site(routes);
    const { r, error } = await run(s.base);
    assert.ifError(error);
    assert.equal(r.platform, 'shopify'); assert.equal(r.api, false);
    assert.equal(r.counts.products, 1);
    assert.match(fileText(r, /products/), /## Trail Pro 1\n\nSource: .*\/products\/trail-pro-1\n- Trail Pro 1 price: 1,299\.00 USD\n- Trail Pro 1 brand: Lumen\n- Trail Pro 1 SKU: TP-1\n- Trail Pro 1 availability: in stock\n\nCarbon trail bike\./);
    assert.ok(r.warnings.some((w) => /products\.json/.test(w)));
  });
});

// ------------------------------------------------------------------------------------------------ fake Magento 2
function magentoRoutes({ graphql = true } = {}) {
  const items = [
    { __typename: 'SimpleProduct', name: 'Hydro Bottle', sku: 'HB-1', url_key: 'hydro-bottle', url_suffix: '.html', stock_status: 'IN_STOCK', categories: [{ name: 'Gear' }],
      price_range: { minimum_price: { regular_price: { value: 25, currency: 'EUR' }, final_price: { value: 19.5, currency: 'EUR' } }, maximum_price: { final_price: { value: 19.5, currency: 'EUR' } } },
      short_description: { html: '<p>Keeps water cold for 24 hours.</p>' }, description: { html: '' } },
    { __typename: 'ConfigurableProduct', name: 'Rain Jacket', sku: 'RJ', url_key: 'rain-jacket', url_suffix: '.html', stock_status: 'IN_STOCK', categories: [],
      price_range: { minimum_price: { regular_price: { value: 120, currency: 'EUR' }, final_price: { value: 120, currency: 'EUR' } }, maximum_price: { final_price: { value: 130, currency: 'EUR' } } },
      short_description: { html: '' }, description: { html: '<p>Waterproof shell.</p>' },
      variants: [{ attributes: [{ label: 'M', code: 'size' }, { label: 'Blue', code: 'color' }], product: { sku: 'RJ-M-B', stock_status: 'OUT_OF_STOCK', price_range: { minimum_price: { final_price: { value: 120, currency: 'EUR' } } } } }] },
    { __typename: 'SimpleProduct', name: 'Bike Light', sku: 'BL-1', url_key: 'bike-light', url_suffix: '.html', stock_status: 'IN_STOCK', categories: [],
      price_range: { minimum_price: { regular_price: { value: 40, currency: 'EUR' }, final_price: { value: 40, currency: 'EUR' } }, maximum_price: { final_price: { value: 40, currency: 'EUR' } } },
      short_description: { html: '' }, description: { html: '<p>300 lumens.</p>' } },
  ];
  return {
    '/': { body: html('Velo Shop', '<h1>Velo</h1>', '<script type="text/x-magento-init">{}</script>'), headers: { 'x-magento-cache-debug': 'MISS', 'set-cookie': 'PHPSESSID=x; mage-cache-sessid=true' } },
    'POST /graphql': (req, res, { body }) => {
      if (!graphql) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('Forbidden'); }
      const { query, variables } = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (/storeConfig/.test(query)) return res.end(JSON.stringify({ data: { storeConfig: { store_name: 'Velo Shop', base_currency_code: 'EUR' } } }));
      if (/products\(/.test(query)) {
        const { page, size } = variables;
        return res.end(JSON.stringify({ data: { products: { total_count: items.length, page_info: { current_page: page, total_pages: Math.ceil(items.length / size) }, items: items.slice((page - 1) * size, page * size) } } }));
      }
      if (/cmsPage/.test(query)) {
        const data = {}; const errors = [];
        for (const m of query.matchAll(/(p\d+): cmsPage\(identifier:"([^"]+)"\)/g)) {
          if (m[2] === 'faq') data[m[1]] = { title: 'FAQ', url_key: 'faq', content: '<h2>Can I return a bike?</h2><p>Yes, within 14 days.</p><h2>Do you offer financing?</h2><p>Yes, 0% for 12 months.</p>' };
          else if (m[2] === 'shipping') data[m[1]] = { title: 'Shipping', url_key: 'shipping', content: '<p>We ship across the EU in 3 to 5 days, free above 50 EUR.</p>' };
          else { data[m[1]] = null; errors.push({ message: `The CMS page with the "${m[2]}" ID doesn't exist.` }); }
        }
        return res.end(JSON.stringify({ data, errors }));
      }
      res.end(JSON.stringify({ errors: [{ message: 'bad query' }] }));
    },
    '/sitemap.xml': { type: 'application/xml', body: (b) => sitemap([`${b}/hydro-bottle.html`, `${b}/customer-service`, `${b}/faq`]) },
    '/customer-service': { body: html('Customer Service', '<h1>Customer Service</h1><p>Call us Monday to Friday, 9 to 5, at +49 30 1234.</p>') },
    '/hydro-bottle.html': { body: html('Hydro Bottle', '<h1>Hydro Bottle</h1>', `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'Velo' }, { '@type': 'Product', name: 'Hydro Bottle', sku: 'HB-1', offers: { '@type': 'Offer', price: 19.5, priceCurrency: 'EUR', availability: 'http://schema.org/InStock' } }] })}</script>`) },
  };
}
describe('Magento 2', () => {
  test('GraphQL products (paged, configurable variants) + cmsPage + sitemap help pages', async () => {
    const s = await site(magentoRoutes());
    const { r, events, error } = await run(s.base, { pageSize: 2 });
    assert.ifError(error);
    assert.equal(r.platform, 'magento'); assert.equal(r.api, true);
    assert.equal(events.find((x) => x.e === 'detect').d.name, 'Velo Shop');
    assert.equal(r.counts.products, 3);
    assert.equal(s.log.filter((l) => l.method === 'POST' && /products\(/.test(l.body)).length, 2, 'two GraphQL pages');
    const prod = fileText(r, /products/);
    assert.match(prod, /## Hydro Bottle\n\nSource: http:\/\/127\.0\.0\.1:\d+\/hydro-bottle\.html\n- Hydro Bottle price: 19\.50 EUR \(was 25\.00 EUR\)\n- Hydro Bottle SKU: HB-1\n- Hydro Bottle availability: in stock\n- Hydro Bottle categories: Gear\n\nKeeps water cold/);
    assert.match(prod, /## Rain Jacket[\s\S]*?- Rain Jacket type: Configurable[\s\S]*?- Rain Jacket variants:\n {2}- Rain Jacket M \/ Blue: 120\.00 EUR, SKU RJ-M-B, out of stock/);
    const faq = fileText(r, /faq/);
    assert.match(faq, /### Can I return a bike\?\nYes, within 14 days\./);
    assert.match(fileText(r, /shipping/), /We ship across the EU/);
    assert.match(fileText(r, /pages/), /## Customer Service\n\nSource: .*\/customer-service\nCall us Monday/);
    assert.equal(s.hits(/^\/faq$/), 0, 'CMS page already read through GraphQL is not fetched again');
    assert.equal(s.hits(/hydro-bottle\.html/), 0, 'API products: product pages not crawled');
  });
  test('GraphQL blocked: falls back to the generic sitemap + JSON-LD path', async () => {
    const s = await site(magentoRoutes({ graphql: false }));
    const { r, error } = await run(s.base);
    assert.ifError(error);
    assert.equal(r.platform, 'magento'); assert.equal(r.api, false);
    assert.equal(r.counts.products, 1);
    assert.match(fileText(r, /products/), /## Hydro Bottle\n[\s\S]*- Hydro Bottle price: 19\.50 EUR/);
  });
});

// ------------------------------------------------------------------------------------------------ fake Squarespace
function squarespaceRoutes({ robots = '' } = {}) {
  const item = (slug, title, value, extra = {}) => ({ title, fullUrl: `/shop/p/${slug}`, body: `<p>${title} is handmade.</p>`, tags: ['ceramic'], recordTypeLabel: 'store-item',
    structuredContent: { productType: 1 }, variants: [{ sku: `${slug}-1`, priceMoney: { currency: 'GBP', value: value }, stock: { unlimited: false, quantity: 3 }, attributes: {} }], ...extra });
  return {
    '/robots.txt': { type: 'text/plain', body: robots },
    '/': (req, res, { url }) => {
      if (url.searchParams.get('format') === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ website: { siteTitle: 'Clay Studio' } })); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('Clay Studio', '<h1>Clay</h1>', '<link rel="stylesheet" href="https://static1.squarespace.com/static/site.css">'));
    },
    '/sitemap.xml': { type: 'application/xml', body: (b) => sitemap([`${b}/shop/p/mug`, `${b}/shop/p/bowl`, `${b}/faq`, `${b}/returns`]) },
    '/shop': (req, res, { url }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.searchParams.get('offset') === '2') return res.end(JSON.stringify({ items: [item('bowl', 'Bowl', '30.00', { variants: [{ sku: 'b-s', priceMoney: { currency: 'GBP', value: '30.00' }, stock: { quantity: 0 }, attributes: { Size: 'Small' } }, { sku: 'b-l', priceMoney: { currency: 'GBP', value: '42.00' }, stock: { quantity: 2 }, attributes: { Size: 'Large' } }] })], pagination: { nextPage: false } }));
      res.end(JSON.stringify({ collection: { title: 'Shop' }, items: [item('mug', 'Mug', '18.00')], pagination: { nextPage: true, nextPageOffset: 2 } }));
    },
    '/shop/p/mug': { body: html('Mug', '<h1>Mug</h1>', `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Mug', offers: [{ '@type': 'Offer', price: '18.00', priceCurrency: 'GBP' }] })}</script>`) },
    '/shop/p/bowl': { body: html('Bowl', '<h1>Bowl</h1>', `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Bowl', offers: { '@type': 'AggregateOffer', lowPrice: '30.00', highPrice: '42.00', priceCurrency: 'GBP' } })}</script>`) },
    '/faq': { body: html('FAQ', '<h1>FAQ</h1><h2>Are mugs dishwasher safe?</h2><p>Yes, top rack.</p><h2>Do you take commissions?</h2><p>Twice a year; join the list.</p>') },
    '/returns': { body: html('Returns', '<h1>Returns</h1><p>Return any piece within 30 days for a full refund.</p>') },
  };
}
describe('Squarespace', () => {
  test('?format=json collections (with pagination) + sitemap pages', async () => {
    const s = await site(squarespaceRoutes());
    const { r, error } = await run(s.base);
    assert.ifError(error);
    assert.equal(r.platform, 'squarespace'); assert.equal(r.api, true);
    assert.equal(r.counts.products, 2);
    const prod = fileText(r, /products/);
    assert.match(prod, /## Mug\n\nSource: http:\/\/127\.0\.0\.1:\d+\/shop\/p\/mug\n- Mug price: 18\.00 GBP\n- Mug SKU: mug-1\n- Mug availability: in stock\n- Mug tags: ceramic\n\nMug is handmade\./);
    assert.match(prod, /## Bowl[\s\S]*?- Bowl price: 30\.00 GBP to 42\.00 GBP[\s\S]*?- Bowl variants:\n {2}- Bowl Size: Small: 30\.00 GBP, SKU b-s, out of stock\n {2}- Bowl Size: Large: 42\.00 GBP, SKU b-l, in stock/);
    assert.match(fileText(r, /faq/), /### Are mugs dishwasher safe\?\nYes, top rack\./);
    assert.match(fileText(r, /returns/), /Return any piece within 30 days/);
    assert.equal(s.hits(/^\/shop\/p\//), 0, 'API path: product pages not fetched');
  });
  test('robots.txt disallows ?format=json: never requested; products come from JSON-LD on product pages', async () => {
    const s = await site(squarespaceRoutes({ robots: 'User-agent: *\nDisallow: /*?format=json\nDisallow: /*&format=json\n' }));
    const { r, error } = await run(s.base);
    assert.ifError(error);
    assert.equal(r.platform, 'squarespace'); assert.equal(r.api, false);
    assert.equal(s.hits(/format=json/), 0);
    assert.equal(r.counts.products, 2);
    assert.match(fileText(r, /products/), /## Bowl\n[\s\S]*- Bowl price: 30\.00 GBP to 42\.00 GBP/);
  });
});

// ------------------------------------------------------------------------------------------------ fake WooCommerce
function wooRoutes(n) {
  const all = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Espresso Grinder &#8211; Mk ${i + 1}`, permalink: `BASE/product/grinder-${i + 1}/`, sku: `EG-${i + 1}`,
    prices: { price: '129900', regular_price: '149900', sale_price: '129900', currency_code: 'AUD', currency_minor_unit: 2 }, is_in_stock: true,
    attributes: [{ name: 'Colour', terms: [{ name: 'Black' }, { name: 'Steel' }] }], categories: [{ name: 'Grinders' }], tags: [],
    short_description: '<p>Flat burrs.</p>', description: '<p>64 mm flat burrs, stepless.</p>' }));
  return {
    '/': { body: html('Bean Co', '<h1>Bean Co</h1>', '<link rel="https://api.w.org/" href="/wp-json/"><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">') },
    '/wp-json/wc/store/v1/products': (req, res, { url, base }) => {
      const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page') || 1);
      res.writeHead(200, { 'content-type': 'application/json', 'x-wp-total': String(all.length), 'x-wp-totalpages': String(Math.ceil(all.length / per)) });
      res.end(JSON.stringify(all.slice((page - 1) * per, page * per)).replaceAll('BASE', base));
    },
    '/wp-json/wp/v2/pages': (req, res, { base }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { link: `${base}/faq/`, title: { rendered: 'FAQ' }, content: { rendered: '<h3>How fine can it grind?</h3><p>Fine enough for Turkish coffee.</p><h3>Is there a warranty?</h3><p>Two years.</p>' } },
        { link: `${base}/shipping-returns/`, title: { rendered: 'Shipping &amp; Returns' }, content: { rendered: '<p>Free shipping in Australia over 100 AUD. Returns within 30 days.</p>' } },
        { link: `${base}/gallery/`, title: { rendered: 'Gallery' }, content: { rendered: '<p>Pictures.</p>' } },
      ]));
    },
  };
}
describe('WooCommerce', () => {
  test('Store API products (minor units, pages) + WordPress pages', async () => {
    const s = await site(wooRoutes(3));
    const { r, error } = await run(s.base, { pageSize: 2 });
    assert.ifError(error);
    assert.equal(r.platform, 'woocommerce'); assert.equal(r.api, true);
    assert.equal(r.counts.products, 3);
    assert.equal(s.hits(/\/wc\/store\/v1\/products\?per_page=2&page=\d/), 2);
    const prod = fileText(r, /products/);
    assert.match(prod, /## Espresso Grinder – Mk 1\n\nSource: http:\/\/127\.0\.0\.1:\d+\/product\/grinder-1\/\n- Espresso Grinder – Mk 1 price: 1,299\.00 AUD \(was 1,499\.00 AUD\)\n- Espresso Grinder – Mk 1 SKU: EG-1\n- Espresso Grinder – Mk 1 availability: in stock\n- Espresso Grinder – Mk 1 options: Colour \(Black, Steel\)\n- Espresso Grinder – Mk 1 categories: Grinders\n\nFlat burrs\.\n\n64 mm flat burrs, stepless\./);
    assert.match(fileText(r, /faq/), /### Is there a warranty\?\nTwo years\./);
    assert.match(fileText(r, /shipping-returns/), /## Shipping & Returns\n\nSource: .*\/shipping-returns\/\nFree shipping in Australia/);
    assert.ok(!r.files.some((f) => /gallery/i.test(f.bytes.toString())), 'non-help pages skipped');
  });
});

// ------------------------------------------------------------------------------------------------ generic
function genericRoutes() {
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  return {
    '/robots.txt': { type: 'text/plain', body: (b) => `User-agent: *\nDisallow: /cart\n\nSitemap: ${b}/custom-sitemap.xml\n` },
    '/': { body: (b) => html('Acme Outdoors', `<h1>Acme</h1><a href="${b}/help/faq">FAQ</a>`) },
    '/custom-sitemap.xml': { type: 'application/xml', body: (b) => sitemapIndex([`${b}/sm-pages.xml.gz`, `${b}/sm-products.xml`, `${b}/sm-posts.xml`]) },
    '/sm-pages.xml.gz': { type: 'application/gzip', body: (b) => zlib.gzipSync(sitemap([`${b}/help/faq`, `${b}/shipping-policy`, `${b}/about`, `${b}/blog/hello`, `${b}/cart`])) },
    '/sm-products.xml': { type: 'application/xml', body: (b) => sitemap([`${b}/tent-2p`, `${b}/stove`]) },
    '/tent-2p': { body: html('Tent 2P', '<h1>Tent</h1>', ld({ '@context': 'https://schema.org', '@type': 'ProductGroup', name: '2P Tent', brand: 'Acme', description: '<p>Two-person, 1.4 kg.</p>',
      offers: { '@type': 'Offer', price: '349', priceCurrency: 'CAD', availability: 'https://schema.org/LimitedAvailability' },
      hasVariant: [{ '@type': 'Product', name: '2P Tent Green', sku: 'T2-G', offers: { price: '349', availability: 'https://schema.org/InStock' } }] })) },
    '/stove': { body: html('Stove', '<h1>Stove</h1><p>No structured data here.</p>') },
    '/help/faq': { body: html('Help', '<h1>Help centre</h1>', ld({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [
      { '@type': 'Question', name: 'Do tents come with stakes?', acceptedAnswer: { '@type': 'Answer', text: '<p>Yes, eight aluminium stakes.</p>' } },
      { '@type': 'Question', name: 'Can I pick up in store?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, in Calgary.' } }] })) },
    '/shipping-policy': { body: html('Shipping', '<h1>Shipping policy</h1><style>.x{color:red}</style><script>var leak = "SECRET";</script><p>Ships in 1&ndash;2 days via Canada Post.</p><ul><li>Free over 99 CAD</li><li>Tracking included</li></ul>') },
    '/about': { body: html('About Acme', '<article><h1>About Acme</h1><p>Family-run outfitter in Calgary since 1998, gear tested in the Rockies.</p></article>') },
    '/cart': { body: html('Cart', '<p>should never be requested</p>') },
  };
}
describe('generic site', () => {
  test('robots Sitemap: line, sitemap index + gz child, JSON-LD Product/ProductGroup/FAQPage, readable policy text', async () => {
    const s = await site(genericRoutes());
    const { r, error } = await run(`${s.base}/some/deep/link?utm=1`);
    assert.ifError(error);
    assert.equal(r.platform, 'generic'); assert.equal(r.api, false);
    assert.equal(s.hits(/sm-posts|blog|cart/), 0, 'posts sitemap, blog and robots-disallowed /cart skipped');
    assert.equal(s.hits(/^\/sitemap\.xml/), 0, 'robots Sitemap: line used instead of guessing');
    assert.equal(r.counts.products, 1);
    assert.match(fileText(r, /products/), /## 2P Tent\n\nSource: .*\/tent-2p\n- 2P Tent price: 349\.00 CAD\n- 2P Tent brand: Acme\n- 2P Tent availability: limited availability\n- 2P Tent variants:\n {2}- 2P Tent Green: 349\.00 CAD, SKU T2-G, in stock\n\nTwo-person, 1\.4 kg\./);
    assert.match(fileText(r, /faq/), /## Help centre\n\nSource: .*\/help\/faq\n\n### Do tents come with stakes\?\nYes, eight aluminium stakes\.\n\n### Can I pick up in store\?\nYes, in Calgary\./);
    const pol = fileText(r, /shipping-policy/);
    assert.match(pol, /Ships in 1–2 days via Canada Post\.\n\n- Free over 99 CAD\n- Tracking included/);
    assert.ok(!/SECRET|color:red/.test(pol));
    assert.match(fileText(r, /pages/), /## About Acme\n\nSource: .*\/about\nFamily-run outfitter/);
  });
  test('detectPlatform on a bare site with no API says generic', async () => {
    const s = await site({ '/': { body: html('Plain', '<h1>Plain</h1>') } });
    const f = createStoreFetcher(NET); f.allowSite('127.0.0.1');
    const d = await detectPlatform(s.base, f.fetch);
    assert.equal(d.platform, 'generic'); assert.equal(d.api, false);
    assert.ok(d.signals.length === 0 || d.signals.every((x) => !x.startsWith('api:')));
  });
  test('no products or help pages → no_content', async () => {
    const s = await site({ '/': { body: html('Empty', '<div id="root"></div>') } });
    const { error, events } = await run(s.base);
    assert.equal(error.code, 'no_content');
    assert.deepEqual(events.at(-1), { e: 'error', d: { code: 'no_content', message: error.message } });
  });
  test('time budget: slow pages are cut off, import still finishes and reports capped.time', async () => {
    const routes = { '/': { body: html('Slow', '<h1>Slow</h1>') }, '/sitemap.xml': { type: 'application/xml', body: (b) => sitemap(Array.from({ length: 40 }, (_, i) => `${b}/products/p${i}`)) } };
    for (let i = 0; i < 40; i++) routes[`/products/p${i}`] = { delay: 120, body: html(`P${i}`, '', `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: `Product ${i}`, offers: { price: 1, priceCurrency: 'USD' } })}</script>`) };
    const s = await site(routes);
    const t0 = Date.now();
    const { r, error } = await run(s.base, { net: { ...NET, budgetMs: 700 } });
    assert.ifError(error);
    assert.ok(Date.now() - t0 < 2500, 'finishes near the budget');
    assert.ok(r.counts.products > 0 && r.counts.products < 40);
    assert.equal(r.capped.time, true);
    assert.ok(r.skipped.budget > 0);
    assert.ok(s.maxActive <= 4, `max ${s.maxActive} concurrent`);
  });
});

// ------------------------------------------------------------------------------------------------ SSRF
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
  test('redirect to 127.0.0.1 when only the store address is allowed is refused (checked on every hop)', async () => {
    const inner = await site({ '/': { body: 'internal admin' } });
    const store = await site({ '/': { status: 302, headers: { location: `${inner.base}/` }, body: '' } }, { host: '127.0.0.2' });
    const { error } = await run(store.base, { net: { allowAddresses: ['127.0.0.2'], allowPorts: 'any', paceMs: 0 } });
    assert.equal(error.code, 'blocked_host');
    assert.equal(inner.log.length, 0, 'the internal server was never contacted');
    const store2 = await site({ '/': { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, body: '' } }, { host: '127.0.0.2' });
    assert.equal((await run(store2.base, { net: { allowAddresses: ['127.0.0.2'], allowPorts: 'any', paceMs: 0 } })).error.code, 'blocked_host');
  });
  test('redirect loops stop after 5 hops; off-site URLs are refused after detection', async () => {
    let n = 0;
    const s = await site({ '/': (req, res) => { n++; res.writeHead(302, { location: `/?n=${n}` }); res.end(); } });
    const { error } = await run(s.base);
    assert.equal(error.code, 'too_many_redirects');
    assert.ok(n <= 7);
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    const t = await site({ '/': { body: 'ok' } });
    const port = new URL(t.base).port;
    const f = createStoreFetcher({ ...NET, resolve });
    f.allowSite('shop.test');
    assert.equal((await f.fetch(`http://www.shop.test:${port}/`)).status, 200, 'same registrable domain is fine');
    await assert.rejects(f.fetch(`http://other.test:${port}/`), { code: 'blocked_host' });
    assert.equal(registrableDomain('a.b.shop.co.uk'), 'shop.co.uk');
    assert.equal(registrableDomain('lumen.myshopify.com'), 'lumen.myshopify.com');
  });
});

// ------------------------------------------------------------------------------------------------ robots, timeouts, size
describe('robots.txt', () => {
  test('parser: most specific group, longest match, wildcards and $', () => {
    const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: KnowBotStudio\nUser-agent: other\nDisallow: /private\nAllow: /private/ok$\nDisallow: /*.json$\nDisallow: /*?format=json\n\nSitemap: https://x/sm.xml');
    assert.deepEqual(p.sitemaps, ['https://x/sm.xml']);
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
    const { error } = await run(s.base);
    assert.equal(error.code, 'robots');
    assert.deepEqual(s.log.map((l) => l.url), ['/robots.txt']);
  });
  test('a rule for our UA skips just that page and is counted', async () => {
    const routes = shopifyRoutes(2);
    routes['/robots.txt'] = { type: 'text/plain', body: 'User-agent: *\nAllow: /\n\nUser-agent: KnowBotStudio\nDisallow: /pages/faq\nDisallow: /policies/\n' };
    const s = await site(routes);
    const { r, error } = await run(s.base);
    assert.ifError(error);
    assert.equal(s.hits(/pages\/faq|policies/), 0);
    assert.equal(r.skipped.robots, 5);
    assert.equal(r.counts.faqs, 0);
    assert.equal(r.counts.products, 2);
  });
});
describe('timeouts and size caps', () => {
  test('a hanging request times out', async () => {
    const s = await site({ '/': () => {} });
    const { error } = await run(s.base, { net: { ...NET, timeoutMs: 200 } });
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
    const f = createStoreFetcher({ ...NET, maxBytes: 4096 });
    f.allowSite('127.0.0.1');
    for (const p of ['/cl', '/chunked', '/bomb']) await assert.rejects(f.fetch(`${s.base}${p}`), { code: 'too_large' }, p);
    assert.equal((await f.fetch(`${s.base}/ok`)).text(), 'small');
    const g = createStoreFetcher(NET); g.allowSite('127.0.0.1');
    const r = await g.fetch(`${s.base}/bomb`);
    assert.equal(r.body.length, 3 * 1024 * 1024, 'gzip is decoded under the default 5 MB cap');
  });
  test('abort signal cancels the import', async () => {
    const s = await site({ '/': { delay: 2000, body: 'late' } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const { error } = await run(s.base, { signal: ac.signal });
    assert.equal(error.code, 'aborted');
  });
});

// ------------------------------------------------------------------------------------------------ Markdown shape
describe('Markdown builder', () => {
  test('splits products, keeps a Source line per section, escapes forged headings, dedupes names', () => {
    const docs = [
      ...Array.from({ length: 5 }, (_, i) => ({ kind: 'product', title: `P${i}`, url: `https://s.example/p${i}`, text: `- Price: ${i}.00\n\n# forged heading` })),
      { kind: 'policy', title: 'Refund policy', url: 'https://s.example/policies/refund-policy', text: 'Thirty days.' },
      { kind: 'policy', title: 'Refund Policy', url: 'https://s.example/pages/refunds', text: 'Also thirty days.' },
      { kind: 'faq', title: 'Q1?', url: 'https://s.example/faq', group: 'FAQ', text: 'A1.' },
      { kind: 'page', title: '## About', url: 'https://s.example/about', text: 'We are nice.' },
    ];
    docs[0].text = htmlToText('<p># forged</p><h2>Real</h2><p>ok</p>', { main: false, minLevel: 4 });
    const { files, capped } = buildMarkdownFiles(docs, { slug: 's.example', storeName: 'S', base: 'https://s.example', date: new Date('2026-11-08T00:00:00Z'), perFileProducts: 2 });
    assert.equal(capped, null);
    assert.deepEqual(files.map((f) => f.name), ['s-example-refund-policy.md', 's-example-refund-policy-2.md', 's-example-faq.md', 's-example-pages.md', 's-example-products-1.md', 's-example-products-2.md', 's-example-products-3.md']);
    assert.deepEqual(files.map((f) => f.docs), [1, 1, 1, 1, 2, 2, 1]);
    const p1 = files[4].bytes.toString();
    assert.match(p1, /^# Products: S \(part 1 of 3\)\n\nImported from https:\/\/s\.example on 2026-11-08\./);
    assert.match(p1, /## P0\n\nSource: https:\/\/s\.example\/p0\n\\# forged\n\n#### Real\n\nok\n/);
    assert.match(p1, /## P1\n\nSource: https:\/\/s\.example\/p1\n- Price: 1\.00\n\n# forged heading/, 'builder trusts collector text (collectors escape via htmlToText)');
    assert.match(files[3].bytes.toString(), /\n## About\n\nSource: https:\/\/s\.example\/about\n/);
    for (const f of files) assert.equal(f.mime, 'text/markdown');
  });
  test('docsFromHtml extracts FAQ pairs from question headings and keeps text otherwise', () => {
    const d = docsFromHtml(html('FAQ', '<h2>Shipping</h2><h3>When will it arrive?</h3><p>In 3 days.</p><h3>Can I change my address?</h3><p>Email us.</p>'), 'https://s.example/faq');
    assert.deepEqual(d.map((x) => [x.kind, x.title, x.text]), [['faq', 'When will it arrive?', 'In 3 days.'], ['faq', 'Can I change my address?', 'Email us.']]);
    const p = docsFromHtml(html('Warranty', '<h1>Warranty</h1><p>Frames carry a lifetime warranty for the first owner.</p>'), 'https://s.example/pages/warranty');
    assert.equal(p[0].kind, 'policy');
  });
});

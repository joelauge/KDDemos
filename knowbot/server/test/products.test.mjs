// Product cards: photo capture at import (storeimport.mjs), the product index and photo lookups (products.mjs), the
// text fallback and answer picker (lib/knowbot.js). Fakes only: every site is a loopback server.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { importStore, productDoc, productFacts, readProductHtml, renderMarkdown, imageOf, ogImageOf, productCardOf, productImageOfHtml } from '../storeimport.mjs';
import { indexToJson, indexFromJson, indexAdd, createImageFinder, within, INDEX_MAX } from '../products.mjs';
import { productFromText, productCards, productCard, productKey, linksIn, isSoldOut, safeHttpUrl, candidateLines, PRODUCT_CARDS_MAX } from '../../lib/knowbot.js';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1

const LOOP = async () => [{ address: '127.0.0.1', family: 4 }];
const NET = { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0, resolve: LOOP };
const servers = [];
after(async () => { for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); } });
/** One loopback server: routes { '/path': (req, res, {url, base}) | {status, type, body} }; hits counted per path. */
async function site(routes) {
  const hits = new Map();
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
    const base = `http://${String(req.headers.host)}`;
    const r = routes[u.pathname];
    if (typeof r === 'function') return r(req, res, { url: u, base });
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    const b = typeof r.body === 'function' ? r.body(base, u) : r.body;
    res.writeHead(r.status || 200, { 'content-type': r.type || (typeof b === 'object' ? 'application/json' : 'text/html; charset=utf-8') });
    res.end(typeof b === 'object' ? JSON.stringify(b) : b);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { base: `http://127.0.0.1:${s.address().port}`, hits };
}
const page = (title, main, head = '') => `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${main}</main></body></html>`;

describe('photos at import', () => {
  test('imageOf: strings, ImageObjects and lists; relative and protocol-relative URLs resolve; only http(s), no quotes or spaces', () => {
    assert.equal(imageOf('//cdn.shop.test/a.jpg', 'https://shop.test/p'), 'https://cdn.shop.test/a.jpg');
    assert.equal(imageOf('/img/b.png', 'https://shop.test/products/x'), 'https://shop.test/img/b.png');
    assert.equal(imageOf({ '@type': 'ImageObject', url: 'https://c.test/1.jpg' }), 'https://c.test/1.jpg');
    assert.equal(imageOf([{ contentUrl: 'javascript:alert(1)' }, { src: 'https://c.test/2.jpg' }]), 'https://c.test/2.jpg');
    assert.equal(imageOf('data:image/png;base64,AAAA'), null);
    assert.equal(imageOf('https://c.test/a b.jpg'), 'https://c.test/a%20b.jpg', 'a space is encoded by URL, never kept raw');
    assert.equal(imageOf('https://user:pw@c.test/x.jpg'), null);
    assert.equal(imageOf(null), null);
    assert.equal(ogImageOf('<meta content="/og.jpg" property="og:image">', 'https://s.test/p/a'), 'https://s.test/og.jpg');
    assert.equal(ogImageOf('<meta name="twitter:image" content="https://s.test/t.jpg">', 'https://s.test/'), 'https://s.test/t.jpg');
    assert.equal(ogImageOf('<p>none</p>', 'https://s.test/'), null);
  });

  test('the photo is a fact line of the page (never quoted: candidate lines drop it) and the record keeps it', () => {
    const p = { title: 'Trail Pro', url: 'https://shop.test/products/trail-pro', price: 1899, compareAt: 2099, currency: 'USD', availability: 'in stock', image: { src: 'https://cdn.shop.test/t.jpg' } };
    const facts = productFacts(p);
    assert.match(facts, /^- Trail Pro image: https:\/\/cdn\.shop\.test\/t\.jpg$/m);
    const md = renderMarkdown(productDoc(p));
    const lines = candidateLines([{ title: 'Trail Pro', text: md }]).map((l) => l.text);
    assert.ok(lines.some((l) => /price: 1,899\.00 USD \(was 2,099\.00 USD\)/.test(l)), lines.join(' | '));
    assert.ok(!lines.some((l) => /image|cdn\.shop/.test(l)), `the photo line is never a candidate line: ${lines.join(' | ')}`);
    assert.deepEqual(productCardOf(p), { url: p.url, title: 'Trail Pro', price: 1899, compareAt: 2099, currency: 'USD', availability: 'in stock', image: 'https://cdn.shop.test/t.jpg' });
    // every option out of stock reads "out of stock"; a compare-at price at or below the price is no sale
    assert.equal(productCardOf({ ...p, compareAt: 1899, variants: [{ title: 'S', available: false }, { title: 'L', available: false }] }).availability, 'out of stock');
    assert.equal(productCardOf({ ...p, compareAt: 1899 }).compareAt, null);
  });

  test('a product page: JSON-LD image first, else og:image (also on top of a feed record without a photo)', () => {
    const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Toad Vault', image: ['/media/toad.jpg'], offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } };
    const html = page('Toad Vault', '<p>A walnut dice vault with a magnetic lid that clicks shut.</p>', `<script type="application/ld+json">${JSON.stringify(ld)}</script><meta property="og:image" content="https://shop.test/og.jpg">`);
    const doc = readProductHtml(html, 'https://shop.test/products/toad-vault');
    assert.equal(doc.record.image, 'https://shop.test/media/toad.jpg');
    assert.match(renderMarkdown(doc), /- Toad Vault image: https:\/\/shop\.test\/media\/toad\.jpg/);
    const og = readProductHtml(page('Plain', '<p>Plain page with a photo in its head only.</p>', '<meta property="og:image" content="https://shop.test/og.jpg">'), 'https://shop.test/products/plain',
      { title: 'Plain', url: 'https://shop.test/products/plain', price: 10, currency: 'USD' });
    assert.equal(og.record.image, 'https://shop.test/og.jpg');
    assert.equal(productImageOfHtml(html, 'https://shop.test/products/toad-vault'), 'https://shop.test/media/toad.jpg');
  });

  test('feeds: a products.json store (featured image, else images[0]) and a Store API store (images[0].src) carry the card on every product file', async () => {
    const shop = await site({
      '/': { body: page('Lumen', '<p>Bikes.</p>', '<link href="https://cdn.shopify.com/s/theme.css"><script>Shopify.currency={"active":"USD"};</script>') },
      '/products.json': (req, res, { url, base }) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ products: Number(url.searchParams.get('page') || 1) > 1 ? [] : [
          { id: 1, title: 'Trail Pro', handle: 'trail-pro', body_html: '<p>Carbon trail bike.</p>', image: { src: '//cdn.shop.test/files/trail-pro.jpg' }, images: [{ src: 'https://cdn.shop.test/other.jpg' }],
            variants: [{ title: 'Default Title', price: '1899.00', compare_at_price: '2099.00', available: true }] },
          { id: 2, title: 'Gravel X', handle: 'gravel-x', body_html: '<p>Steel gravel bike.</p>', images: [{ src: `${base}/img/gravel.jpg` }], variants: [{ title: 'Default Title', price: '1299.00', available: false }] },
          { id: 3, title: 'No Photo', handle: 'no-photo', body_html: '<p>Nothing to see.</p>', images: [], variants: [{ title: 'Default Title', price: '5.00', available: true }] },
        ] }));
      },
    });
    const r = await importStore(shop.base, { net: NET, enrich: 'none' });
    assert.equal(r.platform, 'shopify');
    const cards = Object.fromEntries(r.files.filter((f) => f.kind === 'product').map((f) => [f.title, f.card]));
    assert.deepEqual(cards['Trail Pro'], { url: `${shop.base}/products/trail-pro`, title: 'Trail Pro', price: 1899, compareAt: 2099, currency: 'USD', availability: 'in stock', image: 'https://cdn.shop.test/files/trail-pro.jpg' });
    assert.equal(cards['Gravel X'].image, `${shop.base}/img/gravel.jpg`);
    assert.equal(cards['Gravel X'].availability, 'out of stock');
    assert.equal(cards['No Photo'].image, null);

    const woo = await site({
      '/': { body: page('Wyrm', '<p>Vaults.</p>', '<link rel="stylesheet" href="/wp-content/plugins/woocommerce/style.css">') },
      '/wp-json/wc/store/v1/products': (req, res, { base }) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1' });
        res.end(JSON.stringify([{ id: 1, name: 'Toad &amp; Vault', permalink: `${base}/product/toad-vault/`, prices: { price: '4999', regular_price: '5999', currency_code: 'USD', currency_minor_unit: 2 },
          is_in_stock: true, description: '<p>A walnut dice vault.</p>', images: [{ id: 9, src: `${base}/wp-content/uploads/toad.jpg`, thumbnail: `${base}/wp-content/uploads/toad-300.jpg` }] }]));
      },
    });
    const w = await importStore(woo.base, { net: NET, enrich: 'none' });
    assert.equal(w.platform, 'woocommerce');
    const card = w.files.find((f) => f.kind === 'product').card;
    assert.deepEqual(card, { url: `${woo.base}/product/toad-vault/`, title: 'Toad & Vault', price: 49.99, compareAt: 59.99, currency: 'USD', availability: 'in stock', image: `${woo.base}/wp-content/uploads/toad.jpg` });
  });
});

describe('the product index', () => {
  test('round trip; rows that are not http(s) or have no title are dropped; keys ignore query, hash, case and a trailing slash', () => {
    const idx = new Map();
    assert.ok(indexAdd(idx, { url: 'https://Shop.test/products/Trail-Pro/?variant=1', title: 'Trail Pro', price: '1,899.00', currency: 'USD', availability: 'in stock', image: 'https://cdn.test/t.jpg' }));
    assert.equal(indexAdd(idx, { url: 'javascript:alert(1)', title: 'Bad' }), null);
    assert.equal(indexAdd(idx, { url: 'https://shop.test/x', title: '' }), null);
    assert.equal(productKey('https://www.shop.test/products/trail-pro#top'), 'shop.test/products/trail-pro');
    const back = indexFromJson(indexToJson(idx));
    assert.equal(back.size, 1);
    assert.deepEqual(back.get('shop.test/products/trail-pro'), { url: 'https://shop.test/products/Trail-Pro/?variant=1', title: 'Trail Pro', price: 1899, compareAt: null, currency: 'USD', availability: 'in stock', image: 'https://cdn.test/t.jpg' });
    const forged = indexFromJson(JSON.stringify({ v: 1, items: [['https://s.test/p', '<img src=x onerror=alert(1)>Name', 5, null, 'usd', null, 'javascript:x'], 'junk', ['ftp://s.test/q', 'Q']] }));
    assert.equal(forged.size, 1);
    const c = [...forged.values()][0];
    assert.equal(c.title, 'Name', 'tags are stripped from titles');
    assert.equal(c.currency, null);
    assert.equal(c.image, null);
    assert.deepEqual(indexFromJson('not json'), new Map());
    assert.ok(INDEX_MAX >= 10000);
  });
});

describe('cards from page text (the fallback for corpora without an index)', () => {
  const md = '# Trail Pro · https://shop.test/products/trail-pro\n\nSource: https://shop.test/products/trail-pro\n\n## Price and availability\n\n- Trail Pro price: 1,899.00 USD (was 2,099.00 USD) to 2,299.00 USD\n- Trail Pro availability: only some options in stock (Small)\n- Trail Pro SKU: TP-1\n';
  test('head, price, compare-at, availability; a breadcrumb-prefixed atom too; no price line and no photo is not a product', () => {
    assert.deepEqual(productFromText(md), { url: 'https://shop.test/products/trail-pro', title: 'Trail Pro', price: 1899, compareAt: 2099, currency: 'USD', availability: 'only some options in stock (Small)', image: null });
    const atom = 'Trail Pro · https://shop.test/products/trail-pro > Price and availability\n- Trail Pro price: 649.00 EUR\n- Trail Pro availability: out of stock';
    const c = productFromText(atom);
    assert.equal(c.title, 'Trail Pro'); assert.equal(c.price, 649); assert.equal(c.currency, 'EUR'); assert.ok(isSoldOut(c.availability));
    assert.equal(productFromText('# Refund policy · https://shop.test/policies/refund\n\nReturns within 30 days.'), null);
    assert.equal(productFromText('- Thing price: 5.00 USD'), null, 'no URL: no card');
    assert.equal(productFromText('- Thing price: 5.00 USD', { url: 'https://s.test/p/thing', title: 'Thing' }).price, 5);
    assert.equal(isSoldOut('only some options in stock (S)'), false);
    assert.equal(isSoldOut('Sold out'), true);
    assert.equal(safeHttpUrl('https://s.test/"onmouseover=x'), null);
  });

  test('productCards: links in the text first, then citations; one card per product; at most 4; non-products and unsafe URLs skipped', () => {
    const src = (slug, price) => ({ url: `https://shop.test/products/${slug}`, text: `# ${slug} · https://shop.test/products/${slug}\n- ${slug} price: ${price} USD` });
    const sources = ['a', 'b', 'c', 'd', 'e'].map((x, i) => src(x, `${i + 1}0.00`));
    const out = productCards({ text: 'See [e](https://shop.test/products/e?variant=2) and https://shop.test/products/e. Also javascript:alert(1)', sources,
      citations: [{ n: 2, url: 'https://shop.test/products/b' }, { n: 1, url: 'https://shop.test/products/a' }, { n: 3, url: 'https://shop.test/policies/refund' }, { n: 4, url: 'https://shop.test/products/c' }, { n: 5, url: 'https://shop.test/products/d' }] });
    assert.deepEqual(out.map((c) => c.title), ['e', 'a', 'b', 'c']);
    assert.equal(out.length, PRODUCT_CARDS_MAX);
    // the index wins over the text, and knows products the sources don't carry
    const idx = new Map([[productKey('https://shop.test/products/z'), productCard({ url: 'https://shop.test/products/z', title: 'Zed', price: 1, image: 'https://cdn.test/z.jpg' })]]);
    const got = productCards({ text: 'Try https://shop.test/products/z', lookup: (u, k) => idx.get(k) });
    assert.deepEqual(got, [{ url: 'https://shop.test/products/z', title: 'Zed', price: 1, compareAt: null, currency: null, availability: null, image: 'https://cdn.test/z.jpg' }]);
    assert.deepEqual(productCards({ text: 'nothing here' }), []);
    assert.deepEqual(linksIn('[x](https://a.test/p). https://b.test/q, (https://c.test/r)'), ['https://a.test/p', 'https://b.test/q', 'https://c.test/r']);
  });
});

describe('web chat cards (lib/widget.js)', () => {
  test('escaped titles, http(s) links and photos only, lazy photos with a size, compare-at struck, out of stock chip only when it is', async () => {
    const { productCardsHtml } = await import('../../lib/widget.js');
    const html = productCardsHtml([
      { url: 'https://s.test/products/x?a=1&b=2', title: '<img src=x onerror=alert(1)> & "Y"', price: 10, compareAt: 12, currency: 'USD', availability: 'Sold out', image: 'javascript:alert(1)' },
      { url: 'https://s.test/products/q', title: 'Q', price: 5.5, currency: 'EUR', availability: 'in stock', image: 'https://c.test/q.jpg' },
      { url: 'javascript:alert(1)', title: 'Bad' },
      { url: 'https://s.test/p/1', title: 'One' }, { url: 'https://s.test/p/2', title: 'Two' }, { url: 'https://s.test/p/3', title: 'Three' },
    ]);
    assert.doesNotMatch(html, /<img src=x|javascript:/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Y&quot;/);
    assert.match(html, /href="https:\/\/s\.test\/products\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /<s>\$12<\/s>/);
    assert.equal((html.match(/kb-prod-chip/g) || []).length, 1, 'only the sold-out product has a chip');
    assert.match(html, /<img src="https:\/\/c\.test\/q\.jpg" alt="Q" width="144" height="108" loading="lazy"/);
    assert.equal((html.match(/<li>/g) || []).length, 4, 'at most 4 cards; unsafe links are skipped');
    assert.doesNotMatch(html, /shopify|woocommerce|magento|squarespace|wix/i, 'no vendor names');
    assert.equal(productCardsHtml([]), '');
  });
});

describe('photo lookups (og:image) through the import fetcher', () => {
  test('finds the page photo, caches it (one request), refuses off-site and private addresses, never waits past its timeout', async () => {
    const s = await site({
      '/products/a': { body: page('A', '<p>A</p>', '<meta property="og:image" content="/img/a.jpg">') },
      '/products/b': { body: page('B', '<p>B</p>') },
      '/products/slow': (req, res) => { setTimeout(() => { try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('S', '<p>S</p>', '<meta property="og:image" content="/s.jpg">')); } catch {} }, 1500); },
    });
    const f = createImageFinder({ net: NET, timeoutMs: 400 });
    assert.equal(await f.find(`${s.base}/products/a`), `${s.base}/img/a.jpg`);
    assert.equal(await f.find(`${s.base}/products/a?variant=3`), `${s.base}/img/a.jpg`);
    assert.equal(s.hits.get('/products/a'), 1, 'cached');
    assert.equal(f.peek(`${s.base}/products/a`), `${s.base}/img/a.jpg`);
    assert.equal(await f.find(`${s.base}/products/b`), null);
    const t0 = Date.now();
    assert.equal(await f.find(`${s.base}/products/slow`), null);
    assert.ok(Date.now() - t0 < 1400, 'the fetch timed out');
    // production options (no loopback allowance): a private address is refused before any request
    const prod = createImageFinder({ timeoutMs: 400 });
    const before = s.hits.get('/products/a');
    assert.equal(await prod.find(`${s.base}/products/a`), null);
    assert.equal(s.hits.get('/products/a'), before);
    assert.equal(await within(new Promise(() => {}), 20), null, 'within() gives up');
  });
});

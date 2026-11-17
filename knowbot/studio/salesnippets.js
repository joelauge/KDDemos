// Sale tracking: the code an owner pastes when their order page is somewhere the KnowBot website line cannot run, and
// the words Stats uses for how an order was noticed. Pure text builders (no DOM), so server/test/sale-detect.test.mjs
// runs the Shopify pixel exactly as an owner would paste it.
//
// Why Shopify needs a paste at all (checked in Shopify's docs, 2026-11): Shopify's checkout, Thank you and Order status
// pages do not run theme code or script tags any more (checkout.liquid and "Additional scripts" were sunset on
// 2025-08-28; script tags on those pages on 2025-08-28 for Plus stores and 2026-08-26 for all others; stores that had
// not upgraded were upgraded automatically). The only code a merchant can run there without an app is a custom pixel
// (Settings > Customer events), in a sandboxed frame with no access to the page. It gets the order from the
// `checkout_completed` event, and the click id from the order's own cart attribute (site/sale.js writes `kb_cid` into
// the cart on the storefront) or, failing that, from the storefront's localStorage through `browser.localStorage`.

/** How an order was noticed, in the owner's words (Stats names no platform outside its help). Keep in step with SALE_VIA_TEXT in server/leads.mjs (the CSV). */
export const SALE_VIA_LABEL = Object.freeze({
  snippet: 'Reported by your snippet',
  event: 'From your store’s purchase event',
  page: 'Seen on your order page',
  pixel: 'Reported by your store’s pixel',
});
/** The same, as the end of a sentence ("Detected on your site: …"). */
export const SALE_VIA_HOW = Object.freeze({
  snippet: 'your snippet reported an order page',
  event: 'your store’s purchase event was read on your order page',
  page: 'your order page was read',
  pixel: 'your Shopify pixel reported an order',
});

/** The Shopify custom pixel (Settings > Customer events > Add custom pixel). `saleUrl` is POST …/v1/bots/<bot>/sale. */
export function shopifyPixel(saleUrl) {
  return `// KnowBot sale tracking. Shopify admin > Settings > Customer events > Add custom pixel
analytics.subscribe('checkout_completed', async (event) => {
  try {
    const c = event.data.checkout;
    const id = (v) => (typeof v === 'string' && /^[a-z0-9]{6,20}$/.test(v) ? v : '');
    // which answer the buyer clicked: first from the order itself (the cart attribute your KnowBot line wrote),
    // then from this browser's storage on your shop
    let cid = id(((c.attributes || []).find((a) => a && a.key === 'kb_cid') || {}).value);
    if (!cid) { try { cid = id(await browser.localStorage.getItem('kb_cid')); } catch (e) {} }
    const order = String((c.order && c.order.id) || c.token || '').split('/').pop();
    const total = c.totalPrice && c.totalPrice.amount;
    let body = { ping: true, via: 'pixel' };
    if (cid && order && total != null && c.currencyCode) {
      // the order id, total, currency and item names. Never the buyer's name, email or address.
      body = { cid, order, total, currency: c.currencyCode, via: 'pixel',
        items: (c.lineItems || []).slice(0, 20).map((i) => ({ title: String(i.title || '').slice(0, 80), quantity: i.quantity })) };
    } else {
      // not an order from your bot: only "the pixel works", once a day
      const day = new Date().toISOString().slice(0, 10);
      try {
        if ((await browser.localStorage.getItem('kb_sale_seen')) === day) return;
        await browser.localStorage.setItem('kb_sale_seen', day);
      } catch (e) {}
    }
    fetch('${saleUrl}', { method: 'POST', keepalive: true, body: JSON.stringify(body) });
  } catch (e) {}
});`;
}

/** WooCommerce: a hook for stores whose order page could not be read for certain (it prints exact values). */
export function wooHook({ bot, siteBase, apiAttr = '' }) {
  return `// WooCommerce: add to your theme's functions.php (or a code snippets plugin)
add_action('woocommerce_thankyou', function ($order_id) {
  $order = wc_get_order($order_id);
  if (!$order) return;
  printf('<script async src="%s"${apiAttr} data-bot="%s" data-order="%s" data-total="%s" data-currency="%s"></script>',
    esc_url('${siteBase}site/sale.js'), esc_attr('${bot}'), esc_attr($order->get_order_number()),
    esc_attr($order->get_total()), esc_attr($order->get_currency()));
});`;
}

/** Any other site: one line on the page a customer sees after paying. */
export function anySiteLine({ bot, siteBase, apiAttr = '' }) {
  return `<!-- On your order confirmation ("thank you") page. Replace the three values with the order's own. -->
<script async src="${siteBase}site/sale.js"${apiAttr} data-bot="${bot}"
        data-order="ORDER_ID" data-total="ORDER_TOTAL" data-currency="USD"></script>`;
}

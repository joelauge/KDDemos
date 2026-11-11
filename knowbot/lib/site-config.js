// Where each public host finds its KnowBot API (the Cloudflare Worker in cloudflare/).
// Set the workers.dev URL printed by `wrangler deploy` (or a custom API domain) here.
export const HOSTED_APIS = {
  'knowbot.knowdrive.ai': 'https://knowbot-api.joelauge.workers.dev',
};
export const hostedApi = () => {
  try { return (HOSTED_APIS[location.hostname] || '').replace(/\/+$/, '') || null; } catch { return null; }
};
/** The API that serves an embed script loaded from this host (embed.js on a customer's page), or null. */
export const apiForScriptHost = (host) => (HOSTED_APIS[String(host || '')] || '').replace(/\/+$/, '') || null;

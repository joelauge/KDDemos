// Where each public host finds its KnowBot API (the Cloudflare Worker in cloudflare/).
// Set the workers.dev URL printed by `wrangler deploy` (or a custom API domain) here.
export const HOSTED_APIS = {
  'knowbot.knowdrive.ai': 'https://knowbot-api.joelauge.workers.dev',
};
export const hostedApi = () => {
  try { return (HOSTED_APIS[location.hostname] || '').replace(/\/+$/, '') || null; } catch { return null; }
};

// Where each public host finds its KnowBot API (the Cloudflare Worker in cloudflare/).
// The API's public domain (agent.knowbot.app, a custom domain on the Worker; its workers.dev URL keeps working for older embeds).
export const HOSTED_APIS = {
  'knowbot.knowdrive.ai': 'https://agent.knowbot.app',
};
export const hostedApi = () => {
  try { return (HOSTED_APIS[location.hostname] || '').replace(/\/+$/, '') || null; } catch { return null; }
};
/** The API that serves an embed script loaded from this host (embed.js on a customer's page), or null. */
export const apiForScriptHost = (host) => (HOSTED_APIS[String(host || '')] || '').replace(/\/+$/, '') || null;

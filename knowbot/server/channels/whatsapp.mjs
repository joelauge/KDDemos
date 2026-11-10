// WhatsApp (SPEC 11.3), two providers on one URL: /v1/channels/:botId/whatsapp
//
//   Meta WhatsApp Business Cloud API
//     GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   verify-token handshake (WHATSAPP_VERIFY_TOKEN)
//     POST JSON webhook, X-Hub-Signature-256 checked with WHATSAPP_APP_SECRET; acknowledged at once, then each text
//          message is answered through the Graph API (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID).
//   Twilio WhatsApp
//     POST form-encoded (From=whatsapp:+…), X-Twilio-Signature checked with TWILIO_AUTH_TOKEN; TwiML <Message> reply.
//
// Replies carry [n] markers and numbered source footnotes plus the proof link. Without config: 503.
import { ChannelError, notConfigured, parseForm, twilioValid, metaValid, sendXml, sendJsonRes, xml, formatWhatsApp } from './util.mjs';

const metaReady = (env) => !!(env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
const META_NEEDS = ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];

/** Sends one text message through the Graph API. */
export async function sendWhatsApp(env, to, body) {
  const base = String(env.META_GRAPH_BASE_URL || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
  const res = await fetch(`${base}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Graph API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

export async function handleWhatsApp(cx) {
  const { env, req, res, raw, url } = cx;
  const ct = String(req.headers['content-type'] || '');

  // Meta verification handshake
  if (req.method === 'GET') {
    if (!metaReady(env)) throw notConfigured('WhatsApp', META_NEEDS);
    const mode = url.searchParams.get('hub.mode'), token = url.searchParams.get('hub.verify_token'), challenge = url.searchParams.get('hub.challenge') || '';
    if (mode !== 'subscribe' || token !== env.WHATSAPP_VERIFY_TOKEN) throw new ChannelError(403, 'bad_verify_token', 'The verify token does not match WHATSAPP_VERIFY_TOKEN.');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(challenge.slice(0, 200));
  }
  if (req.method !== 'POST') throw new ChannelError(405, 'method_not_allowed', 'WhatsApp posts messages to this URL.');
  if (!metaReady(env) && !env.TWILIO_AUTH_TOKEN) {
    throw new ChannelError(503, 'channel_not_configured', `The WhatsApp channel is not configured on this server. Set ${META_NEEDS.join(', ')} (Meta Cloud API), or TWILIO_AUTH_TOKEN (Twilio WhatsApp).`);
  }

  // Twilio WhatsApp (form-encoded)
  if (/application\/x-www-form-urlencoded|multipart\//i.test(ct)) {
    if (!env.TWILIO_AUTH_TOKEN) throw notConfigured('WhatsApp (Twilio)', ['TWILIO_AUTH_TOKEN']);
    const params = await parseForm(raw, ct);
    if (!twilioValid(req, env.TWILIO_AUTH_TOKEN, params, env)) throw new ChannelError(403, 'bad_signature', 'X-Twilio-Signature did not verify.');
    const from = String(params.From || '').replace(/^whatsapp:/, '');
    const body = String(params.Body || '').trim();
    if (!body) return sendXml(res, `<Message>${xml('Send me a question and I will answer from my files, with sources.')}</Message>`);
    if (cx.limited(`whatsapp|${from}`)) return sendXml(res, `<Message>${xml('You are sending questions very quickly. Try again in a minute.')}</Message>`);
    const si = await cx.sendInfo?.(body, { channel: 'whatsapp', callerKey: from });
    if (si) return sendXml(res, `<Message>${xml(si.reply)}</Message>`);
    const r = await cx.ask(body, { channel: 'whatsapp', callerKey: from });
    return sendXml(res, `<Message>${xml(formatWhatsApp(r, r.refused ? null : r.proofUrl))}</Message>`);
  }

  // Meta Cloud API (JSON)
  if (!metaReady(env)) throw notConfigured('WhatsApp', META_NEEDS);
  if (!metaValid(req, env.WHATSAPP_APP_SECRET, raw)) throw new ChannelError(403, 'bad_signature', 'X-Hub-Signature-256 did not verify.');
  let payload;
  try { payload = JSON.parse(Buffer.from(raw).toString('utf8') || '{}'); } catch { throw new ChannelError(400, 'bad_request', 'invalid JSON'); }
  const msgs = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value || {};
      if (v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(env.WHATSAPP_PHONE_NUMBER_ID)) continue;
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const text = m?.type === 'text' ? m.text?.body : m?.type === 'button' ? m.button?.text : m?.type === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title) : null;
        if (m?.from) msgs.push({ from: String(m.from), text: String(text || '').trim(), type: m.type });
      }
    }
  }
  // Meta wants a fast 200; answers go out through the Graph API.
  sendJsonRes(res, 200, { ok: true, received: msgs.length });
  for (const m of msgs.slice(0, 10)) {
    cx.background((async () => {
      let body;
      if (!m.text) body = 'I can answer text questions. Send me one and I will reply with sources.';
      else if (cx.limited(`whatsapp|${m.from}`)) body = 'You are sending questions very quickly. Try again in a minute.';
      else {
        // "can you email me that?": the send-info flow answers instead (server/sendinfo.mjs)
        const si = await cx.sendInfo?.(m.text.slice(0, 1000), { channel: 'whatsapp', callerKey: m.from });
        if (si) body = si.reply;
        else { const r = await cx.ask(m.text.slice(0, 1000), { channel: 'whatsapp', callerKey: m.from }); body = formatWhatsApp(r, r.refused ? null : r.proofUrl); }
      }
      await sendWhatsApp(env, m.from, body);
    })().catch((e) => cx.log(`[channels] whatsapp reply failed: ${e.message}`)));
  }
}

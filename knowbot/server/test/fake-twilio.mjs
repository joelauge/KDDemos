// A stand-in for the phone number provider (Twilio REST) for tests and the local dev server: number search, purchase,
// update, release, pricing, and the Messages / Calls sends the phone channel makes. Loopback only; deterministic.
//
//   GET    /2010-04-01/Accounts/:sid/AvailablePhoneNumbers/:cc/Local.json?AreaCode=&InLocality=&InRegion=&PageSize=
//   POST   /2010-04-01/Accounts/:sid/IncomingPhoneNumbers.json        (PhoneNumber, SmsUrl, VoiceUrl, FriendlyName, …)
//   GET    /2010-04-01/Accounts/:sid/IncomingPhoneNumbers.json?FriendlyName=
//   POST   /2010-04-01/Accounts/:sid/IncomingPhoneNumbers/:PN.json     (update)
//   DELETE /2010-04-01/Accounts/:sid/IncomingPhoneNumbers/:PN.json     (release)
//   POST   /2010-04-01/Accounts/:sid/Messages.json | /Calls/:CA.json   (recorded in `sent`)
//   GET    /v1/PhoneNumbers/Countries/:cc · /v1/Voice/Countries/:cc · /v1/Messaging/Countries/:cc   (pricing)
//
// Test knobs: take(phone) makes a listed number fail to buy (taken meanwhile), takeArea(area) takes every number in an
// area code, prices = {monthly, minute, text} (or pricingDown = true for 500s), owned (Map by PN sid), requests (log).
import http from 'node:http';

const CITIES = { 415: ['San Francisco', 'CA'], 212: ['New York', 'NY'], 312: ['Chicago', 'IL'], 604: ['Vancouver', 'BC'], 416: ['Toronto', 'ON'], 512: ['Austin', 'TX'] };

export async function startFakeTwilio({ host = '127.0.0.1', prices = { monthly: '1.15', minute: '0.0085', text: '0.0079', textIn: '0.0083' } } = {}) {
  const owned = new Map();
  const taken = new Set();
  const takenAreas = new Set();
  const sent = [];
  const requests = [];
  let seq = 0;
  const state = { prices, pricingDown: false };
  const listFor = (cc, area, city) => {
    const areas = area ? [area] : Object.entries(CITIES).filter(([, [c]]) => !city || c.toLowerCase() === String(city).toLowerCase()).map(([a]) => a);
    const out = [];
    for (const a of areas) {
      const [loc, reg] = CITIES[a] || ['Springfield', cc === 'CA' ? 'ON' : 'IL'];
      for (let i = 0; i < 6; i++) {
        const phone = `+1${a}555${String(100 + i * 11).padStart(4, '0')}`;
        if ([...owned.values()].some((n) => n.phone_number === phone) || taken.has(phone) || takenAreas.has(a)) continue;
        out.push({ friendly_name: `(${a}) 555-${phone.slice(-4)}`, phone_number: phone, locality: loc, region: reg, postal_code: '00000', iso_country: cc, capabilities: { voice: true, SMS: true, MMS: true } });
      }
    }
    return out;
  };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), form, auth: !!req.headers.authorization });
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 204 ? '' : JSON.stringify(body)); };
      if (!/^Basic /.test(String(req.headers.authorization || ''))) return send(401, { code: 20003, message: 'Authenticate' });
      let m;
      if ((m = /^\/v1\/(PhoneNumbers|Voice|Messaging)\/Countries\/([A-Z]{2})$/.exec(u.pathname))) {
        if (state.pricingDown) return send(500, { message: 'pricing down' });
        const p = state.prices;
        if (m[1] === 'PhoneNumbers') return send(200, { country: m[2], iso_country: m[2], price_unit: 'USD', phone_number_prices: [{ number_type: 'local', base_price: p.monthly, current_price: p.monthly }, { number_type: 'toll free', base_price: '2.15', current_price: '2.15' }] });
        if (m[1] === 'Voice') return send(200, { country: m[2], iso_country: m[2], price_unit: 'USD', inbound_call_prices: [{ number_type: 'local', base_price: p.minute, current_price: p.minute }, { number_type: 'toll free', base_price: '0.022', current_price: '0.022' }],
          outbound_prefix_prices: [{ prefixes: ['1'], friendly_name: 'Local', base_price: '0.014', current_price: '0.014' }] });
        return send(200, { country: m[2], iso_country: m[2], price_unit: 'USD',
          inbound_sms_prices: [{ number_type: 'local', base_price: p.textIn || p.text, current_price: p.textIn || p.text }],
          outbound_sms_prices: [{ carrier: 'Carrier A', mcc: '310', mnc: '1', prices: [{ number_type: 'local', base_price: p.text, current_price: p.text }] }, { carrier: 'Carrier B', mcc: '310', mnc: '2', prices: [{ number_type: 'local', base_price: '0.0075', current_price: '0.0075' }] }] });
      }
      if (!(m = /^\/2010-04-01\/Accounts\/([^/]+)(\/.*)$/.exec(u.pathname))) return send(404, { message: 'not found' });
      const rest = m[2];
      if ((m = /^\/AvailablePhoneNumbers\/([A-Z]{2})\/Local\.json$/.exec(rest)) && req.method === 'GET') {
        const list = listFor(m[1], u.searchParams.get('AreaCode'), u.searchParams.get('InLocality'));
        return send(200, { available_phone_numbers: list.slice(0, Number(u.searchParams.get('PageSize') || 20)), uri: u.pathname });
      }
      if (rest === '/IncomingPhoneNumbers.json' && req.method === 'POST') {
        const phone = form.PhoneNumber;
        const area = /^\+1(\d{3})/.exec(phone || '')?.[1];
        if (!phone || taken.has(phone) || takenAreas.has(area) || [...owned.values()].some((n) => n.phone_number === phone)) return send(400, { code: 21422, message: 'PhoneNumber requested is not available', status: 400 });
        const sid = `PN${String(++seq).padStart(32, '0')}`;
        const n = { sid, phone_number: phone, friendly_name: form.FriendlyName || phone, sms_url: form.SmsUrl, sms_method: form.SmsMethod, voice_url: form.VoiceUrl, voice_method: form.VoiceMethod };
        owned.set(sid, n);
        return send(201, n);
      }
      if (rest === '/IncomingPhoneNumbers.json' && req.method === 'GET') {
        const fn = u.searchParams.get('FriendlyName');
        return send(200, { incoming_phone_numbers: [...owned.values()].filter((n) => !fn || n.friendly_name === fn) });
      }
      if ((m = /^\/IncomingPhoneNumbers\/(PN\w+)\.json$/.exec(rest))) {
        const n = owned.get(m[1]);
        if (!n) return send(404, { code: 20404, message: 'not found' });
        if (req.method === 'DELETE') { owned.delete(m[1]); return send(204, null); }
        if (form.SmsUrl) n.sms_url = form.SmsUrl;
        if (form.VoiceUrl) n.voice_url = form.VoiceUrl;
        return send(200, n);
      }
      if (rest === '/Messages.json' || /^\/Calls\//.test(rest)) { sent.push({ path: rest, form }); return send(201, { sid: `SM${seq++}`, ...form }); }
      return send(404, { message: 'not found' });
    });
  });
  await new Promise((r) => srv.listen(0, host, r));
  const url = `http://${host}:${srv.address().port}`;
  return {
    url, owned, sent, requests, state,
    take: (phone) => taken.add(phone),
    takeArea: (area) => takenAreas.add(String(area)),
    reset() { owned.clear(); taken.clear(); takenAreas.clear(); sent.length = 0; requests.length = 0; },
    purchases: () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/IncomingPhoneNumbers.json')),
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

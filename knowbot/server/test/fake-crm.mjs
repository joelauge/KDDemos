// A fake of everything the CRM connectors talk to (server/crm), on one local HTTP server. Tests only.
//
//   /hook/<anything>     a webhook / REST hook receiver: records the request, answers 200 (or what failNext says)
//   /hubspot/…           CRM v3 contacts search / create / update, notes, account-info, OAuth v3 token
//   /sf/…                Salesforce OAuth token + userinfo, SOQL query, sObjects Lead / Task / Note, external-id upsert
//   /pd/…                Pipedrive users/me, persons search + create (v2), leads + notes (v1), deals (v2), OAuth token
//   /zoho/…              Zoho OAuth token, Leads search / upsert / update, Leads/{id}/Notes
//   /mc/…                Mailchimp OAuth token + metadata, lists, members (PUT), member tags and notes
//   /cc/…                Constant Contact OAuth token, contact_lists, contacts (find, create, sign_up_form), add_list_memberships
//
// Access tokens: `valid` is the set every vendor accepts. OAuth: code 'code-ok' → ATOK_1 / RTOK_1; a refresh mints ATOK_N.
// failNext(/regex on "METHOD path"/, { status, headers, body, times }) makes the next matching request(s) fail.
import http from 'node:http';

export const HUBSPOT_PAT = 'pat-na1-0123456789abcdefghij';
export const PIPEDRIVE_TOKEN = 'pd0123456789abcdef0123456789abcdef';
// a made-up key in Mailchimp's shape (32 hex + data centre), built in parts so secret scanners don't flag the test file
export const MAILCHIMP_KEY = `${'a1b2c3d4'.repeat(4)}-us21`;
export const CC_LIST = '11111111-2222-3333-4444-555555555555';

export async function startFakeCrm() {
  const requests = [];
  const fails = [];
  const valid = new Set([HUBSPOT_PAT, PIPEDRIVE_TOKEN, MAILCHIMP_KEY]);
  const refresh = new Set();
  let seq = 0, tok = 0;
  const S = { hooks: [], hubspot: { contacts: [], notes: [] }, sf: { leads: [], tasks: [], notes: [] }, pd: { persons: [], leads: [], deals: [], notes: [] }, zoho: { leads: [], notes: [] }, mc: { members: {}, tags: [], notes: [] }, cc: { contacts: [], memberships: [] }, tokenCalls: [] };
  const nid = (p = '') => `${p}${1000 + ++seq}`;
  const mint = () => { const access = `ATOK_${++tok}`; valid.add(access); return access; };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, m = req.method;
    let body = null;
    try { body = raw ? (String(req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : null; } catch { body = null; }
    const rec = { method: m, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, raw, body };
    requests.push(rec);
    const send = (status, json, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(json === undefined ? '' : typeof json === 'string' ? json : JSON.stringify(json)); };
    const f = fails.find((x) => x.re.test(`${m} ${p}`));
    if (f) { if (--f.times <= 0) fails.splice(fails.indexOf(f), 1); return send(f.status, f.body ?? { message: 'injected failure' }, f.headers || {}); }
    const auth = String(req.headers.authorization || '').replace(/^(Bearer|Zoho-oauthtoken)\s+/i, '') || String(req.headers['x-api-token'] || '');
    const authed = () => valid.has(auth);

    // ---------------- webhook / REST hook receiver
    if (p.startsWith('/hook/')) { S.hooks.push(rec); return send(200, { ok: true }); }
    if (p === '/redirect-private') { res.writeHead(307, { location: 'https://169.254.169.254/latest/meta-data' }); return res.end(); }
    if (p === '/redirect-hook') { res.writeHead(307, { location: '/hook/after-redirect' }); return res.end(); }
    if (p === '/redirect-302') { res.writeHead(302, { location: '/hook/x' }); return res.end(); }

    // ---------------- OAuth token endpoints (all four vendors)
    if (m === 'POST' && ['/hubspot/oauth/v3/token', '/sf/services/oauth2/token', '/pd/oauth/token', '/zoho/oauth/v2/token', '/mc/oauth2/token', '/cc/token'].includes(p)) {
      const vendor = p.split('/')[1];
      S.tokenCalls.push({ vendor, ...body, basic: req.headers.authorization || null });
      const bad = (error) => (vendor === 'zoho' ? send(200, { error }) : send(400, { error, error_description: `${error} (fake)` }));
      const extra = vendor === 'sf' ? { instance_url: 'https://fake.my.salesforce.com', id: 'https://login.salesforce.com/id/00D/005' } : vendor === 'pd' ? { api_domain: 'https://fakeco.pipedrive.com' }
        : vendor === 'zoho' ? { api_domain: 'https://www.zohoapis.eu' } : { hub_id: 4242 };
      if (body?.grant_type === 'authorization_code') {
        if (body.code !== 'code-ok') return bad('invalid_grant');
        if (vendor === 'sf' && !body.code_verifier) return bad('invalid_grant');
        if (vendor === 'mc') return send(200, { access_token: mint(), expires_in: 0, scope: null });
        const rt = `RTOK_${tok + 1}`; refresh.add(rt);
        return send(200, { access_token: mint(), refresh_token: rt, expires_in: vendor === 'sf' ? undefined : 1800, token_type: 'bearer', ...extra });
      }
      if (body?.grant_type === 'refresh_token') {
        if (!refresh.has(body.refresh_token)) return bad('invalid_grant');
        if (vendor === 'cc') { refresh.delete(body.refresh_token); const rt = `RTOK_${tok + 1}`; refresh.add(rt); return send(200, { access_token: mint(), refresh_token: rt, expires_in: 28800 }); } // rotates
        return send(200, { access_token: mint(), expires_in: 1800, ...extra });
      }
      return bad('unsupported_grant_type');
    }

    // ---------------- HubSpot
    if (p.startsWith('/hubspot/')) {
      if (!authed()) return send(401, { status: 'error', message: 'Authentication credentials not found.', category: 'INVALID_AUTHENTICATION' });
      const H = S.hubspot;
      if (m === 'GET' && p === '/hubspot/crm/v3/objects/contacts') return send(200, { results: H.contacts.slice(0, 1) });
      if (m === 'GET' && p === '/hubspot/account-info/v3/details') return send(200, { portalId: 4242, timeZone: 'UTC' });
      if (m === 'POST' && p === '/hubspot/crm/v3/objects/contacts/search') {
        const hit = H.contacts.find((c) => (body.filterGroups || []).some((g) => g.filters.every((x) => String(c.properties[x.propertyName] || '').toLowerCase() === String(x.value).toLowerCase())));
        return send(200, { total: hit ? 1 : 0, results: hit ? [hit] : [] });
      }
      if (m === 'POST' && p === '/hubspot/crm/v3/objects/contacts') {
        const dup = body.properties.email && H.contacts.find((c) => c.properties.email === body.properties.email);
        if (dup) return send(409, { status: 'error', message: `Contact already exists. Existing ID: ${dup.id}`, category: 'CONFLICT' });
        const c = { id: nid(), properties: { ...body.properties } };
        H.contacts.push(c);
        return send(201, c);
      }
      const mc = /^\/hubspot\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(p);
      if (m === 'PATCH' && mc) { const c = H.contacts.find((x) => x.id === mc[1]); if (!c) return send(404, { message: 'not found' }); Object.assign(c.properties, body.properties); return send(200, c); }
      if (m === 'POST' && p === '/hubspot/crm/v3/objects/notes') { const n = { id: nid(), ...body }; H.notes.push(n); return send(201, n); }
      return send(404, { message: `no fake for ${m} ${p}` });
    }

    // ---------------- Salesforce
    if (p.startsWith('/sf/')) {
      if (!authed()) return send(401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
      const F = S.sf;
      if (m === 'GET' && p === '/sf/services/oauth2/userinfo') return send(200, { organization_id: '00Dxx', preferred_username: 'owner@example.com', name: 'Owner' });
      if (m === 'GET' && /^\/sf\/services\/data\/v\d+\.0\/query$/.test(p)) {
        const q = url.searchParams.get('q') || '';
        const mq = /WHERE (Email|Phone) = '((?:[^'\\]|\\.)*)'/.exec(q);
        const val = mq ? mq[2].replace(/\\(.)/g, '$1') : null;
        const hit = mq ? F.leads.filter((l) => String(l[mq[1]] || '').toLowerCase() === String(val).toLowerCase()).slice(-1) : [];
        return send(200, { totalSize: hit.length, done: true, records: hit.map((l) => ({ Id: l.Id, Phone: l.Phone || null, Email: l.Email || null })) });
      }
      const base = /^\/sf\/services\/data\/v\d+\.0\/sobjects\/(Lead|Task|Note)(?:\/(.+))?$/.exec(p);
      if (base) {
        const [, type, rest] = base;
        if (m === 'POST' && !rest) {
          if (type === 'Lead' && (!body.LastName || !body.Company)) return send(400, [{ message: 'Required fields are missing: [LastName, Company]', errorCode: 'REQUIRED_FIELD_MISSING' }]);
          const row = { Id: nid(type === 'Lead' ? '00Q' : type === 'Task' ? '00T' : '002'), ...body };
          F[type === 'Lead' ? 'leads' : type === 'Task' ? 'tasks' : 'notes'].push(row);
          return send(201, { id: row.Id, success: true, errors: [] });
        }
        if (type === 'Lead' && rest && rest.includes('/')) { // external id upsert / read
          const [field, value] = rest.split('/').map(decodeURIComponent);
          const row = F.leads.find((l) => l[field] === value);
          if (m === 'GET') return row ? send(200, { Id: row.Id }) : send(404, [{ errorCode: 'NOT_FOUND', message: 'not found' }]);
          if (m === 'PATCH') {
            if (row) { Object.assign(row, body); return send(200, { id: row.Id, success: true, created: false }); }
            const fresh = { Id: nid('00Q'), [field]: value, ...body }; F.leads.push(fresh);
            return send(201, { id: fresh.Id, success: true, created: true });
          }
        }
        if (type === 'Lead' && rest && m === 'PATCH') { const row = F.leads.find((l) => l.Id === rest); if (!row) return send(404, [{ errorCode: 'NOT_FOUND', message: 'nf' }]); Object.assign(row, body); res.writeHead(204); return res.end(); }
      }
      return send(404, [{ errorCode: 'NOT_FOUND', message: `no fake for ${m} ${p}` }]);
    }

    // ---------------- Pipedrive
    if (p.startsWith('/pd/')) {
      if (!authed()) return send(401, { success: false, error: 'unauthorized access', errorCode: 401 });
      const P = S.pd;
      if (m === 'GET' && p === '/pd/api/v1/users/me') return send(200, { success: true, data: { id: 7, name: 'Owner', company_name: 'Fake Co', company_domain: 'fakeco' } });
      if (m === 'GET' && p === '/pd/api/v2/persons/search') {
        const term = String(url.searchParams.get('term') || '').toLowerCase(), field = url.searchParams.get('fields');
        const hit = P.persons.find((x) => (field === 'email' ? x.emails : x.phones || []).some((e) => String(e.value).toLowerCase() === term));
        return send(200, { success: true, data: { items: hit ? [{ result_score: 1, item: { id: hit.id, name: hit.name } }] : [] } });
      }
      if (m === 'POST' && p === '/pd/api/v2/persons') { if (!body.name) return send(400, { success: false, error: 'name is required' }); const x = { id: Number(nid()), emails: [], phones: [], ...body }; P.persons.push(x); return send(200, { success: true, data: x }); }
      if (m === 'GET' && p === '/pd/api/v1/leads') return send(200, { success: true, data: P.leads.filter((l) => String(l.person_id) === url.searchParams.get('person_id')).slice(0, 1) });
      if (m === 'POST' && p === '/pd/api/v1/leads') { const x = { id: `uuid-${nid()}`, ...body }; P.leads.push(x); return send(201, { success: true, data: x }); }
      if (m === 'GET' && p === '/pd/api/v2/deals') return send(200, { success: true, data: P.deals.filter((l) => String(l.person_id) === url.searchParams.get('person_id')).slice(0, 1) });
      if (m === 'POST' && p === '/pd/api/v2/deals') { const x = { id: Number(nid()), ...body }; P.deals.push(x); return send(200, { success: true, data: x }); }
      if (m === 'POST' && p === '/pd/api/v1/notes') { const x = { id: Number(nid()), ...body }; P.notes.push(x); return send(201, { success: true, data: x }); }
      return send(404, { success: false, error: `no fake for ${m} ${p}` });
    }

    // ---------------- Zoho CRM
    if (p.startsWith('/zoho/')) {
      if (!authed()) return send(401, { code: 'INVALID_TOKEN', details: {}, message: 'invalid oauth token', status: 'error' });
      const Z = S.zoho;
      if (m === 'GET' && p === '/zoho/crm/v8/Leads') { if (!Z.leads.length) { res.writeHead(204); return res.end(); } return send(200, { data: Z.leads.slice(0, 1) }); }
      if (m === 'GET' && p === '/zoho/crm/v8/Leads/search') {
        const k = url.searchParams.has('email') ? 'Email' : 'Phone';
        const v = url.searchParams.get(k.toLowerCase());
        const hit = Z.leads.find((l) => String(l[k] || '').toLowerCase() === String(v).toLowerCase());
        if (!hit) { res.writeHead(204); return res.end(); }
        return send(200, { data: [hit] });
      }
      if (m === 'POST' && p === '/zoho/crm/v8/Leads/upsert') {
        const d = body.data[0], k = body.duplicate_check_fields[0];
        if (!d.Last_Name) return send(400, { data: [{ code: 'MANDATORY_NOT_FOUND', details: { api_name: 'Last_Name' }, message: 'required field not found', status: 'error' }] });
        const hit = Z.leads.find((l) => l[k] && l[k] === d[k]);
        if (hit) { Object.assign(hit, d); return send(200, { data: [{ code: 'SUCCESS', action: 'update', duplicate_field: k, details: { id: hit.id }, message: 'record updated', status: 'success' }] }); }
        const row = { id: nid('55'), ...d }; Z.leads.push(row);
        return send(201, { data: [{ code: 'SUCCESS', action: 'insert', details: { id: row.id }, message: 'record added', status: 'success' }] });
      }
      const zl = /^\/zoho\/crm\/v8\/Leads\/(\d+)(\/Notes)?$/.exec(p);
      if (zl && m === 'PUT' && !zl[2]) { const row = Z.leads.find((l) => l.id === zl[1]); Object.assign(row, body.data[0]); return send(200, { data: [{ code: 'SUCCESS', details: { id: row.id }, status: 'success' }] }); }
      if (zl && m === 'POST' && zl[2]) { const n = { id: nid('66'), lead: zl[1], ...body.data[0] }; Z.notes.push(n); return send(201, { data: [{ code: 'SUCCESS', details: { id: n.id }, status: 'success' }] }); }
      return send(404, { code: 'INVALID_URL_PATTERN', message: `no fake for ${m} ${p}` });
    }
    // ---------------- Mailchimp
    if (p === '/mc/oauth2/metadata') {
      const t = String(req.headers.authorization || '').replace(/^OAuth\s+/i, '');
      return valid.has(t) ? send(200, { dc: 'us21', api_endpoint: 'https://us21.api.mailchimp.com', accountname: 'Fake Shop' }) : send(401, { error: 'invalid_token' });
    }
    if (p.startsWith('/mc/3.0/')) {
      if (!authed()) return send(401, { title: 'API Key Invalid', status: 401, detail: "Your API key may be invalid, or you've attempted to access the wrong datacenter." });
      const M = S.mc;
      if (m === 'GET' && p === '/mc/3.0/lists') return send(200, { lists: [{ id: 'aud0001', name: 'Newsletter' }, { id: 'aud0002', name: 'Customers' }] });
      const mm = /^\/mc\/3\.0\/lists\/([^/]+)\/members\/([0-9a-f]{32})(?:\/(tags|notes))?$/.exec(p);
      if (mm) {
        const key = `${mm[1]}/${mm[2]}`;
        if (m === 'PUT' && !mm[3]) {
          if (!['aud0001', 'aud0002'].includes(mm[1])) return send(404, { title: 'Resource Not Found', detail: 'The requested resource could not be found.' });
          const had = M.members[key];
          M.members[key] = had ? { ...had, merge_fields: { ...had.merge_fields, ...(body.merge_fields || {}) } } : { id: mm[2], email_address: body.email_address, status: body.status || body.status_if_new, merge_fields: body.merge_fields || {} };
          return send(200, M.members[key]);
        }
        if (m === 'POST' && mm[3] === 'tags') { M.tags.push({ key, tags: body.tags }); res.writeHead(204); return res.end(); }
        if (m === 'POST' && mm[3] === 'notes') { M.notes.push({ key, note: body.note }); return send(200, { id: 1, note: body.note }); }
      }
      return send(404, { title: 'Resource Not Found', detail: `no fake for ${m} ${p}` });
    }

    // ---------------- Constant Contact
    if (p.startsWith('/cc/v3/')) {
      if (!authed()) return send(401, { error_key: 'unauthorized', error_message: 'Unauthorized' });
      const C = S.cc;
      if (m === 'GET' && p === '/cc/v3/contact_lists') return send(200, { lists: [{ list_id: CC_LIST, name: 'General Interest' }] });
      if (m === 'GET' && p === '/cc/v3/contacts') { const hit = C.contacts.find((c) => c.email === String(url.searchParams.get('email')).toLowerCase()); return send(200, { contacts: hit ? [{ contact_id: hit.contact_id }] : [] }); }
      if (m === 'POST' && p === '/cc/v3/contacts') {
        const email = String(body.email_address?.address || '').toLowerCase();
        if (C.contacts.some((c) => c.email === email)) return send(409, [{ error_key: 'contacts.api.conflict', error_message: 'Validation failed: Email already exists.' }]);
        const row = { contact_id: `c-${nid()}`, email, via: 'contacts', ...body }; C.contacts.push(row);
        return send(201, { contact_id: row.contact_id });
      }
      if (m === 'POST' && p === '/cc/v3/contacts/sign_up_form') {
        const email = String(body.email_address || '').toLowerCase();
        const hit = C.contacts.find((c) => c.email === email);
        if (hit) { Object.assign(hit, body, { via: 'sign_up_form' }); return send(200, { contact_id: hit.contact_id, action: 'updated' }); }
        const row = { contact_id: `c-${nid()}`, email, via: 'sign_up_form', ...body }; C.contacts.push(row);
        return send(201, { contact_id: row.contact_id, action: 'created' });
      }
      if (m === 'POST' && p === '/cc/v3/activities/add_list_memberships') { C.memberships.push(body); return send(201, { activity_id: `a-${nid()}`, state: 'initialized' }); }
      return send(404, { error_message: `no fake for ${m} ${p}` });
    }
    return send(404, { message: 'no such fake' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, requests, state: S, valid, refresh,
    /** The `bases` option of createCrm: every connector pointed at this server. */
    bases: {
      hubspot: { api: `${url}/hubspot`, token: `${url}/hubspot/oauth/v3/token`, authorize: `${url}/hubspot/oauth/authorize` },
      salesforce: { login: `${url}/sf`, instance: `${url}/sf` },
      pipedrive: { api: `${url}/pd`, oauth: `${url}/pd` },
      zoho: { accounts: `${url}/zoho`, api: `${url}/zoho` },
      mailchimp: { login: `${url}/mc`, api: `${url}/mc/3.0` },
      constantcontact: { authz: `${url}/cc`, api: `${url}/cc/v3` },
    },
    net: { allowAddresses: ['127.0.0.1'], allowHttp: true, allowPorts: 'any' },
    failNext(re, { status = 500, headers = {}, body = undefined, times = 1 } = {}) { fails.push({ re, status, headers, body, times }); },
    clearFails() { fails.length = 0; },
    since(n) { return requests.slice(n); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

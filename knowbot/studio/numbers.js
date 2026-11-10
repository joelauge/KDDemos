// KnowBot Studio: "Get your KnowBot number" (prefix nb-, styles in golive.css). Shown on the SMS and Telephone cards of
// the Set up / Go live view (golive.js). One number serves texts and calls.
//
//   area code or city → pick a number → pick a credit pack → price summary → secure checkout, in place (an embedded
//   payment form) → "Your number is live" with its credit, and "Add credit" afterwards.
//
// Server: GET/POST /api/studio/trials/:id/number[/search|/checkout|/confirm|/topup] (server/numbers.mjs). The number is
// bought by the server only after the payment is confirmed. Owner rule: this copy never names the phone vendor or the
// payment company ("your KnowBot number", "texts", "calls", "Secure checkout"); the embedded payment form may show its own.

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;
const rate = (c) => `${Math.round(Number(c) * 100) / 100}¢`;
const nfmt = (n) => Number(n || 0).toLocaleString('en-US');
const rid = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scriptPromise = null;
function loadCheckoutJs(src) {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error('checkout did not load')));
    s.onerror = () => { scriptPromise = null; reject(new Error('checkout did not load')); };
    document.head.append(s);
  });
  return scriptPromise;
}

/** Last known state per bot (golive.js reads it for the card status). */
export const numberCache = { trial: null, info: null };

/**
 * mountNumbers(el, { apiBase, trial: () => ({id, token}), icon(name, size), announce(text, politeness), onState(info) })
 * → { destroy() }
 */
export function mountNumbers(root, { apiBase, trial, icon = () => '', announce = null, onState = () => {} } = {}) {
  const box = h('section', { class: 'nb', 'aria-labelledby': `nb-t-${rid()}` });
  const titleId = box.getAttribute('aria-labelledby');
  const live = h('p', { class: 'co-sr', 'aria-live': 'polite', role: 'status' });
  root.append(box);
  let destroyed = false, checkout = null, info = null;
  const ui = { country: 'US', query: '', numbers: [], pick: null, pack: 2500, quote: null };

  // the Studio's own announcer when there is one; else this panel's polite status line
  const say = (text) => { if (announce) announce(text, 'polite'); else live.textContent = text; };
  async function api(p, { method = 'GET', body } = {}) {
    const t = trial();
    const res = await fetch(`${apiBase}/api/studio/trials/${encodeURIComponent(t.id || '')}/number${p}`, {
      method, credentials: 'omit',
      headers: { ...(t.token ? { authorization: `Bearer ${t.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(j?.error?.message || "Something went wrong. Try again in a minute."), { status: res.status, code: j?.error?.code });
    return j;
  }
  function setInfo(next) {
    info = next;
    numberCache.trial = trial().id; numberCache.info = next;
    try { onState(next); } catch { /* ignore */ }
  }
  function dropCheckout() { try { checkout?.destroy(); } catch { /* ignore */ } checkout = null; }

  const head = (title, sub) => h('div', { class: 'nb-head' },
    h('span', { class: 'nb-ico', 'aria-hidden': 'true', html: icon('phone', 16) }),
    h('div', null, h('h4', { class: 'nb-title', id: titleId }, title), sub ? h('p', { class: 'nb-sub' }, sub) : null));
  const errLine = (msg) => h('p', { class: 'nb-err', role: 'alert' }, h('span', { html: icon('warn', 14), 'aria-hidden': 'true' }), ' ', msg);

  function paint(...nodes) {
    if (destroyed) return;
    box.innerHTML = '';
    box.append(...nodes.filter(Boolean), live);
  }

  // ------------------------------------------------------------ states
  async function load() {
    paint(head('Your KnowBot number'), h('div', { class: 'nb-skel', role: 'status', 'aria-label': 'Loading' }, h('i'), h('i')));
    try { setInfo(await api('')); }
    catch { paint(head('Your KnowBot number'), errLine("We couldn't load this right now.")); return; }
    render();
  }
  function render() {
    if (!info || !info.enabled) {
      paint(h('div', { class: 'nb-soon' },
        h('span', { class: 'chip gray is-label' }, 'Coming soon'),
        h('p', null, h('b', null, 'Get a KnowBot number right here. '), 'Pick a number in your area and your bot answers texts and calls on it. Until then, you can use a number you already have (steps below).')));
      return;
    }
    const n = info.number;
    if (n && n.state === 'active') return renderActive(n);
    if (n && n.state === 'buying') return renderWaiting();
    renderSearch(n && (n.state === 'refunded' || n.state === 'cancelled') ? n.note : null);
  }

  function renderSearch(note = null) {
    dropCheckout();
    const id = `nb-q-${rid()}`, cid = `nb-c-${rid()}`;
    const input = h('input', { id, class: 'input nb-input', type: 'text', inputmode: 'text', autocomplete: 'off', placeholder: 'e.g. 415 or Chicago', maxlength: '40', value: ui.query });
    const country = h('select', { id: cid, class: 'input nb-select' },
      h('option', { value: 'US', selected: ui.country === 'US' }, 'United States'), h('option', { value: 'CA', selected: ui.country === 'CA' }, 'Canada'));
    const btn = h('button', { type: 'submit', class: 'btn btn-primary nb-btn' }, 'Find numbers');
    const results = h('div', { class: 'nb-results' });
    const form = h('form', { class: 'nb-form', role: 'search' },
      h('div', { class: 'nb-field' }, h('label', { for: id }, 'Area code or city'), input),
      h('div', { class: 'nb-field nb-field-cc' }, h('label', { for: cid }, 'Country'), country),
      btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) { input.focus(); say('Type an area code or a city.'); return; }
      ui.query = q; ui.country = country.value;
      btn.disabled = true; btn.textContent = 'Finding…';
      results.innerHTML = '';
      results.append(h('div', { class: 'nb-skel', role: 'status', 'aria-label': 'Finding numbers' }, h('i'), h('i'), h('i')));
      const digits = q.replace(/\D+/g, '');
      const qs = new URLSearchParams({ country: ui.country, ...(/^\d{3}$/.test(digits) && digits.length === q.replace(/[\s()-]+/g, '').length ? { areaCode: digits } : { city: q }) });
      try {
        const r = await api(`/search?${qs}`);
        ui.numbers = r.numbers || []; ui.quote = r.quote; ui.pick = null;
        renderResults(results);
        say(ui.numbers.length ? `${ui.numbers.length} numbers found. Pick one.` : 'No numbers found there. Try a nearby area code.');
      } catch (err) { results.innerHTML = ''; results.append(errLine(err.message)); }
      finally { btn.disabled = false; btn.textContent = 'Find numbers'; }
    });
    paint(head('Get your KnowBot number', 'One number for texts and calls. Pick one in your area. It works as soon as you pay.'),
      note ? h('p', { class: 'nb-note' }, h('span', { html: icon('info', 14), 'aria-hidden': 'true' }), ' ', note) : null,
      form, results);
    if (ui.numbers.length) renderResults(results);
  }

  function renderResults(results) {
    results.innerHTML = '';
    if (!ui.numbers.length) { results.append(h('p', { class: 'nb-empty' }, 'No numbers free there right now. Try a nearby area code or a bigger city.')); return; }
    const name = `nb-n-${rid()}`;
    const list = h('div', { class: 'nb-list', role: 'radiogroup', 'aria-label': 'Available numbers' });
    for (const n of ui.numbers) {
      const rid0 = `${name}-${n.phoneNumber.replace(/\D/g, '')}`;
      const radio = h('input', { type: 'radio', name, id: rid0, value: n.phoneNumber, class: 'nb-radio', checked: ui.pick?.phoneNumber === n.phoneNumber });
      radio.addEventListener('change', () => { ui.pick = n; renderSummary(sum); });
      list.append(h('label', { class: 'nb-opt', for: rid0 }, radio,
        h('span', { class: 'nb-opt-num gl-mono' }, n.display),
        h('span', { class: 'nb-opt-loc' }, [n.locality, n.region].filter(Boolean).join(', ') || '')));
    }
    const sum = h('div', { class: 'nb-sum-wrap' });
    results.append(h('h5', { class: 'nb-h5' }, 'Pick a number'), list, sum);
    renderSummary(sum);
  }

  function packPicker(packs, onPick, current) {
    const name = `nb-p-${rid()}`;
    const g = h('div', { class: 'nb-packs', role: 'radiogroup', 'aria-label': 'Credit for calls and texts' });
    for (const p of packs) {
      const id = `${name}-${p.cents}`;
      const r = h('input', { type: 'radio', name, id, value: String(p.cents), class: 'nb-radio', checked: current === p.cents });
      r.addEventListener('change', () => onPick(p.cents));
      g.append(h('label', { class: 'nb-pack', for: id }, r, h('b', null, money(p.cents)), h('small', null, `about ${nfmt(p.minutes)} minutes or ${nfmt(p.texts)} texts`)));
    }
    return g;
  }

  function renderSummary(sum) {
    sum.innerHTML = '';
    const q = ui.quote;
    if (!q) return;
    sum.append(h('h5', { class: 'nb-h5' }, 'Prepay for calls and texts'), packPicker(q.packs, (c) => { ui.pack = c; renderSummary(sum); }, ui.pack));
    const pack = q.packs.find((p) => p.cents === ui.pack) || q.packs[0];
    const service = q.lines.find((l) => l.id === 'service'), num = q.lines.find((l) => l.id === 'number');
    const monthly = service.cents + num.cents;
    const go = h('button', { type: 'button', class: 'btn btn-primary nb-btn nb-go', disabled: !ui.pick },
      h('span', { html: icon('lock', 14), 'aria-hidden': 'true' }), ui.pick ? `Continue to secure checkout · ${money(monthly + pack.cents)}` : 'Pick a number first');
    go.addEventListener('click', () => startCheckout(go));
    sum.append(h('dl', { class: 'nb-sum', 'aria-label': 'Price summary' },
      h('div', null, h('dt', null, 'KnowBot number service'), h('dd', null, `${money(service.cents)}/mo`)),
      h('div', null, h('dt', null, `Your number${ui.pick ? ` ${ui.pick.display}` : ''}`), h('dd', null, `${money(num.cents)}/mo`)),
      h('div', null, h('dt', null, 'Call and text credit (one time)'), h('dd', null, money(pack.cents))),
      h('div', { class: 'nb-sum-total' }, h('dt', null, 'Pay today'), h('dd', null, money(monthly + pack.cents))),
      h('div', { class: 'nb-sum-then' }, h('dt', null, 'Then each month'), h('dd', null, `${money(monthly)}/mo`))),
      h('p', { class: 'nb-fine' }, `Calls use ${rate(q.rates.minuteCents)} of credit a minute and texts about ${rate(q.rates.textCents)} each, in or out. We warn you when credit runs low. Cancel any time.`),
      go, h('div', { class: 'nb-pay' }));
  }

  // ------------------------------------------------------------ embedded payment
  async function mountPay(slot, clientSecret, { title, onPaid, onBack }) {
    dropCheckout();
    slot.innerHTML = '';
    const back = h('button', { type: 'button', class: 'btn btn-ghost co-btn co-btn-ghost is-small nb-back' }, 'Back');
    back.addEventListener('click', () => { dropCheckout(); onBack(); });
    const mount = h('div', { class: 'nb-pay-frame', id: `nb-pay-${rid()}` });
    slot.append(h('div', { class: 'nb-pay-head' }, h('span', { html: icon('lock', 14), 'aria-hidden': 'true' }), h('b', null, title), back), mount);
    try {
      const Stripe = await loadCheckoutJs(info.checkoutJs);
      const stripe = Stripe(info.publishableKey);
      checkout = await stripe.initEmbeddedCheckout({ fetchClientSecret: async () => clientSecret, onComplete: () => onPaid() });
      if (destroyed) { dropCheckout(); return; }
      checkout.mount(mount);
      say('Secure checkout is open. Enter your card to pay.');
      slot.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      slot.append(errLine("Checkout couldn't open. Check your connection and try again."));
    }
  }

  async function startCheckout(go) {
    if (!ui.pick) return;
    go.disabled = true;
    const slot = go.nextElementSibling;
    try {
      const r = await api('/checkout', { method: 'POST', body: { phoneNumber: ui.pick.phoneNumber, pack: ui.pack, country: ui.country, locality: ui.pick.locality, region: ui.pick.region } });
      go.hidden = true;
      await mountPay(slot, r.clientSecret, {
        title: 'Secure checkout',
        onBack: () => { go.hidden = false; go.disabled = false; slot.innerHTML = ''; },
        onPaid: () => confirm(r.sessionId),
      });
    } catch (err) {
      go.disabled = false;
      slot.innerHTML = '';
      slot.append(errLine(err.code === 'has_number' ? 'This bot already has a KnowBot number.' : err.message));
    }
  }

  function renderWaiting(text = 'Payment received. Setting up your number…') {
    dropCheckout();
    paint(head('Setting up your KnowBot number'), h('div', { class: 'nb-wait', role: 'status' }, h('span', { class: 'nb-spin', 'aria-hidden': 'true' }), h('span', null, text)));
    say(text);
  }

  /** After payment: the server checks it and buys the number (once). A short retry covers a slow payment. */
  async function confirm(sessionId, { topup = false } = {}) {
    renderWaiting(topup ? 'Payment received. Adding your credit…' : undefined);
    for (let i = 0; i < 8 && !destroyed; i++) {
      try {
        const r = await api('/confirm', { method: 'POST', body: { sessionId } });
        if (r.state && !r.pending) {
          setInfo({ ...info, number: r.state });
          render();
          if (r.state.state === 'active') say(topup ? `Credit added. You have $${r.state.balance}.` : `Your KnowBot number ${r.state.display} is live for texts and calls.`);
          else if (r.state.note) say(r.state.note);
          return;
        }
      } catch (err) { if (err.status && err.status < 500 && err.status !== 429) { paint(head('Your KnowBot number'), errLine(err.message)); return; } }
      await sleep(Math.min(4000, 800 * (i + 1)));
    }
    // still not confirmed: the payments webhook finishes it; reload shows it
    try { setInfo(await api('')); } catch { /* keep */ }
    if (info?.number?.state === 'active') { render(); return; }
    paint(head('Almost there'), h('p', { class: 'nb-note' }, h('span', { html: icon('info', 14), 'aria-hidden': 'true' }), ' Your payment is being checked. Your number will appear here in a minute. You can close this.'),
      h('button', { type: 'button', class: 'btn nb-btn', onclick: () => load() }, 'Check again'));
  }

  function renderActive(n) {
    dropCheckout();
    const status = n.out ? { tone: 'bad', text: 'Out of credit: texts get no reply and calls hear a short message. Add credit to turn them back on.' }
      : n.low ? { tone: 'warn', text: 'Credit is running low. Add credit so calls and texts keep working.' } : null;
    const add = h('button', { type: 'button', class: `btn ${n.out || n.low ? 'btn-primary' : ''} nb-btn` }, h('span', { html: icon('plus', 14), 'aria-hidden': 'true' }), 'Add credit');
    const topSlot = h('div', { class: 'nb-topup' });
    add.addEventListener('click', () => renderTopUp(topSlot, add));
    paint(
      head('Your KnowBot number is live', 'Texts and calls to this number are answered by your bot.'),
      h('div', { class: 'nb-live' },
        h('div', { class: 'nb-live-num' }, h('span', { class: 'nb-dot', 'aria-hidden': 'true' }), h('b', { class: 'gl-mono' }, n.display),
          [n.locality, n.region].filter(Boolean).length ? h('small', null, [n.locality, n.region].filter(Boolean).join(', ')) : null),
        h('div', { class: 'nb-chips' }, h('span', { class: 'chip green is-label' }, 'Texts on'), h('span', { class: 'chip green is-label' }, 'Calls on'))),
      n.note ? h('p', { class: 'nb-note' }, h('span', { html: icon('info', 14), 'aria-hidden': 'true' }), ' ', n.note) : null,
      h('dl', { class: 'nb-sum nb-bal', 'aria-label': 'Credit' },
        h('div', { class: 'nb-sum-total' }, h('dt', null, 'Credit left'), h('dd', null, `$${n.balance}`)),
        h('div', null, h('dt', null, 'About'), h('dd', null, `${nfmt(n.minutesLeft)} minutes or ${nfmt(n.textsLeft)} texts`)),
        n.monthlyCents ? h('div', null, h('dt', null, 'Plan'), h('dd', null, `${money(n.monthlyCents)}/mo`)) : null),
      status ? h('p', { class: `nb-alert is-${status.tone}`, role: status.tone === 'bad' ? 'alert' : 'status' }, h('span', { html: icon('warn', 14), 'aria-hidden': 'true' }), ' ', status.text) : null,
      add, topSlot);
  }

  function renderTopUp(slot, add) {
    const packs = info.quote?.packs || [];
    let pick = 2500;
    slot.innerHTML = '';
    const go = h('button', { type: 'button', class: 'btn btn-primary nb-btn' }, h('span', { html: icon('lock', 14), 'aria-hidden': 'true' }), `Pay ${money(pick)}`);
    const pay = h('div', { class: 'nb-pay' });
    const picker = packPicker(packs, (c) => { pick = c; go.lastChild.textContent = `Pay ${money(c)}`; }, pick);
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await api('/topup', { method: 'POST', body: { pack: pick } });
        go.hidden = true; picker.hidden = true;
        await mountPay(pay, r.clientSecret, { title: `Add ${money(pick)} of credit`, onBack: () => { go.hidden = false; go.disabled = false; picker.hidden = false; pay.innerHTML = ''; }, onPaid: () => confirm(r.sessionId, { topup: true }) });
      } catch (err) { go.disabled = false; pay.innerHTML = ''; pay.append(errLine(err.message)); }
    });
    add.hidden = true;
    slot.append(h('h5', { class: 'nb-h5' }, 'Add credit for calls and texts'), picker, go, pay);
    picker.querySelector('input:checked')?.focus();
  }

  load();
  return { destroy() { destroyed = true; dropCheckout(); box.remove(); }, reload: load };
}

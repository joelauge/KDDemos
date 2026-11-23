// KnowBot Studio: the KnowDrive account step of Launch (owner decisions 1-4). Lazily imported by checkout.js.
//
//   Launch → this modal: create (or sign in to) a KnowDrive account in a popup → the owner chooses the store the bot's
//   files go to (never picked for them: nothing is preselected, a single store is still confirmed by name, a store
//   another account shared is shown greyed and cannot be picked, a store with other files needs a tick, one KnowDrive
//   does not confirm as theirs also needs its name typed; the server enforces all of it again) → the files move into
//   that store (progress from the trial's `kd` events) → "Continue to checkout" opens the existing checkout.
//   Also the "Reconnect KnowDrive" notice for a live bot whose KnowDrive sign-in stopped working.
//
// Server: /api/studio/trials/:id/kd (status, start, stores, store, move, sign out); the popup ends on /api/studio/kd/callback, which
// posts {type:'knowbot:kd', ok} to this window (when it can) and closes. Tokens never reach the browser.
// Classes: kda- (styles in checkout.css); the layer reuses the checkout's co-layer / co-scrim / co-x / co-cta.

const POLL_MS = 2000;

export function createKdStep(ctx, { h, $$ }) {
  const { store, api, motion, icons, slots, announce } = ctx;
  const { getState, on } = store;
  const icon = (n, s = 16) => icons.icon(n, s);
  const modal = slots.modal || document.getElementById('co-modal-slot');
  const apiOrigin = (() => { try { return new URL(api.BASE || location.origin, location.href).origin; } catch { return location.origin; } })();
  let M = null;           // the open modal
  let last = null;        // the last status from the server
  let notice = null;

  const botName = () => { const n = getState().spec?.name; return n && n !== 'SampleBot' ? n : 'your bot'; };
  const BotName = () => { const n = botName(); return n === 'your bot' ? 'Your bot' : n; };
  const plural = (n, w) => `${Number(n).toLocaleString()} ${n === 1 ? w : `${w}s`}`;
  const errText = (err, fallback) => `${err?.message && err.status && err.status < 500 ? err.message : fallback}${err?.detail?.ref || err?.ref ? ` (ref ${err.detail?.ref || err.ref})` : ''}`;

  async function status() {
    try { last = await api.kdStatus(); } catch (err) { if (M) showError(errText(err, "Couldn't reach KnowDrive just now.")); }
    return last;
  }
  const isReady = () => !!(last && last.ready);

  // ------------------------------------------------------------------ modal shell
  function open({ invoker = null, onContinue = null, reconnect = false } = {}) {
    if (M) { M.focusFirst(); return M.done; }
    const ae = document.activeElement;
    const title = h('h2', { class: 'kda-title', id: 'kda-title' }, reconnect ? 'Reconnect KnowDrive' : `Launch ${botName()}`);
    const desc = h('p', { class: 'kda-desc', id: 'kda-desc' }, "Your bot's files are stored in your own KnowDrive account, where only you control them.");
    const steps = h('ol', { class: 'kda-steps', 'aria-label': 'Launch steps' },
      h('li', { dataset: { step: 'account' } }, h('span', { class: 'kda-dot', 'aria-hidden': 'true' }), h('span', null, 'KnowDrive account')),
      h('li', { dataset: { step: 'store' } }, h('span', { class: 'kda-dot', 'aria-hidden': 'true' }), h('span', null, 'Choose your store')),
      h('li', { dataset: { step: 'files' } }, h('span', { class: 'kda-dot', 'aria-hidden': 'true' }), h('span', null, 'Move your files')),
      h('li', { dataset: { step: 'checkout' } }, h('span', { class: 'kda-dot', 'aria-hidden': 'true' }), h('span', null, 'Checkout')));
    const body = h('div', { class: 'kda-body', 'aria-live': 'polite' });
    const err = h('div', { class: 'co-err kda-err', role: 'alert', hidden: true });
    const x = h('button', { type: 'button', class: 'co-x', 'aria-label': 'Close', html: icon('x', 18) });
    const dialog = h('div', { class: 'kda-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'kda-title', 'aria-describedby': 'kda-desc', tabindex: '-1' },
      x, h('p', { class: 'co-eyebrow' }, h('span', { html: icon('rocket', 13) }), 'Launch'), title, desc, steps, body, err);
    const scrim = h('div', { class: 'co-scrim' });
    const layer = h('div', { class: 'co-layer kda-layer', dataset: { kind: 'kd' } }, scrim, dialog);
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const prevInert = slots.app ? slots.app.inert : false;
    M = { layer, dialog, body, err, steps, title, invoker: invoker || (ae && ae !== document.body ? ae : null), onContinue, done, resolveDone, timers: new Set(), popup: null, state: null, url: null,
      // the step's own action first (the primary button), never the close button
      focusFirst() { const f = focusables().find((n) => n.closest('.kda-body')) || focusables()[0] || dialog; try { f.focus({ preventScroll: true }); } catch { /* ignore */ } } };
    modal.append(layer);
    if (slots.app) slots.app.inert = true;
    M.prevInert = prevInert;
    if (!motion.reduced()) {
      motion.animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.DUR[2], easing: 'out' });
      motion.animate(dialog, [{ opacity: 0, transform: 'translateY(12px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], easing: 'spring' });
    }
    const onKey = (e) => {
      if (!M || M.layer !== layer) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close('esc'); }
      else if (e.key === 'Tab') trap(e);
    };
    document.addEventListener('keydown', onKey, true);
    const onMsg = (e) => {
      if (!M || e.origin !== apiOrigin || !e.data || e.data.type !== 'knowbot:kd') return;
      if (e.data.ok) { refresh(); return; }
      render('start');
      showError(`KnowDrive sign-in didn't finish.${e.data.ref ? ` (ref ${e.data.ref})` : ''}`);
    };
    window.addEventListener('message', onMsg);
    const offEv = on('kd:event', (d) => { if (d && typeof d === 'object') { last = { ...last, ...d }; if (M) paint(); } });
    M.off = () => { document.removeEventListener('keydown', onKey, true); window.removeEventListener('message', onMsg); try { offEv?.(); } catch { /* ignore */ } };
    x.addEventListener('click', () => close('close'));
    scrim.addEventListener('click', () => close('scrim'));
    render('loading');
    requestAnimationFrame(() => M?.focusFirst());
    announce(`${reconnect ? 'Reconnect KnowDrive' : `Launch ${botName()}`}. Your bot's files are stored in your own KnowDrive account.`, 'polite');
    refresh();
    return done;
  }

  function focusables() {
    if (!M) return [];
    return $$('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])', M.dialog).filter((n) => n.offsetParent !== null || n === document.activeElement);
  }
  function trap(e) {
    const f = focusables();
    if (!f.length) { e.preventDefault(); M.dialog.focus(); return; }
    const first = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !M.dialog.contains(document.activeElement))) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && (document.activeElement === lastEl || !M.dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
  // While the files are moving the dialog stays open (closing it mid-move left people with nowhere to go); if the move
  // runs long, closing is allowed again and Launch picks it up where it left off.
  const MOVE_HOLD_MS = 3 * 60000;
  const moveHeld = () => !!M && M.state === 'moving' && Date.now() - (M.movingSince || 0) < MOVE_HOLD_MS;
  function close(reason = 'close') {
    if (!M) return;
    if (moveHeld() && (reason === 'close' || reason === 'esc' || reason === 'scrim')) return;
    const S = M; M = null;
    S.off();
    for (const t of S.timers) clearTimeout(t);
    if (S.popup && !S.popup.closed && reason !== 'continue') { try { S.popup.close(); } catch { /* ignore */ } }
    if (slots.app) slots.app.inert = !!S.prevInert;
    const out = motion.reduced() ? null : motion.animate(S.layer, [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[1] || 120, fill: 'forwards' });
    Promise.resolve(out && out.finished).catch(() => {}).then(() => S.layer.remove());
    setTimeout(() => S.layer.remove(), 400);
    if (reason !== 'continue') {
      const inv = S.invoker && S.invoker.isConnected && !S.invoker.closest('[inert]') ? S.invoker : document.getElementById('st-price');
      requestAnimationFrame(() => { try { inv?.focus({ preventScroll: false }); } catch { /* ignore */ } });
      if (last?.move?.state === 'moving') announce('Your files keep moving in the background.', 'polite');
    }
    S.resolveDone(reason);
  }
  const later = (fn, ms) => { if (!M) return; const t = setTimeout(() => { M?.timers.delete(t); fn(); }, ms); M.timers.add(t); };

  // ------------------------------------------------------------------ states
  async function refresh() {
    await status();
    if (M) paint();
  }
  function paint() {
    const s = last || {};
    if (!M) return;
    if (s.status === 'reconnect') return render('reconnect');
    if (s.status === 'none') return render(M.state === 'waiting' || M.state === 'blocked' ? M.state : 'start');
    if (s.live) return render('ready');
    // the store step: required until the owner has chosen, and open while they are changing their choice. It is not
    // repainted under the owner's hands (a status event would wipe what they picked and typed).
    if (s.storeRequired || M.changing) { if (M.state !== 'store') render('store'); return; }
    if (s.ready) return render('ready');
    const mv = s.move;
    if (mv && mv.state === 'moving') return render('moving');
    if (mv && (mv.state === 'partial' || mv.state === 'error' || mv.state === 'paused')) return render('partial');
    return render('linked');
  }
  function setSteps(active) {
    const order = ['account', 'store', 'files', 'checkout'];
    const i = order.indexOf(active);
    for (const li of M.steps.children) {
      const k = order.indexOf(li.dataset.step);
      li.classList.toggle('is-done', k < i);
      li.classList.toggle('is-current', k === i);
      if (k === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    }
  }
  function showError(msg) {
    if (!M) return;
    M.err.innerHTML = '';
    M.err.append(h('span', { class: 'co-err-ico', html: icon('warn', 15) }), h('span', null, msg));
    M.err.hidden = false;
  }
  const clearError = () => { if (M) { M.err.hidden = true; M.err.innerHTML = ''; } };
  const cta = (label, onclick, { ico = null, id = null } = {}) => {
    const b = h('button', { type: 'button', class: 'co-cta kda-cta', ...(id ? { id } : {}) }, h('span', { class: 'co-spin', 'aria-hidden': 'true' }), h('span', { class: 'co-cta-label' }, label), ico ? h('span', { class: 'co-cta-ico', html: icon(ico, 15) }) : null);
    b.addEventListener('click', onclick);
    return b;
  };
  const link = (label, onclick, id = null) => { const b = h('button', { type: 'button', class: 'co-link kda-link', ...(id ? { id } : {}) }, label); b.addEventListener('click', onclick); return b; };
  const who = () => h('p', { class: 'kda-who' }, h('span', { class: 'kda-ok', html: icon('checkCircle', 16) }), h('span', null, 'Signed in as ', h('b', null, last?.email || 'your KnowDrive account')));
  /** Where the files go: the chosen store, with "Change" while that is still possible (before launch, not mid-move). */
  const storeLine = ({ change = true } = {}) => {
    const st = last?.store;
    if (!st) return null;
    return h('p', { class: 'kda-who kda-where' }, h('span', { class: 'kda-ok', html: icon('checkCircle', 16) }),
      h('span', null, 'Store: ', h('b', null, st.name || 'your KnowDrive store'), change && !last?.live ? [' ', link('Change', changeStore, 'kda-change')] : null));
  };
  const removedNote = () => {
    const r = M?.removed;
    if (!r) return null;
    const from = r.store ? `"${r.store}"` : 'the store you picked before';
    return h('p', { class: 'kda-note', id: 'kda-removed', role: 'status' }, r.failed || r.failed == null
      ? `KnowBot couldn't remove all of this bot's files from ${from} yet. It tries again before it copies anything.`
      : r.files ? `KnowBot removed its ${r.files === 1 ? 'copy of 1 file' : `copies of ${Number(r.files).toLocaleString()} files`} from ${from}. Nothing else there was touched.` : `Nothing of this bot was in ${from}, so nothing was removed there.`);
  };

  // ------------------------------------------------------------------ the store step
  const OWNERSHIP = { owned: 'Your store', unconfirmed: "KnowDrive doesn't confirm this store is yours", shared: "Shared with you by another account: can't be used for a bot" };
  const filesText = (st) => (st.files == null ? "Couldn't count its files" : !st.files ? 'Empty' : st.otherFiles === 0 && !st.capped ? `${plural(st.files, 'file')} from KnowBot` : `${st.capped ? `${Number(st.files).toLocaleString()}+ files` : plural(st.files, 'file')}`);
  const sameName = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  async function loadStores() {
    if (!M) return;
    const S = M;
    try {
      const r = await api.kdStores();
      if (M !== S || M.state !== 'store') return;
      M.stores = Array.isArray(r?.stores) ? r.stores : [];
      M.pick = null; M.tick = false; M.typed = '';
      render('store');
    } catch (err) {
      if (M !== S) return;
      if (err?.code === 'kd_reconnect' || err?.code === 'kd_required') { M.changing = false; await refresh(); return; }
      M.stores = null; M.storesFailed = true;
      render('store');
      showError(errText(err, "Couldn't read your KnowDrive stores just now."));
    }
  }
  function changeStore() {
    if (!M || last?.live) return;
    clearError();
    M.changing = true; M.stores = null; M.storesFailed = false; M.removed = null;
    render('store');
  }
  function renderStores(b) {
    const s = last || {};
    const stores = M.stores || [];
    const usable = stores.filter((st) => st.selectable), off = stores.filter((st) => !st.selectable);
    const again = link('Check again', () => { clearError(); M.stores = null; M.storesFailed = false; render('store'); }, 'kda-stores-again');
    const tail = () => h('p', { class: 'kda-alt' }, M.changing && s.store ? link(`Keep ${s.store.name || 'the current store'}`, () => { M.changing = false; M.stores = null; clearError(); paint(); }, 'kda-keep') : link('Not you? Sign out', signOut, 'kda-signout'));
    if (!usable.length) {
      b.append(h('p', { class: 'kda-note', id: 'kda-store-lead' }, off.length
        ? 'None of the stores in this KnowDrive account are your own, so none can hold a bot. Create a store in KnowDrive, then check again.'
        : 'This KnowDrive account has no store yet. Open KnowDrive once to set one up, then check again.'));
      if (off.length) b.append(offList(off));
      b.append(h('p', { class: 'kda-alt' }, again), tail());
      return;
    }
    b.append(h('p', { class: 'kda-note', id: 'kda-store-lead' }, `Choose where ${botName()}'s files will live. KnowBot only ever adds and removes its own files there. It never touches yours.`));
    if (s.storeRequired && s.move && !M.changing) b.append(h('p', { class: 'kda-fine' }, "Some of this bot's files were copied before you were asked. Pick the store you want: if it's a different one, KnowBot removes its copies from the old one."));
    const confirmBox = h('div', { class: 'kda-confirm', id: 'kda-confirm', hidden: true });
    const use = cta('Choose a store', submit, { id: 'kda-use', ico: 'arrowRight' });
    const label = use.querySelector('.co-cta-label');
    const picked = () => usable.find((st) => st.id === M.pick) || null;
    const sync = () => {
      const st = picked();
      const ok = !!st && (st.needs === 'none' || (M.tick && (st.needs !== 'name' || sameName(M.typed, st.name))));
      label.textContent = st ? `Use ${st.name}` : 'Choose a store';
      use.disabled = !ok || !!M.storeBusy;
      use.classList.toggle('is-busy', !!M.storeBusy);
      if (M.storeBusy) use.setAttribute('aria-busy', 'true'); else use.removeAttribute('aria-busy');
    };
    const paintConfirm = () => {
      const st = picked();
      confirmBox.innerHTML = '';
      confirmBox.hidden = !st || st.needs === 'none';
      if (confirmBox.hidden) return;
      const why = st.needs === 'name' ? `KnowDrive doesn't confirm that "${st.name}" is yours. Only use it if it is your own store.`
        : st.otherFiles == null ? `KnowBot couldn't count the files in "${st.name}". If it holds your files, they stay as they are.`
          : `"${st.name}" already holds ${st.capped ? 'more than ' : ''}${plural(st.otherFiles || st.files || 0, 'other file')}. They stay as they are: KnowBot adds this bot's files in a folder of their own.`;
      const tick = h('input', { type: 'checkbox', id: 'kda-store-tick' });
      tick.checked = !!M.tick;
      tick.addEventListener('change', () => { M.tick = tick.checked; sync(); });
      confirmBox.append(h('p', { class: 'kda-confirm-why', id: 'kda-confirm-why' }, why),
        h('label', { class: 'kda-check', for: 'kda-store-tick' }, tick, h('span', null, "This is my store, and I want this bot's files added to it")));
      if (st.needs === 'name') {
        const input = h('input', { type: 'text', class: 'input co-input kda-input', id: 'kda-store-name', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-describedby': 'kda-confirm-why' });
        input.value = M.typed || '';
        input.addEventListener('input', () => { M.typed = input.value; sync(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !use.disabled) { e.preventDefault(); submit(); } });
        confirmBox.append(h('label', { class: 'kda-field', for: 'kda-store-name' }, h('span', null, 'Type the store\u2019s name to confirm: ', h('b', null, st.name)), input));
      }
    };
    const list = h('fieldset', { class: 'kda-stores', 'aria-describedby': 'kda-store-lead' }, h('legend', { class: 'kda-legend' }, usable.length === 1 ? 'Your KnowDrive store' : 'Your KnowDrive stores'),
      usable.map((st, i) => {
        const radio = h('input', { type: 'radio', name: 'kda-store', value: st.id, id: `kda-store-${i}`, 'aria-describedby': `kda-store-meta-${i}` });
        radio.checked = M.pick === st.id;
        radio.addEventListener('change', () => { if (!radio.checked) return; M.pick = st.id; M.tick = false; M.typed = ''; clearError(); paintConfirm(); sync(); });
        return h('label', { class: 'kda-store', for: `kda-store-${i}`, dataset: { store: st.id, ownership: st.ownership } }, radio,
          h('span', { class: 'kda-store-main' }, h('span', { class: 'kda-store-name' }, st.name, st.current ? h('span', { class: 'kda-store-tag' }, 'Current') : null),
            h('span', { class: 'kda-store-meta', id: `kda-store-meta-${i}` }, `${filesText(st)} · ${OWNERSHIP[st.ownership] || OWNERSHIP.unconfirmed}`)));
      }));
    b.append(list);
    if (off.length) b.append(offList(off));
    b.append(confirmBox, use, h('p', { class: 'kda-alt' }, again), tail());
    M.syncStore = sync;
    paintConfirm(); sync();
  }
  /** Stores another account shared: shown, so the owner sees why they are not offered, never as an option. */
  const offList = (off) => h('ul', { class: 'kda-stores kda-stores-off', 'aria-label': "Stores that can't be used" },
    off.map((st) => h('li', { class: 'kda-store is-off', dataset: { store: st.id, ownership: st.ownership } },
      h('span', { class: 'kda-store-lock', html: icon('lock', 15), 'aria-hidden': 'true' }),
      h('span', { class: 'kda-store-main' }, h('span', { class: 'kda-store-name' }, st.name), h('span', { class: 'kda-store-meta' }, OWNERSHIP.shared)))));
  async function submit() {
    if (!M || M.storeBusy) return;
    const st = (M.stores || []).find((x) => x.id === M.pick && x.selectable);
    if (!st) return;
    clearError();
    const S = M;
    M.storeBusy = true; M.syncStore?.();
    try {
      const r = await api.kdChooseStore({ storeId: st.id, confirmed: st.needs !== 'none' ? !!M.tick : false, ...(st.needs === 'name' ? { typedName: M.typed } : {}) });
      if (M !== S) return;
      const { removed = null, ...rest } = r || {};
      last = { ...last, ...rest };
      M.storeBusy = false; M.changing = false; M.stores = null; M.removed = removed; M.justChose = true;
      announce(`${BotName()}'s files will live in ${st.name}.`, 'polite');
      paint();
    } catch (err) {
      if (M !== S) return;
      M.storeBusy = false;
      if (err?.code === 'kd_reconnect' || err?.code === 'kd_required' || err?.code === 'kd_live') { M.changing = false; await refresh(); if (M === S && err.code === 'kd_live') showError(errText(err, "This bot is live, so its store can't be changed here.")); return; }
      // the list may have changed under the owner (a store shared, removed or made read-only): read it again
      if (['kd_store_shared', 'kd_store_unknown', 'kd_store_unwritable'].includes(err?.code)) { M.stores = null; render('store'); }
      else M.syncStore?.();
      showError(errText(err, "Couldn't use that store just now."));
    }
  }

  function render(state) {
    if (!M) return;
    const prev = M.state;
    M.state = state;
    const b = M.body;
    if (state === 'moving') M.movingSince ||= Date.now(); else M.movingSince = 0;
    const xBtn = M.dialog.querySelector('.co-x');
    if (xBtn) xBtn.hidden = moveHeld();
    const keepFocus = M.dialog.contains(document.activeElement) && document.activeElement !== M.dialog;
    b.innerHTML = '';
    if (state !== 'blocked') clearError();
    const s = last || {};
    if (state === 'loading') { setSteps('account'); b.append(h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), 'Checking your KnowDrive account…')); }
    else if (state === 'start') {
      setSteps('account');
      b.append(
        cta('Create your KnowDrive account', () => signIn('signup'), { id: 'kda-create', ico: 'arrowRight' }),
        h('p', { class: 'kda-alt' }, link('I already have an account', () => signIn('signin'), 'kda-signin')),
        h('p', { class: 'kda-fine' }, 'Free to create. It opens in a small window; you come straight back here.'));
    } else if (state === 'waiting') {
      setSteps('account');
      // onboarding (live run): a new KnowDrive account is confirmed by email, and that link ends on KnowDrive's own site,
      // not back here. So the wait says what to expect and gives the one way to finish: sign in again, now with a password.
      const again = M.url ? h('a', { class: 'co-cta kda-cta', href: M.url, target: '_blank', rel: 'opener', id: 'kda-open' }, h('span', { class: 'co-cta-label' }, 'I\u2019ve set my password: continue'), h('span', { class: 'co-cta-ico', html: icon('arrowRight', 15) })) : null;
      b.append(h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), 'Finish in the KnowDrive window…'),
        h('p', { class: 'kda-fine' }, 'New to KnowDrive? It emails you a link to set your password. Once that\u2019s done, come back here and continue.'),
        again,
        h('p', { class: 'kda-alt' }, link('Cancel', () => { try { M.popup?.close(); } catch { /* ignore */ } render('start'); }, 'kda-cancel')));
      poll();
    } else if (state === 'blocked') {
      setSteps('account');
      const a = h('a', { class: 'co-cta kda-cta', href: M.url, target: '_blank', rel: 'opener', id: 'kda-fallback' }, h('span', { class: 'co-cta-label' }, 'Open KnowDrive sign-in'), h('span', { class: 'co-cta-ico', html: icon('external', 15) }));
      a.addEventListener('click', () => { M.state = 'waiting'; later(() => render('waiting'), 50); });
      b.append(h('p', { class: 'kda-note', role: 'status' }, 'Your browser blocked the sign-in window. Open it here instead:'), a,
        h('p', { class: 'kda-alt' }, link('Back', () => render('start'), 'kda-back')));
    } else if (state === 'store') {
      setSteps('store');
      b.append(who());
      if (M.stores) renderStores(b);
      else if (M.storesFailed) b.append(h('p', { class: 'kda-alt' }, link('Try again', () => { clearError(); M.storesFailed = false; render('store'); }, 'kda-stores-again')), h('p', { class: 'kda-alt' }, link('Not you? Sign out', signOut, 'kda-signout')));
      else { b.append(h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), 'Reading your KnowDrive stores…')); loadStores(); }
    } else if (state === 'linked') {
      setSteps('files');
      const n = s.movable ?? null;
      b.append(who(), storeLine(), removedNote());
      if (s.samplesOnly) b.append(h('p', { class: 'kda-note' }, `${BotName()} only knows sample files, and sample files never move. Launch now and add your own files after, or add them first.`),
        cta('Continue without files', startMove, { id: 'kda-move' }));
      else if (s.learning) { b.append(h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), 'Some files are still learning. They move as soon as they are ready…')); later(startMove, 3000); }
      else b.append(cta(n != null ? `Move ${plural(n, 'file')} to KnowDrive` : 'Move my files to KnowDrive', startMove, { id: 'kda-move', ico: 'arrowRight' }));
      b.append(h('p', { class: 'kda-alt' }, link('Not you? Sign out', signOut, 'kda-signout')));
      // "Use <store>" is the owner's go-ahead: the files start moving into the store they just chose
      if (prev === 'store' && M.justChose) { M.justChose = false; if (!s.learning && !s.samplesOnly && s.movable) later(startMove, 0); }
    } else if (state === 'moving') {
      setSteps('files');
      const mv = s.move || {};
      const total = mv.total || 0, ready = mv.ready || 0, copied = Math.max(mv.copied || 0, ready);
      // two halves: copied into the account, then read by KnowDrive (so the bar moves from the start)
      const pct = total ? Math.round(((copied + ready) / (2 * total)) * 100) : 0;
      const held = moveHeld();
      const where = !total ? 'Getting started.' : copied < total ? `Copying: ${copied} of ${total}.` : `Copied. KnowDrive is reading them: ${ready} of ${total} ready.`;
      b.append(who(), storeLine({ change: false }), removedNote(),
        h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), `Moving ${plural(total, 'file')} into ${s.store?.name ? `"${s.store.name}"` : 'your KnowDrive account'}…`),
        h('div', { class: 'kda-bar', role: 'progressbar', 'aria-label': 'Files moved', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(ready), 'aria-valuetext': `${ready} of ${total} ready` },
          h('span', { style: { width: `${pct}%` } })),
        h('p', { class: 'kda-fine', id: 'kda-progress' }, `${where} ${held ? 'Please keep this open. It usually takes a minute or two, and checkout comes next.' : 'This is taking longer than usual. You can close this: it keeps going, and Launch picks up where it left off.'}`));
      poll();
    } else if (state === 'partial') {
      setSteps('files');
      const mv = s.move || {};
      const failed = Array.isArray(mv.failed) ? mv.failed : [];
      b.append(who(), storeLine(), h('p', { class: 'kda-note' }, failed.length ? `${plural(mv.ready || 0, 'file')} moved. ${plural(failed.length, 'file')} didn't:` : `The move stopped.${mv.ref ? ` (ref ${mv.ref})` : ''}`));
      if (failed.length) b.append(h('ul', { class: 'kda-failed' }, failed.slice(0, 6).map((f) => h('li', null, h('b', null, f.name || 'A file'), ' ', h('span', null, f.error || "Couldn't copy it.")))));
      b.append(cta('Try again', startMove, { id: 'kda-retry', ico: 'refresh' }));
    } else if (state === 'ready') {
      setSteps('checkout');
      const mv = s.move || {};
      b.append(who(), storeLine(), h('p', { class: 'kda-done' }, h('span', { class: 'kda-ok', html: icon('check', 15) }), s.live ? `${BotName()} answers from your KnowDrive account.` : `${plural(mv.ready || mv.total || 0, 'file')} ${(mv.ready || mv.total) === 1 ? 'is' : 'are'} in your KnowDrive account.`));
      if (s.live) b.append(cta('Done', () => close('close'), { id: 'kda-done' }));
      else b.append(cta('Continue to checkout', () => { const fn = M.onContinue; close('continue'); fn?.({ email: last?.email || null }); }, { id: 'kda-continue', ico: 'arrowRight' }));
    } else if (state === 'reconnect') {
      setSteps('account');
      b.append(h('p', { class: 'kda-note' }, `${BotName()} can't read its files because the KnowDrive sign-in stopped working.${s.ref ? ` (ref ${s.ref})` : ''}`),
        cta('Reconnect KnowDrive', () => signIn('signin'), { id: 'kda-reconnect', ico: 'refresh' }));
    }
    if (keepFocus || prev !== state) requestAnimationFrame(() => { if (M && (!M.dialog.contains(document.activeElement) || document.activeElement === M.dialog)) M.focusFirst(); });
  }

  function poll() {
    later(async () => {
      if (!M) return;
      if (M.state === 'waiting' && M.popup && M.popup.closed && M.popupWatched) {
        await status();
        if (!M) return;
        if (last?.status === 'none') { render('start'); showError('The sign-in window closed before you finished.'); return; }
      }
      await refresh();
    }, POLL_MS);
  }

  async function signIn(mode) {
    if (!M) return;
    clearError();
    // open the window inside the click (a window opened after an await is blocked), then point it at KnowDrive
    let w = null;
    try { w = window.open('', 'knowbot-kd-signin', 'popup,width=480,height=720'); } catch { w = null; }
    const btn = document.activeElement && M.dialog.contains(document.activeElement) ? document.activeElement : null;
    btn?.classList.add('is-busy'); btn?.setAttribute('aria-busy', 'true');
    try {
      const r = await api.kdStart(mode);
      if (!M) { try { w?.close(); } catch { /* ignore */ } return; }
      M.url = r.url;
      if (w && !w.closed) {
        try { w.location.href = r.url; M.popup = w; M.popupWatched = true; w.focus?.(); } catch { M.popup = null; }
      }
      if (M.popup) render('waiting');
      else render('blocked');
    } catch (err) {
      try { w?.close(); } catch { /* ignore */ }
      if (!M) return;
      render('start');
      showError(errText(err, "Couldn't open KnowDrive sign-in."));
    }
  }
  async function startMove() {
    if (!M) return;
    clearError();
    try {
      const r = await api.kdMove();
      last = { ...last, ...r };
      paint();
    } catch (err) {
      if (!M) return;
      if (err?.code === 'files_learning') { last = { ...last, learning: 1 }; render('linked'); return; }
      await status();
      if (!M) return;
      paint();
      showError(errText(err, "Couldn't move your files just now."));
    }
  }
  async function signOut() {
    try { last = await api.kdSignOut(); if (M) { M.changing = false; M.stores = null; M.removed = null; } render('start'); announce('Signed out of KnowDrive.', 'polite'); }
    catch (err) { showError(errText(err, "Couldn't sign out just now.")); }
  }

  // ------------------------------------------------------------------ "Reconnect KnowDrive" for a live bot
  function showNotice(s) {
    if (!s || s.status !== 'reconnect') { notice?.remove(); notice = null; return; }
    if (notice?.isConnected) return;
    const btn = h('button', { type: 'button', class: 'co-link kda-link', id: 'kda-notice-reconnect' }, 'Reconnect KnowDrive');
    btn.addEventListener('click', () => open({ invoker: btn, reconnect: true }));
    notice = h('div', { class: 'kda-notice', role: 'status' }, h('span', { class: 'co-err-ico', html: icon('warn', 15) }),
      h('span', null, `${BotName()} can't read its KnowDrive files right now, so it refuses questions.`), btn);
    document.body.append(notice);
  }
  on('kd:event', (d) => { if (d && typeof d === 'object') { last = { ...last, ...d }; showNotice(last); } });

  return {
    open, status, isReady, get last() { return last; },
    /** Boot check: a launched bot whose KnowDrive sign-in stopped working shows the reconnect notice. */
    async check() { const s = await status(); showNotice(s); return s; },
  };
}

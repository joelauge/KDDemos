// KnowBot Studio: the KnowDrive account step of Launch (owner decisions 1-4). Lazily imported by checkout.js.
//
//   Launch → this modal: create (or sign in to) a KnowDrive account in a popup → the bot's files move into the store
//   that account owns (progress from the trial's `kd` events) → "Continue to checkout" opens the existing checkout.
//   Also the "Reconnect KnowDrive" notice for a live bot whose KnowDrive sign-in stopped working.
//
// Server: /api/studio/trials/:id/kd (status, start, move, sign out); the popup ends on /api/studio/kd/callback, which
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

  const botName = () => getState().spec?.name || 'your bot';
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
  function close(reason = 'close') {
    if (!M) return;
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
    if (s.ready || s.live) return render('ready');
    const mv = s.move;
    if (mv && mv.state === 'moving') return render('moving');
    if (mv && (mv.state === 'partial' || mv.state === 'error' || mv.state === 'paused')) return render('partial');
    return render('linked');
  }
  function setSteps(active) {
    const order = ['account', 'files', 'checkout'];
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

  function render(state) {
    if (!M) return;
    const prev = M.state;
    M.state = state;
    const b = M.body;
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
      const again = M.url ? h('a', { class: 'co-link kda-link', href: M.url, target: '_blank', rel: 'opener', id: 'kda-open' }, 'Open the sign-in window again') : null;
      b.append(h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), 'Finish signing in to KnowDrive in the other window…'),
        h('p', { class: 'kda-alt' }, again, again ? ' · ' : null, link('Cancel', () => { try { M.popup?.close(); } catch { /* ignore */ } render('start'); }, 'kda-cancel')));
      poll();
    } else if (state === 'blocked') {
      setSteps('account');
      const a = h('a', { class: 'co-cta kda-cta', href: M.url, target: '_blank', rel: 'opener', id: 'kda-fallback' }, h('span', { class: 'co-cta-label' }, 'Open KnowDrive sign-in'), h('span', { class: 'co-cta-ico', html: icon('external', 15) }));
      a.addEventListener('click', () => { M.state = 'waiting'; later(() => render('waiting'), 50); });
      b.append(h('p', { class: 'kda-note', role: 'status' }, 'Your browser blocked the sign-in window. Open it here instead:'), a,
        h('p', { class: 'kda-alt' }, link('Back', () => render('start'), 'kda-back')));
    } else if (state === 'linked') {
      setSteps('files');
      const n = s.movable ?? null;
      b.append(who());
      if (s.samplesOnly) b.append(h('p', { class: 'kda-note' }, `${botName()} only knows sample files, and sample files never move. Launch now and add your own files after, or add them first.`),
        cta('Continue without files', startMove, { id: 'kda-move' }));
      else if (s.learning) { b.append(h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), 'Some files are still learning. They move as soon as they are ready…')); later(startMove, 3000); }
      else b.append(cta(n != null ? `Move ${plural(n, 'file')} to KnowDrive` : 'Move my files to KnowDrive', startMove, { id: 'kda-move', ico: 'arrowRight' }));
      b.append(h('p', { class: 'kda-alt' }, link('Not you? Sign out', signOut, 'kda-signout')));
      if (prev === 'waiting' || prev === 'loading' || prev === 'blocked') { if (!s.learning && !s.samplesOnly && s.movable) later(startMove, 0); }
    } else if (state === 'moving') {
      setSteps('files');
      const mv = s.move || {};
      const total = mv.total || 0, ready = mv.ready || 0;
      const pct = total ? Math.round((ready / total) * 100) : 0;
      b.append(who(),
        h('p', { class: 'kda-wait' }, h('span', { class: 'kda-spin', 'aria-hidden': 'true' }), `Moving ${plural(total, 'file')} into your KnowDrive account…`),
        h('div', { class: 'kda-bar', role: 'progressbar', 'aria-label': 'Files moved', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(ready), 'aria-valuetext': `${ready} of ${total} ready` },
          h('span', { style: { width: `${pct}%` } })),
        h('p', { class: 'kda-fine', id: 'kda-progress' }, `${ready} of ${total} ready. You can close this; it keeps going.`));
      poll();
    } else if (state === 'partial') {
      setSteps('files');
      const mv = s.move || {};
      const failed = Array.isArray(mv.failed) ? mv.failed : [];
      b.append(who(), h('p', { class: 'kda-note' }, failed.length ? `${plural(mv.ready || 0, 'file')} moved. ${plural(failed.length, 'file')} didn't:` : `The move stopped.${mv.ref ? ` (ref ${mv.ref})` : ''}`));
      if (failed.length) b.append(h('ul', { class: 'kda-failed' }, failed.slice(0, 6).map((f) => h('li', null, h('b', null, f.name || 'A file'), ' ', h('span', null, f.error || "Couldn't copy it.")))));
      b.append(cta('Try again', startMove, { id: 'kda-retry', ico: 'refresh' }));
    } else if (state === 'ready') {
      setSteps('checkout');
      const mv = s.move || {};
      b.append(who(), h('p', { class: 'kda-done' }, h('span', { class: 'kda-ok', html: icon('check', 15) }), s.live ? `${botName()} answers from your KnowDrive account.` : `${plural(mv.ready || mv.total || 0, 'file')} ${(mv.ready || mv.total) === 1 ? 'is' : 'are'} in your KnowDrive account.`));
      if (s.live) b.append(cta('Done', () => close('close'), { id: 'kda-done' }));
      else b.append(cta('Continue to checkout', () => { const fn = M.onContinue; close('continue'); fn?.({ email: last?.email || null }); }, { id: 'kda-continue', ico: 'arrowRight' }));
    } else if (state === 'reconnect') {
      setSteps('account');
      b.append(h('p', { class: 'kda-note' }, `${botName()} can't read its files because the KnowDrive sign-in stopped working.${s.ref ? ` (ref ${s.ref})` : ''}`),
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
    try { last = await api.kdSignOut(); render('start'); announce('Signed out of KnowDrive.', 'polite'); }
    catch (err) { showError(errText(err, "Couldn't sign out just now.")); }
  }

  // ------------------------------------------------------------------ "Reconnect KnowDrive" for a live bot
  function showNotice(s) {
    if (!s || s.status !== 'reconnect') { notice?.remove(); notice = null; return; }
    if (notice?.isConnected) return;
    const btn = h('button', { type: 'button', class: 'co-link kda-link', id: 'kda-notice-reconnect' }, 'Reconnect KnowDrive');
    btn.addEventListener('click', () => open({ invoker: btn, reconnect: true }));
    notice = h('div', { class: 'kda-notice', role: 'status' }, h('span', { class: 'co-err-ico', html: icon('warn', 15) }),
      h('span', null, `${botName()} can't read its KnowDrive files right now, so it refuses questions.`), btn);
    document.body.append(notice);
  }
  on('kd:event', (d) => { if (d && typeof d === 'object') { last = { ...last, ...d }; showNotice(last); } });

  return {
    open, status, isReady, get last() { return last; },
    /** Boot check: a launched bot whose KnowDrive sign-in stopped working shows the reconnect notice. */
    async check() { const s = await status(); showNotice(s); return s; },
  };
}

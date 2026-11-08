/* KnowBot Studio first view (landing). Classic deferred script: no imports, no network.
 *
 * Shown while html[data-landing] is set (index.html pre-paint: first-time visitors only, never with a ?t= or
 * ?launched= link). The visitor types what they want (or picks one of three ways in) and the landing hands off to
 * the Studio underneath, which has been hydrating the whole time:
 *   - window.__studio.landing(action) exists once app.js has rendered the Builder: called directly;
 *   - otherwise the action waits in window.__kbLanding, and app.js drains it right after it renders the Builder.
 * action = { text } (sent as the visitor's first Builder message) | { chip: 'use_samples' | 'upload_files' }.
 * window.__kbLandingShow() brings the landing back (app.js calls it after "Start over").
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var el = document.getElementById('kl-landing');
  if (!el) return;
  var form = document.getElementById('kl-form');
  var input = document.getElementById('kl-input');
  var phText = document.getElementById('kl-ph-text');

  var EXAMPLES = [
    'a support bot for my bike shop',
    'answers from my product manual',
    'help my customers with returns',
    "answers from my website's FAQ",
    "my Shopify store's FAQ",
  ];
  var reduced = function () { return root.getAttribute('data-motion') === 'reduce'; };
  var showing = function () { return root.hasAttribute('data-landing'); };
  var desktop = function () { try { return matchMedia('(min-width: 761px) and (pointer: fine)').matches; } catch (e) { return false; } };

  // ------------------------------------------------------------ typewriter placeholder (aria-hidden overlay; the
  // input's own label and description are static, so nothing is announced while it types)
  var ex = 0, pos = EXAMPLES[0].length, phase = 'hold', timer = 0;
  var current = EXAMPLES[0];          // the example on screen (its full text): an empty submit uses it
  function paint() { phText.textContent = current.slice(0, pos); }
  function step() {
    timer = 0;
    if (!showing() || document.hidden || input.value) return;   // resumes on input/visibility
    var wait;
    if (phase === 'type') {
      pos++; paint();
      if (pos >= current.length) { phase = 'hold'; wait = 2100; } else wait = 38 + Math.random() * 46;
    } else if (phase === 'hold') {
      phase = 'erase'; wait = 0;
    } else {
      pos = Math.max(0, pos - 2); paint();
      if (pos === 0) { ex = (ex + 1) % EXAMPLES.length; current = EXAMPLES[ex]; phase = 'type'; wait = 260; } else wait = 18;
    }
    timer = setTimeout(step, wait);
  }
  function startTyping(delay) {
    stopTyping();
    if (reduced()) { ex = 0; current = EXAMPLES[0]; pos = current.length; paint(); return; }
    timer = setTimeout(step, delay == null ? 2100 : delay);
  }
  function stopTyping() { if (timer) { clearTimeout(timer); timer = 0; } }
  function syncValue() {
    var has = !!input.value;
    el.classList.toggle('has-value', has);
    if (has) stopTyping();
    else if (!timer && showing()) { pos = current.length; paint(); phase = 'hold'; startTyping(1400); }
  }
  input.addEventListener('input', syncValue);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && showing() && !input.value && !timer) startTyping(600); });

  // ------------------------------------------------------------ hand-off into the Studio
  var leaving = false;
  function deliver(action) {
    var s = window.__studio;
    if (s && typeof s.landing === 'function') s.landing(action);
    else window.__kbLanding = action;          // app.js drains this once the Builder exists
  }
  function focusAfter(kind) {
    if (kind === 'upload') return;             // the file picker (or the focused Upload chip) owns focus
    var composer = document.getElementById('st-setup-composer');
    var log = document.getElementById('st-log');
    var target = (kind === 'text' || kind === 'store') && desktop() ? composer : (log || composer);
    if (target && target.focus) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
  }
  function leave(action, kind) {
    if (leaving || !showing()) return;
    leaving = true;
    stopTyping();
    // the file picker needs the visitor's click: when the Studio is ready, open it inside this click
    var early = kind === 'upload' && window.__studio && typeof window.__studio.landing === 'function';
    if (early) deliver(action);
    var swap = function () {
      root.removeAttribute('data-landing');
      if (!early) deliver(action);
    };
    var done = function () { leaving = false; root.classList.remove('kl-vt'); focusAfter(kind); };
    if (reduced()) { swap(); done(); return; }
    if (typeof document.startViewTransition === 'function') {
      root.classList.add('kl-vt');
      var vt;
      try { vt = document.startViewTransition(swap); } catch (e) { vt = null; }
      if (!vt) { swap(); done(); return; }
      vt.finished.then(done, done);
      return;
    }
    el.classList.add('kl-leaving');
    setTimeout(function () {
      el.classList.remove('kl-leaving');
      swap();
      root.classList.add('kl-enter');
      setTimeout(function () { root.classList.remove('kl-enter'); }, 400);
      done();
    }, 240);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = (input.value || '').trim() || current;
    leave({ text: text }, 'text');
  });
  el.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-kl]');
    if (!b) return;
    var k = b.getAttribute('data-kl');
    if (k === 'sample') leave({ chip: 'use_samples' }, 'sample');
    else if (k === 'upload') leave({ chip: 'upload_files' }, 'upload');
    else if (k === 'store') leave({ chip: 'import_store' }, 'store');
  });

  // While the landing is up, the Studio's global keys (Cmd/Ctrl+K palette, "/" focus) stay asleep.
  window.addEventListener('keydown', function (e) {
    if (!showing()) return;
    var k = e.key;
    if (((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'K')) || (k === '/' && e.target !== input) || ((k === 'j' || k === 'J') && e.target !== input)) e.stopPropagation();
  }, true);

  // ------------------------------------------------------------ show (first paint, or again after "Start over")
  function show() {
    input.value = '';
    el.classList.remove('has-value', 'kl-leaving');
    ex = 0; current = EXAMPLES[0]; pos = current.length; phase = 'hold'; paint();
    el.scrollTop = 0;
    startTyping();
    if (desktop()) { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
  }
  window.__kbLandingShow = function () {
    if (showing()) return;
    var on = function () { root.setAttribute('data-landing', ''); show(); };
    if (!reduced() && typeof document.startViewTransition === 'function') { try { document.startViewTransition(on); return; } catch (e) { /* fall through */ } }
    on();
  };

  if (showing()) {
    paint();
    if (input.value) syncValue(); else startTyping();   // a value the browser restored is kept
    if (desktop()) { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
  }
})();

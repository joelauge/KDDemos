/* KnowBot Studio landing: the floating showcase. The visitor sees their bot in the shape they picked under "Where should
 * it answer?" — a website chat, a text message, WhatsApp, an email, a phone call or the web voice assistant — on a
 * gently hovering device beside the hero. A small selector on top previews any shape; with two or more picked, arrows
 * and dots slide between the picked ones. Classic deferred script: no imports, no network. Mounts into #kl-show and
 * follows the [data-surface] buttons in #kl-surf (aria-pressed). Motion respects html[data-motion="reduce"] and
 * prefers-reduced-motion (no hover, no slide, the conversation is shown already answered).
 */
(function () {
  'use strict';
  var host = document.getElementById('kl-show');
  if (!host) return;
  var root = document.documentElement;
  var reduced = function () {
    if (root.getAttribute('data-motion') === 'reduce') return true;
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };

  var SHAPES = [
    { id: 'webchat', label: 'Website chat' },
    { id: 'sms', label: 'SMS' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'email', label: 'Email' },
    { id: 'phone', label: 'Phone' },
    { id: 'webvoice', label: 'Web voice' },
    { id: 'site', label: 'Single-page site' },
  ];
  var ICON = {
    webchat: '<path d="M4 5h16v11H9l-5 4z"/>',
    sms: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    whatsapp: '<path d="M4.5 19.5l1.2-3.6A8 8 0 1 1 8.6 18.6z"/>',
    email: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
    webvoice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    site: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18"/><circle cx="11" cy="14" r="2.6"/><path d="m13 16 2.2 2.2"/>',
  };
  var svg = function (id, s) { return '<svg width="' + (s || 16) + '" height="' + (s || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[id] + '</svg>'; };
  var Q = 'How long is the warranty?';
  var A = 'E-bike batteries are covered for 2 years or 800 charge cycles.';
  var SRC = 'Warranty & Returns';
  var BOT = 'Lumen Bikes';

  // ------------------------------------------------------------ the six mock screens (static, accessible text)
  function screen(id) {
    switch (id) {
      case 'sms': return '' +
        '<div class="ks-phone ks-sms"><div class="ks-ph-top"><span class="ks-av">LB</span><b>' + BOT + '</b><small>Text message</small></div>' +
        '<div class="ks-thread"><p class="ks-b ks-me ks-step1">' + Q + '</p><p class="ks-dots ks-step2" aria-hidden="true"><i></i><i></i><i></i></p>' +
        '<p class="ks-b ks-bot ks-step3">' + A.replace(/\.$/, '') + ' [1]. Proof: <u>kb.link/p/x4k2</u></p></div>' +
        '<div class="ks-bar"><span>Text message</span><i class="ks-send"></i></div></div>';
      case 'whatsapp': return '' +
        '<div class="ks-phone ks-wa"><div class="ks-ph-top"><span class="ks-av">LB</span><b>' + BOT + '</b><small>Business account</small></div>' +
        '<div class="ks-thread"><p class="ks-b ks-me ks-step1">' + Q + '<span class="ks-tick">✓✓</span></p><p class="ks-dots ks-step2" aria-hidden="true"><i></i><i></i><i></i></p>' +
        '<p class="ks-b ks-bot ks-step3">' + A.replace(/\.$/, '') + ' [1].<br><br><b>Sources</b><br>[1] ' + SRC + '</p></div>' +
        '<div class="ks-bar"><span>Message</span><i class="ks-send"></i></div></div>';
      case 'email': return '' +
        '<div class="ks-mail"><div class="ks-mail-top"><i></i><i></i><i></i><span>Inbox</span></div>' +
        '<div class="ks-mail-msg ks-step1"><span class="ks-av">You</span><div><b>You</b><small>' + Q + '</small></div></div>' +
        '<div class="ks-mail-msg is-bot ks-step3"><span class="ks-av">LB</span><div><b>' + BOT + ' Help</b><small>Re: ' + Q + '</small>' +
        '<p>Hi,</p><p>' + A.replace(/\.$/, '') + '<sup>[1]</sup>.</p><p class="ks-src"><b>Sources</b><br>[1] ' + SRC + ' · “E-bike batteries: 2 years or 800 charge cycles”</p></div></div></div>';
      case 'phone': return '' +
        '<div class="ks-phone ks-call"><div class="ks-call-head"><span class="ks-av ks-av-lg">LB</span><b>' + BOT + '</b><small class="ks-timer">00:12</small></div>' +
        '<div class="ks-caps"><p class="ks-cap ks-me ks-step1">' + Q + '</p><p class="ks-cap ks-bot ks-step3">According to the ' + SRC.replace('&', 'and') + ' page, e-bike batteries are covered for 2 years or 800 charge cycles.</p></div>' +
        '<div class="ks-wave ks-step3" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
        '<div class="ks-call-btns" aria-hidden="true"><i></i><i></i><i></i><i class="ks-hang"></i></div></div>';
      case 'webvoice': return '' +
        '<div class="ks-site"><div class="ks-site-top"><i></i><i></i><i></i><span>lumenbikes.com</span></div><div class="ks-site-body"><span></span><span></span><span class="short"></span>' +
        '<div class="ks-vw"><div class="ks-vw-head"><span class="ks-mic">' + svg('webvoice', 18) + '</span><b>Ask ' + BOT + '</b><small class="ks-step3">Answering…</small></div>' +
        '<p class="ks-cap ks-me ks-step1">“' + Q + '”</p><div class="ks-wave ks-step3" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
        '<p class="ks-cap ks-bot ks-step3">' + A + '</p><span class="ks-chip ks-step3">1 · ' + SRC + '</span></div></div></div>';
      case 'site': return '' +
        '<div class="ks-site ks-onepage"><div class="ks-site-top"><i></i><i></i><i></i><span>lumenbikes.com</span></div><div class="ks-op-body">' +
        '<b class="ks-op-h">' + BOT + '</b><p class="ks-op-box ks-step1">' + Q + '</p><p class="ks-op-chips" aria-hidden="true"><i>Warranty</i><i>Returns</i><i>Shipping</i></p>' +
        '<p class="ks-cap ks-bot ks-step3">' + A + ' <span class="ks-n">1</span></p><span class="ks-chip ks-step3">Sources · 1 · ' + SRC + '</span></div></div>';
      default: return '' +
        '<div class="ks-site"><div class="ks-site-top"><i></i><i></i><i></i><span>lumenbikes.com</span></div><div class="ks-site-body"><span></span><span></span><span class="short"></span>' +
        '<div class="ks-chat"><div class="ks-chat-head"><span class="ks-av">LB</span><b>' + BOT + ' Help</b><small>Answers from our docs</small></div>' +
        '<div class="ks-thread"><p class="ks-b ks-me ks-step1">' + Q + '</p><p class="ks-dots ks-step2" aria-hidden="true"><i></i><i></i><i></i></p>' +
        '<p class="ks-b ks-bot ks-step3">' + A + ' <span class="ks-n">1</span></p><span class="ks-chip ks-step3">1 · ' + SRC + '</span></div></div></div></div>';
    }
  }

  // ------------------------------------------------------------ frame
  host.innerHTML = '' +
    '<div class="ks-float">' +
      '<div class="ks-sel" role="radiogroup" aria-label="Preview your bot as"></div>' +
      '<div class="ks-stage" aria-live="polite"><div class="ks-slide"></div></div>' +
      '<div class="ks-nav" hidden><button type="button" class="ks-arrow" data-dir="-1" aria-label="Previous place it answers">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>' +
        '<span class="ks-dots-nav" role="group" aria-label="Places it answers"></span>' +
        '<button type="button" class="ks-arrow" data-dir="1" aria-label="Next place it answers">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></div>' +
      '<p class="ks-cap-line"></p>' +
    '</div><div class="ks-shadow" aria-hidden="true"></div>';
  var sel = host.querySelector('.ks-sel');
  var stage = host.querySelector('.ks-stage');
  var nav = host.querySelector('.ks-nav');
  var dotsEl = host.querySelector('.ks-dots-nav');
  var capLine = host.querySelector('.ks-cap-line');
  var current = 'webchat';
  var CAPTION = {
    webchat: 'A chat on your website. Every answer shows its source.',
    sms: 'Customers text your number; the reply fits in a text, with a proof link.',
    whatsapp: 'Answers on WhatsApp, with numbered sources.',
    email: 'Replies to your support inbox, with footnoted sources.',
    phone: 'Callers ask out loud; it answers and names the source.',
    webvoice: 'A talk button on your website: it answers out loud.',
    site: 'A simple search box over your homepage. Answers link to your pages.',
  };

  SHAPES.forEach(function (s) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ks-opt'; b.setAttribute('role', 'radio'); b.setAttribute('data-shape', s.id);
    b.setAttribute('aria-label', s.label); b.title = s.label;
    b.innerHTML = svg(s.id, 16) + '<span class="ks-opt-mine" aria-hidden="true"></span>';
    b.addEventListener('click', function () { show(s.id, 0); });
    sel.appendChild(b);
  });
  sel.addEventListener('keydown', function (e) {
    var ids = SHAPES.map(function (s) { return s.id; }), i = ids.indexOf(current), n = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = ids[(i + 1) % ids.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = ids[(i - 1 + ids.length) % ids.length];
    if (n) { e.preventDefault(); show(n, 0); var b = sel.querySelector('[data-shape="' + n + '"]'); if (b) b.focus(); }
  });

  // ------------------------------------------------------------ the visitor's picks (#kl-surf)
  var surfEl = document.getElementById('kl-surf');
  function picked() {
    var on = surfEl ? [].slice.call(surfEl.querySelectorAll('[data-surface][aria-pressed="true"]')).map(function (b) { return b.getAttribute('data-surface'); }) : [];
    var order = SHAPES.map(function (s) { return s.id; });
    on = on.filter(function (x) { return order.indexOf(x) >= 0; }).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    return on.length ? on : ['webchat'];
  }
  function paintChrome() {
    var p = picked();
    [].forEach.call(sel.children, function (b) {
      var id = b.getAttribute('data-shape'), on = id === current;
      b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-mine', p.indexOf(id) >= 0);
    });
    nav.hidden = p.length < 2;
    dotsEl.innerHTML = '';
    p.forEach(function (id) {
      var d = document.createElement('button');
      d.type = 'button'; d.className = 'ks-dot' + (id === current ? ' is-on' : '');
      d.setAttribute('aria-label', SHAPES.filter(function (s) { return s.id === id; })[0].label);
      if (id === current) d.setAttribute('aria-current', 'true');
      d.addEventListener('click', function () { show(id, p.indexOf(id) > p.indexOf(current) ? 1 : -1); });
      dotsEl.appendChild(d);
    });
    capLine.textContent = CAPTION[current];
  }
  var swapTimer = 0;
  function show(id, dir) {
    if (id === current && stage.firstChild && stage.firstChild.getAttribute('data-shape') === id) { paintChrome(); return; }
    var prev = current;
    current = id;
    paintChrome();
    var next = document.createElement('div');
    next.className = 'ks-slide';
    next.setAttribute('data-shape', id);
    next.setAttribute('aria-label', SHAPES.filter(function (s) { return s.id === id; })[0].label + ' preview');
    next.innerHTML = screen(id);
    var old = stage.firstChild;
    clearTimeout(swapTimer);
    if (reduced() || !old || !old.getAttribute('data-shape')) {
      stage.innerHTML = ''; stage.appendChild(next); next.classList.add('is-done');
      return;
    }
    var d = dir || (SHAPES.map(function (s) { return s.id; }).indexOf(id) >= SHAPES.map(function (s) { return s.id; }).indexOf(prev) ? 1 : -1);
    next.classList.add(d > 0 ? 'ks-in-r' : 'ks-in-l');
    old.classList.add(d > 0 ? 'ks-out-l' : 'ks-out-r');
    stage.appendChild(next);
    swapTimer = setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); next.classList.remove('ks-in-r', 'ks-in-l'); next.classList.add('is-play'); }, 420);
  }
  nav.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.ks-arrow');
    if (!b) return;
    var p = picked(), i = p.indexOf(current), dir = Number(b.getAttribute('data-dir'));
    if (i < 0) i = dir > 0 ? -1 : 0;
    show(p[(i + dir + p.length) % p.length], dir);
  });
  // swipe on touch screens
  var tx = null;
  stage.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', function (e) {
    if (tx == null) return;
    var dx = e.changedTouches[0].clientX - tx; tx = null;
    var p = picked();
    if (Math.abs(dx) < 40 || p.length < 2) return;
    var i = Math.max(0, p.indexOf(current)), dir = dx < 0 ? 1 : -1;
    show(p[(i + dir + p.length) % p.length], dir);
  });
  // follow the picks: a newly picked surface comes into view; removing the shown one moves to the first left
  if (surfEl) {
    var before = picked();
    new MutationObserver(function () {
      var now = picked();
      var added = now.filter(function (x) { return before.indexOf(x) < 0; });
      before = now;
      if (added.length) show(added[added.length - 1], 1);
      else if (now.indexOf(current) < 0) show(now[0], -1);
      else paintChrome();
    }).observe(surfEl, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  }
  var start = picked()[0];
  current = '';
  show(start, 0);
  var first = stage.querySelector('.ks-slide');
  if (first && !reduced()) { first.classList.remove('is-done'); first.classList.add('is-play'); }
})();

// The Homepage search's look and behaviour, shared by Channels → Homepage search (golive.js siteTry) and the bot spec
// drawer (app.js): the business name, an uploaded logo (shown under the waving hand in place of the name) and when the
// search shows (until the visitor closes it, or on every visit), and voice mode's orb colour (one choice per bot: the
// Homepage search and web chat both use it). Every change saves at once (POST /site) and calls onSaved(view) so the
// caller can refresh its preview.

import * as api from './api.js?v=3b1a5da';
import { ORB_PRESETS, ORB_IDS, orbId, orbSwatch, createOrb } from '../lib/voice-orb.js?v=3b1a5da';

export const LOGO_BOX = { w: 600, h: 200 };          // the suggested size; uploads are fitted inside it
const LOGO_MAX = 150 * 1024;                          // matches server/site.mjs LOGO_MAX_BYTES
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

let seq = 0;
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value' || k === 'hidden' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

/** A file → a PNG (or WebP) data URL fitted inside 600x200, never upscaled, at most LOGO_MAX bytes. */
export async function fitLogo(file) {
  if (!file || !/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) throw new Error('Use a PNG, JPG, WebP or SVG image.');
  if (file.size > 5 * 1024 * 1024) throw new Error('That image is over 5 MB. Use a smaller file.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || LOGO_BOX.w, hh = img.naturalHeight || LOGO_BOX.h;
    if (w < 16 || hh < 16) throw new Error('That image is too small to read. Use one at least 200 px wide.');
    const k = Math.min(1, LOGO_BOX.w / w, LOGO_BOX.h / hh);
    w = Math.max(1, Math.round(w * k)); hh = Math.max(1, Math.round(hh * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    c.getContext('2d').drawImage(img, 0, 0, w, hh);
    for (const [type, q] of [['image/png'], ['image/webp', 0.92], ['image/webp', 0.8]]) {
      const d = c.toDataURL(type, q);
      if (!d.startsWith(`data:${type}`)) continue;
      if (Math.floor((d.length - d.indexOf(',') - 1) * 3 / 4) <= LOGO_MAX) return { dataUrl: d, w, h: hh };
    }
    throw new Error('That image is too detailed to fit in 150 KB. Try a simpler logo or a PNG with fewer colours.');
  } catch (e) {
    if (e instanceof Error && /Use|too/.test(e.message)) throw e;
    throw new Error("That image couldn't be read. Try a PNG or JPG.");
  } finally { URL.revokeObjectURL(url); }
}

/**
 * The settings block. view: the GET/POST /site response. Returns the element; it saves on its own.
 * orbOnly: only voice mode's orb colour (the bot spec drawer, for a bot with web chat but no Homepage search).
 * @param {{view: object, onSaved?: (view: object) => void, compact?: boolean, orbOnly?: boolean}} o
 */
export function siteSettings({ view, onSaved = () => {}, compact = false, orbOnly = false }) {
  const id = `ss${++seq}`;
  let v = view;
  const status = h('p', { class: 'ss-status', role: 'status', 'aria-live': 'polite' });
  const say = (t) => { status.textContent = t || ''; };
  async function save(body, done) {
    say('Saving…');
    try { v = await api.saveSite(body); onSaved(v); say(done); paintLogo(); return true; }
    catch (e) { say(e?.message || "Couldn't save that. Try again."); return false; }
  }

  // business name: saves when the field loses focus or Enter is pressed
  const name = h('input', { id: `${id}-name`, class: 'input ss-input', type: 'text', maxlength: '60', autocomplete: 'organization', name: 'kb-site-name', value: v.site?.name || '' });
  let lastName = name.value;
  const saveName = () => { const t = name.value.trim(); if (t === lastName.trim()) return; lastName = name.value; save({ name: t || null }, t ? 'Name saved.' : 'Name reset to the one from your files.'); };
  name.addEventListener('change', saveName);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveName(); } });

  // the line under the search box: empty = the default sentence
  const defLine = () => `Answers come only from ${v.site?.name || 'your'}'s own pages.`;
  const sub = h('input', { id: `${id}-sub`, class: 'input ss-input', type: 'text', maxlength: '140', name: 'kb-site-subline', value: v.site?.subline || '', placeholder: defLine() });
  let lastSub = sub.value;
  const saveSub = () => { const t = sub.value.trim(); if (t === lastSub.trim()) return; lastSub = sub.value; save({ subline: t || null }, t ? 'Line saved.' : 'Line reset to the default.'); };
  sub.addEventListener('change', saveSub);
  sub.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSub(); } });

  // logo
  const file = h('input', { type: 'file', accept: ACCEPT, class: 'ss-file', id: `${id}-file`, tabindex: '-1', 'aria-hidden': 'true' });
  const tile = h('div', { class: 'ss-logo-tile' });
  const up = h('button', { type: 'button', class: 'btn btn-ghost ss-btn', onclick: () => file.click() });
  const rm = h('button', { type: 'button', class: 'btn btn-ghost ss-btn ss-rm', onclick: async () => { rm.disabled = true; if (!(await save({ logo: null }, 'Logo removed. The business name shows instead.'))) rm.disabled = false; } }, 'Remove');
  function paintLogo() {
    const has = !!v.site?.logo?.path;
    tile.replaceChildren(has
      ? h('img', { src: `${(api.BASE || location.origin).replace(/\/+$/, '')}${v.site.logo.path}`, alt: `${v.site.name} logo` })
      : h('span', { class: 'ss-logo-none' }, h('b', null, v.site?.name || 'Your name'), h('small', null, 'No logo: the name shows')));
    up.textContent = has ? 'Replace logo' : 'Upload logo';
    rm.hidden = !has; rm.disabled = false; up.disabled = false;
    if (name.value.trim() !== (v.site?.name || '') && document.activeElement !== name) { name.value = v.site?.name || ''; lastName = name.value; }
    sub.placeholder = defLine();
    if (document.activeElement !== sub && sub.value.trim() !== (v.site?.subline || '')) { sub.value = v.site?.subline || ''; lastSub = sub.value; }
    for (const r of radios) r.checked = r.value === (v.site?.showOn === 'every-visit' ? 'every-visit' : 'until-dismissed');
    for (const r of orbRadios) r.checked = r.value === orbId(v.site?.orb);
    preview?.setPreset(orbId(v.site?.orb));
  }
  file.addEventListener('change', async () => {
    const f = file.files?.[0]; file.value = '';
    if (!f) return;
    up.disabled = true; say('Preparing your logo…');
    try {
      const { dataUrl, w, h: hh } = await fitLogo(f);
      await save({ logo: dataUrl }, `Logo saved (${w} × ${hh} px). It shows under the waving hand.`);
    } catch (e) { say(e.message); }
    up.disabled = false;
  });

  // when it shows
  const radios = [];
  const opt = (value, label, sub) => {
    const r = h('input', { type: 'radio', name: `${id}-show`, id: `${id}-show-${value}`, value });
    r.addEventListener('change', () => { if (r.checked) save({ showOn: value }, value === 'every-visit' ? 'Saved: it opens on every visit.' : 'Saved: it opens until the visitor closes it.'); });
    radios.push(r);
    return h('label', { class: 'ss-opt', for: r.id }, r, h('span', null, h('b', null, label), h('small', null, sub)));
  };

  // voice mode's orb: four colours, with a live orb that breathes and "listens" in the chosen one
  const orbRadios = [];
  const orbCanvas = h('canvas', { class: 'ss-orb-canvas', 'aria-hidden': 'true' });
  const orbOpt = (oid) => {
    const r = h('input', { type: 'radio', name: `${id}-orb`, id: `${id}-orb-${oid}`, value: oid, class: 'ss-orb-in' });
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      preview?.setPreset(oid);
      const ok = await save({ orb: oid }, `Saved: the ${ORB_PRESETS[oid].label} orb, in voice mode on your homepage search, web chat and web voice assistant.`);
      if (!ok) {
        // not saved: show the colour that is really saved, never a choice the server didn't keep
        const cur = orbId(v.site?.orb);
        for (const x of orbRadios) x.checked = x.value === cur;
        preview?.setPreset(cur);
      }
    });
    orbRadios.push(r);
    return h('label', { class: 'ss-orb-opt', for: r.id }, r, h('span', { class: 'ss-orb-sw', style: `background:${orbSwatch(oid)}`, 'aria-hidden': 'true' }), h('span', { class: 'ss-orb-name' }, ORB_PRESETS[oid].label));
  };
  const orbField = h('fieldset', { class: 'ss-field ss-set ss-orbs' }, h('legend', { class: 'ss-l' }, 'Voice mode colour'),
    h('div', { class: 'ss-orb-row' }, h('div', { class: 'ss-orb-preview' }, orbCanvas), h('div', { class: 'ss-orb-opts' }, ORB_IDS.map(orbOpt))),
    h('p', { class: 'ss-hint' }, 'Visitors who press the mic see this orb. It moves with their voice while it listens, and with the answer while it speaks.'));
  let preview = null;
  try {
    preview = createOrb(orbCanvas, { preset: orbId(v.site?.orb), maxPixels: 256 });
    preview.setState('listening');
    // a calm, speech-like level so the preview shows how it reacts
    const t0 = performance.now();
    preview.setLevelSource(() => { const t = (performance.now() - t0) / 1000; return Math.max(0, 0.25 + 0.3 * Math.sin(t * 2.1) * Math.sin(t * 5.3)); });
    // (it draws only while on screen: a closed drawer or a removed block costs nothing)
  } catch { preview = null; }

  if (orbOnly) {
    const one = h('div', { class: `ss${compact ? ' ss-compact' : ''}` }, orbField, status);
    paintLogo();
    return one;
  }
  const el = h('div', { class: `ss${compact ? ' ss-compact' : ''}` },
    h('div', { class: 'ss-field' }, h('label', { class: 'ss-l', for: name.id }, 'Business name'), name,
      h('p', { class: 'ss-hint' }, 'Used for the search box and the "Ask" button. A logo replaces it under the wave.')),
    h('div', { class: 'ss-field' }, h('label', { class: 'ss-l', for: sub.id }, 'Line under the search box'), sub,
      h('p', { class: 'ss-hint' }, 'Up to 140 characters. Leave it empty for the default shown in grey.')),
    h('div', { class: 'ss-field' }, h('span', { class: 'ss-l', id: `${id}-logo-l` }, 'Logo'),
      h('div', { class: 'ss-logo', role: 'group', 'aria-labelledby': `${id}-logo-l` }, tile, h('div', { class: 'ss-logo-act' }, up, rm)), file,
      h('p', { class: 'ss-hint' }, `Suggested: ${LOGO_BOX.w} × ${LOGO_BOX.h} px (3:1), a PNG or SVG with a transparent background. Square logos work too. Larger images are fitted to that size.`)),
    h('fieldset', { class: 'ss-field ss-set' }, h('legend', { class: 'ss-l' }, 'When it shows'),
      opt('until-dismissed', 'Until the visitor closes it', 'Opens on each visit until they close it with ×. After that, only the small "Ask" button shows.'),
      opt('every-visit', 'On every visit', 'Opens every time someone visits your homepage, even if they closed it before.')),
    orbField,
    status);
  paintLogo();
  return el;
}

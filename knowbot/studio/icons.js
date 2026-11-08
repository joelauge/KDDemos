// KnowBot Studio: inline SVG icons (owner B). 24×24 grid, 1.75 stroke, currentColor. No icon font, no network.
//
// Usage (also via ctx.icons):
//   icon('shield')                       -> '<svg …>…</svg>' (aria-hidden; decorative)
//   icon('copy', { size: 14, label: 'Copy' }) -> role="img" with a <title> when a label is given
//   fileIcon('pdf', { size: 16 })        -> the icon for a FileState.kind
//   iconEl('check')                      -> an SVGElement (for appendChild)
//   ICONS                                 -> name -> inner markup; has(name)

const S = (d) => `<path d="${d}"/>`;

export const ICONS = {
  // brand + roles
  logo: '<path fill="currentColor" stroke="none" d="M2.6 3.5h1.3a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H2.6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path fill="currentColor" stroke="none" d="M9.2 13.9 11 12.1l8.8 8.4c.2.1 0 .4-.1.4h-4.9a1.7 1.7 0 0 1-1.2-.5l-4.4-4.4a1.5 1.5 0 0 1 0-2.1Z"/><path fill="currentColor" stroke="none" d="m9.1 15.8-2.4-2.3a1.9 1.9 0 0 1 0-2.7l6.6-6.6a2.7 2.7 0 0 1 1.9-.8h6.4c.4 0 .8.1 1.2.2 1.8.6 6.5 2.6 6.5 8.2 0 7.1-5 8.5-5.4 8.7l-1.4.3a2 2 0 0 1-1.5-.6l-2-2.1c-.1-.2 0-.4.1-.4h1.9c.6-.1 4.5-1 4.5-5.5 0-4.1-4.2-4.9-5-4.9h-2.8l-1.1.1a2.6 2.6 0 0 0-1.7.7l-2.6 2.5-3 3.1c-.3.3-.5.9-.5 1.2 0 .4.3.8.3.8Z" transform="scale(.82) translate(-.4 1.6)"/>',
  builder: '<path d="M12 3.5 13.7 8l4.8.3-3.7 3 1.2 4.7L12 13.4 8 16l1.2-4.7-3.7-3L10.3 8Z"/><path d="M5 20h14" opacity=".55"/>',
  bot: '<rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3.5V7M9 12.5h.01M15 12.5h.01M9.5 16h5"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 6.2a3 3 0 0 1 0 5.6M17 14.2a5.5 5.5 0 0 1 3.5 4.8"/>',
  // status
  shield: '<path d="M12 3.2 19 6v5.4c0 4.3-2.9 7.9-7 9.4-4.1-1.5-7-5.1-7-9.4V6Z"/>',
  shieldCheck: '<path d="M12 3.2 19 6v5.4c0 4.3-2.9 7.9-7 9.4-4.1-1.5-7-5.1-7-9.4V6Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  check: S('m5 12.5 4.5 4.5L19 7.5'),
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.4 12.3 2.5 2.5 4.8-5"/>',
  x: S('M6.5 6.5l11 11M17.5 6.5l-11 11'),
  close: S('M6.5 6.5l11 11M17.5 6.5l-11 11'),
  warn: '<path d="M12 4 21 19.5H3Z"/><path d="M12 10v4.2M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bolt: S('M13 3 5 13.5h6L10 21l8-10.5h-6Z'),
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  // actions
  upload: S('M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15'),
  paperclip: S('m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2a3.4 3.4 0 0 1 4.8 4.8l-8.2 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4'),
  send: S('M5 12h12.5M12.5 6.5 18 12l-5.5 5.5'),
  arrowUp: S('M12 19V5.5M6.5 11 12 5.5 17.5 11'),
  arrowRight: S('M5 12h14M13.5 6.5 19 12l-5.5 5.5'),
  chevronDown: S('m6.5 9.5 5.5 5.5 5.5-5.5'),
  chevronRight: S('m9.5 6.5 5.5 5.5-5.5 5.5'),
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.2"/><path d="m4 7 8 6 8-6"/>',
  link: S('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2'),
  refresh: S('M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2'),
  undo: S('M9 14 4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3'),
  play: S('M8 5.5v13l10.5-6.5Z'),
  pin: S('M9 4.5h6M10 4.5v5L7 13h10l-3-3.5v-5M12 13v6.5'),
  table: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17M3.5 14.5h17M9.5 10v9"/>',
  command: S('M9 6.5a2.5 2.5 0 1 0-2.5 2.5H17.5a2.5 2.5 0 1 0-2.5-2.5v11a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 17.5Z'),
  edit: S('M14.5 5.5 18.5 9.5M4.5 19.5l1-4.5L15.7 4.8a1.6 1.6 0 0 1 2.3 0l1.2 1.2a1.6 1.6 0 0 1 0 2.3L9 18.5Z'),
  sliders: S('M5 7h9M18 7h1M5 17h3M12 17h7M14 4.5v5M8 14.5v5'),
  eye: '<path d="M2.8 12S6 5.5 12 5.5 21.2 12 21.2 12 18 18.5 12 18.5 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  layers: S('M12 4 3.5 8.5 12 13l8.5-4.5ZM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5'),
  chart: S('M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8'),
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  flask: S('M9.5 3.5h5M10.5 3.5v5.5L5 18.5A1.5 1.5 0 0 0 6.3 20.5h11.4a1.5 1.5 0 0 0 1.3-2L13.5 9V3.5M7.5 14.5h9'),
  rocket: S('M12 15.5 8.5 12c1.2-4.5 4-7.6 10-8.5-.9 6-4 8.8-8.5 10Zm-3.5-3.5-3 .5 2-3.5h3.2M12 15.5l-.5 3 3.5-2V13M7 17c-1 .5-1.5 2-1.5 2s1.5-.5 2-1.5'),
  file: S('M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5ZM13.5 3.5v5h5'),
  folder: S('M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z'),
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: S('M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z'),
  motion: '<path d="M4 12h3M4 7.5h6M4 16.5h5"/><circle cx="16" cy="12" r="4.2"/>',
  motionOff: '<path d="M4 12h3M4 7.5h6M4 16.5h5"/><circle cx="16" cy="12" r="4.2"/><path d="m3.5 3.5 17 17"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  phone: S('M6.5 3.5h2.8l1.4 4-2 1.3a10.5 10.5 0 0 0 6.5 6.5l1.3-2 4 1.4v2.8a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z'),
  chat: S('M5 5.5h14A1.5 1.5 0 0 1 20.5 7v9a1.5 1.5 0 0 1-1.5 1.5H10L6 20.5v-3H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5Z'),
  code: S('m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13'),
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2-2.4 3.6M12 17h.01"/>',
  trending: S('M3.5 17 9.5 11l4 4 7-7.5M15 7.5h5.5V13'),
  sparkline: S('M3.5 15.5 7.5 11l3.5 3 4-6 5.5 5'),
  atom: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(120 12 12)"/>',
  map: '<circle cx="6.5" cy="8" r="1.6"/><circle cx="16.5" cy="6.5" r="1.6"/><circle cx="12" cy="13" r="1.6"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17.5" cy="16.5" r="1.6"/>',
  card: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M3.5 10h17M7 14.5h3"/>',
  external: S('M13.5 4.5h6v6M19.5 4.5l-8 8M10 5.5H6A1.5 1.5 0 0 0 4.5 7v11A1.5 1.5 0 0 0 6 19.5h11a1.5 1.5 0 0 0 1.5-1.5v-4'),
  minus: S('M6 12h12'),
  plus: S('M12 6v12M6 12h12'),
};

// File-kind glyphs: the page outline plus a tiny mono label, so kind never relies on color alone.
const KIND_LABEL = { pdf: 'PDF', docx: 'DOC', pptx: 'PPT', xlsx: 'XLS', html: 'HTM', md: 'MD', txt: 'TXT', image: 'IMG', audio: 'AUD' };

function svg(inner, { size = 16, label = '', cls = '', viewBox = '0 0 24 24', stroke = 1.75 } = {}) {
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"';
  const title = label ? `<title>${esc(label)}</title>` : '';
  return `<svg class="st-ico${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${title}${inner}</svg>`;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export function has(name) { return Object.prototype.hasOwnProperty.call(ICONS, name); }

/** SVG markup string. Unknown names render the generic dot (and warn once). */
export function icon(name, opts = {}) {
  if (!has(name)) { if (!warned.has(name)) { warned.add(name); console.warn(`[studio] unknown icon "${name}"`); } name = 'dot'; }
  const o = typeof opts === 'number' ? { size: opts } : opts;
  return svg(ICONS[name], o);
}
const warned = new Set();

/** File icon for a FileState.kind ('pdf'|'docx'|'pptx'|'xlsx'|'html'|'md'|'txt'|'image'|'audio'). */
export function fileIcon(kind, opts = {}) {
  const o = typeof opts === 'number' ? { size: opts } : opts;
  const k = String(kind || '').toLowerCase();
  if (k === 'image') return svg('<rect x="4" y="4.5" width="16" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4.5 17 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>', o);
  if (k === 'audio') return svg('<path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3"/>', o);
  const label = KIND_LABEL[k];
  if (!label) return svg(ICONS.file, o);
  return svg(`${ICONS.file}<text x="12" y="17.6" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, monospace" font-size="${label.length > 2 ? 5.2 : 6}" font-weight="600" fill="currentColor" stroke="none">${label}</text>`, o);
}

/** Same as icon() but returns an element. */
export function iconEl(name, opts = {}) {
  const t = document.createElement('template');
  t.innerHTML = icon(name, opts);
  return t.content.firstElementChild;
}

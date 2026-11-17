// The e-mail that warns a bot's owner before an unlaunched (trial) bot stops answering on their website.
// Sent by the Studio's hourly pass (server/trials.mjs warnExpiring) at 3 days and at 1 day before the trial ends.
// Same house style as "send me this" e-mail (server/sendinfo-render.mjs): one 600 px column, tables only, inline
// styles, safe in dark mode, and a plain-text part that says the same thing. Pure functions: nothing here sends.
import { esc } from './sendinfo-render.mjs';

const DAY = 86400000, HOUR = 3600000;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { bg: '#f3f4f6', card: '#ffffff', line: '#e5e7eb', text: '#1f2328', muted: '#5f6670', btn: '#4f46e5', warnBg: '#fff7ed', warnLine: '#f59e0b' };
const HEAD_STYLE = `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){.kb-bg{background:#101216!important}.kb-card{background:#1a1d23!important;border-color:#2c313a!important}.kb-tx{color:#e6e8eb!important}.kb-mu{color:#a3a9b3!important}.kb-q{background:#2a2216!important;border-color:#f59e0b!important}.kb-bt{background:#6366f1!important}}
[data-ogsc] .kb-tx{color:#e6e8eb!important}[data-ogsc] .kb-mu{color:#a3a9b3!important}[data-ogsb] .kb-card{background:#1a1d23!important}[data-ogsb] .kb-q{background:#2a2216!important}
@media (max-width:620px){.kb-pad{padding-left:20px!important;padding-right:20px!important}}`;

/** "in 3 days", "in 1 day", "in 5 hours": how long until `expiresAt`, never rounded up past what is left by a day. */
export function timeLeftText(expiresAt, now = Date.now()) {
  const left = Math.max(0, Number(expiresAt) - Number(now));
  if (left >= 1.5 * DAY) { const d = Math.round(left / DAY); return `in ${d} days`; }
  if (left >= DAY) return 'in 1 day';
  const h = Math.max(1, Math.round(left / HOUR));
  return h >= 24 ? 'in 1 day' : `in ${h} hour${h === 1 ? '' : 's'}`;
}
/** "Friday, November 20 at 3:00 PM UTC": we do not know the owner's time zone, so the zone is always said. */
export function stopTimeText(expiresAt) {
  const d = new Date(Number(expiresAt));
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(d).replace(/\s+/g, ' ');
  return `${date} at ${time} UTC`;
}

/**
 * → { subject, html, text }. host: the website the bot was seen on; botName: the bot's name ("Your bot" when unnamed);
 * expiresAt / now: ms; link: the bot's restore link in the Studio (it reopens the bot, where Launch is).
 */
export function expiryWarningEmail({ host, botName = 'Your bot', expiresAt, now = Date.now(), link }) {
  const site = String(host || 'your website');
  const name = String(botName || '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Your bot';
  const left = timeLeftText(expiresAt, now);
  const when = stopTimeText(expiresAt);
  const subject = `Your bot on ${site} stops answering ${left}`;
  const lines = [
    `${name} is answering visitors on ${site}. It is still on its free trial, and the trial ends on ${when}.`,
    'After that, the bot stops answering on your site and its files are deleted.',
    'Launch it before then to keep it running.',
  ];
  const cta = 'Keep my bot running';
  const foot = [
    'You are getting this because this address is saved with a bot built in KnowBot Studio.',
    'If the bot is no longer on your site, you can ignore this email.',
  ];
  const P = `margin:0 0 14px;font-size:16px;line-height:1.6;color:${C.text}`;
  const body = `<h1 class="kb-tx" style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${C.text}">Your bot stops answering ${esc(left)}</h1>`
    + `<p class="kb-tx" style="${P}">${esc(lines[0])}</p>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr><td class="kb-q" style="padding:10px 14px;background:${C.warnBg};border-left:3px solid ${C.warnLine};border-radius:0 8px 8px 0">`
    + `<p class="kb-tx" style="margin:0;font-size:15px;line-height:1.55;color:${C.text}">${esc(lines[1])}</p></td></tr></table>`
    + `<p class="kb-tx" style="${P}">${esc(lines[2])}</p>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0"><tr><td class="kb-bt" bgcolor="${C.btn}" style="border-radius:8px;background:${C.btn}"><a href="${esc(link)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:16px;line-height:1.2;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(cta)}</a></td></tr></table>`;
  const preheader = `${name} is answering visitors on ${site}. The trial ends on ${when}.`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">`
    + `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title><style>${HEAD_STYLE}</style></head>`
    + `<body class="kb-bg" style="margin:0;padding:0;width:100%;background:${C.bg};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">`
    + `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kb-bg" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">`
    + `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT}">`
    + `<tr><td class="kb-pad" style="padding:0 28px 12px;font-family:${FONT}"><p class="kb-tx" style="margin:0;font-size:15px;line-height:1.4;font-weight:700;color:${C.text}">KnowBot</p></td></tr>`
    + `<tr><td class="kb-card kb-pad" bgcolor="${C.card}" style="padding:28px;background:${C.card};border:1px solid ${C.line};border-radius:14px;font-family:${FONT}">${body}</td></tr>`
    + `<tr><td class="kb-pad" style="padding:18px 28px 0;font-family:${FONT}">${foot.map((l) => `<p class="kb-mu" style="margin:0 0 8px;font-size:12px;line-height:1.55;color:${C.muted}">${esc(l)}</p>`).join('')}</td></tr>`
    + `</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  const text = [`Your bot stops answering ${left}`, '', lines[0], '', lines[1], '', lines[2], '', `${cta}:`, String(link), '', '--', 'KnowBot', ...foot].join('\n');
  return { subject, html, text };
}

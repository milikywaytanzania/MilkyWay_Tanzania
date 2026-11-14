// DOM helpers, icons and formatting shared by the views. No framework: direct, minimal DOM writes.
import { lang } from '../core/i18n.js';
import { image } from '../core/media.js';

export const $ = (selector, root = document) => root.querySelector(selector);

/** h('button', { class: 'x', onclick }, 'text', child) */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

/** Universal MilkyWay watermark: a semi-transparent brand mark laid over posts, videos, audio and LIVE views.
 *  It is a display overlay only; uploaded originals are never modified. */
export const BRAND_MARK_SRC = new URL('../../brand/milkyway-watermark-galaxy.webp', import.meta.url).href;
export const brandMark = (variant = 'post') => h('img', { class: `mw-mark mw-mark--${variant}`, src: BRAND_MARK_SRC, alt: '', 'aria-hidden': 'true', draggable: 'false', decoding: 'async', loading: 'eager' });

const svg = path => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
export const icon = {
  heart: svg('<path d="M12 21s-7.5-4.6-10-9.3C.4 8.4 2.3 4 6.4 4c2.3 0 3.9 1.3 5.6 3.3C13.7 5.3 15.3 4 17.6 4 21.7 4 23.6 8.4 22 11.7 19.5 16.4 12 21 12 21z"/>'),
  comment: svg('<path d="M12 3C6.5 3 2 6.7 2 11.3c0 2.5 1.3 4.7 3.4 6.2L4.6 21l4-2.1c1 .3 2.2.5 3.4.5 5.5 0 10-3.7 10-8.2S17.5 3 12 3z"/>'),
  bookmark: svg('<path d="M6 2.5h12a1 1 0 0 1 1 1V22l-7-4.6L5 22V3.5a1 1 0 0 1 1-1z"/>'),
  share: svg('<path d="M14 4v4C7 9 3.5 13 2.5 20c2.6-3.7 6-5.4 11.5-5.4V19l8-7.5L14 4z"/>'),
  gift: svg('<path d="M20 7h-2.2A3 3 0 0 0 12 4.4 3 3 0 0 0 6.2 7H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h.5v8a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-8h.5a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zM15 5.5a1.5 1.5 0 0 1 0 3h-2v-1A2 2 0 0 1 15 5.5zM9 5.5a2 2 0 0 1 2 2v1H9a1.5 1.5 0 0 1 0-3zM11 19H6.5v-7H11v7zm0-8.5H4.5v-2H11v2zm6.5 8.5H13v-7h4.5v7zm1-8.5H13v-2h6.5v2z"/>'),
  home: svg('<path d="M12 3 2.5 11h2.7v9.5h5.3v-6h3v6h5.3V11h2.7L12 3z"/>'),
  live: svg('<path d="M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7.8 7.8a6 6 0 0 0 0 8.4l1.4-1.4a4 4 0 0 1 0-5.6L7.8 7.8zm8.4 0-1.4 1.4a4 4 0 0 1 0 5.6l1.4 1.4a6 6 0 0 0 0-8.4zM5 5a10 10 0 0 0 0 14l1.4-1.4a8 8 0 0 1 0-11.2L5 5zm14 0-1.4 1.4a8 8 0 0 1 0 11.2L19 19A10 10 0 0 0 19 5z"/>'),
  plus: svg('<path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/>'),
  inbox: svg('<path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2z"/>'),
  user: svg('<path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.5-8 5.5V22h16v-2.5c0-3-3.6-5.5-8-5.5z"/>'),
  sound: svg('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>'),
  muted: svg('<path d="M3 9v6h4l5 5V4L7 9H3zm18.7 1.4-1.4-1.4L18 11.3 15.7 9l-1.4 1.4 2.3 2.3-2.3 2.3 1.4 1.4 2.3-2.3 2.3 2.3 1.4-1.4-2.3-2.3 2.3-2.3z"/>'),
  close: svg('<path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/>'),
  play: svg('<path d="M8 5v14l11-7z"/>'),
  search: svg('<path d="M10.5 3a7.5 7.5 0 0 1 6 12l4.7 4.6-1.5 1.5-4.6-4.7A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/>'),
  flip: svg('<path d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9zm3 4.5a4.5 4.5 0 0 1 4.3 3.2H18l-2.5 3-2.5-3h1.2A2.5 2.5 0 0 0 9.8 11l-1.5-1.3A4.5 4.5 0 0 1 12 8.5zM6 13l2.5-3 2.5 3H9.8a2.5 2.5 0 0 0 4.4.9l1.5 1.3A4.5 4.5 0 0 1 7.7 13H6z"/>'),
  mic: svg('<path d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V22h2v-3.1a7 7 0 0 0 6-6.9h-2z"/>'),
  eye: svg('<path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>'),
};

const compact = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
export const count = value => (value > 0 ? compact.format(value) : '0');

const relative = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'narrow' });
export function ago(iso) {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  const steps = [[60, 'second'], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400], [2629800, 'week', 604800], [Infinity, 'month', 2629800]];
  for (const [limit, unit, divisor = 1] of steps) if (Math.abs(seconds) < limit) return relative.format(Math.round(seconds / divisor), unit);
  return '';
}

let toastTimer = 0;
export function toast(message) {
  let node = document.getElementById('mwToast');
  if (!node) { node = h('div', { id: 'mwToast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(node); }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
}

export function avatar(profile, size = 48) {
  const node = h('span', { class: 'avatar', style: `--s:${size}px` });
  paintAvatar(node, profile, size);
  return node;
}

/** (Re)fills an avatar node; used when recycled slides are bound to a new author. */
export function paintAvatar(node, profile, size = 48) {
  const letter = (profile?.name || 'M').trim().slice(0, 1).toUpperCase() || 'M';
  node.replaceChildren();
  if (!profile?.avatar) { node.textContent = letter; return; }
  const img = h('img', { alt: '', decoding: 'async', width: size, height: size, src: image(profile.avatar, size * 2) });
  img.onerror = () => { node.textContent = letter; };
  node.append(img);
}

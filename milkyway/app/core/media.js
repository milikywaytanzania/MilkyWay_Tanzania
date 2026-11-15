// Media delivery: one function decides where pictures come from (Cloudinary, Netlify Image CDN or the original).
import { config } from '../config.js';

const host = location.hostname;
const netlifyHost = /netlify\.app$|masiyatunda\.com$/.test(host);
const provider = (() => {
  const choice = config.media.imageCdn;
  if (choice === 'cloudinary' || (choice === 'auto' && config.cloudinary.cloudName)) return config.cloudinary.cloudName ? 'cloudinary' : 'none';
  if (choice === 'netlify' || (choice === 'auto' && netlifyHost)) return 'netlify';
  return 'none';
})();

const step = width => Math.max(64, Math.ceil(width / 80) * 80);

// When the image CDN refuses a picture (e.g. the remote-image allow-list is missing on a deploy), every later picture
// in this tab loads the original file straight away instead of showing a broken image first.
let cdnOff = (() => { try { return sessionStorage.getItem('mw_cdn_off') === '1'; } catch { return false; } })();
function disableCdn() {
  if (cdnOff || navigator.onLine === false) return;
  cdnOff = true;
  try { sessionStorage.setItem('mw_cdn_off', '1'); } catch {}
}

// Netlify Image CDN only fetches remote pictures from the allow-listed Supabase storage (see netlify.toml);
// anything else would be refused, so those pictures load from their original address.
const NETLIFY_REMOTE = /^https:\/\/wpclkhgizbvxuvbhbwzs\.supabase\.co\/storage\/v1\//i;

/** Sized, modern-format image URL. Widths snap to 80 px steps so CDN and device caches are shared. */
export function image(url, width = 720, quality = 72) {
  if (!url || !/^https?:\/\//i.test(url)) return url || '';
  if (cdnOff || provider === 'none') return url;
  if (provider === 'netlify' && !NETLIFY_REMOTE.test(url)) return url;
  const w = step(width);
  if (provider === 'cloudinary') return `https://res.cloudinary.com/${config.cloudinary.cloudName}/image/fetch/f_auto,q_auto,w_${w}/${encodeURIComponent(url)}`;
  if (provider === 'netlify') return `/.netlify/images?url=${encodeURIComponent(url)}&w=${w}&q=${quality}&fm=webp`;
  return url;
}

/** Points an <img> at a sized picture; if the CDN fails, it falls back to the original file (then `onFail`). */
export function setImage(img, url, width = 720, { quality = 72, onFail } = {}) {
  const sized = image(url, width, quality);
  img.onerror = () => {
    if (sized && sized !== url && img.getAttribute('src') === sized) { disableCdn(); img.src = url; return; }
    img.onerror = null;
    onFail?.();
  };
  if (!url) { img.removeAttribute('src'); return; }
  img.src = sized;
}

/** Poster for an uploaded video (the composer saves "<video>.poster.jpg" next to Supabase uploads). */
export function poster(videoUrl, width) {
  if (!videoUrl || !videoUrl.includes('/storage/v1/object/public/')) return '';
  return image(`${videoUrl}.poster.jpg`, width, 60);
}

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv|3gp)(\?|#|$)/i;
/** 'video' | 'image' | 'text' for a feed post ({ media: { url, type } }) or a mw_posts row (media_url, media_type). */
export function mediaKind(post) {
  const url = String(post?.media?.url || post?.media_url || '');
  const type = String(post?.media?.type || post?.media_type || '').toLowerCase();
  if (!url) return 'text';
  if (type.startsWith('video') || VIDEO_FILE.test(url)) return 'video';
  return 'image';
}

export const initials = name => (String(name || 'M').trim()[0] || 'M').toUpperCase();

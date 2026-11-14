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

/** Sized, modern-format image URL. Widths snap to 80 px steps so CDN and device caches are shared. */
export function image(url, width = 720, quality = 72) {
  if (!url || !/^https?:\/\//i.test(url)) return url || '';
  const w = step(width);
  if (provider === 'cloudinary') return `https://res.cloudinary.com/${config.cloudinary.cloudName}/image/fetch/f_auto,q_auto,w_${w}/${encodeURIComponent(url)}`;
  if (provider === 'netlify') return `/.netlify/images?url=${encodeURIComponent(url)}&w=${w}&q=${quality}&fm=webp`;
  return url;
}

/** Poster for an uploaded video (the composer saves "<video>.poster.jpg" next to Supabase uploads). */
export function poster(videoUrl, width) {
  if (!videoUrl || !videoUrl.includes('/storage/v1/object/public/')) return '';
  return image(`${videoUrl}.poster.jpg`, width, 60);
}

export const initials = name => (String(name || 'M').trim()[0] || 'M').toUpperCase();

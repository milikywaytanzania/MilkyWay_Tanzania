// Gift catalog (cached for everyone) and wallet balance (cached per account). Sending is server-authoritative.
import { config } from '../config.js';
import { api } from '../core/net.js';
import { resource } from '../core/sync.js';
import { lang } from '../core/i18n.js';

// Artwork for well-known gift keys; any other key shows 🎁. Prices always come from the server.
const ICONS = {
  maua: '🌸', kahawa: '☕', ngoma: '🥁', tausi: '🦚', tembo: '🐘', chui: '🐆', simba: '🦁', twiga: '🦒', kilimanjaro: '🏔️',
  dainaso: '🦖', 'taji-ya-milkyway': '👑', 'ngao-ya-galaxy': '🛡️', 'gari-la-kifahari': '🚗', 'gari-la-mashindano': '🏎️',
  limozini: '🚘', 'gari-la-umeme': '🚙', 'gari-la-dhahabu': '🚖', 'simu-ya-dhahabu': '📱', moyo: '❤️', nyota: '⭐', roketi: '🚀',
};
const titleCase = key => key.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

// Fallback: the catalog bundled with the app (same keys and prices the server keeps), loaded only if the API fails.
async function bundledCatalog() {
  if (!globalThis.MilkyWayGiftCatalog) {
    await new Promise((resolve, reject) => {
      const script = Object.assign(document.createElement('script'), { src: new URL('../../gift-catalog.js', import.meta.url).href, async: true, onload: resolve, onerror: reject });
      document.head.append(script);
    });
  }
  const languages = globalThis.MilkyWayGiftCatalog?.languages || ['en'];
  const index = Math.max(0, languages.indexOf(lang));
  return (globalThis.MilkyWayGiftCatalog?.gifts || []).map(gift => ({ key: gift.key, coins: Number(gift.coins), name: gift.names?.[index] || gift.names?.[0] || titleCase(gift.key), icon: gift.emoji || ICONS[gift.key] || '🎁' }));
}

export const catalog = resource('gifts:catalog', async () => {
  let entries = [];
  try {
    const info = await api(`${config.api.wallet}?action=catalog`, { authed: false, timeout: 12000 });
    entries = Object.entries(info?.gifts || {}).map(([key, coins]) => ({ key, coins: Number(coins), name: titleCase(key), icon: ICONS[key] || '🎁' }));
  } catch (error) { console.warn('[gifts] catalog API unavailable, using bundled catalog', error); }
  if (!entries.length) entries = await bundledCatalog();
  return entries.sort((a, b) => a.coins - b.coins);
}, { maxAge: 6 * 60 * 60 * 1000, scope: false });

export const wallet = resource('wallet', async () => {
  const info = await api(`${config.api.wallet}?action=wallet`, { timeout: 12000 });
  return { coins: Number(info?.coins ?? 0) };
}, { maxAge: 30_000 });

/** Sends a gift to a Live room or a post. Returns the new balance. */
export async function sendGift({ gift, room, postId }) {
  const result = await api(`${config.api.wallet}?action=gift`, { method: 'POST', body: room ? { gift, room } : { gift, postId }, timeout: 12000 });
  wallet.mutate({ coins: Number(result?.coins ?? 0) });
  return result;
}

export const giftIcon = key => ICONS[key] || '🎁';

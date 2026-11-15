// Live room settings shared by the Live room API, the gift wallet and the LiveKit token gateway.
// Layout fields plus the host's moderation and audience controls, stored in mw_live_room_settings.settings (jsonb).
import { isUuid } from './supa.js';

export const LIVE_DEFAULTS = Object.freeze({
  layout: 9, admission: 'approval', layoutStyle: 'fullscreen', hostPosition: 'start', mobileLayout: 'stack', featuredId: null, order: [],
  comments: 'everyone', slowMode: 0, filterWords: [], filterLinks: false,
  giftsEnabled: true, likesEnabled: true, showViewerCount: true, allowRequests: true,
  mutedIds: [], blockedIds: [], invites: {}, pinned: null,
});

const ids = value => Array.isArray(value) ? [...new Set(value.filter(isUuid).map(id => id.toLowerCase()))].slice(0, 500) : [];

/** Fills defaults and drops malformed values so older rows (layout-only settings) keep working. */
export function normalizeLiveSettings(raw) {
  const value = { ...LIVE_DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  value.mutedIds = ids(value.mutedIds);
  value.blockedIds = ids(value.blockedIds);
  value.filterWords = Array.isArray(value.filterWords) ? value.filterWords.filter(word => typeof word === 'string' && word.trim()).slice(0, 50) : [];
  value.invites = value.invites && typeof value.invites === 'object' && !Array.isArray(value.invites) ? value.invites : {};
  // Nobody goes on stage without the host: the old "anyone can join" admission now means "request & approve".
  value.admission = value.admission === 'broadcast' ? 'broadcast' : 'approval';
  return value;
}

export async function loadLiveSettings(ctx, roomName) {
  const [row] = await ctx.rest(`mw_live_room_settings?room_name=eq.${encodeURIComponent(roomName)}&select=settings&limit=1`).catch(() => []) || [];
  return normalizeLiveSettings(row?.settings);
}

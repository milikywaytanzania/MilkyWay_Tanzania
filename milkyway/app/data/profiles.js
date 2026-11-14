// Profile cache: authors seen in the feed / Lives / inbox are kept on the device, so names and avatars render
// instantly (and offline) everywhere. Follow state is remembered per account.
import { store } from '../core/store.js';
import { rest, auth } from '../core/net.js';
import { scoped } from '../core/sync.js';
import { bus } from '../core/events.js';

const memory = new Map();
const following = new Set();
let followLoaded = false;

const normalize = row => row && ({ id: String(row.id), name: row.name || row.display_name || 'MilkyWay', username: row.username || '', avatar: row.avatar || row.avatar_url || '' });

export const profiles = {
  /** Seed from data that already arrived with a feed page / Live list (no extra request). */
  prime(list) {
    for (const item of list || []) {
      const profile = normalize(item);
      if (!profile?.id) continue;
      const before = memory.get(profile.id);
      memory.set(profile.id, profile);
      if (!before || before.avatar !== profile.avatar || before.name !== profile.name) store.set(`profile:${profile.id}`, profile);
    }
  },
  peek: id => memory.get(String(id)) || null,
  /** Many at once: memory → device → one network request for the rest. */
  async many(ids) {
    const wanted = [...new Set(ids.map(String))];
    const missing = [];
    for (const id of wanted) {
      if (memory.has(id)) continue;
      const saved = await store.get(`profile:${id}`);
      if (saved) memory.set(id, saved); else missing.push(id);
    }
    if (missing.length) {
      try {
        const rows = await rest(`mw_profiles?id=in.(${missing.slice(0, 100).join(',')})&select=id,display_name,username,avatar_url`);
        profiles.prime(rows || []);
      } catch { /* offline: initials are shown */ }
    }
    return new Map(wanted.map(id => [id, memory.get(id) || null]));
  },
  isFollowing: id => following.has(String(id)),
  setFollowing(id, on) {
    on ? following.add(String(id)) : following.delete(String(id));
    store.set(scoped('following'), [...following]);
    bus.emit('follow', { id: String(id), on });
  },
  /** Who the signed-in user follows (cached; refreshed quietly). */
  async loadFollowing() {
    if (!auth.signedIn()) { following.clear(); return following; }
    if (!followLoaded) {
      followLoaded = true;
      (await store.get(scoped('following')) || []).forEach(id => following.add(id));
    }
    rest(`mw_follows?follower_id=eq.${auth.userId}&select=following_id&limit=2000`).then(rows => {
      following.clear();
      (rows || []).forEach(row => following.add(String(row.following_id)));
      store.set(scoped('following'), [...following]);
      bus.emit('follow', null);
    }).catch(() => {});
    return following;
  },
};
bus.on('auth', () => { following.clear(); followLoaded = false; profiles.loadFollowing(); });

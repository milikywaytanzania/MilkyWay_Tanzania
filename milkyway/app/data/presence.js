// Online status: one Supabase Realtime presence channel for the whole app.
// Everyone signed in listens (so "active now" counts and green dots work); people who turned off
// "Show when I am active" listen without announcing themselves.
import { auth, supabase } from '../core/net.js';
import { bus } from '../core/events.js';

const VISIBLE_KEY = 'mw_show_online';
const subscribers = new Set();
let channel = null;
let online = new Set();
let joined = false;

export const presence = {
  /** Whether this person shares their own online status (default: yes). */
  get visible() { try { return localStorage.getItem(VISIBLE_KEY) !== '0'; } catch { return true; } },
  /** Number of distinct people active right now (including you when visible). */
  get count() { return online.size; },
  isOnline: id => Boolean(id) && online.has(String(id)),
  /** Ids of the people active right now. */
  get ids() { return [...online]; },
  subscribe(fn) { subscribers.add(fn); fn(presence); return () => subscribers.delete(fn); },
  async setVisible(on) {
    try { localStorage.setItem(VISIBLE_KEY, on ? '1' : '0'); } catch {}
    if (!channel || !joined) return;
    if (on) await channel.track({ at: Date.now() }).catch(() => {});
    else await channel.untrack().catch(() => {});
  },
  start,
};

const publish = () => subscribers.forEach(fn => { try { fn(presence); } catch {} });

async function start() {
  if (channel || !auth.signedIn()) return;
  const me = auth.userId;
  try {
    const sb = await supabase();
    if (channel || auth.userId !== me) return;
    channel = sb.channel('mw-online', { config: { presence: { key: me } } });
    channel
      .on('presence', { event: 'sync' }, () => {
        online = new Set(Object.keys(channel.presenceState()));
        publish();
      })
      .subscribe(async status => {
        joined = status === 'SUBSCRIBED';
        if (joined && presence.visible) await channel.track({ at: Date.now() }).catch(() => {});
      });
  } catch { channel = null; }
}

async function stop() {
  const old = channel;
  channel = null; joined = false; online = new Set();
  publish();
  if (old) { try { await old.untrack(); } catch {} try { (await supabase()).removeChannel(old); } catch {} }
}

bus.on('auth', () => { stop().then(() => { if (auth.signedIn()) start(); }); });
// Leaving the app (tab hidden for a while) stops announcing; coming back announces again.
let hiddenTimer = 0;
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (!channel || !joined || !presence.visible) return;
  if (document.visibilityState === 'hidden') hiddenTimer = setTimeout(() => channel?.untrack().catch(() => {}), 60_000);
  else channel.track({ at: Date.now() }).catch(() => {});
});

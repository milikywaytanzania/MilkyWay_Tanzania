// Live sessions directory: cached list, kept fresh by Supabase Realtime (postgres changes) with a slow poll fallback.
import { config } from '../config.js';
import { api, rest, auth, supabase } from '../core/net.js';
import { resource } from '../core/sync.js';
import { profiles } from './profiles.js';

const SELECT = 'id,room_name,host_id,host_name,title,scope,is_live,started_at';

// The site API only lists Lives whose LiveKit room is really running (no dead rooms left behind by a closed app);
// the database is read directly when the API is unreachable.
async function liveRows() {
  try {
    const result = await api(`${config.api.liveRoom}?action=lives`, { timeout: 9000 });
    if (Array.isArray(result?.sessions)) return result.sessions;
  } catch { /* fall back to the database */ }
  return (await rest(`mw_video_live_sessions?is_live=eq.true&select=${SELECT}&order=started_at.desc&limit=60`)) || [];
}

async function fetchLives() {
  const rows = await liveRows();
  const following = await profiles.loadFollowing();
  const seenRooms = new Set(), seenHosts = new Set();
  const visible = rows.filter(row => {
    if (!row.room_name || !row.host_id || seenRooms.has(row.room_name) || seenHosts.has(row.host_id)) return false;
    if (row.scope === 'followers' && row.host_id !== auth.userId && !following.has(String(row.host_id))) return false;
    seenRooms.add(row.room_name); seenHosts.add(row.host_id);
    return true;
  });
  const hosts = await profiles.many(visible.map(row => row.host_id));
  return visible.map(row => {
    const profile = hosts.get(String(row.host_id));
    return {
      id: row.id, room: row.room_name, title: row.title || '', startedAt: row.started_at,
      mode: /audio/.test(row.room_name) ? 'audio' : 'video',
      host: { id: String(row.host_id), name: profile?.name || row.host_name || 'MilkyWay', avatar: profile?.avatar || '' },
    };
  });
}

export const lives = resource('live:list', fetchLives, { maxAge: 10_000 });

let channel = null;
let poll = 0;
let debounce = 0;
/** Starts realtime updates of the Live list (idempotent). */
export async function watchLives() {
  clearInterval(poll);
  poll = setInterval(() => document.visibilityState === 'visible' && lives.refresh(), 30_000);
  if (channel) return;
  try {
    const sb = await supabase();
    channel = sb.channel('mw-core-lives')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mw_video_live_sessions' }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => lives.refresh(), 400);
      })
      .subscribe();
  } catch { /* poll keeps it fresh */ }
}

export async function createSession({ room, title }) {
  // One LIVE per host: sessions left open by an earlier broadcast (app closed, connection lost) end first,
  // so viewers never land in an old room.
  await rest(`mw_video_live_sessions?host_id=eq.${auth.userId}&is_live=eq.true`, {
    method: 'PATCH', body: { is_live: false, ended_at: new Date().toISOString() },
  }).catch(() => {});
  const rows = await rest('mw_video_live_sessions', {
    method: 'POST', prefer: 'return=representation',
    body: { room_name: room, host_id: auth.userId, host_name: auth.name, title, scope: 'public', is_live: true, started_at: new Date().toISOString(), ended_at: null },
  });
  return rows?.[0];
}

export const endSession = room => rest(`mw_video_live_sessions?room_name=eq.${encodeURIComponent(room)}&host_id=eq.${auth.userId}`, {
  method: 'PATCH', body: { is_live: false, ended_at: new Date().toISOString() },
});

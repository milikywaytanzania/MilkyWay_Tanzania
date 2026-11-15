// Direct-message threads: history from the site API, sending straight to Supabase as the signed-in user
// (row-level security + the receiver's "who can message me" setting decide), and live delivery through
// Supabase Realtime (mw_messages is in the realtime publication).
import { config } from '../config.js';
import { api, rest, auth, supabase } from '../core/net.js';
import { bus } from '../core/events.js';
import { inbox } from './chats.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const listeners = new Set();
let channel = null;

/** Newest last. */
export async function loadThread(peer) {
  if (!UUID.test(peer)) throw new Error('Invalid conversation');
  const data = await api(`${config.api.message}?peer=${encodeURIComponent(peer)}`, { timeout: 12000 });
  return (data?.messages || []).slice().reverse();
}

export async function sendMessage(peer, body) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) throw new Error('Empty message');
  const rows = await rest('mw_messages?select=*', {
    method: 'POST', prefer: 'return=representation',
    body: { sender_id: auth.userId, receiver_id: peer, body: text },
  });
  const message = Array.isArray(rows) ? rows[0] : rows;
  inbox.refresh();
  return message;
}

/** Marks everything this peer sent me as read (the only column people may update on mw_messages). */
export function markRead(peer) {
  if (!auth.userId || !UUID.test(peer)) return Promise.resolve();
  return rest(`mw_messages?sender_id=eq.${peer}&receiver_id=eq.${auth.userId}&read_at=is.null`, {
    method: 'PATCH', body: { read_at: new Date().toISOString() },
  }).catch(() => {});
}

export async function deleteForMe(id) {
  await api(`${config.api.message}?action=hide`, { method: 'POST', body: { ids: [id] } });
}

/** fn({ type: 'INSERT' | 'UPDATE' | 'DELETE', message }) for messages I send or receive (any device). */
export function onMessage(fn) {
  listeners.add(fn);
  connect();
  return () => listeners.delete(fn);
}

async function connect() {
  if (channel || !auth.signedIn()) return;
  const me = auth.userId;
  try {
    const sb = await supabase();
    if (channel || auth.userId !== me) return;
    const emit = payload => {
      const message = payload.eventType === 'DELETE' ? payload.old : payload.new;
      listeners.forEach(fn => { try { fn({ type: payload.eventType, message }); } catch {} });
      if (payload.eventType === 'INSERT') inbox.refresh();
    };
    channel = sb.channel(`mw-dm-${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mw_messages', filter: `receiver_id=eq.${me}` }, emit)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mw_messages', filter: `sender_id=eq.${me}` }, emit)
      .subscribe();
  } catch { channel = null; }
}

bus.on('auth', async () => {
  const old = channel;
  channel = null;
  if (old) { try { (await supabase()).removeChannel(old); } catch {} }
  if (auth.signedIn() && listeners.size) connect();
});

/** People search for starting a new conversation (name or @username). */
export async function searchPeople(query) {
  const q = String(query || '').trim().replace(/^@/, '').replace(/[%*,()"\\]/g, '').slice(0, 40);
  if (q.length < 2) return [];
  const pattern = encodeURIComponent(`*${q}*`);
  const rows = await rest(`mw_profiles?select=id,display_name,username,avatar_url&or=(username.ilike.${pattern},display_name.ilike.${pattern})&limit=20`);
  return (rows || []).filter(row => String(row.id) !== auth.userId)
    .map(row => ({ id: String(row.id), name: row.display_name || row.username || 'MilkyWay', username: row.username || '', avatar: row.avatar_url || '' }));
}

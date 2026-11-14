// Chat rooms list (inbox): grouped by conversation, cached on the device and refreshed in the background.
import { config } from '../config.js';
import { api, auth } from '../core/net.js';
import { resource } from '../core/sync.js';
import { profiles } from './profiles.js';

export const inbox = resource('chats:inbox', async () => {
  const data = await api(`${config.api.message}?action=inbox`, { timeout: 10000 });
  const me = auth.userId;
  const rooms = new Map();
  for (const message of data?.messages || []) {
    const peer = String(message.sender_id === me ? message.receiver_id : message.sender_id);
    if (!peer || rooms.has(peer)) continue; // newest first: the first one is the preview
    const encrypted = Number(message.encryption_version) > 0;
    rooms.set(peer, {
      peer, at: message.created_at, mine: message.sender_id === me,
      preview: encrypted ? '🔒' : String(message.body || '').slice(0, 120),
      unread: message.receiver_id === me && !message.read_at && !message.seen_at,
    });
  }
  const people = await profiles.many([...rooms.keys()]);
  return [...rooms.values()].map(room => ({ ...room, name: people.get(room.peer)?.name || 'MilkyWay', avatar: people.get(room.peer)?.avatar || '' }));
}, { maxAge: 15_000 });

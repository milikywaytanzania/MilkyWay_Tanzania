// Delivers new-follower-post notices while the recipient is online using Supabase Realtime.
import { auth, supabase } from '../core/net.js';
import { bus } from '../core/events.js';
import { t } from '../core/i18n.js';
import { toast } from '../ui/dom.js';

let client;
let channel;
let recipient = '';
let queue = Promise.resolve();

async function sync() {
  const nextRecipient = auth.userId || '';
  if (nextRecipient === recipient && (channel || !nextRecipient)) return;
  recipient = nextRecipient;
  if (channel && client) {
    const previous = channel;
    channel = null;
    await client.removeChannel(previous);
  }
  if (!recipient) return;
  const currentRecipient = recipient;
  client = await supabase();
  if (recipient !== currentRecipient) return;
  channel = client.channel(`mw-post-notifications-${currentRecipient}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'mw_post_notifications',
      filter: `recipient_id=eq.${currentRecipient}`,
    }, ({ new: notice }) => {
      if (recipient !== currentRecipient || !notice?.post_id) return;
      const author = String(notice.actor_name || 'MilkyWay').slice(0, 80);
      toast(`${author} ${t('publishedNewPost')}`);
    })
    .subscribe(status => {
      if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        console.warn(`[notifications] post realtime ${status.toLowerCase()}`);
      }
    });
}

export function watchPostNotifications() {
  const task = queue.catch(() => {}).then(sync);
  queue = task.catch(() => {});
  return task;
}

bus.on('auth', () => {
  watchPostNotifications().catch(error => console.warn('[notifications] post realtime unavailable', error));
});

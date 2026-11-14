// Post comments ("echoes"): cached per post, optimistic posting, queued when offline.
import { rest, auth } from '../core/net.js';
import { resource, perform, registerOp } from '../core/sync.js';

const SELECT = 'id,user_id,author_name,body,created_at';
export const comments = postId => resource(`comments:${postId}`, async () => {
  const rows = await rest(`mw_echoes?post_id=eq.${postId}&select=${SELECT}&order=created_at.desc&limit=100`);
  return (rows || []).map(row => ({ id: row.id, userId: row.user_id, name: row.author_name || 'MilkyWay', body: row.body, at: row.created_at }));
}, { maxAge: 20_000 });

registerOp('comment', op => rest('mw_echoes?on_conflict=id', {
  method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
  body: { id: op.id, post_id: op.post, user_id: op.user, author_name: op.name, body: op.body },
}));

export async function addComment(postId, body) {
  const item = { id: crypto.randomUUID(), userId: auth.userId, name: auth.name, body, at: new Date().toISOString(), pending: true };
  const list = comments(postId);
  list.mutate(current => [item, ...(current || [])]);
  const result = await perform('comment', { id: item.id, post: postId, user: auth.userId, name: auth.name, body });
  if (result === 'sent') list.mutate(current => (current || []).map(entry => (entry.id === item.id ? { ...entry, pending: false } : entry)));
  return result;
}

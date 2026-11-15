// Saved posts. On Netlify they live in Netlify Database (table mw_post_saves); the Netlify Function entry hands the
// driver in through useDatabase(), so the Cloudflare and Render builds never load it. Those hosts keep using the
// Supabase table mw_saves as the signed-in user.
//
// Every caller is already authenticated (their Supabase session was checked by route()), and rows are always keyed
// by that verified user id, so nobody can read or change another person's saves.
import { ApiError, eq, inList, isUuid, requireUuid } from './supa.js';

let getDb = null;
let database = null;
/** Called once by the Netlify Function with @netlify/database's getDatabase. */
export function useDatabase(factory) { getDb = factory; }
function db() {
  if (database || !getDb) return database;
  try { database = getDb(); } catch { database = null; }
  return database;
}

/** The ids among `ids` that the signed-in user saved. */
export async function savedAmong(ctx, ids) {
  const me = ctx.user?.id;
  const list = (ids || []).filter(isUuid);
  if (!me || !list.length) return new Set();
  const sql = db()?.sql;
  if (sql) {
    try {
      const rows = await sql`SELECT post_id FROM mw_post_saves WHERE user_id = ${me} AND post_id = ANY(${list}::uuid[])`;
      return new Set(rows.map(row => String(row.post_id)));
    } catch { return new Set(); }
  }
  try {
    const rows = await ctx.rest(`mw_saves?user_id=${eq(me)}&post_id=${inList(list)}&select=post_id`);
    return new Set((rows || []).map(row => String(row.post_id)));
  } catch { return new Set(); }
}

/** Saves (on = true) or unsaves a post the caller can see. Idempotent. */
export async function setSaved(ctx, postId, on) {
  const me = ctx.user.id;
  const post = requireUuid(String(postId || ''), 'post');
  if (on) {
    // Only posts the caller is allowed to see (Supabase row-level security on mw_posts decides).
    const rows = await ctx.rest(`mw_posts?id=${eq(post)}&select=id&limit=1`).catch(() => null);
    if (Array.isArray(rows) && !rows.length) throw new ApiError(404, 'This post is no longer available.');
  }
  const sql = db()?.sql;
  if (sql) {
    try {
      if (on) await sql`INSERT INTO mw_post_saves (user_id, post_id) VALUES (${me}, ${post}) ON CONFLICT (user_id, post_id) DO NOTHING`;
      else await sql`DELETE FROM mw_post_saves WHERE user_id = ${me} AND post_id = ${post}`;
    } catch { throw new ApiError(503, 'Saved posts are unavailable right now.'); }
    return { saved: on };
  }
  if (on) await ctx.rest('mw_saves?on_conflict=post_id,user_id', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: { post_id: post, user_id: me } });
  else await ctx.rest(`mw_saves?post_id=${eq(post)}&user_id=${eq(me)}`, { method: 'DELETE' });
  return { saved: on };
}

/** The caller's saved post ids, newest first. */
export async function savedList(ctx, limit = 200) {
  const me = ctx.user.id;
  const sql = db()?.sql;
  if (sql) {
    const rows = await sql`SELECT post_id, created_at FROM mw_post_saves WHERE user_id = ${me} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(row => ({ postId: String(row.post_id), savedAt: row.created_at }));
  }
  const rows = await ctx.rest(`mw_saves?user_id=${eq(me)}&select=post_id,created_at&order=created_at.desc&limit=${limit}`).catch(() => []);
  return (rows || []).map(row => ({ postId: String(row.post_id), savedAt: row.created_at }));
}

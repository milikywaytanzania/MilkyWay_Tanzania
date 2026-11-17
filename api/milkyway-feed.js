// MilkyWay feed API: one request returns a ready-to-render page of the vertical feed.
// The old client made 6+ sequential reads per page (posts → profiles → privacy → audiences → follows → signals → echoes
// → saves). Here they run server-side in parallel, so a phone on a slow network waits for a single round trip.
// Everything still runs as the caller (their JWT), so row-level security stays the final judge.
//
//   GET /api/milkyway-feed?action=page&scope=foryou|following&before=<ISO time>&limit=12&media=video
//   → { posts: [{ id, author, caption, media, createdAt, likes, comments, liked, saved }], next: <ISO time> | null }
//   POST /api/milkyway-feed?action=save { post, on }   (signed in) → { saved }
//   GET  /api/milkyway-feed?action=saved               (signed in) → { saved: [{ postId, savedAt }] }
import { route, isUuid, eq, inList, ApiError, isMissingSchema, requireUuid } from './_lib/supa.js';
import { savedAmong, setSaved, savedList } from './_lib/saves.js';

const FOLLOW_TABLES = ['mw_follows', 'follows'];
const clamp = (value, min, max, fallback) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const validTime = value => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const quiet = promise => promise.catch(() => null);
const POST_FIELDS = 'id,author_id,author_name,caption,media_url,media_type,media_items,media_preview_items,audio_url,slideshow_style,scheduled_at,created_at';
const LEGACY_POST_FIELDS = 'id,author_id,author_name,caption,media_url,media_type,scheduled_at,created_at';
// Posts store media_type as 'video' / 'image', a MIME type ('video/mp4', 'image/jpeg') or nothing at all (older posts),
// so the file extension decides when the type is missing or unknown.
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv|3gp)(\?|#|$)/i;
const mediaKind = (url, type) => {
  const value = String(type || '').toLowerCase();
  if (value.startsWith('video')) return 'video';
  if (value.startsWith('image') || value === 'photo' || value === 'picture') return VIDEO_FILE.test(url) ? 'video' : 'image';
  return VIDEO_FILE.test(String(url)) ? 'video' : 'image';
};

async function follows(ctx, filter) {
  for (const table of FOLLOW_TABLES) {
    const rows = await quiet(ctx.rest(`${table}?${filter}&select=following_id&limit=2000`));
    if (rows) return new Set(rows.map(row => String(row.following_id)));
  }
  return new Set();
}

async function page({ ctx, query }) {
  const me = ctx.user?.id || null;
  const limit = clamp(query.limit, 4, 30, 12);
  const scope = query.scope === 'following' && me ? 'following' : 'foryou';
  // Over-fetch a little so privacy filtering rarely leaves a short page.
  const filters = [`select=${POST_FIELDS}`, `order=created_at.desc`, `limit=${limit * 2}`];
  filters.push(`or=(scheduled_at.is.null,scheduled_at.lte.${encodeURIComponent(new Date().toISOString())})`);
  if (validTime(query.before)) filters.push(`created_at=lt.${encodeURIComponent(new Date(query.before).toISOString())}`);
  // Default: every post (text posts render as cards). media=video → videos only, media=visual → photos + videos.
  if (query.media === 'video') filters.push('media_type=ilike.video*');
  else if (query.media === 'visual') filters.push('media_url=not.is.null');

  let followed = null;
  if (scope === 'following') {
    followed = await follows(ctx, `follower_id=${eq(me)}`);
    const authors = [...followed, me].filter(isUuid).slice(0, 400);
    filters.push(`author_id=${inList(authors)}`);
  }

  let rows;
  let includeSlideshowFields = true;
  let includeScheduledAt = true;
  while (true) {
    const fields = (includeSlideshowFields ? POST_FIELDS : LEGACY_POST_FIELDS)
      .split(',')
      .filter(field => includeScheduledAt || field !== 'scheduled_at')
      .join(',');
    const queryFilters = filters
      .filter(filter => includeScheduledAt || !filter.startsWith('or=(scheduled_at.'))
      .map(filter => filter.startsWith('select=') ? `select=${fields}` : filter);
    try {
      rows = (await ctx.rest(`mw_posts?${queryFilters.join('&')}`)) || [];
      break;
    } catch (error) {
      const message = String(error?.message || '');
      if (!isMissingSchema(error)) throw error;
      if (includeSlideshowFields && /media_items|media_preview_items|audio_url|slideshow_style/i.test(message)) {
        includeSlideshowFields = false;
        continue;
      }
      if (includeScheduledAt && /\bscheduled_at\b/i.test(message)) {
        includeScheduledAt = false;
        continue;
      }
      throw error;
    }
  }
  if (!rows.length) return { posts: [], next: null };
  const ids = rows.map(row => row.id);
  const authorIds = [...new Set(rows.map(row => String(row.author_id)).filter(isUuid))];

  const [profiles, privacy, audiences, signals, echoes, saves] = await Promise.all([
    authorIds.length ? quiet(ctx.rest(`mw_profiles?id=${inList(authorIds)}&select=id,display_name,username,avatar_url`)) : [],
    authorIds.length ? quiet(ctx.rpc('mw_privacy_flags', { p_ids: authorIds })) : {},
    quiet(ctx.rpc('mw_post_audiences', { p_ids: ids })),
    quiet(ctx.rest(`mw_signals?post_id=${inList(ids)}&kind=eq.light&select=post_id,user_id&limit=10000`)),
    quiet(ctx.rest(`mw_echoes?post_id=${inList(ids)}&select=post_id&limit=10000`)),
    savedAmong(ctx, ids),
  ]);

  // Private accounts: owners and their followers only.
  const privateAuthors = authorIds.filter(id => id !== me && privacy?.[id]?.private);
  let allowedPrivate = new Set();
  if (privateAuthors.length && me) {
    allowedPrivate = followed || await follows(ctx, `follower_id=${eq(me)}&following_id=${inList(privateAuthors)}`);
  }
  const hiddenPosts = new Set((audiences || []).filter(row => !row.can_see).map(row => row.post_id));
  const profileById = new Map((profiles || []).map(profile => [String(profile.id), profile]));
  const likes = new Map(), liked = new Set(), comments = new Map();
  for (const row of signals || []) {
    likes.set(row.post_id, (likes.get(row.post_id) || 0) + 1);
    if (me && String(row.user_id) === me) liked.add(row.post_id);
  }
  for (const row of echoes || []) comments.set(row.post_id, (comments.get(row.post_id) || 0) + 1);
  const saved = saves;

  const allowed = rows.filter(row => {
    const author = String(row.author_id);
    if (hiddenPosts.has(row.id)) return false;
    if (author !== me && privacy?.[author]?.private && !allowedPrivate.has(author)) return false;
    return true;
  });
  const visible = allowed.slice(0, limit);

  const posts = visible.map(row => {
    const profile = profileById.get(String(row.author_id));
    return {
      id: row.id,
      author: {
        id: String(row.author_id),
        name: profile?.display_name || row.author_name || 'MilkyWay',
        username: profile?.username || '',
        avatar: profile?.avatar_url || '',
      },
      caption: row.caption || '',
      media: row.media_url ? {
        url: row.media_url, type: mediaKind(row.media_url, row.media_type),
        items: Array.isArray(row.media_items) ? row.media_items.filter(item => typeof item === 'string' && /^https:\/\//i.test(item)).slice(0, 8) : [],
        previewItems: Array.isArray(row.media_preview_items) ? row.media_preview_items.filter(item => typeof item === 'string' && /^https:\/\//i.test(item)).slice(0, 8) : [],
        audioUrl: typeof row.audio_url === 'string' && /^https:\/\//i.test(row.audio_url) ? row.audio_url : '',
        style: ['fade', 'zoom', 'cinema', 'page', 'slide'].includes(row.slideshow_style) ? row.slideshow_style : 'fade',
      } : null,
      createdAt: row.created_at,
      likes: likes.get(row.id) || 0,
      comments: comments.get(row.id) || 0,
      liked: liked.has(row.id),
      saved: saved.has(String(row.id)),
    };
  });
  // Cursor: right after the last post returned; when filtering hid most rows, after the last row scanned.
  let next = null;
  if (allowed.length > limit) next = visible[visible.length - 1].created_at;
  else if (rows.length >= limit * 2) next = rows[rows.length - 1].created_at;
  return { posts, next };
}

async function sharedPost({ ctx, query }) {
  const id = requireUuid(query.id, 'post id');
  let rows;
  const selections = [`title,${POST_FIELDS}`, POST_FIELDS, LEGACY_POST_FIELDS];
  for (let index = 0; index < selections.length; index++) {
    try {
      rows = await ctx.rest(`mw_posts?id=${eq(id)}&select=${selections[index]}&limit=1`);
      break;
    } catch (error) {
      const message = String(error?.message || '');
      if (!isMissingSchema(error)) throw error;
      if (index === 0 && /\btitle\b/i.test(message)) continue;
      if (index < selections.length - 1 && /media_items|media_preview_items|audio_url|slideshow_style/i.test(message)) {
        index = selections.length - 2;
        continue;
      }
      throw error;
    }
  }
  const row = rows?.[0];
  if (!row) return { post: null };

  const authorId = String(row.author_id);
  const [profiles, privacy, audiences] = await Promise.all([
    ctx.rest(`mw_profiles?id=${eq(authorId)}&select=id,display_name,username,avatar_url`),
    ctx.rpc('mw_privacy_flags', { p_ids: [authorId] }),
    ctx.rpc('mw_post_audiences', { p_ids: [id] }),
  ]);
  if (privacy?.[authorId]?.private || (audiences || []).some(item => item.post_id === id && !item.can_see)) return { post: null };

  const profile = profiles?.[0];
  return {
    post: {
      id,
      title: typeof row.title === 'string' ? row.title : '',
      author: {
        id: authorId,
        name: profile?.display_name || row.author_name || 'MilkyWay',
        username: profile?.username || '',
        avatar: profile?.avatar_url || '',
      },
      caption: row.caption || '',
      media: row.media_url ? {
        url: row.media_url,
        type: mediaKind(row.media_url, row.media_type),
        items: Array.isArray(row.media_items) ? row.media_items.filter(item => typeof item === 'string' && /^https:\/\//i.test(item)).slice(0, 8) : [],
        previewItems: Array.isArray(row.media_preview_items) ? row.media_preview_items.filter(item => typeof item === 'string' && /^https:\/\//i.test(item)).slice(0, 8) : [],
      } : null,
      createdAt: row.created_at,
      likes: 0,
      comments: 0,
      liked: false,
      saved: false,
    },
  };
}

export default route({
  page: { auth: false, run: page },
  share: { auth: false, run: sharedPost },
  // POST { post, on } saves / unsaves one post for the signed-in user.
  save: async ({ ctx, body, method }) => {
    if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
    return setSaved(ctx, body.post, body.on !== false);
  },
  // GET → { saved: [{ postId, savedAt }] }, newest first.
  saved: async ({ ctx }) => ({ saved: await savedList(ctx) }),
});

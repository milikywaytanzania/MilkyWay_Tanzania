// Feed repository: cached pages per scope ("foryou" / "following"), background refresh, infinite paging,
// and optimistic like / save / follow that survive going offline.
import { config } from '../config.js';
import { api, rest, auth, supabase } from '../core/net.js';
import { resource, perform, registerOp } from '../core/sync.js';
import { profiles } from './profiles.js';
import { t } from '../core/i18n.js';
import { toast } from '../ui/dom.js';

const pageUrl = (scope, before) => {
  const params = new URLSearchParams({ action: 'page', scope, limit: String(config.feed.pageSize) });
  if (before) params.set('before', before);
  return `${config.api.feed}?${params}`;
};

async function fetchPage(scope, before) {
  const page = await api(pageUrl(scope, before), { timeout: 9000 });
  const posts = Array.isArray(page?.posts) ? page.posts : [];
  profiles.prime(posts.map(post => post.author));
  return { posts, next: page?.next || null };
}

const feeds = new Map();
export function feed(scope = 'foryou') {
  if (feeds.has(scope)) return feeds.get(scope);
  // The device keeps only the newest posts; the cursor is moved so paging resumes right after them.
  const persist = value => {
    const limit = config.feed.cacheLimit;
    if (!value?.posts || value.posts.length <= limit) return value;
    return { posts: value.posts.slice(0, limit), next: value.posts[limit - 1].createdAt };
  };
  // A refresh puts the newest posts first and keeps the pages already loaded (and their cursor) behind them.
  const refreshFirstPage = () => fetchPage(scope).then(page => {
    const old = source.value;
    if (!old?.posts?.length) return page;
    const fresh = new Map(page.posts.map(post => [post.id, post]));
    const rest = old.posts.filter(post => !fresh.has(post.id));
    return { posts: [...page.posts, ...rest], next: rest.length ? old.next : page.next };
  });
  const source = resource(`feed:${scope}`, refreshFirstPage, { maxAge: 15_000, persist });
  let loadingMore = null;
  const api = {
    source,
    load: () => source.load(),
    refresh: () => source.refresh(),
    /** Appends the next page; the device copy keeps only the newest posts. */
    more() {
      const current = source.value;
      if (loadingMore || !current?.next) return loadingMore || Promise.resolve(false);
      loadingMore = fetchPage(scope, current.next).then(page => {
        const seen = new Set(current.posts.map(post => post.id));
        const posts = [...current.posts, ...page.posts.filter(post => !seen.has(post.id))];
        source.mutate({ posts, next: page.next });
        return page.posts.length > 0;
      }).catch(() => false).finally(() => { loadingMore = null; });
      return loadingMore;
    },
  };
  feeds.set(scope, api);
  return api;
}

/** Posts deleted on this device; views drop them even from pages they still hold in memory. */
export const deletedPosts = new Set();
const dropPost = postId => feeds.forEach(({ source }) => {
  const value = source.value;
  if (value?.posts?.some(post => post.id === postId)) source.mutate({ ...value, posts: value.posts.filter(post => post.id !== postId) });
});
const STORAGE_PREFIX = '/storage/v1/object/public/portfolio/';
const storagePath = url => {
  const at = String(url || '').indexOf(STORAGE_PREFIX);
  return at === -1 ? '' : decodeURIComponent(String(url).slice(at + STORAGE_PREFIX.length).split('?')[0]);
};

const updatePost = (postId, change) => feeds.forEach(({ source }) => {
  const value = source.value;
  if (!value?.posts?.some(post => post.id === postId)) return;
  source.mutate({ ...value, posts: value.posts.map(post => (post.id === postId ? { ...post, ...change(post) } : post)) });
});

// ---- Writes (idempotent, so a replay after a flaky connection never double-counts) ----
// Row-level security only lets people write their own rows. An operation queued offline by another account on this
// device (or before sign-out) would be refused with "violates row-level security policy", so it is dropped instead.
const ownOp = send => op => (op.user && op.user === auth.userId ? send(op) : Promise.resolve('skipped'));
// Readable message instead of the raw PostgREST text (e.g. 'new row violates row-level security policy for table "mw_saves"').
const friendly = (error, key) => {
  if (error?.status === 401) return Object.assign(new Error(t('signInToContinue')), { status: 401 });
  if (error?.status === 403 || /row-level security/i.test(String(error?.message || ''))) return Object.assign(new Error(t(key)), { status: 403 });
  return error;
};
registerOp('like', ownOp(op => op.on
  ? rest('mw_signals?on_conflict=post_id,user_id,kind', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: { post_id: op.post, user_id: op.user, kind: 'light' } })
  : rest(`mw_signals?post_id=eq.${op.post}&user_id=eq.${op.user}&kind=eq.light`, { method: 'DELETE' })));
registerOp('save', ownOp(op => op.on
  ? rest('mw_saves?on_conflict=post_id,user_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: { post_id: op.post, user_id: op.user } })
  : rest(`mw_saves?post_id=eq.${op.post}&user_id=eq.${op.user}`, { method: 'DELETE' })));
registerOp('follow', ownOp(op => op.on
  ? rest('mw_follows?on_conflict=follower_id,following_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: { follower_id: op.user, following_id: op.target } })
  : rest(`mw_follows?follower_id=eq.${op.user}&following_id=eq.${op.target}`, { method: 'DELETE' })));

export const actions = {
  like(post, on) {
    updatePost(post.id, current => ({ liked: on, likes: Math.max(0, current.likes + (on === current.liked ? 0 : on ? 1 : -1)) }));
    return perform('like', { post: post.id, user: auth.userId, on }).catch(error => {
      updatePost(post.id, current => ({ liked: !on, likes: Math.max(0, current.likes + (on ? -1 : 1)) }));
      throw friendly(error, 'likeFailed');
    });
  },
  save(post, on) {
    updatePost(post.id, () => ({ saved: on }));
    if (!auth.userId) return Promise.reject(friendly({ status: 401 }));
    return perform('save', { post: post.id, user: auth.userId, on }).then(result => {
      if (result === 'sent' && on) toast(t('saved'));
      return result;
    }).catch(error => { updatePost(post.id, () => ({ saved: !on })); throw friendly(error, 'saveFailed'); });
  },
  follow(authorId, on) {
    profiles.setFollowing(authorId, on);
    return perform('follow', { target: authorId, user: auth.userId, on }).catch(error => { profiles.setFollowing(authorId, !on); throw friendly(error, 'followFailed'); });
  },
  /** Deletes one of the signed-in user's posts (row-level security allows authors only), then its files. */
  async remove(post) {
    if (!auth.signedIn() || !post?.id) throw new Error('Sign in first.');
    // Attached documents first: their rows are looked up through the post.
    await api(`/api/milkyway-gallery?action=post&id=${encodeURIComponent(post.id)}`, { method: 'DELETE', timeout: 15000 }).catch(() => {});
    const sb = await supabase();
    const { data, error } = await sb.from('mw_posts').delete().eq('id', post.id).eq('author_id', auth.userId).select('id');
    if (error) throw error;
    if (!data?.length) throw Object.assign(new Error('This post could not be deleted.'), { status: 403 });
    deletedPosts.add(post.id);
    dropPost(post.id);
    const path = storagePath(post.media_url || post.media?.url);
    if (path.startsWith(`milkyway/${auth.userId}/`)) sb.storage.from('portfolio').remove([path, `${path}.poster.jpg`]).catch(() => {});
    return true;
  },
  commentAdded(postId) { updatePost(postId, current => ({ comments: current.comments + 1 })); },
};

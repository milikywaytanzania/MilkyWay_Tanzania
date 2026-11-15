// Profile ("Nova" tab for the signed-in user, or any author tapped in the feed / Lives).
// Header, counts and posts come from Supabase as the caller, so row-level security decides what is visible.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { setImage, poster } from '../core/media.js';
import { profiles } from '../data/profiles.js';
import { actions } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, icon, avatar, count, toast } from './dom.js';
import { PostViewer, postKind } from './post-viewer.js';

const quiet = promise => Promise.resolve(promise).then(result => result, () => ({}));

export class ProfileView {
  constructor({ requireLogin, openCreate, openComments }) {
    this.hooks = { requireLogin, openCreate, openComments };
    this.sheet = new Sheet({ title: t('me'), className: 'profile-sheet' });
    this.content = h('div', { class: 'profile' });
    this.sheet.body.append(this.content);
    this.token = 0;
    this.posts = [];
    this.viewer = null;
    // Delete confirmation for a post picked from the grid's "⋯" button.
    this.menu = new Sheet({ title: t('post'), className: 'post-menu-sheet' });
  }

  #viewer() {
    return this.viewer ||= new PostViewer({
      requireLogin: () => this.hooks.requireLogin(),
      openComments: post => this.hooks.openComments?.(post),
      onDeleted: post => this.#removed(post),
    });
  }

  #openPost(post) {
    const index = this.posts.indexOf(post);
    if (index >= 0) this.#viewer().open(this.posts, index, { own: this.own });
  }

  #removed(post) {
    const at = this.posts.indexOf(post);
    if (at >= 0) this.posts.splice(at, 1);
    this.grid?.querySelector(`[data-post="${CSS.escape(String(post.id))}"]`)?.remove();
    if (this.postCount) this.postCount.textContent = count(this.posts.length);
    if (this.grid && !this.posts.length) this.grid.replaceChildren(h('p', { class: 'muted center' }, this.own ? t('noPostsYet') : t('empty')));
  }

  #postMenu(post) {
    const message = h('p', { class: 'muted center', role: 'status' });
    const remove = h('button', { class: 'pill-btn danger wide', type: 'button' }, t('deletePost'));
    let armed = 0;
    remove.onclick = async () => {
      if (!armed) {
        remove.textContent = t('tapAgainDelete'); remove.classList.add('armed');
        armed = setTimeout(() => { armed = 0; remove.textContent = t('deletePost'); remove.classList.remove('armed'); }, 3000);
        return;
      }
      clearTimeout(armed);
      remove.disabled = true; remove.textContent = t('deleting'); message.textContent = '';
      try {
        await actions.remove(post);
        this.#removed(post);
        this.menu.close();
        toast(t('postDeleted'));
      } catch (error) {
        armed = 0; remove.disabled = false; remove.textContent = t('deletePost'); remove.classList.remove('armed');
        message.textContent = error?.message || t('deleteFailed');
      }
    };
    this.menu.body.replaceChildren(h('div', { class: 'stack' },
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => { this.menu.close(); this.#openPost(post); } }, t('openPost')),
      remove, message,
      h('button', { class: 'link center', type: 'button', onclick: () => this.menu.close() }, t('cancel'))));
    this.menu.open();
  }

  /** person: { id, name, username, avatar } or null for the signed-in user. */
  open(person = null) {
    const id = String(person?.id || auth.userId || '');
    if (!id) return;
    this.id = id;
    this.own = id === auth.userId;
    this.sheet.title = this.own ? t('me') : (person?.name || profiles.peek(id)?.name || t('profile'));
    this.#render({ profile: person || profiles.peek(id) || { id, name: this.own ? auth.name : '' }, loading: true });
    this.sheet.open();
    this.#load(id);
  }

  async #load(id) {
    const token = ++this.token;
    try {
      const sb = await supabase();
      const head = { count: 'exact', head: true };
      const [profile, followers, following, posts] = await Promise.all([
        quiet(sb.from('mw_profiles').select('*').eq('id', id).maybeSingle()),
        quiet(sb.from('mw_follows').select('follower_id', head).eq('following_id', id)),
        quiet(sb.from('mw_follows').select('following_id', head).eq('follower_id', id)),
        quiet(sb.from('mw_posts').select('id,author_id,caption,media_url,media_type,created_at').eq('author_id', id).order('created_at', { ascending: false }).limit(30)),
      ]);
      if (token !== this.token) return;
      const row = profile.data || {};
      const person = { id, name: row.display_name || profiles.peek(id)?.name || (this.own ? auth.name : 'MilkyWay'), username: row.username || '', avatar: row.avatar_url || '', bio: row.bio || '', private: Boolean(row.is_private) };
      profiles.prime([{ id, name: person.name, username: person.username, avatar: person.avatar }]);
      if (!this.own) this.sheet.title = person.name;
      this.#render({ profile: person, followers: followers.count || 0, following: following.count || 0, posts: posts.data || [] });
    } catch {
      if (token === this.token) this.#render({ profile: profiles.peek(id) || { id }, error: true });
    }
  }

  #render({ profile, followers = 0, following = 0, posts = [], loading = false, error = false }) {
    this.posts = posts.slice();
    this.postCount = h('b', {}, count(posts.length));
    const stats = h('div', { class: 'profile-stats' },
      h('span', {}, this.postCount, t('posts')),
      h('span', {}, h('b', {}, count(followers)), t('followers')),
      h('span', {}, h('b', {}, count(following)), t('followingCount')));
    const actionsRow = h('div', { class: 'profile-actions' });
    if (this.own) {
      actionsRow.append(
        h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#edit(profile) }, t('editProfile')),
        h('button', { class: 'pill-btn hot', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openCreate(); } }, t('create')),
        h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#signOut() }, t('signOut')));
    } else if (auth.signedIn()) {
      const button = h('button', { class: 'pill-btn hot', type: 'button' });
      const paint = () => { const on = profiles.isFollowing(profile.id); button.textContent = on ? t('following') : t('follow'); button.classList.toggle('hot', !on); button.setAttribute('aria-pressed', String(on)); };
      button.onclick = () => {
        const on = !profiles.isFollowing(profile.id);
        actions.follow(profile.id, on).catch(() => toast(t('queued')));
        paint();
      };
      paint();
      actionsRow.append(button);
    } else {
      actionsRow.append(h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.hooks.requireLogin() }, t('follow')));
    }

    const grid = this.grid = h('div', { class: 'profile-grid' });
    if (loading) grid.append(h('p', { class: 'muted center' }, t('loading')));
    else if (error) grid.append(h('p', { class: 'muted center' }, t('retry')));
    else if (!posts.length) grid.append(h('p', { class: 'muted center' }, this.own ? t('noPostsYet') : t('empty')));
    else grid.append(...this.posts.map(post => tile(post, {
      open: () => this.#openPost(post),
      menu: this.own ? () => this.#postMenu(post) : null,
    })));

    this.content.replaceChildren(
      h('div', { class: 'profile-head' },
        avatar(profile, 84),
        h('div', { class: 'profile-names' },
          h('b', {}, profile.name || ''),
          profile.username ? h('span', { class: 'muted' }, `@${profile.username}`) : null,
          profile.private ? h('small', { class: 'muted' }, `🔒 ${t('privateAccount')}`) : null)),
      profile.bio ? h('p', { class: 'profile-bio' }, profile.bio) : null,
      stats, actionsRow, grid);
  }

  #edit(profile) {
    const name = h('input', { class: 'field', maxlength: '60', value: profile.name || '', placeholder: t('displayName'), required: true });
    const username = h('input', { class: 'field', maxlength: '30', value: profile.username || '', placeholder: t('username'), autocapitalize: 'off', spellcheck: 'false' });
    const bio = h('textarea', { class: 'field area', maxlength: '300', placeholder: t('bio') });
    bio.value = profile.bio || '';
    const message = h('p', { class: 'muted', role: 'status' });
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('save'));
    this.content.replaceChildren(h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      const handle = username.value.trim().replace(/^@/, '');
      if (handle && !/^[A-Za-z0-9._]{2,30}$/.test(handle)) { message.textContent = t('usernameRule'); return; }
      submit.disabled = true; message.textContent = t('loading');
      try {
        const sb = await supabase();
        const { error } = await sb.from('mw_profiles').update({ display_name: name.value.trim(), username: handle || null, bio: bio.value.trim() || null }).eq('id', auth.userId);
        if (error) throw error;
        toast('✓');
        this.#load(this.id);
      } catch (error) { message.textContent = error.message || t('retry'); submit.disabled = false; }
    } }, name, username, bio, submit, message,
    h('button', { class: 'link center', type: 'button', onclick: () => this.#load(this.id) }, t('cancel'))));
  }

  async #signOut() {
    try { const sb = await supabase(); await sb.auth.signOut(); } catch {}
    this.sheet.close();
  }
}

function tile(post, { open, menu }) {
  const kind = postKind(post);
  const url = post.media_url || '';
  const node = h('div', { class: `profile-tile ${kind}`, role: 'button', tabindex: '0', 'data-post': String(post.id), 'aria-label': post.caption || t('post') });
  if (kind === 'video') {
    // A still frame: the saved poster when there is one, otherwise the first frame of the video itself.
    const still = poster(url, 360);
    const video = h('video', { muted: true, playsinline: true, preload: 'metadata', disablepictureinpicture: true, src: `${url}#t=0.1` });
    video.muted = true;
    if (still) video.poster = still;
    node.append(video, h('span', { class: 'tile-badge', html: icon.play, 'aria-hidden': 'true' }));
  } else if (kind === 'image') {
    const img = h('img', { alt: post.caption || '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    setImage(img, url, 360, { onFail: () => { node.classList.add('missing'); img.remove(); node.prepend(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '🖼')); } });
    node.append(img);
  } else {
    node.append(h('p', {}, (post.caption || '').slice(0, 140)));
  }
  if (menu) {
    node.append(h('button', { class: 'tile-more', type: 'button', 'aria-label': t('postOptions'), onclick: event => { event.stopPropagation(); menu(); } }, '⋯'));
  }
  node.addEventListener('click', open);
  node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  return node;
}

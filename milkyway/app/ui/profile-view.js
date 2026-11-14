// Profile ("Nova" tab for the signed-in user, or any author tapped in the feed / Lives).
// Header, counts and posts come from Supabase as the caller, so row-level security decides what is visible.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { image } from '../core/media.js';
import { profiles } from '../data/profiles.js';
import { actions } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, avatar, count, toast } from './dom.js';

const quiet = promise => Promise.resolve(promise).then(result => result, () => ({}));

export class ProfileView {
  constructor({ requireLogin, openCreate }) {
    this.hooks = { requireLogin, openCreate };
    this.sheet = new Sheet({ title: t('me'), className: 'profile-sheet' });
    this.content = h('div', { class: 'profile' });
    this.sheet.body.append(this.content);
    this.token = 0;
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
        quiet(sb.from('mw_posts').select('id,caption,media_url,media_type,created_at').eq('author_id', id).order('created_at', { ascending: false }).limit(30)),
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
    const stats = h('div', { class: 'profile-stats' },
      h('span', {}, h('b', {}, count(posts.length)), t('posts')),
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

    const grid = h('div', { class: 'profile-grid' });
    if (loading) grid.append(h('p', { class: 'muted center' }, t('loading')));
    else if (error) grid.append(h('p', { class: 'muted center' }, t('retry')));
    else if (!posts.length) grid.append(h('p', { class: 'muted center' }, this.own ? t('noPostsYet') : t('empty')));
    else grid.append(...posts.map(post => tile(post)));

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

function tile(post) {
  const node = h('div', { class: 'profile-tile' });
  if (post.media_url && post.media_type === 'video') {
    const video = h('video', { src: post.media_url, muted: true, playsinline: true, loop: true, preload: 'metadata' });
    video.muted = true;
    node.append(video);
    node.addEventListener('click', () => (video.paused ? video.play().catch(() => {}) : video.pause()));
  } else if (post.media_url) {
    node.append(h('img', { src: image(post.media_url, 360), alt: post.caption || '', loading: 'lazy', decoding: 'async' }));
  } else {
    node.classList.add('text');
    node.append(h('p', {}, (post.caption || '').slice(0, 140)));
  }
  return node;
}

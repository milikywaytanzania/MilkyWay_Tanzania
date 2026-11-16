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
import { presence } from '../data/presence.js';
import { isOwnerAccount } from './admin-view.js';

const quiet = promise => Promise.resolve(promise).then(result => result, () => ({}));

async function loadProfilePosts(sb, id) {
  const fields = 'id,author_id,caption,media_url,media_type,media_items,media_preview_items,audio_url,slideshow_style,scheduled_at,created_at';
  let result = await sb.from('mw_posts').select(fields).eq('author_id', id).order('created_at', { ascending: false }).limit(30);
  if (result.error && /media_preview_items/i.test(result.error.message || '')) {
    result = await sb.from('mw_posts').select(fields.replace(',media_preview_items', '')).eq('author_id', id).order('created_at', { ascending: false }).limit(30);
  }
  return result;
}

export class ProfileView {
  constructor({ requireLogin, openCreate, openComments, openMenu, openChat }) {
    this.hooks = { requireLogin, openCreate, openComments, openMenu, openChat };
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
    this.mode = 'profile';
    try {
      const sb = await supabase();
      const head = { count: 'exact', head: true };
      const [profile, followers, following, posts] = await Promise.all([
        quiet(sb.from('mw_profiles').select('*').eq('id', id).maybeSingle()),
        quiet(sb.from('mw_follows').select('follower_id', head).eq('following_id', id)),
        quiet(sb.from('mw_follows').select('following_id', head).eq('follower_id', id)),
        quiet(loadProfilePosts(sb, id)),
      ]);
      if (token !== this.token) return;
      const row = profile.data || {};
      const person = { id, name: row.display_name || profiles.peek(id)?.name || (this.own ? auth.name : 'MilkyWay'), username: row.username || '', avatar: row.avatar_url || '', bio: row.bio || '', private: Boolean(row.is_private) };
      profiles.prime([{ id, name: person.name, username: person.username, avatar: person.avatar }]);
      if (!this.own) this.sheet.title = person.name;
      const { data: pin } = await quiet(sb.from('mw_creator_pins').select('post_id').eq('creator_id', id).maybeSingle());
      const profilePosts = posts.data || [];
      if (pin?.post_id) profilePosts.sort((a, b) => Number(b.id === pin.post_id) - Number(a.id === pin.post_id));
      this.#render({ profile: person, followers: followers.count || 0, following: following.count || 0, posts: profilePosts });
      this.#loadBusiness(person, token);
    } catch {
      if (token === this.token) this.#render({ profile: profiles.peek(id) || { id }, error: true });
    }
  }

  async #loadBusiness(profile, token) {
    let section;
    try {
      const sb = await supabase();
      const { data, error } = await sb.from('mw_creator_services')
        .select('id,title,category,description,pricing')
        .eq('creator_id', profile.id).eq('is_published', true).order('created_at', { ascending: false });
      if (error) throw error;
      if (token !== this.token || this.mode !== 'profile' || !data?.length) return;
      section = h('section', { class: 'mw-profile-services' },
        h('h3', {}, t('studioPortfolio')),
        h('div', { class: 'mw-studio-service-list' }, ...data.map(service => this.#profileService(service, profile))));
    } catch (error) {
      if (token !== this.token || this.mode !== 'profile') return;
      section = h('section', { class: 'mw-profile-services' },
        h('h3', {}, t('studioPortfolio')),
        h('p', { class: 'muted', role: 'status' }, `${t('studioServiceUnavailable')}: ${error?.message || t('retry')}`));
    }
    if (token === this.token && this.mode === 'profile' && section) this.content.append(section);
  }

  #profileService(service, profile) {
    const card = h('article', { class: 'mw-studio-service-card' },
      h('div', {}, h('small', { class: 'mw-studio-eyebrow' }, service.category),
        h('h4', {}, service.title), h('p', { class: 'muted' }, service.description),
        service.pricing ? h('b', { class: 'mw-studio-price' }, service.pricing) : null));
    if (this.own || !auth.signedIn()) return card;
    const button = h('button', { class: 'pill-btn hot', type: 'button', onclick: () => {
      const note = h('p', { class: 'muted', role: 'status' });
      const preferredAt = h('input', { class: 'field', type: 'datetime-local', 'aria-label': t('studioPreferredDate') });
      const inquiryText = h('textarea', { class: 'field area', maxlength: '2000', minlength: '10', required: true, placeholder: t('studioInquiryMessage') });
      const submit = h('button', { class: 'pill-btn hot', type: 'submit' }, t('studioSendInquiry'));
      const form = h('form', { class: 'mw-studio-service-request', onsubmit: async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const sb = await supabase();
          const { error } = await sb.from('mw_service_inquiries').insert({
            service_id: service.id,
            creator_id: profile.id,
            requester_id: auth.userId,
            client_name: auth.name.slice(0, 80),
            message: inquiryText.value.trim(),
            preferred_at: preferredAt.value ? new Date(preferredAt.value).toISOString() : null,
          });
          if (error) throw error;
          note.textContent = t('studioInquirySent');
          submit.remove();
          toast(t('studioInquirySent'));
        } catch (error) {
          note.textContent = error?.message || t('retry');
          submit.disabled = false;
        }
      } }, preferredAt, inquiryText, submit, note);
      card.replaceChildren(card.firstElementChild, form);
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } }, t('studioRequestService'));
    card.append(button);
    return card;
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
        h('button', { class: 'pill-btn nova-menu-btn', type: 'button', 'aria-label': t('menu'), onclick: () => this.hooks.openMenu?.(profile) }, h('span', { html: icon.gear }), t('menu')));
      // Owner-only gold Admin button (shown at once for the owner email; the server checks again on every action).
      if (isOwnerAccount() && !actionsRow.querySelector('.nova-admin-btn')) {
        actionsRow.append(h('button', { class: 'pill-btn nova-admin-btn', type: 'button', onclick: () => {
          this.sheet.close();
          import('./admin-view.js').then(m => (ProfileView.admin ||= new m.AdminView()).open());
        } }, '🛡 Admin'));
      }
    } else if (auth.signedIn()) {
      const button = h('button', { class: 'pill-btn hot', type: 'button' });
      const paint = () => { const on = profiles.isFollowing(profile.id); button.textContent = on ? t('following') : t('follow'); button.classList.toggle('hot', !on); button.setAttribute('aria-pressed', String(on)); };
      button.onclick = () => {
        const on = !profiles.isFollowing(profile.id);
        actions.follow(profile.id, on).catch(() => toast(t('queued')));
        paint();
      };
      paint();
      actionsRow.append(button,
        h('button', { class: 'pill-btn', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openChat?.(profile); } }, h('span', { html: icon.inbox }), t('inbox')));
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
        h('span', { class: `presence-avatar${presence.isOnline(profile.id) || (this.own && presence.visible) ? ' online' : ''}`, 'data-presence': this.own ? null : profile.id },
          avatar(profile, 84), h('i', { class: 'presence-dot', 'aria-hidden': 'true' })),
        h('div', { class: 'profile-names' },
          h('b', {}, profile.name || ''),
          profile.username ? h('span', { class: 'muted' }, `@${profile.username}`) : null,
          profile.private ? h('small', { class: 'muted' }, `🔒 ${t('privateAccount')}`) : null,
          presence.isOnline(profile.id) || (this.own && presence.visible) ? h('small', { class: 'presence-label' }, t('activeNow')) : null)),
      profile.bio ? h('p', { class: 'profile-bio' }, profile.bio) : null,
      stats, actionsRow, grid);
  }

  #edit(profile) {
    this.mode = 'edit';
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

}

function tile(post, { open, menu }) {
  const kind = postKind(post);
  const url = post.media_url || '';
  const node = h('div', { class: `profile-tile ${kind}`, role: 'button', tabindex: '0', 'data-post': String(post.id), 'aria-label': post.caption || t('post') });
  if (kind === 'video') {
    const still = poster(url, 360);
    if (still) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      setImage(img, `${url}.poster.jpg`, 360, { quality: 60 });
      node.append(img);
    } else {
      node.classList.add('missing');
      node.append(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '▶'));
    }
    node.append(h('span', { class: 'tile-badge', html: icon.play, 'aria-hidden': 'true' }));
  } else if (kind === 'image') {
    const img = h('img', { alt: post.caption || '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    const preview = post.media_preview_items?.[0] || url;
    setImage(img, preview, 360, { quality: 65, onFail: () => { node.classList.add('missing'); img.remove(); node.prepend(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '🖼')); } });
    node.append(img);
  } else {
    node.append(h('p', {}, (post.caption || '').slice(0, 140)));
  }
  if (post.scheduled_at && Date.parse(post.scheduled_at) > Date.now()) {
    node.append(h('span', { class: 'mw-profile-scheduled' }, t('studioScheduled')));
  }
  if (menu) {
    node.append(h('button', { class: 'tile-more', type: 'button', 'aria-label': t('postOptions'), onclick: event => { event.stopPropagation(); menu(); } }, '⋯'));
  }
  node.addEventListener('click', open);
  node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  return node;
}

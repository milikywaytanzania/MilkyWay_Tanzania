// Owner Admin panel: opened from the gold "Admin" button that only the app owner sees (signed in with the registered
// owner email). Overview, users (suspend / restore), posts (remove) and live rooms (end). Every action is checked again
// on the server (/api/milkyway-account admin-* actions), so hiding the button is a convenience, not the protection.
import { config } from '../config.js';
import { t } from '../core/i18n.js';
import { api, auth } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h, avatar, count, ago, toast } from './dom.js';

const ACCOUNT = `${config.api.base}/milkyway-account`;
export const OWNER_EMAIL = 'masiyatunda@gmail.com';

/** True for the owner's account (by email), so the Admin button shows at once. The server checks the confirmed
 *  owner account again for every admin request. */
export const isOwnerAccount = () => {
  const user = auth.user;
  return Boolean(user?.id && String(user.email || '').trim().toLowerCase() === OWNER_EMAIL);
};

let verified = null; // user id → Promise<boolean>
/** Asks the server whether the signed-in account is the owner (cached per account). */
export function ownerVerified() {
  if (!isOwnerAccount()) return Promise.resolve(false);
  const id = auth.userId;
  if (verified?.id !== id) {
    verified = { id, promise: api(`${ACCOUNT}?action=admin-status`, { timeout: 10000 }).then(result => result?.owner === true, () => false) };
  }
  return verified.promise;
}

const call = (action, { query = '', body } = {}) => api(`${ACCOUNT}?action=${action}${query}`, body ? { method: 'POST', body, timeout: 15000 } : { timeout: 15000 });
const L = (key, fallback) => { const value = t(key); return value && value !== key ? value : fallback; };
const confirmButton = (label, run) => {
  const button = h('button', { class: 'pill-btn danger', type: 'button' }, label);
  let armed = 0;
  button.onclick = async () => {
    if (!armed) {
      button.textContent = L('tapAgainConfirm', 'Tap again');
      armed = setTimeout(() => { armed = 0; button.textContent = label; }, 3000);
      return;
    }
    clearTimeout(armed); armed = 0;
    button.disabled = true;
    try { await run(); } catch (error) { toast(error?.message || t('retry')); button.disabled = false; button.textContent = label; }
  };
  return button;
};

export class AdminView {
  constructor() {
    this.sheet = new Sheet({ title: 'Admin', className: 'admin-sheet' });
    this.tabs = h('div', { class: 'admin-tabs', role: 'tablist' });
    this.box = h('div', { class: 'stack' });
    this.sheet.body.append(this.tabs, this.box);
    this.sections = [
      ['overview', L('overview', 'Overview'), () => this.#overview()],
      ['users', L('users', 'Users'), () => this.#users()],
      ['posts', t('posts'), () => this.#posts()],
      ['lives', t('live'), () => this.#lives()],
    ];
  }

  async open() {
    if (!(await ownerVerified())) { toast(L('adminDenied', 'Administrator permission is required.')); return; }
    this.sheet.open();
    this.#show('overview');
  }

  #show(name) {
    this.current = name;
    this.tabs.replaceChildren(...this.sections.map(([key, label]) => h('button', {
      type: 'button', role: 'tab', class: key === name ? 'on' : '', 'aria-selected': String(key === name), onclick: () => this.#show(key),
    }, label)));
    this.box.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    this.sections.find(([key]) => key === name)[2]().catch(error => {
      if (this.current === name) this.box.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry')));
    });
  }

  async #overview() {
    const data = await call('admin-overview');
    const stat = (label, value) => h('div', {}, h('small', { class: 'muted' }, label), h('b', {}, value == null ? '—' : count(value)));
    this.box.replaceChildren(
      h('div', { class: 'admin-stats' },
        stat(L('users', 'Users'), data.users), stat(t('posts'), data.posts),
        stat(L('postsToday', 'Posts (24 h)'), data.postsToday), stat(L('liveNow', 'LIVE now'), data.lives)),
      h('a', { class: 'pill-btn wide', href: '/admin.html', target: '_blank', rel: 'noopener' }, L('fullDashboard', 'Open full admin dashboard')));
  }

  async #users(q = '') {
    const search = h('input', { class: 'field', type: 'search', placeholder: L('searchUsers', 'Search name or @username'), value: q, 'aria-label': L('searchUsers', 'Search users') });
    const list = h('div', {}, h('p', { class: 'muted center' }, t('loading')));
    let timer = 0;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.#users(search.value.trim()), 350); });
    this.box.replaceChildren(search, list);
    if (q) { search.focus(); search.setSelectionRange(q.length, q.length); }
    const data = await call('admin-users', { query: `&q=${encodeURIComponent(q)}` });
    const users = Array.isArray(data?.users) ? data.users : [];
    if (!users.length) { list.replaceChildren(h('p', { class: 'muted center' }, t('empty'))); return; }
    list.replaceChildren(...users.map(user => {
      const suspended = user.status === 'suspended';
      const actions = user.self ? h('span', { class: 'admin-pill' }, L('you', 'You'))
        : suspended
          ? h('button', { class: 'pill-btn', type: 'button', onclick: async event => {
            event.target.disabled = true;
            try { await call('admin-restore', { body: { userId: user.id } }); toast('✓'); this.#users(q); }
            catch (error) { toast(error?.message || t('retry')); event.target.disabled = false; }
          } }, L('restore', 'Restore'))
          : confirmButton(L('suspend', 'Suspend'), async () => { await call('admin-suspend', { body: { userId: user.id, reason: 'Suspended by the MilkyWay owner.' } }); toast('✓'); this.#users(q); });
      return h('div', { class: 'admin-row' }, avatar(user, 40),
        h('div', { class: 'chat-text' }, h('b', {}, user.name || user.username || 'MilkyWay'), h('span', { class: 'muted' }, user.username ? `@${user.username}` : String(user.id).slice(0, 8))),
        suspended ? h('span', { class: 'admin-pill bad' }, L('suspended', 'Suspended')) : null, actions);
    }));
  }

  async #posts() {
    const data = await call('admin-posts');
    const posts = Array.isArray(data?.posts) ? data.posts : [];
    if (!posts.length) { this.box.replaceChildren(h('p', { class: 'muted center' }, t('empty'))); return; }
    this.box.replaceChildren(...posts.map(post => {
      const node = h('div', { class: 'admin-row' },
        h('span', { class: 'nova-kind', 'aria-hidden': 'true' }, /video/.test(post.media_type || '') ? '🎬' : post.media_url ? '🖼' : '✍️'),
        h('div', { class: 'chat-text' }, h('b', {}, (post.caption || t('post')).slice(0, 70)), h('span', { class: 'muted' }, `${post.author_name || ''} · ${ago(post.created_at)}`)),
        confirmButton(t('deletePost'), async () => { await call('admin-delete-post', { body: { id: post.id } }); node.remove(); toast(t('postDeleted')); }));
      return node;
    }));
  }

  async #lives() {
    const data = await call('admin-lives');
    const lives = Array.isArray(data?.lives) ? data.lives : [];
    if (!lives.length) { this.box.replaceChildren(h('p', { class: 'muted center' }, L('noLives', 'No LIVE rooms right now.'))); return; }
    this.box.replaceChildren(...lives.map(live => {
      const host = { id: live.host_id, name: live.host?.display_name || live.host?.username || 'MilkyWay', avatar: live.host?.avatar_url || '' };
      const node = h('div', { class: 'admin-row' }, avatar(host, 40),
        h('div', { class: 'chat-text' }, h('b', {}, live.title || t('live')), h('span', { class: 'muted' }, `${host.name} · ${/^mw-audio/.test(live.room_name) ? t('audio') : t('video')} · ${ago(live.created_at)}`)),
        confirmButton(L('endLive', 'End LIVE'), async () => { await call('admin-end-live', { body: { room: live.room_name } }); node.remove(); toast('✓'); }));
      return node;
    }));
  }
}

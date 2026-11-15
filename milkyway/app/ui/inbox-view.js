// Messages: inbox (device cache first, refreshed in the background), real-time conversations and
// audio / video calls from any conversation.
import { t } from '../core/i18n.js';
import { auth } from '../core/net.js';
import { inbox } from '../data/chats.js';
import { profiles } from '../data/profiles.js';
import { presence } from '../data/presence.js';
import { loadThread, sendMessage, markRead, onMessage, deleteForMe, searchPeople } from '../data/messages.js';
import { Sheet } from './sheet.js';
import { h, icon, ago, avatar, toast } from './dom.js';
import { calls } from './call-view.js';

const phoneIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z"/></svg>';
const backIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 4.6 14 3.2 5.2 12l8.8 8.8 1.4-1.4L8 12z"/></svg>';
const time = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit' });

/** Avatar with a green dot while that person is active. */
function presenceAvatar(person, size) {
  const node = h('span', { class: 'presence-avatar', 'data-presence': person.id });
  node.append(avatar(person, size), h('i', { class: 'presence-dot', 'aria-hidden': 'true' }));
  node.classList.toggle('online', presence.isOnline(person.id));
  return node;
}
presence.subscribe(() => document.querySelectorAll('[data-presence]').forEach(node => node.classList.toggle('online', presence.isOnline(node.dataset.presence))));

export class InboxView {
  constructor() {
    this.sheet = new Sheet({ title: t('chats'), className: 'inbox-sheet' });
    this.active = h('p', { class: 'muted inbox-active' });
    this.list = h('div', { class: 'chat-list' });
    this.searchBox = h('div', { class: 'stack', hidden: true });
    this.sheet.body.append(
      h('div', { class: 'inbox-tools' },
        this.active,
        h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.#toggleSearch() }, h('span', { html: icon.plus }), t('newChat'))),
      this.searchBox, this.list);
    this.chat = new ChatSheet();
    inbox.subscribe(rooms => this.#render(rooms));
    presence.subscribe(() => { this.active.textContent = presence.count ? `🟢 ${presence.count} ${t('activeUsers')}` : ''; });
    onMessage(() => {}); // opens the realtime connection so the inbox refreshes on new messages
  }

  open() {
    if (!inbox.value) this.list.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    inbox.load().then(value => { if (value === undefined) inbox.refresh().then(rooms => !rooms && this.#render([])); });
    inbox.refresh();
    presence.start();
    this.sheet.open();
  }

  /** Opens a conversation directly (e.g. "Message" on someone's profile). */
  openWith(person) {
    if (!person?.id || person.id === auth.userId) return;
    this.chat.open(person);
  }

  #toggleSearch() {
    if (!this.searchBox.hidden) { this.searchBox.hidden = true; return; }
    const input = h('input', { class: 'field', type: 'search', placeholder: t('searchPeople'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('searchPeople') });
    const results = h('div', { class: 'chat-list' });
    let timer = 0, token = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++token;
        const q = input.value.trim();
        if (q.replace(/^@/, '').length < 2) { results.replaceChildren(); return; }
        results.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
        try {
          const people = await searchPeople(q);
          if (mine !== token) return;
          profiles.prime(people);
          results.replaceChildren(...(people.length ? people.map(person => h('button', { class: 'chat-row', type: 'button', onclick: () => { this.searchBox.hidden = true; this.chat.open(person); } },
            presenceAvatar(person, 40), h('div', { class: 'chat-text' }, h('b', {}, person.name), person.username ? h('span', { class: 'muted' }, `@${person.username}`) : null)))
            : [h('p', { class: 'muted center' }, t('noResults'))]));
        } catch { if (mine === token) results.replaceChildren(h('p', { class: 'muted center' }, t('retry'))); }
      }, 280);
    });
    this.searchBox.replaceChildren(input, results);
    this.searchBox.hidden = false;
    setTimeout(() => input.focus(), 50);
  }

  #render(rooms) {
    if (!rooms?.length) { this.list.replaceChildren(h('p', { class: 'muted center' }, t('noChats'))); return; }
    this.list.replaceChildren(...rooms.map(room => {
      const person = { id: room.peer, name: room.name, avatar: room.avatar };
      return h('button', { class: `chat-row${room.unread ? ' unread' : ''}`, type: 'button', onclick: () => this.chat.open(person) },
        presenceAvatar(person, 44),
        h('div', { class: 'chat-text' }, h('b', {}, room.name),
          h('span', { class: 'muted' }, room.preview === '🔒' ? `🔒 ${t('encrypted')}` : `${room.mine ? `${t('you')}: ` : ''}${room.preview}`)),
        h('small', { class: 'muted' }, ago(room.at)));
    }));
  }
}

class ChatSheet {
  constructor() {
    this.sheet = new Sheet({ title: '', className: 'chat-sheet', onClose: () => { this.peer = null; } });
    this.sheet.heading.hidden = true;
    this.name = h('b', {});
    this.state = h('small', { class: 'muted' });
    this.face = h('span', {});
    this.list = h('div', { class: 'msg-list', role: 'log', 'aria-live': 'polite' });
    this.input = h('textarea', { class: 'field msg-input', rows: '1', maxlength: '4000', placeholder: t('typeMessage'), 'aria-label': t('typeMessage') });
    this.sendBtn = h('button', { class: 'pill-btn hot msg-send', type: 'submit', 'aria-label': t('send') }, t('send'));
    const form = h('form', { class: 'msg-form', onsubmit: event => { event.preventDefault(); this.#send(); } }, this.input, this.sendBtn);
    this.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.#send(); } });
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`; });
    const iconBtn = (label, html, onclick) => h('button', { class: 'icon-btn chat-call', type: 'button', 'aria-label': label, title: label, html, onclick });
    this.sheet.body.append(
      h('header', { class: 'chat-head' },
        iconBtn(t('back'), backIcon, () => this.sheet.close()),
        this.face,
        h('div', { class: 'chat-who' }, this.name, this.state),
        iconBtn(t('audioCall'), phoneIcon, () => this.peer && calls.start(this.peer.id, 'audio')),
        iconBtn(t('videoCall'), icon.camera, () => this.peer && calls.start(this.peer.id, 'video'))),
      this.list, form);
    this.messages = new Map();
    onMessage(event => this.#live(event));
    presence.subscribe(() => this.#paintState());
  }

  open(person) {
    this.peer = { ...person, ...(profiles.peek(person.id) || {}), ...person };
    this.name.textContent = this.peer.name || 'MilkyWay';
    this.face.replaceChildren(presenceAvatar(this.peer, 38));
    this.#paintState();
    this.messages.clear();
    this.list.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    this.sheet.open();
    this.#load(person.id);
  }

  #paintState() {
    if (!this.peer) return;
    this.state.textContent = presence.isOnline(this.peer.id) ? t('activeNow') : (this.peer.username ? `@${this.peer.username}` : '');
  }

  async #load(peer) {
    try {
      const rows = await loadThread(peer);
      if (this.peer?.id !== peer) return;
      this.messages.clear();
      rows.forEach(row => this.messages.set(row.id, row));
      this.#render();
      markRead(peer).then(() => this.peer?.id === peer && import('../data/chats.js').then(m => m.inbox.refresh()));
    } catch (error) {
      if (this.peer?.id === peer) this.list.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry')));
    }
  }

  #render() {
    const rows = [...this.messages.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (!rows.length) { this.list.replaceChildren(h('p', { class: 'muted center msg-empty' }, t('sayHello'))); return; }
    const lastMine = [...rows].reverse().find(row => row.sender_id === auth.userId);
    this.list.replaceChildren(...rows.map(row => this.#bubble(row, row === lastMine)));
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  #bubble(row, last) {
    const mine = row.sender_id === auth.userId;
    const encrypted = Number(row.encryption_version) > 0;
    const bubble = h('div', { class: `msg${mine ? ' mine' : ''}${row.pending ? ' pending' : ''}${row.failed ? ' failed' : ''}`, 'data-id': row.id },
      h('p', {}, encrypted ? `🔒 ${t('encrypted')}` : row.body),
      h('small', {}, time.format(new Date(row.created_at)), row.edited_at ? ` · ${t('edited')}` : '',
        mine && last && row.read_at ? ` · ${t('seen')}` : '', row.failed ? ` · ${t('messageFailed')}` : ''));
    if (!row.pending && !row.failed) {
      // Long-press (context menu) or double-tap: "Delete for me".
      bubble.addEventListener('contextmenu', event => { event.preventDefault(); this.#hide(row); });
      bubble.addEventListener('dblclick', () => this.#hide(row));
    }
    return bubble;
  }

  async #hide(row) {
    if (!confirm(`${t('deleteForMe')}?`)) return;
    try { await deleteForMe(row.id); this.messages.delete(row.id); this.#render(); } catch (error) { toast(error?.message || t('retry')); }
  }

  async #send() {
    const text = this.input.value.trim();
    if (!text || !this.peer) return;
    const peer = this.peer.id;
    const temp = { id: `tmp-${Date.now()}`, sender_id: auth.userId, receiver_id: peer, body: text, created_at: new Date().toISOString(), pending: true };
    this.messages.set(temp.id, temp);
    this.input.value = ''; this.input.style.height = '';
    this.#render();
    try {
      const saved = await sendMessage(peer, text);
      this.messages.delete(temp.id);
      if (saved?.id) this.messages.set(saved.id, saved);
    } catch (error) {
      temp.pending = false; temp.failed = true;
      toast(error?.status === 403 || /row-level security/i.test(String(error?.message || '')) ? t('cantMessage') : t('messageFailed'));
    }
    if (this.peer?.id === peer) this.#render();
  }

  #live({ type, message }) {
    if (!this.peer || !message) return;
    const peer = this.peer.id;
    const inThread = (message.sender_id === peer && message.receiver_id === auth.userId) || (message.sender_id === auth.userId && message.receiver_id === peer);
    if (type === 'DELETE') { if (this.messages.delete(message.id)) this.#render(); return; }
    if (!inThread) return;
    if (type === 'INSERT' && message.sender_id === auth.userId) {
      // Our own message echoed back: replace the optimistic copy instead of showing it twice.
      for (const [id, row] of this.messages) if (row.pending && row.body === message.body) this.messages.delete(id);
    }
    this.messages.set(message.id, { ...(this.messages.get(message.id) || {}), ...message });
    this.#render();
    if (type === 'INSERT' && message.sender_id === peer && this.sheet.isOpen && document.visibilityState === 'visible') markRead(peer);
  }
}

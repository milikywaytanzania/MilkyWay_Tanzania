// Inbox: chat rooms from the device cache first (works offline), refreshed in the background.
// Threads open in the full messenger (end-to-end encryption keys live there).
import { t } from '../core/i18n.js';
import { config } from '../config.js';
import { inbox } from '../data/chats.js';
import { Sheet } from './sheet.js';
import { h, ago, avatar } from './dom.js';

export class InboxView {
  constructor() {
    this.sheet = new Sheet({ title: t('chats'), className: 'inbox-sheet' });
    this.list = h('div', { class: 'chat-list' });
    this.sheet.body.append(this.list);
    inbox.subscribe(rooms => this.#render(rooms));
  }
  open() {
    if (!inbox.value) this.list.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    inbox.load().then(value => { if (value === undefined) inbox.refresh().then(rooms => !rooms && this.#render([])); });
    this.sheet.open();
  }
  #render(rooms) {
    if (!rooms?.length) { this.list.replaceChildren(h('p', { class: 'muted center' }, t('noChats'))); return; }
    this.list.replaceChildren(...rooms.map(room => h('a', { class: `chat-row${room.unread ? ' unread' : ''}`, href: `${config.classicUrl}#thread=${encodeURIComponent(room.peer)}` },
      avatar(room, 44),
      h('div', { class: 'chat-text' }, h('b', {}, room.name), h('span', { class: 'muted' }, room.preview === '🔒' ? `🔒 ${t('encrypted')}` : room.preview)),
      h('small', { class: 'muted' }, ago(room.at)))));
  }
}

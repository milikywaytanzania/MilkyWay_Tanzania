// Comments sheet for a post: cached list paints instantly, posting is optimistic and queued offline.
import { t } from '../core/i18n.js';
import { comments, addComment } from '../data/comments.js';
import { actions } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, ago, toast } from './dom.js';

export class CommentsSheet {
  constructor({ requireLogin }) {
    this.requireLogin = requireLogin;
    this.sheet = new Sheet({ title: t('comments'), className: 'comments-sheet', onClose: () => this.off?.() });
    this.list = h('div', { class: 'comment-list' });
    this.input = h('input', { class: 'field', type: 'text', maxlength: '1000', placeholder: t('addComment'), enterkeyhint: 'send', 'aria-label': t('addComment') });
    this.form = h('form', { class: 'comment-form', onsubmit: event => this.#submit(event) }, this.input, h('button', { class: 'pill-btn', type: 'submit' }, t('send')));
    this.sheet.body.append(this.list, this.form);
  }

  open(post) {
    this.post = post;
    this.off?.();
    this.list.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    this.sheet.title = `${t('comments')} · ${post.comments || 0}`;
    const source = comments(post.id);
    this.off = source.subscribe(items => this.#render(items));
    source.load().then(value => { if (value === undefined) source.refresh().then(items => !items && this.#render([])); });
    this.sheet.open();
  }

  #render(items) {
    if (!items?.length) { this.list.replaceChildren(h('p', { class: 'muted center' }, t('noComments'))); return; }
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.append(h('div', { class: `comment${item.pending ? ' pending' : ''}` },
        h('span', { class: 'avatar', style: '--s:32px' }, (item.name || 'M')[0].toUpperCase()),
        h('div', {}, h('b', {}, item.name), h('p', {}, item.body), h('small', { class: 'muted' }, ago(item.at)))));
    }
    this.list.replaceChildren(fragment);
  }

  async #submit(event) {
    event.preventDefault();
    const body = this.input.value.trim();
    if (!body || !this.requireLogin()) return;
    this.input.value = '';
    try {
      const result = await addComment(this.post.id, body);
      actions.commentAdded(this.post.id);
      if (result === 'queued') toast(t('queued'));
    } catch (error) { toast(error.message); }
  }
}

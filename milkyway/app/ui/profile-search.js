import { t } from '../core/i18n.js';
import { profiles } from '../data/profiles.js';
import { searchPeople } from '../data/messages.js';
import { Sheet } from './sheet.js';
import { h, avatar } from './dom.js';

export class ProfileSearch {
  constructor({ openProfile }) {
    this.openProfile = openProfile;
    this.sheet = new Sheet({ title: t('searchPeople'), className: 'profile-search-sheet' });
    this.input = h('input', {
      class: 'field', type: 'search', placeholder: t('searchPeople'), autocomplete: 'off',
      autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('searchPeople'),
    });
    this.results = h('div', { class: 'chat-list', 'aria-live': 'polite' });
    this.sheet.body.append(this.input, this.results);
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#search(), 250);
    });
  }

  open() {
    clearTimeout(this.timer);
    this.request = (this.request || 0) + 1;
    this.input.value = '';
    this.results.replaceChildren();
    this.sheet.open();
    setTimeout(() => this.input.focus({ preventScroll: true }), 230);
  }

  async #search() {
    const query = this.input.value.trim();
    const token = this.request = (this.request || 0) + 1;
    if (query.replace(/^@/, '').length < 2) {
      this.results.replaceChildren();
      return;
    }
    this.results.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    try {
      const people = await searchPeople(query);
      if (token !== this.request) return;
      profiles.prime(people);
      this.results.replaceChildren(...(people.length
        ? people.map(person => h('button', {
          class: 'chat-row', type: 'button',
          onclick: () => { this.sheet.close(); this.openProfile(person); },
        }, avatar(person, 40),
        h('div', { class: 'chat-text' }, h('b', {}, person.name), person.username ? h('span', { class: 'muted' }, `@${person.username}`) : null)))
        : [h('p', { class: 'muted center' }, t('noResults'))]));
    } catch (error) {
      if (token !== this.request) return;
      console.warn('[profiles] search failed', error);
      this.results.replaceChildren(h('p', { class: 'muted center' }, t('retry')));
    }
  }
}

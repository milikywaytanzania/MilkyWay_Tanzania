import { config } from '../config.js';
import { api } from '../core/net.js';
import { t } from '../core/i18n.js';
import { searchPeople } from '../data/messages.js';
import { profiles } from '../data/profiles.js';
import { extractVideoThumbnail, poster, setImage } from '../core/media.js';
import { h, avatar } from './dom.js';

const TABS = ['all', 'people', 'tags', 'sounds'];
const HASHTAG = /(^|\s)#([\p{L}\p{N}_]{2,40})/gu;

export class DiscoveryView {
  constructor(root, { openProfile, openPost }) {
    this.root = root;
    this.openProfile = openProfile;
    this.openPost = openPost;
    this.posts = [];
    this.tab = 'all';
    this.heading = h('header', { class: 'explore-heading' },
      h('div', {}, h('span', { class: 'explore-eyebrow' }, 'MILKYWAY'), h('h1', {}, t('explore'))));
    this.search = h('input', {
      class: 'field explore-search', type: 'search', placeholder: t('exploreSearch'),
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('exploreSearch'),
    });
    this.tabs = h('div', { class: 'explore-tabs', role: 'tablist', 'aria-label': t('explore') });
    for (const tab of TABS) {
      const button = h('button', {
        class: 'explore-tab', type: 'button', role: 'tab', 'aria-selected': String(tab === this.tab),
        onclick: () => { this.tab = tab; this.#render(); },
      }, t(`explore${tab[0].toUpperCase()}${tab.slice(1)}`));
      button.dataset.exploreTab = tab;
      this.tabs.append(button);
    }
    this.results = h('div', { class: 'explore-results', 'aria-live': 'polite' });
    this.root.replaceChildren(h('div', { class: 'explore-scroll' }, this.heading, this.search, this.tabs, this.results));
    this.search.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.#render(), 200);
    });
  }

  open() {
    this.root.hidden = false;
    this.search.value = '';
    this.tab = 'all';
    this.#selectTab();
    this.#render();
    this.#load();
  }

  async #load() {
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    this.loading = true;
    this.error = null;
    this.#render();
    try {
      const params = new URLSearchParams({ action: 'page', scope: 'foryou', limit: '30' });
      const result = await api(`${config.api.feed}?${params}`, { timeout: 12000 });
      if (request !== this.loadRequest) return;
      this.posts = Array.isArray(result?.posts) ? result.posts : [];
      profiles.prime(this.posts.map(post => post.author).filter(Boolean));
    } catch (error) {
      if (request !== this.loadRequest) return;
      this.error = error;
      console.warn('[explore] discovery content could not be loaded', error);
    } finally {
      if (request === this.loadRequest) {
        this.loading = false;
        this.#render();
      }
    }
  }

  #selectTab() {
    this.tabs.querySelectorAll('[data-explore-tab]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.exploreTab === this.tab));
    });
  }

  #tags() {
    const counts = new Map();
    for (const post of this.posts) {
      for (const match of post.caption?.matchAll(HASHTAG) || []) {
        const tag = match[2].toLocaleLowerCase();
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20);
  }

  #sounds() {
    const sounds = new Map();
    for (const post of this.posts) {
      const url = post.media?.audioUrl;
      if (url && !sounds.has(url)) sounds.set(url, post);
    }
    return [...sounds.values()];
  }

  #render() {
    this.#selectTab();
    const query = this.search.value.trim().replace(/^#/, '').toLocaleLowerCase();
    this.results.replaceChildren();
    if (this.error && !this.posts.length) {
      this.results.append(h('div', { class: 'explore-message' },
        h('p', {}, t('exploreLoadFailed')),
        h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#load() }, t('retry'))));
      return;
    }
    if (this.loading && !this.posts.length) {
      this.results.append(h('p', { class: 'muted center explore-message' }, t('loading')));
      return;
    }
    if (this.tab === 'people') { this.#renderPeople(query); return; }
    if (this.tab === 'tags') { this.#renderTags(query); return; }
    if (this.tab === 'sounds') { this.#renderSounds(query); return; }

    if (!query) {
      this.#renderTags('', true);
      this.#renderPosts(this.posts, t('exploreNew'));
      return;
    }
    const matches = this.posts.filter(post => `${post.caption || ''} ${post.author?.name || ''} ${post.author?.username || ''}`.toLocaleLowerCase().includes(query));
    this.#renderPosts(matches, t('exploreResults'));
  }

  #renderPeople(query) {
    if (query.length < 2) {
      this.results.append(h('p', { class: 'muted center explore-message' }, t('explorePeopleHint')));
      return;
    }
    const request = this.peopleRequest = (this.peopleRequest || 0) + 1;
    this.results.append(h('p', { class: 'muted center explore-message' }, t('loading')));
    searchPeople(query).then(people => {
      if (request !== this.peopleRequest || this.tab !== 'people') return;
      profiles.prime(people);
      this.results.replaceChildren(...(people.length
        ? people.map(person => h('button', {
          class: 'explore-person', type: 'button',
          onclick: () => this.openProfile(person),
        }, avatar(person, 44), h('span', {}, h('b', {}, person.name), h('small', { class: 'muted' }, person.username ? `@${person.username}` : ''))))
        : [h('p', { class: 'muted center explore-message' }, t('noResults'))]));
    }).catch(error => {
      if (request !== this.peopleRequest || this.tab !== 'people') return;
      console.warn('[explore] people search failed', error);
      this.results.replaceChildren(h('p', { class: 'muted center explore-message' }, t('retry')));
    });
  }

  #renderTags(query, featured = false) {
    const tags = this.#tags().filter(([tag]) => !query || tag.includes(query));
    const heading = h('h2', { class: 'explore-section-title' }, featured ? t('exploreTrending') : t('exploreTags'));
    const content = h('div', { class: 'explore-tags' }, ...tags.map(([tag, count]) => h('button', {
      class: 'explore-tag', type: 'button',
      onclick: () => { this.tab = 'all'; this.search.value = `#${tag}`; this.#render(); },
    }, h('b', {}, `#${tag}`), h('small', {}, String(count)))));
    if (tags.length) this.results.append(heading, content);
    else if (!featured) this.results.append(h('p', { class: 'muted center explore-message' }, t('noResults')));
  }

  #renderSounds(query) {
    const sounds = this.#sounds().filter(post => !query || `${post.caption || ''} ${post.author?.name || ''}`.toLocaleLowerCase().includes(query));
    this.results.append(h('h2', { class: 'explore-section-title' }, t('exploreSounds')));
    if (!sounds.length) {
      this.results.append(h('p', { class: 'muted center explore-message' }, t('exploreNoSounds')));
      return;
    }
    for (const post of sounds) {
      const audio = h('audio', { controls: true, preload: 'none', src: post.media.audioUrl, 'aria-label': t('explorePlaySound') });
      this.results.append(h('article', { class: 'explore-sound' },
        h('div', {}, h('b', {}, post.author?.name || 'MilkyWay'), h('p', {}, post.caption || t('exploreOriginalSound'))),
        audio,
        h('button', { class: 'link', type: 'button', onclick: () => this.openPost(post) }, t('openPost'))));
    }
  }

  #renderPosts(posts, title) {
    this.results.append(h('h2', { class: 'explore-section-title' }, title));
    if (!posts.length) {
      this.results.append(h('p', { class: 'muted center explore-message' }, t('noResults')));
      return;
    }
    this.results.append(h('div', { class: 'explore-grid' }, ...posts.map(post => {
      const media = post.media;
      const isVideo = media?.type === 'video';
      const sources = isVideo
        ? [media?.previewItems?.[0], poster(media.url, 480)].filter((source, index, list) => source && list.indexOf(source) === index)
        : [media?.previewItems?.[0] || media?.url || media?.items?.[0]].filter(Boolean);
      const authorName = post.author?.name || 'MilkyWay';
      const tile = h('button', {
        class: `explore-post${isVideo ? ' is-video' : sources.length ? '' : ' is-text'}`, type: 'button',
        'aria-label': `${authorName}: ${(post.caption || '').slice(0, 100)}`,
        onclick: () => this.openPost(post),
      });
      const showFallback = () => {
        tile.classList.add(isVideo ? 'is-video-fallback' : 'is-image-fallback');
      };
      if (sources.length || isVideo) {
        const img = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
        tile.append(img);
        let sourceIndex = 0;
        const useNextSource = () => {
          const source = sources[sourceIndex++];
          if (source) {
            setImage(img, source, 480, { onFail: useNextSource });
          } else if (isVideo) {
            img.onerror = null;
            img.removeAttribute('src');
            extractVideoThumbnail(media.url).then(frame => {
              if (!tile.isConnected) return;
              if (frame) img.src = frame;
              else showFallback();
            });
          } else {
            img.remove();
            showFallback();
          }
        };
        useNextSource();
      } else tile.append(h('span', {}, post.caption || t('explorePost')));
      tile.append(
        h('span', { class: 'explore-post-author' }, authorName),
        h('span', { class: 'explore-post-caption' }, post.caption || t('explorePost')),
      );
      return tile;
    })));
  }
}

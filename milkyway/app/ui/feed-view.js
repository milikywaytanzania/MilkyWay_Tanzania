// Feed view: full-screen vertical short-video feed on top of VerticalPager + playback manager.
//  - 3–5 slides in the DOM, recycled; video sources only on the active slide and its neighbours.
//  - Renders the device copy instantly, then merges background refreshes without moving the user.
//  - Double-tap to like (with burst), tap to pause / unmute (videos) or open full size (photos),
//    rail: profile+follow, like, comments, save, gift, share.
import { config } from '../config.js';
import { auth } from '../core/net.js';
import { bus, idle } from '../core/events.js';
import { device } from '../core/device.js';
import { setImage, poster, mediaKind } from '../core/media.js';
import { t } from '../core/i18n.js';
import { feed, actions, deletedPosts, watchPosts } from '../data/feed.js';
import { profiles } from '../data/profiles.js';
import { VerticalPager } from './pager.js';
import { playback } from './playback.js';
import { h, icon, count, toast, paintAvatar, brandMark, avatar, mediaPlaceholder } from './dom.js';
import { loadAds, loadSuggestions, weave, adImpression, adClick, dismissAd } from '../data/promoted.js';
import { openShare } from './share-sheet.js';

const DOUBLE_TAP_MS = 260;

export class FeedView {
  constructor(root, { requireLogin, openComments, openGifts, openProfile, openPost }) {
    this.root = root;
    this.hooks = { requireLogin, openComments, openGifts, openProfile, openPost };
    this.scope = null;
    this.unsubscribe = null;
    this.interacted = false;
    this.status = h('div', { class: 'feed-status', hidden: true });
    this.surface = h('div', { class: 'feed-pager', tabindex: '0', 'aria-roledescription': 'carousel', 'aria-label': 'Feed' });
    root.append(this.surface, this.status);

    this.pager = new VerticalPager(this.surface, {
      radius: device.windowRadius,
      keyOf: post => post.id,
      create: () => this.#createSlide(),
      bind: (slide, post) => this.#bind(slide, post),
      update: (slide, post) => this.#paintCounts(slide, post),
      release: slide => this.#release(slide),
      afterRender: mounted => this.#sources(mounted),
      onChange: index => {
        if (index > 0) this.interacted = true;
        this.#trackProgress();
        const item = this.pager.items[index];
        if (item?.kind === 'ad') adImpression(item.ad);
      },
      onNearEnd: () => this.source?.more(),
    });
    this.#bindEvents();
    playback.onMute(muted => this.root.classList.toggle('is-muted', muted));
    this.root.classList.toggle('is-muted', playback.muted);
    bus.on('follow', () => this.pager.mounted.forEach(slide => { this.#paintFollow(slide, slide._post); if (slide._post?.kind === 'suggest') this.#paintSuggest(slide); }));
    this.promo = { ads: [], people: [] };
    this.#loadPromoted();
    bus.on('auth', () => this.#loadPromoted());
  }

  /** Switches between "foryou" and "following". Cached posts paint immediately. */
  show(scope) {
    idle(() => watchPosts(() => this.scope).catch(error => console.warn('[feed] realtime setup failed', error)), 1800);
    if (scope === this.scope) { this.reload(); return; }
    this.scope = scope;
    this.unsubscribe?.();
    this.interacted = false;
    this.source = feed(scope);
    this.pager.setItems([], { keepKey: false });
    this.#setStatus('loading');
    this.unsubscribe = this.source.source.subscribe(value => this.#apply(value));
    const source = this.source;
    source.load().then(() => source.refresh()).then(() => this.#emptyCheck(source));
  }

  reload() {
    this.interacted = false;
    const source = this.source;
    if (!source) return Promise.resolve();
    this.#setStatus('loading');
    return source.refresh().then(() => this.#emptyCheck(source));
  }
  focus() { this.surface.focus({ preventScroll: true }); }

  // Sponsored ads and friend suggestions load in the background and are woven in once they arrive.
  #loadPromoted() {
    Promise.all([loadAds(), loadSuggestions()]).then(([ads, people]) => {
      this.promo = { ads, people };
      if (this.lastValue) this.#apply(this.lastValue);
    });
  }

  #apply(value) {
    this.lastValue = value;
    const live = post => !post.kind && !deletedPosts.has(post.id);
    const incoming = (value?.posts || []).filter(live);
    const current = this.pager.items.filter(live);
    let items = incoming;
    if (current.length && (this.interacted || this.pager.index > 0)) {
      // The user is mid-feed: update what they have, append what's new at the end — never jump.
      const byId = new Map(incoming.map(post => [post.id, post]));
      const kept = current.map(post => byId.get(post.id) || post);
      const known = new Set(kept.map(post => post.id));
      items = [...kept, ...incoming.filter(post => !known.has(post.id))];
    }
    items = weave(items, this.promo);
    this.pager.setItems(items);
    if (items.length) this.#setStatus(null);
  }

  #emptyCheck(source = this.source) {
    if (source !== this.source) return;
    if (this.pager.items.length) return this.#setStatus(null);
    if (navigator.onLine === false) return this.#setStatus('offline');
    this.#setStatus(source?.source.error ? 'feedLoadFailed' : this.scope === 'following' ? 'emptyFollowing' : 'empty');
  }

  #setStatus(kind) {
    this.status.hidden = !kind;
    if (!kind) return;
    if (kind === 'loading') { this.status.replaceChildren(h('div', { class: 'skeleton-slide', 'aria-busy': 'true', 'aria-label': t('loading') }, h('i'), h('b'), h('span'))); return; }
    this.status.replaceChildren(h('div', { class: 'empty-card' },
      h('p', {}, kind === 'offline' ? t('offline') : t(kind)),
      h('button', { class: 'pill-btn', type: 'button', onclick: () => { this.#setStatus('loading'); this.reload(); } }, t('retry'))));
  }

  // ---- Slides ----------------------------------------------------------------------------------------------
  #createSlide() {
    const video = h('video', { playsinline: true, 'webkit-playsinline': true, loop: true, muted: true, preload: 'none', disablepictureinpicture: true, disableremoteplayback: true });
    const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
    const slideshowBadge = h('span', { class: 'slideshow-badge', hidden: true, 'aria-hidden': 'true' }, '▧');
    const text = h('div', { class: 'text-card' });
    const paused = h('span', { class: 'paused-badge', html: icon.play, hidden: true });
    const missing = mediaPlaceholder(t('imageUnavailable'));
    missing.hidden = true;
    const media = h('div', { class: 'media', 'data-act': 'media' }, video, img, text, missing, paused, slideshowBadge);
    const avatarNode = h('span', { class: 'avatar' });
    const follow = h('span', { class: 'follow-plus', 'data-act': 'follow', role: 'button', 'aria-label': t('follow'), html: icon.plus });
    const rail = (act, svg, label) => h('button', { class: `rail-btn rail-${act}`, type: 'button', 'data-act': act, 'aria-label': label }, h('span', { class: 'rail-icon', html: svg }), h('b', {}, ''));
    const like = rail('like', icon.heart, 'Like');
    const comment = rail('comment', icon.comment, t('comments'));
    const save = rail('save', icon.bookmark, t('save'));
    const gift = rail('gift', icon.gift, t('gift'));
    const share = rail('share', icon.share, t('share'));
    const name = h('button', { class: 'meta-name', type: 'button', 'data-act': 'profile' });
    const caption = h('p', { class: 'meta-caption', 'data-act': 'caption' });
    const bar = h('i');
    // Sponsored label + call to action (ads) and the "Suggested for you" card; hidden on normal posts.
    const adBar = h('div', { class: 'ad-bar', hidden: true },
      h('div', { class: 'ad-line' }, h('span', { class: 'ad-tag' }, t('sponsored') === 'sponsored' ? 'Sponsored' : t('sponsored')),
        h('button', { class: 'ad-hide', type: 'button', 'data-act': 'ad-hide', 'aria-label': 'Not interested' }, '✕')),
      h('button', { class: 'ad-cta', type: 'button', 'data-act': 'ad-cta' }, ''));
    const suggest = h('div', { class: 'suggest-card', hidden: true });
    const slide = h('section', { class: 'slide', 'aria-roledescription': 'slide' },
      media, brandMark(), h('div', { class: 'shade', 'aria-hidden': 'true' }),
      h('aside', { class: 'rail' }, h('div', { class: 'rail-author', 'data-act': 'profile' }, avatarNode, follow), like, comment, save, gift, share),
      h('div', { class: 'meta' }, name, caption, adBar), suggest,
      h('div', { class: 'progress', 'aria-hidden': 'true' }, bar));
    slide._refs = { video, img, text, paused, missing, slideshowBadge, avatarNode, follow, like, comment, save, gift, share, name, caption, bar, adBar, suggest };
    // Portrait media fills the screen; landscape media is letterboxed instead of cropped.
    const fit = (w, h) => { if (w && h) slide.dataset.fit = h >= w * 1.2 ? 'cover' : 'contain'; };
    video.addEventListener('loadedmetadata', () => fit(video.videoWidth, video.videoHeight));
    video.addEventListener('error', () => {
      const post = slide._post;
      if (!post || mediaKind(post) !== 'video' || video.getAttribute('src') !== post.media.url) return;
      video.hidden = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
      slide._refs.missing.hidden = false;
    });
    img.addEventListener('load', () => fit(img.naturalWidth, img.naturalHeight));
    playback.observe(video);
    return slide;
  }

  #bind(slide, post) {
    slide._post = post;
    const r = slide._refs;
    const type = mediaKind(post);
    slide.dataset.type = type;
    if (post.kind) slide.dataset.kind = post.kind; else delete slide.dataset.kind;
    r.adBar.hidden = post.kind !== 'ad';
    r.suggest.hidden = post.kind !== 'suggest';
    r.video.hidden = type !== 'video';
    r.img.hidden = type !== 'image';
    r.text.hidden = type !== 'text';
    r.paused.hidden = true;
    r.missing.hidden = true;
    r.slideshowBadge.hidden = (post.media?.items?.length || post.media_items?.length || 0) < 2;
    r.slideshowBadge.textContent = `▧ ${post.media?.items?.length || post.media_items?.length || 0}`;
    delete slide.dataset.fit;
    r.bar.style.transform = 'scaleX(0)';
    if (type === 'video') {
      const still = poster(post.media.url, device.mediaWidth);
      still ? (r.video.poster = still) : r.video.removeAttribute('poster');
    } else r.video.removeAttribute('poster');
    if (type === 'image') {
      r.img.hidden = false;
      r.img.alt = post.caption || '';
      r.img.loading = 'lazy';
      r.img.decoding = 'async';
      r.img.fetchPriority = 'auto';
      const preview = post.media.previewItems?.[0] || post.media.url;
      setImage(r.img, preview, Math.min(720, device.mediaWidth), { quality: device.saveData ? 55 : 66, onFail: () => { if (slide._post !== post) return; r.img.hidden = true; r.missing.hidden = false; } });
    }
    else { r.img.onerror = null; r.img.removeAttribute('src'); }
    r.text.textContent = type === 'text' ? post.caption : '';
    paintAvatar(r.avatarNode, post.author, 40);
    r.name.textContent = `@${post.author.username || post.author.name}`;
    r.caption.textContent = type === 'text' ? '' : post.caption;
    r.caption.classList.remove('open');
    this.#paintCounts(slide, post);
    this.#paintFollow(slide, post);
    if (post.kind === 'ad') {
      r.name.textContent = post.ad.business || post.ad.title || '';
      r.caption.textContent = [post.ad.title && post.ad.business ? post.ad.title : '', post.ad.description || ''].filter(Boolean).join(' — ');
      r.adBar.querySelector('.ad-cta').textContent = `${post.ad.ctaLabel || (t('learnMore') === 'learnMore' ? 'Learn more' : t('learnMore'))} ›`;
      r.adBar.querySelector('.ad-cta').hidden = !post.ad.destination;
    }
    if (post.kind === 'suggest') { r.name.textContent = ''; r.caption.textContent = ''; this.#paintSuggest(slide); }
  }

  #paintSuggest(slide) {
    const people = this.promo.people.filter(person => !profiles.isFollowing(person.id)).slice(0, 6);
    const title = t('suggestedForYou') === 'suggestedForYou' ? 'Suggested for you' : t('suggestedForYou');
    slide._refs.suggest.replaceChildren(h('b', { class: 'suggest-title' }, title),
      people.length ? h('div', { class: 'suggest-grid' }, ...people.map(person => h('div', { class: 'suggest-person' },
        h('button', { class: 'suggest-face', type: 'button', 'data-act': 'suggest-profile', 'data-uid': person.id }, avatar(person, 64)),
        h('b', {}, person.name), h('small', { class: 'muted' }, person.mutual ? `${count(person.mutual)} ${t('followers').toLowerCase()}` : person.username ? `@${person.username}` : ''),
        h('button', { class: 'pill-btn hot', type: 'button', 'data-act': 'suggest-follow', 'data-uid': person.id }, t('follow')))))
        : h('p', { class: 'muted center' }, '✓'));
  }

  #paintCounts(slide, post) {
    slide._post = post;
    const r = slide._refs;
    r.like.classList.toggle('on', !!post.liked);
    r.like.setAttribute('aria-pressed', String(!!post.liked));
    r.like.querySelector('b').textContent = count(post.likes);
    r.comment.querySelector('b').textContent = count(post.comments);
    r.save.classList.toggle('on', !!post.saved);
    r.save.setAttribute('aria-pressed', String(!!post.saved));
    r.save.querySelector('b').textContent = '';
    r.gift.querySelector('b').textContent = '';
    r.share.querySelector('b').textContent = '';
  }

  #paintFollow(slide, post) {
    if (!post) return;
    if (post.kind) { slide._refs.follow.hidden = true; return; }
    const own = post.author.id === auth.userId;
    slide._refs.follow.hidden = own || profiles.isFollowing(post.author.id);
  }

  #release(slide) {
    playback.source(slide._refs.video, null, 99);
    if (device.lowEnd) slide._refs.img.removeAttribute('src');
  }

  /** Attaches video sources only around the active slide. */
  #sources(mounted) {
    const active = this.pager.index;
    mounted.forEach((slide, index) => {
      const post = slide._post;
      const url = post && mediaKind(post) === 'video' ? post.media.url : null;
      playback.source(slide._refs.video, url, index - active, { saveData: device.saveData || device.slowNetwork });
    });
  }

  #trackProgress() {
    this.progressOff?.();
    const slide = this.pager.slideAt(this.pager.index);
    const video = slide?._refs.video;
    if (!video || !slide._post || mediaKind(slide._post) !== 'video') return;
    const bar = slide._refs.bar;
    const tick = () => { if (video.duration) bar.style.transform = `scaleX(${video.currentTime / video.duration})`; };
    video.addEventListener('timeupdate', tick);
    this.progressOff = () => video.removeEventListener('timeupdate', tick);
  }

  // ---- Interaction -----------------------------------------------------------------------------------------
  #bindEvents() {
    let lastTap = 0, tapTimer = 0;
    this.surface.addEventListener('click', event => {
      const target = event.target.closest('[data-act]');
      const slide = event.target.closest('.slide');
      const post = slide?._post;
      if (!target || !post) return;
      const act = target.dataset.act;
      if (post.kind) {
        if (act === 'ad-cta' || (act === 'media' && post.kind === 'ad' && mediaKind(post) !== 'video' && post.ad.destination)) {
          event.stopPropagation();
          adClick(post.ad);
          if (/^https?:\/\//i.test(post.ad.destination || '')) window.open(post.ad.destination, '_blank', 'noopener');
          return;
        }
        if (act === 'ad-hide') {
          event.stopPropagation();
          dismissAd(post.ad);
          this.promo = { ...this.promo, ads: this.promo.ads.filter(ad => ad.id !== post.ad.id) };
          this.pager.next?.();
          setTimeout(() => this.lastValue && this.#apply(this.lastValue), 350);
          return;
        }
        const uid = target.dataset.uid;
        if (act === 'suggest-follow' && uid) { event.stopPropagation(); if (this.hooks.requireLogin()) actions.follow(uid, true).catch(error => toast(error.message)); return; }
        if (act === 'suggest-profile' && uid) { event.stopPropagation(); const person = this.promo.people.find(p => p.id === uid); this.hooks.openProfile(person || { id: uid }); return; }
        if (act === 'media' && mediaKind(post) === 'video') this.#tap(slide);
        return;
      }
      if (act === 'media') {
        const now = event.timeStamp;
        if (now - lastTap < DOUBLE_TAP_MS) {
          clearTimeout(tapTimer); lastTap = 0;
          this.#burst(slide, event.clientX, event.clientY);
          if (!post.liked) this.#like(post, true);
          return;
        }
        lastTap = now;
        tapTimer = setTimeout(() => this.#tap(slide), DOUBLE_TAP_MS);
        return;
      }
      event.stopPropagation();
      if (act === 'like') this.#like(post, !post.liked);
      else if (act === 'save') { if (this.hooks.requireLogin()) actions.save(post, !post.saved).catch(error => toast(error.message)); }
      else if (act === 'follow') { if (this.hooks.requireLogin()) actions.follow(post.author.id, true).catch(error => toast(error.message)); }
      else if (act === 'comment') this.hooks.openComments(post);
      else if (act === 'gift') { if (this.hooks.requireLogin()) this.hooks.openGifts({ postId: post.id, to: post.author }); }
      else if (act === 'share') this.#share(post);
      else if (act === 'profile') this.hooks.openProfile(post.author);
      else if (act === 'caption') target.classList.toggle('open');
    });
  }

  #tap(slide) {
    const post = slide._post;
    if (!post) return;
    const kind = mediaKind(post);
    // Photos open full size in the post popup (pinch-free zoom, comments, likes), like a tap on a Nova grid tile.
    if (kind === 'image') { if (slide._refs.missing.hidden) this.hooks.openPost?.(post); return; }
    if (kind !== 'video') return;
    const video = slide._refs.video;
    if (playback.muted) { playback.setMuted(false); if (video.paused) playback.toggle(video); return; }
    const playing = playback.toggle(video);
    slide._refs.paused.hidden = playing;
  }

  #like(post, on) {
    if (!this.hooks.requireLogin()) return;
    if (navigator.vibrate && on) navigator.vibrate(8);
    actions.like(post, on).then(result => { if (result === 'queued') toast(t('queued')); }).catch(error => toast(error.message));
  }

  #burst(slide, x, y) {
    const rect = slide.getBoundingClientRect();
    const heart = h('span', { class: 'burst', html: icon.heart, style: `left:${x - rect.left}px;top:${y - rect.top}px;--r:${Math.round(Math.random() * 30 - 15)}deg` });
    heart.addEventListener('animationend', () => heart.remove(), { once: true });
    slide.append(heart);
  }

  async #share(post) {
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}?post=${encodeURIComponent(post.id)}`;
    openShare({ title: post.author.name || 'MilkyWay', text: (post.caption || '').slice(0, 120), url });
  }
}

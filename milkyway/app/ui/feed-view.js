// Feed view: full-screen vertical short-video feed on top of VerticalPager + playback manager.
//  - 3–5 slides in the DOM, recycled; video sources only on the active slide and its neighbours.
//  - Renders the device copy instantly, then merges background refreshes without moving the user.
//  - Double-tap to like (with burst), tap to pause / unmute, rail: profile+follow, like, comments, save, gift, share.
import { config } from '../config.js';
import { auth } from '../core/net.js';
import { bus } from '../core/events.js';
import { device } from '../core/device.js';
import { image, poster } from '../core/media.js';
import { t } from '../core/i18n.js';
import { feed, actions } from '../data/feed.js';
import { profiles } from '../data/profiles.js';
import { VerticalPager } from './pager.js';
import { playback } from './playback.js';
import { h, icon, count, toast, paintAvatar, brandMark } from './dom.js';

const DOUBLE_TAP_MS = 260;

export class FeedView {
  constructor(root, { requireLogin, openComments, openGifts, openProfile }) {
    this.root = root;
    this.hooks = { requireLogin, openComments, openGifts, openProfile };
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
      },
      onNearEnd: () => this.source?.more(),
    });
    this.#bindEvents();
    playback.onMute(muted => this.root.classList.toggle('is-muted', muted));
    this.root.classList.toggle('is-muted', playback.muted);
    bus.on('follow', () => this.pager.mounted.forEach(slide => this.#paintFollow(slide, slide._post)));
  }

  /** Switches between "foryou" and "following". Cached posts paint immediately. */
  show(scope) {
    if (scope === this.scope) { this.source.refresh(); return; }
    this.scope = scope;
    this.unsubscribe?.();
    this.interacted = false;
    this.source = feed(scope);
    this.pager.setItems([], { keepKey: false });
    this.#setStatus('loading');
    this.unsubscribe = this.source.source.subscribe(value => this.#apply(value));
    this.source.load().then(value => { if (!value) this.source.refresh().then(() => this.#emptyCheck()); else this.#emptyCheck(); });
  }

  reload() { this.interacted = false; return this.source?.refresh().then(() => this.#emptyCheck()); }
  focus() { this.surface.focus({ preventScroll: true }); }

  #apply(value) {
    const incoming = value?.posts || [];
    const current = this.pager.items;
    let items = incoming;
    if (current.length && (this.interacted || this.pager.index > 0)) {
      // The user is mid-feed: update what they have, append what's new at the end — never jump.
      const byId = new Map(incoming.map(post => [post.id, post]));
      const kept = current.map(post => byId.get(post.id) || post);
      const known = new Set(kept.map(post => post.id));
      items = [...kept, ...incoming.filter(post => !known.has(post.id))];
    }
    this.pager.setItems(items);
    if (items.length) this.#setStatus(null);
  }

  #emptyCheck() {
    if (this.pager.items.length) return this.#setStatus(null);
    this.#setStatus(navigator.onLine === false ? 'offline' : this.scope === 'following' ? 'emptyFollowing' : 'empty');
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
    const text = h('div', { class: 'text-card' });
    const paused = h('span', { class: 'paused-badge', html: icon.play, hidden: true });
    const media = h('div', { class: 'media', 'data-act': 'media' }, video, img, text, paused);
    const avatarNode = h('span', { class: 'avatar', style: '--s:46px' });
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
    const slide = h('section', { class: 'slide', 'aria-roledescription': 'slide' },
      media, brandMark(), h('div', { class: 'shade', 'aria-hidden': 'true' }),
      h('aside', { class: 'rail' }, h('div', { class: 'rail-author', 'data-act': 'profile' }, avatarNode, follow), like, comment, save, gift, share),
      h('div', { class: 'meta' }, name, caption),
      h('div', { class: 'progress', 'aria-hidden': 'true' }, bar));
    slide._refs = { video, img, text, paused, avatarNode, follow, like, comment, save, gift, share, name, caption, bar };
    // Portrait media fills the screen; landscape media is letterboxed instead of cropped.
    const fit = (w, h) => { if (w && h) slide.dataset.fit = h >= w * 1.2 ? 'cover' : 'contain'; };
    video.addEventListener('loadedmetadata', () => fit(video.videoWidth, video.videoHeight));
    img.addEventListener('load', () => fit(img.naturalWidth, img.naturalHeight));
    playback.observe(video);
    return slide;
  }

  #bind(slide, post) {
    slide._post = post;
    const r = slide._refs;
    const type = post.media?.type || 'text';
    slide.dataset.type = type;
    r.video.hidden = type !== 'video';
    r.img.hidden = type !== 'image';
    r.text.hidden = type !== 'text';
    r.paused.hidden = true;
    delete slide.dataset.fit;
    r.bar.style.transform = 'scaleX(0)';
    if (type === 'video') {
      const still = poster(post.media.url, device.mediaWidth);
      still ? (r.video.poster = still) : r.video.removeAttribute('poster');
    } else r.video.removeAttribute('poster');
    if (type === 'image') { r.img.fetchPriority = 'high'; r.img.src = image(post.media.url, device.mediaWidth); }
    else r.img.removeAttribute('src');
    r.text.textContent = type === 'text' ? post.caption : '';
    paintAvatar(r.avatarNode, post.author, 46);
    r.name.textContent = `@${post.author.username || post.author.name}`;
    r.caption.textContent = type === 'text' ? '' : post.caption;
    r.caption.classList.remove('open');
    this.#paintCounts(slide, post);
    this.#paintFollow(slide, post);
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
      const url = post?.media?.type === 'video' ? post.media.url : null;
      playback.source(slide._refs.video, url, index - active, { saveData: device.saveData });
    });
  }

  #trackProgress() {
    this.progressOff?.();
    const slide = this.pager.slideAt(this.pager.index);
    const video = slide?._refs.video;
    if (!video || slide._post?.media?.type !== 'video') return;
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
    if (slide._post?.media?.type !== 'video') return;
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
    try {
      if (navigator.share) await navigator.share({ title: post.author.name, text: post.caption.slice(0, 120), url });
      else { await navigator.clipboard.writeText(url); toast(t('linkCopied')); }
    } catch (error) { if (error?.name !== 'AbortError') toast(url); }
  }
}


// Post detail: full-screen popup for a post tapped in a profile grid (photos, videos and text posts alike).
// Swipe/arrow keys step through the grid; the owner can delete the post from here.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { setImage, image as imageUrl, poster, mediaKind } from '../core/media.js';
import { device } from '../core/device.js';
import { actions } from '../data/feed.js';
import { h, icon, count, ago, toast, brandMark, mediaPlaceholder } from './dom.js';
import { openShare } from './share-sheet.js';

const SWIPE_PX = 60;

/** 'video' | 'image' | 'text' for a mw_posts row or a feed post. */
export const postKind = mediaKind;
// Full-size photos: as sharp as the screen can show (up to 2560 px), straight from the original if the CDN fails.
const fullWidth = () => Math.min(2560, Math.round(Math.max(window.innerWidth || 720, window.innerHeight || 720) * Math.min(window.devicePixelRatio || 1, 2.5)));
const photoItems = post => {
  const items = post.media?.items || post.media_items;
  const urls = Array.isArray(items) ? items.filter(url => typeof url === 'string' && /^https:\/\//i.test(url)).slice(0, 8) : [];
  const primary = post.media?.url || post.media_url || '';
  return urls.length ? urls : primary ? [primary] : [];
};
const photoPreviewItems = post => {
  const items = post.media?.previewItems || post.media_preview_items;
  return Array.isArray(items) ? items.filter(url => typeof url === 'string' && /^https:\/\//i.test(url)).slice(0, 8) : [];
};

export class PostViewer {
  constructor({ requireLogin, openComments, onDeleted } = {}) {
    this.hooks = { requireLogin, openComments, onDeleted };
    this.stage = h('div', { class: 'pv-media' });
    this.caption = h('p', { class: 'pv-caption' });
    this.when = h('small', { class: 'muted' });
    this.sound = h('div', { class: 'pv-sound' });
    this.likeBtn = h('button', { class: 'pv-act', type: 'button', 'aria-label': t('like') }, h('span', { html: icon.heart }), h('b', {}, '0'));
    this.commentBtn = h('button', { class: 'pv-act', type: 'button', 'aria-label': t('comments') }, h('span', { html: icon.comment }), h('b', {}, '0'));
    this.shareBtn = h('button', { class: 'pv-act', type: 'button', 'aria-label': t('share') }, h('span', { html: icon.share }), h('b', {}, ''));
    this.deleteBtn = h('button', { class: 'pill-btn danger pv-delete', type: 'button' }, t('deletePost'));
    this.prevBtn = h('button', { class: 'icon-btn pv-nav pv-prev', type: 'button', 'aria-label': t('previous'), html: '‹' });
    this.nextBtn = h('button', { class: 'icon-btn pv-nav pv-next', type: 'button', 'aria-label': t('next'), html: '›' });
    this.closeBtn = h('button', { class: 'icon-btn pv-close', type: 'button', 'aria-label': t('close'), html: icon.close });
    this.root = h('div', { class: 'pv-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('post'), hidden: true, tabindex: '-1' },
      h('div', { class: 'pv-frame' }, this.stage, brandMark(), this.prevBtn, this.nextBtn, this.closeBtn),
      h('div', { class: 'pv-info' }, this.caption, this.when, this.sound,
        h('div', { class: 'pv-actions' }, this.likeBtn, this.commentBtn, this.shareBtn, this.deleteBtn)));
    document.body.append(this.root);

    this.closeBtn.onclick = () => this.close();
    this.prevBtn.onclick = () => this.step(-1);
    this.nextBtn.onclick = () => this.step(1);
    this.likeBtn.onclick = () => this.#like();
    this.commentBtn.onclick = () => { if (this.post) this.hooks.openComments?.(this.#feedShape()); };
    this.shareBtn.onclick = () => this.#share();
    this.#armDelete();
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.close();
      else if (event.key === 'ArrowLeft') this.step(-1);
      else if (event.key === 'ArrowRight') this.step(1);
    });
    let startX = null, startY = null;
    this.stage.addEventListener('pointerdown', event => { startX = event.clientX; startY = event.clientY; });
    this.stage.addEventListener('pointerup', event => {
      if (startX == null) return;
      const dx = event.clientX - startX, dy = event.clientY - startY;
      startX = null;
      this.swiped = Math.abs(dx) > 10 || Math.abs(dy) > 10;
      if (this.stage.classList.contains('zoomed')) return; // panning a zoomed photo
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
        if (this.post && postKind(this.post) === 'image' && photoItems(this.post).length > 1) this.#stepImage(dx < 0 ? 1 : -1);
        else this.step(dx < 0 ? 1 : -1);
      }
      else if (dy > SWIPE_PX * 1.5 && Math.abs(dy) > Math.abs(dx)) this.close();
    });
  }

  get isOpen() { return !this.root.hidden; }

  /** posts: the grid's list; index: the tapped one; own: the viewer owns these posts. */
  open(posts, index, { own = false, onClose = null } = {}) {
    this.posts = posts;
    this.own = own;
    this.onClose = onClose;
    this.returnFocus = document.activeElement;
    if (document.body.lastElementChild !== this.root) document.body.append(this.root);
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('open'));
    this.#show(index);
    this.root.focus({ preventScroll: true });
  }

  close() {
    if (this.root.hidden) return;
    this.#stopVideo();
    this.#stopSlideshow();
    this.#clearImagePreloads();
    this.root.classList.remove('open');
    this.root.hidden = true;
    this.stage.replaceChildren();
    this.sound.replaceChildren();
    this.stage.classList.remove('zoomed', 'loading');
    this.returnFocus?.focus?.({ preventScroll: true });
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }

  step(delta) {
    const next = this.index + delta;
    if (!this.posts || next < 0 || next >= this.posts.length) return;
    this.#show(next);
  }

  #show(index) {
    this.#stopVideo();
    this.#stopSlideshow();
    this.#clearImagePreloads();
    this.stage.classList.remove('zoomed', 'loading');
    this.index = index;
    const post = this.post = this.posts[index];
    const kind = postKind(post);
    const url = post.media_url || post.media?.url || '';
    this.root.dataset.style = ['fade', 'zoom', 'cinema', 'page', 'slide'].includes(post.media?.style || post.slideshow_style) ? (post.media?.style || post.slideshow_style) : 'fade';
    this.root.dataset.kind = kind;
    if (kind === 'video') {
      const video = h('video', { controls: true, playsinline: true, autoplay: true, loop: true, preload: 'auto', src: url });
      const still = poster(url, 720);
      if (still) video.poster = still;
      video.addEventListener('error', () => {
        if (this.post !== post || !this.stage.contains(video)) return;
        this.stage.replaceChildren(mediaPlaceholder(t('imageUnavailable')));
      });
      video.play?.()?.catch?.(() => { video.muted = true; video.play().catch(() => {}); });
      this.stage.replaceChildren(video);
    } else if (kind === 'image') {
      this.imageIndex = 0;
      this.#renderImage(post, 0);
    } else {
      this.stage.replaceChildren(h('div', { class: 'pv-text' }, post.caption || ''));
    }
    this.#renderSoundtrack(post);
    this.caption.textContent = kind === 'text' ? '' : post.caption || '';
    this.caption.hidden = !this.caption.textContent;
    const created = post.created_at || post.createdAt;
    this.when.textContent = created ? ago(created) : '';
    this.prevBtn.hidden = index <= 0;
    this.nextBtn.hidden = index >= this.posts.length - 1;
    const authorId = String(post.author_id || post.author?.id || (this.own ? auth.userId : ''));
    this.deleteBtn.hidden = !(auth.userId && authorId === auth.userId);
    this.#resetDelete();
    this.#paintCounts();
    this.#loadCounts(post);
  }

  #stopVideo() {
    const video = this.stage.querySelector('video');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    const audio = this.sound.querySelector('audio');
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }

  #renderImage(post, index) {
    const items = photoItems(post);
    const url = items[index];
    if (!url) return;
    this.imageIndex = index;
    const img = h('img', { class: `pv-image pv-image-${this.root.dataset.style || 'fade'}`, alt: post.caption || '', decoding: 'async', draggable: 'false', fetchpriority: 'high' });
    const preview = photoPreviewItems(post)[index] || url;
    const progressive = preview !== url;
    const controls = [];
    if (items.length > 1) {
      controls.push(
        h('button', { class: 'icon-btn pv-image-prev', type: 'button', 'aria-label': t('previous'), disabled: index <= 0, onclick: event => { event.stopPropagation(); this.#stepImage(-1); } }, '‹'),
        h('span', { class: 'pv-image-count' }, `${t('photoNumber')} ${index + 1}/${items.length}`),
        h('button', { class: 'icon-btn pv-image-next', type: 'button', 'aria-label': t('next'), disabled: index >= items.length - 1, onclick: event => { event.stopPropagation(); this.#stepImage(1); } }, '›'),
        h('button', { class: 'pill-btn pv-slideshow-play', type: 'button', onclick: event => { event.stopPropagation(); this.#toggleSlideshow(items.length); } },
          this.slideshowPlaying ? t('pauseSlideshow') : t('playSlideshow')));
    }
    this.stage.classList.add('loading');
    this.#preloadImages(items, index);
    const showMissing = () => {
      if (this.post !== post || this.imageIndex !== index) return;
      this.stage.classList.remove('loading');
      this.stage.replaceChildren(mediaPlaceholder(t('imageUnavailable')));
    };
    const loadFull = () => {
      if (this.post !== post || this.imageIndex !== index || !this.stage.contains(img)) return;
      setImage(img, url, fullWidth(), { quality: device.saveData ? 72 : 82, onFail: showMissing });
    };
    img.addEventListener('load', () => {
      if (this.post !== post || this.imageIndex !== index) return;
      this.stage.classList.remove('loading');
      if (progressive) {
        const schedule = window.requestIdleCallback || (fn => setTimeout(fn, 0));
        schedule(loadFull);
      }
    }, { once: true });
    img.addEventListener('error', () => {
      if (this.post !== post || this.imageIndex !== index) return;
      if (progressive) loadFull();
      else showMissing();
    }, { once: true });
    setImage(img, progressive ? preview : url, progressive ? Math.min(720, fullWidth()) : fullWidth(), {
      quality: progressive ? 65 : device.saveData ? 72 : 82,
      onFail: progressive ? loadFull : showMissing,
    });
    img.addEventListener('click', () => { if (!this.swiped) this.stage.classList.toggle('zoomed'); });
    this.stage.replaceChildren(img, ...controls);
  }

  #preloadImages(items, index) {
    this.preloadImages ||= new Map();
    const ahead = device.saveData ? 0 : device.slowNetwork ? 1 : 2;
    const previews = photoPreviewItems(this.post);
    for (let offset = 1; offset <= ahead; offset++) {
      const next = index + offset;
      if (next >= items.length) break;
      const url = previews[next] || items[next];
      if (!url || this.preloadImages.has(url)) continue;
      const image = new Image();
      image.decoding = 'async';
      image.fetchPriority = 'low';
      image.src = imageUrl(url, Math.min(720, fullWidth()), 65);
      this.preloadImages.set(url, image);
    }
    for (const [url, image] of this.preloadImages) {
      if (!items.includes(url) && !previews.includes(url)) {
        image.src = '';
        this.preloadImages.delete(url);
      }
    }
  }

  #clearImagePreloads() {
    for (const image of this.preloadImages?.values() || []) image.src = '';
    this.preloadImages?.clear();
  }

  #stepImage(delta) {
    const items = photoItems(this.post);
    const next = this.imageIndex + delta;
    if (next < 0 || next >= items.length) return;
    this.#renderImage(this.post, next);
    if (this.slideshowPlaying) {
      clearTimeout(this.slideTimer);
      this.#scheduleSlideshow(items.length);
    }
  }

  #toggleSlideshow(count) {
    if (this.slideshowPlaying) {
      this.#stopSlideshow();
      this.#renderImage(this.post, this.imageIndex);
      return;
    }
    this.slideshowPlaying = true;
    this.#renderImage(this.post, this.imageIndex);
    this.#scheduleSlideshow(count);
  }

  #scheduleSlideshow(count) {
    const generation = this.slideSchedule = (this.slideSchedule || 0) + 1;
    const advance = () => {
      if (!this.slideshowPlaying || !this.post) return;
      const next = (this.imageIndex + 1) % count;
      const nextUrl = photoItems(this.post)[next];
      const preloaded = this.preloadImages?.get(nextUrl);
      const ready = preloaded?.complete ? Promise.resolve() : preloaded?.decode?.().catch(() => {}) || Promise.resolve();
      ready.then(() => {
        if (!this.slideshowPlaying || !this.post || generation !== this.slideSchedule) return;
        this.slideTimer = setTimeout(() => {
          this.#renderImage(this.post, next);
          this.#scheduleSlideshow(count);
        }, 3500);
      });
    };
    advance();
  }

  #stopSlideshow() {
    clearTimeout(this.slideTimer);
    this.slideSchedule = (this.slideSchedule || 0) + 1;
    this.slideTimer = null;
    this.slideshowPlaying = false;
  }

  #renderSoundtrack(post) {
    const url = post.media?.audioUrl || post.audio_url || '';
    this.sound.replaceChildren();
    if (typeof url === 'string' && /^https:\/\//i.test(url)) {
      this.sound.append(h('small', { class: 'muted' }, t('backgroundAudio')), h('audio', { controls: true, preload: 'none', src: url }));
    }
  }

  #paintCounts() {
    const post = this.post;
    this.likeBtn.classList.toggle('on', !!post.liked);
    this.likeBtn.setAttribute('aria-pressed', String(!!post.liked));
    this.likeBtn.querySelector('b').textContent = count(post.likes || 0);
    this.commentBtn.querySelector('b').textContent = count(post.comments || 0);
  }

  async #loadCounts(post) {
    if (post._counted) return;
    try {
      const sb = await supabase();
      const head = { count: 'exact', head: true };
      const [likes, comments, mine] = await Promise.all([
        sb.from('mw_signals').select('post_id', head).eq('post_id', post.id).eq('kind', 'light'),
        sb.from('mw_echoes').select('post_id', head).eq('post_id', post.id),
        auth.userId ? sb.from('mw_signals').select('post_id').eq('post_id', post.id).eq('user_id', auth.userId).eq('kind', 'light').limit(1) : Promise.resolve({ data: [] }),
      ]);
      post.likes = likes.count || 0;
      post.comments = comments.count || 0;
      post.liked = !!mine.data?.length;
      post._counted = true;
      if (this.post === post) this.#paintCounts();
    } catch { /* counts stay at their last value */ }
  }

  #feedShape() {
    const post = this.post;
    return { id: post.id, caption: post.caption || '', likes: post.likes || 0, comments: post.comments || 0, liked: !!post.liked };
  }

  #like() {
    const post = this.post;
    if (!post || !this.hooks.requireLogin?.()) return;
    const on = !post.liked;
    post.liked = on;
    post.likes = Math.max(0, (post.likes || 0) + (on ? 1 : -1));
    this.#paintCounts();
    actions.like(this.#feedShape(), on).catch(error => {
      post.liked = !on;
      post.likes = Math.max(0, post.likes + (on ? -1 : 1));
      if (this.post === post) this.#paintCounts();
      toast(error?.message || t('retry'));
    });
  }

  async #share() {
    const post = this.post;
    const url = `${location.origin}/share/${encodeURIComponent(post.id)}`;
    openShare({ title: post.author?.name || 'MilkyWay', text: (post.caption || '').slice(0, 120), url });
  }

  // Delete needs a second tap within 3 s.
  #armDelete() {
    this.deleteBtn.addEventListener('click', async () => {
      if (!this.armed) {
        this.deleteBtn.textContent = t('tapAgainDelete');
        this.deleteBtn.classList.add('armed');
        this.armed = setTimeout(() => this.#resetDelete(), 3000);
        return;
      }
      this.#resetDelete();
      const post = this.post;
      this.deleteBtn.disabled = true;
      this.deleteBtn.textContent = t('deleting');
      try {
        await actions.remove(post);
        toast(t('postDeleted'));
        const at = this.posts.indexOf(post);
        if (at >= 0) this.posts.splice(at, 1);
        this.hooks.onDeleted?.(post);
        if (!this.posts.length) this.close();
        else this.#show(Math.min(at, this.posts.length - 1));
      } catch (error) {
        toast(error?.message || t('deleteFailed'));
      } finally {
        this.deleteBtn.disabled = false;
        this.#resetDelete();
      }
    });
  }

  #resetDelete() {
    clearTimeout(this.armed);
    this.armed = 0;
    this.deleteBtn.textContent = t('deletePost');
    this.deleteBtn.classList.remove('armed');
  }
}

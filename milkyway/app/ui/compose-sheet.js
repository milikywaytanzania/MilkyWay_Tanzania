// Create photo, slideshow, video or text posts. All slideshow assistance runs locally on the device.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { profiles } from '../data/profiles.js';
import { feed } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_PHOTOS = 8;
const SLIDESHOW_STYLES = ['fade', 'zoom', 'cinema'];

export class ComposeSheet {
  constructor({ onPublished } = {}) {
    this.onPublished = onPublished;
    this.sheet = new Sheet({ title: t('newPost'), className: 'compose-sheet', onClose: () => { this.#releaseMedia(); this.#pickAudio(null); } });
    this.files = [];
    this.preview = h('div', { class: 'compose-preview' });
    this.mediaInput = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true, onchange: () => this.#pickMedia([...this.mediaInput.files]) });
    this.audioInput = h('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: () => this.#pickAudio(this.audioInput.files[0]) });
    this.caption = h('textarea', { class: 'field area', maxlength: '2200', placeholder: t('captionPlaceholder') });
    this.style = h('select', { class: 'field', 'aria-label': t('slideshowStyle') },
      h('option', { value: 'fade' }, t('styleFade')),
      h('option', { value: 'zoom' }, t('styleZoom')),
      h('option', { value: 'cinema' }, t('styleCinema')));
    this.assist = h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#autoStyle() }, t('autoStyle'));
    this.audioPreview = h('div', { class: 'compose-audio-preview' });
    this.message = h('p', { class: 'muted', role: 'status' });
    this.submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('publish'));
    this.sheet.body.append(h('form', { class: 'stack', onsubmit: event => { event.preventDefault(); this.#publish(); } },
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => this.mediaInput.click() }, t('choosePhotosOrVideo')),
      this.mediaInput, this.preview,
      h('div', { class: 'compose-assist' }, this.assist, this.style),
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => this.audioInput.click() }, t('attachAudio')),
      this.audioInput, this.audioPreview,
      this.caption, this.submit, this.message));
  }

  open() { this.message.textContent = ''; this.sheet.open(); }

  #releaseMedia() {
    for (const entry of this.files) URL.revokeObjectURL(entry.url);
    this.files = [];
  }

  #pickMedia(files) {
    this.#releaseMedia();
    this.mediaInput.value = '';
    this.preview.replaceChildren();
    if (!files.length) return;
    const videos = files.filter(file => file.type.startsWith('video/'));
    if (videos.length && (files.length > 1 || videos.length > 1)) { this.message.textContent = t('oneVideoOnly'); return; }
    if (files.length > MAX_PHOTOS) { this.message.textContent = t('slideshowPhotoLimit'); return; }
    const video = videos.length === 1;
    for (const file of files) {
      if ((!video && !file.type.startsWith('image/')) || (video && file !== videos[0])) { this.message.textContent = t('mediaType'); return; }
      if (file.size > (video ? MAX_VIDEO : MAX_IMAGE)) { this.message.textContent = video ? t('videoTooBig') : t('imageTooBig'); return; }
    }
    this.files = files.map(file => ({ file, url: URL.createObjectURL(file) }));
    this.message.textContent = '';
    for (const [index, entry] of this.files.entries()) {
      const media = video
        ? h('video', { src: entry.url, controls: true, playsinline: true, muted: true, preload: 'metadata' })
        : h('img', { src: entry.url, alt: `${t('slide')} ${index + 1}` });
      this.preview.append(h('div', { class: 'compose-photo' }, media,
        h('span', { class: 'compose-photo-index' }, String(index + 1)),
        h('button', { class: 'link', type: 'button', 'aria-label': `${t('remove')} ${index + 1}`, onclick: () => this.#removePhoto(index) }, t('remove'))));
    }
    if (!video && files.length > 1) this.preview.prepend(h('small', { class: 'muted compose-count' }, `${files.length} ${t('photosInSlideshow')}`));
  }

  #removePhoto(index) {
    const [removed] = this.files.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.url);
    this.#pickMedia(this.files.map(entry => entry.file));
  }

  #pickAudio(file) {
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioFile = null;
    this.audioUrl = null;
    this.audioInput.value = '';
    this.audioPreview.replaceChildren();
    if (!file) return;
    if (!file.type.startsWith('audio/')) { this.message.textContent = t('audioFileOnly'); return; }
    if (file.size > MAX_AUDIO) { this.message.textContent = t('audioTooBig'); return; }
    this.audioFile = file;
    this.audioUrl = URL.createObjectURL(file);
    this.audioPreview.append(h('audio', { src: this.audioUrl, controls: true, preload: 'metadata' }),
      h('button', { class: 'link', type: 'button', onclick: () => this.#pickAudio(null) }, t('remove')));
    this.message.textContent = '';
  }

  async #autoStyle() {
    if (this.files.length < 2 || this.files.some(entry => !entry.file.type.startsWith('image/'))) {
      this.message.textContent = t('pickSlideshowFirst');
      return;
    }
    let portraitCount = 0;
    try {
      for (const { file } of this.files) {
        const bitmap = await createImageBitmap(file);
        if (bitmap.height > bitmap.width * 1.15) portraitCount++;
        bitmap.close();
      }
    } catch (error) {
      console.warn('[compose] slideshow style analysis unavailable', error);
    }
    this.style.value = this.files.length >= 5 || portraitCount >= Math.ceil(this.files.length / 2) ? 'zoom' : 'cinema';
    this.message.textContent = t('autoStyleApplied');
  }

  async #upload(sb, file) {
    const name = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-100) || 'media';
    const path = `milkyway/${auth.userId}/${Date.now()}-${crypto.randomUUID()}-${name}`;
    const uploaded = await sb.storage.from('portfolio').upload(path, file, { contentType: file.type });
    if (uploaded.error) throw uploaded.error;
    return sb.storage.from('portfolio').getPublicUrl(path).data.publicUrl;
  }

  async #publish() {
    const caption = this.caption.value.trim();
    if (!caption && !this.files.length) { this.message.textContent = t('writeOrPick'); return; }
    if (!auth.signedIn()) return;
    this.submit.disabled = true; this.message.textContent = t('uploading');
    try {
      const sb = await supabase();
      const video = this.files[0]?.file.type.startsWith('video/');
      const mediaItems = video ? [] : await Promise.all(this.files.map(entry => this.#upload(sb, entry.file)));
      const media_url = video ? await this.#upload(sb, this.files[0].file) : mediaItems[0] || null;
      const audio_url = this.audioFile ? await this.#upload(sb, this.audioFile) : null;
      const media_type = video ? 'video' : media_url ? 'image' : null;
      const author_name = profiles.peek(auth.userId)?.name || auth.name;
      const { error } = await sb.from('mw_posts').insert({
        author_id: auth.userId, author_name, caption: caption || null, media_url, media_type,
        media_items: mediaItems, audio_url, slideshow_style: this.style.value,
      });
      if (error) throw error;
      this.caption.value = ''; this.#releaseMedia(); this.#pickAudio(null);
      this.preview.replaceChildren(); this.message.textContent = '';
      this.sheet.close();
      toast(t('published'));
      for (const scope of ['foryou', 'following']) feed(scope).refresh().catch(() => {});
      this.onPublished?.();
    } catch (error) {
      this.message.textContent = error?.message || t('retry');
    } finally { this.submit.disabled = false; }
  }
}

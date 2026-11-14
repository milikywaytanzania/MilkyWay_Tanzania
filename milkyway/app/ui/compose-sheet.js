// Create: the centre action button. Publishes a photo, video or text post to the feed.
// Media goes to the "portfolio" storage bucket under milkyway/<user id>/ (same layout as earlier MilkyWay posts),
// then one row is added to mw_posts as the signed-in user.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { profiles } from '../data/profiles.js';
import { feed } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;

export class ComposeSheet {
  constructor({ onPublished } = {}) {
    this.onPublished = onPublished;
    this.sheet = new Sheet({ title: t('newPost'), className: 'compose-sheet' });
    this.file = null;
    this.preview = h('div', { class: 'compose-preview' });
    this.input = h('input', { type: 'file', accept: 'image/*,video/*', hidden: true, onchange: () => this.#pick(this.input.files[0]) });
    this.caption = h('textarea', { class: 'field area', maxlength: '2200', placeholder: t('captionPlaceholder') });
    this.message = h('p', { class: 'muted', role: 'status' });
    this.submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('publish'));
    this.sheet.body.append(h('form', { class: 'stack', onsubmit: event => { event.preventDefault(); this.#publish(); } },
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => this.input.click() }, t('chooseMedia')),
      this.input, this.preview, this.caption, this.submit, this.message));
  }

  open() { this.message.textContent = ''; this.sheet.open(); }

  #pick(file) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.file = null; this.url = null;
    this.preview.replaceChildren();
    if (!file) return;
    const video = file.type.startsWith('video/');
    if (!video && !file.type.startsWith('image/')) { this.message.textContent = t('mediaType'); return; }
    if (file.size > (video ? MAX_VIDEO : MAX_IMAGE)) { this.message.textContent = video ? t('videoTooBig') : t('imageTooBig'); return; }
    this.file = file; this.url = URL.createObjectURL(file);
    this.message.textContent = '';
    this.preview.append(video
      ? h('video', { src: this.url, controls: true, playsinline: true, muted: true, preload: 'metadata' })
      : h('img', { src: this.url, alt: '' }),
    h('button', { class: 'link', type: 'button', onclick: () => { this.input.value = ''; this.#pick(null); } }, t('remove')));
  }

  async #publish() {
    const caption = this.caption.value.trim();
    if (!caption && !this.file) { this.message.textContent = t('writeOrPick'); return; }
    if (!auth.signedIn()) return;
    this.submit.disabled = true; this.message.textContent = t('uploading');
    try {
      const sb = await supabase();
      let media_url = null, media_type = null;
      if (this.file) {
        media_type = this.file.type.startsWith('video/') ? 'video' : 'image';
        const path = `milkyway/${auth.userId}/${Date.now()}-${this.file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-100)}`;
        const uploaded = await sb.storage.from('portfolio').upload(path, this.file, { contentType: this.file.type });
        if (uploaded.error) throw uploaded.error;
        media_url = sb.storage.from('portfolio').getPublicUrl(path).data.publicUrl;
      }
      const author_name = profiles.peek(auth.userId)?.name || auth.name;
      const { error } = await sb.from('mw_posts').insert({ author_id: auth.userId, author_name, caption: caption || null, media_url, media_type });
      if (error) throw error;
      this.caption.value = ''; this.input.value = ''; this.#pick(null);
      this.message.textContent = '';
      this.sheet.close();
      toast(t('published'));
      for (const scope of ['foryou', 'following']) feed(scope).refresh().catch(() => {});
      this.onPublished?.();
    } catch (error) {
      this.message.textContent = error?.message || t('retry');
    } finally { this.submit.disabled = false; }
  }
}

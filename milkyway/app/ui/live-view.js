// Live view: swipe vertically between ongoing Lives (TikTok LIVE feed) and broadcast your own.
//  - VerticalPager virtualizes the list; only the settled slide holds a LiveSession (one WebRTC connection total).
//  - Swiping away disconnects instantly; joining waits ~200 ms of stillness so fast flicks don't open rooms.
//  - Comments, gifts, likes and viewer counts render from LiveSession events; DOM stays capped (40 comments, 24 hearts).
import { t } from '../core/i18n.js';
import { auth } from '../core/net.js';
import { lives, watchLives, createSession, endSession } from '../data/live.js';
import { profiles } from '../data/profiles.js';
import { actions } from '../data/feed.js';
import { catalog, giftIcon } from '../data/gifts.js';
import { VerticalPager } from './pager.js';
import { LiveSession } from './live-session.js';
import { Sheet } from './sheet.js';
import { h, icon, count, toast, paintAvatar, brandMark } from './dom.js';

const JOIN_DELAY = 200;
const MAX_COMMENTS = 40;
const MAX_HEARTS = 24;

/** Builds the chrome shared by viewer slides and the host stage. */
function liveChrome({ host = false } = {}) {
  const avatarNode = h('span', { class: 'avatar', style: '--s:34px' });
  const name = h('b', { class: 'live-host-name' });
  const follow = h('button', { class: 'live-follow', type: 'button', 'data-act': 'follow' }, t('follow'));
  const viewers = h('span', { class: 'live-viewers' }, h('span', { html: icon.eye }), h('b', {}, '0'));
  const close = h('button', { class: 'icon-btn live-close', type: 'button', 'data-act': host ? 'end' : 'close', 'aria-label': host ? t('end') : 'Close', html: host ? '' : icon.close }, host ? t('end') : '');
  const cover = h('div', { class: 'live-cover' }, h('span', { class: 'avatar live-cover-avatar', style: '--s:96px' }), h('p', { class: 'live-cover-title' }), h('span', { class: 'live-badge' }, t('live')));
  const stage = h('div', { class: 'live-stage' });
  const guests = h('div', { class: 'live-guests' });
  const comments = h('div', { class: 'live-comments', 'aria-live': 'polite' });
  const hearts = h('div', { class: 'live-hearts', 'aria-hidden': 'true' });
  const banner = h('div', { class: 'live-gift-banner', 'aria-live': 'polite' });
  const state = h('div', { class: 'live-state', hidden: true });
  const input = h('input', { class: 'live-input', type: 'text', maxlength: '300', placeholder: t('sayHi'), enterkeyhint: 'send', 'aria-label': t('sayHi') });
  const form = h('form', { class: 'live-form', 'data-no-swipe': true }, input);
  const bar = h('div', { class: 'live-bar' }, form,
    ...(host
      ? [h('button', { class: 'icon-btn', type: 'button', 'data-act': 'flip', 'aria-label': 'Flip camera', html: icon.flip }),
         h('button', { class: 'icon-btn', type: 'button', 'data-act': 'mic', 'aria-label': 'Microphone', html: icon.mic })]
      : [h('button', { class: 'icon-btn gift', type: 'button', 'data-act': 'gift', 'aria-label': t('gift'), html: icon.gift }),
         h('button', { class: 'icon-btn like', type: 'button', 'data-act': 'like', 'aria-label': 'Like', html: icon.heart })]),
    h('button', { class: 'icon-btn', type: 'button', 'data-act': 'share', 'aria-label': t('share'), html: icon.share }));
  const top = h('div', { class: 'live-top' },
    h('div', { class: 'live-host', 'data-act': 'profile' }, avatarNode, h('div', {}, name, h('small', { class: 'live-tag' }, t('live'))), host ? null : follow),
    viewers, close);
  const node = h('section', { class: 'slide live-slide' }, cover, stage, guests, brandMark('live'), h('div', { class: 'shade' }), top, comments, hearts, banner, state, bar);
  node._refs = { avatarNode, name, follow, viewers: viewers.querySelector('b'), cover, stage, guests, comments, hearts, banner, state, input, form };
  return node;
}

function paintLive(slide, live) {
  const r = slide._refs;
  slide._live = live;
  paintAvatar(r.avatarNode, live.host, 34);
  paintAvatar(r.cover.querySelector('.live-cover-avatar'), live.host, 96);
  r.name.textContent = live.host.name;
  r.cover.querySelector('.live-cover-title').textContent = live.title || '';
  r.follow.hidden = live.host.id === auth.userId || profiles.isFollowing(live.host.id);
  r.viewers.textContent = '–';
}

function resetStage(slide) {
  const r = slide._refs;
  r.stage.replaceChildren(); r.guests.replaceChildren(); r.comments.replaceChildren(); r.hearts.replaceChildren(); r.banner.replaceChildren();
  r.state.hidden = true;
  r.cover.hidden = false;
  slide.classList.remove('has-video');
}

/** Wires a LiveSession's events into a slide. Returns an unbind function. */
function connectUi(slide, session) {
  const r = slide._refs;
  const audio = h('div', { hidden: true });
  slide.append(audio);
  const giftQueue = [];
  let showingGift = false;
  const offs = [
    session.on('state', state => {
      r.state.hidden = state === 'connected';
      r.state.textContent = state === 'reconnecting' ? t('reconnecting') : state === 'connecting' ? t('joining') : '';
    }),
    session.on('video', ({ element, isHost }) => {
      (isHost ? r.stage : r.guests).append(element);
      if (isHost) { r.cover.hidden = true; slide.classList.add('has-video'); }
    }),
    session.on('audio', element => audio.append(element)),
    session.on('viewers', n => { r.viewers.textContent = count(n); }),
    session.on('comment', event => {
      const line = h('p', { class: event.uid === auth.userId ? 'mine' : '' }, h('b', {}, event.name || 'MilkyWay'), ' ', event.body);
      r.comments.append(line);
      while (r.comments.childElementCount > MAX_COMMENTS) r.comments.firstElementChild.remove();
      r.comments.scrollTop = r.comments.scrollHeight;
    }),
    session.on('like', ({ n }) => {
      for (let i = 0; i < Math.min(n, 4); i++) {
        if (r.hearts.childElementCount >= MAX_HEARTS) break;
        const heart = h('span', { class: 'float-heart', html: icon.heart, style: `--x:${Math.round(Math.random() * 40 - 20)}px;--d:${(1.6 + Math.random()).toFixed(2)}s;--hue:${Math.round(Math.random() * 60 + 320)}` });
        heart.addEventListener('animationend', () => heart.remove(), { once: true });
        r.hearts.append(heart);
      }
    }),
    session.on('gift', event => {
      giftQueue.push(event);
      const next = () => {
        const gift = giftQueue.shift();
        if (!gift) { showingGift = false; return; }
        showingGift = true;
        const item = catalog.value?.find(entry => entry.key === gift.gift);
        const card = h('div', { class: 'gift-card' }, h('span', { class: 'gift-card-icon' }, giftIcon(gift.gift)), h('div', {}, h('b', {}, gift.name || 'MilkyWay'), h('small', {}, `${t('sent')} ${item?.name || gift.gift}`)));
        r.banner.replaceChildren(card);
        setTimeout(() => { card.classList.add('out'); setTimeout(next, 250); }, 2200);
      };
      if (!showingGift) next();
    }),
    session.on('audio-blocked', blocked => slide.classList.toggle('audio-blocked', !!blocked)),
  ];
  return () => { offs.forEach(off => off()); audio.remove(); };
}

export class LiveView {
  constructor(root, { requireLogin, openGifts, openProfile, onClose }) {
    this.root = root;
    this.hooks = { requireLogin, openGifts, openProfile, onClose };
    this.session = null;
    this.unbind = null;
    this.pending = null; // room to focus when the list arrives
    this.surface = h('div', { class: 'live-pager', tabindex: '0', 'aria-label': 'LIVE' });
    this.empty = h('div', { class: 'live-empty', hidden: true },
      h('p', {}, t('noLives')),
      h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.openGoLive() }, t('goLive')));
    this.goLiveBtn = h('button', { class: 'pill-btn hot go-live-fab', type: 'button', onclick: () => this.openGoLive() }, t('goLive'));
    root.append(this.surface, this.empty, this.goLiveBtn);

    this.pager = new VerticalPager(this.surface, {
      radius: 1,
      keyOf: live => live.room,
      create: () => liveChrome(),
      bind: (slide, live) => { resetStage(slide); paintLive(slide, live); },
      update: (slide, live) => { slide._live = live; },
      release: slide => { if (slide === this.activeSlide) this.#leave(); resetStage(slide); },
      onChange: () => { this.#leave(); clearTimeout(this.joinTimer); this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY); },
    });
    this.#bindEvents();
    lives.subscribe(list => this.#apply(list));
  }

  open(room = null) {
    this.root.hidden = false;
    this.pending = room;
    watchLives();
    lives.load().then(list => { if (!list) lives.refresh(); });
    if (this.pager.items.length && !room) { clearTimeout(this.joinTimer); this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY); }
    else this.#apply(lives.value);
    this.surface.focus({ preventScroll: true });
  }

  close() {
    clearTimeout(this.joinTimer);
    this.#leave();
    this.root.hidden = true;
  }

  #apply(list) {
    if (!list) return;
    this.empty.hidden = list.length > 0;
    this.goLiveBtn.hidden = list.length === 0;
    const before = this.pager.current?.room;
    this.pager.setItems(list);
    if (this.pending) {
      const index = list.findIndex(live => live.room === this.pending);
      if (index >= 0) { this.pending = null; this.pager.goTo(index, { animate: false }); }
    }
    if (!this.root.hidden && list.length && (this.pager.current?.room !== before || !this.session)) {
      clearTimeout(this.joinTimer);
      this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY);
    }
  }

  async #join() {
    if (this.root.hidden) return;
    const live = this.pager.current;
    const slide = this.pager.slideAt(this.pager.index);
    if (!live || !slide || this.session?.live.room === live.room) return;
    this.#leave();
    if (!auth.signedIn()) {
      slide._refs.state.hidden = false;
      slide._refs.state.replaceChildren(h('button', { class: 'pill-btn', type: 'button', onclick: () => this.hooks.requireLogin() }, t('signInToContinue')));
      return;
    }
    const session = new LiveSession(live);
    this.session = session;
    this.activeSlide = slide;
    resetStage(slide);
    this.unbind = connectUi(slide, session);
    session.on('ended', () => {
      if (this.session !== session) return;
      slide._refs.state.hidden = false;
      slide._refs.state.textContent = t('liveEnded');
      setTimeout(() => { if (this.session === session) { this.#leave(); lives.refresh(); this.pager.next(); } }, 2200);
    });
    try { await session.join(); }
    catch (error) {
      if (this.session !== session) return;
      slide._refs.state.hidden = false;
      slide._refs.state.textContent = error.status === 401 ? t('signInToContinue') : t('liveUnavailable');
      console.warn('[live] join failed', error);
    }
  }

  #leave() {
    this.unbind?.(); this.unbind = null;
    this.session?.leave(); this.session = null;
    this.activeSlide = null;
  }

  #bindEvents() {
    this.surface.addEventListener('click', event => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      const slide = event.target.closest('.live-slide');
      const live = slide?._live;
      this.session?.resumeAudio()?.catch?.(() => {});
      if (!act || !live) {
        // Tap on the stage: like (TikTok taps), only for the active, connected session.
        if (slide && this.session && slide === this.activeSlide && !event.target.closest('.live-bar, .live-top')) this.session.like();
        return;
      }
      if (act === 'close') this.hooks.onClose();
      else if (act === 'like') { if (this.session) this.session.like(); }
      else if (act === 'gift') { if (this.hooks.requireLogin() && this.session) this.hooks.openGifts({ room: live.room, to: live.host, session: this.session }); }
      else if (act === 'share') shareLive(live);
      else if (act === 'profile') this.hooks.openProfile(live.host);
      else if (act === 'follow') { if (this.hooks.requireLogin()) actions.follow(live.host.id, true).then(() => { slide._refs.follow.hidden = true; }).catch(error => toast(error.message)); }
    });
    this.surface.addEventListener('submit', event => {
      event.preventDefault();
      const input = event.target.querySelector('input');
      if (!input?.value.trim() || !this.session) return;
      if (!this.hooks.requireLogin()) return;
      this.session.comment(input.value);
      input.value = '';
    });
  }

  // ---- Broadcasting ----------------------------------------------------------------------------------------
  openGoLive() {
    if (!this.hooks.requireLogin()) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { toast(t('cameraNeeded')); return; }
    this.goSheet ||= this.#buildGoLiveSheet();
    this.goSheet.open();
  }

  #buildGoLiveSheet() {
    const sheet = new Sheet({ title: t('goLive'), className: 'go-live-sheet' });
    const title = h('input', { class: 'field', type: 'text', maxlength: '80', placeholder: t('liveTitle') });
    const mode = h('div', { class: 'segmented', role: 'radiogroup' },
      h('label', {}, h('input', { type: 'radio', name: 'mwLiveMode', value: 'video', checked: true }), h('span', {}, t('video'))),
      h('label', {}, h('input', { type: 'radio', name: 'mwLiveMode', value: 'audio' }), h('span', {}, t('audio'))));
    const start = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('start'));
    sheet.body.append(h('form', { class: 'stack', onsubmit: event => {
      event.preventDefault();
      sheet.close();
      this.#broadcast(title.value.trim(), mode.querySelector('input:checked').value);
    } }, title, mode, start));
    return sheet;
  }

  async #broadcast(title, mode) {
    this.close();
    const stage = liveChrome({ host: true });
    stage.classList.add('host-stage');
    const room = `mw-${mode}-live-${crypto.randomUUID()}`;
    const live = { room, title: title || t('live'), mode, host: { id: auth.userId, name: auth.name, avatar: profiles.peek(auth.userId)?.avatar || '' } };
    paintLive(stage, live);
    document.body.append(stage);
    const session = new LiveSession(live, { host: true, mode });
    const unbind = connectUi(stage, session);
    const finish = async () => {
      unbind();
      await session.end().catch(() => {});
      await endSession(room).catch(() => {});
      stage.remove();
      lives.refresh();
      this.hooks.onClose();
    };
    stage.addEventListener('click', async event => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'end') finish();
      else if (act === 'flip') session.flipCamera().catch(error => toast(error.message));
      else if (act === 'mic') session.toggleMic().then(on => event.target.closest('button').classList.toggle('off', !on));
      else if (act === 'share') shareLive(live);
    });
    stage.addEventListener('submit', event => {
      event.preventDefault();
      const input = stage._refs.input;
      if (input.value.trim()) { session.comment(input.value); input.value = ''; }
    });
    try {
      await createSession({ room, title: live.title });
      await session.join();
    } catch (error) {
      console.warn('[live] broadcast failed', error);
      toast(error?.name === 'NotAllowedError' ? t('cameraNeeded') : error.message || t('liveUnavailable'));
      finish();
    }
  }
}

async function shareLive(live) {
  const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#live=${encodeURIComponent(live.room)}`;
  try {
    if (navigator.share) await navigator.share({ title: live.title || 'MilkyWay LIVE', url });
    else { await navigator.clipboard.writeText(url); toast(t('linkCopied')); }
  } catch (error) { if (error?.name !== 'AbortError') toast(url); }
}

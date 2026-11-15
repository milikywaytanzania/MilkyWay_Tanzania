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
import { HostControls, InvitePrompt } from './live-controls.js';
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
  const viewers = h(host ? 'button' : 'span', { class: 'live-viewers', ...(host ? { type: 'button', 'data-act': 'viewers', 'aria-label': t('viewersTitle') } : {}) }, h('span', { html: icon.eye }), h('b', {}, '0'));
  const close = h('button', { class: 'icon-btn live-close', type: 'button', 'data-act': host ? 'end' : 'close', 'aria-label': host ? t('end') : 'Close', html: host ? '' : icon.close }, host ? t('end') : '');
  const cover = h('div', { class: 'live-cover' }, h('span', { class: 'avatar live-cover-avatar', style: '--s:96px' }), h('p', { class: 'live-cover-title' }), h('span', { class: 'live-badge' }, t('live')));
  const stage = h('div', { class: 'live-stage' });
  const guests = h('div', { class: 'live-guests' });
  const pinned = h('div', { class: 'live-pinned', hidden: true });
  const comments = h('div', { class: 'live-comments', 'aria-live': 'polite' });
  const hearts = h('div', { class: 'live-hearts', 'aria-hidden': 'true' });
  const banner = h('div', { class: 'live-gift-banner', 'aria-live': 'polite' });
  const state = h('div', { class: 'live-state', hidden: true });
  const input = h('input', { class: 'live-input', type: 'text', maxlength: '300', placeholder: t('sayHi'), enterkeyhint: 'send', 'aria-label': t('sayHi') });
  const form = h('form', { class: 'live-form', 'data-no-swipe': true }, input);
  // Stream controls: always visible for the host, shown to a viewer while they are a guest on stage.
  const micBtn = h('button', { class: 'icon-btn', type: 'button', 'data-act': 'mic', 'aria-label': t('microphone'), title: t('microphone'), html: icon.mic });
  const camBtn = h('button', { class: 'icon-btn live-video-only', type: 'button', 'data-act': 'cam', 'aria-label': t('camera'), title: t('camera'), html: icon.camera });
  const tools = h('div', { class: 'live-tools', 'data-no-swipe': true },
    h('button', { class: 'icon-btn live-video-only', type: 'button', 'data-act': 'flip', 'aria-label': t('flipCamera'), title: t('flipCamera'), html: icon.flip }),
    micBtn, camBtn,
    host ? null : h('button', { class: 'icon-btn leave', type: 'button', 'data-act': 'leave-stage', 'aria-label': t('leaveStage'), title: t('leaveStage'), html: icon.leave }));
  const guestsBadge = h('span', { class: 'live-badge-count', hidden: true });
  const stageBtn = h('button', { class: 'icon-btn stage-btn', type: 'button', 'data-act': 'stage', 'aria-label': t('requestJoin'), title: t('requestJoin'), html: icon.guests, hidden: true });
  const giftBtn = h('button', { class: 'icon-btn gift', type: 'button', 'data-act': 'gift', 'aria-label': t('gift'), html: icon.gift });
  const likeBtn = h('button', { class: 'icon-btn like', type: 'button', 'data-act': 'like', 'aria-label': 'Like', html: icon.heart });
  const bar = h('div', { class: 'live-bar' }, form,
    ...(host
      ? [h('button', { class: 'icon-btn has-badge', type: 'button', 'data-act': 'guests', 'aria-label': t('guests'), title: t('guests'), html: icon.guests }, guestsBadge),
         h('button', { class: 'icon-btn', type: 'button', 'data-act': 'moderation', 'aria-label': t('moderation'), title: t('moderation'), html: icon.shield }),
         h('button', { class: 'icon-btn', type: 'button', 'data-act': 'settings', 'aria-label': t('liveSettings'), title: t('liveSettings'), html: icon.gear })]
      : [stageBtn, giftBtn, likeBtn]),
    h('button', { class: 'icon-btn', type: 'button', 'data-act': 'share', 'aria-label': t('share'), html: icon.share }));
  const top = h('div', { class: 'live-top' },
    h('div', { class: 'live-host', 'data-act': 'profile' }, avatarNode, h('div', {}, name, h('small', { class: 'live-tag' }, t('live'))), host ? null : follow),
    viewers, close);
  const node = h('section', { class: 'slide live-slide' }, cover, stage, guests, brandMark('live'), h('div', { class: 'shade' }), top, tools, pinned, comments, hearts, banner, state, bar);
  node._refs = { avatarNode, name, follow, viewers: viewers.querySelector('b'), viewersWrap: viewers, cover, stage, guests, pinned, comments, hearts, banner, state, input, form, tools, micBtn, camBtn, stageBtn, giftBtn, likeBtn, guestsBadge };
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
  slide.classList.toggle('audio-live', live.mode === 'audio');
}

function resetStage(slide) {
  const r = slide._refs;
  r.stage.replaceChildren(); r.guests.replaceChildren(); r.comments.replaceChildren(); r.hearts.replaceChildren(); r.banner.replaceChildren();
  r.state.hidden = true;
  r.cover.hidden = false;
  r.pinned.hidden = true;
  r.stageBtn.hidden = true;
  r.input.disabled = false;
  r.input.placeholder = t('sayHi');
  r.viewersWrap.hidden = false;
  slide.classList.remove('has-video', 'on-stage');
}

const cssId = value => String(value).replace(/[^a-z0-9-]/gi, '');

/** One box per guest on stage: their video (or avatar in audio Lives / camera off) with name and mic state. */
function guestTile(slide, userId, name = '') {
  const r = slide._refs;
  let tile = r.guests.querySelector(`[data-uid="${cssId(userId)}"]`);
  if (!tile) {
    tile = h('div', { class: 'live-guest', 'data-uid': cssId(userId), 'data-act': 'guest' },
      h('span', { class: 'avatar live-guest-avatar', style: '--s:44px' }),
      h('span', { class: 'live-guest-name' }, name || 'MilkyWay'),
      h('span', { class: 'live-guest-mic', html: icon.muted, hidden: true }));
    paintAvatar(tile.querySelector('.avatar'), { name }, 44);
    r.guests.append(tile);
  }
  return tile;
}

/** Applies a room status (settings, stage, self) to a slide. */
function applyRoom(slide, session, status) {
  const r = slide._refs;
  const settings = status.settings || {};
  const self = status.self || {};
  const host = session.host;

  // Pinned comment
  r.pinned.hidden = !settings.pinned;
  if (settings.pinned) {
    r.pinned.replaceChildren(h('span', { html: icon.pin }), h('b', {}, settings.pinned.name || 'MilkyWay'), ' ', settings.pinned.body,
      host ? h('button', { class: 'live-unpin', type: 'button', 'data-act': 'unpin', 'aria-label': t('unpinComment'), html: icon.close }) : null);
  }

  // Audience controls
  if (!host) {
    r.viewersWrap.hidden = settings.showViewerCount === false;
    r.giftBtn.hidden = settings.giftsEnabled === false;
    r.likeBtn.hidden = settings.likesEnabled === false;
    const blockedNote = settings.comments === 'off' ? t('commentsOffNote') : self.commentMuted ? t('mutedNote') : '';
    r.input.disabled = !!blockedNote;
    r.input.placeholder = blockedNote || (settings.slowMode ? `${t('sayHi')} · ${t('slowMode')} ${settings.slowMode}${t('seconds')}` : t('sayHi'));
    const seated = self.state === 'speaker';
    const canAsk = settings.admission !== 'broadcast' && settings.allowRequests !== false;
    r.stageBtn.hidden = seated || (!canAsk && self.state !== 'pending' && !self.invited);
    r.stageBtn.classList.toggle('pending', self.state === 'pending');
    r.stageBtn.setAttribute('aria-label', self.state === 'pending' ? t('requested') : t('requestJoin'));
    r.stageBtn.title = r.stageBtn.getAttribute('aria-label');
    slide.classList.toggle('on-stage', seated);
    r.micBtn.classList.toggle('off', seated && (self.hostMuted || !session.micOn));
    r.camBtn.classList.toggle('off', seated && !session.cameraOn);
  } else {
    const waiting = (status.members || []).filter(member => member.state === 'pending' && !member.invited).length;
    r.guestsBadge.hidden = !waiting;
    r.guestsBadge.textContent = String(waiting);
  }

  // Guest boxes
  const speakers = (status.members || []).filter(member => member.state === 'speaker');
  const ids = new Set(speakers.map(member => cssId(member.userId)));
  for (const tile of [...r.guests.children]) if (!ids.has(tile.dataset.uid)) tile.remove();
  for (const member of speakers) {
    const tile = guestTile(slide, member.userId, member.name);
    tile.querySelector('.live-guest-name').textContent = member.userId === auth.userId ? t('youAreOnStage') : member.name || 'MilkyWay';
    paintAvatar(tile.querySelector('.avatar'), member, 44);
    tile.querySelector('.live-guest-mic').hidden = !member.hostMuted;
    tile._member = member;
  }
  slide.classList.toggle('has-guests', speakers.length > 0);
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
      if (state === 'disconnected') { showRetry(slide, session.host ? t('liveUnavailable') : t('connectionLost')); return; }
      r.state.textContent = state === 'reconnecting' ? t('reconnecting') : state === 'connecting' ? t('joining') : '';
    }),
    // A guest (or the host) switched their camera off/on: show their avatar instead of a frozen frame.
    session.on('camera', ({ participant, on }) => {
      if (!participant) return;
      if (participant === session.live.host.id) { if (!session.host) { r.cover.hidden = on; slide.classList.toggle('has-video', on); } return; }
      r.guests.querySelector(`[data-uid="${cssId(participant)}"]`)?.classList.toggle('cam-off', !on);
    }),
    session.on('video', ({ element, isHost, participant, name }) => {
      if (isHost) {
        r.stage.replaceChildren(element);
        r.cover.hidden = true; slide.classList.add('has-video');
        return;
      }
      const tile = guestTile(slide, participant, name);
      tile.querySelector('video')?.remove();
      tile.prepend(element);
      tile.classList.add('has-video');
      tile.classList.remove('cam-off');
    }),
    session.on('video-gone', participant => {
      if (participant === session.live.host.id) { r.stage.replaceChildren(); r.cover.hidden = false; slide.classList.remove('has-video'); return; }
      const tile = r.guests.querySelector(`[data-uid="${cssId(participant)}"]`);
      if (!tile) return;
      tile.querySelector('video')?.remove();
      tile.classList.remove('has-video');
      if (!tile._member) tile.remove();
    }),
    session.on('track-muted', ({ participant, kind, muted }) => {
      if (kind !== 'video') return;
      if (participant === session.live.host.id) { r.cover.hidden = !muted; slide.classList.toggle('has-video', !muted); }
      else r.guests.querySelector(`[data-uid="${cssId(participant)}"]`)?.classList.toggle('cam-off', muted);
    }),
    session.on('facing', facing => slide.querySelectorAll('.live-track.local').forEach(element => element.classList.toggle('mirror', facing !== 'environment'))),
    session.on('audio', element => audio.append(element)),
    session.on('viewers', n => { r.viewers.textContent = count(n); }),
    session.on('comment', event => {
      if (r.comments.querySelector(`[data-id="${cssId(event.id)}"]`)) return;
      const line = h('p', { class: event.uid === auth.userId ? 'mine' : '', 'data-id': cssId(event.id), 'data-uid': event.uid || '' },
        h('b', {}, event.name || 'MilkyWay'), ' ', event.body);
      line._event = event;
      if (session.host && event.uid && event.uid !== auth.userId) { line.dataset.act = 'comment'; line.classList.add('tappable'); }
      r.comments.append(line);
      while (r.comments.childElementCount > MAX_COMMENTS) r.comments.firstElementChild.remove();
      r.comments.scrollTop = r.comments.scrollHeight;
    }),
    session.on('comment-rejected', ({ id, error }) => {
      r.comments.querySelector(`[data-id="${cssId(id)}"]`)?.remove();
      toast(error?.message || t('liveUnavailable'));
    }),
    session.on('comment-deleted', id => r.comments.querySelector(`[data-id="${cssId(id)}"]`)?.remove()),
    session.on('room', status => applyRoom(slide, session, status)),
    session.on('stage', ({ onStage }) => { slide.classList.toggle('on-stage', onStage); if (onStage) toast(t('youAreOnStage')); }),
    session.on('error', error => { if (error?.message) toast(error.message); }),
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

/** Shows a message with a Retry button in the slide's status pill. */
function showRetry(slide, message) {
  const r = slide._refs;
  r.state.hidden = false;
  r.state.replaceChildren(h('span', {}, message), ' ', h('button', { class: 'pill-btn live-retry', type: 'button', 'data-act': 'retry' }, t('retry')));
}

/** Stream controls shared by the host and guests on stage (flip, mic, camera). Returns true when handled. */
function streamControl(act, session, button, slide) {
  if (act === 'flip') { session.flipCamera().catch(error => toast(error.message)); return true; }
  if (act === 'mic') {
    session.toggleMic().then(on => { button.classList.toggle('off', !on); }).catch(error => toast(error.message || t('guestMutedByHost')));
    return true;
  }
  if (act === 'cam') {
    session.toggleCamera().then(on => {
      button.classList.toggle('off', !on);
      if (session.host) { slide._refs.cover.hidden = on; slide.classList.toggle('has-video', on); }
    }).catch(error => toast(error.message));
    return true;
  }
  return false;
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
    session.on('removed', () => {
      if (this.session !== session) return;
      slide._refs.state.hidden = false;
      slide._refs.state.textContent = t('removedYou');
      setTimeout(() => { if (this.session === session) { this.#leave(); this.pager.next(); } }, 2600);
    });
    session.on('invited', () => {
      if (this.session !== session) return;
      this.invite?.destroy();
      this.invite = new InvitePrompt(session, live.host.name);
      this.invite.open();
    });
    try { await session.join(); }
    catch (error) {
      if (this.session !== session) return;
      console.warn('[live] join failed', error);
      if (error.status === 404) {
        slide._refs.state.hidden = false;
        slide._refs.state.textContent = t('liveEnded');
        setTimeout(() => { if (this.session === session) { this.#leave(); lives.refresh(); } }, 2200);
      } else if (error.status === 401) {
        slide._refs.state.hidden = false;
        slide._refs.state.replaceChildren(h('button', { class: 'pill-btn', type: 'button', onclick: () => this.hooks.requireLogin() }, t('signInToContinue')));
      } else if (error.status === 403) {
        slide._refs.state.hidden = false;
        slide._refs.state.textContent = error.message || t('liveUnavailable');
      } else showRetry(slide, error?.name === 'NotAllowedError' ? t('cameraNeeded') : t('liveUnavailable'));
    }
  }

  #leave() {
    this.invite?.destroy(); this.invite = null;
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
        if (slide && this.session && slide === this.activeSlide && !event.target.closest('.live-bar, .live-top, .live-tools, .live-pinned')) this.session.like();
        return;
      }
      const button = event.target.closest('[data-act]');
      if (this.session && slide === this.activeSlide && streamControl(act, this.session, button, slide)) return;
      if (act === 'retry') { if (slide === this.pager.slideAt(this.pager.index)) { this.#leave(); this.#join(); } }
      else if (act === 'close') this.hooks.onClose();
      else if (act === 'stage') { if (this.hooks.requireLogin() && this.session) this.#stageRequest(); }
      else if (act === 'leave-stage') { this.session?.leaveStage().catch(error => toast(error.message)); }
      else if (act === 'guest') {
        // Viewers: a guest box opens that guest's profile.
        const member = event.target.closest('.live-guest')?._member;
        if (member?.userId && member.userId !== auth.userId) this.hooks.openProfile({ id: member.userId, name: member.name, avatar: member.avatar });
      }
      else if (act === 'comment' || act === 'unpin') { /* host-only actions */ }
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

  async #stageRequest() {
    const session = this.session;
    const self = session.self;
    try {
      if (self?.state === 'pending') { await session.leaveStage(); return; }
      if (self?.invited) { await session.acceptInvite(); return; }
      const state = await session.requestStage();
      toast(state === 'speaker' ? t('youAreOnStage') : t('requestSent'));
    } catch (error) { toast(error?.message || t('liveUnavailable')); }
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
    const radios = (name, options) => h('div', { class: `segmented lc-seg lc-seg-${options.length}`, role: 'radiogroup' },
      ...options.map(([value, label], i) => h('label', {}, h('input', { type: 'radio', name, value, checked: i === 0 }), h('span', {}, label))));
    const guests = radios('mwLiveGuests', [['approval', t('admissionApproval')], ['direct', t('admissionDirect')], ['broadcast', t('admissionOff')]]);
    const comments = radios('mwLiveComments', [['everyone', t('commentsEveryone')], ['followers', t('commentsFollowers')], ['off', t('commentsOff')]]);
    const start = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('start'));
    sheet.body.append(h('form', { class: 'stack', onsubmit: event => {
      event.preventDefault();
      sheet.close();
      this.#broadcast(title.value.trim(), mode.querySelector('input:checked').value, {
        admission: guests.querySelector('input:checked').value,
        comments: comments.querySelector('input:checked').value,
      });
    } }, title, mode, h('div', { class: 'lc-label' }, t('admission')), guests, h('div', { class: 'lc-label' }, t('comments2')), comments, start));
    return sheet;
  }

  async #broadcast(title, mode, initialSettings = {}) {
    this.close();
    const stage = liveChrome({ host: true });
    stage.classList.add('host-stage');
    const room = `mw-${mode}-live-${crypto.randomUUID()}`;
    const live = { room, title: title || t('live'), mode, initialSettings, host: { id: auth.userId, name: auth.name, avatar: profiles.peek(auth.userId)?.avatar || '' } };
    paintLive(stage, live);
    document.body.append(stage);
    const session = new LiveSession(live, { host: true, mode });
    const controls = new HostControls(session, { openProfile: person => this.hooks.openProfile(person) });
    const unbind = connectUi(stage, session);
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      unbind();
      controls.destroy();
      await session.end().catch(() => {});
      await endSession(room).catch(() => {});
      stage.remove();
      lives.refresh();
      this.hooks.onClose();
    };
    stage.addEventListener('click', async event => {
      const button = event.target.closest('[data-act]');
      const act = button?.dataset.act;
      if (!act) return;
      if (streamControl(act, session, button, stage)) return;
      if (act === 'end') finish();
      else if (act === 'retry') session.reconnect().catch(error => { toast(error?.message || t('liveUnavailable')); showRetry(stage, t('liveUnavailable')); });
      else if (act === 'share') shareLive(live);
      else if (act === 'guests') controls.openGuests();
      else if (act === 'settings') controls.openSettings();
      else if (act === 'viewers') controls.openViewers();
      else if (act === 'moderation') controls.openModeration();
      else if (act === 'profile') this.hooks.openProfile(live.host);
      else if (act === 'unpin') session.control('unpin').catch(error => toast(error.message));
      else if (act === 'guest') {
        // Boxes can appear (from the video track) before the room status names them.
        const member = button._member || { userId: button.dataset.uid, name: button.querySelector('.live-guest-name')?.textContent || '', state: 'speaker' };
        if (member.userId) controls.openPerson(member);
      }
      else if (act === 'comment') {
        const line = button._event;
        if (line?.uid) controls.openPerson({ userId: line.uid, name: line.name }, { id: line.id, body: line.body });
      }
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

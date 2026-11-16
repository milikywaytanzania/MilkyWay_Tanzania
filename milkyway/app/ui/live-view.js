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
import { loadLiveKit } from '../core/sdk.js';
import { HostControls, InvitePrompt } from './live-controls.js';
import { Sheet } from './sheet.js';
import { openShare } from './share-sheet.js';
import { h, icon, count, toast, paintAvatar, brandMark, avatar } from './dom.js';

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
  const background = h('div', { class: 'live-host-background', hidden: true, 'aria-hidden': 'true' },
    h('img', { class: 'live-host-background-image', alt: '', hidden: true }),
    h('video', { class: 'live-host-background-video', muted: true, loop: true, playsinline: true, preload: 'metadata', hidden: true }));
  const stage = h('div', { class: 'live-stage' });
  const guests = h('div', { class: 'live-guests' });
  // Host cell + allocated guest seats share one grid, including seats that have not been filled yet.
  const hostLabel = h('span', { class: 'live-cell-name' });
  const hostCell = h('div', { class: 'live-host-cell' }, background, cover, stage, hostLabel);
  const grid = h('div', { class: 'live-grid', 'data-tiles': '1' }, hostCell, guests);
  // Host only: real-time list of viewers asking to join, with one-tap Approve / Reject.
  const requests = h('div', { class: 'live-requests', hidden: true, 'data-no-swipe': true, 'aria-live': 'polite' });
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
  // Viewers: a labelled pill in the bottom bar so joining as a guest is always obvious
  // (Request to join → Requested → on stage). It is never replaced by a view-only layout.
  const stageLabel = h('span', { class: 'stage-label' }, t('requestJoin'));
  const stageBtn = h('button', { class: 'live-join-btn', type: 'button', 'data-act': 'stage', 'data-no-swipe': true, 'aria-label': t('requestJoin'), title: t('requestJoin') },
    h('span', { class: 'stage-icon', html: icon.guests, 'aria-hidden': 'true' }), stageLabel);
  const giftBtn = h('button', { class: 'icon-btn gift', type: 'button', 'data-act': 'gift', 'data-no-swipe': true, 'aria-label': t('gift'), title: t('gift'), html: icon.gift });
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
  const node = h('section', { class: 'slide live-slide' }, grid, brandMark('live'), h('div', { class: 'shade' }), top, tools, pinned, comments, hearts, banner, state, host ? requests : null, bar);
  node._refs = { avatarNode, name, follow, viewers: viewers.querySelector('b'), viewersWrap: viewers, cover, background, stage, guests, grid, hostLabel, requests, pinned, comments, hearts, banner, state, input, form, tools, micBtn, camBtn, stageBtn, stageLabel, giftBtn, likeBtn, guestsBadge };
  // Re-arrange the grid whenever a guest tile appears or leaves (tiles come from both room status and video tracks).
  new MutationObserver(() => layoutGrid(node)).observe(guests, { childList: true });
  return node;
}

/** Sizes the video grid to the number of people on stage: 1 = full screen, 2 = side by side, 3 = host + 2 stacked,
 *  4 = 2×2, 5–6 = 3×2, 7–9 = 3×3, 10+ = 4 columns. Audio LIVEs keep their avatar seats.
 *  The slide carries the same count so the comments and pinned comment sit below the grid instead of over faces. */
function layoutGrid(slide) {
  const r = slide._refs;
  const tiles = String(Math.min(1 + r.guests.childElementCount, 10));
  if (r.grid.dataset.tiles !== tiles) r.grid.dataset.tiles = tiles;
  if (slide.dataset.tiles !== tiles) slide.dataset.tiles = tiles;
  r.grid.style.setProperty('--side-tiles', String(Math.max(4, r.guests.childElementCount)));
  slide.classList.toggle('has-guests', tiles !== '1');
}

function paintLive(slide, live) {
  const r = slide._refs;
  slide._live = live;
  paintAvatar(r.avatarNode, live.host, 34);
  paintAvatar(r.cover.querySelector('.live-cover-avatar'), live.host, 96);
  r.name.textContent = live.host.name;
  r.hostLabel.textContent = live.host.name;
  r.cover.querySelector('.live-cover-title').textContent = live.title || '';
  r.follow.hidden = live.host.id === auth.userId || profiles.isFollowing(live.host.id);
  r.viewers.textContent = '–';
  slide.classList.toggle('audio-live', live.mode === 'audio');
}

function resetStage(slide) {
  const r = slide._refs;
  r.stage.replaceChildren(); r.guests.replaceChildren(); r.comments.replaceChildren(); r.hearts.replaceChildren(); r.banner.replaceChildren();
  r.background.querySelector('img').removeAttribute('src');
  r.background.querySelector('video').pause();
  r.background.querySelector('video').removeAttribute('src');
  r.background.querySelector('video').load();
  r.background.hidden = true;
  r.background.querySelectorAll('img,video').forEach(element => { element.hidden = true; });
  r.state.hidden = true;
  r.cover.hidden = false;
  r.pinned.hidden = true;
  r.stageBtn.hidden = false;
  r.stageBtn.disabled = false;
  r.stageBtn.className = 'live-join-btn';
  r.stageLabel.textContent = t('requestJoin');
  r.stageBtn.setAttribute('aria-label', t('requestJoin'));
  r.stageBtn.title = t('requestJoin');
  r.grid.dataset.tiles = '1';
  r.grid.dataset.layout = 'fullscreen';
  slide.dataset.layout = 'fullscreen';
  slide.dataset.tiles = '1';
  slide.classList.remove('has-guests');
  r.requests.hidden = true;
  r.requests.replaceChildren();
  slide._lastSelf = null;
  slide._selfCancelled = false;
  r.input.disabled = false;
  r.input.placeholder = t('sayHi');
  r.viewersWrap.hidden = false;
  slide.classList.remove('has-video', 'has-host-background', 'on-stage');
  slide.classList.toggle('can-request', !slide.classList.contains('host-stage'));
}

const cssId = value => String(value).replace(/[^a-z0-9-]/gi, '');

/** One box per guest on stage: their video (or avatar in audio Lives / camera off) with name and mic state. */
function guestTile(slide, userId, name = '') {
  const r = slide._refs;
  let tile = r.guests.querySelector(`[data-uid="${cssId(userId)}"]`);
  if (!tile) {
    // The host gets one-tap controls on every guest box: mute / allow mic, move back to the audience, remove from LIVE.
    const hostTools = slide.classList.contains('host-stage')
      ? h('div', { class: 'live-guest-tools', 'data-no-swipe': true },
          h('button', { class: 'live-guest-btn', type: 'button', 'data-act': 'guest-mute', 'data-uid': userId, 'aria-label': t('muteMic'), title: t('muteMic'), html: icon.mic }),
          h('button', { class: 'live-guest-btn', type: 'button', 'data-act': 'guest-remove', 'data-uid': userId, 'aria-label': t('removeFromStage'), title: t('removeFromStage'), html: icon.leave }),
          h('button', { class: 'live-guest-btn danger', type: 'button', 'data-act': 'guest-kick', 'data-uid': userId, 'aria-label': t('removeFromLive'), title: t('removeFromLive'), html: icon.close }))
      : null;
    tile = h('div', { class: 'live-guest', 'data-uid': cssId(userId), 'data-act': 'guest' },
      h('span', { class: 'avatar live-guest-avatar', style: '--s:44px' }),
      h('span', { class: 'live-guest-name' }, name || 'MilkyWay'),
      h('span', { class: 'live-guest-mic', html: icon.muted, hidden: true }),
      hostTools);
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
  const layoutStyle = settings.layoutStyle === 'featured' ? 'featured' : 'fullscreen';
  r.grid.dataset.layout = layoutStyle;
  slide.dataset.layout = layoutStyle;
  paintHostBackground(slide, settings);

  // Pinned comment
  r.pinned.hidden = !settings.pinned;
  if (settings.pinned) {
    r.pinned.replaceChildren(h('span', { html: icon.pin }), h('b', {}, settings.pinned.name || 'MilkyWay'), ' ', settings.pinned.body,
      host ? h('button', { class: 'live-unpin', type: 'button', 'data-act': 'unpin', 'aria-label': t('unpinComment'), html: icon.close }) : null);
  }

  function paintHostBackground(slide, settings) {
    const layer = slide._refs.background;
    const image = layer.querySelector('img');
    const video = layer.querySelector('video');
    const url = typeof settings.hostBackground === 'string' ? settings.hostBackground : '';
    const kind = settings.hostBackgroundKind === 'video' ? 'video' : 'image';
    layer.hidden = !url;
    image.hidden = !url || kind !== 'image';
    video.hidden = !url || kind !== 'video';
    slide.classList.toggle('has-host-background', !!url);
    if (!url) {
      image.removeAttribute('src');
      video.pause();
      video.removeAttribute('src');
      video.load();
      return;
    }
    if (kind === 'image' && image.src !== url) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      image.src = url;
      image.onerror = () => { if (slide.classList.contains('host-stage')) toast(t('backgroundUnavailable')); };
    }
    if (kind === 'video' && video.src !== url) {
      image.removeAttribute('src');
      video.src = url;
      video.onerror = () => { if (slide.classList.contains('host-stage')) toast(t('backgroundUnavailable')); };
      video.play().catch(error => {
        if (error?.name !== 'NotAllowedError' && slide.classList.contains('host-stage')) toast(t('backgroundUnavailable'));
      });
    }
  }

  // Audience controls
  if (!host) {
    r.viewersWrap.hidden = settings.showViewerCount === false;
    r.giftBtn.hidden = settings.giftsEnabled === false;
    r.likeBtn.hidden = settings.likesEnabled === false;
    const blockedNote = settings.comments === 'off' ? t('commentsOffNote') : self.commentMuted ? t('mutedNote') : '';
    r.input.disabled = !!blockedNote;
    r.input.placeholder = blockedNote || (settings.slowMode ? `${t('sayHi')} · ${t('slowMode')} ${settings.slowMode}${t('seconds')}` : t('sayHi'));
    paintStageButton(slide, session);
    // Host decisions about this viewer, read from the server record.
    const was = slide._lastSelf;
    if (was?.state === 'pending' && self.state === 'viewer' && !slide._selfCancelled) toast(t('requestDeclined'));
    if (was?.state === 'speaker' && self.state === 'viewer' && !slide._selfCancelled) toast(t('movedToAudience'));
    if (was?.state === 'speaker' && self.state === 'speaker' && !was.hostMuted && self.hostMuted) toast(t('guestMutedByHost'));
    if (was?.state === 'speaker' && self.state === 'speaker' && was.hostMuted && !self.hostMuted) toast(t('hostAllowedMic'));
    if (self.state !== 'pending' && self.state !== 'speaker') slide._selfCancelled = false;
    slide._lastSelf = { state: self.state, hostMuted: !!self.hostMuted };
    paintMedia(slide, session.media);
  } else {
    const waiting = (status.members || []).filter(member => member.state === 'pending' && !member.invited).length;
    r.guestsBadge.hidden = !waiting;
    r.guestsBadge.textContent = String(waiting);
    renderRequests(slide, status);
  }

  // Guest boxes
  const speakers = (status.members || []).filter(member => member.state === 'speaker');
  const guestSeats = host && settings.showGuestSlots ? Math.max(0, Math.min(8, Number(settings.layout || 1) - 1)) : 0;
  const orderedTiles = [];
  for (const member of speakers) {
    const tile = guestTile(slide, member.userId, member.name);
    tile.querySelector('.live-guest-name').textContent = member.userId === auth.userId ? t('youAreOnStage') : member.name || 'MilkyWay';
    paintAvatar(tile.querySelector('.avatar'), member, 44);
    tile.querySelector('.live-guest-mic').hidden = !member.hostMuted;
    const muteBtn = tile.querySelector('[data-act="guest-mute"]');
    if (muteBtn) {
      const label = member.hostMuted ? t('unmuteMic') : t('muteMic');
      muteBtn.innerHTML = member.hostMuted ? icon.muted : icon.mic;
      muteBtn.classList.toggle('off', !!member.hostMuted);
      muteBtn.setAttribute('aria-label', label); muteBtn.title = label;
    }
    tile._member = member;
    orderedTiles.push(tile);
  }
  for (let seat = 1; seat <= guestSeats; seat++) {
    if (speakers[seat - 1]) continue;
    let placeholder = r.guests.querySelector(`[data-seat="${seat}"]`);
    if (!placeholder) {
      placeholder = h('button', {
        class: 'live-guest live-guest-slot', type: 'button', role: 'listitem', 'data-seat': seat,
        'data-act': 'guests', 'data-no-swipe': true, 'aria-label': `${t('invite')} · ${t('seats')} ${seat}`,
        title: t('invite'),
      }, h('span', { class: 'live-slot-plus', 'aria-hidden': 'true' }, '+'),
      h('span', { class: 'live-guest-name' }, t('invite')));
    }
    orderedTiles.push(placeholder);
  }
  for (const tile of [...r.guests.children]) {
    if (!orderedTiles.includes(tile)) tile.remove();
  }
  orderedTiles.forEach((tile, index) => {
    if (r.guests.children[index] !== tile) r.guests.insertBefore(tile, r.guests.children[index] || null);
  });
  layoutGrid(slide);
}

/** Viewer's join button, from the session's stage state:
 *  audience → "Request to join", requested → "Requested · tap to cancel", invited → "Join as guest",
 *  joining → "Joining…" (approved, rights arriving), guest → hidden (the guest controls take over). */
function paintStageButton(slide, session) {
  const r = slide._refs;
  if (session.host) return;
  const settings = session.settings;
  const stage = session.stage;
  const canAsk = settings.admission !== 'broadcast' && settings.allowRequests !== false;
  const label = stage === 'requested' ? t('requested') : stage === 'invited' ? t('joinAsGuest') : stage === 'joining' ? t('joiningStage') : t('requestJoin');
  r.stageBtn.hidden = stage === 'guest';
  r.stageBtn.disabled = stage === 'joining' || !!session.stageAction || (stage === 'audience' && !canAsk);
  r.stageBtn.classList.toggle('pending', stage === 'requested' || stage === 'joining');
  r.stageBtn.classList.toggle('invited', stage === 'invited');
  r.stageBtn.classList.toggle('closed', stage === 'audience' && !canAsk);
  r.stageBtn.setAttribute('aria-pressed', String(stage === 'requested'));
  r.stageLabel.textContent = label;
  r.stageBtn.setAttribute('aria-label', label);
  r.stageBtn.title = label;
  slide.classList.toggle('can-request', !r.stageBtn.hidden);
  slide.classList.toggle('on-stage', stage === 'guest');
}

/** Mic / camera buttons of the host or a guest on stage, from the real LiveKit track state. */
function paintMedia(slide, media) {
  const r = slide._refs;
  if (!media) return;
  const micLabel = media.hostMuted ? t('guestMutedByHost') : media.mic ? t('muteMyMic') : t('unmuteMyMic');
  r.micBtn.classList.toggle('off', !media.mic);
  r.micBtn.classList.toggle('locked', !!media.hostMuted);
  r.micBtn.innerHTML = media.mic ? icon.mic : icon.muted;
  r.micBtn.setAttribute('aria-pressed', String(!media.mic));
  r.micBtn.setAttribute('aria-label', micLabel); r.micBtn.title = micLabel;
  const camLabel = media.camera ? t('cameraOffAction') : t('cameraOnAction');
  r.camBtn.classList.toggle('off', !media.camera);
  r.camBtn.setAttribute('aria-pressed', String(!media.camera));
  r.camBtn.setAttribute('aria-label', camLabel); r.camBtn.title = camLabel;
}

const REQUESTS_SHOWN = 3;
/** Host: the waiting list on screen. Each row has Approve (promotes the viewer to publisher) and Reject. */
function renderRequests(slide, status) {
  const r = slide._refs;
  const settings = status.settings || {};
  const pending = (status.members || []).filter(member => member.state === 'pending' && !member.invited && !member.blocked);
  r.requests.hidden = !pending.length;
  if (!pending.length) { r.requests.replaceChildren(); return; }
  const busy = slide._approving || new Set();
  const seats = Math.max(1, (settings.layout || 9) - 1);
  const onStage = (status.members || []).filter(member => member.state === 'speaker').length;
  const full = onStage >= seats;
  r.requests.replaceChildren(
    h('div', { class: 'live-requests-head' },
      h('span', { html: icon.guests, 'aria-hidden': 'true' }),
      h('b', {}, `${t('requestsToJoin')} (${pending.length})`),
      h('small', {}, `${onStage}/${seats}`)),
    ...pending.slice(0, REQUESTS_SHOWN).map(member => h('div', { class: 'live-request', 'data-uid': cssId(member.userId) },
      avatar(member, 30),
      h('span', { class: 'live-request-name' }, member.name || 'MilkyWay'),
      h('button', { class: 'live-req-btn approve', type: 'button', 'data-act': 'approve-request', 'data-uid': member.userId, disabled: busy.has(member.userId),
        title: full ? t('seatsFull') : t('approve'), 'aria-label': `${t('approve')} ${member.name || ''}` }, t('approve')),
      h('button', { class: 'live-req-btn reject', type: 'button', 'data-act': 'reject-request', 'data-uid': member.userId, disabled: busy.has(member.userId),
        'aria-label': `${t('reject')} ${member.name || ''}`, html: icon.close }))),
    pending.length > REQUESTS_SHOWN
      ? h('button', { class: 'live-requests-more', type: 'button', 'data-act': 'guests' }, `+${pending.length - REQUESTS_SHOWN} · ${t('requests')}`)
      : null,
  );
}

/** Wires a LiveSession's events into a slide. Returns an unbind function. */
function connectUi(slide, session) {
  const r = slide._refs;
  const audio = h('div', { class: 'live-audio', 'aria-hidden': 'true' });
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
    session.on('stage-state', () => paintStageButton(slide, session)),
    session.on('stage-action', () => paintStageButton(slide, session)),
    session.on('media', media => paintMedia(slide, media)),
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

/** Stream controls shared by the host and guests on stage (flip, mic, camera). Returns true when handled.
 *  Buttons repaint from the session's 'media' event, i.e. from the real track state. */
function streamControl(act, session, _button, slide) {
  if (act === 'flip') { session.flipCamera().catch(error => toast(error.message)); return true; }
  if (act === 'mic') { session.toggleMic().catch(error => toast(error.message || t('guestMutedByHost'))).finally(() => paintMedia(slide, session.media)); return true; }
  if (act === 'cam') {
    session.toggleCamera().then(on => {
      if (session.host) { slide._refs.cover.hidden = on; slide.classList.toggle('has-video', on); }
    }).catch(error => toast(error.message)).finally(() => paintMedia(slide, session.media));
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
    if (auth.signedIn()) loadLiveKit().catch(error => console.warn('[live] media warm-up failed', error));
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
    if (!this.root.hidden && auth.signedIn()) {
      const current = this.pager.current;
      if (current) LiveSession.warm(current).catch(error => console.warn('[live] room warm-up failed', error));
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
      else if (act === 'stage') {
        // The button is in the bar from the first frame; until the room is connected a tap just says so.
        if (!this.hooks.requireLogin()) return;
        if (this.session && slide === this.activeSlide) this.#stageRequest(); else toast(t('joining'));
      }
      else if (act === 'leave-stage') {
        if (this.activeSlide) this.activeSlide._selfCancelled = true;
        this.session?.leaveStage().then(() => toast(t('leftStage'))).catch(error => toast(error.message));
      }
      else if (act === 'guest') {
        // Viewers: a guest box opens that guest's profile.
        const member = event.target.closest('.live-guest')?._member;
        if (member?.userId && member.userId !== auth.userId) this.hooks.openProfile({ id: member.userId, name: member.name, avatar: member.avatar });
      }
      else if (act === 'comment' || act === 'unpin') { /* host-only actions */ }
      else if (act === 'like') { if (this.session) this.session.like(); }
      else if (act === 'gift') {
        if (!this.hooks.requireLogin() || !this.session) return;
        Promise.resolve(this.hooks.openGifts({ room: live.room, to: live.host, session: this.session }))
          .catch(error => toast(error?.message || t('giftFailed')));
      }
      else if (act === 'share') openShare({ title: live.title || 'MilkyWay LIVE', url: `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#live=${encodeURIComponent(live.room)}` });
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
    const slide = this.activeSlide;
    if (session.stageAction) return;
    try {
      if (session.stage === 'requested') {
        if (slide) slide._selfCancelled = true;
        await session.cancelRequest();
        toast(t('requestCancelled'));
        return;
      }
      if (session.stage === 'joining' || session.stage === 'guest') return;
      if (session.stage === 'invited') { await session.acceptInvite(); return; }
      if (slide) slide._selfCancelled = false;
      await session.requestStage();
      toast(t('requestSent'));
    } catch (error) { toast(error?.message || t('liveUnavailable')); }
  }

  // ---- Broadcasting ----------------------------------------------------------------------------------------
  openGoLive() {
    if (!this.hooks.requireLogin()) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { toast(t('cameraNeeded')); return; }
    this.goSheet ||= this.#buildGoLiveSheet();
    this.goSheet.open();
  }

  // Compact, TikTok-style setup card: avatar + slim title on the top row, Video/Audio toggle pills on their own row
  // below it, guest and comment options as small grid chips, and one slim gradient Start button. No tall form, no spacers.
  #buildGoLiveSheet() {
    const sheet = new Sheet({ title: t('goLive'), className: 'go-live-sheet' });
    sheet.panel.setAttribute('aria-label', t('goLive'));
    const me = { id: auth.userId, name: auth.name, avatar: profiles.peek(auth.userId)?.avatar || '' };
    const title = h('input', { class: 'gl-title', type: 'text', maxlength: '80', placeholder: t('liveTitle'), 'aria-label': t('liveTitle'), enterkeyhint: 'go' });
    // A row of small single-choice pills/chips; returns the group with a .value getter.
    const choices = (className, label, options, iconFor) => {
      let value = options[0][0];
      const buttons = options.map(([key, text]) => h('button', {
        class: 'gl-chip', type: 'button', role: 'radio', 'data-value': key,
        onclick: () => { value = key; paint(); },
      }, iconFor ? h('span', { html: iconFor(key), 'aria-hidden': 'true' }) : null, text));
      const paint = () => buttons.forEach(button => {
        const on = button.dataset.value === value;
        button.classList.toggle('on', on);
        button.setAttribute('aria-checked', String(on));
      });
      paint();
      const group = h('div', { class: className, role: 'radiogroup', 'aria-label': label }, ...buttons);
      Object.defineProperty(group, 'value', { get: () => value });
      return group;
    };
    const mode = choices('gl-modes', t('goLive'), [['video', t('video')], ['audio', t('audio')]], key => key === 'video' ? icon.camera : icon.mic);
    const guests = choices('gl-grid', t('admission'), [['approval', t('admissionApproval')], ['broadcast', t('admissionOff')]]);
    const comments = choices('gl-grid', t('comments2'), [['everyone', t('commentsEveryone')], ['followers', t('commentsFollowers')], ['off', t('commentsOff')]]);
    const group = (emoji, label, node) => h('div', { class: 'gl-group' }, h('small', { class: 'gl-label' }, h('span', { 'aria-hidden': 'true' }, emoji), label), node);
    const start = h('button', { class: 'gl-start', type: 'submit' }, h('i', { class: 'gl-dot', 'aria-hidden': 'true' }), t('goLive'));
    sheet.body.append(h('form', { class: 'gl-form', onsubmit: event => {
      event.preventDefault();
      sheet.close();
      this.#broadcast(title.value.trim(), mode.value, { admission: guests.value, comments: comments.value });
    } },
    h('div', { class: 'gl-head' }, avatar(me, 36), title),
    h('div', { class: 'gl-mode-row' }, mode),
    group('👥', t('admission'), guests),
    group('💬', t('comments2'), comments),
    h('div', { class: 'gl-actions' }, start)));
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
      // Any tap on the host's screen unlocks audio playback, so the host hears approved guests (mobile autoplay rules).
      session.resumeAudio()?.catch?.(() => {});
      if (!act) return;
      if (streamControl(act, session, button, stage)) return;
      if (act === 'end') finish();
      else if (act === 'retry') session.reconnect().catch(error => { toast(error?.message || t('liveUnavailable')); showRetry(stage, t('liveUnavailable')); });
      else if (act === 'share') openShare({ title: live.title || 'MilkyWay LIVE', url: `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#live=${encodeURIComponent(live.room)}` });
      else if (act === 'guests') controls.openGuests();
      else if (act === 'approve-request' || act === 'reject-request') {
        const userId = button.dataset.uid;
        stage._approving ||= new Set();
        if (!userId || stage._approving.has(userId)) return;
        stage._approving.add(userId);
        button.closest('.live-request')?.querySelectorAll('button').forEach(node => { node.disabled = true; });
        session.control(act === 'approve-request' ? 'approve' : 'reject', { target: userId })
          .then(() => { if (act === 'approve-request') toast(t('guestApproved')); })
          .catch(error => toast(error?.message || t('liveUnavailable')))
          .finally(() => { stage._approving.delete(userId); if (session.status) applyRoom(stage, session, session.status); });
      }
      else if (act === 'guest-mute' || act === 'guest-remove' || act === 'guest-kick') {
        event.stopPropagation();
        const userId = button.dataset.uid;
        const member = button.closest('.live-guest')?._member;
        if (!userId) return;
        if (act === 'guest-kick' && !button.classList.contains('armed')) {
          // Removing someone from the LIVE needs a second tap.
          button.classList.add('armed'); button.title = t('tapAgain');
          setTimeout(() => { button.classList.remove('armed'); button.title = t('removeFromLive'); }, 3000);
          toast(t('tapAgain'));
          return;
        }
        const action = act === 'guest-mute' ? (member?.hostMuted ? 'allow-mic' : 'mute') : act === 'guest-remove' ? 'remove' : 'kick';
        button.disabled = true;
        session.control(action, { target: userId })
          .then(() => { if (act === 'guest-kick') toast(t('removed')); })
          .catch(error => toast(error?.message || t('liveUnavailable')))
          .finally(() => { button.disabled = false; });
      }
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

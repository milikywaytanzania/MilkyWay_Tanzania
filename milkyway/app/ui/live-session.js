// LiveSession — one real-time Live connection (viewer or host).
//
// Media:   LiveKit (WebRTC SFU) with adaptive stream + dynacast, so each viewer only receives the layer its screen needs.
// Events:  comments, gifts, likes and joins travel on LiveKit data channels (sub-100 ms) AND on a Supabase Realtime
//          broadcast channel as a fallback. Every event carries an id and is de-duplicated, so a viewer whose WebRTC
//          is blocked still sees chat and gifts, and nobody sees anything twice.
// History: comments are persisted through /api/milkyway-live-room so late joiners see the recent conversation.
// Viewers: counted from LiveKit participants (authoritative), Realtime presence when LiveKit is not connected.
//
// Live room signals: understands {type:'lv-heart'} / {type:'lv-sync'} signals and sends them.
import { config } from '../config.js';
import { api, auth, supabase, isNetworkError, accessToken } from '../core/net.js';
import { loadLiveKit } from '../core/sdk.js';
import { sendGift } from '../data/gifts.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOPIC = 'mw';
const SAFETY_POLL_MS = 20_000;
const HOST_POLL_MS = 4_000;   // the host watches guest requests closely
const STAGE_POLL_MS = 5_000;  // viewers who requested, were invited or are on stage
const HOST_GRACE_MS = 25_000;
const tokenCache = new Map(); // room → { payload, at }

class Emitter {
  #handlers = new Map();
  on(type, fn) { (this.#handlers.get(type) || this.#handlers.set(type, new Set()).get(type)).add(fn); return () => this.#handlers.get(type)?.delete(fn); }
  emit(type, detail) { this.#handlers.get(type)?.forEach(fn => { try { fn(detail); } catch (error) { console.error(error); } }); }
}

const isJson = response => response && ![404, 405].includes(response.status) && /json/.test(response.headers.get('content-type') || '');

async function fetchToken(live, host) {
  const cached = tokenCache.get(live.room);
  if (!host && cached && Date.now() - cached.at < 60_000) return cached.payload;
  const body = {
    room: live.room, roomName: live.room, identity: auth.userId, name: auth.name, participantName: auth.name,
    role: host ? 'host' : 'viewer', title: live.title, scope: 'public', action: 'token',
  };
  let payload;
  try { payload = await api(config.livekit.tokenEndpoint, { method: 'POST', body, timeout: 12000 }); }
  catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
    // Site API unreachable or not deployed here: go straight to the Supabase Edge Function.
    const token = await accessToken();
    const response = await fetch(config.livekit.directTokenEndpoint, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json', apikey: config.supabase.anonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!isJson(response)) throw error;
    payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload?.error || 'LIVE unavailable'), { status: response.status });
  }
  if (!payload?.token || !payload?.serverUrl || !/^wss:/i.test(payload.serverUrl)) throw new Error('Invalid LIVE token.');
  tokenCache.set(live.room, { payload, at: Date.now() });
  return payload;
}

export class LiveSession extends Emitter {
  constructor(live, { host = false, mode = live.mode || 'video' } = {}) {
    super();
    this.live = live;
    this.host = host;
    this.mode = mode;
    this.room = null;
    this.channel = null;
    this.seen = new Set();
    this.closed = false;
    this.viewers = 0;
    this.likeBatch = 0;
    this.status = null;      // last /live-room status: settings, self, members, messages
    this.onStage = false;    // a guest currently publishing
    this.approving = new Set();
  }

  get settings() { return this.status?.settings || {}; }
  get self() { return this.status?.self || null; }

  /** Connects media + event channels. Resolves when watching (or throws with a readable message). */
  async join() {
    this.emit('state', 'connecting');
    this.#openRealtime(); // in parallel; never blocks the video
    this.#loadHistory();
    const [sdk, token] = await Promise.all([loadLiveKit(), fetchToken(this.live, this.host)]);
    if (this.closed) return;
    const { Room, RoomEvent, Track } = sdk;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
      videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 }, facingMode: 'user' },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.room = room;
    this.sdk = sdk;

    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => this.#attach(track, participant, Track))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => { track.detach().forEach(element => element.remove()); if (track.kind === 'video') this.emit('video-gone', participant.identity); })
      .on(RoomEvent.LocalTrackPublished, publication => { if (publication.track?.kind === 'video') this.#attach(publication.track, room.localParticipant, Track, true); })
      .on(RoomEvent.LocalTrackUnpublished, publication => { if (publication.kind === 'video' || publication.track?.kind === 'video') { publication.track?.detach().forEach(element => element.remove()); this.emit('video-gone', room.localParticipant.identity); } })
      .on(RoomEvent.TrackMuted, (publication, participant) => this.emit('track-muted', { participant: participant.identity, kind: publication.kind, muted: true }))
      .on(RoomEvent.TrackUnmuted, (publication, participant) => this.emit('track-muted', { participant: participant.identity, kind: publication.kind, muted: false }))
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => { if (participant === room.localParticipant || participant?.isLocal) this.#syncStage(); })
      .on(RoomEvent.ParticipantConnected, participant => {
        this.#countViewers(); this.emit('audience');
        if (participant.identity === this.live.host.id) clearTimeout(this.hostTimer);
        // Someone the host removed tried to come back: disconnect them again.
        if (this.host && this.settings.blockedIds?.includes(participant.identity)) this.control('kick', { target: participant.identity }, { quiet: true }).catch(() => {});
      })
      .on(RoomEvent.ParticipantDisconnected, participant => {
        this.#countViewers(); this.emit('audience');
        if (!this.host && participant.identity === this.live.host.id) {
          clearTimeout(this.hostTimer);
          this.hostTimer = setTimeout(() => this.#ended(), HOST_GRACE_MS);
        }
      })
      .on(RoomEvent.DataReceived, (payload, participant) => this.#receive(payload, participant))
      .on(RoomEvent.Reconnecting, () => this.emit('state', 'reconnecting'))
      .on(RoomEvent.Reconnected, () => { this.emit('state', 'connected'); this.#loadHistory(); })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.emit('audio-blocked', !room.canPlaybackAudio))
      .on(RoomEvent.Disconnected, reason => {
        if (this.closed) return;
        if (reason != null && reason === sdk.DisconnectReason?.ROOM_DELETED) this.#ended();
        else if (reason != null && reason === sdk.DisconnectReason?.PARTICIPANT_REMOVED) this.#removed();
        else this.emit('state', 'disconnected');
      });

    await room.connect(token.serverUrl, token.token, { autoSubscribe: true });
    if (this.closed) { room.disconnect(); return; }
    this.emit('state', 'connected');
    this.#countViewers();
    if (!this.host && ![...room.remoteParticipants.values()].some(p => p.identity === this.live.host.id)) {
      this.hostTimer = setTimeout(() => this.#ended(), HOST_GRACE_MS);
    }
    room.startAudio?.().catch(() => this.emit('audio-blocked', true));
    if (this.host) await this.#publish();
    this.#schedulePoll();
    this.flushLikes = setInterval(() => this.#sendLikes(), 500);
  }

  async leave() {
    this.closed = true;
    clearTimeout(this.poll); clearInterval(this.flushLikes); clearTimeout(this.hostTimer); clearTimeout(this.nudgeTimer);
    this.#sendLikes();
    try { await this.room?.disconnect(); } catch {}
    try { if (this.channel) (await supabase()).removeChannel(this.channel); } catch {}
    this.room = null; this.channel = null;
  }

  /** Unlocks audio after a user gesture (mobile autoplay policies). */
  resumeAudio() { return this.room?.startAudio?.(); }

  // ---- Sending ---------------------------------------------------------------------------------------------
  /** Sends a comment. The server applies the host's rules first; only accepted comments reach other viewers. */
  async comment(text) {
    const body = text.trim().slice(0, 300);
    if (!body) return;
    const event = { t: 'chat', id: crypto.randomUUID(), uid: auth.userId, name: auth.name, body, at: Date.now() };
    this.#deliver(event); // optimistic, instant for the sender
    try {
      const result = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'message', id: event.id, message: body } });
      if (result?.filtered) return; // hidden from everyone else, like a filtered TikTok comment
    } catch (error) {
      if (!isNetworkError(error)) { this.emit('comment-rejected', { id: event.id, error }); return; }
    }
    this.#broadcast(event, true);
    this.#legacy({ type: 'lv-sync' });
  }

  like() {
    if (this.settings.likesEnabled === false) return;
    this.likeBatch += 1;
    this.emit('like', { n: 1, mine: true });
  }

  async gift(key) {
    const result = await sendGift({ gift: key, room: this.live.room });
    const event = { t: 'gift', id: crypto.randomUUID(), uid: auth.userId, name: auth.name, gift: key, at: Date.now() };
    this.#deliver(event);
    this.#broadcast(event, true);
    return result;
  }

  // ---- Stream controls (host, and guests on stage) ---------------------------------------------------------
  async flipCamera() {
    const track = this.room?.localParticipant.getTrackPublication(this.sdk.Track.Source.Camera)?.track;
    if (!track) return;
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    await track.restartTrack({ facingMode: this.facing });
    this.emit('facing', this.facing);
  }
  async toggleMic() {
    const lp = this.room?.localParticipant;
    if (!lp) return true;
    if (!this.host && this.self?.hostMuted) throw new Error('The host muted your microphone.');
    const next = !lp.isMicrophoneEnabled;
    await lp.setMicrophoneEnabled(next);
    return next;
  }
  async toggleCamera() {
    const lp = this.room?.localParticipant;
    if (!lp || this.mode !== 'video') return false;
    const next = !lp.isCameraEnabled;
    await lp.setCameraEnabled(next, { facingMode: this.facing || 'user' });
    this.#broadcast({ t: 'cam', id: crypto.randomUUID(), uid: auth.userId, on: next }, true);
    return next;
  }
  get micOn() { return !!this.room?.localParticipant?.isMicrophoneEnabled; }
  get cameraOn() { return !!this.room?.localParticipant?.isCameraEnabled; }

  /** Everyone connected to the LiveKit room right now (identity + name), excluding the host. */
  audience() {
    if (!this.room) return [];
    return [...this.room.remoteParticipants.values()]
      .filter(participant => participant.identity !== this.live.host.id)
      .map(participant => ({ userId: participant.identity, name: participant.name || '' }));
  }

  /** Host moderation / guest action through the server, then everyone refreshes. */
  async control(action, extra = {}, { quiet = false } = {}) {
    const result = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action, ...extra } });
    if (result?.settings && this.status) this.status = { ...this.status, settings: result.settings };
    this.#nudge(this.host ? '' : 'host'); // a viewer's stage change only concerns the host
    if (!quiet) await this.refresh();
    return result;
  }

  // ---- Guest actions (viewers) ----------------------------------------------------------------------------
  async requestStage() { const result = await this.control('request'); return result?.state; }
  async acceptInvite() { const result = await this.control('accept-invite'); return result?.state; }
  async declineInvite() {
    await this.control('decline-invite');
    this.#broadcast({ t: 'decline', id: crypto.randomUUID(), uid: auth.userId }, true);
  }
  async leaveStage() { await this.control('leave-stage'); await this.#syncStage(); }

  async end() {
    try { await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'end' } }); } catch {}
    const event = { t: 'end', id: crypto.randomUUID(), at: Date.now() };
    this.#broadcast(event, true);
    await this.leave();
  }

  /** Re-reads the room (settings, stage, chat history). Public so the UI can refresh after an action. */
  refresh() { return this.#loadHistory(); }

  // ---- Internals -------------------------------------------------------------------------------------------
  async #publish() {
    const lp = this.room.localParticipant;
    await lp.setMicrophoneEnabled(true);
    if (this.mode === 'video') await lp.setCameraEnabled(true, { facingMode: 'user' });
    this.facing = 'user';
    // Starting settings chosen in the Go LIVE sheet (guests, comments); everything else keeps its defaults.
    const initial = { layout: 4, admission: 'approval', order: [], ...(this.live.initialSettings || {}) };
    api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'settings', ...initial } })
      .then(result => { if (result?.settings) this.status = { ...(this.status || {}), settings: result.settings }; this.refresh(); })
      .catch(() => {});
    api('/api/milkyway-notifications?action=live-started', { method: 'POST', body: { room: this.live.room } }).catch(() => {});
  }

  // Publishes or unpublishes the guest's camera/mic to match their seat on stage.
  async #syncStage() {
    if (this.host || !this.room || this.closed) return;
    const self = this.self;
    const lp = this.room.localParticipant;
    const seated = self?.state === 'speaker';
    try {
      if (seated && lp.permissions?.canPublish !== false) {
        if (!this.onStage) {
          this.onStage = true;
          if (this.mode === 'video') await lp.setCameraEnabled(true, { facingMode: this.facing || 'user' });
          if (!self.hostMuted) await lp.setMicrophoneEnabled(true);
          this.emit('stage', { onStage: true });
        }
        if (self.hostMuted && lp.isMicrophoneEnabled) await lp.setMicrophoneEnabled(false);
      } else if (!seated && this.onStage) {
        this.onStage = false;
        await lp.setCameraEnabled(false).catch(() => {});
        await lp.setMicrophoneEnabled(false).catch(() => {});
        this.emit('stage', { onStage: false });
      }
    } catch (error) {
      this.onStage = false; // permission not granted yet; the next refresh retries
      if (error?.name === 'NotAllowedError') this.emit('error', Object.assign(new Error('Camera and microphone are needed to join as a guest.'), { status: 0 }));
    }
  }

  #schedulePoll() {
    clearTimeout(this.poll);
    if (this.closed) return;
    const busy = this.host || ['pending', 'speaker'].includes(this.self?.state) || this.self?.invited;
    this.poll = setTimeout(async () => {
      if (document.visibilityState === 'visible') await this.#loadHistory();
      this.#schedulePoll();
    }, this.host ? HOST_POLL_MS : busy ? STAGE_POLL_MS : SAFETY_POLL_MS);
  }

  // Tells everyone in the room that the room state changed, so they refresh now instead of at the next poll.
  #nudge(to = '') { this.#broadcast({ t: 'room', id: crypto.randomUUID(), uid: auth.userId, to }, true); }

  #onNudge() {
    clearTimeout(this.nudgeTimer);
    // Spread viewer refreshes so a host action does not hit the API with every viewer at the same instant.
    this.nudgeTimer = setTimeout(() => this.#loadHistory(), this.host ? 150 : 250 + Math.random() * 1250);
  }

  // The host's app approves guests who accepted an invitation (publish rights can only be granted by the host).
  #autoApprove(status) {
    if (!this.host) return;
    for (const member of status.members || []) {
      if (member.state !== 'pending' || !member.invited || this.approving.has(member.userId)) continue;
      this.approving.add(member.userId);
      this.control('approve', { target: member.userId }, { quiet: true })
        .catch(error => this.emit('error', error))
        .finally(() => { this.approving.delete(member.userId); this.#onNudge(); });
    }
  }

  #removed() {
    if (this.removedOnce) return;
    this.removedOnce = true;
    this.emit('removed');
  }

  #attach(track, participant, Track, local = false) {
    if (track.kind === Track.Kind.Audio) { const el = track.attach(); el.hidden = true; this.emit('audio', el); return; }
    const element = track.attach();
    element.playsInline = true;
    element.muted = true;
    element.className = 'live-track';
    if (local) element.classList.add('local');
    if (local && this.facing !== 'environment') element.classList.add('mirror');
    this.emit('video', { element, participant: participant.identity, name: participant.name || '', local, isHost: participant.identity === this.live.host.id });
  }

  #countViewers() {
    if (!this.room) return;
    const n = Math.max(1, (this.room.numParticipants || this.room.remoteParticipants.size + 1) - 1);
    if (n !== this.viewers) { this.viewers = n; this.emit('viewers', n); }
  }

  async #openRealtime() {
    try {
      const sb = await supabase();
      if (this.closed) return;
      const channel = sb.channel(`mw-live:${this.live.room}`, { config: { broadcast: { self: false }, presence: { key: auth.userId || crypto.randomUUID() } } });
      channel
        .on('broadcast', { event: TOPIC }, ({ payload }) => this.#handle(payload))
        .on('presence', { event: 'sync' }, () => {
          if (this.room?.state === 'connected') return;
          const n = Object.keys(channel.presenceState()).length;
          if (n && n !== this.viewers) { this.viewers = n; this.emit('viewers', n); }
        })
        .subscribe(status => { if (status === 'SUBSCRIBED') channel.track({ at: Date.now() }).catch(() => {}); });
      this.channel = channel;
    } catch { /* LiveKit data still works */ }
  }

  #broadcast(event, reliable) {
    try { this.room?.localParticipant.publishData(encoder.encode(JSON.stringify(event)), { reliable, topic: TOPIC }).catch(() => {}); } catch {}
    try { this.channel?.send({ type: 'broadcast', event: TOPIC, payload: event }); } catch {}
  }

  #legacy(message) {
    try { this.room?.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: false }).catch(() => {}); } catch {}
  }

  #sendLikes() {
    if (!this.likeBatch) return;
    const n = Math.min(this.likeBatch, 50);
    this.likeBatch = 0;
    this.#broadcast({ t: 'like', id: crypto.randomUUID(), n }, false);
    this.#legacy({ type: 'lv-heart' });
  }

  #receive(payload, participant) {
    let message;
    try { message = JSON.parse(decoder.decode(payload)); } catch { return; }
    if (message?.type === 'lv-heart') return this.emit('like', { n: 1 });
    if (message?.type === 'lv-sync') return this.#loadHistory();
    // LiveKit data is authenticated: the sender's identity replaces whatever the payload claims.
    if (message && participant?.identity) message.uid = participant.identity;
    this.#handle(message);
  }

  #handle(event) {
    if (!event?.id || this.seen.has(event.id)) return;
    this.#deliver(event);
  }

  // Comments from people the host muted or removed (or while comments are off) never render, even if a modified
  // client broadcasts them directly.
  #hidden(event) {
    if (event.uid === auth.userId || event.uid === this.live.host.id) return false;
    const settings = this.settings;
    return settings.comments === 'off' || settings.mutedIds?.includes(event.uid) || settings.blockedIds?.includes(event.uid);
  }

  #deliver(event) {
    this.seen.add(event.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    if (event.t === 'chat') { if (!this.#hidden(event)) this.emit('comment', event); }
    else if (event.t === 'gift') this.emit('gift', event);
    else if (event.t === 'like') { if (this.settings.likesEnabled !== false) this.emit('like', { n: Math.min(event.n || 1, 50) }); }
    else if (event.t === 'end') this.#ended();
    else if (event.t === 'room') { if (!event.to || (event.to === 'host' && this.host)) this.#onNudge(); }
    else if (event.t === 'cam') this.emit('camera', { participant: event.uid, on: !!event.on });
    else if (event.t === 'decline' && this.host && event.uid) this.control('cancel-invite', { target: event.uid }, { quiet: true }).then(() => this.emit('declined', event.uid)).catch(() => {});
  }

  async #loadHistory() {
    if (!auth.signedIn() || this.loadingHistory || this.closed) return;
    this.loadingHistory = true;
    try {
      const status = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'status' }, timeout: 10000 });
      if (this.closed || !status) return;
      const before = this.status;
      this.status = status;
      for (const message of status.messages || []) {
        if (message.deleted) { if (this.seen.has(message.id)) this.emit('comment-deleted', message.id); continue; }
        if (message.kind !== 'chat' || this.seen.has(message.id)) continue;
        this.#deliver({ t: 'chat', id: message.id, uid: message.userId, name: message.name, body: message.body, at: Date.parse(message.createdAt), history: true });
      }
      if (!this.host && status.self?.invited && !before?.self?.invited) this.emit('invited');
      this.emit('room', status);
      this.#autoApprove(status);
      await this.#syncStage();
      if (!this.host) this.#schedulePoll();
    } catch (error) {
      if (error.status === 404) this.#ended();
      else if (error.status === 403 && !this.host) this.#removed();
    } finally { this.loadingHistory = false; }
  }

  #ended() {
    if (this.endedOnce) return;
    this.endedOnce = true;
    this.emit('ended');
  }
}

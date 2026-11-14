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
  }

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
      .on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => element.remove()))
      .on(RoomEvent.LocalTrackPublished, publication => { if (publication.track?.kind === 'video') this.#attach(publication.track, room.localParticipant, Track, true); })
      .on(RoomEvent.ParticipantConnected, participant => { this.#countViewers(); if (participant.identity === this.live.host.id) clearTimeout(this.hostTimer); })
      .on(RoomEvent.ParticipantDisconnected, participant => {
        this.#countViewers();
        if (!this.host && participant.identity === this.live.host.id) {
          clearTimeout(this.hostTimer);
          this.hostTimer = setTimeout(() => this.#ended(), HOST_GRACE_MS);
        }
      })
      .on(RoomEvent.DataReceived, (payload, participant) => this.#receive(payload, participant))
      .on(RoomEvent.Reconnecting, () => this.emit('state', 'reconnecting'))
      .on(RoomEvent.Reconnected, () => { this.emit('state', 'connected'); this.#loadHistory(); })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.emit('audio-blocked', !room.canPlaybackAudio))
      .on(RoomEvent.Disconnected, reason => { if (!this.closed && reason != null && reason === sdk.DisconnectReason?.ROOM_DELETED) this.#ended(); else if (!this.closed) this.emit('state', 'disconnected'); });

    await room.connect(token.serverUrl, token.token, { autoSubscribe: true });
    if (this.closed) { room.disconnect(); return; }
    this.emit('state', 'connected');
    this.#countViewers();
    if (!this.host && ![...room.remoteParticipants.values()].some(p => p.identity === this.live.host.id)) {
      this.hostTimer = setTimeout(() => this.#ended(), HOST_GRACE_MS);
    }
    room.startAudio?.().catch(() => this.emit('audio-blocked', true));
    if (this.host) await this.#publish();
    this.poll = setInterval(() => document.visibilityState === 'visible' && this.#loadHistory(), SAFETY_POLL_MS);
    this.flushLikes = setInterval(() => this.#sendLikes(), 500);
  }

  async leave() {
    this.closed = true;
    clearInterval(this.poll); clearInterval(this.flushLikes); clearTimeout(this.hostTimer);
    this.#sendLikes();
    try { await this.room?.disconnect(); } catch {}
    try { if (this.channel) (await supabase()).removeChannel(this.channel); } catch {}
    this.room = null; this.channel = null;
  }

  /** Unlocks audio after a user gesture (mobile autoplay policies). */
  resumeAudio() { return this.room?.startAudio?.(); }

  // ---- Sending ---------------------------------------------------------------------------------------------
  async comment(text) {
    const body = text.trim().slice(0, 300);
    if (!body) return;
    const event = { t: 'chat', id: crypto.randomUUID(), uid: auth.userId, name: auth.name, body, at: Date.now() };
    this.#deliver(event);          // optimistic, instant
    this.#broadcast(event, true);  // everyone, sub-second
    this.#legacy({ type: 'lv-sync' });
    try { await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'message', id: event.id, message: body } }); }
    catch (error) { if (!isNetworkError(error)) this.emit('error', error); }
  }

  like() {
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

  // Host controls
  async flipCamera() {
    const track = this.room?.localParticipant.getTrackPublication(this.sdk.Track.Source.Camera)?.track;
    if (!track) return;
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    await track.restartTrack({ facingMode: this.facing });
  }
  async toggleMic() {
    const lp = this.room?.localParticipant;
    if (!lp) return true;
    const next = !lp.isMicrophoneEnabled;
    await lp.setMicrophoneEnabled(next);
    return next;
  }
  async end() {
    try { await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'end' } }); } catch {}
    const event = { t: 'end', id: crypto.randomUUID(), at: Date.now() };
    this.#broadcast(event, true);
    await this.leave();
  }

  // ---- Internals -------------------------------------------------------------------------------------------
  async #publish() {
    const lp = this.room.localParticipant;
    await lp.setMicrophoneEnabled(true);
    if (this.mode === 'video') await lp.setCameraEnabled(true, { facingMode: 'user' });
    api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'settings', layout: 4, admission: 'direct', order: [] } }).catch(() => {});
    api('/api/milkyway-notifications?action=live-started', { method: 'POST', body: { room: this.live.room } }).catch(() => {});
  }

  #attach(track, participant, Track, local = false) {
    if (track.kind === Track.Kind.Audio) { const el = track.attach(); el.hidden = true; this.emit('audio', el); return; }
    const element = track.attach();
    element.playsInline = true;
    element.muted = true;
    element.className = 'live-track';
    if (local) element.classList.add('mirror');
    this.emit('video', { element, participant: participant.identity, isHost: participant.identity === this.live.host.id || local });
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

  #receive(payload) {
    let message;
    try { message = JSON.parse(decoder.decode(payload)); } catch { return; }
    if (message?.type === 'lv-heart') return this.emit('like', { n: 1 });
    if (message?.type === 'lv-sync') return this.#loadHistory();
    this.#handle(message);
  }

  #handle(event) {
    if (!event?.id || this.seen.has(event.id)) return;
    this.#deliver(event);
  }

  #deliver(event) {
    this.seen.add(event.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    if (event.t === 'chat') this.emit('comment', event);
    else if (event.t === 'gift') this.emit('gift', event);
    else if (event.t === 'like') this.emit('like', { n: Math.min(event.n || 1, 50) });
    else if (event.t === 'end') this.#ended();
  }

  async #loadHistory() {
    if (!auth.signedIn() || this.loadingHistory) return;
    this.loadingHistory = true;
    try {
      const status = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'status' }, timeout: 10000 });
      for (const message of status?.messages || []) {
        if (message.deleted || message.kind !== 'chat' || this.seen.has(message.id)) continue;
        this.#deliver({ t: 'chat', id: message.id, uid: message.userId, name: message.name, body: message.body, at: Date.parse(message.createdAt), history: true });
      }
    } catch (error) {
      if (error.status === 404) this.#ended();
    } finally { this.loadingHistory = false; }
  }

  #ended() {
    if (this.endedOnce) return;
    this.endedOnce = true;
    this.emit('ended');
  }
}

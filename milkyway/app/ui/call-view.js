// One-to-one audio and video calls (LiveKit media, MilkyWay call records via /api/milkyway-call).
//
//   calls.start(peer, 'video')  → rings the other person and opens the call screen
//   calls.watch()               → listens for incoming calls (Realtime nudge + polling fallback)
//
// The caller connects to the LiveKit room while it rings, so audio/video flows the moment the other side accepts.
import { config } from '../config.js';
import { api, auth, supabase, accessToken } from '../core/net.js';
import { bus } from '../core/events.js';
import { loadLiveKit } from '../core/sdk.js';
import { t } from '../core/i18n.js';
import { profiles } from '../data/profiles.js';
import { h, icon, avatar, toast } from './dom.js';
import { playback } from './playback.js';

const CALL_API = `${config.api.base}/milkyway-call`;

// Call token straight from the Supabase livekit-token function (used when LiveKit refused the site-signed token).
async function directCallToken(roomName, name) {
  const token = await accessToken();
  const response = await fetch(config.livekit.directTokenEndpoint, {
    method: 'POST', signal: AbortSignal.timeout(12000), body: JSON.stringify({ roomName, room: roomName, action: 'token', name }),
    headers: { 'Content-Type': 'application/json', apikey: config.supabase.anonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.token !== 'string' || !/^wss?:/i.test(data?.serverUrl || '')) throw new Error(data?.error || t('callFailed'));
  return data;
}
const RING_MS = 55_000;
const callApi = (action, body) => api(`${CALL_API}?action=${action}`, body ? { method: 'POST', body, timeout: 15000 } : { timeout: 12000 });
const getCall = id => api(`${CALL_API}?id=${encodeURIComponent(id)}`, { timeout: 10000 }).then(data => data?.call || null);

const icons = {
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z"/></svg>',
  hangup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .4-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41A16.9 16.9 0 0 1 12 7c4.5 0 8.6 1.76 11.7 4.67a1 1 0 0 1 0 1.41l-2.48 2.47a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23A6.9 6.9 0 0 0 19 11zm-4.02.17V5a3 3 0 0 0-5.96-.59l5.96 5.96v.8zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 4.29 2.71l1.66 1.66A5 5 0 0 1 7 11H5.3a6.9 6.9 0 0 0 5.7 6.72V21h2v-3.28c.9-.13 1.75-.44 2.5-.88L19.73 21 21 19.73 4.27 3z"/></svg>',
  camOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18V6.5zM3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.21 0 .39-.08.55-.18L19.73 21 21 19.73 3.27 2z"/></svg>',
};

class CallScreen {
  constructor({ call, peer, mode, incoming }) {
    this.call = call;
    this.peer = peer;
    this.mode = mode;
    this.incoming = incoming;
    this.closed = false;
    this.connectedAt = 0;
    this.micOn = true;
    this.camOn = mode === 'video';
    this.facing = 'user';
    this.#build();
    playback.suspend(true);
    if (incoming) this.#setState('incoming');
    else { this.#setState('ringing'); this.#connect(); this.ringTimer = setTimeout(() => this.hangUp('missed'), RING_MS); }
    this.poll = setInterval(() => this.#check(), 2000);
    if (incoming) navigator.vibrate?.([400, 200, 400, 200, 400]);
  }

  #build() {
    const person = profiles.peek(this.peer) || { id: this.peer, name: 'MilkyWay' };
    this.remote = h('div', { class: 'call-remote' });
    this.local = h('div', { class: 'call-local' });
    this.status = h('span', { class: 'call-status', role: 'status', 'aria-live': 'polite' });
    this.audioBox = h('div', { hidden: true });
    const button = (label, html, onclick, extra = '') => h('button', { class: `call-btn ${extra}`, type: 'button', 'aria-label': label, title: label, html, onclick });
    this.micBtn = button(t('microphone'), icon.mic, () => this.#toggleMic());
    this.camBtn = button(t('camera'), icon.camera, () => this.#toggleCam());
    this.flipBtn = button(t('flipCamera'), icon.flip, () => this.#flip());
    this.endBtn = button(t('endCall'), icons.hangup, () => this.hangUp(this.connectedAt ? 'ended' : 'cancelled'), 'end');
    if (this.mode !== 'video') { this.camBtn.hidden = true; this.flipBtn.hidden = true; }
    this.controls = h('div', { class: 'call-controls' }, this.micBtn, this.camBtn, this.flipBtn, this.endBtn);
    this.answer = h('div', { class: 'call-answer' },
      h('button', { class: 'call-btn end', type: 'button', 'aria-label': t('decline'), html: icons.hangup, onclick: () => this.#decline() }),
      h('button', { class: 'call-btn accept', type: 'button', 'aria-label': t('accept'), html: this.mode === 'video' ? icon.camera : icons.phone, onclick: () => this.#accept() }));
    this.root = h('div', { class: 'call-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': this.mode === 'video' ? t('videoCall') : t('audioCall'), 'data-mode': this.mode },
      this.remote, this.local,
      h('div', { class: 'call-info' }, avatar(person, 104), h('b', { class: 'call-name' }, person.name), this.status),
      this.controls, this.answer, this.audioBox);
    document.body.append(this.root);
    requestAnimationFrame(() => this.root.classList.add('open'));
    if (!profiles.peek(this.peer)) profiles.many([this.peer]).then(map => {
      const found = map.get(this.peer);
      if (found && !this.closed) { this.root.querySelector('.call-name').textContent = found.name; this.root.querySelector('.call-info .avatar').replaceWith(avatar(found, 104)); }
    });
  }

  #setState(state) {
    this.state = state;
    this.root.dataset.state = state;
    const labels = {
      incoming: this.mode === 'video' ? t('incomingVideo') : t('incomingAudio'),
      ringing: t('ringing'), connecting: t('joining'), connected: t('callConnected'),
      reconnecting: t('reconnecting'), ended: t('callEnded'), declined: t('callDeclined'), missed: t('noAnswer'), failed: t('callFailed'),
    };
    this.status.textContent = labels[state] || '';
    clearInterval(this.clock);
    if (state === 'connected') {
      this.connectedAt ||= Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - this.connectedAt) / 1000);
        this.status.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      };
      tick();
      this.clock = setInterval(tick, 1000);
    }
  }

  async #connect() {
    try {
      const [sdk, access] = await Promise.all([loadLiveKit(), callApi('token', { id: this.call.id, name: auth.name })]);
      if (this.closed) return;
      if (!access?.token || !/^wss?:/i.test(access?.serverUrl || '')) throw new Error(t('callFailed'));
      const { Room, RoomEvent, Track } = sdk;
      const room = this.room = new Room({
        adaptiveStream: true, dynacast: true,
        videoCaptureDefaults: { resolution: { width: 960, height: 540, frameRate: 24 }, facingMode: 'user' },
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      room
        .on(RoomEvent.TrackSubscribed, track => this.#attachRemote(track, Track))
        .on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => element.remove()))
        .on(RoomEvent.ParticipantConnected, () => this.#peerJoined())
        .on(RoomEvent.ParticipantDisconnected, () => { if (this.connectedAt && !room.remoteParticipants.size) this.hangUp('ended'); })
        .on(RoomEvent.Reconnecting, () => this.#setState('reconnecting'))
        .on(RoomEvent.Reconnected, () => this.#setState(room.remoteParticipants.size ? 'connected' : 'ringing'))
        .on(RoomEvent.Disconnected, () => { if (!this.closed) this.finish('ended'); })
        .on(RoomEvent.LocalTrackPublished, publication => {
          if (publication.track?.kind === 'video') { this.local.replaceChildren(publication.track.attach()); }
        });
      try { await room.connect(access.serverUrl, access.token, { autoSubscribe: true }); }
      catch (error) {
        // "invalid API key": the token was signed with a key this LiveKit project does not know. Ask the Supabase
        // livekit-token function (it signs with the project's own secrets) and connect once more.
        if (this.closed || !/api key|signal connection|unauthori[sz]ed|\b401\b/i.test(String(error?.message || ''))) throw error;
        const retry = await directCallToken(`mw-conversation-${this.mode === 'video' ? 'video' : 'audio'}-${this.call.id}`, auth.name);
        if (this.closed) return;
        await room.connect(retry.serverUrl, retry.token, { autoSubscribe: true });
      }
      if (this.closed) { room.disconnect(); return; }
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        if (this.mode === 'video') await room.localParticipant.setCameraEnabled(true, { facingMode: this.facing });
      } catch { toast(t('micNeeded')); }
      if (room.remoteParticipants.size) this.#peerJoined();
      room.remoteParticipants.forEach(participant => participant.trackPublications.forEach(publication => publication.track && this.#attachRemote(publication.track, Track)));
    } catch (error) {
      if (this.closed) return;
      console.warn('[call] connect failed', error);
      // LiveKit's own wording ("could not establish signal connection: invalid API key") means nothing to people.
      const raw = String(error?.message || '');
      toast(/signal|api key|websocket|token/i.test(raw) ? t('callServiceError') : raw ? `${t('callFailed')}: ${raw}` : t('callFailed'));
      this.hangUp('disconnected');
    }
  }

  #peerJoined() {
    clearTimeout(this.ringTimer);
    if (this.state !== 'connected') this.#setState('connected');
  }

  #attachRemote(track, Track) {
    const element = track.attach();
    if (track.kind === Track.Kind.Audio) { this.audioBox.append(element); element.play?.().catch(() => {}); return; }
    element.playsInline = true;
    this.remote.replaceChildren(element);
    this.root.classList.add('has-video');
  }

  async #accept() {
    navigator.vibrate?.(0);
    this.#setState('connecting');
    try {
      const result = await callApi('accept', { id: this.call.id });
      this.call = result?.call || this.call;
      this.incoming = false;
      this.#connect();
    } catch (error) { toast(error?.message || t('callFailed')); this.finish('ended'); }
  }

  async #decline() {
    navigator.vibrate?.(0);
    callApi('decline', { id: this.call.id }).catch(() => {});
    this.finish('declined');
  }

  async #check() {
    if (this.closed || document.visibilityState === 'hidden') return;
    try {
      const call = await getCall(this.call.id);
      if (!call || this.closed) return;
      this.call = call;
      if (call.status === 'declined') this.finish('declined');
      else if (call.status === 'ended') this.finish(call.answer?.outcome === 'missed' ? 'missed' : 'ended');
    } catch {}
  }

  /** Nudges from the other side (Realtime), so state changes show at once. */
  nudge(kind) {
    if (kind === 'declined') this.finish('declined');
    else if (kind === 'ended') this.finish('ended');
    else this.#check();
  }

  async #toggleMic() {
    this.micOn = !this.micOn;
    await this.room?.localParticipant.setMicrophoneEnabled(this.micOn).catch(() => {});
    this.micBtn.classList.toggle('off', !this.micOn);
    this.micBtn.innerHTML = this.micOn ? icon.mic : icons.micOff;
  }

  async #toggleCam() {
    this.camOn = !this.camOn;
    await this.room?.localParticipant.setCameraEnabled(this.camOn, { facingMode: this.facing }).catch(() => {});
    this.camBtn.classList.toggle('off', !this.camOn);
    this.camBtn.innerHTML = this.camOn ? icon.camera : icons.camOff;
    this.local.hidden = !this.camOn;
  }

  async #flip() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    const publication = [...(this.room?.localParticipant.videoTrackPublications?.values() || [])][0];
    try { await publication?.track?.restartTrack({ facingMode: this.facing }); } catch {}
  }

  hangUp(outcome = 'ended') {
    if (this.closed) return;
    callApi('end', { id: this.call.id, outcome }).catch(() => {});
    this.finish(outcome === 'missed' ? 'missed' : 'ended');
  }

  finish(state = 'ended') {
    if (this.closed) return;
    this.closed = true;
    navigator.vibrate?.(0);
    clearTimeout(this.ringTimer); clearInterval(this.poll); clearInterval(this.clock);
    const room = this.room; this.room = null;
    try { room?.removeAllListeners?.(); room?.disconnect(); } catch {}
    this.#setState(state);
    this.root.classList.add('closing');
    setTimeout(() => { this.root.remove(); playback.suspend(false); }, 1400);
    calls.active = calls.active === this ? null : calls.active;
  }
}

export const calls = {
  active: null,

  /** Rings `peer` (user id) with an audio or video call. */
  async start(peer, mode = 'audio') {
    if (!auth.signedIn() || !peer) return;
    if (calls.active) { toast(t('calling')); return; }
    if (!navigator.mediaDevices?.getUserMedia) { toast(t('micNeeded')); return; }
    try {
      const result = await callApi('start', { callee: peer, mode: mode === 'video' ? 'video' : 'audio', name: auth.name });
      if (!result?.call) throw new Error(t('callFailed'));
      calls.active = new CallScreen({ call: result.call, peer, mode, incoming: false });
    } catch (error) { toast(error?.message || t('callFailed')); }
  },

  /** Opens a ringing call addressed to me (from a notification link, the Realtime nudge or polling). */
  async ring(callOrId) {
    if (!auth.signedIn() || calls.active) return;
    try {
      const call = typeof callOrId === 'string' ? await getCall(callOrId) : callOrId;
      if (!call || call.status !== 'ringing' || call.callee_id !== auth.userId || calls.active) return;
      if (Date.now() - Date.parse(call.created_at) > RING_MS) return;
      calls.active = new CallScreen({ call, peer: call.caller_id, mode: call.offer?.mode === 'video' ? 'video' : 'audio', incoming: true });
    } catch {}
  },

  /** Listens for incoming calls while signed in. */
  watch() {
    if (calls.watching) return;
    calls.watching = true;
    let channel = null;
    const listen = async () => {
      if (!auth.signedIn()) return;
      const me = auth.userId;
      try {
        const sb = await supabase();
        if (auth.userId !== me) return;
        channel = sb.channel(`mw-calls-${me}`).on('broadcast', { event: 'call' }, ({ payload }) => {
          if (!payload?.id) return;
          if (calls.active?.call?.id === payload.id) calls.active.nudge(payload.kind);
          else if (payload.kind === 'ring') calls.ring(payload.id);
        }).subscribe();
      } catch {}
    };
    const poll = () => {
      if (!auth.signedIn() || calls.active || document.visibilityState === 'hidden') return;
      callApi('incoming').then(result => result?.call && calls.ring(result.call)).catch(() => {});
    };
    listen(); poll();
    setInterval(poll, 8000);
    document.addEventListener('visibilitychange', poll);
    bus.on('auth', async () => {
      if (channel) { try { (await supabase()).removeChannel(channel); } catch {} channel = null; }
      if (!auth.signedIn()) calls.active?.finish('ended');
      listen(); poll();
    });
  },
};

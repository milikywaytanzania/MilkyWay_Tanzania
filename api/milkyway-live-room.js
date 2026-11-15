import { createHmac } from 'node:crypto';
import { route, ApiError, requireUuid, isUuid } from './_lib/supa.js';
import { LIVE_DEFAULTS as DEFAULTS, loadLiveSettings as loadSettings } from './_lib/live-policy.js';

// Co-host Live rooms (TikTok-style guests). The client polls `status`; request/approve/mute/remove change who may
// publish. Publish rights are changed in LiveKit itself with the server secret, so a guest cannot grant themselves
// camera/mic access by editing database rows. Needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on Render.

const ROOM = /^mw-(audio|video)-live-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ADMISSIONS = ['approval', 'direct', 'broadcast'];
const COMMENT_MODES = ['everyone', 'followers', 'off'];
const SLOW_MODES = [0, 3, 10, 30, 60];
const INVITE_TTL_MS = 3 * 60_000;
const CAMERA = 1, MIC = 2;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|co|tz|ke|ug|me|ly|app|link|xyz|info|biz|site|online|shop)\b)/i;

const env = name => (process.env[name] || '').trim();
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function livekitConfigured() { return !!(env('LIVEKIT_URL') && env('LIVEKIT_API_KEY') && env('LIVEKIT_API_SECRET')); }

async function livekit(method, room, body) {
  if (!livekitConfigured()) throw new ApiError(503, 'LiveKit is not configured on the server (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: env('LIVEKIT_API_KEY'), sub: 'milkyway-render', nbf: now - 5, exp: now + 60, video: { roomAdmin: true, room } })}`;
  const jwt = `${head}.${createHmac('sha256', env('LIVEKIT_API_SECRET')).update(head).digest('base64url')}`;
  const origin = env('LIVEKIT_URL').replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
  let result;
  try {
    result = await fetch(`${origin}/twirp/livekit.RoomService/${method}`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, ...body }), signal: AbortSignal.timeout(8000),
    });
  } catch { throw new ApiError(503, 'LiveKit is unreachable.'); }
  const data = await result.json().catch(() => ({}));
  if (result.status === 404) return null; // participant or room is not connected right now
  if (!result.ok) throw new ApiError(503, data?.msg || 'LiveKit rejected the request.');
  return data;
}

const sourcesFor = (audioRoom, micAllowed) => audioRoom ? (micAllowed ? [MIC] : []) : (micAllowed ? [CAMERA, MIC] : [CAMERA]);
const setPublish = (room, identity, allowed, audioRoom, micAllowed = true) => livekit('UpdateParticipant', room, {
  identity,
  permission: { canSubscribe: true, canPublish: allowed, canPublishData: true, canPublishSources: allowed ? sourcesFor(audioRoom, micAllowed) : [] },
});

// Short cache so every viewer polling does not hit LiveKit each time.
const presence = new Map();
async function connectedIds(room) {
  const cached = presence.get(room);
  if (cached && Date.now() - cached.at < 2000) return cached.ids;
  let ids = cached?.ids || [];
  try {
    const data = await livekit('ListParticipants', room, {});
    ids = (data?.participants || []).map(participant => participant.identity);
  } catch { /* keep the last known list */ }
  presence.set(room, { at: Date.now(), ids });
  if (presence.size > 500) presence.delete(presence.keys().next().value);
  return ids;
}

const profiles = new Map();
async function whoAmI(ctx) {
  const cached = profiles.get(ctx.user.id);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  const [row] = await ctx.rest(`mw_profiles?id=eq.${ctx.user.id}&select=display_name,username,avatar_url&limit=1`).catch(() => []) || [];
  const value = { name: String(row?.display_name || row?.username || ctx.user.user_metadata?.name || 'MilkyWay user').slice(0, 80), avatar: String(row?.avatar_url || '').slice(0, 500) };
  profiles.set(ctx.user.id, { at: Date.now(), value });
  if (profiles.size > 1000) profiles.delete(profiles.keys().next().value);
  return value;
}

async function loadRoom(ctx, body) {
  const roomName = typeof body.room === 'string' ? body.room : typeof body.roomName === 'string' ? body.roomName : '';
  if (!ROOM.test(roomName)) throw new ApiError(400, 'Invalid Live room.');
  const [record] = await ctx.rest(`mw_video_live_sessions?room_name=eq.${encodeURIComponent(roomName)}&select=id,host_id,is_live,title&limit=1`) || [];
  if (!record) throw new ApiError(404, 'This Live session is no longer available.');
  return { roomName, record, host: record.host_id === ctx.user.id, audio: roomName.startsWith('mw-audio-') };
}


const requireHost = room => { if (!room.host) throw new ApiError(403, 'Only the host can do this.'); };
const enc = encodeURIComponent;
const memberPath = (roomName, userId) => `mw_live_room_members?room_name=eq.${enc(roomName)}&user_id=eq.${userId}`;
const upsertMember = (ctx, roomName, userId, fields) => ctx.rest('mw_live_room_members?on_conflict=room_name,user_id', {
  method: 'POST', prefer: 'resolution=merge-duplicates', body: { room_name: roomName, user_id: userId, updated_at: new Date().toISOString(), ...fields },
});
const saveSettings = (ctx, room, settings) => ctx.rest('mw_live_room_settings?on_conflict=room_name', {
  method: 'POST', prefer: 'resolution=merge-duplicates', body: { room_name: room.roomName, host_id: ctx.user.id, settings, updated_at: new Date().toISOString() },
});
const speakersOf = async (ctx, roomName) => (await ctx.rest(`mw_live_room_members?room_name=eq.${enc(roomName)}&state=eq.speaker&select=user_id`)) || [];
const freshInvites = invites => Object.fromEntries(Object.entries(invites || {}).filter(([id, at]) => isUuid(id) && Date.now() - Number(at) < INVITE_TTL_MS));
const without = (list, id) => (list || []).filter(entry => entry !== id);
const withId = (list, id) => [...new Set([...(list || []), id])].slice(-500);
const kickedMessage = 'The host removed you from this LIVE.';

// What a viewer may know about the room. Filter words and pending invites of other people stay with the host.
function publicSettings(settings, userId) {
  const { filterWords, invites, ...rest } = settings;
  return { ...rest, filterWordCount: filterWords.length, invited: !!freshInvites(invites)[userId] };
}

async function status(ctx, room) {
  const me = await whoAmI(ctx);
  const [settings, rows, messages, connected] = await Promise.all([
    loadSettings(ctx, room.roomName),
    ctx.rest(`mw_live_room_members?room_name=eq.${enc(room.roomName)}&select=room_name,user_id,name,avatar,state,host_muted&order=updated_at.desc&limit=200`),
    ctx.rest(`mw_live_room_messages?room_name=eq.${enc(room.roomName)}&select=id,user_id,name,avatar,kind,body,deleted,created_at&order=created_at.desc&limit=100`),
    connectedIds(room.roomName),
  ]);
  const myId = ctx.user.id.toLowerCase();
  if (!room.host && settings.blockedIds.includes(myId)) throw new ApiError(403, kickedMessage);
  let own = (rows || []).find(row => row.user_id === ctx.user.id);
  if (!room.host && !own) {
    await upsertMember(ctx, room.roomName, ctx.user.id, { name: me.name, avatar: me.avatar, state: 'viewer' }).catch(() => {});
    own = { room_name: room.roomName, user_id: ctx.user.id, name: me.name, avatar: me.avatar, state: 'viewer', host_muted: false };
  }
  if (room.host && !(await ctx.rest(`mw_live_room_settings?room_name=eq.${enc(room.roomName)}&select=room_name&limit=1`).catch(() => [null]))?.length) {
    await ctx.rest('mw_live_room_settings', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: { room_name: room.roomName, host_id: ctx.user.id, settings: DEFAULTS } }).catch(() => {});
  }
  const invites = freshInvites(settings.invites);
  const online = new Set(connected);
  const toMember = row => ({
    roomName: row.room_name, userId: row.user_id, name: row.name, avatar: row.avatar, state: row.state, hostMuted: !!row.host_muted,
    online: online.has(row.user_id), commentMuted: settings.mutedIds.includes(row.user_id), blocked: settings.blockedIds.includes(row.user_id),
    invited: !!invites[row.user_id],
  });
  const self = room.host
    ? { userId: ctx.user.id, name: me.name, avatar: me.avatar, state: 'speaker', hostMuted: false, host: true }
    : { ...toMember(own), invited: !!invites[myId] };
  const members = (rows || []).filter(row => row.user_id !== room.record.host_id).map(toMember);
  return {
    settings: room.host ? { ...settings, invites } : publicSettings(settings, myId),
    self,
    // Viewers only need the people on stage; the host gets everyone for audience management.
    members: room.host ? members : members.filter(member => member.state === 'speaker'),
    messages: (messages || []).reverse().map(row => ({ id: row.id, userId: row.user_id, name: row.name, avatar: row.avatar, kind: row.kind, body: row.deleted ? '' : row.body, deleted: !!row.deleted, createdAt: row.created_at })),
    connected: room.host ? connected : [],
    viewerCount: Math.max(0, connected.filter(id => id !== room.record.host_id).length),
    title: room.record.title || '',
  };
}

// Comment rules set by the host. Returns 'ok' or 'filtered' (stored hidden, shown only to the sender), or throws.
async function checkComment(ctx, room, settings, text) {
  if (room.host) return 'ok';
  const me = ctx.user.id.toLowerCase();
  if (settings.blockedIds.includes(me)) throw new ApiError(403, kickedMessage);
  if (settings.comments === 'off') throw new ApiError(403, 'The host turned off comments.');
  if (settings.mutedIds.includes(me)) throw new ApiError(403, 'The host muted your comments in this LIVE.');
  if (settings.comments === 'followers') {
    const [follow] = await ctx.rest(`mw_follows?follower_id=eq.${ctx.user.id}&following_id=eq.${room.record.host_id}&select=follower_id&limit=1`).catch(() => []) || [];
    if (!follow) throw new ApiError(403, 'Only followers of the host can comment.');
  }
  if (settings.slowMode > 0) {
    const since = new Date(Date.now() - settings.slowMode * 1000).toISOString();
    const recent = await ctx.rest(`mw_live_room_messages?room_name=eq.${enc(room.roomName)}&user_id=eq.${ctx.user.id}&created_at=gt.${enc(since)}&select=id&limit=1`).catch(() => []);
    if (recent?.length) throw new ApiError(429, `Slow mode is on: one comment every ${settings.slowMode} seconds.`);
  }
  const lower = text.toLowerCase();
  if (settings.filterLinks && LINK.test(text)) return 'filtered';
  if (settings.filterWords.some(word => lower.includes(word))) return 'filtered';
  return 'ok';
}

function cleanWords(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : [];
  return [...new Set(list.map(word => String(word).trim().toLowerCase().slice(0, 30)).filter(word => word.length >= 2))].slice(0, 50);
}

async function handle({ ctx, body, method }) {
  if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
  const action = String(body.action || 'status');
  const room = await loadRoom(ctx, body);
  const target = () => requireUuid(typeof body.target === 'string' ? body.target.toLowerCase() : '', 'participant');
  const me = ctx.user.id.toLowerCase();

  if (action === 'status') return status(ctx, room);
  if (action === 'started') return { ok: true };
  if (!room.record.is_live && action !== 'end') throw new ApiError(404, 'This Live session has ended.');

  // ---- Audience actions -----------------------------------------------------------------------------------
  if (action === 'request' || action === 'accept-invite') {
    if (room.host) throw new ApiError(400, 'The host is already on stage.');
    const settings = await loadSettings(ctx, room.roomName);
    if (settings.blockedIds.includes(me)) throw new ApiError(403, kickedMessage);
    const user = await whoAmI(ctx);
    const [existing] = await ctx.rest(`${memberPath(room.roomName, ctx.user.id)}&select=state,host_muted&limit=1`) || [];
    if (existing?.state === 'speaker') {
      await setPublish(room.roomName, ctx.user.id, true, room.audio, !existing.host_muted);
      return { state: 'speaker' };
    }
    const invited = !!freshInvites(settings.invites)[me];
    if (action === 'accept-invite' && !invited) throw new ApiError(410, 'This invitation has expired.');
    const seated = await speakersOf(ctx, room.roomName);
    if (seated.length >= settings.layout - 1) throw new ApiError(409, 'All guest seats are full.');
    if (invited) {
      // The host's app approves invited guests the moment it sees them waiting (publish rights come from the host).
      await upsertMember(ctx, room.roomName, ctx.user.id, { name: user.name, avatar: user.avatar, state: 'pending' });
      return { state: 'pending', invited: true };
    }
    if (settings.admission === 'broadcast' || settings.allowRequests === false) throw new ApiError(403, 'The host is not taking guest requests right now.');
    const direct = settings.admission === 'direct';
    await upsertMember(ctx, room.roomName, ctx.user.id, { name: user.name, avatar: user.avatar, state: direct ? 'speaker' : 'pending' });
    if (direct) await setPublish(room.roomName, ctx.user.id, true, room.audio).catch(async error => {
      await upsertMember(ctx, room.roomName, ctx.user.id, { state: 'viewer' }).catch(() => {});
      throw error;
    });
    return { state: direct ? 'speaker' : 'pending' };
  }

  if (action === 'decline-invite' || action === 'leave-stage') {
    if (room.host) throw new ApiError(400, 'The host cannot leave the stage.');
    await upsertMember(ctx, room.roomName, ctx.user.id, { state: 'viewer', host_muted: false });
    if (action === 'leave-stage') await setPublish(room.roomName, ctx.user.id, false, room.audio).catch(() => {});
    return { state: 'viewer' };
  }

  if (action === 'message') {
    const id = requireUuid(body.id, 'message');
    const text = typeof body.message === 'string' ? body.message.trim().slice(0, 300) : '';
    if (!text) throw new ApiError(400, 'Write a message first.');
    const settings = await loadSettings(ctx, room.roomName);
    const verdict = await checkComment(ctx, room, settings, text);
    const user = await whoAmI(ctx);
    await ctx.rest('mw_live_room_messages', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: { id, room_name: room.roomName, user_id: ctx.user.id, name: user.name, avatar: user.avatar, kind: 'chat', body: text, deleted: verdict === 'filtered' } });
    return { ok: true, filtered: verdict === 'filtered' };
  }

  // ---- Host controls --------------------------------------------------------------------------------------
  requireHost(room);
  const settings = await loadSettings(ctx, room.roomName);
  const update = async changes => {
    const next = { ...settings, ...changes, invites: freshInvites(changes.invites ?? settings.invites) };
    await saveSettings(ctx, room, next);
    return { ok: true, settings: next };
  };

  if (action === 'approve') {
    const userId = target();
    if (settings.blockedIds.includes(userId)) throw new ApiError(409, 'Unblock this person before inviting them on stage.');
    const speakers = await speakersOf(ctx, room.roomName);
    if (!speakers.some(row => row.user_id === userId) && speakers.length >= settings.layout - 1) throw new ApiError(409, 'All guest seats are full. Add more guest seats in Guest settings.');
    const [member] = await ctx.rest(`${memberPath(room.roomName, userId)}&select=user_id&limit=1`) || [];
    if (!member) throw new ApiError(404, 'That person is not in this Live.');
    await setPublish(room.roomName, userId, true, room.audio);
    await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { state: 'speaker', host_muted: false, updated_at: new Date().toISOString() } });
    const { [userId]: wasInvited, ...invites } = freshInvites(settings.invites);
    if (wasInvited) await update({ invites });
    return { ok: true, state: 'speaker' };
  }

  if (action === 'reject' || action === 'remove') {
    const userId = target();
    await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { state: 'viewer', host_muted: false, updated_at: new Date().toISOString() } });
    await setPublish(room.roomName, userId, false, room.audio).catch(() => {});
    return { ok: true };
  }

  if (action === 'mute' || action === 'allow-mic') {
    const userId = target();
    const muted = action === 'mute';
    await setPublish(room.roomName, userId, true, room.audio, !muted);
    await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { host_muted: muted, updated_at: new Date().toISOString() } });
    return { ok: true };
  }

  if (action === 'invite') {
    const userId = target();
    if (userId === me) throw new ApiError(400, 'You are already on stage.');
    if (settings.blockedIds.includes(userId)) throw new ApiError(409, 'Unblock this person before inviting them.');
    const speakers = await speakersOf(ctx, room.roomName);
    if (speakers.some(row => row.user_id === userId)) throw new ApiError(409, 'This person is already a guest.');
    if (speakers.length >= settings.layout - 1) throw new ApiError(409, 'All guest seats are full. Add more guest seats in Guest settings.');
    return update({ invites: { ...freshInvites(settings.invites), [userId]: Date.now() } });
  }

  if (action === 'cancel-invite') {
    const userId = target();
    const { [userId]: _gone, ...invites } = freshInvites(settings.invites);
    return update({ invites });
  }

  if (action === 'mute-comments' || action === 'unmute-comments') {
    const userId = target();
    return update({ mutedIds: action === 'mute-comments' ? withId(settings.mutedIds, userId) : without(settings.mutedIds, userId) });
  }

  if (action === 'kick') {
    // Remove from the LIVE: off stage, disconnected now, and refused if they try to come back.
    const userId = target();
    if (userId === me) throw new ApiError(400, 'You cannot remove yourself.');
    const { [userId]: _gone, ...invites } = freshInvites(settings.invites);
    const result = await update({ blockedIds: withId(settings.blockedIds, userId), invites });
    await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { state: 'viewer', host_muted: false, updated_at: new Date().toISOString() } }).catch(() => {});
    await setPublish(room.roomName, userId, false, room.audio).catch(() => {});
    await livekit('RemoveParticipant', room.roomName, { identity: userId }).catch(() => {});
    presence.delete(room.roomName);
    return result;
  }

  if (action === 'unblock') return update({ blockedIds: without(settings.blockedIds, target()) });

  if (action === 'pin') {
    const id = requireUuid(body.id, 'message');
    const [row] = await ctx.rest(`mw_live_room_messages?id=eq.${id}&room_name=eq.${enc(room.roomName)}&select=id,user_id,name,body,deleted&limit=1`) || [];
    if (!row || row.deleted) throw new ApiError(404, 'That comment is no longer available.');
    return update({ pinned: { id: row.id, userId: row.user_id, name: row.name, body: row.body, at: Date.now() } });
  }

  if (action === 'unpin') return update({ pinned: null });

  if (action === 'settings') {
    const layout = Number.isInteger(body.layout) ? Math.max(2, Math.min(21, body.layout)) : settings.layout;
    if (layout < settings.layout) {
      const speakers = await speakersOf(ctx, room.roomName);
      if (speakers.length > layout - 1) throw new ApiError(409, 'Remove a guest from the stage before reducing the number of guest seats.');
    }
    const flag = (key) => typeof body[key] === 'boolean' ? body[key] : settings[key];
    return update({
      layout,
      admission: ADMISSIONS.includes(body.admission) ? body.admission : settings.admission,
      layoutStyle: typeof body.layoutStyle === 'string' && /^[a-z-]{3,30}$/.test(body.layoutStyle) ? body.layoutStyle : settings.layoutStyle,
      hostPosition: body.hostPosition === 'end' || body.hostPosition === 'start' ? body.hostPosition : settings.hostPosition,
      mobileLayout: body.mobileLayout === 'compact' || body.mobileLayout === 'stack' ? body.mobileLayout : settings.mobileLayout,
      featuredId: body.featuredId === null ? null : isUuid(body.featuredId) ? body.featuredId : settings.featuredId,
      order: Array.isArray(body.order) ? body.order.filter(isUuid).slice(0, 21) : settings.order || [],
      comments: COMMENT_MODES.includes(body.comments) ? body.comments : settings.comments,
      slowMode: SLOW_MODES.includes(body.slowMode) ? body.slowMode : settings.slowMode,
      filterWords: body.filterWords !== undefined ? cleanWords(body.filterWords) : settings.filterWords,
      filterLinks: flag('filterLinks'),
      giftsEnabled: flag('giftsEnabled'),
      likesEnabled: flag('likesEnabled'),
      showViewerCount: flag('showViewerCount'),
      allowRequests: flag('allowRequests'),
    });
  }

  if (action === 'title') {
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    await ctx.rest(`mw_video_live_sessions?id=eq.${room.record.id}`, { method: 'PATCH', body: { title } });
    return { ok: true, title };
  }

  if (action === 'delete-message') {
    const id = requireUuid(body.id, 'message');
    await ctx.rest(`mw_live_room_messages?id=eq.${id}&room_name=eq.${enc(room.roomName)}`, { method: 'PATCH', body: { deleted: true } });
    if (settings.pinned?.id === id) await update({ pinned: null });
    return { ok: true };
  }

  if (action === 'end') {
    await ctx.rest(`mw_video_live_sessions?id=eq.${room.record.id}`, { method: 'PATCH', body: { is_live: false, ended_at: new Date().toISOString() } });
    await livekit('DeleteRoom', room.roomName, {}).catch(() => {});
    return { ok: true };
  }

  throw new ApiError(400, 'Unsupported room action.');
}

export default route({ '': handle });

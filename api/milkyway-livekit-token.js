// LiveKit token endpoint.
// LIVE rooms (mw-video-live-… / mw-audio-live-…): when LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set,
// tokens are signed right here with the same credentials the Live room API uses for guest seats and moderation.
// Everything else (calls, conversation rooms) and sites without those settings go through the Supabase
// livekit-token Edge Function as before.
import { authenticate } from './_lib/supa.js';
import { livekitConfigured, livekitUrl, accessToken, CAMERA, MIC } from './_lib/livekit.js';

const DEFAULT_SUPABASE_URL = 'https://wpclkhgizbvxuvbhbwzs.supabase.co';

function getSupabaseConfig(req) {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/$/, '');
  const apiKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    req.headers.apikey ||
    'sb_publishable_GCFJ3Is8t8mdia4gLeHApg_M_3ez9xb'
  ).trim();
  return { url, apiKey };
}

const LIVE_ROOM = /^mw-(audio|video)-live-[a-f0-9-]{36}$/i;

async function removedFromLive(url, apiKey, authorization, body) {
  const room = typeof body?.room === 'string' ? body.room : typeof body?.roomName === 'string' ? body.roomName : '';
  if (body?.role !== 'viewer' || !LIVE_ROOM.test(room) || !authorization || !/^Bearer\s+\S+$/i.test(authorization)) return false;
  const headers = { apikey: apiKey, Authorization: authorization, Accept: 'application/json' };
  try {
    const [user, rows] = await Promise.all([
      fetch(`${url}/auth/v1/user`, { headers, signal: AbortSignal.timeout(5000) }).then(r => (r.ok ? r.json() : null)),
      fetch(`${url}/rest/v1/mw_live_room_settings?room_name=eq.${encodeURIComponent(room)}&select=settings&limit=1`, { headers, signal: AbortSignal.timeout(5000) }).then(r => (r.ok ? r.json() : [])),
    ]);
    const blocked = rows?.[0]?.settings?.blockedIds;
    return !!user?.id && Array.isArray(blocked) && blocked.includes(String(user.id).toLowerCase());
  } catch { return false; } // the host's app also disconnects removed viewers, so a lookup failure never blocks everyone
}

// Signs a LIVE room token here. Same rules as the Edge Function: only the host may broadcast, followers-only Lives
// need a follow, removed people are refused. Guests already seated on stage get their publish rights back on rejoin.
async function liveToken(req, res, body) {
  const ctx = await authenticate(req, res);
  if (!ctx) return;
  const me = ctx.user.id;
  const room = typeof body.room === 'string' ? body.room : body.roomName;
  if (body.identity && String(body.identity) !== me) return res.status(403).json({ error: 'Identity does not match the signed-in account.' });
  const role = body.role === 'host' ? 'host' : 'viewer';
  const enc = encodeURIComponent;
  try {
    const [[record], [settingsRow], [member], [profile]] = await Promise.all([
      ctx.rest(`mw_video_live_sessions?room_name=eq.${enc(room)}&select=host_id,scope,is_live&limit=1`).then(rows => rows || []),
      ctx.rest(`mw_live_room_settings?room_name=eq.${enc(room)}&select=settings&limit=1`).then(rows => rows || []).catch(() => []),
      ctx.rest(`mw_live_room_members?room_name=eq.${enc(room)}&user_id=eq.${me}&select=state,host_muted&limit=1`).then(rows => rows || []).catch(() => []),
      ctx.rest(`mw_profiles?id=eq.${me}&select=display_name,username,avatar_url&limit=1`).then(rows => rows || []).catch(() => []),
    ]);
    if (!record?.is_live) return res.status(404).json({ error: 'This Live session is no longer available.' });
    const isHost = record.host_id === me;
    if (role === 'host' && !isHost) return res.status(403).json({ error: 'Only the host can broadcast.' });
    if (!isHost) {
      const blocked = settingsRow?.settings?.blockedIds;
      if (Array.isArray(blocked) && blocked.includes(me.toLowerCase())) return res.status(403).json({ error: 'The host removed you from this LIVE.' });
      if (record.scope === 'followers') {
        const follows = await ctx.rest(`mw_follows?follower_id=eq.${me}&following_id=eq.${record.host_id}&select=follower_id&limit=1`).catch(() => []);
        if (!follows?.length) return res.status(403).json({ error: 'This session is for followers only.' });
      }
    }
    const audio = /^mw-audio-/i.test(room);
    const seated = !isHost && member?.state === 'speaker';
    const sources = isHost || seated ? (audio ? (seated && member.host_muted ? [] : [MIC]) : (seated && member.host_muted ? [CAMERA] : [CAMERA, MIC])) : [];
    const name = String(profile?.display_name || profile?.username || body.name || 'MilkyWay user').slice(0, 80);
    const token = accessToken({
      identity: me, name, room, canPublish: sources.length > 0, sources,
      metadata: JSON.stringify({ avatar: String(profile?.avatar_url || '').slice(0, 500) }),
    });
    return res.status(200).json({ contractVersion: 2, token, serverUrl: livekitUrl(), roomName: room, room, service: 'netlify' });
  } catch (error) {
    return res.status(error?.status && error.status < 500 ? error.status : 503).json({ error: error?.message || 'LIVE service is unavailable right now.' });
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'POST' && livekitConfigured() && /^wss:\/\//i.test(livekitUrl()) && req.body && typeof req.body === 'object') {
    const room = typeof req.body.room === 'string' ? req.body.room : typeof req.body.roomName === 'string' ? req.body.roomName : '';
    if (LIVE_ROOM.test(room) && (req.body.action || 'token') === 'token') return liveToken(req, res, req.body);
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const { url, apiKey } = getSupabaseConfig(req);
  if (!url || !apiKey) {
    return res.status(503).json({
      available: false,
      reason: 'supabase_gateway_not_configured',
      error: 'Supabase URL or publishable/anon key is missing from the Vercel gateway.'
    });
  }

  const headers = { apikey: apiKey, Accept: 'application/json' };
  const authorization = req.headers.authorization;
  if (authorization && /^Bearer\s+\S+$/i.test(authorization)) headers.Authorization = authorization;

  const options = { method: req.method, headers, signal: AbortSignal.timeout(15000) };
  if (req.method === 'POST') {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid request body.' });
    }
    const serialized = JSON.stringify(body);
    if (serialized.length > 4096) return res.status(413).json({ error: 'Request too large.' });
    headers['Content-Type'] = 'application/json';
    options.body = serialized;
  }

  // People the host removed from a LIVE cannot get a new viewer token for that room.
  if (req.method === 'POST' && await removedFromLive(url, apiKey, authorization, req.body)) {
    return res.status(403).json({ error: 'The host removed you from this LIVE.' });
  }

  try {
    const upstream = await fetch(`${url}/functions/v1/livekit-token`, options);
    const text = await upstream.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(upstream.ok ? 502 : upstream.status).json({ error: 'Supabase LiveKit function returned an invalid response.' });
    }
    // A successful token reply must carry everything the client needs to connect.
    const tokenReply = upstream.ok && payload.token !== undefined;
    if (tokenReply && (typeof payload.token !== 'string' || !payload.token.trim() || typeof payload.serverUrl !== 'string' || !payload.serverUrl.trim())) {
      return res.status(502).json({ error: 'Supabase LiveKit function did not return a token and LiveKit server URL.' });
    }
    return res.status(upstream.status).json(payload);
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return res.status(503).json({
      available: false,
      reason: timedOut ? 'supabase_timeout' : 'supabase_unreachable',
      error: 'Vercel could not reach the Supabase livekit-token function. Check its deployment and Supabase availability.'
    });
  }
}

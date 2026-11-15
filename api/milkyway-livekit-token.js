// Vercel gateway for the existing Supabase LiveKit Edge Function.
// Keep this endpoint in JavaScript so the known-good Vercel build does not
// need to compile TypeScript API handlers.
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

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

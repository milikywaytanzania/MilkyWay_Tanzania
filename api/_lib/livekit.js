// LiveKit helpers shared by the Live room API and the token endpoint. Tokens and room-admin calls are signed with the
// same server credentials (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET), so permissions granted by the host
// (guest seats, mic mutes, removals) always apply to the room the viewers actually joined.
import { createHmac, randomUUID } from 'node:crypto';
import { ApiError } from './supa.js';

const env = name => (process.env[name] || '').trim();
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export const CAMERA = 1, MIC = 2;
const SOURCE_NAMES = { [CAMERA]: 'camera', [MIC]: 'microphone' };

export const livekitConfigured = () => !!(env('LIVEKIT_URL') && env('LIVEKIT_API_KEY') && env('LIVEKIT_API_SECRET'));
// Clients connect over WebSocket; an https:// project URL (as copied from the LiveKit dashboard) means the same host.
export const livekitUrl = () => env('LIVEKIT_URL').replace(/\/+$/, '').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');

function sign(claims) {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', env('LIVEKIT_API_SECRET')).update(head).digest('base64url')}`;
}

/** Calls the LiveKit RoomService (Twirp). Returns null when the room or participant is not connected right now. */
export async function livekit(method, room, body = {}, grant = null) {
  if (!livekitConfigured()) throw new ApiError(503, 'LiveKit is not configured on the server (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).');
  const now = Math.floor(Date.now() / 1000);
  const jwt = sign({ iss: env('LIVEKIT_API_KEY'), sub: 'milkyway-server', nbf: now - 5, exp: now + 60, video: grant || { roomAdmin: true, room } });
  const origin = livekitUrl().replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  let result;
  try {
    result = await fetch(`${origin}/twirp/livekit.RoomService/${method}`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(room ? { room, ...body } : body), signal: AbortSignal.timeout(8000),
    });
  } catch { throw new ApiError(503, 'LiveKit is unreachable.'); }
  const data = await result.json().catch(() => ({}));
  if (result.status === 404) return null;
  if (!result.ok) throw new ApiError(503, data?.msg || 'LiveKit rejected the request.');
  return data;
}

// Whether LiveKit accepts this server's key/secret for LIVEKIT_URL. A key from another LiveKit project (or a stale
// secret) still signs tokens, but every client then fails with "could not establish signal connection: invalid API
// key". Checked with one cheap RoomService call and remembered for a few minutes per server instance.
let credentialCheck = { at: 0, ok: true, reason: '' };
export async function livekitUsable() {
  if (!livekitConfigured() || !/^wss?:\/\//i.test(livekitUrl())) return false;
  const age = Date.now() - credentialCheck.at;
  if (credentialCheck.at && age < (credentialCheck.ok ? 5 * 60_000 : 60_000)) return credentialCheck.ok;
  const now = Math.floor(Date.now() / 1000);
  const jwt = sign({ iss: env('LIVEKIT_API_KEY'), sub: 'milkyway-server', nbf: now - 5, exp: now + 60, video: { roomList: true } });
  const origin = livekitUrl().replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  try {
    const result = await fetch(`${origin}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: ['milkyway-credential-check'] }), signal: AbortSignal.timeout(5000),
    });
    // Only a clear refusal of the credentials disables local signing; an outage is not a key problem.
    const rejected = result.status === 401 || result.status === 403;
    credentialCheck = { at: Date.now(), ok: !rejected, reason: rejected ? 'LiveKit rejected LIVEKIT_API_KEY / LIVEKIT_API_SECRET for LIVEKIT_URL.' : '' };
  } catch {
    credentialCheck = { at: Date.now() - 4 * 60_000, ok: true, reason: 'LiveKit was unreachable during the credential check.' };
  }
  return credentialCheck.ok;
}
export const livekitCredentialStatus = () => ({ ...credentialCheck });

/** Signs a participant access token for one room. `sources` are CAMERA / MIC numbers. */
export function accessToken({ identity, name = '', metadata = '', room, canPublish = false, sources = [], ttlSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: env('LIVEKIT_API_KEY'), sub: identity, name: String(name || 'MilkyWay user').slice(0, 80), metadata, jti: randomUUID(),
    nbf: now - 5, exp: now + ttlSeconds,
    video: {
      room, roomJoin: true, canSubscribe: true, canPublishData: true, canPublish,
      canPublishSources: canPublish ? sources.map(source => SOURCE_NAMES[source]).filter(Boolean) : [],
    },
  });
}

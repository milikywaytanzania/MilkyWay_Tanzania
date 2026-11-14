// Network + session layer.
//  - The signed-in session is read synchronously from localStorage at startup (same key supabase-js uses, so the
//    classic app and this shell share one login). No network call is needed to know who the user is.
//  - supabase-js is only loaded when idle or when a token must be refreshed / realtime is needed.
//  - api() and rest() are thin fetch wrappers with timeouts, auth, one retry after a token refresh,
//    and online/offline tracking that the sync engine listens to.
import { config } from '../config.js';
import { bus, idle } from './events.js';
import { loadSupabase } from './sdk.js';

const projectRef = new URL(config.supabase.url).hostname.split('.')[0];
const SESSION_KEY = `sb-${projectRef}-auth-token`;

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const session = value?.currentSession || value;
    return session?.access_token && session?.user?.id ? session : null;
  } catch { return null; }
}

let session = readStoredSession();
let client = null;
let clientPromise = null;

export const auth = {
  get user() { return session?.user || null; },
  get userId() { return session?.user?.id || null; },
  get name() {
    const meta = session?.user?.user_metadata || {};
    return meta.display_name || meta.full_name || session?.user?.email?.split('@')[0] || 'Guest';
  },
  signedIn: () => Boolean(session?.user?.id),
};

/** The shared supabase-js client (lazy). Keeps `session` in sync and announces auth changes. */
export function supabase() {
  if (client) return Promise.resolve(client);
  clientPromise ||= loadSupabase().then(sdk => {
    client = sdk.createClient(config.supabase.url, config.supabase.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    client.auth.onAuthStateChange((event, next) => {
      const before = session?.user?.id || null;
      session = next || null;
      if ((next?.user?.id || null) !== before || event === 'SIGNED_OUT') bus.emit('auth', auth.user);
    });
    return client;
  }).catch(error => { clientPromise = null; throw error; });
  return clientPromise;
}

// Other tabs (or the classic app) signing in/out.
addEventListener('storage', event => {
  if (event.key !== SESSION_KEY) return;
  const before = session?.user?.id || null;
  session = readStoredSession();
  if ((session?.user?.id || null) !== before) bus.emit('auth', auth.user);
});

/** A valid access token, refreshing through supabase-js only when the stored one is about to expire. */
export async function accessToken({ force = false } = {}) {
  if (!session) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!force && session.expires_at && session.expires_at - now > 60) return session.access_token;
  try {
    const sb = await supabase();
    const result = force ? await sb.auth.refreshSession() : await sb.auth.getSession();
    session = result.data?.session || session;
  } catch { /* offline: keep the old token, the server answers 401 and we retry later */ }
  return session?.access_token || null;
}

// ---- Connectivity ---------------------------------------------------------------------------------------------
let online = navigator.onLine !== false;
const setOnline = value => {
  if (value === online) return;
  online = value;
  bus.emit(value ? 'online' : 'offline');
};
addEventListener('online', () => setOnline(true));
addEventListener('offline', () => setOnline(false));
export const isOnline = () => online;

const NETWORK_ERROR = /failed to fetch|networkerror|load failed|network request failed|timeout|aborted/i;
export const isNetworkError = error => error?.name === 'TimeoutError' || error?.name === 'AbortError' || NETWORK_ERROR.test(String(error?.message || ''));

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function send(url, { method = 'GET', body, headers = {}, timeout = 10000, authed = true, signal } = {}, retried = false) {
  const token = authed ? await accessToken() : null;
  const init = {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any?.([signal, AbortSignal.timeout(timeout)]) || signal : AbortSignal.timeout(timeout),
  };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  let response;
  try { response = await fetch(url, init); }
  catch (error) { if (isNetworkError(error)) setOnline(false); throw error; }
  setOnline(true);
  if (response.status === 401 && token && !retried) {
    await accessToken({ force: true });
    return send(url, { method, body, headers, timeout, authed, signal }, true);
  }
  const type = response.headers.get('content-type') || '';
  const data = /json/.test(type) ? await response.json().catch(() => null) : null;
  if (!response.ok) throw new HttpError(response.status, data?.error || data?.message || `HTTP ${response.status}`);
  // A static host answering an API route with its HTML page is "unavailable", not success.
  if (data === null && /html/.test(type)) throw new HttpError(502, 'Service returned an invalid response.');
  return data;
}

/** Site API (/api/…). */
export const api = (path, options) => send(path, options);

/** Supabase PostgREST, as the signed-in user. rest('mw_signals', { method:'POST', body:{…} }) */
export const rest = (path, { prefer = 'return=minimal', ...options } = {}) =>
  send(`${config.supabase.url}/rest/v1/${path}`, { ...options, headers: { apikey: config.supabase.anonKey, Prefer: prefer, ...(options.headers || {}) } });

// Warm supabase-js once the app is idle (token refresh + realtime later cost nothing on the critical path).
if (session) idle(() => supabase().catch(() => {}), 4000);

// MilkyWay app configuration — the ONE place to plug in providers.
//
// Only PUBLIC values belong here (they ship to every browser). Secrets — the LiveKit API secret, a Cloudinary API
// secret, the Supabase service-role key — stay server-side as environment variables of the token/API functions.
//
// Any value can be overridden without editing this file by defining `window.MW_CONFIG` before app/main.js runs
// (e.g. an inline script injected by the Android shell, an edge function, or a staging page):
//   <script>window.MW_CONFIG = { livekit: { url: 'wss://my-project.livekit.cloud' }, cloudinary: { cloudName: 'demo' } }</script>

const defaults = {
  supabase: {
    url: 'https://wpclkhgizbvxuvbhbwzs.supabase.co',
    // Publishable (anon) key — safe in the browser; row-level security protects the data.
    anonKey: 'sb_publishable_GCFJ3Is8t8mdia4gLeHApg_M_3ez9xb',
    // UMD bundle, loaded lazily after first paint (never blocks startup).
    sdkUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  },
  livekit: {
    // Leave empty: the token endpoint returns the server URL. Set it to pre-warm the connection earlier.
    url: '',
    tokenEndpoint: '/api/milkyway-livekit-token',
    // Used when the site API is unreachable (e.g. a static mirror).
    directTokenEndpoint: 'https://wpclkhgizbvxuvbhbwzs.supabase.co/functions/v1/livekit-token',
    sdkUrls: [
      'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js',
      'https://unpkg.com/livekit-client@2/dist/livekit-client.umd.js',
    ],
  },
  cloudinary: {
    // Set cloudName to deliver images/posters through Cloudinary fetch (f_auto, q_auto, sized). Empty = off.
    cloudName: '',
    // Unsigned upload preset, for future direct uploads from the composer.
    uploadPreset: '',
  },
  media: {
    // 'auto' → Cloudinary if configured, else Cloudflare Image Resizing on Cloudflare Pages hosts, else original files.
    imageCdn: 'auto',
  },
  api: {
    base: '/api',
    feed: '/api/milkyway-feed',
    liveRoom: '/api/milkyway-live-room',
    wallet: '/api/milkyway-wallet',
    message: '/api/milkyway-message',
  },
  feed: {
    pageSize: 10,
    // Posts kept per feed in IndexedDB for instant, offline startup.
    cacheLimit: 60,
  },
};

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const merge = (base, extra) => {
  if (!isObject(extra)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  return out;
};

export const config = Object.freeze(merge(defaults, globalThis.MW_CONFIG));

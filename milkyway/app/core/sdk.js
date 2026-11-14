// Lazy loaders for third-party SDKs. Nothing here runs at startup: each SDK downloads on first use (or when idle),
// once, with CDN fallbacks — so the first screen never waits for Supabase or LiveKit.
import { config } from '../config.js';

const loaded = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.append(script);
  });
}

async function loadFirst(urls, ready) {
  if (ready()) return ready();
  let lastError;
  for (const url of urls) {
    try { await loadScript(url); if (ready()) return ready(); } catch (error) { lastError = error; }
  }
  throw lastError || new Error('SDK failed to load.');
}

const once = (name, factory) => {
  if (!loaded.has(name)) loaded.set(name, factory().catch(error => { loaded.delete(name); throw error; }));
  return loaded.get(name);
};

export const loadSupabase = () => once('supabase', () => loadFirst([config.supabase.sdkUrl], () => globalThis.supabase?.createClient && globalThis.supabase));
export const loadLiveKit = () => once('livekit', () => loadFirst(config.livekit.sdkUrls, () => globalThis.LivekitClient || globalThis.LiveKitClient));

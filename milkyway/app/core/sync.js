// Local-first sync engine.
//
//   const feed = resource('feed:foryou', () => api(...), { maxAge: 30_000 });
//   feed.subscribe(value => render(value));   // fires at once with the cached copy, then again only if data changed
//   feed.refresh();                           // background revalidation (deduplicated, offline-aware)
//
// Writes made offline go to the IndexedDB outbox and are replayed (in order, idempotently) when the network returns.
import { store, outbox } from './store.js';
import { bus, idle } from './events.js';
import { auth, isOnline, isNetworkError } from './net.js';

/** Cache keys are namespaced by account, so switching accounts never shows someone else's data. */
export const scoped = key => `${auth.userId || 'guest'}:${key}`;

const resources = new Map();
const fingerprint = value => { try { return JSON.stringify(value); } catch { return String(Math.random()); } };

export function resource(key, fetcher, { maxAge = 60_000, scope = true, persist = value => value } = {}) {
  const fullKey = () => (scope ? scoped(key) : key);
  const id = `${scope ? 's' : 'g'}|${key}`;
  if (resources.has(id)) return resources.get(id);

  const subscribers = new Set();
  let value;
  let print = '';
  let inflight = null;
  let loadedKey = null;

  const publish = (next, source) => {
    const nextPrint = fingerprint(next);
    if (nextPrint === print) return;
    value = next;
    print = nextPrint;
    subscribers.forEach(fn => fn(value, source));
  };

  const hydrate = async () => {
    const k = fullKey();
    if (loadedKey === k) return value;
    loadedKey = k;
    const cached = await store.get(k);
    if (cached !== undefined && loadedKey === k) publish(cached, 'cache');
    return cached;
  };

  const api = {
    get value() { return value; },
    subscribe(fn) {
      subscribers.add(fn);
      if (value !== undefined) fn(value, 'memory');
      return () => subscribers.delete(fn);
    },
    /** Cached copy first (instant), then a quiet background refresh when stale. */
    async load() {
      const cached = await hydrate();
      if (cached === undefined || store.age(fullKey()) > maxAge) api.refresh();
      return value;
    },
    refresh() {
      if (inflight) return inflight;
      if (!isOnline() && value !== undefined) return Promise.resolve(value);
      const k = fullKey();
      inflight = Promise.resolve().then(fetcher).then(next => {
        if (k !== fullKey()) return value;
        store.set(k, persist(next));
        publish(next, 'network');
        return next;
      }).catch(error => {
        if (!isNetworkError(error)) console.warn(`[sync] ${key} refresh failed`, error);
        bus.emit('sync-error', { key, error });
        return value;
      }).finally(() => { inflight = null; });
      return inflight;
    },
    /** Optimistic local change: updates memory + device copy and notifies subscribers at once. */
    mutate(update) {
      const next = typeof update === 'function' ? update(value) : update;
      store.set(fullKey(), persist(next));
      publish(next, 'local');
    },
    reset() { value = undefined; print = ''; loadedKey = null; },
  };
  resources.set(id, api);
  return api;
}

// ---- Outbox --------------------------------------------------------------------------------------------------
const handlers = new Map();
/** Registers how a queued operation type is sent, e.g. registerOp('like', op => rest(...)). */
export const registerOp = (type, send) => handlers.set(type, send);

let flushing = false;
export async function flushOutbox() {
  if (flushing || !isOnline()) return;
  flushing = true;
  try {
    const items = (await outbox.all()).sort((a, b) => a.at - b.at);
    for (const item of items) {
      const send = handlers.get(item.type);
      if (!send) continue;
      try { await send(item); await outbox.remove(item.id); }
      catch (error) {
        if (isNetworkError(error)) break;
        // Permanent failures (400/403/409…) are dropped after a few tries so the queue never jams.
        item.tries += 1;
        if (item.tries >= 3 || [400, 403, 404, 409, 422].includes(error.status)) await outbox.remove(item.id);
        else await outbox.update(item);
      }
    }
  } finally { flushing = false; }
}

/** Runs op now when online; queues it durably when offline or when the network fails mid-request. */
export async function perform(type, payload) {
  const op = { type, ...payload };
  const send = handlers.get(type);
  if (isOnline() && send) {
    try { await send(op); return 'sent'; }
    catch (error) { if (!isNetworkError(error)) throw error; }
  }
  await outbox.add(op);
  return 'queued';
}

bus.on('online', () => { flushOutbox(); resources.forEach(resource => resource.value !== undefined && resource.refresh()); });
bus.on('auth', () => resources.forEach(resource => { resource.reset(); }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flushOutbox(); });
idle(() => { flushOutbox(); store.prune(); }, 5000);

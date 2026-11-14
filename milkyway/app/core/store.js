// Local-first device storage on IndexedDB.
//  - Reads hit an in-memory mirror first, so repeated reads are synchronous-fast.
//  - Writes are coalesced into one transaction per frame (no write storms while scrolling).
//  - Without IndexedDB (private mode, very old WebView) everything keeps working in memory only.
const DB_NAME = 'milkyway-core';
const VERSION = 1;
const KV = 'kv';
const OUTBOX = 'outbox';
const MAX_ENTRIES = 500;
const MAX_AGE = 21 * 24 * 60 * 60 * 1000;

let dbPromise = null;
const memory = new Map();
const pending = new Map();
let flushScheduled = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let request;
    try { request = indexedDB.open(DB_NAME, VERSION); } catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV, { keyPath: 'k' }).createIndex('t', 't');
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => { flushScheduled = false; flush(); };
  if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') requestAnimationFrame(() => setTimeout(run, 0));
  else setTimeout(run, 16);
}

async function flush() {
  if (!pending.size) return;
  const batch = [...pending];
  pending.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(KV, 'readwrite');
    const store = tx.objectStore(KV);
    for (const [k, entry] of batch) entry === null ? store.delete(k) : store.put(entry);
  } catch (error) { console.warn('[store] write failed', error); }
}

export const store = {
  /** Returns the saved value (or undefined). Memory first, then IndexedDB. */
  async get(key) {
    if (memory.has(key)) return memory.get(key).v;
    const db = await openDb();
    if (!db) return undefined;
    try {
      const entry = await done(db.transaction(KV).objectStore(KV).get(key));
      if (!entry) return undefined;
      memory.set(key, entry);
      return entry.v;
    } catch { return undefined; }
  },
  /** Age of a saved entry in ms (Infinity if missing). */
  age(key) {
    const entry = memory.get(key);
    return entry ? Date.now() - entry.t : Infinity;
  },
  set(key, value) {
    const entry = { k: key, v: value, t: Date.now() };
    memory.set(key, entry);
    pending.set(key, entry);
    scheduleFlush();
  },
  delete(key) {
    memory.delete(key);
    pending.set(key, null);
    scheduleFlush();
  },
  /** Removes every key starting with prefix (e.g. on sign-out: the account namespace). */
  async clearPrefix(prefix) {
    for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
    const db = await openDb();
    if (!db) return;
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    db.transaction(KV, 'readwrite').objectStore(KV).delete(range);
  },
  /** Drops entries older than MAX_AGE and keeps at most MAX_ENTRIES (oldest first). Run when idle. */
  async prune() {
    const db = await openDb();
    if (!db) return;
    try {
      // Primary keys ordered by save time, oldest first.
      const keys = await done(db.transaction(KV).objectStore(KV).index('t').getAllKeys());
      const old = await done(db.transaction(KV).objectStore(KV).index('t').getAllKeys(IDBKeyRange.upperBound(Date.now() - MAX_AGE)));
      const excess = Math.max(0, keys.length - MAX_ENTRIES);
      const victims = new Set([...old, ...keys.slice(0, excess)]);
      if (!victims.size) return;
      const write = db.transaction(KV, 'readwrite').objectStore(KV);
      victims.forEach(key => { write.delete(key); memory.delete(key); });
    } catch (error) { console.warn('[store] prune failed', error); }
  },
};

// Durable queue of writes made offline (likes, comments). Flushed by sync.js when the network returns.
const memoryOutbox = new Map();
export const outbox = {
  async add(op) {
    const item = { id: op.id || crypto.randomUUID(), at: Date.now(), tries: 0, ...op };
    memoryOutbox.set(item.id, item);
    const db = await openDb();
    if (db) db.transaction(OUTBOX, 'readwrite').objectStore(OUTBOX).put(item);
    return item;
  },
  async all() {
    const db = await openDb();
    if (!db) return [...memoryOutbox.values()];
    try { return await done(db.transaction(OUTBOX).objectStore(OUTBOX).getAll()); } catch { return [...memoryOutbox.values()]; }
  },
  async remove(id) {
    memoryOutbox.delete(id);
    const db = await openDb();
    if (db) db.transaction(OUTBOX, 'readwrite').objectStore(OUTBOX).delete(id);
  },
  async update(item) {
    memoryOutbox.set(item.id, item);
    const db = await openDb();
    if (db) db.transaction(OUTBOX, 'readwrite').objectStore(OUTBOX).put(item);
  },
};

// Start opening the database immediately so the first cached read is ready by the time the shell paints.
openDb();

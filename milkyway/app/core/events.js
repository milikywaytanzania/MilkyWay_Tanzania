// Tiny typed-by-convention event bus shared by every module (no framework, no allocations on emit).
const listeners = new Map();

export const bus = {
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  },
  emit(type, detail) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(detail); } catch (error) { console.error(`[bus] ${type} listener failed`, error); }
    }
  },
};

/** Runs fn when the main thread is idle (falls back to a short timeout). */
export const idle = (fn, timeout = 1500) =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60);

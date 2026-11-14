// VerticalPager — TikTok-style full-screen vertical paging with DOM virtualization.
//
// Only the active slide and `radius` neighbours on each side exist in the DOM (3–5 nodes for any list length).
// Slide elements are recycled: when the user moves on, the slide that falls out of the window is re-bound to the
// item entering it, so scrolling through 10 000 posts allocates no more DOM than scrolling through 5.
//
// Movement is transform-only (GPU composited): the finger drags the track 1:1, release snaps by distance or velocity.
// Wheel, trackpad and keyboard (↑ ↓ / j k / PageUp PageDown) page one item at a time.
//
//   const pager = new VerticalPager(root, { keyOf, create, bind, update, release, onChange, onNearEnd, radius });
//   pager.setItems(items);
const SNAP_MS = 300;
const EASE = 'cubic-bezier(.2,.85,.25,1)';

export class VerticalPager {
  constructor(root, options) {
    this.root = root;
    this.options = { radius: 2, nearEnd: 3, ...options };
    this.items = [];
    this.index = 0;
    this.height = root.clientHeight || innerHeight;
    this.mounted = new Map(); // index → slide element
    this.pool = [];
    this.offset = 0;
    this.animating = false;

    this.track = document.createElement('div');
    this.track.className = 'vp-track';
    root.classList.add('vp');
    root.append(this.track);

    this.#bindGestures();
    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(root);
  }

  get current() { return this.items[this.index]; }
  slideAt(index) { return this.mounted.get(index) || null; }

  /** Replaces the list, keeping the user on the same item when it still exists. */
  setItems(items, { keepKey = true } = {}) {
    const { keyOf } = this.options;
    const activeKey = keepKey && this.current ? keyOf(this.current) : null;
    this.items = items;
    let next = activeKey ? items.findIndex(item => keyOf(item) === activeKey) : 0;
    if (next < 0) next = Math.min(this.index, Math.max(0, items.length - 1));
    this.index = Math.max(0, next);
    this.#render(true);
    this.#place(false);
    // Notify when the item on screen is a different one (also when it changed at the same index).
    const nowKey = this.current ? keyOf(this.current) : null;
    if (nowKey !== activeKey || !activeKey) this.options.onChange?.(this.index, this.current, -1);
  }

  goTo(index, { animate = true } = {}) {
    const target = Math.max(0, Math.min(this.items.length - 1, index));
    if (target === this.index) {
      this.#place(animate);
      if (index > this.index) this.options.onNearEnd?.();
      return;
    }
    const previous = this.index;
    this.index = target;
    this.#render(false);
    this.#place(animate);
    this.options.onChange?.(this.index, this.current, previous);
    if (this.items.length - 1 - this.index <= this.options.nearEnd) this.options.onNearEnd?.();
  }
  next() { this.goTo(this.index + 1); }
  prev() { this.goTo(this.index - 1); }

  destroy() {
    this.resizeObserver.disconnect();
    this.mounted.forEach(slide => this.options.release?.(slide));
    this.track.remove();
    this.abort?.abort();
  }

  // ---- Rendering -------------------------------------------------------------------------------------------
  #render(rebind) {
    const { radius, keyOf, create, bind, update, release } = this.options;
    const from = Math.max(0, this.index - radius);
    const to = Math.min(this.items.length - 1, this.index + radius);
    // Recycle slides that left the window.
    for (const [index, slide] of this.mounted) {
      if (index >= from && index <= to) continue;
      release?.(slide);
      this.mounted.delete(index);
      slide.remove();
      this.pool.push(slide);
    }
    for (let index = from; index <= to; index++) {
      const item = this.items[index];
      let slide = this.mounted.get(index);
      if (!slide) {
        slide = this.pool.pop() || create();
        slide.classList.add('vp-slide');
        slide.dataset.key = '';
        this.mounted.set(index, slide);
        this.track.append(slide);
      }
      const key = String(keyOf(item));
      if (slide.dataset.key !== key) { slide.dataset.key = key; bind(slide, item, index); }
      else if (rebind) update?.(slide, item, index);
      slide.dataset.index = String(index);
      slide.dataset.distance = String(index - this.index);
      slide.style.transform = `translate3d(0,${index * this.height}px,0)`;
    }
    this.options.afterRender?.(this.mounted, this.index);
  }

  #place(animate) {
    const y = -this.index * this.height + this.offset;
    this.track.style.transition = animate ? `transform ${SNAP_MS}ms ${EASE}` : 'none';
    this.track.style.transform = `translate3d(0,${y}px,0)`;
    this.animating = animate;
    if (animate) {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => { this.animating = false; this.options.onSettle?.(this.index, this.current); }, SNAP_MS + 20);
    } else this.options.onSettle?.(this.index, this.current);
  }

  #resize() {
    const height = this.root.clientHeight;
    if (!height || height === this.height) return;
    this.height = height;
    this.mounted.forEach((slide, index) => { slide.style.transform = `translate3d(0,${index * height}px,0)`; });
    this.#place(false);
  }

  // ---- Input -----------------------------------------------------------------------------------------------
  #bindGestures() {
    this.abort = new AbortController();
    const { signal } = this.abort;
    const root = this.root;
    let start = null;
    let samples = [];
    let locked = null; // 'y' | 'x'
    let frame = 0;

    const blocked = target => target.closest?.('[data-no-swipe], input, textarea, select');
    const paint = () => {
      frame = 0;
      this.track.style.transform = `translate3d(0,${-this.index * this.height + this.offset}px,0)`;
    };

    root.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (blocked(event.target) || this.items.length < 2) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      samples = [{ y: event.clientY, t: event.timeStamp }];
      locked = null;
    }, { signal, passive: true });

    root.addEventListener('pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!locked) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        locked = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
        if (locked === 'y') {
          root.setPointerCapture?.(event.pointerId);
          this.track.style.transition = 'none';
          root.classList.add('vp-dragging');
        }
      }
      if (locked !== 'y') return;
      const atEdge = (this.index === 0 && dy > 0) || (this.index === this.items.length - 1 && dy < 0);
      this.offset = atEdge ? dy * 0.28 : dy; // rubber band at the ends
      samples.push({ y: event.clientY, t: event.timeStamp });
      if (samples.length > 6) samples.shift();
      if (!frame) frame = requestAnimationFrame(paint);
    }, { signal, passive: true });

    const end = event => {
      if (!start || event.pointerId !== start.id) return;
      const wasDrag = locked === 'y';
      start = null;
      root.classList.remove('vp-dragging');
      if (!wasDrag) return;
      cancelAnimationFrame(frame); frame = 0;
      const first = samples[0], last = samples[samples.length - 1];
      const velocity = last && first && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0; // px/ms
      const distance = this.offset;
      this.offset = 0;
      // Swallow the click that may follow a drag so buttons under the finger don't fire.
      const swallow = e => { e.stopImmediatePropagation(); e.preventDefault(); };
      root.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => root.removeEventListener('click', swallow, { capture: true }), 60);
      if (distance < -this.height * 0.18 || velocity < -0.45) this.goTo(this.index + 1);
      else if (distance > this.height * 0.18 || velocity > 0.45) this.goTo(this.index - 1);
      else this.#place(true);
    };
    root.addEventListener('pointerup', end, { signal });
    root.addEventListener('pointercancel', end, { signal });

    // Wheel / trackpad: one item per gesture (inertia is ignored until the wheel goes quiet).
    let wheelSum = 0, wheelLock = false, wheelQuiet = 0;
    root.addEventListener('wheel', event => {
      if (blocked(event.target)) return;
      event.preventDefault();
      clearTimeout(wheelQuiet);
      wheelQuiet = setTimeout(() => { wheelLock = false; wheelSum = 0; }, 180);
      if (wheelLock) return;
      wheelSum += event.deltaY;
      if (Math.abs(wheelSum) > 45) { wheelLock = true; this.goTo(this.index + Math.sign(wheelSum)); wheelSum = 0; }
    }, { signal, passive: false });

    document.addEventListener('keydown', event => {
      if (blocked(event.target) || event.defaultPrevented || !(root.checkVisibility?.() ?? root.offsetParent !== null)) return;
      if (event.target.closest?.('.sheet-layer')) return;
      const step = { ArrowDown: 1, PageDown: 1, j: 1, ArrowUp: -1, PageUp: -1, k: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      this.goTo(this.index + step);
    }, { signal });
  }
}

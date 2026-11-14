// Playback manager — IntersectionObserver-driven autoplay.
//  - A video plays when ≥ 60 % of it is on screen, and pauses the instant it drops below (no scroll listeners).
//  - Leaving the screen rewinds it, so coming back starts from the top like TikTok.
//  - Bandwidth: sources are attached only near the viewport (see `source()`); far videos have no src at all.
//  - The tab going to the background pauses everything; coming back resumes the visible one.
//  - Sound: autoplay starts muted (browser policy); one tap anywhere unmutes for the whole session.
const THRESHOLD = 0.6;

class Playback {
  constructor() {
    this.muted = true;
    this.userPaused = new WeakSet();
    this.visible = new Set();
    this.suspended = false;
    this.listeners = new Set();
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const video = entry.target;
        if (entry.intersectionRatio >= THRESHOLD) { this.visible.add(video); this.#play(video); }
        else {
          this.visible.delete(video);
          if (!video.paused) video.pause();
          if (!entry.isIntersecting || entry.intersectionRatio === 0) {
            this.userPaused.delete(video);
            if (video.readyState > 0 && video.currentTime > 0) try { video.currentTime = 0; } catch {}
          }
        }
      }
    }, { threshold: [0, THRESHOLD] });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.visible.forEach(video => video.pause());
      else this.visible.forEach(video => this.#play(video));
    });
  }

  observe(video) { this.observer.observe(video); }
  unobserve(video) { this.observer.unobserve(video); this.visible.delete(video); video.pause(); }

  /** Attaches or detaches a source by distance from the active slide (0 = active, ±1 = neighbours). */
  source(video, url, distance, { saveData = false } = {}) {
    const near = Math.abs(distance) <= 1;
    if (!url || !near) {
      if (video.getAttribute('src')) { video.pause(); video.removeAttribute('src'); video.load(); }
      return;
    }
    // Active: full buffering. Next: warm up (metadata only on Data Saver). Previous: metadata.
    video.preload = distance === 0 ? 'auto' : distance === 1 && !saveData ? 'auto' : 'metadata';
    if (video.getAttribute('src') !== url) { video.src = url; }
    if (this.visible.has(video) && video.paused) this.#play(video);
  }

  /** Pauses everything (e.g. a full-screen Live is on top of the feed). */
  suspend(on) {
    this.suspended = on;
    this.visible.forEach(video => (on ? video.pause() : this.#play(video)));
  }

  toggle(video) {
    if (video.paused) { this.userPaused.delete(video); this.#play(video); return true; }
    this.userPaused.add(video); video.pause(); return false;
  }

  setMuted(muted) {
    this.muted = muted;
    this.visible.forEach(video => { video.muted = muted; });
    this.listeners.forEach(fn => fn(muted));
  }
  onMute(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  #play(video) {
    if (this.suspended || document.visibilityState === 'hidden' || this.userPaused.has(video) || !video.getAttribute('src')) return;
    video.muted = this.muted;
    const attempt = video.play();
    attempt?.catch?.(error => {
      // Sound was blocked: fall back to muted autoplay and show the "tap for sound" hint.
      if (error?.name === 'NotAllowedError' && !video.muted) { this.setMuted(true); video.play().catch(() => {}); }
    });
  }
}

export const playback = new Playback();

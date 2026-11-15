// Bottom sheet: one reusable, accessible overlay (Esc / backdrop / swipe-down to close). Content is built lazily.
import { h } from './dom.js';

export class Sheet {
  constructor({ title = '', className = '', onClose } = {}) {
    this.onClose = onClose;
    this.body = h('div', { class: 'sheet-body' });
    this.heading = h('h2', { class: 'sheet-title' }, title);
    this.panel = h('div', { class: `sheet ${className}`, role: 'dialog', 'aria-modal': 'true', 'data-no-swipe': true },
      h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), this.heading, this.body);
    this.root = h('div', { class: 'sheet-layer', hidden: true },
      h('div', { class: 'sheet-backdrop', onclick: () => this.close() }), this.panel);
    document.body.append(this.root);
    this.root.addEventListener('keydown', event => { if (event.key === 'Escape') this.close(); });
    this.#swipeToClose();
  }
  set title(value) { this.heading.textContent = value; }
  get isOpen() { return !this.root.hidden; }
  open() {
    this.returnFocus = document.activeElement;
    // The newest popup always sits on top of the others (e.g. comments opened from a post or a LIVE panel).
    if (document.body.lastElementChild !== this.root) document.body.append(this.root);
    clearTimeout(this.hideTimer);
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('open'));
    setTimeout(() => this.panel.querySelector('input, textarea, button')?.focus({ preventScroll: true }), 220);
  }
  close() {
    if (this.root.hidden) return;
    this.root.classList.remove('open');
    this.hideTimer = setTimeout(() => { this.root.hidden = true; }, 220);
    this.returnFocus?.focus?.({ preventScroll: true });
    this.onClose?.();
  }
  #swipeToClose() {
    let startY = null;
    const grip = this.panel.querySelector('.sheet-grip');
    grip.addEventListener('pointerdown', event => { startY = event.clientY; grip.setPointerCapture(event.pointerId); });
    grip.addEventListener('pointermove', event => {
      if (startY == null) return;
      this.panel.style.transform = `translateY(${Math.max(0, event.clientY - startY)}px)`;
    });
    grip.addEventListener('pointerup', event => {
      const moved = event.clientY - (startY ?? event.clientY);
      startY = null;
      this.panel.style.transform = '';
      if (moved > 80) this.close();
    });
  }
}

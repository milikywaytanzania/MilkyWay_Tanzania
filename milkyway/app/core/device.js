// Device profile: decides how much work the app does, so low-end phones stay smooth and high-end ones look sharp.
const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
const memory = navigator.deviceMemory || 4;
const cores = navigator.hardwareConcurrency || 4;

export const device = {
  get saveData() { return Boolean(connection?.saveData) || /(^|-)2g$/.test(connection?.effectiveType || ''); },
  get slowNetwork() { return this.saveData || /^3g$/.test(connection?.effectiveType || '') || (connection?.downlink && connection.downlink < 1.5); },
  lowEnd: memory <= 2 || cores <= 4 && memory <= 3,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  /** Slides kept mounted on each side of the active one. */
  get windowRadius() { return this.lowEnd || this.saveData ? 1 : 2; },
  /** Image width to request for a full-screen slide. */
  get mediaWidth() {
    const dpr = Math.min(devicePixelRatio || 1, this.lowEnd || this.slowNetwork ? 1.5 : 2.5);
    return Math.min(1440, Math.ceil((innerWidth * dpr) / 120) * 120);
  },
};
connection?.addEventListener?.('change', () => document.documentElement.toggleAttribute('data-save-data', device.saveData));
document.documentElement.toggleAttribute('data-low-end', device.lowEnd);

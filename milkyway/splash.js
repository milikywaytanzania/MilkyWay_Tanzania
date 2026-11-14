// MilkyWay startup splash: keeps the official galaxy artwork on screen while the app opens, then fades it out.
// Shown once per app session (a fresh launch or a new tab); moving between MilkyWay pages in the same session skips it.
(() => {
  const KEY = 'mw_splash_seen';
  const MIN_MS = 1500;  // long enough to read "FREEDOM. TRUTH. LIGHT." without feeling slow
  const MAX_MS = 5000;  // never hold the app back on slow networks
  const splash = document.getElementById('mwSplash');
  if (!splash) return;
  if (document.documentElement.hasAttribute('data-splash-seen')) { splash.remove(); return; }
  let done = false;
  const hide = () => {
    if (done) return;
    done = true;
    try { sessionStorage.setItem(KEY, '1'); } catch {}
    splash.classList.add('is-done');
    splash.setAttribute('aria-hidden', 'true');
    setTimeout(() => splash.remove(), 700);
    window.dispatchEvent(new Event('mw-splash-hidden'));
  };
  const elapsed = () => performance.now();
  const hideAfterMinimum = () => setTimeout(hide, Math.max(0, MIN_MS - elapsed()));
  if (document.readyState === 'complete') hideAfterMinimum();
  else window.addEventListener('load', hideAfterMinimum, { once: true });
  setTimeout(hide, Math.max(0, MAX_MS - elapsed()));
  // A tap skips the splash once the artwork has appeared.
  splash.addEventListener('pointerdown', () => { if (elapsed() > 600) hide(); });
})();

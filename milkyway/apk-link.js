// Points every "APK" download button at the newest MilkyWay build, taken from download/version.json.
// The deployed version.json names a file that carries the version (see tools/build-cloudflare.mjs), so a
// browser, proxy or download manager that kept an older copy can never hand it out again.
(() => {
  const links = document.querySelectorAll('#appDownload, #mwApkLink, a[data-mw-apk]');
  if (!links.length) return;
  // Resolved from this script's own folder (/milkyway/), whichever page loads it.
  const base = new URL('.', document.currentScript?.src || new URL('/milkyway/apk-link.js', location.href));
  fetch(new URL('download/version.json', base), { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(latest => {
      if (!latest || !latest.versionCode) return;
      const url = new URL(String(latest.apk || latest.url || 'download/MilkyWay.apk'), base);
      if (url.origin !== location.origin) return;
      url.searchParams.set('v', latest.versionCode);
      links.forEach(link => { link.href = url.pathname + url.search; });
    })
    .catch(() => {});
})();

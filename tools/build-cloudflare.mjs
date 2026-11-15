// Builds the static site for Cloudflare Pages into dist/. Mirrors what server.js exposes: only public web assets,
// never SQL, notes, sources or tooling. The /api routes are served by functions/api/_middleware.js.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const blocked = /\.(sql|bak|md|txt|map|gradle|java|ts)$/i;
const maxBytes = 25 * 1024 * 1024; // Cloudflare Pages per-file limit

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const filter = source => {
  if (blocked.test(source)) return false;
  const info = statSync(source);
  if (info.isFile() && info.size > maxBytes) { console.warn(`Skipped ${source} (over 25 MB).`); return false; }
  return true;
};

for (const file of ['index.html', 'sw.js', 'sw-cache.js', 'manifest.webmanifest', 'placeholder.svg', 'careers.html', 'media.html', 'sanaa.html', 'admin.html', 'privacy.html', 'account-deletion.html']) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(out, file));
}
for (const folder of ['img', 'slides', 'milkyway']) {
  if (existsSync(join(root, folder))) cpSync(join(root, folder), join(out, folder), { recursive: true, filter });
}

// The APK is also published under a name that carries its version. Download managers resume interrupted
// downloads with byte ranges; a versioned file never changes underneath them, so a resumed download can't
// mix two builds, and browsers or proxies holding an older MilkyWay.apk can never hand it out again.
const downloads = join(out, 'milkyway', 'download');
const release = JSON.parse(readFileSync(join(downloads, 'version.json'), 'utf8'));
if (!Number.isInteger(release.versionCode) || !existsSync(join(downloads, 'MilkyWay.apk'))) throw new Error('milkyway/download needs MilkyWay.apk and a valid version.json.');
const publicDownloads = join(out, 'download');
mkdirSync(publicDownloads, { recursive: true });
copyFileSync(join(downloads, 'MilkyWay.apk'), join(publicDownloads, 'MilkyWay.apk'));
copyFileSync(join(downloads, 'MilkyWay.apk'), join(out, 'MilkyWay.apk'));
const versionedApk = `MilkyWay-${release.versionCode}.apk`;
copyFileSync(join(downloads, 'MilkyWay.apk'), join(downloads, versionedApk));
writeFileSync(join(downloads, 'version.json'), `${JSON.stringify({ ...release, apk: `/milkyway/download/${versionedApk}` }, null, 2)}\n`);

// Pages from the old MilkyWay app were removed. Saved links, bookmarks and old notifications that still
// point at them open the new app instead of an error page.
writeFileSync(join(out, '_redirects'), [
  '/milkyway/classic.html /milkyway/ 301',
  '/milkyway/classic /milkyway/ 301',
  '/milkyway/classic/* /milkyway/ 301',
  '/account.html /milkyway/ 301',
  '/account /milkyway/ 301',
  '/portal.html / 301',
  '/portal / 301',
  '',
].join('\n'));

// Same response headers server.js sets. LIVE needs the camera and microphone on this origin.
writeFileSync(join(out, '_headers'), `/*
  Permissions-Policy: camera=(self), microphone=(self), autoplay=(self), fullscreen=(self), geolocation=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/*.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/sw-cache.js
  Cache-Control: no-cache
/*.webmanifest
  Cache-Control: no-cache
/milkyway/app/*
  Cache-Control: public, max-age=0, must-revalidate
/milkyway/download/version.json
  Cache-Control: no-cache
/MilkyWay.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment; filename="MilkyWay.apk"
  Accept-Ranges: bytes
  Cache-Control: no-cache, no-transform
/milkyway/download/MilkyWay.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment; filename="MilkyWay.apk"
  Accept-Ranges: bytes
  Cache-Control: public, max-age=0, must-revalidate, no-transform
/milkyway/download/MilkyWay-*.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment; filename="MilkyWay.apk"
  Accept-Ranges: bytes
  Cache-Control: public, max-age=31536000, immutable, no-transform
`);
// The same build also deploys on Netlify: there, pictures are resized by Netlify Image CDN instead of
// Cloudflare Image Resizing (which only exists on Cloudflare hosts).
if (process.env.NETLIFY === 'true') {
  const appConfig = join(out, 'milkyway', 'app', 'config.js');
  writeFileSync(appConfig, readFileSync(appConfig, 'utf8').replace("imageCdn: 'auto'", "imageCdn: 'netlify'"));
}
console.log(`${process.env.NETLIFY === 'true' ? 'Netlify' : 'Cloudflare Pages'} build written to dist/.`);

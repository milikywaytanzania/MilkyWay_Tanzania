# MilkyWay brand assets

All assets come from the official MilkyWay logo (blue and gold spiral galaxy, "MilkyWay — FREEDOM. TRUTH. LIGHT."), taken from the supplied design reference. The starry background was keyed out; the emblem, colours, wordmark and tagline are unchanged.

| File | Use |
| --- | --- |
| `milkyway-logo.png` | Master transparent logo (276×360, full quality). |
| `milkyway-logo-web.png` | Optimized transparent logo for in-app placements (sign-in screen). |
| `milkyway-watermark.png` | Previous low-resolution watermark (kept for older cached pages). |
| `milkyway-watermark-galaxy.webp` | Universal watermark: the official spiral emblem and wordmark keyed out of the 2K master logo (300 px, transparent). |
| `milkyway-splash.webp`, `milkyway-splash.jpg` | Official startup splash artwork (vertical galaxy, "FREEDOM. TRUTH. LIGHT."). The WebP is used in the app; the JPG is the 1125×2000 master. |
| `milkyway-emblem.png` | Transparent spiral emblem without the wordmark. |
| `milkyway-emblem-96.png` | Toolbar emblem. |
| `favicon-16.png`, `favicon-32.png`, `../favicon.ico` | MilkyWay favicons. |
| `../icon-180.png` … `../icon-512.png`, `../icon-square-source.png` | App and PWA icons (logo on the galaxy plate, maskable-safe padding). |

The source in the reference sheet is only about 280 px wide, so the large icons are slightly upscaled. If a high-resolution master logo is available, regenerate these files from it at the same names and sizes.

## Splash screen

- `../splash.css` + `../splash.js` show the splash artwork full screen while the app opens (both `index.html` and `classic.html`), fading out once the page has loaded (at least 1.5 s, at most 5 s; a tap skips it). It shows once per app session.
- The Android launch theme uses the same artwork (`android/capacitor/app/src/main/res/drawable*/splash.png`); a new APK build is needed for the native splash to change.

## Watermark rules

- The universal watermark (`milkyway-watermark-galaxy.webp`, ~55% opacity) is a display overlay on every image and video post, text post, LIVE video and audio room, LIVE previews in the feed, and audio players inside posts. Uploaded originals are never modified.
- New app: `brandMark()` in `../app/ui/dom.js`. Full app: `premium.js` (feed posts), `../mw-watermark.js` (posts outside the feed, audio in posts) and `../mw-watermark.css` (LIVE stages and previews).
- "Download with watermark" (author's post menu, images only) creates a separate branded JPEG copy in the browser. Exporting branded videos is not implemented.
- The watermark is not applied to DMs, documents, profile pictures, Stories or advertisements.

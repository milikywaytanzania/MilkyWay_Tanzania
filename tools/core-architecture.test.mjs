// Tests for the rebuilt MilkyWay core: the single-request feed API and the non-blocking app shell.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import feed from '../api/milkyway-feed.js';
import livekitToken from '../api/milkyway-livekit-token.js';

const A = '11111111-1111-4111-8111-111111111111'; // public author
const B = '22222222-2222-4222-8222-222222222222'; // private author
const P = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

function fakeSupabase(routes) {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    const match = routes.find(([pattern]) => address.includes(pattern));
    const body = match ? match[1] : [];
    return new Response(JSON.stringify(typeof body === 'function' ? body(address) : body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

async function call(query) {
  let status = 200, payload;
  const res = { headersSent: false, setHeader() { return res; }, status(code) { status = code; return res; }, json(value) { payload = value; res.headersSent = true; return res; } };
  await feed({ method: 'GET', headers: {}, query }, res);
  return { status, payload };
}

test('feed page returns ready-to-render posts with counts and hides private and audience-restricted posts', async () => {
  const rows = [
    { id: P(1), author_id: A, author_name: 'Asha', caption: 'hi', media_url: 'https://x/v.mp4', media_type: 'video', created_at: '2026-11-14T10:00:00Z' },
    { id: P(2), author_id: B, author_name: 'Bo', caption: 'secret', media_url: null, media_type: null, created_at: '2026-11-14T09:00:00Z' },
    { id: P(3), author_id: A, author_name: 'Asha', caption: 'only me', media_url: null, media_type: null, created_at: '2026-11-14T08:00:00Z' },
  ];
  const calls = fakeSupabase([
    ['/rest/v1/mw_posts?', rows],
    ['/rest/v1/mw_profiles?', [{ id: A, display_name: 'Asha K', username: 'asha', avatar_url: 'https://x/a.jpg' }]],
    ['/rpc/mw_privacy_flags', { [B]: { private: true } }],
    ['/rpc/mw_post_audiences', [{ post_id: P(3), owner_id: A, audience: 'only_me', can_see: false }]],
    ['/rest/v1/mw_signals?', [{ post_id: P(1), user_id: 'x' }, { post_id: P(1), user_id: 'y' }]],
    ['/rest/v1/mw_echoes?', [{ post_id: P(1) }]],
  ]);
  const { status, payload } = await call({ action: 'page', limit: '5' });
  assert.equal(status, 200);
  assert.doesNotMatch(calls.find(url => url.includes('/mw_posts?')), /author_id=/, 'the For You page is global, not limited to the caller');
  assert.deepEqual(payload.posts.map(post => post.id), [P(1)]);
  assert.deepEqual(payload.posts[0], {
    id: P(1), author: { id: A, name: 'Asha K', username: 'asha', avatar: 'https://x/a.jpg' }, caption: 'hi',
    media: { url: 'https://x/v.mp4', type: 'video' }, createdAt: '2026-11-14T10:00:00Z', likes: 2, comments: 1, liked: false, saved: false,
  });
  assert.equal(payload.next, null);
  // One posts read, then every lookup in parallel — never per-post requests.
  assert.equal(calls.filter(url => url.includes('/mw_posts?')).length, 1);
});

test('feed cursor resumes right after the last returned post', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: P(i + 1), author_id: A, caption: '', media_url: null, media_type: null, created_at: `2026-11-14T0${9 - i}:00:00Z` }));
  fakeSupabase([['/rest/v1/mw_posts?', rows], ['/rpc/mw_privacy_flags', {}]]);
  const { payload } = await call({ action: 'page', limit: '4', before: '2026-11-15T00:00:00Z' });
  assert.equal(payload.posts.length, 4);
  assert.equal(payload.next, payload.posts[3].createdAt);
});

test('Orbit feed subscribes to global post changes and Supabase publishes mw_posts', () => {
  const feed = readFileSync(new URL('../milkyway/app/data/feed.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261116_milkyway_orbit_feed_realtime.sql', import.meta.url), 'utf8');
  assert.match(feed, /table:\s*'mw_posts'/);
  assert.match(feed, /active\?\.refresh\(\)/);
  assert.match(migration, /alter table public\.mw_posts enable row level security/i);
  assert.match(migration, /grant select on public\.mw_posts to anon, authenticated/i);
  assert.match(migration, /mw_posts_orbit_read/);
  assert.match(migration, /alter publication supabase_realtime add table public\.mw_posts/i);
});

test('LIVE guest stage grants publisher permissions and renders allocated guest seats', () => {
  const roomApi = readFileSync(new URL('../api/milkyway-live-room.js', import.meta.url), 'utf8');
  const tokenApi = readFileSync(new URL('../api/milkyway-livekit-token.js', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const liveControls = readFileSync(new URL('../milkyway/app/ui/live-controls.js', import.meta.url), 'utf8');
  const liveSession = readFileSync(new URL('../milkyway/app/ui/live-session.js', import.meta.url), 'utf8');
  assert.match(roomApi, /setPublish\(room\.roomName, userId, true, room\.audio\)/);
  assert.match(roomApi, /canPublish: sources\.length > 0, canPublishData: true, canPublishSources: sources/);
  assert.match(tokenApi, /body\.stage === true[\s\S]*member\?\.state === 'speaker'/);
  assert.match(tokenApi, /approvedGuest \? \(audio \? \(member\.host_muted \? \[\] : \[MIC\]\) : \(member\.host_muted \? \[CAMERA\] : \[CAMERA, MIC\]\)\)/);
  assert.match(liveView, /const guestSeats = host && settings\.showGuestSlots[\s\S]*data-seat/);
  assert.match(liveControls, /toggleRow\(t\('showGuestSlots'\)/);
  assert.match(liveSession, /adaptiveStream: true,[\s\S]*dynacast: true,[\s\S]*publishDefaults:/);
  assert.match(liveSession, /static warm\(live\)/);
});

test('app shell has no render-blocking scripts and loads the core as a module', () => {
  const html = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
  assert.ok(scripts.length >= 1);
  for (const attrs of scripts) assert.match(attrs, /type="module"/, 'every script is a deferred ES module');
  assert.match(html, /app\/main\.js/);
  assert.doesNotMatch(html, /supabase-js|livekit-client/, 'SDKs load lazily, never from the shell');
});

test('homepage APK download is a native static-file link', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="appDownload" href="\/MilkyWay\.apk" download="MilkyWay\.apk"/);
  assert.doesNotMatch(html, /apk-link\.js/);
  const build = readFileSync(new URL('./build-cloudflare.mjs', import.meta.url), 'utf8');
  assert.match(build, /copyFileSync\(join\(downloads, 'MilkyWay\.apk'\), join\(out, 'MilkyWay\.apk'\)\)/);
  assert.match(build, /\/MilkyWay\.apk\n  Content-Type: application\/vnd\.android\.package-archive\n  Content-Disposition: attachment; filename="MilkyWay\.apk"\n  Accept-Ranges: bytes\n  Cache-Control: no-cache, no-transform/);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/MilkyWay\.apk'.*sendFile/);
  assert.match(server, /'Content-Type': 'application\/vnd\.android\.package-archive'/);
});

test('mobile homepage keeps its content and shows a direct APK download button', () => {
  const homepage = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const serviceWorker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(homepage, /location\.replace\('\/milkyway\//);
  assert.match(homepage, /class="mobile-apk-download" href="\/MilkyWay\.apk" download="MilkyWay\.apk" type="application\/vnd\.android\.package-archive"/);
  assert.match(homepage, /Download Android App \(APK\)/);
  assert.match(homepage, /@media \(max-width: 767px\)[\s\S]*?\.mobile-apk-download\s*\{[^}]*position: fixed/);
  assert.match(serviceWorker, /version: 'v14'/);
});

test('feed sharing uses native share or a short copy toast, and failed media uses an icon fallback', () => {
  const feed = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const live = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  assert.match(feed, /navigator\.share\(\{ title: post\.author\.name/);
  assert.match(feed, /navigator\.clipboard\.writeText\(url\); toast\(t\('linkCopied'\)\)/);
  for (const source of [feed, viewer, live]) assert.doesNotMatch(source, /toast\(url\)/);
  assert.match(feed, /mediaPlaceholder\(t\('imageUnavailable'\)\)/);
  assert.match(feed, /video\.addEventListener\('error'/);
  assert.match(viewer, /video\.addEventListener\('error'/);
  assert.match(viewer, /mediaPlaceholder\(t\('imageUnavailable'\)\)/);
  assert.match(styles, /\.media-missing-icon/);
});

test('public Supabase content uses DOM text nodes and validates media URLs', () => {
  const homepage = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const publicMedia = readFileSync(new URL('../milkyway/public-media.js', import.meta.url), 'utf8');
  const publicArts = readFileSync(new URL('../milkyway/public-arts.js', import.meta.url), 'utf8');
  const artsChat = readFileSync(new URL('../milkyway/public-arts-chat.js', import.meta.url), 'utf8');
  const moderation = readFileSync(new URL('../milkyway/moderation.html', import.meta.url), 'utf8');
  assert.doesNotMatch(homepage, /innerHTML\s*=/);
  for (const source of [publicMedia, publicArts, artsChat]) {
    assert.doesNotMatch(source, /innerHTML\s*=|insertAdjacentHTML/);
    assert.match(source, /textContent/);
  }
  for (const source of [homepage, publicMedia, publicArts]) {
    assert.match(source, /https:/);
    assert.match(source, /safe\w*MediaUrl|safeMediaUrl/);
  }
  assert.doesNotMatch(moderation, /innerHTML\s*=/);
  assert.match(moderation, /textContent/);
});

test('registration, privacy policy and account deletion request are wired', () => {
  const auth = readFileSync(new URL('../milkyway/app/ui/auth-sheet.js', import.meta.url), 'utf8');
  assert.match(auth, /auth\.signUp/);
  assert.match(auth, /emailRedirectTo/);
  assert.match(auth, /passwordMismatch/);
  assert.match(auth, /confirmEmailSent/);
  const policy = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
  const deletion = readFileSync(new URL('../account-deletion.html', import.meta.url), 'utf8');
  assert.match(policy, /account-deletion\.html/);
  assert.match(deletion, /mailto:masiyatunda@gmail\.com/);
  const appSettings = readFileSync(new URL('../milkyway/app/ui/settings-view.js', import.meta.url), 'utf8');
  assert.match(appSettings, /\/privacy\.html/);
  assert.match(appSettings, /\/account-deletion\.html/);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const build = readFileSync(new URL('./build-cloudflare.mjs', import.meta.url), 'utf8');
  for (const page of ['privacy.html', 'account-deletion.html']) {
    assert.ok(server.includes(page), `${page} is served by server.js`);
    assert.ok(build.includes(page), `${page} is included in the static build`);
  }
});

test('LIVE token keeps viewers subscribed until the server records host approval', async () => {
  const hostId = '11111111-1111-4111-8111-111111111111';
  const viewerId = '22222222-2222-4222-8222-222222222222';
  const room = 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const originalFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  let memberState = 'pending';
  process.env.LIVEKIT_URL = 'wss://live.example.test';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret';
  globalThis.fetch = async input => {
    const address = String(input);
    if (address.includes('/twirp/livekit.RoomService/ListRooms')) return new Response('{"rooms":[]}', { status: 200 });
    if (address.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: viewerId }), { status: 200 });
    if (address.includes('/mw_video_live_sessions?')) return new Response(JSON.stringify([{ host_id: hostId, scope: 'public', is_live: true }]), { status: 200 });
    if (address.includes('/mw_live_room_settings?')) return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
    if (address.includes('/mw_live_room_members?')) return new Response(JSON.stringify([{ state: memberState, host_muted: false }]), { status: 200 });
    if (address.includes('/mw_profiles?')) return new Response(JSON.stringify([]), { status: 200 });
    throw new Error(`Unexpected LIVE token request: ${address}`);
  };
  const call = async body => {
    let status = 200, payload;
    const response = { setHeader() { return response; }, status(code) { status = code; return response; }, json(value) { payload = value; return response; } };
    await livekitToken({ method: 'POST', headers: { authorization: 'Bearer test-user-token', apikey: 'test-public-key' }, body: { room, identity: viewerId, role: 'viewer', ...body } }, response);
    assert.equal(status, 200);
    return JSON.parse(Buffer.from(payload.token.split('.')[1], 'base64url').toString('utf8')).video;
  };

  try {
    assert.equal((await call({ stage: true })).canPublish, false, 'a viewer cannot self-promote by requesting a stage token');
    memberState = 'speaker';
    assert.equal((await call({ stage: true })).canPublish, true, 'the server grants publishing only after the member is approved');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('service worker precaches every core module', () => {
  const sw = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  for (const folder of ['core', 'data', 'ui']) {
    for (const file of readdirSync(new URL(`../milkyway/app/${folder}/`, import.meta.url))) {
      assert.ok(sw.includes(`./app/${folder}/${file}`), `${folder}/${file} is precached`);
    }
  }
});

test('provider keys are configured in one place', () => {
  const source = readFileSync(new URL('../milkyway/app/config.js', import.meta.url), 'utf8');
  for (const key of ['supabase', 'livekit', 'cloudinary', 'MW_CONFIG']) assert.ok(source.includes(key));
  for (const folder of ['core', 'data', 'ui']) {
    for (const file of readdirSync(new URL(`../milkyway/app/${folder}/`, import.meta.url))) {
      const code = readFileSync(new URL(`../milkyway/app/${folder}/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(code, /sb_publishable_|supabase\.co/, `${folder}/${file} reads keys from config.js`);
    }
  }
});

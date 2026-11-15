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
  assert.match(html, /id="appDownload" href="\/download\/MilkyWay\.apk" download="MilkyWay\.apk"/);
  assert.doesNotMatch(html, /apk-link\.js/);
  const build = readFileSync(new URL('./build-cloudflare.mjs', import.meta.url), 'utf8');
  assert.match(build, /copyFileSync\(join\(downloads, 'MilkyWay\.apk'\), join\(publicDownloads, 'MilkyWay\.apk'\)\)/);
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

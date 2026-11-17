// Tests for the rebuilt MilkyWay core: the single-request feed API and the non-blocking app shell.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import feed from '../api/milkyway-feed.js';
import liveRoom from '../api/milkyway-live-room.js';
import livekitToken from '../api/milkyway-livekit-token.js';
import { postShareResponse } from '../api/_lib/post-share.js';

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
    { id: P(1), author_id: A, author_name: 'Asha', caption: 'hi', media_url: 'https://x/photo.webp', media_type: 'image', media_items: ['https://x/photo.webp'], media_preview_items: ['https://x/photo-preview.webp'], audio_url: 'https://x/music.mp3', slideshow_style: 'cinema', created_at: '2026-11-14T10:00:00Z' },
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
    media: { url: 'https://x/photo.webp', type: 'image', items: ['https://x/photo.webp'], previewItems: ['https://x/photo-preview.webp'], audioUrl: 'https://x/music.mp3', style: 'cinema' }, createdAt: '2026-11-14T10:00:00Z', likes: 2, comments: 1, liked: false, saved: false,
  });
  assert.equal(payload.next, null);
  // One posts read, then every lookup in parallel — never per-post requests.
  assert.equal(calls.filter(url => url.includes('/mw_posts?')).length, 1);
});

test('shared-post metadata returns public content and excludes private or audience-restricted posts', async () => {
  const row = {
    id: P(9), author_id: A, author_name: 'Asha', title: 'Post title', caption: 'A lovely <post>',
    media_url: 'https://x/photo.webp', media_type: 'image', media_items: [], media_preview_items: ['https://x/preview.webp'],
    created_at: '2026-11-14T10:00:00Z',
  };
  fakeSupabase([
    ['/rest/v1/mw_posts?', [row]],
    ['/rest/v1/mw_profiles?', [{ id: A, display_name: 'Asha K', username: 'asha', avatar_url: '' }]],
    ['/rpc/mw_privacy_flags', {}],
    ['/rpc/mw_post_audiences', []],
  ]);
  const { status, payload } = await call({ action: 'share', id: P(9) });
  assert.equal(status, 200);
  assert.equal(payload.post.title, 'Post title');
  assert.equal(payload.post.author.name, 'Asha K');
  assert.equal(payload.post.caption, 'A lovely <post>');
  assert.equal(payload.post.media.previewItems[0], 'https://x/preview.webp');

  fakeSupabase([
    ['/rest/v1/mw_posts?', [{ ...row, author_id: B }]],
    ['/rest/v1/mw_profiles?', []],
    ['/rpc/mw_privacy_flags', { [B]: { private: true } }],
    ['/rpc/mw_post_audiences', []],
  ]);
  const hidden = await call({ action: 'share', id: P(9) });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.payload.post, null);

  fakeSupabase([
    ['/rest/v1/mw_posts?', [row]],
    ['/rest/v1/mw_profiles?', [{ id: A, display_name: 'Asha K', username: 'asha', avatar_url: '' }]],
    ['/rpc/mw_privacy_flags', {}],
    ['/rpc/mw_post_audiences', [{ post_id: P(9), can_see: false }]],
  ]);
  const audienceHidden = await call({ action: 'share', id: P(9) });
  assert.equal(audienceHidden.payload.post, null);
});

test('shared-post metadata falls back when older schemas lack title and slideshow columns', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/rest/v1/mw_posts?') && address.includes('select=title,')) {
      return new Response(JSON.stringify({ message: "Could not find the 'title' column of 'mw_posts' in the schema cache" }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (address.includes('/rest/v1/mw_posts?') && !address.includes('media_preview_items')) {
      return new Response(JSON.stringify([{
        id: P(11), author_id: A, caption: 'Legacy caption', media_url: null, media_type: null,
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (address.includes('/rest/v1/mw_posts?')) {
      return new Response(JSON.stringify({ message: "Could not find the 'media_preview_items' column of 'mw_posts' in the schema cache" }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { status, payload } = await call({ action: 'share', id: P(11) });
  assert.equal(status, 200);
  assert.equal(payload.post.title, '');
  assert.equal(payload.post.caption, 'Legacy caption');
  assert.equal(calls.filter(url => url.includes('/rest/v1/mw_posts?')).length, 3);
});

test('post share page emits escaped post-specific Open Graph metadata and a useful app fallback', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    post: {
      id: P(10), title: 'A post title', author: { name: 'Asha & Co' }, caption: 'A <great> view',
      media: { type: 'image', url: 'https://x/post.webp', previewItems: [] },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const response = await postShareResponse(`https://milkyway.test/share/${P(10)}`, P(10));
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /property="og:image" content="https:\/\/x\/post\.webp"/);
  assert.match(body, /property="og:title" content="A post title"/);
  assert.match(body, /property="og:description" content="A &lt;great&gt; view"/);
  assert.match(body, /http-equiv="refresh" content="0;url=https:\/\/milkyway\.test\/milkyway\/\?post=/);
  assert.match(body, /<img src="https:\/\/x\/post\.webp"/);
  assert.match(body, /Open this post in MilkyWay/);
  assert.match(body, /property="og:url" content="https:\/\/milkyway\.test\/share\//);

  const crawler = await postShareResponse(`https://milkyway.test/share/${P(10)}`, P(10), 'WhatsApp');
  const crawlerBody = await crawler.text();
  assert.doesNotMatch(crawlerBody, /http-equiv="refresh"/);
  assert.match(crawlerBody, /property="og:image" content="https:\/\/x\/post\.webp"/);
});

test('feed cursor resumes right after the last returned post', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: P(i + 1), author_id: A, caption: '', media_url: null, media_type: null, created_at: `2026-11-14T0${9 - i}:00:00Z` }));
  fakeSupabase([['/rest/v1/mw_posts?', rows], ['/rpc/mw_privacy_flags', {}]]);
  const { payload } = await call({ action: 'page', limit: '4', before: '2026-11-15T00:00:00Z' });
  assert.equal(payload.posts.length, 4);
  assert.equal(payload.next, payload.posts[3].createdAt);
});

test('Orbit feed falls back to core post columns when slideshow columns are absent', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/auth/v1/user')) return new Response('{}', { status: 401 });
    if (address.includes('/rest/v1/mw_posts?')) {
      if (address.includes('media_items')) {
        return new Response(JSON.stringify({ message: "Could not find the 'media_items' column of 'mw_posts' in the schema cache" }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([{
        id: P(4), author_id: A, author_name: 'Asha', caption: 'Existing post',
        media_url: null, media_type: null, created_at: '2026-11-14T10:00:00Z',
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { status, payload } = await call({ action: 'page', scope: 'foryou', limit: '5' });
  assert.equal(status, 200);
  assert.deepEqual(payload.posts.map(post => post.id), [P(4)]);
  assert.equal(calls.filter(url => url.includes('/rest/v1/mw_posts?')).length, 2);
  assert.match(calls[0], /media_items/);
  assert.doesNotMatch(calls[1], /media_items|audio_url|slideshow_style/);
  assert.doesNotMatch(calls[1], /author_id=/, 'the For You query remains global');
});

test('Orbit feed falls back when scheduled_at is absent from an older posts schema', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/auth/v1/user')) return new Response('{}', { status: 401 });
    if (address.includes('/rest/v1/mw_posts?') && address.includes('scheduled_at')) {
      return new Response(JSON.stringify({ message: "Could not find the 'scheduled_at' column of 'mw_posts' in the schema cache" }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (address.includes('/rest/v1/mw_posts?')) return new Response('[]', { status: 200 });
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { status, payload } = await call({ action: 'page', scope: 'foryou', limit: '5' });
  assert.equal(status, 200);
  assert.deepEqual(payload, { posts: [], next: null });
  assert.equal(calls.filter(url => url.includes('/rest/v1/mw_posts?')).length, 2);
  assert.match(calls[0], /scheduled_at/);
  assert.doesNotMatch(calls[1], /scheduled_at/);
  assert.doesNotMatch(calls[1], /author_id=/, 'the For You query remains global');
});

test('Orbit feed treats an empty posts table as a successful empty page', async () => {
  fakeSupabase([['/rest/v1/mw_posts?', []]]);
  const { status, payload } = await call({ action: 'page', scope: 'foryou', limit: '5' });
  assert.equal(status, 200);
  assert.deepEqual(payload, { posts: [], next: null });

  const strings = readFileSync(new URL('../milkyway/app/core/i18n.js', import.meta.url), 'utf8');
  assert.match(strings, /empty:\s*'No posts yet\. Be the first to post!'/);
});

test('Orbit feed subscribes to global post changes and Supabase publishes mw_posts', () => {
  const feed = readFileSync(new URL('../milkyway/app/data/feed.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261116_milkyway_orbit_feed_realtime.sql', import.meta.url), 'utf8');
  const repository = readFileSync(new URL('../api/milkyway-feed.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const sync = readFileSync(new URL('../milkyway/app/core/sync.js', import.meta.url), 'utf8');
  assert.match(feed, /table:\s*'mw_posts'/);
  assert.match(feed, /active\?\.refresh\(\)/);
  assert.match(repository, /scope === 'following'[\s\S]*author_id=\$\{inList\(authors\)\}/);
  assert.match(repository, /public feed includes every author|POST_FIELDS/);
  assert.match(migration, /using \(public\.mw_profile_posts_visible\(author_id::text\)\)/);
  assert.doesNotMatch(migration, /using\s*\(true\)/i, 'public posts must continue to respect account privacy');
  assert.match(migration, /alter table public\.mw_posts enable row level security/i);
  assert.match(migration, /grant select on public\.mw_posts to anon, authenticated/i);
  assert.match(migration, /mw_posts_orbit_read/);
  assert.match(migration, /alter publication supabase_realtime add table public\.mw_posts/i);
  assert.match(view, /source\.load\(\)\.then\(\(\) => source\.refresh\(\)\)/);
  assert.match(view, /source\?\.source\.error[\s\S]*feedLoadFailed/);
  assert.match(sync, /get error\(\) \{ return error; \}/);
});

test('DM call schema migration repairs call columns and reloads PostgREST schema', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261123_milkyway_dm_calls_schema.sql', import.meta.url), 'utf8');
  for (const column of ['caller_id', 'callee_id', 'created_at', 'status']) {
    assert.match(migration, new RegExp(`add column if not exists ${column}\\b`, 'i'));
  }
  assert.match(migration, /created_at set not null/i);
  assert.match(migration, /status set not null/i);
  assert.match(migration, /mw_dm_calls_incoming_idx/);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});

test('DM call connection validates token endpoints and offers an in-call retry on LiveKit errors', () => {
  const callView = readFileSync(new URL('../milkyway/app/ui/call-view.js', import.meta.url), 'utf8');
  const liveKit = readFileSync(new URL('../api/_lib/livekit.js', import.meta.url), 'utf8');
  const callApi = readFileSync(new URL('../api/milkyway-call.js', import.meta.url), 'utf8');
  const translations = readFileSync(new URL('../milkyway/app/core/i18n.js', import.meta.url), 'utf8');
  assert.match(callApi, /livekitUsable\(\)/);
  assert.match(callApi, /serverUrl:\s*livekitUrl\(\)/);
  assert.match(liveKit, /LIVEKIT_URL.*LIVEKIT_API_KEY.*LIVEKIT_API_SECRET/);
  assert.match(liveKit, /const validLivekitUrl = \(\) =>/);
  assert.match(liveKit, /url\.pathname === '\/'.*!url\.username/);
  assert.match(callView, /callAccessToken\(roomName, this\.call\.id, auth\.name\)/);
  assert.match(callView, /directCallToken\(roomName, auth\.name\)/);
  assert.match(callView, /validLiveKitAccess/);
  assert.match(callView, /this\.retryBtn\.hidden = false/);
  assert.doesNotMatch(callView, /this\.hangUp\('disconnected'\)/);
  assert.match(callView, /callServiceLimited/);
  assert.match(translations, /callServiceLimited:/);
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

test('LIVE settings persist guest slots and featured host backgrounds with schema repair', async () => {
  const hostId = A;
  const room = 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const originalFetch = globalThis.fetch;
  const saved = [];
  globalThis.fetch = async (input, init = {}) => {
    const address = String(input);
    if (address.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: hostId }), { status: 200 });
    if (address.includes('/mw_video_live_sessions?')) return new Response(JSON.stringify([{ id: P(1), host_id: hostId, is_live: true, title: 'Test' }]), { status: 200 });
    if (address.includes('/mw_live_room_settings?room_name=') && init.method !== 'POST') return new Response(JSON.stringify([{ settings: { layout: 9 } }]), { status: 200 });
    if (address.includes('/mw_live_room_settings?on_conflict=')) {
      saved.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected LIVE settings request: ${address}`);
  };
  const callSettings = async body => {
    let status = 200, payload;
    const response = { headersSent: false, setHeader() { return response; }, status(code) { status = code; return response; }, json(value) { payload = value; response.headersSent = true; return response; } };
    await liveRoom({ method: 'POST', headers: { authorization: 'Bearer test-token', apikey: 'test-public-key' }, query: {}, body: { action: 'settings', room, ...body } }, response);
    return { status, payload };
  };
  try {
    const result = await callSettings({ layout: 12, showGuestSlots: true, layoutStyle: 'featured', hostBackground: 'https://example.test/backdrop.mp4', hostBackgroundKind: 'video' });
    assert.equal(result.status, 200);
    assert.equal(saved[0].settings.layout, 9, 'the room allows at most eight guest seats');
    assert.equal(saved[0].settings.showGuestSlots, true);
    assert.equal(saved[0].settings.layoutStyle, 'featured');
    assert.equal(saved[0].settings.hostBackground, 'https://example.test/backdrop.mp4');
    assert.equal(saved[0].settings.hostBackgroundKind, 'video');
    assert.equal((await callSettings({ hostBackground: 'http://example.test/backdrop.mp4' })).status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_live_settings_host_id.sql', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists host_id uuid/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(liveView, /dataset\.layout = layoutStyle/);
  assert.match(liveView, /live-host-background/);
  assert.match(css, /grid-template-columns: minmax\(0, 2\.2fr\) minmax\(52px, \.8fr\)/);
});

test('composer and post viewer support client-assisted photo slideshows with optional audio', () => {
  const compose = readFileSync(new URL('../milkyway/app/ui/compose-sheet.js', import.meta.url), 'utf8');
  const optimizer = readFileSync(new URL('../milkyway/app/core/media-optimizer.js', import.meta.url), 'utf8');
  const imageOptimizer = readFileSync(new URL('../milkyway/app/core/media-image.js', import.meta.url), 'utf8');
  const feedView = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const mediaMigration = readFileSync(new URL('../supabase/migrations/20261119_milkyway_media_previews.sql', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../milkyway/app/ui/profile-view.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  const transitions = readFileSync(new URL('../supabase/migrations/20261118_milkyway_slideshow_transitions.sql', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const giftTray = readFileSync(new URL('../milkyway/app/ui/gift-tray.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_post_slideshows.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  assert.match(compose, /multiple:\s*true/);
  assert.match(compose, /MAX_PHOTOS = 8/);
  assert.match(compose, /createImageBitmap/);
  assert.match(compose, /value: 'page'.*stylePage/);
  assert.match(compose, /value: 'slide'.*styleSlide/);
  assert.match(compose, /media_items:\s*mediaItems,[\s\S]*audio_url,[\s\S]*slideshow_style/);
  assert.match(compose, /media_preview_items:\s*mediaPreviewItems/);
  assert.match(compose, /optimizeImage\(file\)/);
  assert.match(compose, /createVideoPreview\(videoFile\)/);
  assert.match(imageOptimizer, /MAX_IMAGE_EDGE = 2048/);
  assert.match(imageOptimizer, /PREVIEW_EDGE = 640/);
  assert.match(imageOptimizer, /fullBlob\.size < file\.size/);
  assert.match(optimizer, /video\.removeAttribute\('src'\)/);
  assert.match(feedView, /post\.media\.previewItems\?\.\[0\]/);
  assert.match(feedView, /: 'lazy'/);
  assert.match(mediaMigration, /add column if not exists media_preview_items jsonb not null default '\[\]'::jsonb/i);
  assert.match(mediaMigration, /notify pgrst, 'reload schema'/i);
  assert.match(viewer, /#stepImage\(delta\)/);
  assert.match(viewer, /#renderSoundtrack\(post\)/);
  assert.match(viewer, /#toggleSlideshow/);
  assert.match(viewer, /#preloadImages\(items, index\)/);
  assert.match(viewer, /preloaded\?\.decode\?\.\(\)/);
  assert.match(styles, /pv-image-page[\s\S]*@keyframes pvPageTurn/);
  assert.match(styles, /pv-image-slide[\s\S]*@keyframes pvSlide/);
  assert.match(profile, /media_items,media_preview_items,audio_url,slideshow_style/);
  assert.match(profile, /media_preview_items/);
  assert.match(migration, /add column if not exists media_items jsonb/i);
  assert.match(migration, /add column if not exists audio_url text/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(transitions, /'fade', 'zoom', 'cinema', 'page', 'slide'/);
  assert.match(transitions, /validate constraint mw_posts_slideshow_style_check/i);
  assert.match(repair, /supabase\/migrations\/20261118_milkyway_slideshow_transitions\.sql/);
  assert.match(repair, /supabase\/migrations\/20261117_milkyway_post_slideshows.sql/);
  assert.match(liveView, /data-act': 'gift'[\s\S]*html: icon\.gift/);
  assert.match(liveView, /openGifts\(\{ room: live\.room, to: live\.host, session: this\.session \}\)/);
  assert.match(giftTray, /target\.session\.gift\(key\)/);
  assert.match(giftTray, /this\.sendButton = h\('button'.*t\('send'\)/);
  assert.match(giftTray, /open\(target\) \{[\s\S]*this\.sheet\.open\(\)/);
  assert.doesNotMatch(giftTray.match(/open\(target\) \{([\s\S]*?)\n  \}/)?.[1] || '', /ensureWalletProfile/);
  assert.match(giftTray, /#sendSelected\(\)[\s\S]*ensureWalletProfile/);
  assert.match(giftTray, /topUpPrompt.*hidden: true/);
  assert.match(giftTray, /error\?\.status === 402[\s\S]*topUpPrompt\.hidden = false/);
  assert.match(giftTray, /#select\(button\.dataset\.gift\)/);
});

test('post publishing migration and errors cover slideshow schema and network failures', () => {
  const compose = readFileSync(new URL('../milkyway/app/ui/compose-sheet.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_post_slideshows.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists media_items jsonb not null default '\[\]'::jsonb/i);
  assert.match(migration, /add column if not exists audio_url text/i);
  assert.match(migration, /add column if not exists slideshow_style text not null default 'fade'/i);
  assert.match(migration, /validate constraint mw_posts_slideshow_style_check/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(repair, /supabase\/migrations\/20261117_milkyway_post_slideshows\.sql/);
  assert.match(compose, /const failedPhase = error\?\.publishPhase \|\| phase/);
  assert.match(compose, /postNetworkFailed/);
  assert.match(compose, /postSchemaFailed/);
  assert.match(compose, /console\.error\('\[compose\] post publication failed'/);
});

test('app shell has no render-blocking scripts and loads the core as a module', () => {
  const html = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
  assert.ok(scripts.length >= 1);
  for (const attrs of scripts) assert.match(attrs, /type="module"/, 'every script is a deferred ES module');
  assert.match(html, /app\/main\.js/);
  assert.doesNotMatch(html, /supabase-js|livekit-client/, 'SDKs load lazily, never from the shell');
});

test('Explore video tiles fall back to extracted frames and retain a dark creator placeholder', () => {
  const discovery = readFileSync(new URL('../milkyway/app/ui/discovery-view.js', import.meta.url), 'utf8');
  const media = readFileSync(new URL('../milkyway/app/core/media.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  assert.match(discovery, /extractVideoThumbnail\(media\.url\)/);
  assert.match(discovery, /media\?\.previewItems\?\.\[0\]/);
  assert.match(discovery, /mediaKind\(post\) === 'video'/);
  assert.match(discovery, /class:\s*'explore-post-author'/);
  assert.match(media, /video\.crossOrigin = 'anonymous'/);
  assert.match(media, /context\.drawImage\(video/);
  assert.match(media, /canvas\.toDataURL\('image\/jpeg'/);
  assert.match(styles, /\.explore-post\.is-video-fallback/);
  assert.match(styles, /\.explore-post\.is-video::after/);
  assert.match(styles, /\.explore-post-author/);
});

test('bottom navigation opens Explore discovery and keeps LIVE reachable outside the nav', () => {
  const html = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const navigation = html.match(/<nav class="bottombar"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.match(navigation, /data-nav="home"[\s\S]*data-nav="explore"/);
  assert.doesNotMatch(navigation, /data-nav="live"/);
  assert.match(navigation, /data-nav="explore"[\s\S]*data-i18n="explore">Explore/);
  assert.match(html, /id="exploreView"/);

  const main = readFileSync(new URL('../milkyway/app/main.js', import.meta.url), 'utf8');
  const discovery = readFileSync(new URL('../milkyway/app/ui/discovery-view.js', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../milkyway/app/ui/settings-view.js', import.meta.url), 'utf8');
  const serviceWorker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  assert.match(main, /else if \(nav === 'explore'\) showExplore\(\)/);
  assert.match(main, /function showExplore\(\)[\s\S]*discoveryView\(\)\.then/);
  assert.match(discovery, /searchPeople\(query\)/);
  assert.match(discovery, /HASHTAG/);
  assert.match(discovery, /post\.media\?\.audioUrl/);
  assert.match(discovery, /action: 'page'/);
  assert.match(settings, /querySelector\('#liveEntry'\)/);
  assert.match(serviceWorker, /app\/ui\/discovery-view\.js/);
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

test('share sheets fit the screen and support native sharing or copy fallback', () => {
  const feed = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const live = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const share = readFileSync(new URL('../milkyway/app/ui/share-sheet.js', import.meta.url), 'utf8');
  const sheet = readFileSync(new URL('../milkyway/app/ui/sheet.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  for (const source of [feed, viewer, live]) assert.match(source, /openShare\(/);
  assert.match(share, /platformOptions\(current\)/);
  assert.match(share, /https:\/\/wa\.me\/\?text=/);
  assert.match(share, /facebook\.com\/sharer\/sharer\.php/);
  assert.match(share, /https:\/\/t\.me\/share\/url/);
  assert.match(share, /twitter\.com\/intent\/tweet/);
  assert.match(share, /sms:\?body=/);
  for (const platform of ['WhatsApp', 'Facebook', 'Telegram', 'X', 'sms']) assert.match(share, new RegExp(platform, 'i'));
  assert.match(share, /share-option/);
  assert.match(share, /capacitor\.Plugins\?\.Share \|\| capacitor\.registerPlugin\?\.\('Share'\)/);
  assert.match(share, /plugin\.share\(\{ \.\.\.data, dialogTitle: t\('share'\) \}\)/);
  assert.match(share, /navigator\.canShare/);
  assert.match(share, /result = navigator\.share\(data\)/);
  assert.match(share, /native\.addEventListener\('click', \(\) => shareWithDevice\(tray\)\)/);
  assert.match(share, /navigator\.clipboard\?\.writeText/);
  assert.match(share, /document\.execCommand\('copy'\)/);
  assert.match(share, /autoFocus: false/);
  assert.match(sheet, /if \(this\.autoFocus\)/);
  assert.match(sheet, /constructor\(\{ title = '', className = '', onClose, autoFocus = true \}/);
  assert.match(styles, /\.share-sheet/);
  assert.match(feed, /mediaPlaceholder\(t\('imageUnavailable'\)\)/);
  assert.match(feed, /video\.addEventListener\('error'/);
  assert.match(viewer, /video\.addEventListener\('error'/);
  assert.match(viewer, /mediaPlaceholder\(t\('imageUnavailable'\)\)/);
  assert.match(styles, /\.media-missing-icon/);
});

test('LIVE settings schema and follower post notifications have an idempotent Realtime migration', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_live_settings_and_post_notifications.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  const notifications = readFileSync(new URL('../milkyway/app/data/post-notifications.js', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../milkyway/app/main.js', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists settings jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /having count\(distinct host_id\) = 1/i);
  assert.match(migration, /create policy mw_live_settings_host[\s\S]*mw_is_live_host\(room_name\)[\s\S]*host_id = auth\.uid\(\)/i);
  assert.match(migration, /create table if not exists public\.mw_post_notifications/i);
  assert.match(migration, /create trigger mw_posts_notify_followers/i);
  assert.match(migration, /follow\.following_id::text = new\.author_id::text/i);
  assert.match(migration, /recipient_id = auth\.uid\(\)/i);
  assert.match(migration, /alter publication supabase_realtime add table public\.mw_post_notifications/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(repair, /supabase\/migrations\/20261117_milkyway_live_settings_and_post_notifications\.sql/);
  assert.match(notifications, /table: 'mw_post_notifications'/);
  assert.match(notifications, /filter: `recipient_id=eq\.\$\{currentRecipient\}`/);
  assert.match(entry, /import\('\.\/data\/post-notifications\.js'\)/);
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

test('media uploads compress asynchronously and feed media is cached progressively', () => {
  const optimizer = readFileSync(new URL('../milkyway/app/core/media-optimizer.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../milkyway/app/core/media-worker.js', import.meta.url), 'utf8');
  const imageOptimizer = readFileSync(new URL('../milkyway/app/core/media-image.js', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../milkyway/app/ui/compose-sheet.js', import.meta.url), 'utf8');
  const feed = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const cache = readFileSync(new URL('../sw-cache.js', import.meta.url), 'utf8');
  assert.match(optimizer, /new Worker\(new URL\('\.\/media-worker\.js'/);
  assert.match(optimizer, /export async function optimizeVideo/);
  assert.match(optimizer, /videoBitsPerSecond:\s*1_500_000/);
  assert.match(worker, /optimizeImageFile\(file\)/);
  assert.match(imageOptimizer, /new OffscreenCanvas/);
  assert.match(compose, /optimizeVideo\(selectedVideo/);
  assert.match(compose, /mapConcurrent\(this\.files,\s*2/);
  assert.match(feed, /r\.img\.loading = index === this\.pager\.index \? 'eager' : 'lazy'/);
  assert.match(viewer, /photoPreviewItems\(post\)\[index\]/);
  assert.match(viewer, /device\.saveData \? 0 : device\.slowNetwork \? 1 : 2/);
  assert.match(cache, /IMAGE_MAX_BYTES/);
  assert.match(cache, /address\.pathname\.startsWith\('\/storage\/v1\/object\/public\/portfolio\/'\)/);
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

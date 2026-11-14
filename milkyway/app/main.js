// MilkyWay app entry.
//
// Startup budget (what happens before the first frame of content):
//   1. index.html paints the shell (static HTML + one CSS file) — no blocking scripts, no network.
//   2. This module reads the session from localStorage (sync) and the feed from IndexedDB (~10–30 ms).
//   3. The cached feed renders; video #1 starts. Network refresh, supabase-js, LiveKit and every sheet load later,
//      in the background or on first use.
import { config } from './config.js';
import { auth } from './core/net.js';
import { bus, idle } from './core/events.js';
import { t } from './core/i18n.js';
import { FeedView } from './ui/feed-view.js';
import { playback } from './ui/playback.js';
import { toast } from './ui/dom.js';
import { profiles } from './data/profiles.js';

// Call and conversation-room links belong to screens that are not in this shell yet.
const comingSoon = hash => /^#(call=|live=mw-conversation-)/.test(hash);
const soon = () => toast(t('soon'));

const $ = id => document.getElementById(id);
const shell = document.documentElement;

// ---- Lazily created panels (code downloads on first use) -------------------------------------------------
const lazy = loader => { let value; const get = () => (value ||= loader()); get.loaded = () => Boolean(value); return get; };
const authSheet = lazy(() => import('./ui/auth-sheet.js').then(m => new m.AuthSheet()));
const commentsSheet = lazy(() => import('./ui/comments-sheet.js').then(m => new m.CommentsSheet({ requireLogin })));
const giftTray = lazy(() => import('./ui/gift-tray.js').then(m => new m.GiftTray()));
const inboxView = lazy(() => import('./ui/inbox-view.js').then(m => new m.InboxView()));
const profileView = lazy(() => import('./ui/profile-view.js').then(m => new m.ProfileView({ requireLogin, openCreate })));
const composeSheet = lazy(() => import('./ui/compose-sheet.js').then(m => new m.ComposeSheet()));
const liveView = lazy(() => import('./ui/live-view.js').then(m => new m.LiveView($('liveView'), {
  requireLogin, openProfile, onClose: () => showHome(),
  openGifts: target => giftTray().then(tray => tray.open(target)),
})));

function requireLogin() {
  if (auth.signedIn()) return true;
  authSheet().then(sheet => sheet.open());
  return false;
}
// Any author (feed / Lives) or, with no argument, the signed-in user's own profile.
function openProfile(person = null) {
  if (!person?.id && !requireLogin()) return;
  profileView().then(view => view.open(person?.id ? person : null));
}
function openCreate() {
  if (requireLogin()) composeSheet().then(sheet => sheet.open());
}

// ---- Feed ---------------------------------------------------------------------------------------------------
const feedView = new FeedView($('feedView'), {
  requireLogin,
  openProfile,
  openComments: post => commentsSheet().then(sheet => sheet.open(post)),
  openGifts: target => giftTray().then(tray => tray.open(target)),
});

let scope = auth.signedIn() && localStorage.getItem('mw_core_scope') === 'following' ? 'following' : 'foryou';
function setScope(next) {
  if (next === 'following' && !requireLogin()) return;
  scope = next;
  try { localStorage.setItem('mw_core_scope', next); } catch {}
  document.querySelectorAll('[data-scope]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.scope === next)));
  feedView.show(next);
}

// ---- Views ------------------------------------------------------------------------------------------------
function setNav(name) {
  document.querySelectorAll('.nav-btn').forEach(button => button.toggleAttribute('aria-current', button.dataset.nav === name));
  shell.dataset.view = name;
}
function showHome() {
  if (liveView.loaded()) liveView().then(view => view.close());
  $('feedView').hidden = false;
  playback.suspend(false);
  setNav('home');
  if (location.hash.startsWith('#live')) history.replaceState(null, '', location.pathname);
  feedView.focus();
}
function showLive(room = null) {
  playback.suspend(true);
  $('feedView').hidden = true;
  setNav('live');
  if (!location.hash.startsWith('#live')) history.pushState({ live: true }, '', room ? `#live=${encodeURIComponent(room)}` : '#live');
  liveView().then(view => view.open(room));
}

function route() {
  if (comingSoon(location.hash)) { history.replaceState(null, '', location.pathname + location.search); soon(); }
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('live')) showLive(hash.split('=')[1] || null);
  else if (shell.dataset.view === 'live') showHome();
}
addEventListener('popstate', route);

document.addEventListener('click', event => {
  const target = event.target.closest('[data-scope], [data-nav], #liveEntry, #muteToggle');
  if (!target) return;
  if (target.dataset.scope) { if (shell.dataset.view !== 'home') showHome(); setScope(target.dataset.scope); return; }
  if (target.id === 'liveEntry') { showLive(); return; }
  if (target.id === 'muteToggle') { playback.setMuted(!playback.muted); return; }
  const nav = target.dataset.nav;
  if (nav === 'home') { if (shell.dataset.view === 'home') feedView.reload(); else showHome(); }
  else if (nav === 'live') showLive();
  else if (nav === 'create') openCreate();
  else if (nav === 'inbox') { if (requireLogin()) inboxView().then(view => view.open()); }
  else if (nav === 'me') openProfile();
});

// ---- Connectivity + account changes ----------------------------------------------------------------------
bus.on('offline', () => { $('netBanner').hidden = false; $('netBanner').textContent = t('offline'); });
bus.on('online', () => { if (!$('netBanner').hidden) { $('netBanner').hidden = true; toast(t('backOnline')); } });
if (navigator.onLine === false) { $('netBanner').hidden = false; $('netBanner').textContent = t('offline'); }
bus.on('auth', () => {
  shell.toggleAttribute('data-signed-in', auth.signedIn());
  if (!auth.signedIn() && scope === 'following') scope = 'foryou';
  feedView.scope = null;
  setScope(scope);
});
shell.toggleAttribute('data-signed-in', auth.signedIn());
playback.onMute(muted => shell.toggleAttribute('data-muted', muted));
shell.toggleAttribute('data-muted', playback.muted);

// ---- Go -----------------------------------------------------------------------------------------------------
document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
setScope(scope);
route();

idle(() => {
  profiles.loadFollowing();
  // LIVE badge: show when someone is live (cached list first, quiet refresh).
  import('./data/live.js').then(({ lives }) => {
    lives.subscribe(list => $('liveEntry')?.classList.toggle('has-live', (list?.length || 0) > 0));
    lives.load();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Notification taps forwarded by the worker: Lives open here; calls are not in this shell yet.
    navigator.serviceWorker.addEventListener('message', ({ data }) => {
      if (data?.type === 'mw-open-live' && data.url) {
        const hash = new URL(data.url).hash;
        if (comingSoon(hash)) soon();
        else { history.pushState(null, '', hash); route(); }
      } else if (data?.type === 'mw-call-push' || data?.type === 'mw-call-action') soon();
    });
  }
}, 2500);

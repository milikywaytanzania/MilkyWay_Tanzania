// Sponsored ads and "Suggested for you" cards woven into the Orbit feed, TikTok style.
//  - Ads: active campaigns from /api/milkyway-account?action=advertisements (placement "feed" or any), one every
//    AD_EVERY posts, rotated; impressions/clicks reported once per campaign per session; "Not interested" hides it.
//  - Suggestions: people followed by the people you follow (friends of friends), topped up with recent accounts.
// Both fail quietly: the feed never waits on them and never shows an error because of them.
import { config } from '../config.js';
import { api, auth, supabase } from '../core/net.js';
import { lang } from '../core/i18n.js';
import { profiles } from './profiles.js';

const ACCOUNT = `${config.api.base}/milkyway-account`;
export const AD_EVERY = 6;          // one sponsored slide after every 6 posts
export const SUGGEST_FIRST = 4;     // first suggestion card after 4 posts
export const SUGGEST_EVERY = 18;    // then every 18 posts
const DISMISSED_KEY = 'mw_ads_dismissed';

let adsPromise = null, adsAt = 0;
let suggestPromise = null, suggestAt = 0, suggestFor = null;
const seen = new Set();

const dismissed = () => { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}'))); } catch { return new Map(); } };

/** Active feed campaigns (cached 5 minutes). */
export function loadAds() {
  if (adsPromise && Date.now() - adsAt < 5 * 60_000) return adsPromise;
  adsAt = Date.now();
  adsPromise = api(`${ACCOUNT}?action=advertisements&lang=${encodeURIComponent(lang)}`, { timeout: 10000 })
    .then(result => {
      const hidden = dismissed();
      return (Array.isArray(result?.campaigns) ? result.campaigns : [])
        .filter(ad => ad?.id && (ad.mediaUrl || ad.title || ad.description))
        .filter(ad => !ad.placement || ad.placement === 'feed' || ad.placement === 'video')
        .filter(ad => !(Number(hidden.get(ad.id)) > Date.now()));
    })
    .catch(() => []);
  return adsPromise;
}

const report = (id, type) => api(`${ACCOUNT}?action=ad-event&id=${encodeURIComponent(id)}&type=${type}`, { method: 'POST', body: {}, timeout: 8000 }).catch(() => {});
export const adImpression = ad => { if (!seen.has(ad.id)) { seen.add(ad.id); report(ad.id, 'impression'); } };
export const adClick = ad => report(ad.id, 'click');
export function dismissAd(ad) {
  const hidden = dismissed();
  hidden.set(ad.id, Date.now() + Math.max(1, Number(ad.dismissDays) || 7) * 86400000);
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(Object.fromEntries(hidden))); } catch {}
  adsPromise = null;
  if (auth.signedIn()) api(`${ACCOUNT}?action=dismiss-ad&id=${encodeURIComponent(ad.id)}`, { method: 'POST', body: {}, timeout: 8000 }).catch(() => {});
}

/** Feed item for a campaign: shaped like a post so the slide's media pipeline (video/photo) plays it. */
export const adItem = (ad, slot) => ({
  id: `ad:${slot}`, kind: 'ad', ad,
  caption: ad.description || '', media: ad.mediaUrl ? { url: ad.mediaUrl, type: ad.mediaType || '' } : null,
  author: { id: '', name: ad.business || ad.title || 'Sponsored', username: '', avatar: '' },
  likes: 0, comments: 0,
});
export const suggestItem = slot => ({ id: `suggest:${slot}`, kind: 'suggest', caption: '', media: null, author: { id: '', name: '' }, likes: 0, comments: 0 });

/** Up to 12 people to follow (cached 10 minutes per account). */
export function loadSuggestions() {
  const me = auth.userId || 'guest';
  if (suggestPromise && suggestFor === me && Date.now() - suggestAt < 10 * 60_000) return suggestPromise;
  suggestFor = me; suggestAt = Date.now();
  suggestPromise = (async () => {
    const sb = await supabase();
    const following = auth.signedIn() ? [...await profiles.loadFollowing()] : [];
    const skip = new Set([...following, auth.userId].filter(Boolean).map(String));
    const scores = new Map();
    if (following.length) {
      const { data } = await sb.from('mw_follows').select('following_id').in('follower_id', following.slice(0, 200)).limit(2000);
      (data || []).forEach(row => { const id = String(row.following_id); if (!skip.has(id)) scores.set(id, (scores.get(id) || 0) + 1); });
    }
    const mutual = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
    const rows = [];
    if (mutual.length) rows.push(...((await sb.from('mw_profiles').select('id,display_name,username,avatar_url').in('id', mutual)).data || []));
    if (rows.length < 12) {
      const { data } = await sb.from('mw_profiles').select('id,display_name,username,avatar_url').limit(40);
      const have = new Set(rows.map(row => String(row.id)));
      for (const row of data || []) {
        const id = String(row.id);
        if (!skip.has(id) && !have.has(id) && (row.display_name || row.username)) { rows.push(row); have.add(id); }
        if (rows.length >= 12) break;
      }
    }
    const people = rows.map(row => ({
      id: String(row.id), name: row.display_name || row.username || 'MilkyWay', username: row.username || '', avatar: row.avatar_url || '',
      mutual: scores.get(String(row.id)) || 0,
    }));
    profiles.prime?.(people.map(({ id, name, username, avatar }) => ({ id, name, username, avatar })));
    return people.sort((a, b) => b.mutual - a.mutual);
  })().catch(() => []);
  return suggestPromise;
}

/** Inserts ad and suggestion slots between posts. Keys depend only on post positions, so they stay stable. */
export function weave(posts, { ads = [], people = [] } = {}) {
  const out = [];
  let adTurn = 0;
  posts.forEach((post, index) => {
    out.push(post);
    const n = index + 1;
    if (people.length && (n === SUGGEST_FIRST || (n > SUGGEST_FIRST && (n - SUGGEST_FIRST) % SUGGEST_EVERY === 0))) out.push(suggestItem(n));
    else if (ads.length && n % AD_EVERY === 0) out.push(adItem(ads[adTurn++ % ads.length], n));
  });
  return out;
}

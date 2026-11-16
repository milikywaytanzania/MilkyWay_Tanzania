import { config } from '../config.js';
import { t } from '../core/i18n.js';
import { api, auth, supabase } from '../core/net.js';
import { actions } from '../data/feed.js';
import { ago, count, h, toast } from './dom.js';

const SERVICE_FIELDS = 'id,creator_id,title,category,description,pricing,created_at';
const clean = value => String(value || '').trim();
const message = (parent, error) => {
  parent.replaceChildren(h('p', { class: 'muted center', role: 'status' }, error?.message || t('retry')));
};

export class StudioView {
  constructor({ container, setTitle, onBack, onWallet, onGoLive, onCreatePost, onOpenPost }) {
    this.container = container;
    this.setTitle = setTitle;
    this.hooks = { onBack, onWallet, onGoLive, onCreatePost, onOpenPost };
  }

  open() {
    this.#show('overview');
  }

  stop() {
    clearInterval(this.refreshTimer);
    this.refreshTimer = 0;
  }

  #show(section) {
    this.stop();
    this.section = section;
    this.setTitle(t('studio'));
    const nav = h('nav', { class: 'mw-studio-tabs', 'aria-label': t('studioSections') });
    const content = h('div', { class: 'mw-studio-content', 'aria-live': 'polite' }, h('p', { class: 'muted center' }, t('loading')));
    const sections = [
      ['overview', t('studioOverview')],
      ['content', t('studioContent')],
      ['live', t('studioLive')],
      ['business', t('studioBusiness')],
    ];
    nav.append(...sections.map(([key, label]) => h('button', {
      type: 'button',
      'aria-pressed': String(key === section),
      onclick: () => this.#show(key),
    }, label)));
    this.container.replaceChildren(
      h('button', { class: 'link nova-back', type: 'button', onclick: this.hooks.onBack }, `‹ ${t('back')}`),
      h('header', { class: 'mw-studio-hero' },
        h('span', { class: 'mw-studio-mark', 'aria-hidden': 'true' }, '✦'),
        h('div', {}, h('p', { class: 'mw-studio-eyebrow' }, 'MASIYATUNDA CO. LTD'),
          h('h2', {}, t('studio')), h('p', { class: 'muted' }, t('studioHint'))),
        section === 'overview'
          ? h('button', { class: 'mw-studio-refresh', type: 'button', 'aria-label': t('studioRefresh'), title: t('studioRefresh'), onclick: () => this.#show('overview') }, '↻')
          : null,
        h('button', { class: 'pill-btn mw-studio-wallet', type: 'button', onclick: this.hooks.onWallet }, `🪙 ${t('giftBalance')}`)),
      nav, content);
    this.#load(section, content);
  }

  async #load(section, content) {
    try {
      if (section === 'overview') await this.#overview(content);
      else if (section === 'content') await this.#content(content);
      else if (section === 'live') await this.#live(content);
      else await this.#business(content);
    } catch (error) {
      message(content, error);
    }
  }

  async #overview(content) {
    const sb = await supabase();
    const head = { count: 'exact', head: true };
    const [postResult, followerResult, followingResult, wallet, liveResult] = await Promise.all([
      sb.from('mw_posts').select('id,caption,media_url,media_type,created_at', { count: 'exact' })
        .eq('author_id', auth.userId).order('created_at', { ascending: false }).limit(30),
      sb.from('mw_follows').select('follower_id', head).eq('following_id', auth.userId),
      sb.from('mw_follows').select('following_id', head).eq('follower_id', auth.userId),
      api(`${config.api.wallet}?action=wallet`, { timeout: 12000 }),
      sb.from('mw_video_live_sessions').select('id,room_name,is_live,started_at,ended_at')
        .eq('host_id', auth.userId).order('started_at', { ascending: false }).limit(30),
    ]);
    for (const result of [postResult, followerResult, followingResult, liveResult]) if (result.error) throw result.error;
    const posts = postResult.data || [];
    const postIds = posts.map(post => post.id);
    let likes = 0, comments = 0, views = 0;
    if (postIds.length) {
      const [likeResult, commentResult, viewResult] = await Promise.all([
        sb.from('mw_signals').select('post_id', { count: 'exact', head: true }).in('post_id', postIds).eq('kind', 'light'),
        sb.from('mw_echoes').select('post_id', { count: 'exact', head: true }).in('post_id', postIds),
        sb.from('mw_post_views').select('post_id', { count: 'exact', head: true }).in('post_id', postIds),
      ]);
      if (likeResult.error) throw likeResult.error;
      if (commentResult.error) throw commentResult.error;
      if (viewResult.error) throw viewResult.error;
      likes = likeResult.count || 0;
      comments = commentResult.count || 0;
      views = viewResult.count || 0;
    }
    const live = liveResult.data || [];
    const activeLive = live.find(item => item.is_live);
    let liveViewers = 0, liveGuests = 0;
    if (activeLive) {
      const [viewersResult, guestsResult] = await Promise.all([
        sb.from('mw_live_room_members').select('user_id', { count: 'exact', head: true }).eq('room_name', activeLive.room_name).eq('state', 'viewer'),
        sb.from('mw_live_room_members').select('user_id', { count: 'exact', head: true }).eq('room_name', activeLive.room_name).eq('state', 'speaker'),
      ]);
      if (viewersResult.error) throw viewersResult.error;
      if (guestsResult.error) throw guestsResult.error;
      liveViewers = viewersResult.count || 0;
      liveGuests = guestsResult.count || 0;
    }
    const stat = (label, value, detail = '') => h('div', { class: 'mw-studio-stat' },
      h('small', {}, label), h('b', {}, value), detail ? h('span', { class: 'muted' }, detail) : null);
    const walletBalance = Number(wallet?.coins) || 0;
    const earned = Number(wallet?.earned) || 0;
    const recentLiveGifts = (Array.isArray(wallet?.received) ? wallet.received : [])
      .filter(item => item.target === 'live')
      .reduce((sum, item) => sum + (Number(item.earned) || 0), 0);
    content.replaceChildren(
      h('div', { class: 'mw-studio-stats' },
        stat(t('followers'), count(followerResult.count || 0)),
        stat(t('studioFollowing'), count(followingResult.count || 0)),
        stat(t('studioPosts'), count(postResult.count ?? posts.length)),
        stat(t('studioLikesRecent'), count(likes), t('studioLast30Posts')),
        stat(t('studioCommentsRecent'), count(comments), t('studioLast30Posts')),
        stat(t('studioViews'), count(views), t('studioViewsRecent')),
        stat(t('earned'), count(earned), t('studioGiftEarnings')),
        stat(t('studioLiveGiftEarnings'), count(recentLiveGifts), t('studioLiveGiftHint')),
        stat(t('studioWalletBalance'), count(walletBalance), t('coins')),
        stat(t('studioLiveSessions'), count(live.length), activeLive ? t('studioLiveNow') : t('studioNoActiveLive')),
        stat(t('studioLiveViewers'), count(liveViewers)),
        stat(t('studioLiveGuests'), count(liveGuests))),
      h('div', { class: 'mw-studio-actions' },
        h('button', { class: 'pill-btn hot', type: 'button', onclick: this.hooks.onCreatePost }, `＋ ${t('studioCreatePost')}`),
        h('button', { class: 'pill-btn', type: 'button', onclick: this.hooks.onWallet }, t('studioOpenWallet')),
        h('button', { class: 'pill-btn', type: 'button', onclick: this.hooks.onGoLive }, t('studioOpenLive'))));
    this.refreshTimer = setInterval(() => {
      if (this.section === 'overview') this.#overview(content).catch(error => message(content, error));
    }, 30_000);
  }

  async #content(content) {
    const sb = await supabase();
    const { data, error } = await sb.from('mw_posts')
      .select('id,caption,media_url,media_type,scheduled_at,created_at')
      .eq('author_id', auth.userId).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    const posts = data || [];
    const { data: pin, error: pinError } = await sb.from('mw_creator_pins').select('post_id').eq('creator_id', auth.userId).maybeSingle();
    if (pinError) throw pinError;
    const rows = posts.length ? posts.map(post => {
      const pinned = pin?.post_id === post.id;
      const scheduled = post.scheduled_at && Date.parse(post.scheduled_at) > Date.now();
      const item = h('article', { class: 'mw-studio-post' },
        h('span', { class: 'nova-kind', 'aria-hidden': 'true' }, /video/.test(post.media_type || '') ? '🎬' : post.media_url ? '🖼' : '✍️'),
        h('div', { class: 'mw-studio-post-copy' },
          h('b', {}, (post.caption || t('post')).slice(0, 100)),
          h('small', { class: 'muted' }, `${scheduled ? `${t('studioScheduled')} · ${new Date(post.scheduled_at).toLocaleString()}` : ago(post.created_at)}${pinned ? ` · ${t('studioPinned')}` : ''}`)),
        h('div', { class: 'mw-studio-post-actions' },
          h('button', { class: 'pill-btn', type: 'button', onclick: () => this.hooks.onOpenPost?.(post) }, t('openPost')),
          h('button', { class: 'pill-btn', type: 'button', disabled: Boolean(scheduled), onclick: () => this.#togglePin(post, pinned, item, content) }, pinned ? t('studioUnpin') : t('studioPin')),
          scheduled ? h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.#publishScheduled(post, content) }, t('studioPublishNow')) : null,
          h('button', { class: 'pill-btn danger', type: 'button', onclick: () => this.#deletePost(post, item) }, t('deletePost'))));
      return item;
    }) : [h('p', { class: 'muted center' }, t('noPostsYet'))];
    content.replaceChildren(
      h('div', { class: 'mw-studio-section-head' },
        h('div', {}, h('h3', {}, t('studioContent')), h('p', { class: 'muted' }, t('studioContentHint'))),
        h('button', { class: 'pill-btn hot', type: 'button', onclick: this.hooks.onCreatePost }, `＋ ${t('create')}`)),
      h('div', { class: 'mw-studio-post-list' }, ...rows));
  }

  async #togglePin(post, pinned, row, content) {
    const button = row.querySelector('.mw-studio-post-actions button:nth-child(2)');
    button.disabled = true;
    try {
      const sb = await supabase();
      const result = pinned
        ? await sb.from('mw_creator_pins').delete().eq('creator_id', auth.userId).eq('post_id', post.id)
        : await sb.from('mw_creator_pins').upsert({ creator_id: auth.userId, post_id: post.id }, { onConflict: 'creator_id' });
      if (result.error) throw result.error;
      toast(pinned ? t('studioPostUnpinned') : t('studioPostPinned'));
      this.#load('content', content);
    } catch (error) {
      button.disabled = false;
      toast(error?.message || t('retry'));
    }
  }

  async #deletePost(post, row) {
    const button = row.querySelector('.mw-studio-post-actions .danger');
    if (button.dataset.armed !== 'true') {
      button.dataset.armed = 'true';
      button.textContent = t('tapAgainDelete');
      setTimeout(() => {
        if (!button.isConnected) return;
        delete button.dataset.armed;
        button.textContent = t('deletePost');
      }, 3000);
      return;
    }
    button.disabled = true;
    try {
      await actions.remove(post);
      toast(t('postDeleted'));
      row.remove();
      if (!row.parentElement?.children.length) row.parentElement?.replaceChildren(h('p', { class: 'muted center' }, t('noPostsYet')));
    } catch (error) {
      button.disabled = false;
      toast(error?.message || t('deleteFailed'));
    }
  }

  async #publishScheduled(post, content) {
    try {
      const sb = await supabase();
      const { data, error } = await sb.from('mw_posts').update({ scheduled_at: null })
        .eq('id', post.id).eq('author_id', auth.userId).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error(t('retry'));
      toast(t('studioPublishedNow'));
      this.#load('content', content);
    } catch (error) {
      toast(error?.message || t('retry'));
    }
  }

  async #live(content) {
    const sb = await supabase();
    const { data, error } = await sb.from('mw_video_live_sessions')
      .select('id,title,room_name,is_live,started_at,ended_at')
      .eq('host_id', auth.userId).order('started_at', { ascending: false }).limit(30);
    if (error) throw error;
    const sessions = data || [];
    content.replaceChildren(
      h('div', { class: 'mw-studio-section-head' },
        h('div', {}, h('h3', {}, t('studioLive')), h('p', { class: 'muted' }, t('studioLiveHint'))),
        h('button', { class: 'pill-btn hot', type: 'button', onclick: this.hooks.onGoLive }, t('goLive'))),
      sessions.length
        ? h('div', { class: 'mw-studio-post-list' }, ...sessions.map(session => h('div', { class: 'mw-studio-post' },
          h('span', { class: `mw-studio-live-indicator${session.is_live ? ' active' : ''}` }, session.is_live ? 'LIVE' : '◉'),
          h('div', { class: 'mw-studio-post-copy' },
            h('b', {}, session.title || t('studioUntitledLive')),
            h('small', { class: 'muted' }, `${ago(session.started_at)} · ${session.is_live ? t('studioLiveNow') : t('studioLiveEnded')}`)),
          h('span', { class: 'muted mw-studio-session-room' }, session.room_name))))
        : h('div', { class: 'mw-studio-note' }, h('b', {}, t('studioNoLivesYet')), h('p', { class: 'muted' }, t('studioLiveHint'))));
  }

  async #business(content) {
    const sb = await supabase();
    const [servicesResult, inquiriesResult, requestsResult] = await Promise.all([
      sb.from('mw_creator_services').select(SERVICE_FIELDS).eq('creator_id', auth.userId).order('created_at', { ascending: false }),
      sb.from('mw_service_inquiries').select('id,service_id,client_name,message,preferred_at,status,creator_reply,created_at,service:mw_creator_services(title)')
        .eq('creator_id', auth.userId).order('created_at', { ascending: false }).limit(100),
      sb.from('mw_service_inquiries').select('id,message,preferred_at,status,creator_reply,created_at,service:mw_creator_services(title)')
        .eq('requester_id', auth.userId).order('created_at', { ascending: false }).limit(100),
    ]);
    if (servicesResult.error) throw servicesResult.error;
    if (inquiriesResult.error) throw inquiriesResult.error;
    if (requestsResult.error) throw requestsResult.error;

    const title = h('input', { class: 'field', minlength: '2', maxlength: '80', placeholder: t('studioServiceTitle'), required: true });
    const category = h('input', { class: 'field', minlength: '2', maxlength: '60', placeholder: t('studioServiceCategory'), required: true });
    const pricing = h('input', { class: 'field', maxlength: '100', placeholder: t('studioServicePricing') });
    const description = h('textarea', { class: 'field area', minlength: '10', maxlength: '1000', placeholder: t('studioServiceDescription'), required: true });
    const notice = h('p', { class: 'muted', role: 'status' });
    const form = h('form', { class: 'mw-studio-service-form', onsubmit: async event => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      notice.textContent = t('loading');
      try {
        const { error } = await sb.from('mw_creator_services').insert({
          creator_id: auth.userId,
          title: clean(title.value),
          category: clean(category.value),
          pricing: clean(pricing.value),
          description: clean(description.value),
        });
        if (error) throw error;
        toast(t('studioServiceAdded'));
        this.#show('business');
      } catch (error) {
        notice.textContent = error?.message || t('retry');
        submit.disabled = false;
      }
    } }, title, category, pricing, description,
    h('button', { class: 'pill-btn hot', type: 'submit' }, t('studioAddService')), notice);

    const services = (servicesResult.data || []).map(service => h('article', { class: 'mw-studio-service-card' },
      h('div', {}, h('small', { class: 'mw-studio-eyebrow' }, service.category),
        h('h4', {}, service.title), h('p', { class: 'muted' }, service.description),
        service.pricing ? h('b', { class: 'mw-studio-price' }, service.pricing) : null),
      h('div', { class: 'mw-studio-service-actions' },
        h('button', { class: 'pill-btn', type: 'button', onclick: event => this.#editService(service, event.currentTarget.closest('.mw-studio-service-card')) }, t('update')),
        h('button', { class: 'pill-btn danger', type: 'button', onclick: () => this.#removeService(service.id) }, t('remove')))));
    const inquiries = (inquiriesResult.data || []).map(inquiry => this.#inquiryCard(inquiry));
    const requests = (requestsResult.data || []).map(request => h('article', { class: 'mw-studio-inquiry' },
      h('div', { class: 'mw-studio-inquiry-head' },
        h('div', {}, h('b', {}, request.service?.title || t('studioService')),
          h('small', { class: 'muted' }, ago(request.created_at))),
        h('span', { class: `mw-studio-request-status ${request.status}` }, t(`studioStatus_${request.status}`))),
      h('p', {}, request.message),
      request.preferred_at ? h('p', { class: 'muted' }, `${t('studioPreferredTime')}: ${new Date(request.preferred_at).toLocaleString()}`) : null,
      request.creator_reply ? h('p', { class: 'mw-studio-reply' }, `${t('studioProviderReply')}: ${request.creator_reply}`) : null));
    content.replaceChildren(
      h('div', { class: 'mw-studio-section-head' },
        h('div', {}, h('h3', {}, t('studioBusiness')), h('p', { class: 'muted' }, t('studioBusinessHint')))),
      h('section', { class: 'mw-studio-panel' }, h('h4', {}, t('studioAddService')), form),
      h('section', { class: 'mw-studio-panel' }, h('h4', {}, t('studioPortfolio')),
        services.length ? h('div', { class: 'mw-studio-service-list' }, ...services) : h('p', { class: 'muted' }, t('studioNoServices'))),
      h('section', { class: 'mw-studio-panel' }, h('h4', {}, t('studioInquiries')),
        inquiries.length ? h('div', { class: 'mw-studio-inquiry-list' }, ...inquiries) : h('p', { class: 'muted' }, t('studioNoInquiries'))),
      h('section', { class: 'mw-studio-panel' }, h('h4', {}, t('studioMyRequests')),
        requests.length ? h('div', { class: 'mw-studio-inquiry-list' }, ...requests) : h('p', { class: 'muted' }, t('studioNoRequests'))));
  }

  #inquiryCard(inquiry) {
    const reply = h('textarea', { class: 'field area', maxlength: '500', placeholder: t('studioReplyPlaceholder') });
    reply.value = inquiry.creator_reply || '';
    const status = h('select', { class: 'field', 'aria-label': t('studioInquiryStatus') },
      ...['pending', 'accepted', 'declined', 'completed'].map(value => h('option', { value, selected: inquiry.status === value }, t(`studioStatus_${value}`))));
    const note = h('p', { class: 'muted', role: 'status' });
    return h('article', { class: 'mw-studio-inquiry' },
      h('div', { class: 'mw-studio-inquiry-head' },
        h('div', {}, h('b', {}, inquiry.service?.title || t('studioService')),
          h('small', { class: 'muted' }, `${inquiry.client_name || t('studioClient')} · ${ago(inquiry.created_at)}`)),
        status),
      h('p', {}, inquiry.message),
      inquiry.preferred_at ? h('p', { class: 'muted' }, `${t('studioPreferredTime')}: ${new Date(inquiry.preferred_at).toLocaleString()}`) : null,
      reply,
      h('button', { class: 'pill-btn', type: 'button', onclick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const { error } = await supabase().then(client => client.from('mw_service_inquiries')
            .update({ status: status.value, creator_reply: clean(reply.value) || null })
            .eq('id', inquiry.id));
          if (error) throw error;
          note.textContent = t('studioReplySaved');
          toast(t('studioReplySaved'));
        } catch (error) {
          note.textContent = error?.message || t('retry');
        } finally {
          button.disabled = false;
        }
      } }, t('studioSaveInquiry')), note);
  }

  async #removeService(id) {
    if (!confirm(t('studioRemoveServiceConfirm'))) return;
    try {
      const sb = await supabase();
      const { error } = await sb.from('mw_creator_services').delete().eq('id', id).eq('creator_id', auth.userId);
      if (error) throw error;
      toast(t('remove'));
      this.#show('business');
    } catch (error) {
      toast(error?.message || t('retry'));
    }
  }

  #editService(service, card) {
    const title = h('input', { class: 'field', minlength: '2', maxlength: '80', value: service.title, required: true });
    const category = h('input', { class: 'field', minlength: '2', maxlength: '60', value: service.category, required: true });
    const pricing = h('input', { class: 'field', maxlength: '100', value: service.pricing || '' });
    const description = h('textarea', { class: 'field area', minlength: '10', maxlength: '1000', required: true }, service.description);
    const note = h('p', { class: 'muted', role: 'status' });
    const form = h('form', { class: 'mw-studio-service-form', onsubmit: async event => {
        event.preventDefault();
        const save = form.querySelector('[type="submit"]');
        save.disabled = true;
        try {
          const sb = await supabase();
          const { error } = await sb.from('mw_creator_services').update({
            title: clean(title.value),
            category: clean(category.value),
            pricing: clean(pricing.value),
            description: clean(description.value),
            updated_at: new Date().toISOString(),
          }).eq('id', service.id).eq('creator_id', auth.userId);
          if (error) throw error;
          toast(t('settingsSaved'));
          this.#show('business');
        } catch (error) {
          note.textContent = error?.message || t('retry');
          save.disabled = false;
        }
      } }, title, category, pricing, description,
      h('div', { class: 'mw-studio-service-actions' },
        h('button', { class: 'pill-btn hot', type: 'submit' }, t('save')),
        h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#show('business') }, t('cancel'))), note);
        card.replaceWith(form);
        title.focus();
  }
}

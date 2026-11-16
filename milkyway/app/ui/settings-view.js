// Nova menu: privacy, gift coins, MilkyWay Studio, email / phone / password, online status and language.
// Everything is saved as the signed-in user: Supabase Auth for email and password, the site API for the rest.
import { config } from '../config.js';
import { t, lang, languages, setLanguage } from '../core/i18n.js';
import { api, auth, supabase } from '../core/net.js';
import { presence } from '../data/presence.js';
import { catalog, wallet } from '../data/gifts.js';
import { Sheet } from './sheet.js';
import { h, icon, avatar, count, ago, toast } from './dom.js';
import { isOwnerAccount, ownerVerified } from './admin-view.js';

let adminView = null;
const openAdmin = () => (adminView ||= import('./admin-view.js').then(m => new m.AdminView())).then(view => view.open());
// Members fill in their wallet details (phone number, account name) before the wallet opens.
const walletReady = () => import('./wallet-onboarding.js').then(m => m.ensureWalletProfile()).catch(() => false);

const ACCOUNT = `${config.api.base}/milkyway-account`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLAY_PRODUCTS = `${config.api.wallet}?action=play-products`;
const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.6 4.6 1.4-1.4 8.8 8.8-8.8 8.8-1.4-1.4L16 12z"/></svg>';

function googlePlayBilling() {
  const capacitor = globalThis.Capacitor;
  if (capacitor?.getPlatform?.() !== 'android') return null;
  return capacitor.Plugins?.NativePurchases || capacitor.registerPlugin?.('NativePurchases') || null;
}

async function purchaseAccountToken() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(auth.userId));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function toggle(label, checked, onchange, hint = '') {
  const input = h('input', { type: 'checkbox', class: 'lc-switch', role: 'switch' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('label', { class: 'lc-toggle nova-toggle' }, h('span', {}, label, hint ? h('small', { class: 'muted' }, hint) : null), input);
}
function row(emoji, label, { detail = '', onclick } = {}) {
  const value = h('small', { class: 'muted nova-row-detail' }, detail);
  const node = h('button', { class: 'nova-row', type: 'button', onclick }, h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, emoji), h('span', { class: 'nova-row-label' }, label), value, h('span', { class: 'nova-row-go', html: chevron }));
  node.detail = value;
  return node;
}
const status = () => h('p', { class: 'muted center', role: 'status' });
const fail = (node, error) => { node.textContent = error?.message || t('retry'); };

async function renderPlayCoinPackages(container, balance, note) {
  const billing = googlePlayBilling();
  if (!billing) return;
  container.hidden = false;
  container.replaceChildren(h('p', { class: 'nova-section' }, t('topUp')));
  const options = h('div', { class: 'play-topup-list' });
  container.append(options);

  try {
    const [available, support] = await Promise.all([
      api(PLAY_PRODUCTS, { authed: false, timeout: 12000 }),
      billing.isBillingSupported(),
    ]);
    if (!support?.isBillingSupported) throw new Error('Google Play Billing is unavailable on this device.');
    const packs = Array.isArray(available?.products) ? available.products : [];
    if (!packs.length) throw new Error('Coin packages are not configured for Google Play.');
    const { products = [] } = await billing.getProducts({
      productIdentifiers: packs.map(pack => pack.productId),
      productType: 'inapp',
    });
    const byId = new Map(products.map(product => [product.identifier, product]));
    const visiblePacks = packs.filter(pack => byId.has(pack.productId));
    if (!visiblePacks.length) throw new Error('Coin packages are not available in Google Play yet.');

    const updateBalance = result => {
      const coins = Number(result?.coins) || 0;
      balance.textContent = count(coins);
      wallet.mutate({ coins });
    };
    const verifyPurchase = async (productId, purchaseToken) => {
      const client = await supabase();
      const { data: result, error } = await client.functions.invoke('google-play-verify', {
        body: { productId, purchaseToken },
      });
      if (error) {
        let message = error.message || t('retry');
        if (error.context instanceof Response) {
          const details = await error.context.json().catch(() => null);
          if (details?.error) message = details.error;
        }
        throw new Error(message);
      }
      updateBalance(result);
      if (Number(result?.added) > 0) note.textContent = `+${count(Number(result.added))} ${t('coins')}`;
      else note.textContent = `${t('balance')}: ${count(Number(result?.coins) || 0)} ${t('coins')}`;
      return result;
    };

    for (const pack of visiblePacks) {
      const product = byId.get(pack.productId);
      const button = h('button', {
        class: 'play-topup-option',
        type: 'button',
        onclick: async () => {
          if (button.disabled) return;
          button.disabled = true;
          note.textContent = t('loading');
          let transaction = null;
          try {
            const appAccountToken = await purchaseAccountToken();
            transaction = await billing.purchaseProduct({
              productIdentifier: pack.productId,
              productType: 'inapp',
              appAccountToken,
              autoAcknowledgePurchases: false,
              isConsumable: false,
            });
            if (transaction.purchaseState === '2') {
              note.textContent = 'Google Play payment is pending. Coins will be added after it completes.';
              return;
            }
            if (transaction.purchaseState !== '1' || !transaction.purchaseToken) {
              throw new Error('Google Play has not confirmed this purchase.');
            }
            await verifyPurchase(pack.productId, transaction.purchaseToken);
          } catch (error) {
            note.textContent = error?.message || t('retry');
            if (transaction?.purchaseToken) {
              try {
                const current = await wallet.refresh();
                if (current) balance.textContent = count(Number(current.coins) || 0);
              } catch (refreshError) {
                console.warn('[wallet] balance refresh failed after purchase verification error', refreshError);
              }
            }
          } finally {
            button.disabled = false;
          }
        },
      },
      h('span', { class: 'play-topup-coins' }, `${count(Number(pack.coins) || 0)} ${t('coins')}`),
      h('span', { class: 'play-topup-price' }, product.priceString || ''));
      options.append(button);
    }

    try {
      const appAccountToken = await purchaseAccountToken();
      const { purchases = [] } = await billing.getPurchases({
        productType: 'inapp',
        appAccountToken,
      });
      for (const purchase of purchases) {
        if (purchase.purchaseState !== '1' || !purchase.purchaseToken
          || !visiblePacks.some(pack => pack.productId === purchase.productIdentifier)) continue;
        try {
          note.textContent = t('loading');
          await verifyPurchase(purchase.productIdentifier, purchase.purchaseToken);
        } catch (error) {
          console.error('[wallet] pending Google Play purchase could not be verified', error);
          note.textContent = error?.message || t('retry');
        }
      }
    } catch (error) {
      console.error('[wallet] pending Google Play purchases could not be checked', error);
      note.textContent = error?.message || t('retry');
    }
  } catch (error) {
    console.error('[wallet] Google Play coin packages could not be loaded', error);
    options.replaceChildren(h('p', { class: 'muted center', role: 'status' }, error?.message || t('retry')));
  }
}

export class NovaMenu {
  constructor({ onSignedOut, openStudioPost } = {}) {
    this.hooks = { onSignedOut, openStudioPost };
    this.sheet = new Sheet({ title: t('menu'), className: 'nova-sheet', onClose: () => this.studioView?.stop() });
    this.content = h('div', { class: 'nova-menu' });
    this.sheet.body.append(this.content);
    presence.subscribe(() => this.#paintPresence());
  }

  open(profile = {}) {
    this.profile = profile;
    presence.start();
    this.#home();
    this.sheet.open();
  }

  async openWallet() {
    this.open(this.profile || {});
    if (await walletReady()) this.#wallet();
  }

  #screen(title, ...children) {
    this.sheet.title = title;
    this.content.replaceChildren(
      h('button', { class: 'link nova-back', type: 'button', onclick: () => this.#home() }, `‹ ${t('back')}`),
      ...children);
    this.content.scrollTop = 0;
  }

  #paintPresence() {
    if (this.onlineBadge) {
      const visible = presence.visible;
      this.onlineBadge.className = `nova-online${visible ? ' on' : ''}`;
      this.onlineBadge.textContent = visible ? t('online') : t('hiddenStatus');
    }
    if (this.activeLine) this.activeLine.textContent = `${count(presence.count)} ${t('activeUsers')}`;
  }

  // ---- Main menu -----------------------------------------------------------------------------------------
  #home() {
    this.studioView?.stop();
    this.sheet.title = t('menu');
    const person = { id: auth.userId, name: this.profile?.name || auth.name, avatar: this.profile?.avatar || '' };
    this.onlineBadge = h('span', {});
    this.activeLine = h('small', { class: 'muted' });
    const coins = row('🪙', t('giftBalance'), { detail: '…', onclick: async () => { if (await walletReady()) this.#wallet(); } });
    const languageName = languages.find(item => item.code === lang)?.name || 'English';
    // Gold Admin dashboard button: shown straight away for the owner's account (masiyatunda@gmail.com). Every admin
    // action is checked again on the server, so this only decides what the owner sees.
    const adminSlot = isOwnerAccount()
      ? h('button', { class: 'nova-admin-btn nova-admin-card', type: 'button', onclick: () => { this.sheet.close(); openAdmin(); } },
        h('span', { class: 'nova-admin-icon', 'aria-hidden': 'true' }, '🛡'),
        h('span', { class: 'nova-admin-text' }, h('b', {}, 'Admin dashboard'), h('small', {}, 'Users · Posts · LIVE')),
        h('span', { class: 'nova-admin-go', html: chevron }))
      : null;
    if (adminSlot) ownerVerified();
    this.content.replaceChildren(
      h('div', { class: 'nova-card' },
        h('span', { class: 'presence-avatar online-self' }, avatar(person, 56), h('i', { class: 'presence-dot', 'aria-hidden': 'true' })),
        h('div', { class: 'nova-card-text' }, h('b', {}, person.name), h('small', { class: 'muted' }, auth.user?.email || ''), this.onlineBadge),
        h('button', { class: 'nova-active', type: 'button', title: t('activeNow'), onclick: () => this.#online() }, h('i', { class: 'presence-dot live', 'aria-hidden': 'true' }), this.activeLine)),
      adminSlot,
      h('p', { class: 'nova-section' }, t('settings')),
      row('🔒', t('privacy'), { onclick: () => this.#privacy() }),
      row('📄', t('privacyPolicy'), { onclick: () => { location.href = '/privacy.html'; } }),
      coins,
      row('🎬', t('studio'), { detail: t('studioHint'), onclick: () => this.#studio() }),
      row('🔖', t('savedPosts'), { onclick: () => this.#saved() }),
      h('p', { class: 'nova-section' }, t('account')),
      row('✉️', t('changeEmail'), { detail: auth.user?.email || '', onclick: () => this.#email() }),
      row('📱', t('changePhone'), { onclick: () => this.#phone() }),
      row('🔑', t('changePassword'), { onclick: () => this.#password() }),
      row('🗑️', t('deleteAccount'), { onclick: () => { location.href = '/account-deletion.html'; } }),
      h('p', { class: 'nova-section' }, t('onlineStatus')),
      toggle(t('showOnline'), presence.visible, async on => { await presence.setVisible(on); this.#paintPresence(); toast(t('settingsSaved')); }),
      h('p', { class: 'nova-section' }, t('language')),
      row('🌐', t('language'), { detail: languageName, onclick: () => this.#language() }),
      h('button', { class: 'pill-btn danger wide nova-signout', type: 'button', onclick: () => this.#signOut() }, t('signOut')));
    this.#paintPresence();
    api(`${ACCOUNT}?action=balance`, { timeout: 10000 })
      .then(result => { coins.detail.textContent = `${count(Number(result?.coins) || 0)} ${t('coins')}`; })
      .catch(() => { coins.detail.textContent = ''; });
  }

  // ---- Who is online ---------------------------------------------------------------------------------------
  async #online() {
    const box = h('div', { class: 'nova-list nova-online-list' }, h('p', { class: 'muted center' }, t('loading')));
    this.#screen(`${count(presence.count)} ${t('activeUsers')}`, box);
    const ids = presence.ids.filter(id => /^[a-f0-9-]{36}$/i.test(id)).slice(0, 100);
    if (!ids.length) { box.replaceChildren(h('p', { class: 'muted center' }, t('empty'))); return; }
    let rows = [];
    try { const sb = await supabase(); rows = (await sb.from('mw_profiles').select('id,display_name,username,avatar_url').in('id', ids)).data || []; } catch {}
    const byId = new Map(rows.map(row => [row.id, row]));
    box.replaceChildren(...ids.map(id => {
      const row = byId.get(id) || {};
      const person = { id, name: row.display_name || row.username || (id === auth.userId ? auth.name : 'MilkyWay'), avatar: row.avatar_url || '' };
      return h('div', { class: 'nova-list-row' },
        h('span', { class: 'presence-avatar online' }, avatar(person, 40), h('i', { class: 'presence-dot', 'aria-hidden': 'true' })),
        h('div', { class: 'chat-text' }, h('b', {}, person.name), h('span', { class: 'presence-label' }, id === auth.userId ? t('online') : t('activeNow'))));
    }));
  }

  // ---- Privacy ---------------------------------------------------------------------------------------------
  async #privacy() {
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted center' }, t('loading')));
    this.#screen(t('privacy'), box);
    let prefs;
    try { prefs = (await api(`${ACCOUNT}?action=preferences`, { timeout: 10000 }))?.preferences || {}; }
    catch (error) { box.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry'))); return; }
    const save = async (patch, input) => {
      try {
        const result = await api(`${ACCOUNT}?action=preferences`, { method: 'POST', body: patch, timeout: 12000 });
        prefs = result?.preferences || { ...prefs, ...patch };
        toast(t('settingsSaved'));
      } catch (error) {
        if (input) input.checked = !input.checked;
        toast(error?.message || t('retry'));
      }
    };
    const messages = h('div', { class: 'segmented nova-seg' }, ...['everyone', 'followers', 'nobody'].map(value => {
      const input = h('input', { type: 'radio', name: 'mwAllowMessages', value });
      input.checked = (prefs.allowMessages || 'everyone') === value;
      input.addEventListener('change', () => save({ allowMessages: value }));
      return h('label', {}, input, h('span', {}, value === 'everyone' ? t('everyone') : value === 'followers' ? t('followersOnly') : t('nobody')));
    }));
    box.replaceChildren(
      toggle(t('privateAccount'), prefs.isPrivate, (on, input) => save({ isPrivate: on }, input), t('privateAccountHint')),
      h('p', { class: 'nova-section' }, t('whoCanMessage')), messages,
      h('p', { class: 'nova-section' }, t('notifications')),
      toggle(t('notifyFollow'), prefs.notifyFollow !== false, (on, input) => save({ notifyFollow: on }, input)),
      toggle(t('notifyEcho'), prefs.notifyEcho !== false, (on, input) => save({ notifyEcho: on }, input)),
      toggle(t('notifySignal'), prefs.notifySignal !== false, (on, input) => save({ notifySignal: on }, input)),
      h('p', { class: 'nova-section' }, t('onlineStatus')),
      toggle(t('showOnline'), presence.visible, async on => { await presence.setVisible(on); toast(t('settingsSaved')); }));
  }

  // ---- Gift coins -------------------------------------------------------------------------------------------
  async #wallet() {
    this.studioView?.stop();
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted center' }, t('loading')));
    this.#screen(t('giftBalance'), box);
    try {
      const [info, gifts] = await Promise.all([api(`${config.api.wallet}?action=wallet`, { timeout: 12000 }), catalog.load().catch(() => [])]);
      const icons = new Map((gifts || catalog.value || []).map(item => [item.key, item.icon]));
      const code = h('input', { class: 'field', maxlength: '40', placeholder: 'XXXX-XXXX', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': t('topUp') });
      const note = status();
      const balance = h('b', { class: 'nova-big' }, count(Number(info?.coins) || 0));
      const playTopups = h('div', { class: 'play-topups', hidden: true });
      const received = Array.isArray(info?.received) ? info.received : [];
      const topups = Array.isArray(info?.topups) ? info.topups : [];
      const withdrawals = Array.isArray(info?.withdrawals) ? info.withdrawals : [];
      const transactions = [
        ...received.map(item => ({ kind: t('giftsReceived'), icon: icons.get(item.gift) || '🎁', detail: item.from || 'MilkyWay', at: item.at, coins: Number(item.earned) || 0 })),
        ...topups.map(item => ({ kind: t('topUp'), icon: '⬇️', detail: t(`studioStatus_${item.status}`), at: item.at, coins: Number(item.coins) || 0 })),
        ...withdrawals.map(item => ({ kind: t('studioWithdrawal'), icon: '⬆️', detail: t(`studioStatus_${item.status}`), at: item.at, coins: -(Number(item.coins) || 0) })),
      ].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0)).slice(0, 60);
      box.replaceChildren(
        h('div', { class: 'nova-stats' },
          h('div', {}, h('small', { class: 'muted' }, t('balance')), h('span', {}, '🪙 ', balance)),
          h('div', {}, h('small', { class: 'muted' }, t('earned')), h('b', { class: 'nova-big' }, count(Number(info?.earned) || 0)))),
        playTopups,
        h('form', { class: 'nova-inline', onsubmit: async event => {
          event.preventDefault();
          if (!code.value.trim()) return;
          note.textContent = t('loading');
          try {
            const result = await api(`${config.api.wallet}?action=redeem-topup-code`, { method: 'POST', body: { code: code.value.trim() }, timeout: 15000 });
            balance.textContent = count(Number(result?.coins) || 0);
            wallet.mutate({ coins: Number(result?.coins) || 0 });
            note.textContent = result?.message || `+${count(Number(result?.added) || 0)} ${t('coins')}`;
            code.value = '';
          } catch (error) { fail(note, error); }
        } }, code, h('button', { class: 'pill-btn hot', type: 'submit' }, t('topUp'))),
        note,
        h('p', { class: 'nova-section' }, t('studioTransactions')),
        transactions.length
          ? h('div', { class: 'nova-list' }, ...transactions.map(item => h('div', { class: 'nova-list-row' },
            h('span', { class: 'gift-icon' }, item.icon),
            h('div', { class: 'chat-text' }, h('b', {}, item.kind), h('span', { class: 'muted' }, `${item.detail} · ${ago(item.at)}`)),
            h('em', { class: 'nova-coins' }, `${item.coins > 0 ? '+' : ''}${count(item.coins)}`))))
          : h('p', { class: 'muted center' }, t('empty')));
      await renderPlayCoinPackages(playTopups, balance, note);
    } catch (error) { box.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry'))); }
  }

  // ---- Saved posts --------------------------------------------------------------------------------------------
  async #saved() {
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted center' }, t('loading')));
    this.#screen(t('savedPosts'), box);
    try {
      const list = (await api(`${config.api.feed}?action=saved`, { timeout: 12000 }))?.saved || [];
      const ids = list.map(item => item.postId).slice(0, 100);
      let posts = [];
      if (ids.length) {
        const sb = await supabase();
        const { data, error } = await sb.from('mw_posts').select('id,caption,media_url,media_type,created_at').in('id', ids);
        if (error) throw error;
        const byId = new Map((data || []).map(post => [String(post.id), post]));
        posts = ids.map(id => byId.get(id)).filter(Boolean);
      }
      if (!posts.length) { box.replaceChildren(h('p', { class: 'muted center' }, t('noSaved'))); return; }
      box.replaceChildren(h('div', { class: 'nova-list' }, ...posts.map(post => {
        const remove = h('button', { class: 'pill-btn', type: 'button' }, t('unsave'));
        const node = h('div', { class: 'nova-list-row' },
          h('span', { class: 'nova-kind', 'aria-hidden': 'true' }, /video/.test(post.media_type || '') ? '🎬' : post.media_url ? '🖼' : '✍️'),
          h('div', { class: 'chat-text' }, h('b', {}, (post.caption || t('post')).slice(0, 60)), h('span', { class: 'muted' }, ago(post.created_at))),
          remove);
        remove.onclick = async () => {
          remove.disabled = true;
          try { await api(`${config.api.feed}?action=save`, { method: 'POST', body: { post: post.id, on: false }, timeout: 12000 }); node.remove(); }
          catch (error) { remove.disabled = false; toast(error?.message || t('retry')); }
        };
        return node;
      })));
    } catch (error) { box.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry'))); }
  }

  // ---- MilkyWay Studio -------------------------------------------------------------------------------------
  async #studio() {
    this.#screen(t('studio'));
    const { StudioView } = await import('./studio-view.js');
    this.studioView ||= new StudioView({
      container: this.content,
      setTitle: title => { this.sheet.title = title; },
      onBack: () => this.#home(),
      onWallet: () => this.#wallet(),
      onGoLive: () => { this.sheet.close(); document.querySelector('[data-nav="live"]')?.click(); },
      onCreatePost: () => { this.sheet.close(); this.hooks.openStudioPost?.(); },
      onOpenPost: post => { this.sheet.close(); this.hooks.openStudioPost?.(post); },
    });
    this.studioView.open();
  }

  // ---- Email -----------------------------------------------------------------------------------------------
  #email() {
    const input = h('input', { class: 'field', type: 'email', autocomplete: 'email', placeholder: t('newEmail'), required: true, 'aria-label': t('newEmail') });
    const note = status();
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('update'));
    this.#screen(t('changeEmail'), h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      const email = input.value.trim().toLowerCase();
      if (!EMAIL.test(email)) { note.textContent = t('invalidEmail'); return; }
      submit.disabled = true; note.textContent = t('loading');
      try {
        const sb = await supabase();
        const { error } = await sb.auth.updateUser({ email }, { emailRedirectTo: `${location.origin}/milkyway/` });
        if (error) throw error;
        note.textContent = t('emailSent');
      } catch (error) { fail(note, error); }
      submit.disabled = false;
    } }, h('small', { class: 'muted' }, `${t('currentEmail')}: ${auth.user?.email || '—'}`), input, submit, note));
  }

  // ---- Phone -----------------------------------------------------------------------------------------------
  async #phone() {
    const input = h('input', { class: 'field', type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: '24', placeholder: '+255 7xx xxx xxx', 'aria-label': t('phoneNumber') });
    const note = status();
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('save'));
    this.#screen(t('changePhone'), h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      submit.disabled = true; note.textContent = t('loading');
      try {
        const result = await api(`${ACCOUNT}?action=phone`, { method: 'POST', body: { phone: input.value.trim() }, timeout: 12000 });
        input.value = result?.phone || '';
        note.textContent = t('phoneSaved');
      } catch (error) { fail(note, error); }
      submit.disabled = false;
    } }, h('small', { class: 'muted' }, t('phoneHint')), input, submit, note));
    api(`${ACCOUNT}?action=phone`, { timeout: 10000 }).then(result => { if (!input.value) input.value = result?.phone || ''; }).catch(() => {});
  }

  // ---- Password ----------------------------------------------------------------------------------------------
  #password() {
    const first = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', minlength: '8', placeholder: t('newPassword'), 'aria-label': t('newPassword') });
    const second = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', minlength: '8', placeholder: t('confirmPassword'), 'aria-label': t('confirmPassword') });
    const note = status();
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('changePassword'));
    const resetNote = status();
    const reset = h('button', { class: 'pill-btn wide', type: 'button', onclick: async () => {
      const email = auth.user?.email;
      if (!email) { resetNote.textContent = t('invalidEmail'); return; }
      reset.disabled = true; resetNote.textContent = t('loading');
      try {
        const sb = await supabase();
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/milkyway/` });
        if (error) throw error;
        resetNote.textContent = `${t('resetSent')} ${email}`;
      } catch (error) { fail(resetNote, error); }
      reset.disabled = false;
    } }, t('resetPassword'));
    this.#screen(t('changePassword'),
      h('form', { class: 'stack', onsubmit: async event => {
        event.preventDefault();
        if (first.value.length < 8) { note.textContent = t('passwordRule'); return; }
        if (first.value !== second.value) { note.textContent = t('passwordMismatch'); return; }
        submit.disabled = true; note.textContent = t('loading');
        try {
          const sb = await supabase();
          const { error } = await sb.auth.updateUser({ password: first.value });
          if (error) throw error;
          first.value = ''; second.value = '';
          note.textContent = t('passwordChanged');
        } catch (error) { fail(note, error); }
        submit.disabled = false;
      } }, first, second, submit, note),
      h('p', { class: 'nova-section' }, t('forgotPassword')), reset, resetNote);
  }

  // ---- Language ----------------------------------------------------------------------------------------------
  #language() {
    this.#screen(t('language'), h('p', { class: 'muted center' }, t('languageHint')),
      h('div', { class: 'nova-langs', role: 'radiogroup', 'aria-label': t('language') }, ...languages.map(item =>
        h('button', { class: `nova-lang${item.code === lang ? ' current' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(item.code === lang), lang: item.code, dir: item.dir || 'ltr',
          onclick: () => { if (item.code !== lang) setLanguage(item.code); } },
        h('b', {}, item.name), h('small', { class: 'muted' }, item.code.toUpperCase())))));
  }

  async #signOut() {
    try { const sb = await supabase(); await sb.auth.signOut(); } catch {}
    this.sheet.close();
    this.hooks.onSignedOut?.();
  }
}

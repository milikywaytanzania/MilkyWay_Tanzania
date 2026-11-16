// Gift tray: catalog and balance come from the device cache instantly, then refresh. Works for posts and Lives.
import { t } from '../core/i18n.js';
import { catalog, wallet, sendGift } from '../data/gifts.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

export class GiftTray {
  constructor({ onTopUp } = {}) {
    this.onTopUp = onTopUp;
    this.sheet = new Sheet({ title: t('gift'), className: 'gift-sheet' });
    this.balance = h('b', {}, '–');
    this.grid = h('div', { class: 'gift-grid' });
    this.sendButton = h('button', { class: 'pill-btn hot wide gift-send', type: 'button', disabled: true, onclick: () => this.#sendSelected() }, t('send'));
    this.topUpPrompt = h('div', { class: 'gift-topup-prompt', hidden: true },
      h('p', { class: 'muted center', role: 'status' }, `${t('giftFailed')}: ${t('topUp')}`),
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => {
        this.sheet.close();
        if (this.onTopUp) this.onTopUp();
        else toast(t('topUp'));
      } }, t('topUp')));
    this.sheet.body.append(
      h('div', { class: 'gift-head' }, h('span', {}, '🪙 ', this.balance, ' ', t('coins'))),
      this.grid, this.topUpPrompt, this.sendButton);
    catalog.subscribe(items => this.#render(items));
    wallet.subscribe(value => { this.balance.textContent = String(value?.coins ?? '–'); });
    this.grid.addEventListener('click', event => {
      const button = event.target.closest('[data-gift]');
      if (button) this.#select(button.dataset.gift);
    });
  }

  /** target: { postId } or { room, session } */
  open(target) {
    this.target = target;
    this.selectedGift = null;
    this.topUpPrompt.hidden = true;
    this.sheet.title = `${t('gift')} → ${target.to?.name || ''}`;
    catalog.load(); wallet.load(); wallet.refresh();
    this.#select(null);
    this.sheet.open();
  }

  #render(items) {
    this.grid.replaceChildren(...(items || []).map(item =>
      h('button', { class: `gift-item${item.key === this.selectedGift ? ' selected' : ''}`, type: 'button', 'data-gift': item.key, 'aria-pressed': item.key === this.selectedGift ? 'true' : 'false' },
        h('span', { class: 'gift-icon' }, item.icon), h('small', {}, item.name), h('em', {}, `🪙 ${item.coins}`))));
  }

  #select(key) {
    this.selectedGift = key;
    this.topUpPrompt.hidden = true;
    this.sendButton.disabled = !key;
    this.grid.querySelectorAll('[data-gift]').forEach(button => {
      const selected = button.dataset.gift === key;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  async #sendSelected() {
    const key = this.selectedGift;
    if (!key || this.sendButton.disabled) return;
    const target = this.target;
    const button = [...this.grid.querySelectorAll('[data-gift]')].find(item => item.dataset.gift === key);
    this.sendButton.disabled = true;
    try {
      const ready = await import('./wallet-onboarding.js').then(m => m.ensureWalletProfile());
      if (!ready || !target) return;
      if (target.session) await target.session.gift(key);
      else await sendGift({ gift: key, postId: target.postId });
      button?.classList.add('sent');
      setTimeout(() => button?.classList.remove('sent'), 600);
      if (!target.session) toast(`${catalog.value?.find(item => item.key === key)?.icon || '🎁'} ${t('sent')}`);
    } catch (error) {
      if (error?.status === 402 || /not enough coins/i.test(error?.message || '')) this.topUpPrompt.hidden = false;
      else toast(`${t('giftFailed')}: ${error.message}`);
    } finally { this.sendButton.disabled = !this.selectedGift; }
  }
}

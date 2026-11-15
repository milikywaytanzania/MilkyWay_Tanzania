// Gift tray: catalog and balance come from the device cache instantly, then refresh. Works for posts and Lives.
import { t } from '../core/i18n.js';
import { catalog, wallet, sendGift } from '../data/gifts.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

export class GiftTray {
  constructor() {
    this.sheet = new Sheet({ title: t('gift'), className: 'gift-sheet' });
    this.balance = h('b', {}, '–');
    this.grid = h('div', { class: 'gift-grid' });
    this.sheet.body.append(
      h('div', { class: 'gift-head' }, h('span', {}, '🪙 ', this.balance, ' ', t('coins')), h('button', { class: 'pill-btn', type: 'button', onclick: () => toast(t('soon')) }, t('topUp'))),
      this.grid);
    catalog.subscribe(items => this.#render(items));
    wallet.subscribe(value => { this.balance.textContent = String(value?.coins ?? '–'); });
    this.grid.addEventListener('click', event => {
      const key = event.target.closest('[data-gift]')?.dataset.gift;
      if (key) this.#send(key, event.target.closest('[data-gift]'));
    });
  }

  /** target: { postId } or { room, session } */
  async open(target) {
    // Gift coins need the member's wallet details (phone number, account name) first.
    const ready = await import('./wallet-onboarding.js').then(m => m.ensureWalletProfile()).catch(() => false);
    if (!ready) return;
    this.target = target;
    this.sheet.title = `${t('gift')} → ${target.to?.name || ''}`;
    catalog.load(); wallet.load(); wallet.refresh();
    this.sheet.open();
  }

  #render(items) {
    this.grid.replaceChildren(...(items || []).map(item =>
      h('button', { class: 'gift-item', type: 'button', 'data-gift': item.key },
        h('span', { class: 'gift-icon' }, item.icon), h('small', {}, item.name), h('em', {}, `🪙 ${item.coins}`))));
  }

  async #send(key, button) {
    button.disabled = true;
    try {
      if (this.target.session) await this.target.session.gift(key);
      else await sendGift({ gift: key, postId: this.target.postId });
      button.classList.add('sent');
      setTimeout(() => button.classList.remove('sent'), 600);
      if (!this.target.session) toast(`${catalog.value?.find(item => item.key === key)?.icon || '🎁'} ${t('sent')}`);
    } catch (error) { toast(`${t('giftFailed')}: ${error.message}`); }
    finally { button.disabled = false; }
  }
}

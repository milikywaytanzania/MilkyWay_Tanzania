// Wallet onboarding: before a member opens the coin wallet or sends gift coins, they fill in their basic details
// (phone number and account name). Saved with /api/milkyway-account?action=wallet-profile; once complete it is
// remembered on this device so the wallet opens instantly next time.
import { config } from '../config.js';
import { t } from '../core/i18n.js';
import { api, auth } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h } from './dom.js';

const ENDPOINT = `${config.api.base}/milkyway-account?action=wallet-profile`;
const L = (key, fallback) => { const value = t(key); return value && value !== key ? value : fallback; };
const storageKey = () => `mw-wallet-ready:${auth.userId || ''}`;
const remembered = () => { try { return Boolean(auth.userId) && localStorage.getItem(storageKey()) === '1'; } catch { return false; } };
const remember = () => { try { localStorage.setItem(storageKey(), '1'); } catch {} };

let sheet = null;
let pending = null;

/** Resolves true when the signed-in member has completed their wallet details (asking for them first if needed). */
export async function ensureWalletProfile() {
  if (!auth.userId) return false;
  if (remembered()) return true;
  let profile = null;
  try { profile = await api(ENDPOINT, { timeout: 10000 }); } catch { profile = null; }
  if (profile?.complete) { remember(); return true; }
  return ask(profile || {});
}

function ask(profile) {
  if (pending) return pending;
  pending = new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; pending = null; resolve(ok); };
    sheet ||= new Sheet({ title: L('walletSetupTitle', 'Wallet details'), className: 'wallet-setup-sheet' });
    sheet.onClose = () => finish(false);

    const name = h('input', { class: 'field', type: 'text', name: 'accountName', autocomplete: 'name', maxlength: '80', required: true,
      placeholder: L('accountNamePlaceholder', 'Full name on the account'), value: profile.accountName || '' });
    const phone = h('input', { class: 'field', type: 'tel', name: 'phone', autocomplete: 'tel', inputmode: 'tel', maxlength: '24', required: true,
      placeholder: '+255 7xx xxx xxx', value: profile.phone || '' });
    const note = h('p', { class: 'muted center ws-note', role: 'status' });
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, L('continue', 'Continue'));
    const field = (label, input) => h('label', { class: 'ws-field' }, h('span', {}, label, h('i', { class: 'ws-req', 'aria-hidden': 'true' }, '*')), input);

    const form = h('form', { class: 'ws-form', novalidate: true, onsubmit: async event => {
      event.preventDefault();
      const accountName = name.value.trim().replace(/\s+/g, ' ');
      const number = phone.value.trim();
      const digits = number.replace(/\D/g, '');
      if (accountName.length < 2) { note.textContent = L('accountNameRequired', 'Enter the account name.'); name.focus(); return; }
      if (!/^\+?[\d\s().-]{6,24}$/.test(number) || digits.length < 8 || digits.length > 15) { note.textContent = L('phoneRequired', 'Enter a valid phone number.'); phone.focus(); return; }
      submit.disabled = true; note.textContent = t('loading');
      try {
        const result = await api(ENDPOINT, { method: 'POST', body: { accountName, phone: number }, timeout: 15000 });
        if (!result?.complete) throw new Error(t('retry'));
        remember();
        sheet.onClose = null;
        sheet.close();
        finish(true);
      } catch (error) {
        note.textContent = error?.message || t('retry');
        submit.disabled = false;
      }
    } },
    h('div', { class: 'ws-intro' }, h('span', { class: 'ws-icon', 'aria-hidden': 'true' }, '🪙'),
      h('p', {}, L('walletSetupIntro', 'Fill in your basic details to use your wallet and send gift coins. These are kept private and used for top-ups and payouts.'))),
    field(L('accountName', 'Account name'), name),
    field(L('phoneNumber', 'Phone number'), phone),
    submit, note);

    sheet.body.replaceChildren(form);
    sheet.open();
  });
  return pending;
}

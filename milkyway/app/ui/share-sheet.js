// Fixed share sheet used by LIVE, Orbit and post detail actions.
import { t } from '../core/i18n.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

let tray;

function nativeSharePlugin() {
  const capacitor = globalThis.Capacitor;
  if (typeof capacitor?.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) return null;
  const plugin = capacitor.Plugins?.Share || capacitor.registerPlugin?.('Share');
  return typeof plugin?.share === 'function' ? plugin : null;
}

function hasDeviceShare() {
  return Boolean(nativeSharePlugin() || typeof navigator.share === 'function');
}

function sharePayload(current) {
  return [current.text, current.url].filter(Boolean).join(' ');
}

function platformOptions(current) {
  const message = sharePayload(current);
  const encoded = encodeURIComponent(message);
  const url = encodeURIComponent(current.url);
  const title = encodeURIComponent(current.title);
  return [
    { name: 'WhatsApp', mark: 'WA', className: 'whatsapp', href: `https://wa.me/?text=${encoded}` },
    { name: 'Facebook', mark: 'f', className: 'facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${url}&quote=${encodeURIComponent(current.text || current.title)}` },
    { name: 'Telegram', mark: '➤', className: 'telegram', href: `https://t.me/share/url?url=${url}&text=${encodeURIComponent([current.title, current.text].filter(Boolean).join(' '))}` },
    { name: 'X', mark: '𝕏', className: 'x', href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(current.text || current.title)}&url=${url}` },
    { name: t('sms'), mark: 'SMS', className: 'sms', href: `sms:?body=${encoded}`, sms: true },
  ];
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; }
    catch { /* Continue with the selection-based fallback. */ }
  }
  const field = h('textarea', { readonly: '', 'aria-hidden': 'true', tabindex: '-1' });
  field.value = value;
  field.style.cssText = 'position:fixed;inset:auto auto 0 0;width:1px;height:1px;opacity:0;font-size:16px';
  document.body.append(field);
  let copied = false;
  try { field.focus({ preventScroll: true }); field.select(); copied = document.execCommand('copy'); }
  finally { field.remove(); }
  return copied;
}

function shareWithDevice(current) {
  if (current.sharing) return;
  const plugin = nativeSharePlugin();
  if (!plugin && typeof navigator.share !== 'function') return;
  current.sharing = true;
  current.native.disabled = true;
  let result;
  try {
    const data = { title: current.title, text: current.text, url: current.url };
    if (plugin) result = plugin.share({ ...data, dialogTitle: t('share') });
    else {
      if (typeof navigator.canShare === 'function' && !navigator.canShare(data)) {
        throw new Error('This content cannot be shared by this browser.');
      }
      result = navigator.share(data);
    }
  } catch (error) {
    current.sharing = false;
    current.native.disabled = false;
    if (error?.name !== 'AbortError') toast(error?.message || t('retry'));
    return;
  }
  Promise.resolve(result).then(() => current.sheet.close()).catch(error => {
    if (error?.name === 'AbortError') return;
    toast(error?.message || t('retry'));
  }).finally(() => {
    current.sharing = false;
    current.native.disabled = false;
  });
}

function getTray() {
  if (tray) return tray;
  const sheet = new Sheet({ title: t('share'), className: 'share-sheet', autoFocus: false });
  const description = h('p', { class: 'share-description' });
  const url = h('input', { class: 'field share-url', type: 'url', readonly: '', 'aria-label': t('shareLink') });
  const options = h('div', { class: 'share-options', role: 'group', 'aria-label': t('share') });
  const copy = h('button', { class: 'pill-btn hot wide', type: 'button' }, t('copyLink'));
  const native = h('button', { class: 'pill-btn wide', type: 'button' }, t('shareUsingDevice'));
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    try {
      if (!await copyText(url.value)) throw new Error(t('copyUnavailable'));
      toast(t('linkCopied'));
      sheet.close();
    } catch (error) { toast(error?.message || t('retry')); }
    finally { copy.disabled = false; }
  });
  native.addEventListener('click', () => shareWithDevice(tray));
  sheet.body.append(description, options, url, native, copy);
  tray = { sheet, description, options, urlInput: url, native, title: '', text: '', url: '' };
  return tray;
}

export function openShare({ title = 'MilkyWay', text = '', url } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    toast(t('retry'));
    return;
  }
  const current = getTray();
  current.title = title;
  current.text = text;
  current.url = url;
  current.description.textContent = text || title;
  current.urlInput.value = url;
  current.native.hidden = !hasDeviceShare();
  current.options.replaceChildren(...platformOptions(current).map(option => h('a', {
    class: `share-option share-option--${option.className}`,
    href: option.href,
    target: option.sms ? null : '_blank',
    rel: option.sms ? null : 'noopener noreferrer',
    'aria-label': `${t('share')} ${option.name}`,
  }, h('span', { class: 'share-option-mark', 'aria-hidden': 'true' }, option.mark), h('span', { class: 'share-option-name' }, option.name))));
  current.sheet.open();
}

// Fixed share sheet used by LIVE, Orbit and post detail actions.
import { t } from '../core/i18n.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

let tray;

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

function shareWithDevice(current, { openFallback = false } = {}) {
  if (current.sharing || typeof navigator.share !== 'function') return;
  current.sharing = true;
  current.native.disabled = true;
  let result;
  try {
    result = navigator.share({ title: current.title, text: current.text, url: current.url });
  } catch (error) {
    current.sharing = false;
    current.native.disabled = false;
    if (openFallback) current.sheet.open();
    else if (error?.name !== 'AbortError') toast(error?.message || t('retry'));
    return;
  }
  Promise.resolve(result).then(() => current.sheet.close()).catch(error => {
    if (error?.name === 'AbortError') return;
    if (openFallback) current.sheet.open();
    else toast(error?.message || t('retry'));
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
  sheet.body.append(description, url, native, copy);
  tray = { sheet, description, urlInput: url, native, title: '', text: '', url: '' };
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
  current.native.hidden = typeof navigator.share !== 'function';
  if (!current.native.hidden) {
    shareWithDevice(current, { openFallback: true });
    return;
  }
  current.sheet.open();
}

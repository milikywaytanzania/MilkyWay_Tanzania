// Sign-in sheet (email + password through supabase-js, loaded only when this opens).
import { t, lang, languages, setLanguage } from '../core/i18n.js';
import { supabase } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

export class AuthSheet {
  constructor() {
    this.sheet = new Sheet({ title: t('signIn'), className: 'auth-sheet' });
    const email = h('input', { class: 'field', type: 'email', autocomplete: 'email', placeholder: t('email'), required: true });
    const password = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', placeholder: t('password'), required: true });
    const message = h('p', { class: 'muted', role: 'status' });
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('signIn'));
    this.sheet.body.append(h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      submit.disabled = true; message.textContent = t('loading');
      try {
        const sb = await supabase();
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
        if (error) throw error;
        password.value = ''; message.textContent = '';
        this.sheet.close();
        toast('✓');
      } catch (error) { message.textContent = error.message || 'Sign-in failed'; }
      finally { submit.disabled = false; }
    } }, email, password, submit, message,
    h('button', { class: 'link center', type: 'button', onclick: () => toast(t('soon')) }, t('createAccount'))),
    // Language can be picked before signing in (the signed-in Nova menu has the same list).
    h('label', { class: 'auth-lang' }, h('span', { 'aria-hidden': 'true' }, '🌐'),
      h('select', { class: 'field', 'aria-label': t('language'), onchange: event => setLanguage(event.target.value) },
        ...languages.map(item => h('option', { value: item.code, selected: item.code === lang }, item.name)))));
  }
  open() { this.sheet.open(); }
}

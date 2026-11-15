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
    const confirmation = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: t('confirmPassword'), minlength: 8, hidden: true });
    const message = h('p', { class: 'muted', role: 'status' });
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('signIn'));
    const switchMode = h('button', { class: 'link center', type: 'button' }, t('createAccount'));
    const policyLink = h('a', { class: 'link center', href: '/privacy.html' }, t('privacyPolicy'));
    let mode = 'signin';
    const setMode = next => {
      mode = next;
      const creating = mode === 'signup';
      this.sheet.title = creating ? t('createAccount') : t('signIn');
      submit.textContent = this.sheet.title;
      switchMode.textContent = creating ? t('haveAccount') : t('createAccount');
      confirmation.hidden = !creating;
      confirmation.required = creating;
      password.autocomplete = creating ? 'new-password' : 'current-password';
      password.minLength = creating ? 8 : 0;
      message.textContent = '';
    };
    switchMode.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
    this.sheet.body.append(h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      submit.disabled = true; message.textContent = t('loading');
      try {
        const sb = await supabase();
        if (mode === 'signup' && password.value !== confirmation.value) throw new Error(t('passwordMismatch'));
        const result = mode === 'signup'
          ? await sb.auth.signUp({ email: email.value.trim(), password: password.value, options: { emailRedirectTo: `${location.origin}/milkyway/` } })
          : await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
        const { data, error } = result;
        if (error) throw error;
        password.value = ''; confirmation.value = '';
        if (mode === 'signup' && !data.session) {
          message.textContent = t('confirmEmailSent');
          return;
        }
        message.textContent = '';
        this.sheet.close();
        toast(mode === 'signup' ? t('accountCreated') : '✓');
      } catch (error) { message.textContent = error.message || 'Sign-in failed'; }
      finally { submit.disabled = false; }
    } }, email, password, confirmation, submit, message, switchMode, policyLink),
    // Language can be picked before signing in (the signed-in Nova menu has the same list).
    h('label', { class: 'auth-lang' }, h('span', { 'aria-hidden': 'true' }, '🌐'),
      h('select', { class: 'field', 'aria-label': t('language'), onchange: event => setLanguage(event.target.value) },
        ...languages.map(item => h('option', { value: item.code, selected: item.code === lang }, item.name)))));
  }
  open() { this.sheet.open(); }
}

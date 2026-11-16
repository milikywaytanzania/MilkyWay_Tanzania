// Sign-in sheet (email + password through supabase-js, loaded only when this opens).
import { t, lang, languages, setLanguage } from '../core/i18n.js';
import { supabase } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h, icon, toast } from './dom.js';

const PENDING_OAUTH_USERNAME = 'mw_pending_oauth_username';

function passwordControl(input) {
  const toggle = h('button', {
    class: 'auth-password-toggle',
    type: 'button',
    'aria-label': t('showPassword'),
    'aria-pressed': 'false',
    onclick: () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      toggle.setAttribute('aria-label', t(visible ? 'hidePassword' : 'showPassword'));
      toggle.setAttribute('aria-pressed', String(visible));
    },
  }, h('span', { html: icon.eye }));
  return h('div', { class: 'auth-password-field' }, input, toggle);
}

export class AuthSheet {
  constructor() {
    this.sheet = new Sheet({ title: t('signIn'), className: 'auth-sheet' });
    const username = h('input', {
      class: 'field', type: 'text', autocomplete: 'username', autocapitalize: 'none',
      placeholder: t('username'), 'aria-label': t('username'), minlength: 2, maxlength: 30,
      pattern: '[A-Za-z0-9._]{2,30}', title: t('usernameRule'),
    });
    const email = h('input', {
      class: 'field', type: 'email', autocomplete: 'email', placeholder: t('email'),
      'aria-label': t('email'), required: true,
    });
    const password = h('input', {
      class: 'field', type: 'password', autocomplete: 'current-password',
      placeholder: t('password'), 'aria-label': t('password'), required: true,
    });
    const confirmation = h('input', {
      class: 'field', type: 'password', autocomplete: 'new-password',
      placeholder: t('confirmPassword'), 'aria-label': t('confirmPassword'), minlength: 8,
    });
    const usernameWrap = h('div', { class: 'auth-field-wrap', hidden: true }, username);
    const confirmationWrap = h('div', { class: 'auth-field-wrap', hidden: true }, passwordControl(confirmation));
    const message = h('p', { class: 'muted auth-message', role: 'status', 'aria-live': 'polite' });
    const submit = h('button', { class: 'pill-btn hot wide auth-submit', type: 'submit' }, t('signIn'));
    const switchMode = h('button', { class: 'link center auth-switch', type: 'button' }, t('createAccount'));
    const policyLink = h('a', { class: 'link center', href: '/privacy.html' }, t('privacyPolicy'));
    const forgotPassword = h('button', {
      class: 'link auth-forgot', type: 'button',
      onclick: async () => {
        if (!email.value.trim() || !email.checkValidity()) { email.reportValidity(); return; }
        forgotPassword.disabled = true;
        message.textContent = t('loading');
        try {
          const sb = await supabase();
          const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), {
            redirectTo: `${location.origin}/milkyway/`,
          });
          if (error) throw error;
          message.textContent = `${t('resetSent')} ${email.value.trim()}.`;
        } catch (error) {
          message.textContent = error.message || 'Could not send the password reset link.';
        } finally {
          forgotPassword.disabled = false;
        }
      },
    }, t('forgotPassword'));
    const google = h('button', {
      class: 'auth-google',
      type: 'button',
      onclick: async () => {
        if (mode === 'signup') {
          username.value = username.value.trim().toLowerCase();
          if (!username.reportValidity()) return;
          try {
            localStorage.setItem(PENDING_OAUTH_USERNAME, JSON.stringify({
              username: username.value,
              startedAt: Date.now(),
            }));
          } catch {
            message.textContent = 'Could not save your username for Google sign-up. Check your browser storage settings.';
            return;
          }
        }
        google.disabled = true;
        message.textContent = t('loading');
        try {
          const sb = await supabase();
          const { error } = await sb.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: `${location.origin}/milkyway/` },
          });
          if (error) throw error;
        } catch (error) {
          try { localStorage.removeItem(PENDING_OAUTH_USERNAME); } catch {}
          message.textContent = error.message || 'Google sign-in failed.';
          google.disabled = false;
        }
      },
    }, h('span', { class: 'auth-google-mark', 'aria-hidden': 'true' }, 'G'), t('continueWithGoogle'));
    let mode = 'signin';
    const setMode = next => {
      mode = next;
      const creating = mode === 'signup';
      this.sheet.title = creating ? t('createAccount') : t('signIn');
      submit.textContent = creating ? t('createAccount') : t('signIn');
      switchMode.textContent = creating ? t('haveAccount') : t('createAccount');
      usernameWrap.hidden = !creating;
      username.required = creating;
      confirmationWrap.hidden = !creating;
      confirmation.required = creating;
      forgotPassword.hidden = creating;
      password.autocomplete = creating ? 'new-password' : 'current-password';
      password.minLength = creating ? 8 : 0;
      message.textContent = '';
    };
    switchMode.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
    const form = h('form', {
      class: 'stack auth-form',
      onsubmit: async event => {
        event.preventDefault();
        submit.disabled = true;
        message.textContent = t('loading');
        try {
          const sb = await supabase();
          if (mode === 'signup' && password.value !== confirmation.value) throw new Error(t('passwordMismatch'));
          const normalizedUsername = username.value.trim().toLowerCase();
          const result = mode === 'signup'
            ? await sb.auth.signUp({
              email: email.value.trim(),
              password: password.value,
              options: {
                emailRedirectTo: `${location.origin}/milkyway/`,
                data: { username: normalizedUsername },
              },
            })
            : await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
          const { data, error } = result;
          if (error) throw error;
          password.value = '';
          confirmation.value = '';
          if (mode === 'signup' && !data.session) {
            message.textContent = t('confirmEmailSent');
            return;
          }
          message.textContent = '';
          this.sheet.close();
          toast(mode === 'signup' ? t('accountCreated') : '✓');
        } catch (error) {
          message.textContent = error.message || 'Sign-in failed';
        } finally {
          submit.disabled = false;
        }
      },
    },
    usernameWrap,
    email,
    passwordControl(password),
    forgotPassword,
    confirmationWrap,
    submit,
    message,
    h('div', { class: 'auth-divider', 'aria-hidden': 'true' }, h('span'), h('b', {}, t('or')), h('span')),
    google,
    switchMode,
    policyLink);
    const languageSheet = new Sheet({ title: t('language'), className: 'language-sheet' });
    const languageButton = h('button', {
      class: 'auth-language-button', type: 'button', 'aria-haspopup': 'dialog',
      onclick: () => languageSheet.open(),
    }, h('span', { 'aria-hidden': 'true' }, '🌐'),
    h('span', {}, languages.find(item => item.code === lang)?.name || 'English'),
    h('span', { class: 'auth-language-chevron', 'aria-hidden': 'true' }, '⌄'));
    languageSheet.body.classList.add('language-options');
    for (const item of languages) {
      languageSheet.body.append(h('button', {
        class: 'language-option',
        type: 'button',
        'aria-pressed': String(item.code === lang),
        onclick: () => setLanguage(item.code),
      }, h('span', {}, item.name), h('span', { class: 'language-option-check', 'aria-hidden': 'true' }, item.code === lang ? '✓' : '')));
    }
    this.sheet.body.append(form, languageButton);
  }
  open() { this.sheet.open(); }
}

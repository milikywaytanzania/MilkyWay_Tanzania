// LIVE host controls (TikTok LIVE style): guest management, LIVE settings (comment filters, moderation, audience)
// and viewer management. Everything here is a thin UI over LiveSession.control(); the server enforces every rule
// (api/milkyway-live-room.js), so a modified client cannot bypass the host's choices.
//
// Viewers get the matching pieces: the invitation prompt and the join-as-guest request.
import { t } from '../core/i18n.js';
import { auth } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h, icon, toast, avatar } from './dom.js';

const SLOW_STEPS = [0, 3, 10, 30, 60];

/** Runs a session action with a toast on failure; returns true on success. */
async function run(session, action, extra = {}, okMessage = '') {
  try {
    await session.control(action, extra);
    if (okMessage) toast(okMessage);
    return true;
  } catch (error) {
    toast(error?.message || t('liveUnavailable'));
    return false;
  }
}

/** A button that needs a second tap within 3 s (destructive actions). */
function confirmButton(label, onConfirm, className = 'pill-btn danger') {
  let armed = 0;
  const button = h('button', { class: className, type: 'button' }, label);
  button.addEventListener('click', () => {
    if (!armed) {
      button.textContent = t('tapAgain');
      button.classList.add('armed');
      armed = setTimeout(() => { armed = 0; button.textContent = label; button.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(armed); armed = 0;
    onConfirm();
  });
  return button;
}

const actionBtn = (label, onclick, className = 'pill-btn') => h('button', { class: className, type: 'button', onclick }, label);

function personRow(person, ...actions) {
  return h('div', { class: 'lc-person' },
    avatar(person, 36),
    h('div', { class: 'lc-person-name' }, h('b', {}, person.name || 'MilkyWay'),
      person.hostMuted ? h('small', {}, `🔇 ${t('muteMic')}`) : person.commentMuted ? h('small', {}, `💬 ${t('mutedCommenters')}`) : null),
    h('div', { class: 'lc-person-actions' }, ...actions.filter(Boolean)));
}

const section = (title, ...children) => h('section', { class: 'lc-section' }, h('h3', {}, title), ...children);
const note = text => h('p', { class: 'lc-note' }, text);

function toggleRow(label, checked, onchange) {
  const input = h('input', { type: 'checkbox', class: 'lc-switch', role: 'switch' });
  input.checked = !!checked;
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('label', { class: 'lc-toggle' }, h('span', {}, label), input);
}

function segmented(name, options, value, onchange) {
  const group = h('div', { class: `segmented lc-seg lc-seg-${options.length}`, role: 'radiogroup' });
  for (const [key, label] of options) {
    const input = h('input', { type: 'radio', name, value: String(key) });
    input.checked = String(key) === String(value);
    input.addEventListener('change', () => { if (input.checked) onchange(key); });
    group.append(h('label', {}, input, h('span', {}, label)));
  }
  return group;
}

/** Host-side panels. One instance per broadcast; destroy() when the LIVE ends. */
export class HostControls {
  constructor(session, { openProfile } = {}) {
    this.session = session;
    this.openProfile = openProfile;
    this.sheets = [];
    this.guestSheet = this.#sheet(t('guests'), 'lc-sheet');
    this.settingsSheet = this.#sheet(t('liveSettings'), 'lc-sheet');
    this.viewerSheet = this.#sheet(t('viewersTitle'), 'lc-sheet');
    this.personSheet = this.#sheet('', 'lc-sheet lc-person-sheet');
    this.query = '';
    this.offs = [
      session.on('room', () => this.#rerender()),
      session.on('audience', () => { if (this.viewerSheet.isOpen || this.guestSheet.isOpen) this.#rerender(); }),
      session.on('declined', userId => {
        const person = this.#people().find(entry => entry.userId === userId);
        toast(`${person?.name || 'MilkyWay'} ${t('declined')}`);
      }),
    ];
  }

  destroy() { this.offs.forEach(off => off()); this.sheets.forEach(sheet => sheet.root.remove()); }

  openGuests() { this.#renderGuests(); this.guestSheet.open(); }
  openSettings() { this.#renderSettings(); this.settingsSheet.open(); }
  openViewers() { this.#renderViewers(); this.viewerSheet.open(); }
  /** Actions for one person; `message` is set when opened from a comment. */
  openPerson(person, message = null) {
    if (!person?.userId || person.userId === auth.userId) return;
    this.focus = { userId: person.userId, fallback: person, message };
    this.#renderPerson();
    this.personSheet.open();
  }

  /** Pending guest requests, for the badge on the guests button. */
  get pendingCount() { return this.#people().filter(person => person.state === 'pending' && !person.invited).length; }

  #sheet(title, className) { const sheet = new Sheet({ title, className }); this.sheets.push(sheet); return sheet; }

  #rerender() {
    if (this.guestSheet.isOpen) this.#renderGuests();
    if (this.settingsSheet.isOpen) this.#renderSettings({ keepInputs: true });
    if (this.viewerSheet.isOpen) this.#renderViewers();
    if (this.personSheet.isOpen) this.#renderPerson();
  }

  // Members known to the server, merged with who is connected to the media room right now.
  #people() {
    const status = this.session.status;
    const byId = new Map((status?.members || []).map(member => [member.userId, { ...member }]));
    for (const participant of this.session.audience()) {
      const known = byId.get(participant.userId);
      if (known) known.online = true;
      else byId.set(participant.userId, { userId: participant.userId, name: participant.name || 'MilkyWay', avatar: '', state: 'viewer', online: true });
    }
    const settings = this.session.settings;
    for (const person of byId.values()) {
      person.commentMuted = !!settings.mutedIds?.includes(person.userId);
      person.blocked = !!settings.blockedIds?.includes(person.userId);
      person.invited = !!settings.invites?.[person.userId];
    }
    return [...byId.values()];
  }

  // ---- Guests -----------------------------------------------------------------------------------------------
  #renderGuests() {
    const s = this.session, settings = s.settings;
    const people = this.#people();
    const stage = people.filter(person => person.state === 'speaker');
    const requests = people.filter(person => person.state === 'pending' && !person.invited && !person.blocked);
    const invited = people.filter(person => person.invited && person.state !== 'speaker');
    const seats = Math.max(1, (settings.layout || 3) - 1);
    const seatLabel = h('b', {}, `${stage.length}/${seats}`);
    const setSeats = next => run(s, 'settings', { layout: Math.max(2, Math.min(9, next + 1)) });

    this.guestSheet.body.replaceChildren(
      section(t('seats'),
        h('div', { class: 'lc-stepper' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': '−', disabled: seats <= 1 || seats <= stage.length, onclick: () => setSeats(seats - 1) }, '−'),
          seatLabel,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': '+', disabled: seats >= 8, onclick: () => setSeats(seats + 1) }, '+'))),
      section(t('admission'),
        segmented('lcAdmission', [['approval', t('admissionApproval')], ['direct', t('admissionDirect')], ['broadcast', t('admissionOff')]], settings.admission || 'approval',
          value => run(s, 'settings', { admission: value })),
        toggleRow(t('allowRequests'), settings.allowRequests !== false, value => run(s, 'settings', { allowRequests: value }))),
      section(`${t('onStage')} (${stage.length})`,
        ...(stage.length ? stage.map(person => personRow(person,
          person.hostMuted
            ? actionBtn(t('unmuteMic'), () => run(s, 'allow-mic', { target: person.userId }))
            : actionBtn(t('muteMic'), () => run(s, 'mute', { target: person.userId })),
          confirmButton(t('removeFromStage'), () => run(s, 'remove', { target: person.userId }))))
          : [note(t('noGuests'))])),
      section(`${t('requests')} (${requests.length})`,
        ...(requests.length ? requests.map(person => personRow(person,
          actionBtn(t('accept'), () => run(s, 'approve', { target: person.userId }), 'pill-btn hot'),
          actionBtn(t('decline'), () => run(s, 'reject', { target: person.userId }))))
          : [note(t('noRequests'))])),
      invited.length ? section(`${t('invited')} (${invited.length})`,
        ...invited.map(person => personRow(person, actionBtn(t('cancelInvite'), () => run(s, 'cancel-invite', { target: person.userId }))))) : null,
      section(t('inviteViewers'), ...this.#inviteList(people)),
    );
  }

  #inviteList(people) {
    const candidates = people.filter(person => person.online && person.state === 'viewer' && !person.invited && !person.blocked);
    if (!candidates.length) return [note(t('noViewers'))];
    return candidates.slice(0, 50).map(person => personRow(person,
      actionBtn(t('invite'), () => run(this.session, 'invite', { target: person.userId }, t('inviteSent')), 'pill-btn hot')));
  }

  // ---- LIVE settings ----------------------------------------------------------------------------------------
  #renderSettings({ keepInputs = false } = {}) {
    const s = this.session, settings = s.settings;
    // Don't wipe what the host is typing when a refresh arrives.
    if (keepInputs && this.settingsSheet.body.contains(document.activeElement) && document.activeElement.matches('input[type="text"]')) return;
    const people = this.#people();
    const byId = id => people.find(person => person.userId === id) || { userId: id, name: 'MilkyWay' };

    const title = h('input', { class: 'field', type: 'text', maxlength: '80', value: s.live.title || '', placeholder: t('liveTitle') });
    const titleForm = h('form', { class: 'lc-inline', onsubmit: async event => {
      event.preventDefault();
      if (await run(s, 'title', { title: title.value.trim() }, t('titleSaved'))) { s.live.title = title.value.trim(); }
    } }, title, h('button', { class: 'pill-btn', type: 'submit' }, t('save')));

    const words = settings.filterWords || [];
    const wordInput = h('input', { class: 'field', type: 'text', maxlength: '30', placeholder: t('addKeyword'), enterkeyhint: 'done' });
    const wordForm = h('form', { class: 'lc-inline', onsubmit: event => {
      event.preventDefault();
      const added = wordInput.value.split(',').map(word => word.trim().toLowerCase()).filter(word => word.length >= 2);
      if (!added.length) return;
      wordInput.value = '';
      run(s, 'settings', { filterWords: [...words, ...added] });
    } }, wordInput, h('button', { class: 'pill-btn', type: 'submit' }, t('addKeyword').split(' ')[0]));
    const chips = h('div', { class: 'lc-chips' }, ...words.map(word => h('button', {
      class: 'lc-chip', type: 'button', 'aria-label': `${t('remove')} ${word}`,
      onclick: () => run(s, 'settings', { filterWords: words.filter(entry => entry !== word) }),
    }, word, h('span', { html: icon.close }))));

    const muted = (settings.mutedIds || []).map(byId);
    const blocked = (settings.blockedIds || []).map(byId);

    this.settingsSheet.body.replaceChildren(
      section(t('liveTitle'), titleForm),
      section(t('comments2'),
        segmented('lcComments', [['everyone', t('commentsEveryone')], ['followers', t('commentsFollowers')], ['off', t('commentsOff')]], settings.comments || 'everyone',
          value => run(s, 'settings', { comments: value })),
        h('div', { class: 'lc-label' }, t('slowMode')),
        segmented('lcSlow', SLOW_STEPS.map(step => [step, step ? `${step}${t('seconds')}` : t('slowOff')]), settings.slowMode || 0,
          value => run(s, 'settings', { slowMode: Number(value) }))),
      section(t('keywordFilter'), note(t('keywordHint')), wordForm, chips,
        toggleRow(t('filterLinks'), settings.filterLinks, value => run(s, 'settings', { filterLinks: value }))),
      section(t('audienceControls'),
        toggleRow(t('showViewerCount'), settings.showViewerCount !== false, value => run(s, 'settings', { showViewerCount: value })),
        toggleRow(t('allowGifts'), settings.giftsEnabled !== false, value => run(s, 'settings', { giftsEnabled: value })),
        toggleRow(t('allowLikes'), settings.likesEnabled !== false, value => run(s, 'settings', { likesEnabled: value }))),
      section(`${t('mutedCommenters')} (${muted.length})`,
        ...(muted.length ? muted.map(person => personRow(person, actionBtn(t('unmute'), () => run(s, 'unmute-comments', { target: person.userId })))) : [note(t('noneYet'))])),
      section(`${t('removedPeople')} (${blocked.length})`,
        ...(blocked.length ? blocked.map(person => personRow(person, actionBtn(t('unblock'), () => run(s, 'unblock', { target: person.userId })))) : [note(t('noneYet'))])),
    );
  }

  // ---- Viewers ----------------------------------------------------------------------------------------------
  #renderViewers() {
    const keep = this.viewerSheet.body.contains(document.activeElement);
    const search = h('input', { class: 'field', type: 'search', placeholder: t('searchViewers'), value: this.query });
    const list = h('div', { class: 'lc-list' });
    const paint = () => {
      const q = this.query.trim().toLowerCase();
      const people = this.#people().filter(person => person.online && !person.blocked && (!q || (person.name || '').toLowerCase().includes(q)))
        .sort((a, b) => (b.state === 'speaker') - (a.state === 'speaker') || (a.name || '').localeCompare(b.name || ''));
      this.viewerSheet.title = `${t('viewersTitle')} (${people.length})`;
      list.replaceChildren(...(people.length ? people.slice(0, 200).map(person => {
        const row = personRow(person,
          person.state === 'speaker' ? h('span', { class: 'lc-tag' }, t('onStage')) : person.invited ? h('span', { class: 'lc-tag' }, t('invited')) : null,
          h('button', { class: 'icon-btn lc-more', type: 'button', 'aria-label': t('moderation'), html: icon.shield }));
        row.classList.add('tappable');
        row.addEventListener('click', () => this.openPerson(person));
        return row;
      }) : [note(t('noViewers'))]));
    };
    search.addEventListener('input', () => { this.query = search.value; paint(); });
    paint();
    this.viewerSheet.body.replaceChildren(search, list);
    if (keep) search.focus({ preventScroll: true });
  }

  // ---- One person -------------------------------------------------------------------------------------------
  #renderPerson() {
    const s = this.session;
    const focus = this.focus;
    if (!focus) return;
    const person = this.#people().find(entry => entry.userId === focus.userId) || { ...focus.fallback, state: focus.fallback.state || 'viewer' };
    const message = focus.message;
    const id = person.userId;
    const pinnedId = s.settings.pinned?.id;
    const close = () => this.personSheet.close();
    this.personSheet.title = person.name || 'MilkyWay';

    const stage = person.state === 'speaker'
      ? [person.hostMuted
          ? actionBtn(t('unmuteMic'), () => run(s, 'allow-mic', { target: id }))
          : actionBtn(t('muteMic'), () => run(s, 'mute', { target: id })),
         actionBtn(t('removeFromStage'), () => run(s, 'remove', { target: id }))]
      : person.state === 'pending' && !person.invited
        ? [actionBtn(t('accept'), () => run(s, 'approve', { target: id }), 'pill-btn hot'), actionBtn(t('decline'), () => run(s, 'reject', { target: id }))]
        : person.invited
          ? [actionBtn(t('cancelInvite'), () => run(s, 'cancel-invite', { target: id }))]
          : person.blocked ? [] : [actionBtn(t('invite'), () => run(s, 'invite', { target: id }, t('inviteSent')), 'pill-btn hot')];

    this.personSheet.body.replaceChildren(
      h('div', { class: 'lc-person-head' }, avatar(person, 56), h('b', {}, person.name || 'MilkyWay'),
        person.state === 'speaker' ? h('span', { class: 'lc-tag' }, t('onStage')) : null),
      message ? h('blockquote', { class: 'lc-quote' }, message.body) : null,
      h('div', { class: 'lc-actions' },
        this.openProfile ? actionBtn(t('viewProfile'), () => { close(); this.openProfile({ id, name: person.name, avatar: person.avatar }); }) : null,
        ...stage,
        message && message.id !== pinnedId ? actionBtn(`📌 ${t('pinComment')}`, async () => { if (await run(s, 'pin', { id: message.id }, t('pinned'))) close(); }) : null,
        message && message.id === pinnedId ? actionBtn(t('unpinComment'), () => run(s, 'unpin')) : null,
        message ? actionBtn(t('deleteComment'), async () => { if (await run(s, 'delete-message', { id: message.id })) close(); }) : null,
        person.commentMuted
          ? actionBtn(t('unmuteComments'), () => run(s, 'unmute-comments', { target: id }))
          : actionBtn(t('muteComments'), () => run(s, 'mute-comments', { target: id })),
        person.blocked
          ? actionBtn(t('unblock'), () => run(s, 'unblock', { target: id }))
          : confirmButton(t('removeFromLive'), async () => { if (await run(s, 'kick', { target: id }, t('removed'))) close(); })),
    );
  }
}

/** Viewer-side prompt shown when the host invites them on stage. */
export class InvitePrompt {
  constructor(session, hostName) {
    this.session = session;
    this.sheet = new Sheet({ title: t('joinLive'), className: 'lc-sheet lc-invite' });
    this.sheet.body.append(
      h('p', { class: 'lc-invite-text' }, h('b', {}, hostName || 'MilkyWay'), ' ', t('invitedYou')),
      h('div', { class: 'lc-actions' },
        actionBtn(t('accept'), async () => {
          this.sheet.close();
          try { await session.acceptInvite(); } catch (error) { toast(error?.message || t('liveUnavailable')); }
        }, 'pill-btn hot wide'),
        actionBtn(t('decline'), () => { this.sheet.close(); session.declineInvite().catch(() => {}); }, 'pill-btn wide')));
  }
  open() { this.sheet.open(); }
  destroy() { this.sheet.root.remove(); }
}

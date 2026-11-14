// Minimal UI strings for the new shell. Follows the language chosen in the classic app (localStorage "mw_lang").
const strings = {
  en: {
    forYou: 'For You', following: 'Following', live: 'LIVE', home: 'Orbit', create: 'Create', inbox: 'Messages', me: 'Nova', explore: 'Lives',
    tapForSound: 'Tap for sound', offline: 'Offline · showing saved posts', backOnline: 'Back online', empty: 'Nothing here yet',
    emptyFollowing: 'Follow creators to fill this feed', retry: 'Retry', loading: 'Loading…', comments: 'Comments',
    addComment: 'Add a comment…', send: 'Send', signIn: 'Sign in', signInToContinue: 'Sign in to continue', email: 'Email',
    password: 'Password', createAccount: 'Create account', signOut: 'Sign out', share: 'Share', save: 'Save', gift: 'Gift',
    linkCopied: 'Link copied', noLives: 'No one is live right now', goLive: 'Go LIVE', liveTitle: 'Title of your LIVE',
    video: 'Video', audio: 'Audio', start: 'Start', end: 'End', viewers: 'viewers', joining: 'Joining…', reconnecting: 'Reconnecting…',
    liveEnded: 'This LIVE has ended', sayHi: 'Say something…', coins: 'coins', topUp: 'Top up', sent: 'sent', queued: 'Will send when online',
    giftFailed: 'Gift not sent', noComments: 'Be the first to comment', swipeHint: 'Swipe up for more', chats: 'Messages',
    noChats: 'No conversations yet', encrypted: 'Encrypted message', cameraNeeded: 'Camera and microphone are needed to go LIVE',
    liveUnavailable: 'LIVE service is unavailable right now', classic: 'More', follow: 'Follow',
  },
  sw: {
    forYou: 'Kwa Ajili Yako', following: 'Unaowafuata', live: 'LIVE', home: 'Orbit', create: 'Tengeneza', inbox: 'Ujumbe', me: 'Nova', explore: 'Live',
    tapForSound: 'Gusa kupata sauti', offline: 'Nje ya mtandao · machapisho yaliyohifadhiwa', backOnline: 'Umerudi mtandaoni', empty: 'Bado hakuna kitu',
    emptyFollowing: 'Fuata watu ili kujaza ukurasa huu', retry: 'Jaribu tena', loading: 'Inapakia…', comments: 'Maoni',
    addComment: 'Andika maoni…', send: 'Tuma', signIn: 'Ingia', signInToContinue: 'Ingia kuendelea', email: 'Barua pepe',
    password: 'Nenosiri', createAccount: 'Fungua akaunti', signOut: 'Toka', share: 'Shiriki', save: 'Hifadhi', gift: 'Zawadi',
    linkCopied: 'Kiungo kimenakiliwa', noLives: 'Hakuna aliye LIVE sasa hivi', goLive: 'Anza LIVE', liveTitle: 'Kichwa cha LIVE yako',
    video: 'Video', audio: 'Sauti', start: 'Anza', end: 'Maliza', viewers: 'wanatazama', joining: 'Inajiunga…', reconnecting: 'Inaunganisha tena…',
    liveEnded: 'LIVE hii imeisha', sayHi: 'Sema kitu…', coins: 'sarafu', topUp: 'Ongeza', sent: 'imetumwa', queued: 'Itatumwa ukirudi mtandaoni',
    giftFailed: 'Zawadi haikutumwa', noComments: 'Kuwa wa kwanza kutoa maoni', swipeHint: 'Telezesha juu kwa zaidi', chats: 'Ujumbe',
    noChats: 'Bado hakuna mazungumzo', encrypted: 'Ujumbe uliosimbwa', cameraNeeded: 'Kamera na maikrofoni zinahitajika kuanza LIVE',
    liveUnavailable: 'Huduma ya LIVE haipatikani sasa', classic: 'Zaidi', follow: 'Fuata',
  },
};
const language = (() => { try { return localStorage.getItem('mw_lang') || (navigator.language || 'en').slice(0, 2); } catch { return 'en'; } })();
const table = strings[language] || strings.en;
export const lang = strings[language] ? language : 'en';
export const t = key => table[key] ?? strings.en[key] ?? key;

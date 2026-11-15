function safePublicMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim(), location.origin);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (url.origin !== location.origin && url.protocol !== 'https:') return '';
    return url.href;
  } catch { return ''; }
}

function mediaCardSource(value, video, alt = '') {
  const media = document.createElement(video ? 'video' : 'img');
  if (video) {
    media.controls = true;
    media.preload = 'metadata';
    media.playsInline = true;
    const source = safePublicMediaUrl(value);
    if (source) media.src = source;
  } else {
    media.loading = 'lazy';
    media.decoding = 'async';
    media.alt = alt;
    const original = safePublicMediaUrl(value) || new URL('/placeholder.svg', location.origin).href;
    const resized = window.MilkyWayMedia?.image(original, 800);
    media.src = safePublicMediaUrl(resized) || original;
  }
  return media;
}

function mediaNotice(container, message) {
  const card = document.createElement('div');
  card.className = 'card';
  const body = document.createElement('div');
  body.className = 'card-body';
  body.textContent = message;
  card.append(body);
  container.replaceChildren(card);
}

async function loadMedia() {
  const box = document.getElementById('mediaGallery');
  try {
    const { data, error } = await sb.from('site_media').select('*').eq('published', true).order('created_at', { ascending: false });
    if (error) throw error;
    const lang = localStorage.getItem('masiyatunda_lang') || 'sw';
    const cards = (data || []).map(item => {
      const video = item.media_type === 'video';
      const title = lang === 'en' ? (item.title_en || item.title_sw) : (item.title_sw || item.title_en);
      const description = lang === 'en' ? (item.description_en || item.description_sw) : (item.description_sw || item.description_en);
      const card = document.createElement('article');
      card.className = 'card';
      const body = document.createElement('div');
      body.className = 'card-body';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = video ? 'VIDEO' : 'PHOTO';
      const heading = document.createElement('h3');
      heading.textContent = title || 'Masiyatunda Media';
      const text = document.createElement('p');
      text.textContent = description || '';
      body.append(tag, heading, text);
      card.append(mediaCardSource(item.media_url, video, title || 'Media'), body);
      return card;
    });
    if (cards.length) box.replaceChildren(...cards);
    else mediaNotice(box, 'Hakuna media iliyowekwa bado.');
  } catch (error) {
    console.error('Could not load public media.', error);
    mediaNotice(box, error.message || 'Media haikuweza kupakiwa.');
  }
}

loadMedia();

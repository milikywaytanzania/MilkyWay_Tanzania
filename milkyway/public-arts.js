function safeArtsMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim(), location.origin);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (url.origin !== location.origin && url.protocol !== 'https:') return '';
    return url.href;
  } catch { return ''; }
}

function artsImage(value, width, alt = '') {
  const image = document.createElement('img');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = alt;
  const original = safeArtsMediaUrl(value) || new URL('/placeholder.svg', location.origin).href;
  const resized = window.MilkyWayMedia?.image(original, width);
  image.src = safeArtsMediaUrl(resized) || original;
  return image;
}

function artsNotice(element, message, cardClass) {
  const card = document.createElement('div');
  card.className = cardClass;
  card.textContent = message;
  element.replaceChildren(card);
}

(async function loadPublicArts() {
  const directory = document.getElementById('artistDirectory');
  const gallery = document.getElementById('artsGallery');
  try {
    const artistId = new URLSearchParams(location.search).get('artist');
    const result = await sb.rpc('get_public_artist_profiles', { p_artist_id: artistId || null });
    if (result.error) throw result.error;
    const artists = result.data || [];
    const artistCards = artists.map(artist => {
      const card = document.createElement('a');
      card.href = `sanaa.html?artist=${encodeURIComponent(artist.id)}`;
      card.className = 'artist-public-card';
      card.style.textDecoration = 'none';
      card.style.display = 'block';
      card.append(artsImage(artist.photo_url || 'placeholder.svg', 480));
      const heading = document.createElement('h3');
      heading.append(document.createTextNode(artist.name || ''));
      if (artist.verified) {
        const verified = document.createElement('span');
        verified.className = 'verified-public';
        verified.textContent = '✓';
        heading.append(' ', verified);
      }
      const category = document.createElement('div');
      category.className = 'tag';
      category.textContent = artist.category || 'Artist';
      const bio = document.createElement('p');
      bio.textContent = (artist.bio || '').slice(0, 150);
      const locationText = document.createElement('small');
      locationText.textContent = artist.location || '';
      const clear = document.createElement('div');
      clear.style.clear = 'both';
      card.append(heading, category, bio, locationText, clear);
      return card;
    });
    if (artistCards.length) directory.replaceChildren(...artistCards);
    else artsNotice(directory, 'Hakuna profile za wasanii bado.', 'artist-public-card');

    let galleryQuery = sb.from('arts_gallery').select('*').eq('published', true).order('created_at', { ascending: false });
    if (artistId) galleryQuery = galleryQuery.eq('artist_id', artistId);
    const galleryResult = await galleryQuery;
    if (galleryResult.error) throw galleryResult.error;
    const works = (galleryResult.data || []).map(work => {
      const video = work.media_type === 'video';
      const card = document.createElement('article');
      card.className = 'card';
      const media = video ? document.createElement('video') : artsImage(work.media_url, 800, work.title_sw || work.title_en || 'Sanaa');
      if (video) {
        media.preload = 'metadata';
        media.controls = true;
        const source = safeArtsMediaUrl(work.media_url);
        if (source) media.src = source;
      }
      const body = document.createElement('div');
      body.className = 'card-body';
      const category = document.createElement('span');
      category.className = 'tag';
      category.textContent = work.category || 'Sanaa';
      const heading = document.createElement('h3');
      heading.textContent = work.title_sw || work.title_en || '';
      const description = document.createElement('p');
      description.textContent = work.description_sw || work.description_en || '';
      body.append(category, heading, description);
      card.append(media, body);
      return card;
    });
    if (works.length) gallery.replaceChildren(...works);
    else artsNotice(gallery, 'Hakuna sanaa iliyowekwa bado.', 'card');

    if (artistId) {
      const artist = artists.find(item => item.id === artistId);
      if (artist) {
        document.querySelector('.hero h1').textContent = artist.name || '';
        document.querySelector('.hero p').textContent = (artist.bio || '').slice(0, 240);
        document.getElementById('artist-directory').scrollIntoView({ behavior: 'smooth' });
      }
    }
  } catch (error) {
    console.error('Could not load public arts content.', error);
    artsNotice(directory, error.message || 'Wasanii hawakuweza kupakiwa.', 'artist-public-card');
    artsNotice(gallery, error.message || 'Sanaa haikuweza kupakiwa.', 'card');
  }
})();

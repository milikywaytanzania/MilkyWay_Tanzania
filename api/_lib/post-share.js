const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const publicUrl = value => typeof value === 'string' && /^https:\/\//i.test(value) ? value : '';
const postUrl = (origin, id) => new URL(`/share/${encodeURIComponent(id)}`, origin).href;
const appUrl = (origin, id) => new URL(`/milkyway/?post=${encodeURIComponent(id)}`, origin).href;

export async function postShareResponse(requestUrl, postId, userAgent = '') {
  const request = new URL(requestUrl);
  const crawler = /bot|crawler|spider|facebookexternalhit|whatsapp|telegram|twitter|linkedin|slack|discord/i.test(userAgent);
  const apiUrl = new URL(`/api/milkyway-feed?action=share&id=${encodeURIComponent(postId)}`, request.origin);
  let response;
  try {
    response = await fetch(apiUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  } catch (error) {
    console.error('[post-share] Could not load post metadata.', error);
    return new Response('Post preview unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!response.ok) return new Response('Post preview unavailable.', {
    status: response.status === 400 || response.status === 404 ? 404 : 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

  let data;
  try { data = await response.json(); }
  catch (error) {
    console.error('[post-share] Invalid post metadata response.', error);
    return new Response('Post preview unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const post = data?.post;
  if (!post) return new Response('Post not found.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

  const id = post.id;
  const canonical = postUrl(request.origin, id);
  const destination = appUrl(request.origin, id);
  const name = String(post.author?.name || 'MilkyWay').slice(0, 100);
  const caption = String(post.caption || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const title = String(post.title || caption || `${name} on MilkyWay`).replace(/\s+/g, ' ').trim().slice(0, 160);
  const description = caption || `A post by ${name} on MilkyWay.`;
  const media = post.media;
  const image = publicUrl(media?.previewItems?.[0])
    || (media?.type === 'video'
      ? publicUrl(media.url && /\/storage\/v1\/object\/public\//i.test(media.url) ? `${media.url.split(/[?#]/, 1)[0]}.poster.jpg` : '')
      : publicUrl(media?.url) || publicUrl(media?.items?.[0]))
    || new URL('/milkyway/brand/milkyway-splash.webp', request.origin).href;
  const video = media?.type === 'video' ? publicUrl(media.url) : '';
  const tags = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${html(title)}</title>`,
    `<meta name="description" content="${html(description)}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${html(title)}">`,
    `<meta property="og:description" content="${html(description)}">`,
    `<meta property="og:image" content="${html(image)}">`,
    `<meta property="og:image:alt" content="${html(title)}">`,
    `<meta property="og:url" content="${html(canonical)}">`,
    `<link rel="canonical" href="${html(canonical)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${html(title)}">`,
    `<meta name="twitter:description" content="${html(description)}">`,
    `<meta name="twitter:image" content="${html(image)}">`,
    ...(video ? [`<meta property="og:video" content="${html(video)}">`] : []),
    ...(crawler ? [] : [`<meta http-equiv="refresh" content="0;url=${html(destination)}">`]),
    '</head><body><main><h1>',
    html(title),
    '</h1><p>',
    html(description),
    `</p><img src="${html(image)}" alt="${html(title)}" style="max-width:100%;height:auto"><p>Shared by `,
    html(name),
    ' on MilkyWay.</p><p><a href="',
    html(destination),
    '">Open this post in MilkyWay</a></p></main></body></html>',
  ];
  return new Response(tags.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

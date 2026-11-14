// Universal MilkyWay watermark for media shown outside the main feed (profile grids, galleries, post previews) and
// for audio players inside posts. The main feed is branded by premium.js; LIVE stages are branded in mw-watermark.css.
(() => {
  const SRC = 'brand/milkyway-watermark-galaxy.webp';
  const SELECTOR = '.post .post-media, .post audio';
  const mark = () => { const img = document.createElement('img'); img.className = 'mw-watermark'; img.src = SRC; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async'; img.draggable = false; return img; };
  function brand(media) {
    if (media.closest('#feed .post[data-post-id]')) return; // premium.js owns feed posts
    const parent = media.parentElement;
    if (!parent || parent.classList.contains('mw-media-frame') || parent.classList.contains('mw-wm-frame')) return;
    const frame = document.createElement('div');
    const kind = media.tagName === 'AUDIO' ? 'audio' : media.tagName === 'VIDEO' ? 'video' : 'image';
    frame.className = `mw-wm-frame${kind === 'audio' ? ' mw-wm-frame--audio' : ''}`;
    frame.dataset.kind = kind;
    media.before(frame);
    frame.append(media, mark());
  }
  const scan = root => { if (root.matches?.(SELECTOR)) brand(root); root.querySelectorAll?.(SELECTOR).forEach(brand); };
  let queued = new Set(), scheduled = false;
  const flush = () => { scheduled = false; const nodes = queued; queued = new Set(); nodes.forEach(scan); };
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) queued.add(node);
    if (queued.size && !scheduled) { scheduled = true; requestAnimationFrame(flush); }
  }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
})();

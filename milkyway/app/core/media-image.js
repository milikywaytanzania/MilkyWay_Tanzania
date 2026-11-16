const MAX_IMAGE_EDGE = 2048;
const PREVIEW_EDGE = 640;

function outputSize(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function encode(source, width, height, type = 'image/webp', quality = 0.8, maxEdge = PREVIEW_EDGE) {
  if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas is unavailable.');
  const { width: outputWidth, height: outputHeight } = outputSize(width, height, maxEdge);
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d', { alpha: type !== 'image/jpeg' });
  if (!context) throw new Error('Canvas 2D context is unavailable.');
  context.drawImage(source, 0, 0, outputWidth, outputHeight);
  return canvas.convertToBlob({ type, quality });
}

function extensionFor(blob, fallback) {
  if (blob.type === 'image/jpeg') return 'jpg';
  if (blob.type === 'image/png') return 'png';
  if (blob.type === 'image/webp') return 'webp';
  return fallback;
}

/** Makes a compressed upload and a small rendition using worker-only image APIs. */
export async function optimizeImageFile(file) {
  if (typeof createImageBitmap !== 'function') throw new Error('Image decoding is unavailable.');
  const bitmap = await createImageBitmap(file);
  try {
    let full = file;
    if (Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_EDGE || file.size > 600 * 1024) {
      const { width, height } = outputSize(bitmap.width, bitmap.height, MAX_IMAGE_EDGE);
      const fullBlob = await encode(bitmap, width, height, 'image/webp', 0.82, MAX_IMAGE_EDGE);
      if (fullBlob.size < file.size) {
        const name = file.name.replace(/\.[^.]+$/, '');
        full = new File([fullBlob], `${name}.${extensionFor(fullBlob, 'webp')}`, { type: fullBlob.type, lastModified: Date.now() });
      }
    }

    let preview = null;
    if (Math.max(bitmap.width, bitmap.height) > PREVIEW_EDGE || file.size > 300 * 1024) {
      const previewBlob = await encode(bitmap, bitmap.width, bitmap.height, 'image/webp', 0.68);
      if (previewBlob.size < file.size) {
        const name = file.name.replace(/\.[^.]+$/, '');
        preview = new File([previewBlob], `${name}-preview.${extensionFor(previewBlob, 'webp')}`, { type: previewBlob.type, lastModified: Date.now() });
      }
    }
    return { full, preview };
  } finally {
    bitmap.close?.();
  }
}

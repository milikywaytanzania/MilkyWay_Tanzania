const MAX_IMAGE_EDGE = 2048;
const PREVIEW_EDGE = 640;

function outputSize(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasFor(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encode(source, width, height, type = 'image/webp', quality = 0.8, maxEdge = PREVIEW_EDGE) {
  const { width: outputWidth, height: outputHeight } = outputSize(width, height, maxEdge);
  const canvas = canvasFor(outputWidth, outputHeight);
  const context = canvas.getContext('2d', { alpha: type !== 'image/jpeg' });
  if (!context) throw new Error('Canvas 2D context is unavailable.');
  context.drawImage(source, 0, 0, outputWidth, outputHeight);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('Browser could not encode the media preview.'));
  }, type, quality));
}

async function blobToFile(blob, name, type) {
  if (typeof File === 'function') return new File([blob], name, { type: blob.type || type, lastModified: Date.now() });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

function extensionFor(blob, fallback) {
  if (blob.type === 'image/jpeg') return 'jpg';
  if (blob.type === 'image/png') return 'png';
  if (blob.type === 'image/webp') return 'webp';
  return fallback;
}

/** Compresses photos locally and makes a separate small rendition for feed/profile surfaces. */
export async function optimizeImage(file) {
  if (typeof createImageBitmap !== 'function') return { full: file, preview: null };
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    let full = file;
    if (Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_EDGE || file.size > 600 * 1024) {
      const { width, height } = outputSize(bitmap.width, bitmap.height, MAX_IMAGE_EDGE);
      const fullBlob = await encode(bitmap, width, height, 'image/webp', 0.82, MAX_IMAGE_EDGE);
      if (fullBlob.size < file.size) full = await blobToFile(fullBlob, `${file.name.replace(/\.[^.]+$/, '')}.${extensionFor(fullBlob, 'webp')}`, 'image/webp');
    }

    let preview = null;
    if (Math.max(bitmap.width, bitmap.height) > PREVIEW_EDGE || file.size > 300 * 1024) {
      const previewBlob = await encode(bitmap, bitmap.width, bitmap.height, 'image/webp', 0.68);
      if (previewBlob.size < file.size) preview = await blobToFile(previewBlob, `${file.name.replace(/\.[^.]+$/, '')}-preview.${extensionFor(previewBlob, 'webp')}`, 'image/webp');
    }
    return { full, preview };
  } catch (error) {
    console.warn('[media] photo optimization unavailable; uploading the selected file', error);
    return { full: file, preview: null };
  } finally {
    bitmap?.close?.();
  }
}

function waitFor(video, eventName) {
  if ((eventName === 'loadedmetadata' && video.readyState >= 1) || (eventName === 'loadeddata' && video.readyState >= 2)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out while preparing the video preview.')), 8000);
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener(eventName, loaded);
      video.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('Could not decode the selected video.'));
    video.addEventListener(eventName, loaded, { once: true });
    video.addEventListener('error', failed, { once: true });
  });
}

/** Extracts a small poster frame without transcoding or uploading the whole video twice. */
export async function createVideoPreview(file) {
  const video = document.createElement('video');
  const objectUrl = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = objectUrl;
  try {
    await waitFor(video, 'loadedmetadata');
    if (Number.isFinite(video.duration) && video.duration > 0.2) {
      video.currentTime = Math.min(0.25, video.duration / 2);
      await waitFor(video, 'seeked');
    } else await waitFor(video, 'loadeddata');
    const { width, height } = outputSize(video.videoWidth, video.videoHeight, PREVIEW_EDGE);
    const blob = await encode(video, width, height, 'image/jpeg', 0.64);
    return await blobToFile(blob, `${file.name.replace(/\.[^.]+$/, '')}-poster.jpg`, 'image/jpeg');
  } catch (error) {
    console.warn('[media] video poster generation unavailable', error);
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export function yieldToBrowser() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(resolve, { timeout: 100 });
    else setTimeout(resolve, 0);
  });
}

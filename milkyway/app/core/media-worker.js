import { optimizeImageFile } from './media-image.js';

self.addEventListener('message', async event => {
  const { id, file } = event.data || {};
  try {
    const result = await optimizeImageFile(file);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
});

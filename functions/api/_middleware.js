// Cloudflare Pages Function: serves every api/<name>.js handler at /api/<name>, exactly like server.js does on Render.
// A directory middleware runs for every request under /api/, so one file covers all endpoints.
// Requires the nodejs_compat flag (see wrangler.toml) for process.env, Buffer and node:crypto.
import { runApi } from '../../api/_lib/fetch-adapter.js';

export const onRequest = ({ request }) => {
  const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/api\/?/, '').split('/')[0] || '');
  return runApi(name, request);
};

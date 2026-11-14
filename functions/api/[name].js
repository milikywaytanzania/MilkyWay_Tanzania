// Cloudflare Pages Function: serves every api/<name>.js handler at /api/<name>, exactly like server.js does on Render.
// Requires the nodejs_compat flag (see wrangler.toml) for process.env, Buffer and node:crypto.
import { runApi } from '../../api/_lib/fetch-adapter.js';

export const onRequest = ({ request, params }) => runApi(params.name, request);

// Netlify Function: serves every api/<name>.js handler at /api/<name> (same routes as server.js and Cloudflare Pages).
import { runApi } from '../../api/_lib/fetch-adapter.js';

export default async (request, context) => runApi(context.params.name, request);

export const config = { path: '/api/:name' };

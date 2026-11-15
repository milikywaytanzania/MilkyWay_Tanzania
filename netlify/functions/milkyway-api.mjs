// Netlify Function: serves every api/<name>.js handler at /api/<name> (same routes as server.js and Cloudflare Pages).
import { getDatabase } from '@netlify/database';
import { runApi } from '../../api/_lib/fetch-adapter.js';
import { useDatabase } from '../../api/_lib/saves.js';

// Saved posts are stored in Netlify Database on this host.
useDatabase(getDatabase);

export default async (request, context) => runApi(context.params.name, request);

export const config = { path: '/api/:name' };

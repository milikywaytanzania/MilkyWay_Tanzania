// Runs the Express-style api/<name>.js handlers (req, res) from a Fetch Request and returns a Fetch Response.
// Used by the Cloudflare Pages Function (functions/api/_middleware.js) that serves /api/<name>.
import account from '../milkyway-account.js';
import call from '../milkyway-call.js';
import discovery from '../milkyway-discovery.js';
import feed from '../milkyway-feed.js';
import gallery from '../milkyway-gallery.js';
import groups from '../milkyway-groups.js';
import health from '../milkyway-health.js';
import liveRoom from '../milkyway-live-room.js';
import livekitToken from '../milkyway-livekit-token.js';
import mediaAuthorize from '../milkyway-media-authorize.js';
import message from '../milkyway-message.js';
import notifications from '../milkyway-notifications.js';
import social from '../milkyway-social.js';
import wallet from '../milkyway-wallet.js';

export const handlers = {
  'milkyway-account': account,
  'milkyway-call': call,
  'milkyway-discovery': discovery,
  'milkyway-feed': feed,
  'milkyway-gallery': gallery,
  'milkyway-groups': groups,
  'milkyway-health': health,
  'milkyway-live-room': liveRoom,
  'milkyway-livekit-token': livekitToken,
  'milkyway-media-authorize': mediaAuthorize,
  'milkyway-message': message,
  'milkyway-notifications': notifications,
  'milkyway-social': social,
  'milkyway-wallet': wallet,
};

const JSON_LIMIT = 16 * 1024;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function makeResponse() {
  const state = { status: 200, headers: new Headers(), body: null, sent: false };
  const finish = body => {
    if (!state.sent) { state.sent = true; state.body = body; }
    return res;
  };
  const res = {
    get headersSent() { return state.sent; },
    status(code) { state.status = code; return res; },
    setHeader(name, value) { state.headers.set(name, String(value)); return res; },
    json(value) { state.headers.set('Content-Type', 'application/json'); return finish(JSON.stringify(value)); },
    send(value) { return finish(value ?? null); },
    end(value) { return finish(value ?? null); },
    redirect(code, location) { state.status = code; state.headers.set('Location', location); return finish(null); },
  };
  return { res, state };
}

export async function runApi(name, request) {
  const handler = handlers[name];
  if (!handler) return json(404, { error: 'Not found.' });

  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  const query = Object.fromEntries(url.searchParams);
  let body;
  let raw = null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    if (/\bjson\b/i.test(headers['content-type'] || '')) {
      const text = await request.text();
      if (text.length > JSON_LIMIT) return json(413, { error: 'Request too large.' });
      try { body = text ? JSON.parse(text) : undefined; } catch { return json(400, { error: 'Invalid request body.' }); }
    } else {
      raw = request.body;
    }
  }

  const { res, state } = makeResponse();
  const req = {
    method: request.method, headers, query, body, res, url: url.pathname + url.search,
    // Multipart uploads read the raw body as a stream, as with a Node request.
    async *[Symbol.asyncIterator]() { if (raw) for await (const chunk of raw) yield chunk; },
  };
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`[api/${name}] unhandled error`, error);
  }
  if (!state.sent) return json(500, { error: 'Service unavailable.' });
  return new Response(request.method === 'HEAD' ? null : state.body, { status: state.status, headers: state.headers });
}

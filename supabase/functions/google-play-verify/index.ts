import { corsHeaders } from '../_shared/cors.ts';
import { GOOGLE_PLAY_COIN_PACKAGES, GOOGLE_PLAY_PACKAGE_NAME } from '../_shared/google-play-products.js';

const GOOGLE_OAUTH_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_API_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const encoder = new TextEncoder();
let googleAccessTokenCache: { value: string; expiresAt: number } | null = null;

class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const base64url = (value: string) =>
  btoa(String.fromCharCode(...encoder.encode(value))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const base64urlBytes = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const sha256Hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');

async function googleAccessToken() {
  if (googleAccessTokenCache && googleAccessTokenCache.expiresAt > Date.now() + 60_000) {
    return googleAccessTokenCache.value;
  }
  let credentials;
  try {
    credentials = JSON.parse(Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON') || '');
  } catch {
    throw new Error('Google Play verification is not configured on the server.');
  }
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('Google Play verification is not configured on the server.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: GOOGLE_API_SCOPE,
    aud: GOOGLE_OAUTH_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  let assertion: string;
  try {
    const pem = String(credentials.private_key).replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
    const keyBytes = Uint8Array.from(atob(pem), character => character.charCodeAt(0));
    const signingKey = await crypto.subtle.importKey(
      'pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, encoder.encode(unsigned));
    assertion = `${unsigned}.${base64urlBytes(new Uint8Array(signature))}`;
  } catch {
    throw new Error('Google Play service-account key is invalid.');
  }

  let response: Response;
  try {
    response = await fetch(GOOGLE_OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error('Google Play verification is temporarily unavailable.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    console.error('[google-play] OAuth token request failed', response.status);
    throw new Error('Google Play verification is temporarily unavailable.');
  }
  googleAccessTokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  return googleAccessTokenCache.value;
}

async function googlePlayRequest(url: string, token: string, method = 'GET') {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error('Google Play verification is temporarily unavailable.');
  }
  const data = method === 'GET' ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    console.error('[google-play] API request failed', response.status);
    throw new HttpError(response.status === 404
      ? 'Google Play could not find this purchase.'
      : 'Google Play verification is temporarily unavailable.', response.status === 404 ? 400 : 503);
  }
  return data;
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return json({ error: 'Sign in first.' }, 401);
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/+$/, '');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || request.headers.get('apikey') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Wallet verification is not configured on the server.' }, 503);

  try {
    const raw = await request.text();
    if (raw.length > 8192) return json({ error: 'Request too large.' }, 413);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Invalid request.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request.' }, 400);
    const productId = String(body.productId || '').trim();
    const purchaseToken = String(body.purchaseToken || '');
    if (!/^[a-z0-9._]{1,150}$/.test(productId) || purchaseToken.length < 20 || purchaseToken.length > 4096) {
      return json({ error: 'Invalid Google Play purchase.' }, 400);
    }
    const product = GOOGLE_PLAY_COIN_PACKAGES.find(item => item.productId === productId);
    if (!product) return json({ error: 'Unknown coin package.' }, 400);

    let userResponse: Response;
    try {
      userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: authorization },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return json({ error: 'Account service is temporarily unavailable.' }, 503);
    }
    if (!userResponse.ok) {
      return json(
        { error: [401, 403].includes(userResponse.status) ? 'Sign in first.' : 'Account service is temporarily unavailable.' },
        [401, 403].includes(userResponse.status) ? 401 : 503,
      );
    }
    const user = await userResponse.json().catch(() => null);
    if (!user?.id) return json({ error: 'Sign in first.' }, 401);

    const accessToken = await googleAccessToken();
    const purchaseUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(GOOGLE_PLAY_PACKAGE_NAME)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    const purchase = await googlePlayRequest(purchaseUrl, accessToken);
    if (purchase?.productId && purchase.productId !== productId) return json({ error: 'Google Play product does not match.' }, 400);
    if (purchase?.purchaseState !== 0) {
      return json({
        error: purchase?.purchaseState === 2
          ? 'Google Play payment is pending. Coins will be added after it completes.'
          : 'Google Play has not confirmed this purchase.',
      }, 409);
    }
    if (Number(purchase.quantity ?? 1) !== 1) return json({ error: 'This purchase quantity is not supported.' }, 400);
    if (purchase.obfuscatedExternalAccountId !== await sha256Hex(user.id)) {
      return json({ error: 'This purchase belongs to a different account.' }, 403);
    }

    let creditResponse: Response;
    try {
      creditResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/mw_wallet_credit_google_play`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_user: user.id,
          p_purchase_token_hash: await sha256Hex(purchaseToken),
          p_product_id: productId,
          p_order_id: purchase.orderId || null,
          p_coins: product.coins,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return json({ error: 'Wallet service is temporarily unavailable. Retry to finish this purchase.' }, 503);
    }
    const credited = await creditResponse.json().catch(() => null);
    if (!creditResponse.ok || !credited?.ok) {
      console.error('[google-play] Verified purchase could not be credited', creditResponse.status);
      return json({ error: 'Wallet service could not credit this purchase. Retry to finish it.' }, 503);
    }

    if (purchase.consumptionState !== 1) {
      await googlePlayRequest(`${purchaseUrl}:consume`, accessToken, 'POST');
    }
    return json({
      ok: true,
      coins: Number(credited.coins) || 0,
      added: Number(credited.added) || 0,
      duplicate: Boolean(credited.duplicate),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Purchase verification failed.';
    return json({ error: message }, error instanceof HttpError ? error.status : 503);
  }
});

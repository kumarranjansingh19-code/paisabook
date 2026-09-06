/**
 * Google OAuth 2.0 implicit flow done by hand (no GIS popup): a redirect to
 * accounts.google.com and back to this page with the token in the URL hash.
 * Works inside installed PWAs (popups don't), needs no client secret.
 *
 * The OAuth client must be a "Web application" with this page's origin in both
 * "Authorized JavaScript origins" and "Authorized redirect URIs".
 */
import { getToken, setToken, settings } from '../store/local';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

export class AuthRequiredError extends Error {
  constructor(msg = 'Google sign-in required') {
    super(msg);
    this.name = 'AuthRequiredError';
  }
}

export function redirectUri(): string {
  return `${location.origin}${import.meta.env.BASE_URL}`;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Is this client a Google "Desktop app" client? Those only allow localhost redirects. */
export function isLocalhost(): boolean {
  return /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
}

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Kick off sign-in. With a client secret on the device we use the
 * authorization-code flow with PKCE and get a refresh token, so sign-in
 * survives the hourly access-token expiry (the old-app experience). Without
 * one we fall back to the implicit flow (access token only).
 */
export async function startSignIn(returnTo = location.hash || '#/'): Promise<void> {
  const { googleClientId: clientId, googleClientSecret: secret } = settings();
  if (!clientId) throw new Error('No OAuth client id configured');
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem('paisabook.oauth.state', state);
  sessionStorage.setItem('paisabook.oauth.return', returnTo);
  const common = { client_id: clientId, redirect_uri: redirectUri(), scope: SCOPES, include_granted_scopes: 'true', state };
  let params: URLSearchParams;
  if (secret) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)).buffer);
    sessionStorage.setItem('paisabook.oauth.verifier', verifier);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    params = new URLSearchParams({
      ...common,
      response_type: 'code',
      access_type: 'offline',
      prompt: getToken()?.refreshToken ? 'select_account' : 'consent', // consent is what makes Google issue a refresh token
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  } else {
    params = new URLSearchParams({ ...common, response_type: 'token', prompt: getToken() ? '' : 'consent' });
  }
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return (await res.json().catch(() => ({}))) as TokenResponse;
}

/**
 * Call once on boot: if the URL carries an OAuth response (code in the query
 * for the code flow, token in the hash for implicit), store it and clean the
 * URL. Returns the route to go back to.
 */
export async function consumeRedirect(): Promise<string | null> {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const isCode = query.has('code') || query.has('error');
  const isImplicit = hash.has('access_token');
  if (!isCode && !isImplicit) return null;
  const p = isCode ? query : hash;
  const expected = sessionStorage.getItem('paisabook.oauth.state');
  const returnTo = sessionStorage.getItem('paisabook.oauth.return') ?? '#/';
  const verifier = sessionStorage.getItem('paisabook.oauth.verifier') ?? '';
  for (const k of ['state', 'return', 'verifier']) sessionStorage.removeItem(`paisabook.oauth.${k}`);
  const clean = () => history.replaceState(null, '', location.pathname + returnTo);
  if (p.get('error')) {
    clean();
    throw new Error(`Google sign-in failed: ${p.get('error')}`);
  }
  if (expected && p.get('state') !== expected) {
    clean();
    throw new Error('OAuth state mismatch — please sign in again');
  }
  if (isCode) {
    const { googleClientId, googleClientSecret } = settings();
    const t = await tokenRequest({
      grant_type: 'authorization_code',
      code: p.get('code')!,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    });
    clean();
    if (!t.access_token) throw new Error(`Token exchange failed: ${t.error_description ?? t.error ?? 'unknown error'}`);
    setToken({
      accessToken: t.access_token,
      expiresAt: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000,
      scope: t.scope ?? '',
      refreshToken: t.refresh_token ?? getToken()?.refreshToken,
    });
    return returnTo;
  }
  const token = p.get('access_token');
  const expiresIn = Number(p.get('expires_in') ?? 3600);
  if (token) setToken({ accessToken: token, expiresAt: Date.now() + (expiresIn - 60) * 1000, scope: p.get('scope') ?? '' });
  clean();
  return returnTo;
}

/** True when we can make requests now or can silently get a fresh access token. */
export function hasValidToken(): boolean {
  const t = getToken();
  return !!t && (t.expiresAt > Date.now() || !!t.refreshToken);
}

let refreshing: Promise<string> | null = null;

/** Current access token, silently refreshed when expired and a refresh token exists. */
export async function accessToken(): Promise<string> {
  const t = getToken();
  if (!t) throw new AuthRequiredError();
  if (t.expiresAt > Date.now()) return t.accessToken;
  if (!t.refreshToken) throw new AuthRequiredError();
  if (!refreshing) {
    refreshing = (async () => {
      const { googleClientId, googleClientSecret } = settings();
      const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken!, client_id: googleClientId, client_secret: googleClientSecret });
      if (!r.access_token) {
        // invalid_grant = refresh token expired/revoked (testing-mode apps: 7 days) → sign in again
        setToken(null);
        throw new AuthRequiredError(`Google session expired (${r.error ?? 'refresh failed'}) — sign in again`);
      }
      setToken({ ...t, accessToken: r.access_token, expiresAt: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000, scope: r.scope ?? t.scope });
      return r.access_token;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export function signOut(): void {
  const t = getToken();
  setToken(null);
  if (t) {
    // best-effort revoke (the refresh token if we have one revokes everything); no-cors — we don't need the response
    const tok = t.refreshToken ?? t.accessToken;
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok)}`, { method: 'POST', mode: 'no-cors' }).catch(() => {});
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const REQUEST_TIMEOUT_MS = 45_000;

/** Combine the caller's signal with a per-request timeout so a hung request can never stall a sync. */
export function withTimeout(signal?: AbortSignal | null, ms = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal;
}

function extractMessage(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { message?: string } })?.error?.message;
  } catch {
    return undefined;
  }
}

/** Authenticated raw fetch with retry on 429/5xx (honours Retry-After). Throws AuthRequiredError on 401. */
export async function gfetchRaw(url: string, init: RequestInit = {}, retries = 8): Promise<Response> {
  const givenHeaders = (init.headers ?? {}) as Record<string, string>;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: withTimeout(init.signal),
        headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.body && !givenHeaders['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...givenHeaders },
      });
    } catch (err) {
      // "Failed to fetch" / timeout: transient network trouble — retry a few times before giving up
      if (init.signal?.aborted || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 401) {
      const t = getToken();
      if (t?.refreshToken && attempt === 0) {
        // access token revoked/expired early: force a refresh and retry once
        setToken({ ...t, expiresAt: 0 });
        continue;
      }
      setToken(null);
      throw new AuthRequiredError();
    }
    if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < retries) {
      const body = await res.text().catch(() => '');
      // 403 is only retryable when it's a rate limit, not a scope/permission problem.
      if (res.status === 403 && !/rate ?limit|quota|usageLimits/i.test(body)) throw new ApiError(403, extractMessage(body) ?? '403 Forbidden', body);
      const retryAfter = Number(res.headers.get('Retry-After')) || 0;
      // Per-minute quotas reset within 60s: back off up to 20s per attempt (≈2 min total over 8 retries).
      const wait = Math.min(retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 20_000) + Math.random() * 1000, 30_000);
      window.dispatchEvent(new CustomEvent('paisabook:ratelimit', { detail: { status: res.status, waitMs: wait, attempt, url } }));
      await new Promise((r, rej) => {
        const t = setTimeout(r, wait);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rej(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, extractMessage(body) ?? `${res.status} ${res.statusText}`, body);
    }
    return res;
  }
}

/** Authenticated JSON fetch. */
export async function gfetch<T>(url: string, init: RequestInit = {}, retries = 5): Promise<T> {
  const res = await gfetchRaw(url, init, retries);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function whoAmI(): Promise<{ email: string }> {
  return gfetch<{ email: string }>('https://www.googleapis.com/oauth2/v3/userinfo');
}

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

/** Kick off sign-in. Remembers where to return (hash route) across the redirect. */
export function startSignIn(returnTo = location.hash || '#/'): void {
  const clientId = settings().googleClientId;
  if (!clientId) throw new Error('No OAuth client id configured');
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem('paisabook.oauth.state', state);
  sessionStorage.setItem('paisabook.oauth.return', returnTo);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    state,
    prompt: getToken() ? '' : 'consent',
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/** Call once on boot: if the URL carries an OAuth response, store it and clean the URL. */
export function consumeRedirect(): string | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!/(^|&)access_token=/.test(hash)) return null;
  const p = new URLSearchParams(hash);
  const expected = sessionStorage.getItem('paisabook.oauth.state');
  const returnTo = sessionStorage.getItem('paisabook.oauth.return') ?? '#/';
  sessionStorage.removeItem('paisabook.oauth.state');
  sessionStorage.removeItem('paisabook.oauth.return');
  if (expected && p.get('state') !== expected) {
    history.replaceState(null, '', location.pathname);
    throw new Error('OAuth state mismatch — please sign in again');
  }
  const token = p.get('access_token');
  const expiresIn = Number(p.get('expires_in') ?? 3600);
  if (token) {
    setToken({ accessToken: token, expiresAt: Date.now() + (expiresIn - 60) * 1000, scope: p.get('scope') ?? '' });
  }
  history.replaceState(null, '', location.pathname + returnTo);
  return returnTo;
}

export function hasValidToken(): boolean {
  const t = getToken();
  return !!t && t.expiresAt > Date.now();
}

export function accessToken(): string {
  const t = getToken();
  if (!t || t.expiresAt <= Date.now()) throw new AuthRequiredError();
  return t.accessToken;
}

export function signOut(): void {
  const t = getToken();
  setToken(null);
  if (t) {
    // best-effort revoke; no-cors so we don't care about the response
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.accessToken)}`, { method: 'POST', mode: 'no-cors' }).catch(() => {});
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
    const res = await fetch(url, {
      ...init,
      signal: withTimeout(init.signal),
      headers: { Authorization: `Bearer ${accessToken()}`, ...(init.body && !givenHeaders['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...givenHeaders },
    });
    if (res.status === 401) {
      setToken(null);
      throw new AuthRequiredError();
    }
    if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < retries) {
      const body = await res.text().catch(() => '');
      // 403 is only retryable when it's a rate limit, not a scope/permission problem.
      if (res.status === 403 && !/rate ?limit|quota|usageLimits/i.test(body)) throw new ApiError(403, extractMessage(body) ?? '403 Forbidden', body);
      const retryAfter = Number(res.headers.get('Retry-After')) || 0;
      // Per-minute quotas reset within 60s: back off up to 20s per attempt (≈2 min total over 8 retries).
      const wait = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 20_000) + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
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

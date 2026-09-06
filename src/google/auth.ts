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

/** Authenticated fetch with retry on 429/5xx. Throws AuthRequiredError on 401. */
export async function gfetch<T>(url: string, init: RequestInit = {}, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
    if (res.status === 401) {
      setToken(null);
      throw new AuthRequiredError();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      let body: unknown = await res.text();
      try {
        body = JSON.parse(body as string);
      } catch {
        /* text */
      }
      const msg = (body as { error?: { message?: string } })?.error?.message ?? `${res.status} ${res.statusText}`;
      throw new ApiError(res.status, msg, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

export async function whoAmI(): Promise<{ email: string }> {
  return gfetch<{ email: string }>('https://www.googleapis.com/oauth2/v3/userinfo');
}

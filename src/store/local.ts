/**
 * Device-only storage. Secrets never go into the Google Sheet: OAuth client id,
 * Gemini key, statement passwords, and the current access token stay here.
 */
export interface DeviceSettings {
  googleClientId: string;
  /** From the downloaded client JSON. Enables the code flow + refresh token (sign in once). Device-only. */
  googleClientSecret: string;
  geminiApiKey: string;
  modelBulk: string;
  modelReasoning: string;
  spreadsheetId: string;
  gmailExtraQuery: string;
  /** account id → statement PDF password (remembered only if the user ticks "remember") */
  passwords: Record<string, string>;
  setupDone: boolean;
}

const KEY = 'paisabook.settings.v1';
const TOKEN_KEY = 'paisabook.token.v1';

export const DEFAULTS: DeviceSettings = {
  googleClientId: '',
  googleClientSecret: '',
  geminiApiKey: '',
  modelBulk: 'gemini-3.5-flash-lite',
  modelReasoning: 'gemini-3.7-flash',
  spreadsheetId: '',
  gmailExtraQuery: '',
  passwords: {},
  setupDone: false,
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

let cache: DeviceSettings | null = null;

export function settings(): DeviceSettings {
  if (!cache) cache = read(KEY, DEFAULTS);
  return cache;
}

export function saveSettings(patch: Partial<DeviceSettings>): DeviceSettings {
  cache = { ...settings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode */
  }
  return cache;
}

export interface StoredToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
  /** present with the code flow; lets the app renew access without a new sign-in */
  refreshToken?: string;
}

export function getToken(): StoredToken | null {
  const t = read<StoredToken | null>(TOKEN_KEY, null);
  return t && t.accessToken ? t : null;
}

export function setToken(t: StoredToken | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Wipe everything on this device (the Google Sheet is untouched). */
export function resetDevice(): void {
  cache = null;
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('paisabook.cache.v1');
  } catch {
    /* ignore */
  }
}

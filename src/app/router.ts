import { db } from '../store/db';
import { settings } from '../store/local';
import { hasValidToken, startSignIn } from '../google/auth';
import { syncState, onSync } from '../core/sync';
import { html, raw, toast } from './ui';

export interface View {
  /** Render into the container; return a cleanup fn if you subscribed to anything. */
  render(root: HTMLElement, params: URLSearchParams): void | (() => void) | Promise<void | (() => void)>;
  title: string;
  requiresDb?: boolean;
}

const routes = new Map<string, View>();
export function route(path: string, view: View): void {
  routes.set(path, view);
}

const NAV: Array<{ path: string; label: string; icon: string }> = [
  { path: '/', label: 'Home', icon: '⌂' },
  { path: '/txns', label: 'Ledger', icon: '☰' },
  { path: '/sync', label: 'Sync', icon: '⟳' },
  { path: '/accounts', label: 'Accounts', icon: '▤' },
  { path: '/more', label: 'More', icon: '⋯' },
];

let cleanup: (() => void) | void;
let unsubSync: (() => void) | null = null;

export function navigate(path: string): void {
  location.hash = `#${path}`;
}

export function currentPath(): { path: string; params: URLSearchParams } {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?') as [string, string?];
  return { path: path || '/', params: new URLSearchParams(qs ?? '') };
}

export async function renderCurrent(): Promise<void> {
  const app = document.getElementById('app')!;
  const { path, params } = currentPath();
  const s = settings();
  if (!s.setupDone && path !== '/setup') {
    navigate('/setup');
    return;
  }
  const view = routes.get(path) ?? routes.get('/')!;
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  app.innerHTML = shell(path, view);
  wireInstallBar();
  const main = app.querySelector<HTMLElement>('#view')!;
  if (view.requiresDb !== false && s.setupDone) {
    if (!hasValidToken()) {
      main.innerHTML = signInCard();
      main.querySelector('[data-signin]')?.addEventListener('click', () => void startSignIn(location.hash));
      return;
    }
    if (!db.loaded) {
      main.innerHTML = `<div class="card"><div class="spinner-row"><span class="spinner"></span> Loading your sheet…</div></div>`;
      try {
        await db.load();
      } catch (err) {
        main.innerHTML = html`<div class="card error"><h3>Couldn't load the sheet</h3><p>${String((err as Error).message)}</p>
          <p><a href="#/setup?step=sheet" class="btn">Reconnect a sheet</a></p></div>`;
        return;
      }
    }
  }
  document.title = `${view.title} · PaisaBook`;
  try {
    cleanup = await view.render(main, params);
  } catch (err) {
    main.innerHTML = html`<div class="card error"><h3>Something broke</h3><pre>${String((err as Error).stack ?? err)}</pre></div>`;
  }
  if (!unsubSync) unsubSync = onSync(updateSyncBadge);
  updateSyncBadge();
}

function updateSyncBadge(): void {
  const b = document.getElementById('sync-badge');
  if (!b) return;
  b.hidden = !syncState.running && !syncState.pendingPdfs.length;
  b.textContent = syncState.running ? '●' : String(syncState.pendingPdfs.length);
  b.className = syncState.running ? 'badge live' : 'badge';
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
const w = window as unknown as { paisabookInstall?: () => Promise<boolean>; paisabookCanInstall?: () => boolean };

/** Offer installation from the very first screen; dismissable per device. */
function installBar(): string {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('paisabook.installDismissed') === '1';
  } catch {
    /* ignore */
  }
  if (isStandalone() || dismissed) return '';
  if (w.paisabookCanInstall?.()) {
    return `<div class="install-bar"><span>Install PaisaBook on this device for the app experience (works offline, opens full-screen).</span>
      <button class="btn small primary" data-install>Install</button><button class="btn small ghost" data-install-dismiss title="Not now">✕</button></div>`;
  }
  if (isIos()) {
    return `<div class="install-bar"><span>To install on iPhone/iPad: tap <strong>Share</strong> then <strong>Add to Home Screen</strong>.</span>
      <button class="btn small ghost" data-install-dismiss title="Not now">✕</button></div>`;
  }
  return '';
}

function wireInstallBar(): void {
  document.querySelector('[data-install]')?.addEventListener('click', async () => {
    const ok = await w.paisabookInstall?.();
    toast(ok ? 'Installed — find PaisaBook on your home screen' : 'Install dismissed');
    document.getElementById('install-slot')!.innerHTML = installBar();
    wireInstallBar();
  });
  document.querySelector('[data-install-dismiss]')?.addEventListener('click', () => {
    try {
      localStorage.setItem('paisabook.installDismissed', '1');
    } catch {
      /* ignore */
    }
    document.getElementById('install-slot')!.innerHTML = '';
  });
}
document.addEventListener('paisabook:installable', () => {
  const slot = document.getElementById('install-slot');
  if (slot) {
    slot.innerHTML = installBar();
    wireInstallBar();
  }
});

function shell(path: string, view: View): string {
  return html`
    <header class="topbar">
      <a href="#/" class="brand"><img src="${import.meta.env.BASE_URL}icons/icon.svg" alt="" width="24" height="24" /> PaisaBook</a>
      <span class="topbar-title">${view.title}</span>
      ${db.loaded ? raw(`<a class="sheet-link" href="${db.sheetUrl()}" target="_blank" rel="noopener" title="Open the Google Sheet">Sheet ↗</a>`) : ''}
    </header>
    <div id="install-slot">${raw(installBar())}</div>
    <main id="view"></main>
    <nav class="tabbar">
      ${raw(
        NAV.map(
          (n) => `<a href="#${n.path}" class="${n.path === path || (n.path === '/more' && ['/rules', '/sources', '/settings'].includes(path)) ? 'active' : ''}">
              <span class="icon">${n.icon}${n.path === '/sync' ? '<span id="sync-badge" class="badge" hidden></span>' : ''}</span><span>${n.label}</span></a>`,
        ).join(''),
      )}
    </nav>`;
}

function signInCard(): string {
  return `<div class="card center">
    <h2>Sign in to Google</h2>
    <p class="muted">Your session expired. Sign in again to read Gmail and your Sheet. Nothing leaves your browser except calls to Google and Gemini.</p>
    <button class="btn primary" data-signin>Sign in with Google</button>
  </div>`;
}

export function start(): void {
  window.addEventListener('hashchange', () => void renderCurrent());
  void renderCurrent();
  window.addEventListener('unhandledrejection', (e) => {
    const msg = String((e.reason as Error)?.message ?? e.reason);
    if (/AuthRequired|sign-in required/i.test(msg)) {
      toast('Google session expired — sign in again', 'error');
      void renderCurrent();
    }
  });
}

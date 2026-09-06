import { db } from '../store/db';
import { settings } from '../store/local';
import { hasValidToken, startSignIn } from '../google/auth';
import { syncState, onSync } from '../core/sync';
import { html, raw, toast } from './ui';
import { addRipples } from './material';

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

/* Material Symbols paths (Apache 2.0) */
const ICONS = {
  home: 'M6 19h3v-6h6v6h3v-9l-6-4.5L6 10v9Zm-2 2V9l8-6 8 6v12h-7v-6h-2v6H4Z',
  receipt: 'M4 22V2l1.5 1.5L7 2l1.5 1.5L10 2l1.5 1.5L13 2l1.5 1.5L16 2l1.5 1.5L19 2l1.5 1.5L22 2v20l-1.5-1.5L19 22l-1.5-1.5L16 22l-1.5-1.5L13 22l-1.5-1.5L10 22l-1.5-1.5L7 22l-1.5-1.5L4 22Zm3-5h10v-2H7v2Zm0-4h10v-2H7v2Zm0-4h10V7H7v2Z',
  sync: 'M12 20q-3.35 0-5.675-2.325T4 12q0-3.35 2.325-5.675T12 4q1.725 0 3.3.713T18 6.75V4h2v7h-7V9h4.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12q0 2.5 1.75 4.25T12 18q1.925 0 3.475-1.1T17.65 14h2.1q-.7 2.65-2.85 4.325T12 20Z',
  bank: 'M4 20v-2h16v2H4Zm1-3v-7h2v7H5Zm4 0v-7h2v7H9Zm4 0v-7h2v7h-2Zm4 0v-7h2v7h-2ZM3 8V6l9-4.5L21 6v2H3Z',
  more: 'M6 14q-.825 0-1.412-.588T4 12q0-.825.588-1.413T6 10q.825 0 1.413.587T8 12q0 .825-.587 1.412T6 14Zm6 0q-.825 0-1.412-.588T10 12q0-.825.588-1.413T12 10q.825 0 1.413.587T14 12q0 .825-.587 1.412T12 14Zm6 0q-.825 0-1.412-.588T16 12q0-.825.588-1.413T18 10q.825 0 1.413.587T20 12q0 .825-.587 1.412T18 14Z',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const NAV: Array<{ path: string; label: string; icon: string }> = [
  { path: '/', label: 'Home', icon: svg(ICONS.home) },
  { path: '/txns', label: 'Ledger', icon: svg(ICONS.receipt) },
  { path: '/sync', label: 'Sync', icon: svg(ICONS.sync) },
  { path: '/accounts', label: 'Accounts', icon: svg(ICONS.bank) },
  { path: '/more', label: 'More', icon: svg(ICONS.more) },
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
  const view = routes.get(path) ?? routes.get('/')!;
  // Until setup is done only the data screens redirect to the wizard; More and Settings stay reachable.
  if (!s.setupDone && path !== '/setup' && view.requiresDb !== false) {
    navigate('/setup');
    return;
  }
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  app.innerHTML = shell(path, view);
  wireInstallBar();
  app.querySelector('[data-apply-update]')?.addEventListener('click', () => wu.paisabookApplyUpdate?.());
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
  addRipples(app);
  // views re-render themselves on data changes; keep ripples on new rows
  new MutationObserver(() => addRipples(main)).observe(main, { childList: true, subtree: true });
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

const wu = window as unknown as { paisabookUpdateReady?: () => boolean; paisabookApplyUpdate?: () => void };

/** A new build is downloaded and waiting: offer it without forcing a reload mid-sync. */
function updateBar(): string {
  if (!wu.paisabookUpdateReady?.()) return '';
  return `<div class="install-bar update-bar"><span>A new version of PaisaBook is ready.</span><md-filled-button data-small data-apply-update>Update now</md-filled-button></div>`;
}
document.addEventListener('paisabook:update-ready', () => {
  const slot = document.getElementById('update-slot');
  if (slot) {
    slot.innerHTML = updateBar();
    slot.querySelector('[data-apply-update]')?.addEventListener('click', () => wu.paisabookApplyUpdate?.());
  }
});

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
      <md-filled-button data-small data-install>Install</md-filled-button><md-text-button data-small data-install-dismiss title="Not now">✕</md-text-button></div>`;
  }
  if (isIos()) {
    return `<div class="install-bar"><span>To install on iPhone/iPad: tap <strong>Share</strong> then <strong>Add to Home Screen</strong>.</span>
      <md-text-button data-small data-install-dismiss title="Not now">✕</md-text-button></div>`;
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
    <div id="update-slot">${raw(updateBar())}</div>
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
    <md-filled-button data-signin>Sign in with Google</md-filled-button>
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

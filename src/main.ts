import './styles.css';
import './app/material';
import { registerSW } from 'virtual:pwa-register';
import { consumeRedirect } from './google/auth';
import { onSync, syncState } from './core/sync';
import { route, start, navigate } from './app/router';
import { toast } from './app/ui';
import { setupView } from './views/setup';
import { dashboardView } from './views/dashboard';
import { transactionsView } from './views/transactions';
import { accountsView } from './views/accounts';
import { syncView } from './views/sync';
import { sourcesView } from './views/sources';
import { rulesView } from './views/rules';
import { moreView, settingsView } from './views/settings';

/**
 * Updates: the service worker is polled every 15 minutes (installed PWAs
 * otherwise only check on launch). When a new build is ready we reload at
 * once — unless a sync is running, in which case a banner offers the update
 * and it applies when the user taps it or the sync ends.
 */
let updateReady = false;
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration) {
      setInterval(() => registration.update().catch(() => {}), 15 * 60 * 1000);
      (window as unknown as { paisabookCheckUpdate: () => Promise<boolean> }).paisabookCheckUpdate = async () => {
        await registration.update();
        return !!(registration.installing || registration.waiting) || updateReady;
      };
    }
  },
  onNeedRefresh() {
    updateReady = true;
    document.dispatchEvent(new Event('paisabook:update-ready'));
    if (!syncState.running) {
      toast('New version ready — restarting…');
      setTimeout(() => void updateSW(true), 1200);
    } else {
      toast('New version ready — it will apply after the sync');
      const off = onSync(() => {
        if (!syncState.running) {
          off();
          setTimeout(() => void updateSW(true), 1500);
        }
      });
    }
  },
});
export function isUpdateReady(): boolean {
  return updateReady;
}
export function applyUpdate(): void {
  void updateSW(true);
}
(window as unknown as { paisabookApplyUpdate: () => void; paisabookUpdateReady: () => boolean }).paisabookApplyUpdate = applyUpdate;
(window as unknown as { paisabookApplyUpdate: () => void; paisabookUpdateReady: () => boolean }).paisabookUpdateReady = isUpdateReady;

/**
 * Install prompt: Chrome/Edge/Android fire `beforeinstallprompt`; we keep the
 * event and offer a button from the first screen. iOS has no event, so the
 * shell shows the Share → Add to Home Screen hint instead.
 */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let installEvent: InstallEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as InstallEvent;
  document.dispatchEvent(new Event('paisabook:installable'));
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  document.dispatchEvent(new Event('paisabook:installable'));
});
export function canPromptInstall(): boolean {
  return !!installEvent;
}
export async function promptInstall(): Promise<boolean> {
  if (!installEvent) return false;
  await installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  return outcome === 'accepted';
}
(window as unknown as { paisabookInstall: () => Promise<boolean>; paisabookCanInstall: () => boolean }).paisabookInstall = promptInstall;
(window as unknown as { paisabookInstall: () => Promise<boolean>; paisabookCanInstall: () => boolean }).paisabookCanInstall = canPromptInstall;

/** Hard refresh: drop every cache and service worker, then reload. Exposed for the More page. */
export async function clearCachesAndReload(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map((r) => r.unregister()));
    const keys = await caches?.keys?.();
    await Promise.all((keys ?? []).map((k) => caches.delete(k)));
  } finally {
    location.reload();
  }
}
(window as unknown as { paisabookClearCaches: () => Promise<void> }).paisabookClearCaches = clearCachesAndReload;

route('/', dashboardView);
route('/setup', setupView);
route('/txns', transactionsView);
route('/accounts', accountsView);
route('/sync', syncView);
route('/sources', sourcesView);
route('/rules', rulesView);
route('/settings', settingsView);
route('/more', moreView);

try {
  const back = await consumeRedirect();
  if (back) {
    toast('Signed in to Google', 'ok');
    navigate(back.replace(/^#/, ''));
  }
} catch (err) {
  toast(String((err as Error).message), 'error');
}

start();

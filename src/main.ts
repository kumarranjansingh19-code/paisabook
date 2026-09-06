import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { consumeRedirect } from './google/auth';
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

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    // Installed PWAs only check for a new service worker on launch; poll too.
    if (registration) setInterval(() => registration.update().catch(() => {}), 15 * 60 * 1000);
  },
  onNeedRefresh() {
    toast('Update available — reloading…');
    setTimeout(() => void updateSW(true), 1200);
  },
});

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
  const back = consumeRedirect();
  if (back) {
    toast('Signed in to Google', 'ok');
    navigate(back.replace(/^#/, ''));
  }
} catch (err) {
  toast(String((err as Error).message), 'error');
}

start();

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

registerSW({
  immediate: true,
  onNeedRefresh() {
    toast('Update available — reload to get it');
  },
});

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

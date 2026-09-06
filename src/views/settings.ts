import type { View } from '../app/router';
import { pairOwnTransfers, tagFamilyTransfers } from '../core/categorize';
import { html, raw, onAction, toast, modal, confirmDialog, downloadText, spinner, deferWhileTyping } from '../app/ui';
import { db, newId, stamp, type Category } from '../store/db';
import { addCategory, categories } from '../core/categories';
import { cacheStats, clearMailCache } from '../store/mailcache';
import { importWithNewPassword } from '../core/sync';
import { settings, saveSettings, resetDevice } from '../store/local';
import { signOut, redirectUri, hasValidToken, startSignIn } from '../google/auth';
import { escapeHtml } from '../core/text';
import { testGemini, usage } from '../llm/gemini';
import { navigate } from '../app/router';

export const moreView: View = {
  title: 'More',
  requiresDb: false,
  render(root) {
    root.innerHTML = html`
      ${!settings().setupDone ? raw('<div class="card warn small">Setup isn\'t finished yet — <a href="#/setup">continue the wizard</a> to unlock Home, Ledger, Sync and Accounts.</div>') : ''}
      <div class="card">
        <a class="list-item" href="#/rules"><div class="grow"><div class="title">Categorization rules</div><div class="sub">Deterministic rules, AI suggestions</div></div>›</a>
        <a class="list-item" href="#/sources"><div class="grow"><div class="title">Other sources</div><div class="sub">Import transactions from any Google Sheet</div></div>›</a>
        <a class="list-item" href="#/settings"><div class="grow"><div class="title">Settings</div><div class="sub">Keys, models, family, sheet, sign-out</div></div>›</a>
        ${db.loaded ? raw(`<a class="list-item" href="${db.sheetUrl()}" target="_blank" rel="noopener"><div class="grow"><div class="title">Open the Google Sheet ↗</div><div class="sub">Your data, in your Drive</div></div></a>`) : ''}
      </div>
      <div class="card">
        <h3>App</h3>
        <p class="small muted">Build <code>${__BUILD__}</code>. New builds are checked for every 15 minutes and on launch; updates apply automatically, or after a running sync finishes.</p>
        <div class="row">
          <md-filled-button data-small data-action="update">Check for updates</md-filled-button>
          <md-text-button data-small data-action="hard-refresh">Clear cache & reinstall</md-text-button>
        </div>
        <div id="update-status" class="small" style="margin-top:.5rem"></div>
      </div>
      <p class="muted small center">PaisaBook · open source · <a href="https://github.com/kumarranjansingh19-code/paisabook" target="_blank" rel="noopener">source</a></p>`;
    onAction(root, {
      update: async (el) => {
        const status = root.querySelector('#update-status')!;
        const w = window as unknown as { paisabookCheckUpdate?: () => Promise<boolean>; paisabookApplyUpdate?: () => void };
        if (!w.paisabookCheckUpdate) {
          status.textContent = 'No service worker here (dev mode) — updates apply on the installed app.';
          return;
        }
        el.setAttribute('disabled', '');
        status.innerHTML = spinner('Checking…');
        try {
          const found = await w.paisabookCheckUpdate();
          status.innerHTML = found
            ? `<span class="pill ok">Update found</span> <md-filled-button data-small data-action="apply-update">Install & restart</md-filled-button>`
            : `<span class="pill ok">You're on the latest build</span>`;
        } catch (err) {
          status.innerHTML = `<span class="pill bad">${escapeHtml(String((err as Error).message))}</span>`;
        } finally {
          el.removeAttribute('disabled');
        }
      },
      'apply-update': () => (window as unknown as { paisabookApplyUpdate?: () => void }).paisabookApplyUpdate?.(),
      'hard-refresh': () => (window as unknown as { paisabookClearCaches: () => Promise<void> }).paisabookClearCaches(),
    });
  },
};

export const settingsView: View = {
  title: 'Settings',
  requiresDb: false,
  render(root) {
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    onAction(root, {
      'save-keys': async () => {
        const v = (n: string) => root.querySelector<HTMLInputElement>(`[name=${n}]`)!.value.trim();
        saveSettings({ geminiApiKey: v('geminiApiKey'), modelBulk: v('modelBulk'), modelReasoning: v('modelReasoning'), gmailExtraQuery: v('gmailExtraQuery'), readMode: v('readMode') === 'economy' ? 'economy' : 'accurate' });
        try {
          await testGemini();
          toast('Saved · Gemini OK', 'ok');
        } catch (err) {
          toast(`Saved, but Gemini failed: ${String((err as Error).message)}`, 'error');
        }
      },
      'add-family': async () => {
        const r = await modal(
          `<md-outlined-text-field class="field" label="Name" name="name" required></md-outlined-text-field>
           <md-outlined-select class="field" label="Relation" name="relation"><md-select-option value="self"><div slot="headline">me</div></md-select-option><md-select-option value="spouse"><div slot="headline">spouse</div></md-select-option><md-select-option value="parent"><div slot="headline">parent</div></md-select-option><md-select-option value="child"><div slot="headline">child</div></md-select-option><md-select-option value="sibling"><div slot="headline">sibling</div></md-select-option><md-select-option value="other"><div slot="headline">other</div></md-select-option></md-outlined-select>`,
          { title: 'Family member', submit: 'Add' },
        );
        if (!r?.name) return;
        await db.append(db.family, [{ id: newId('fam'), name: r.name, relation: r.relation ?? 'other', created_at: stamp() }]);
        const retagged = r.relation === 'self' ? pairOwnTransfers() : tagFamilyTransfers();
        if (retagged) {
          await db.flush();
          toast(`${retagged} existing transaction${retagged > 1 ? 's' : ''} re-tagged as ${r.relation === 'self' ? 'self transfer' : 'family transfer'}`, 'ok');
        }
        draw();
      },
      'del-family': async (el) => {
        db.update(db.family, el.dataset.id!, { name: '', relation: '' });
        await db.flush();
        db.family.rows = db.family.rows.filter((f) => f.id !== el.dataset.id);
        draw();
      },
      export: () => {
        const rows = db.liveTransactions();
        const csv = ['date,account,direction,amount,narration,merchant,category,status,source']
          .concat(rows.map((t) => [t.posted_at, db.accounts.get(t.account_id)?.display_name ?? '', t.direction, (t.amount_paise / 100).toFixed(2), t.narration, t.merchant, t.category, t.status, t.source].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')))
          .join('\n');
        downloadText('paisabook-transactions.csv', csv, 'text/csv');
      },
      signin: () => void startSignIn('#/settings'),
      signout: () => {
        signOut();
        draw();
        toast('Signed out of Google');
      },
      reset: async () => {
        if (!(await confirmDialog('Forget everything on this device (keys, passwords, sheet link)? The Google Sheet itself is not touched.', 'Forget'))) return;
        signOut();
        resetDevice();
        location.hash = '#/setup';
        location.reload();
      },
      'change-sheet': () => navigate('/setup?step=sheet'),
      'save-recipe': async (el) => {
        const v = (n: string) => root.querySelector<HTMLInputElement>(`[name=${n}]`)!.value.trim();
        saveSettings({ pwRecipe: { dob: v('pwDob'), pan: v('pwPan').toUpperCase(), mobile: v('pwMobile'), name: v('pwName') } });
        el.setAttribute('disabled', '');
        toast('Saved on this device — trying waiting statements…');
        const { imported, remaining } = await importWithNewPassword();
        toast(imported ? `${imported} statement${imported > 1 ? 's' : ''} opened${remaining ? `, ${remaining} still waiting` : ''}` : remaining ? `Saved. ${remaining} PDF${remaining > 1 ? 's' : ''} still need a password` : 'Saved', 'ok');
        el.removeAttribute('disabled');
      },
      'clear-mail-cache': async () => {
        const stats = await cacheStats();
        if (!(await confirmDialog(`Clear ${stats.emails} cached emails and their AI readings from this device? The sheet is untouched; the next sync re-downloads and re-reads them (costs Gmail quota and AI calls).`, 'Clear'))) return;
        await clearMailCache();
        toast('Cache cleared', 'ok');
      },
      'add-category': async () => {
        const r = await modal(
          `<md-outlined-text-field class="field" label="Name" name="label" placeholder="Pet care" required></md-outlined-text-field>
           <md-outlined-select class="field" label="Kind" name="kind"><md-select-option value="spend"><div slot="headline">Spend (counts as consumption)</div></md-select-option><md-select-option value="income"><div slot="headline">Income</div></md-select-option><md-select-option value="transfer"><div slot="headline">Transfer (never spend or income)</div></md-select-option><md-select-option value="investment"><div slot="headline">Investment</div></md-select-option><md-select-option value="refund"><div slot="headline">Refund (reduces spend)</div></md-select-option></md-outlined-select>
           <md-outlined-text-field class="field" label="What goes here (helps the AI)" name="description" placeholder="vet, pet food, grooming"></md-outlined-text-field>`,
          { title: 'New category', submit: 'Add' },
        );
        if (!r?.label) return;
        try {
          const c = await addCategory(r.label, (r.kind as Category['kind']) ?? 'spend', r.description ?? '');
          toast(`Added "${c.label}" (${c.name})`, 'ok');
          draw();
        } catch (err) {
          toast(String((err as Error).message), 'error');
        }
      },
    });
    return db.onChange(deferWhileTyping(root, draw));
  },
};

function page(): string {
  const s = settings();
  return html`
    <div class="card">
      <h3>Google</h3>
      <p class="small">Client ID <code>${s.googleClientId || '—'}</code><br/>Redirect URI <code>${redirectUri()}</code></p>
      <div class="row">${hasValidToken() ? raw('<span class="pill ok">signed in</span> <md-outlined-button data-small data-action="signout">Sign out</md-outlined-button>') : raw('<md-filled-button data-small data-action="signin">Sign in</md-filled-button>')}
        <md-outlined-button data-small data-action="change-sheet">Change sheet</md-outlined-button>
        ${db.loaded ? raw(`<a class="btn small" href="${db.sheetUrl()}" target="_blank" rel="noopener">Open sheet ↗</a>`) : ''}</div>
    </div>
    <div class="card">
      <h3>Gemini</h3>
      <md-outlined-text-field class="field" label="API key" name="geminiApiKey" type="password" value="${s.geminiApiKey}" autocomplete="off"></md-outlined-text-field>
      <div class="row"><md-outlined-text-field class="field grow" label="Bulk model" name="modelBulk" value="${s.modelBulk}"></md-outlined-text-field><md-outlined-text-field class="field grow" label="Reasoning model" name="modelReasoning" value="${s.modelReasoning}"></md-outlined-text-field></div>
      <md-outlined-select class="field" label="How alerts are read" name="readMode">
          <md-select-option value="accurate" ${s.readMode !== 'economy' ? 'selected' : ''}><div slot="headline">Accurate — the AI writes every entry; rules only double-check amounts</div></md-select-option>
          <md-select-option value="economy" ${s.readMode === 'economy' ? 'selected' : ''}><div slot="headline">Economy — rules write what they can, the AI reads the rest (fewer calls)</div></md-select-option>
        </md-outlined-select>
      <md-outlined-text-field class="field" label="Extra Gmail search terms (added to every scan)" name="gmailExtraQuery" value="${s.gmailExtraQuery}" placeholder='e.g. -from:newsletter@example.com'></md-outlined-text-field>
      <md-filled-button data-action="save-keys">Save & test</md-filled-button>
      ${usage.calls ? raw(`<p class="muted small">This session: ${usage.calls} AI calls, ${Math.round(usage.inputTokens / 1000)}k tokens in.</p>`) : ''}
    </div>
    <div class="card">
      <div class="row between"><h3>Family</h3><md-outlined-button data-small data-action="add-family">+ Add</md-outlined-button></div>
      <p class="small muted">Payments naming a family member are tagged <em>family transfer</em> instead of spending — existing rows are re-tagged the moment you add someone. Add yourself as <em>self</em> so moves between your own accounts are never counted as income.</p>
      ${db.family.rows.length ? raw(db.family.rows.map((f) => `<div class="list-item"><div class="grow">${escapeHtml(f.name)} <span class="muted small">${escapeHtml(f.relation)}</span></div><md-text-button data-small data-action="del-family" data-id="${f.id}">✕</md-text-button></div>`).join('')) : ''}
    </div>
    <div class="card">
      <h3>Statement passwords: let the app guess</h3>
      <p class="small muted">Banks build PDF passwords from these (and say which in the email). Stored only on this device; the app tries the usual recipes before asking you, and remembers the one that works per account.</p>
      <div class="row">
        <md-outlined-text-field class="field grow" label="Date of birth" type="date" name="pwDob" value="${s.pwRecipe?.dob ?? ''}"></md-outlined-text-field>
        <md-outlined-text-field class="field grow" label="PAN" name="pwPan" value="${s.pwRecipe?.pan ?? ''}" autocapitalize="characters" autocomplete="off" placeholder="ABCDE1234F"></md-outlined-text-field>
      </div>
      <div class="row">
        <md-outlined-text-field class="field grow" label="Mobile" name="pwMobile" inputmode="numeric" value="${s.pwRecipe?.mobile ?? ''}" autocomplete="off"></md-outlined-text-field>
        <md-outlined-text-field class="field grow" label="Name as on the account" name="pwName" value="${s.pwRecipe?.name ?? ''}" autocomplete="off"></md-outlined-text-field>
      </div>
      <md-filled-button data-small data-action="save-recipe">Save & try waiting statements</md-filled-button>
    </div>
    <div class="card">
      <div class="row between"><h3>Categories</h3><md-outlined-button data-small data-action="add-category">+ Add</md-outlined-button></div>
      <p class="small muted">Copied into your sheet's <em>categories</em> tab the first time; edit labels and descriptions there, or add more here. The kind decides how a category counts: spend, income, transfer (never spend), investment, or refund (reduces spend).</p>
      ${db.loaded ? raw(`<div class="table-wrap"><table><thead><tr><th>Category</th><th>Kind</th><th>Used</th></tr></thead><tbody>${categories()
        .map((c) => `<tr><td>${escapeHtml(c.label)} <span class="muted small">${escapeHtml(c.name)}</span></td><td><span class="pill muted">${c.kind}</span></td><td class="num">${db.liveTransactions().filter((t) => t.category === c.name).length}</td></tr>`)
        .join('')}</tbody></table></div>`) : raw('<p class="small muted">Sign in and open a data tab to see the list.</p>')}
    </div>
    <div class="card">
      <h3>Data</h3>
      <p class="small muted">Statement passwords stay on this device (set them from the key button on each account). Everything else lives in your Google Sheet.</p>
      <div class="row"><md-outlined-button data-action="export">Export CSV</md-outlined-button><md-outlined-button data-action="clear-mail-cache">Clear mail & AI cache</md-outlined-button><md-outlined-button class="danger" data-action="reset">Forget this device</md-outlined-button></div>
      <p class="small muted">The mail & AI cache holds downloaded emails and model results on this device so re-runs are free. Clear it to measure a true first-time run, or to free space.</p>
    </div>`;
}

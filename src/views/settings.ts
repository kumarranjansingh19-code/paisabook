import type { View } from '../app/router';
import { html, raw, onAction, toast, modal, confirmDialog, downloadText, spinner } from '../app/ui';
import { db, newId, stamp } from '../store/db';
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
          <button class="btn primary small" data-action="update">Check for updates</button>
          <button class="btn small ghost" data-action="hard-refresh">Clear cache & reinstall</button>
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
            ? `<span class="pill ok">Update found</span> <button class="btn small primary" data-action="apply-update">Install & restart</button>`
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
        saveSettings({ geminiApiKey: v('geminiApiKey'), modelBulk: v('modelBulk'), modelReasoning: v('modelReasoning'), gmailExtraQuery: v('gmailExtraQuery') });
        try {
          await testGemini();
          toast('Saved · Gemini OK', 'ok');
        } catch (err) {
          toast(`Saved, but Gemini failed: ${String((err as Error).message)}`, 'error');
        }
      },
      'add-family': async () => {
        const r = await modal(
          `<label class="field">Name <input name="name" required /></label>
           <label class="field">Relation <select name="relation"><option value="self">me</option><option>spouse</option><option>parent</option><option>child</option><option>sibling</option><option>other</option></select></label>`,
          { title: 'Family member', submit: 'Add' },
        );
        if (!r?.name) return;
        await db.append(db.family, [{ id: newId('fam'), name: r.name, relation: r.relation ?? 'other', created_at: stamp() }]);
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
      'pw-toggle': (el) => {
        const id = el.dataset.id!;
        if (revealed.has(id)) revealed.delete(id);
        else revealed.add(id);
        draw();
      },
      'pw-edit': async (el) => {
        const a = db.accounts.get(el.dataset.id!);
        if (!a) return;
        const r = await modal(
          `<p class="small muted">${a.password_hint ? `Your hint: <em>${escapeHtml(a.password_hint)}</em>` : 'Banks usually explain the password in the statement email (date of birth, PAN, mobile digits…).'}</p>
           <label class="field">Password <input name="pw" value="${escapeHtml(settings().passwords[a.id] ?? '')}" autocomplete="off" autocapitalize="off" /></label>
           <label class="field">Hint for yourself (stored in the sheet, so keep it vague) <input name="hint" value="${escapeHtml(a.password_hint)}" /></label>`,
          { title: `${a.display_name} · PDF password` },
        );
        if (!r) return;
        const passwords = { ...settings().passwords };
        if (r.pw) passwords[a.id] = r.pw;
        else delete passwords[a.id];
        saveSettings({ passwords });
        if ((r.hint ?? '') !== a.password_hint) {
          db.update(db.accounts, a.id, { password_hint: r.hint ?? '' });
          await db.flush();
        }
        toast(r.pw ? 'Password saved on this device' : 'Password removed', 'ok');
        draw();
      },
      'pw-remove': async (el) => {
        const a = db.accounts.get(el.dataset.id!);
        if (!a || !(await confirmDialog(`Remove the saved password for ${a.display_name}?`, 'Remove'))) return;
        const passwords = { ...settings().passwords };
        delete passwords[a.id];
        saveSettings({ passwords });
        revealed.delete(a.id);
        draw();
      },
    });
    // The list needs the accounts from the sheet; load them if we're signed in and haven't yet.
    if (!db.loaded && hasValidToken() && settings().spreadsheetId) db.load().then(draw).catch(() => {});
    return db.onChange(draw);
  },
};

const revealed = new Set<string>();

function passwordRows(pw: Record<string, string>): string {
  if (!db.loaded) return `<p class="small muted">Sign in and open any data tab once to list your accounts here.</p>`;
  const accs = db.accounts.rows.filter((a) => a.is_active && (a.kind === 'bank' || a.kind === 'credit_card'));
  if (!accs.length) return `<p class="small muted">No accounts yet.</p>`;
  return accs
    .map((a) => {
      const v = pw[a.id];
      const shown = revealed.has(a.id);
      return `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(a.display_name)}</div>
        <div class="sub">${v ? `<code>${shown ? escapeHtml(v) : '•'.repeat(Math.min(12, v.length))}</code>` : '<span class="pill warn">not set</span>'}${a.password_hint ? ` · hint: ${escapeHtml(a.password_hint)}` : ''}</div></div>
        ${v ? `<button class="btn small ghost" data-action="pw-toggle" data-id="${a.id}">${shown ? 'Hide' : 'Show'}</button>` : ''}
        <button class="btn small" data-action="pw-edit" data-id="${a.id}">${v ? 'Edit' : 'Set'}</button>
        ${v ? `<button class="btn small ghost danger" data-action="pw-remove" data-id="${a.id}">Remove</button>` : ''}</div>`;
    })
    .join('');
}

function page(): string {
  const s = settings();
  return html`
    <div class="card">
      <h3>Google</h3>
      <p class="small">Client ID <code>${s.googleClientId || '—'}</code><br/>Redirect URI <code>${redirectUri()}</code></p>
      <div class="row">${hasValidToken() ? raw('<span class="pill ok">signed in</span> <button class="btn small" data-action="signout">Sign out</button>') : raw('<button class="btn small primary" data-action="signin">Sign in</button>')}
        <button class="btn small" data-action="change-sheet">Change sheet</button>
        ${db.loaded ? raw(`<a class="btn small" href="${db.sheetUrl()}" target="_blank" rel="noopener">Open sheet ↗</a>`) : ''}</div>
    </div>
    <div class="card">
      <h3>Gemini</h3>
      <label class="field">API key <input name="geminiApiKey" type="password" value="${s.geminiApiKey}" autocomplete="off" /></label>
      <div class="row"><label class="field grow">Bulk model <input name="modelBulk" value="${s.modelBulk}" /></label><label class="field grow">Reasoning model <input name="modelReasoning" value="${s.modelReasoning}" /></label></div>
      <label class="field">Extra Gmail search terms (added to every scan) <input name="gmailExtraQuery" value="${s.gmailExtraQuery}" placeholder='e.g. -from:newsletter@example.com' /></label>
      <button class="btn primary" data-action="save-keys">Save & test</button>
      ${usage.calls ? raw(`<p class="muted small">This session: ${usage.calls} AI calls, ${Math.round(usage.inputTokens / 1000)}k tokens in.</p>`) : ''}
    </div>
    <div class="card">
      <div class="row between"><h3>Family</h3><button class="btn small" data-action="add-family">+ Add</button></div>
      <p class="small muted">Names help the AI tag transfers to family as <em>family transfer</em> instead of spending.</p>
      ${db.family.rows.length ? raw(db.family.rows.map((f) => `<div class="list-item"><div class="grow">${escapeHtml(f.name)} <span class="muted small">${escapeHtml(f.relation)}</span></div><button class="btn small ghost" data-action="del-family" data-id="${f.id}">✕</button></div>`).join('')) : ''}
    </div>
    <div class="card">
      <h3>Statement PDF passwords</h3>
      <p class="small muted">Saved only on this device, never in the sheet. Used to open the statements each bank emails you.</p>
      ${raw(passwordRows(s.passwords))}
    </div>
    <div class="card">
      <h3>Data</h3>
      <p class="small muted">Everything except the passwords above lives in your Google Sheet.</p>
      <div class="row"><button class="btn" data-action="export">Export CSV</button><button class="btn danger" data-action="reset">Forget this device</button></div>
    </div>`;
}

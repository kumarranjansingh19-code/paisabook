import type { View } from '../app/router';
import { html, raw, money, onAction, modal, toast, spinner, confirmDialog } from '../app/ui';
import { db, type Account } from '../store/db';
import { addAccount, rehomeUnmatched, unmatchedHints, updateAccount } from '../core/accounts';
import { settings, saveSettings } from '../store/local';
import { escapeHtml } from '../core/text';
import { scanMailbox } from '../core/extract';
import { discoverAccounts } from '../core/discover';
import { daysAgoIso, todayIso } from '../core/dates';
import { categorizeAll } from '../core/categorize';

export const accountsView: View = {
  title: 'Accounts',
  render(root) {
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    onAction(root, {
      add: () => addDialog(),
      edit: (el) => editDialog(el.dataset.id!),
      password: (el) => passwordDialog(el.dataset.id!),
      discover: async (el) => {
        if (el.hasAttribute('disabled')) return;
        el.setAttribute('disabled', '');
        const box = el.closest('.card')!.querySelector<HTMLElement>('#disc')!;
        box.innerHTML = spinner('Scanning 60 days of mail…');
        let props: Awaited<ReturnType<typeof discoverAccounts>>;
        try {
          const scan = await scanMailbox(daysAgoIso(60), todayIso(), { reprocess: true, metaOnly: true, onProgress: (p) => (box.innerHTML = spinner(`${p.phase} ${p.total ? `${p.done}/${p.total}` : ''}`)) });
          box.innerHTML = spinner('AI is looking for account names…');
          props = await discoverAccounts(scan.emails);
        } catch (err) {
          box.innerHTML = `<p class="pill bad">${escapeHtml(String((err as Error).message))}</p>`;
          el.removeAttribute('disabled');
          return;
        }
        el.removeAttribute('disabled');
        box.innerHTML = props.length
          ? props
              .map(
                (p) => `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(p.institution)} ${p.kind === 'credit_card' ? 'card' : 'account'} ${p.last4 ? `••${p.last4}` : ''}</div><div class="sub">seen ${p.seen}× · ${escapeHtml(p.example_subject)}</div></div>
                  <button class="btn small" data-action="add-proposal" data-p='${escapeHtml(JSON.stringify(p))}'>Add</button></div>`,
              )
              .join('')
          : '<p class="muted">Nothing new found.</p>';
      },
      'add-proposal': async (el) => {
        const p = JSON.parse(el.dataset.p!) as { kind: 'bank' | 'credit_card'; institution: string; last4: string; statement_sender: string };
        await addAccount({ kind: p.kind, institution: p.institution, account_ref: p.last4 ? `XX${p.last4}` : '', statement_sender: p.statement_sender });
        el.closest('.list-item')?.remove();
        const n = await rehomeUnmatched();
        toast(`Added${n ? ` · ${n} alerts attached` : ''}`, 'ok');
      },
      'add-from-hint': async (el) => {
        const hint = el.dataset.hint!;
        const digits = hint.match(/\d{4,}/)?.[0]?.slice(-4) ?? '';
        const r = await modal(accountForm({ institution: hint.replace(/x+\d+/i, '').replace(/\b(credit card|card|a\/c|account|ending|with)\b/gi, '').trim(), account_ref: digits ? `XX${digits}` : '', kind: /card/i.test(hint) ? 'credit_card' : 'bank' }), { title: 'Add account', submit: 'Add' });
        if (!r) return;
        await addAccount({ kind: r.kind as Account['kind'], institution: r.institution!, display_name: r.display_name, account_ref: r.account_ref, statement_sender: r.statement_sender });
        const n = await rehomeUnmatched();
        toast(`Added · ${n} alerts attached`, 'ok');
        if (n) categorizeAll().catch(() => {});
      },
      deactivate: async (el) => {
        const a = db.accounts.get(el.dataset.id!)!;
        if (!(await confirmDialog(`Hide ${a.display_name}? Its transactions stay in the sheet but won't be matched or shown.`, 'Hide'))) return;
        await updateAccount(a.id, { is_active: false });
        toast('Hidden');
      },
      activate: async (el) => {
        await updateAccount(el.dataset.id!, { is_active: true });
      },
    });
    return db.onChange(draw);
  },
};

function page(): string {
  const accs = db.accounts.rows;
  const hints = unmatchedHints();
  const pw = settings().passwords;
  const stmtCount = (id: string) => db.statements.rows.filter((s) => s.account_id === id && s.status !== 'failed' && s.status !== 'superseded').length;
  const txnCount = (id: string) => db.transactions.rows.filter((t) => t.account_id === id && t.status !== 'superseded').length;
  const balanceish = (id: string) =>
    db.transactions.rows.filter((t) => t.account_id === id && t.status !== 'superseded' && t.posted_at.startsWith(todayIso().slice(0, 7))).reduce((s, t) => s + (t.direction === 'debit' ? t.amount_paise : 0), 0);
  return html`
    <div class="row between"><h2>Accounts</h2><button class="btn primary" data-action="add">+ Add</button></div>
    ${hints.length
      ? raw(`<div class="card warn"><h3>Alerts for unknown accounts</h3><p class="small muted">These masked numbers appear in alerts but match none of your accounts. Add the account and the alerts attach automatically.</p>
        ${hints.map((h) => `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(h.hint)}</div><div class="sub">${h.count} alerts · last ${h.last}</div></div><button class="btn small" data-action="add-from-hint" data-hint="${escapeHtml(h.hint)}">Add account</button></div>`).join('')}</div>`)
      : ''}
    <div class="card">${accs.length ? raw(accs
      .map(
        (a) => `<div class="list-item" style="opacity:${a.is_active ? 1 : 0.5}">
          <div class="grow">
            <div class="title">${escapeHtml(a.display_name)} <span class="pill muted">${a.kind.replace('_', ' ')}</span> ${pw[a.id] ? '<span class="pill ok">🔑 password saved</span>' : a.kind !== 'cash' && a.kind !== 'wallet' ? '<span class="pill warn">no PDF password</span>' : ''}</div>
            <div class="sub">${escapeHtml(a.account_ref || 'no masked number')}${a.statement_sender ? ` · statements from ${escapeHtml(a.statement_sender)}` : ''} · ${txnCount(a.id)} txns · ${stmtCount(a.id)} statements · this month ${money(balanceish(a.id), true)}</div>
          </div>
          <button class="btn small" data-action="password" data-id="${a.id}" title="Statement PDF password">🔑</button>
          <button class="btn small" data-action="edit" data-id="${a.id}">Edit</button>
          ${a.is_active ? `<button class="btn small ghost" data-action="deactivate" data-id="${a.id}">Hide</button>` : `<button class="btn small" data-action="activate" data-id="${a.id}">Show</button>`}
        </div>`,
      )
      .join('')) : raw('<p class="muted">No accounts yet.</p>')}</div>
    <div class="card"><div class="row between"><h3>Discover from email</h3><button class="btn" data-action="discover">Scan</button></div>
      <p class="small muted">Reads 60 days of mail headers and proposes banks and cards it sees.</p><div id="disc"></div></div>`;
}

function accountForm(a: Partial<Account>): string {
  const kinds: Array<[Account['kind'], string]> = [['bank', 'Bank account'], ['credit_card', 'Credit card'], ['cash', 'Cash'], ['wallet', 'Wallet / UPI app'], ['other', 'Other']];
  return `<label class="field">Type <select name="kind">${kinds.map(([k, l]) => `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field">Institution <input name="institution" value="${escapeHtml(a.institution ?? '')}" placeholder="HDFC Bank" required /></label>
    <label class="field">Display name (optional) <input name="display_name" value="${escapeHtml(a.display_name ?? '')}" /></label>
    <label class="field">Masked numbers seen in alerts / statements <input name="account_ref" value="${escapeHtml(a.account_ref ?? '')}" placeholder="XX1234 / XX5678" /></label>
    <label class="field">Statement sender email (optional) <input name="statement_sender" value="${escapeHtml(a.statement_sender ?? '')}" placeholder="estatement@hdfcbank.net" /></label>
    <label class="field">Password hint (for you) <input name="password_hint" value="${escapeHtml(a.password_hint ?? '')}" placeholder="DOB ddmmyyyy + last 4 of mobile" /></label>`;
}

async function addDialog(): Promise<void> {
  const r = await modal(accountForm({}), { title: 'Add account', submit: 'Add' });
  if (!r) return;
  await addAccount({ kind: r.kind as Account['kind'], institution: r.institution!, display_name: r.display_name, account_ref: r.account_ref, statement_sender: r.statement_sender, password_hint: r.password_hint });
  const n = await rehomeUnmatched();
  toast(`Added${n ? ` · ${n} alerts attached` : ''}`, 'ok');
}

async function editDialog(id: string): Promise<void> {
  const a = db.accounts.get(id);
  if (!a) return;
  const r = await modal(accountForm(a), { title: 'Edit account' });
  if (!r) return;
  await updateAccount(id, { kind: r.kind as Account['kind'], institution: r.institution!, display_name: r.display_name || a.display_name, account_ref: r.account_ref ?? '', statement_sender: r.statement_sender ?? '', password_hint: r.password_hint ?? '' });
  const n = await rehomeUnmatched();
  toast(`Saved${n ? ` · ${n} alerts attached` : ''}`, 'ok');
}

async function passwordDialog(id: string): Promise<void> {
  const a = db.accounts.get(id);
  if (!a) return;
  const cur = settings().passwords[id] ?? '';
  const r = await modal(
    `<p class="small muted">Used to open this account's statement PDFs. Stored only on this device, never in the sheet.${a.password_hint ? `<br/>Your hint: <em>${escapeHtml(a.password_hint)}</em>` : ''}</p>
     <label class="field">Password <input name="pw" value="${escapeHtml(cur)}" autocomplete="off" /></label>`,
    { title: `${a.display_name} · PDF password` },
  );
  if (!r) return;
  const passwords = { ...settings().passwords };
  if (r.pw) passwords[id] = r.pw!;
  else delete passwords[id];
  saveSettings({ passwords });
  db.notify();
  toast(r.pw ? 'Password saved on this device' : 'Password removed', 'ok');
}

import type { View } from '../app/router';
import { html, raw, money, onAction, modal, toast, spinner, confirmDialog, deferWhileTyping, mdOptions } from '../app/ui';
import { db, type Account } from '../store/db';
import { addAccount, addonEntries, attachAddonCard, deleteAccount, ignoreAllHints, ignoreHint, ignoredHints, mergeAccounts, rehomeUnmatched, restoreHint, unmatchedHints, updateAccount } from '../core/accounts';
import { settings, saveSettings } from '../store/local';
import { escapeHtml } from '../core/text';
import { scanMailbox } from '../core/extract';
import { discoverAccounts } from '../core/discover';
import { daysAgoIso, todayIso } from '../core/dates';
import { categorizeAll } from '../core/categorize';
import { importWithNewPassword } from '../core/sync';

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
          const scan = await scanMailbox(daysAgoIso(60), todayIso(), { reprocess: true, metaOnly: true, sendersOnly: true, maxEmails: 500, onProgress: (p) => (box.innerHTML = spinner(`${p.phase} ${p.total ? `${p.done}/${p.total}` : ''}`)) });
          box.innerHTML = spinner('Looking for account names…');
          props = await discoverAccounts(scan.emails);
          if (scan.interrupted) toast(`Gmail stopped the scan at ${scan.read}/${scan.total} — press Scan again to continue from there`, 'error');
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
                  <md-outlined-button data-small data-action="add-proposal" data-p='${escapeHtml(JSON.stringify(p))}'>Add</md-outlined-button></div>`,
              )
              .join('')
          : '<p class="muted">Nothing new found.</p>';
      },
      'add-proposal': async (el) => {
        const p = JSON.parse(el.dataset.p!) as { kind: 'bank' | 'credit_card'; institution: string; last4: string; statement_sender: string };
        el.setAttribute('disabled', '');
        el.textContent = 'Adding…';
        try {
          await addAccount({ kind: p.kind, institution: p.institution, account_ref: p.last4 ? `XX${p.last4}` : '', statement_sender: p.statement_sender });
          el.closest('.list-item')?.remove();
          const n = await rehomeUnmatched();
          toast(`Added${n ? ` · ${n} alerts attached` : ''}`, 'ok');
        } catch (err) {
          el.removeAttribute('disabled');
          el.textContent = 'Add';
          toast(String((err as Error).message), 'error');
        }
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
      delete: async (el) => {
        const a = db.accounts.get(el.dataset.id!)!;
        if (!(await confirmDialog(`Delete ${a.display_name}? It has no transactions or statements.`, 'Delete'))) return;
        const r = await deleteAccount(a.id);
        toast(r === 'deleted' ? 'Deleted' : 'This account has data — hide it instead', r === 'deleted' ? 'ok' : 'error');
      },
      'addon-from-hint': async (el) => {
        const hint = el.dataset.hint!;
        const cards = db.activeAccounts().filter((a) => a.kind === 'credit_card');
        if (!cards.length) return toast('Add the primary credit card first', 'error');
        const r = await modal(
          `<p class="small muted">Alerts for <b>${escapeHtml(hint)}</b> will attach to the card you pick, and its statement lines will match those alerts. The holder name shows on each transaction.</p>
           <md-outlined-select class="field" label="Primary card" name="primary" required>${mdOptions(cards.map((a) => ({ value: a.id, label: `${a.display_name} · ${a.account_ref || 'no masked number'}` })), cards[0]!.id)}</md-outlined-select>
           <md-outlined-text-field class="field" label="Card holder (optional)" name="holder" placeholder="Priyanka"></md-outlined-text-field>`,
          { title: 'Add-on card of…', submit: 'Attach' },
        );
        if (!r?.primary) return;
        const n = await attachAddonCard(r.primary, hint, r.holder ?? '');
        toast(`Add-on card recorded · ${n} alerts attached`, 'ok');
        if (n) categorizeAll().catch(() => {});
      },
      'ignore-hint': async (el) => {
        const hint = el.dataset.hint!;
        if (!(await confirmDialog(`Ignore "${hint}"? Its alerts are hidden and future ones are skipped. You can restore it later.`, 'Ignore'))) return;
        const n = await ignoreHint(hint);
        toast(`${n} alerts hidden`, 'ok');
      },
      'ignore-all-hints': async () => {
        const hints = unmatchedHints();
        const alerts = hints.reduce((n, h) => n + h.count, 0);
        if (!(await confirmDialog(`Ignore all ${hints.length} unknown accounts? ${alerts} alerts are hidden and these hints are skipped in future syncs. You can restore any of them later.`, 'Ignore all'))) return;
        const r = await ignoreAllHints();
        toast(`${r.hints} hints ignored · ${r.alerts} alerts hidden`, 'ok');
      },
      merge: (el) => mergeDialog(el.dataset.id!),
      'restore-hint': async (el) => {
        const n = await restoreHint(el.dataset.key!);
        toast(`${n} alerts restored`, 'ok');
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
    return db.onChange(deferWhileTyping(root, draw));
  },
};

function page(): string {
  const accs = db.accounts.rows;
  const activeCount = accs.filter((a) => a.is_active).length;
  const hasCard = accs.some((a) => a.is_active && a.kind === 'credit_card');
  const hints = unmatchedHints();
  const ignored = ignoredHints();
  const pw = settings().passwords;
  const stmtCount = (id: string) => db.statements.rows.filter((s) => s.account_id === id && s.status !== 'failed' && s.status !== 'superseded').length;
  const txnCount = (id: string) => db.transactions.rows.filter((t) => t.account_id === id && t.status !== 'superseded').length;
  const balanceish = (id: string) =>
    db.transactions.rows.filter((t) => t.account_id === id && t.status !== 'superseded' && t.posted_at.startsWith(todayIso().slice(0, 7))).reduce((s, t) => s + (t.direction === 'debit' ? t.amount_paise : 0), 0);
  return html`
    <div class="row between"><h2>Accounts</h2><md-filled-button data-action="add">+ Add</md-filled-button></div>
    ${hints.length
      ? raw(`<div class="card warn"><div class="row between"><h3>Alerts for unknown accounts</h3>${hints.length > 1 ? `<md-text-button data-small data-action="ignore-all-hints" title="None of these are my accounts — hide all their alerts and skip these hints from now on">Ignore all</md-text-button>` : ''}</div><p class="small muted">These masked numbers appear in alerts but match none of your accounts. Add the account and the alerts attach automatically.</p>
        ${hints.map((h) => `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(h.hint)}</div><div class="sub">${h.count} alerts · last ${h.last}</div></div><md-outlined-button data-small data-action="add-from-hint" data-hint="${escapeHtml(h.hint)}">Add account</md-outlined-button>${hasCard && /\d{4}/.test(h.hint) ? `<md-outlined-button data-small data-action="addon-from-hint" data-hint="${escapeHtml(h.hint)}" title="This is a supplementary card billed to one of my cards">Add-on of…</md-outlined-button>` : ''}<md-text-button data-small data-action="ignore-hint" data-hint="${escapeHtml(h.hint)}" title="Not my account — hide these alerts and skip this hint from now on">Ignore</md-text-button></div>`).join('')}</div>`)
      : ''}
    ${ignored.length
      ? raw(`<details class="card small"><summary>Ignored hints (${ignored.length})</summary><p class="muted">Alerts mentioning these are skipped. Restore one to see its alerts again.</p>
        ${ignored.map((k) => `<div class="list-item"><div class="grow">${escapeHtml(k)}</div><md-text-button data-small data-action="restore-hint" data-key="${escapeHtml(k)}">Restore</md-text-button></div>`).join('')}</details>`)
      : ''}
    <div class="card">${accs.length ? raw(accs
      .map(
        (a) => `<div class="list-item" style="opacity:${a.is_active ? 1 : 0.5}">
          <div class="grow">
            <div class="title">${escapeHtml(a.display_name)} <span class="pill muted">${a.kind.replace('_', ' ')}</span> ${pw[a.id] ? '<span class="pill ok">🔑 password saved</span>' : a.kind !== 'cash' && a.kind !== 'wallet' ? '<span class="pill warn">no PDF password</span>' : ''}</div>
            <div class="sub">${escapeHtml(a.account_ref || 'no masked number')}${addonEntries(a).length ? ` · add-on ${addonEntries(a).map((e) => `XX${e.last4}${e.holder ? ` (${escapeHtml(e.holder)})` : ''}`).join(', ')}` : ''}${a.statement_sender ? ` · statements from ${escapeHtml(a.statement_sender)}` : ''} · ${txnCount(a.id)} txns · ${stmtCount(a.id)} statements · this month ${money(balanceish(a.id), true)}</div>
          </div>
          <md-outlined-button data-small data-action="password" data-id="${a.id}" title="Statement PDF password">🔑</md-outlined-button>
          <md-outlined-button data-small data-action="edit" data-id="${a.id}">Edit</md-outlined-button>
          ${a.is_active && activeCount > 1 ? `<md-outlined-button data-small data-action="merge" data-id="${a.id}" title="Same account under two names? Fold another account into this one">Merge</md-outlined-button>` : ''}
          ${txnCount(a.id) === 0 && stmtCount(a.id) === 0 ? `<md-text-button data-small class="danger" data-action="delete" data-id="${a.id}">Delete</md-text-button>` : a.is_active ? `<md-text-button data-small data-action="deactivate" data-id="${a.id}" title="Keeps its rows in the sheet but removes them from every number">Hide</md-text-button>` : `<md-outlined-button data-small data-action="activate" data-id="${a.id}">Show</md-outlined-button>`}
        </div>`,
      )
      .join('')) : raw('<p class="muted">No accounts yet.</p>')}</div>
    <div class="card"><div class="row between"><h3>Discover from email</h3><md-outlined-button data-action="discover">Scan</md-outlined-button></div>
      <p class="small muted">Reads 60 days of mail headers and proposes banks and cards it sees.</p><div id="disc"></div></div>`;
}

function accountForm(a: Partial<Account>): string {
  const kinds: Array<[Account['kind'], string]> = [['bank', 'Bank account'], ['credit_card', 'Credit card'], ['cash', 'Cash'], ['wallet', 'Wallet / UPI app'], ['other', 'Other']];
  return `<md-outlined-select class="field" label="Type" name="kind">${kinds.map(([k, l]) => `<md-select-option value="${k}" ${a.kind === k ? 'selected' : ''}><div slot="headline">${l}</div></md-select-option>`).join('')}</md-outlined-select>
    <md-outlined-text-field class="field" label="Institution" name="institution" value="${escapeHtml(a.institution ?? '')}" placeholder="HDFC Bank" required></md-outlined-text-field>
    <md-outlined-text-field class="field" label="Display name (optional)" name="display_name" value="${escapeHtml(a.display_name ?? '')}"></md-outlined-text-field>
    <md-outlined-text-field class="field" label="Masked numbers seen in alerts / statements" name="account_ref" value="${escapeHtml(a.account_ref ?? '')}" placeholder="XX1234 / XX5678"></md-outlined-text-field>
    <md-outlined-text-field class="field" label="Add-on card numbers (optional)" name="addon_refs" value="${escapeHtml(a.addon_refs ?? '')}" placeholder="XX5678 (Priyanka) / XX9012"></md-outlined-text-field>
    <md-outlined-text-field class="field" label="Statement sender email (optional)" name="statement_sender" value="${escapeHtml(a.statement_sender ?? '')}" placeholder="estatement@hdfcbank.net"></md-outlined-text-field>
    <md-outlined-text-field class="field" label="Password hint (for you)" name="password_hint" value="${escapeHtml(a.password_hint ?? '')}" placeholder="DOB ddmmyyyy + last 4 of mobile"></md-outlined-text-field>`;
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
  await updateAccount(id, { kind: r.kind as Account['kind'], institution: r.institution!, display_name: r.display_name || a.display_name, account_ref: r.account_ref ?? '', addon_refs: r.addon_refs ?? '', statement_sender: r.statement_sender ?? '', password_hint: r.password_hint ?? '' });
  const n = await rehomeUnmatched();
  toast(`Saved${n ? ` · ${n} alerts attached` : ''}`, 'ok');
}

/**
 * "These two are the same account": pick which other account folds into
 * `keepId`. Same-kind accounts are listed first since that is the usual case
 * (a card seen under two names), but any account can be chosen.
 */
async function mergeDialog(keepId: string): Promise<void> {
  const keep = db.accounts.get(keepId);
  if (!keep) return;
  const others = db.activeAccounts().filter((a) => a.id !== keepId).sort((a, b) => Number(a.kind !== keep.kind) - Number(b.kind !== keep.kind) || a.display_name.localeCompare(b.display_name));
  if (!others.length) return toast('No other account to merge', 'error');
  const txns = (id: string) => db.transactions.rows.filter((t) => t.account_id === id && t.status !== 'superseded').length;
  const r = await modal(
    `<p class="small muted">Everything from the account you pick — transactions, statements, masked numbers, PDF password — moves into <b>${escapeHtml(keep.display_name)}</b>, and the picked account is hidden as "(merged)". Undo by editing the hidden account back to Show and moving rows manually, so double-check.</p>
     <md-outlined-select class="field" label="Merge this account into it" name="drop" required>${mdOptions(others.map((a) => ({ value: a.id, label: `${a.display_name} · ${a.kind.replace('_', ' ')} · ${a.account_ref || 'no masked number'} · ${txns(a.id)} txns` })), others[0]!.id)}</md-outlined-select>
     <md-outlined-select class="field" label="How are they related?" name="how">${mdOptions(
       [
         { value: 'same', label: 'Same account seen under two names' },
         { value: 'addon', label: keep.kind === 'credit_card' ? `Add-on card billed to ${keep.display_name}` : 'Add-on / supplementary card' },
       ],
       'same',
     )}</md-outlined-select>
     <md-outlined-text-field class="field" label="Add-on card holder (only for add-on)" name="holder" placeholder="Priyanka"></md-outlined-text-field>`,
    { title: `Merge into ${keep.display_name}`, submit: 'Merge' },
  );
  if (!r?.drop) return;
  const drop = db.accounts.get(r.drop);
  if (!drop) return;
  const asAddon = r.how === 'addon';
  const what = asAddon ? `Record "${drop.display_name}" as an add-on card of "${keep.display_name}"?` : `Merge "${drop.display_name}" into "${keep.display_name}"?`;
  if (!(await confirmDialog(`${what} ${txns(drop.id)} transactions move over and "${drop.display_name}" is hidden.`, 'Merge'))) return;
  const moved = await mergeAccounts(keep.id, drop.id, { asAddon, holder: r.holder });
  toast(`${asAddon ? 'Add-on recorded' : 'Merged'} · ${moved} transactions moved to ${keep.display_name}`, 'ok');
}

async function passwordDialog(id: string): Promise<void> {
  const a = db.accounts.get(id);
  if (!a) return;
  const cur = settings().passwords[id] ?? '';
  const r = await modal(
    `<p class="small muted">Used to open this account's statement PDFs. Stored only on this device, never in the sheet.${a.password_hint ? `<br/>Your hint: <em>${escapeHtml(a.password_hint)}</em>` : ''}</p>
     <md-outlined-text-field class="field" label="Password" name="pw" value="${escapeHtml(cur)}" autocomplete="off"></md-outlined-text-field>`,
    { title: `${a.display_name} · PDF password` },
  );
  if (!r) return;
  const passwords = { ...settings().passwords };
  if (r.pw) passwords[id] = r.pw!;
  else delete passwords[id];
  saveSettings({ passwords });
  db.notify();
  if (!r.pw) return toast('Password removed', 'ok');
  toast('Password saved — trying waiting statements…');
  const { imported, remaining } = await importWithNewPassword();
  toast(imported ? `${imported} statement${imported > 1 ? 's' : ''} imported${remaining ? `, ${remaining} still waiting` : ''}` : remaining ? `Saved. ${remaining} PDF${remaining > 1 ? 's' : ''} still need a different password` : 'Password saved on this device', 'ok');
}

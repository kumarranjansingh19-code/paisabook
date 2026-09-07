import type { View } from '../app/router';
import { html, raw, money, onAction, categoryOptions, mdCategoryOptions, fromNone, catLabel, modal, toast } from '../app/ui';
import { db, type Transaction } from '../store/db';
import { categoryKind, categoryNames } from '../core/categories';
import { setCategory, addRule } from '../core/categorize';
import { availableMonths } from '../core/analytics';
import { monthLabel, monthOf, todayIso } from '../core/dates';
import { escapeHtml } from '../core/text';
import { txnFingerprint } from '../core/fingerprint';
import { parseAmountToPaise } from '../core/money';
import { stamp } from '../store/db';
import { addonHolderFor } from '../core/accounts';

interface Filter {
  m: string;
  cat: string;
  acc: string;
  status: string;
  q: string;
  /** income | spend | investment | transfer | refund — set by the Home stat cards */
  kind: string;
}
const DEFAULTS = (): Filter => ({ m: monthOf(todayIso()), cat: '', acc: '', status: '', q: '', kind: '' });
const f: Filter = DEFAULTS();

const holderOf = (t: Transaction): string => addonHolderFor(db.accounts.get(t.account_id), t.account_hint);

export const transactionsView: View = {
  title: 'Ledger',
  render(root, params) {
    // A link from Home names exactly what to show: start from clean filters so an
    // account/status/search left over from an earlier visit can't hide rows.
    if ([...params.keys()].length) Object.assign(f, DEFAULTS());
    for (const k of Object.keys(f) as Array<keyof Filter>) if (params.has(k)) f[k] = params.get(k)!;
    if (params.has('m') && params.get('m') === 'all') f.m = '';
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    root.addEventListener('change', async (e) => {
      const t = e.target as HTMLSelectElement | HTMLInputElement;
      if (t.name in f) {
        f[t.name as keyof Filter] = t.value === 'all' ? '' : t.value;
        draw();
      } else if (t.dataset.cat) {
        await setCategory(t.dataset.cat, t.value);
        toast(`→ ${catLabel(t.value)}`, 'ok');
      }
    });
    root.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'q') {
        f.q = t.value;
        const list = root.querySelector('#list');
        if (list) list.innerHTML = list_();
      }
    });
    onAction(root, {
      open: (el) => openTxn(el.dataset.id!),
      add: () => addManual(),
    });
    return db.onChange(() => {
      const list = root.querySelector('#list');
      if (list) list.innerHTML = list_();
    });
  },
};

function filtered(): Transaction[] {
  const q = f.q.trim().toLowerCase();
  return db.transactions.rows
    .filter((t) => (f.status === 'superseded' ? t.status === 'superseded' : t.status !== 'superseded'))
    .filter((t) => (f.m ? t.posted_at.startsWith(f.m) : true))
    .filter((t) => (f.cat ? (f.cat === 'uncategorized' ? !t.category : t.category === f.cat) : true))
    .filter((t) => (f.acc ? t.account_id === f.acc : true))
    .filter((t) => (f.status ? t.status === f.status : true))
    .filter((t) => (f.kind ? !!t.category && categoryKind(t.category) === f.kind : true))
    .filter((t) => (q ? `${t.narration} ${t.merchant} ${t.ref_no} ${t.amount_paise / 100} ${t.category} ${catLabel(t.category)} ${db.accounts.get(t.account_id)?.display_name ?? ''}`.toLowerCase().includes(q) : true))
    .sort((a, b) => (a.posted_at < b.posted_at ? 1 : a.posted_at > b.posted_at ? -1 : 0));
}

function page(): string {
  const months = availableMonths(db.liveTransactions());
  return html`
    <div class="filters">
      <md-outlined-select name="m"><md-select-option value="all" ${!f.m ? 'selected' : ''}><div slot="headline">All months</div></md-select-option>${raw(months.map((m) => `<md-select-option value="${m}" ${m === f.m ? 'selected' : ''}><div slot="headline">${monthLabel(m)}</div></md-select-option>`).join(''))}</md-outlined-select>
      <md-outlined-select name="acc"><md-select-option value="all" ${!f.acc ? 'selected' : ''}><div slot="headline">All accounts</div></md-select-option>${raw(db.accounts.rows.map((a) => `<md-select-option value="${a.id}" ${a.id === f.acc ? 'selected' : ''}><div slot="headline">${escapeHtml(a.display_name)}</div></md-select-option>`).join(''))}</md-outlined-select>
      <md-outlined-select name="cat"><md-select-option value="all" ${!f.cat ? 'selected' : ''}><div slot="headline">All categories</div></md-select-option><md-select-option value="uncategorized" ${f.cat === 'uncategorized' ? 'selected' : ''}><div slot="headline">uncategorized</div></md-select-option>${raw(categoryNames().map((c) => `<md-select-option value="${c}" ${c === f.cat ? 'selected' : ''}><div slot="headline">${catLabel(c)}</div></md-select-option>`).join(''))}</md-outlined-select>
      <md-outlined-select name="status"><md-select-option value="all" ${!f.status ? 'selected' : ''}><div slot="headline">Any status</div></md-select-option>${raw(['confirmed', 'provisional', 'needs_review', 'unmatched'].map((s) => `<md-select-option value="${s}" ${s === f.status ? 'selected' : ''}><div slot="headline">${s.replace('_', ' ')}</div></md-select-option>`).join(''))}<md-select-option value="superseded" ${f.status === 'superseded' ? 'selected' : ''}><div slot="headline">hidden (duplicates / merged)</div></md-select-option></md-outlined-select>
      <md-outlined-text-field name="q" placeholder="Search narration / amount / category" value="${f.q}" ></md-outlined-text-field>
      <md-outlined-button data-action="add">+ Manual</md-outlined-button>
    </div>
    ${f.kind ? raw(`<p class="small muted">Showing <strong>${escapeHtml(f.kind)}</strong> categories only · <a href="#/txns?m=${encodeURIComponent(f.m || 'all')}">show everything</a></p>`) : ''}
    <div id="list">${raw(list_())}</div>`;
}

function list_(): string {
  const rows = filtered();
  const debit = rows.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount_paise, 0);
  const credit = rows.filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount_paise, 0);
  if (!rows.length) return '<p class="muted center">Nothing matches.</p>';
  return `<p class="muted small">${rows.length} transactions · out ${money(debit, true)} · in ${money(credit, true)}</p>
    <div class="card" style="padding:.2rem 1rem">${rows
      .slice(0, 400)
      .map(
        (t) => `<div class="txn">
        <div class="who" data-action="open" data-id="${t.id}" title="${escapeHtml(t.narration)}">${escapeHtml(t.merchant || t.narration || '(no narration)')}</div>
        <div class="amt ${t.direction}">${t.direction === 'credit' ? '+' : '−'}${money(t.amount_paise)}</div>
        <div class="meta">
          <span>${t.posted_at}</span>
          <span>${escapeHtml(db.accounts.get(t.account_id)?.display_name ?? t.account_hint ?? '?')}${holderOf(t) ? ` <span class="pill muted" title="add-on card">${escapeHtml(holderOf(t))}</span>` : ''}</span>
          ${statusPill(t)}
          <select class="inline" data-cat="${t.id}">${categoryOptions(t.category, categoryNames())}</select>
        </div></div>`,
      )
      .join('')}
    ${rows.length > 400 ? `<p class="muted small center">Showing 400 of ${rows.length} — narrow the filter.</p>` : ''}</div>`;
}

function statusPill(t: Transaction): string {
  if (t.status === 'needs_review') return '<span class="pill warn">not on statement</span>';
  if (t.status === 'provisional') return '<span class="pill muted">alert</span>';
  if (t.status === 'unmatched') return '<span class="pill bad">no account</span>';
  if (t.status === 'superseded') return '<span class="pill muted">hidden</span>';
  if (t.source === 'sheet') return '<span class="pill muted">sheet</span>';
  if (t.source === 'manual') return '<span class="pill muted">manual</span>';
  if (t.categorized_by === 'user') return '<span class="pill">you</span>';
  return '';
}

async function openTxn(id: string): Promise<void> {
  const t = db.transactions.get(id);
  if (!t) return;
  const acc = db.accounts.get(t.account_id);
  const r = await modal(
    `<p><strong>${escapeHtml(t.narration)}</strong></p>
     <p class="muted small">${t.posted_at} · ${escapeHtml(acc?.display_name ?? t.account_hint)}${holderOf(t) ? ` (${escapeHtml(holderOf(t))}'s add-on card)` : ''} · ${t.direction} ${money(t.amount_paise)}${t.ref_no ? ` · ref ${escapeHtml(t.ref_no)}` : ''}<br/>
     source ${t.source} · status ${t.status} · categorized by ${t.categorized_by || '—'}</p>
     <md-outlined-select class="field" label="Category" name="category">${mdCategoryOptions(t.category, categoryNames())}</md-outlined-select>
     <md-outlined-text-field class="field" label="Merchant" name="merchant" value="${escapeHtml(t.merchant)}"></md-outlined-text-field>
     <label class="check"><md-checkbox name="rule" touch-target="wrapper"></md-checkbox> Also create a rule so similar narrations get this category automatically</label>
     <md-outlined-text-field class="field" label="Rule fragment (must appear in the narration)" name="pattern" value="${escapeHtml(suggestFragment(t))}"></md-outlined-text-field>
     ${t.status === 'needs_review' || t.status === 'provisional' ? `<label class="check"><md-radio name="fix" value="confirm" touch-target="wrapper"></md-radio> This alert is real (keep it)</label><label class="check"><md-radio name="fix" value="dup" touch-target="wrapper"></md-radio> Duplicate — hide it</label>` : ''}
     ${t.status === 'confirmed' && t.source !== 'statement' ? `<label class="check"><md-radio name="fix" value="dup" touch-target="wrapper"></md-radio> Hide this row (duplicate / not mine)</label>` : ''}
     ${t.status === 'superseded' ? `<label class="check"><md-radio name="fix" value="restore" touch-target="wrapper"></md-radio> Restore this row (it was hidden as a duplicate or merged)</label>` : ''}
     ${t.status === 'unmatched' ? `<md-outlined-select class="field" label="Attach to account" name="acc"><md-select-option value="none" selected><div slot="headline">—</div></md-select-option>${db.accounts.rows.map((a) => `<md-select-option value="${a.id}"><div slot="headline">${escapeHtml(a.display_name)}</div></md-select-option>`).join('')}</md-outlined-select>` : ''}`,
    { title: 'Transaction' },
  );
  if (!r) return;
  const patch: Partial<Transaction> = {};
  const newCat = fromNone(r.category);
  if (newCat !== t.category || r.merchant !== t.merchant) Object.assign(patch, { category: newCat, merchant: r.merchant, categorized_by: 'user' });
  if (r.fix === 'confirm') patch.status = 'confirmed';
  if (r.fix === 'dup') patch.status = 'superseded';
  if (r.fix === 'restore') patch.status = t.source === 'statement' || t.statement_id ? 'confirmed' : 'provisional';
  if (r.acc && r.acc !== 'none') Object.assign(patch, { account_id: r.acc, status: 'provisional' });
  if (Object.keys(patch).length) {
    db.update(db.transactions, t.id, patch);
    await db.flush();
  }
  if (r.rule && newCat && r.pattern) {
    const { retagged } = await addRule(r.pattern, newCat, r.merchant ?? '');
    toast(`Rule added · ${retagged} transactions retagged`, 'ok');
  } else toast('Saved', 'ok');
}

function suggestFragment(t: Transaction): string {
  const m = (t.merchant || t.narration).toLowerCase().replace(/[^a-z0-9@.]/g, '');
  return m.slice(0, 24);
}

async function addManual(): Promise<void> {
  const r = await modal(
    `<md-outlined-select class="field" label="Account" name="acc">${db.accounts.rows.map((a) => `<md-select-option value="${a.id}"><div slot="headline">${escapeHtml(a.display_name)}</div></md-select-option>`).join('')}</md-outlined-select>
     <md-outlined-text-field class="field" label="Date" type="date" name="date" value="${todayIso()}" required></md-outlined-text-field>
     <md-outlined-text-field class="field" label="Amount (₹)" name="amount" inputmode="decimal" required></md-outlined-text-field>
     <md-outlined-select class="field" label="Direction" name="dir"><md-select-option value="debit"><div slot="headline">Spent / debit</div></md-select-option><md-select-option value="credit"><div slot="headline">Received / credit</div></md-select-option></md-outlined-select>
     <md-outlined-text-field class="field" label="Description" name="narration" required></md-outlined-text-field>
     <md-outlined-select class="field" label="Category" name="category">${mdCategoryOptions('', categoryNames())}</md-outlined-select>`,
    { title: 'Manual transaction', submit: 'Add' },
  );
  if (!r) return;
  if (!db.accounts.rows.length) return toast('Add an account first', 'error');
  const amount = Math.abs(parseAmountToPaise(r.amount!));
  const fp = txnFingerprint({ accountId: r.acc!, postedAt: r.date!, direction: r.dir as 'debit', amountPaise: amount, narration: r.narration, refNo: `MANUAL${Date.now()}` });
  await db.append(db.transactions, [
    { id: `t_${fp.slice(0, 20)}`, account_id: r.acc!, account_hint: '', posted_at: r.date!, amount_paise: amount, direction: r.dir as 'debit', narration: r.narration!, ref_no: '', category: fromNone(r.category), merchant: '', categorized_by: fromNone(r.category) ? 'user' : '', source: 'manual', status: 'confirmed', email_id: '', statement_id: '', created_at: stamp() },
  ]);
  toast('Added', 'ok');
}

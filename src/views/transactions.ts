import type { View } from '../app/router';
import { html, raw, money, onAction, categoryOptions, catLabel, modal, toast } from '../app/ui';
import { db, type Transaction } from '../store/db';
import { SPEND_CATEGORIES } from '../llm/schemas';
import { setCategory, addRule } from '../core/categorize';
import { availableMonths } from '../core/analytics';
import { monthLabel, monthOf, todayIso } from '../core/dates';
import { escapeHtml } from '../core/text';
import { txnFingerprint } from '../core/fingerprint';
import { parseAmountToPaise } from '../core/money';
import { stamp } from '../store/db';

interface Filter {
  m: string;
  cat: string;
  acc: string;
  status: string;
  q: string;
}
const f: Filter = { m: monthOf(todayIso()), cat: '', acc: '', status: '', q: '' };

export const transactionsView: View = {
  title: 'Ledger',
  render(root, params) {
    for (const k of Object.keys(f) as Array<keyof Filter>) if (params.has(k)) f[k] = params.get(k)!;
    if (params.has('m') && params.get('m') === 'all') f.m = '';
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    root.addEventListener('change', async (e) => {
      const t = e.target as HTMLSelectElement | HTMLInputElement;
      if (t.name in f) {
        f[t.name as keyof Filter] = t.value;
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
    .filter((t) => t.status !== 'superseded')
    .filter((t) => (f.m ? t.posted_at.startsWith(f.m) : true))
    .filter((t) => (f.cat ? (f.cat === 'uncategorized' ? !t.category : t.category === f.cat) : true))
    .filter((t) => (f.acc ? t.account_id === f.acc : true))
    .filter((t) => (f.status ? t.status === f.status : true))
    .filter((t) => (q ? `${t.narration} ${t.merchant} ${t.ref_no} ${t.amount_paise / 100}`.toLowerCase().includes(q) : true))
    .sort((a, b) => (a.posted_at < b.posted_at ? 1 : a.posted_at > b.posted_at ? -1 : 0));
}

function page(): string {
  const months = availableMonths(db.liveTransactions());
  return html`
    <div class="filters">
      <select name="m"><option value="" ${!f.m ? 'selected' : ''}>All months</option>${raw(months.map((m) => `<option value="${m}" ${m === f.m ? 'selected' : ''}>${monthLabel(m)}</option>`).join(''))}</select>
      <select name="acc"><option value="">All accounts</option>${raw(db.accounts.rows.map((a) => `<option value="${a.id}" ${a.id === f.acc ? 'selected' : ''}>${escapeHtml(a.display_name)}</option>`).join(''))}</select>
      <select name="cat"><option value="">All categories</option><option value="uncategorized" ${f.cat === 'uncategorized' ? 'selected' : ''}>uncategorized</option>${raw(SPEND_CATEGORIES.map((c) => `<option value="${c}" ${c === f.cat ? 'selected' : ''}>${catLabel(c)}</option>`).join(''))}</select>
      <select name="status"><option value="">Any status</option>${raw(['confirmed', 'provisional', 'needs_review', 'unmatched'].map((s) => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join(''))}</select>
      <input name="q" placeholder="Search narration / amount" value="${f.q}" />
      <button class="btn" data-action="add">+ Manual</button>
    </div>
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
          <span>${escapeHtml(db.accounts.get(t.account_id)?.display_name ?? t.account_hint ?? '?')}</span>
          ${statusPill(t)}
          <select class="inline" data-cat="${t.id}">${categoryOptions(t.category, SPEND_CATEGORIES)}</select>
        </div></div>`,
      )
      .join('')}
    ${rows.length > 400 ? `<p class="muted small center">Showing 400 of ${rows.length} — narrow the filter.</p>` : ''}</div>`;
}

function statusPill(t: Transaction): string {
  if (t.status === 'needs_review') return '<span class="pill warn">not on statement</span>';
  if (t.status === 'provisional') return '<span class="pill muted">alert</span>';
  if (t.status === 'unmatched') return '<span class="pill bad">no account</span>';
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
     <p class="muted small">${t.posted_at} · ${escapeHtml(acc?.display_name ?? t.account_hint)} · ${t.direction} ${money(t.amount_paise)}${t.ref_no ? ` · ref ${escapeHtml(t.ref_no)}` : ''}<br/>
     source ${t.source} · status ${t.status} · categorized by ${t.categorized_by || '—'}</p>
     <label class="field">Category <select name="category">${categoryOptions(t.category, SPEND_CATEGORIES)}</select></label>
     <label class="field">Merchant <input name="merchant" value="${escapeHtml(t.merchant)}" /></label>
     <label class="check"><input type="checkbox" name="rule" /> Also create a rule so similar narrations get this category automatically</label>
     <label class="field">Rule fragment (must appear in the narration) <input name="pattern" value="${escapeHtml(suggestFragment(t))}" /></label>
     ${t.status === 'needs_review' || t.status === 'provisional' ? `<label class="check"><input type="radio" name="fix" value="confirm" /> This alert is real (keep it)</label><label class="check"><input type="radio" name="fix" value="dup" /> Duplicate — hide it</label>` : ''}
     ${t.status === 'unmatched' ? `<label class="field">Attach to account <select name="acc"><option value="">—</option>${db.accounts.rows.map((a) => `<option value="${a.id}">${escapeHtml(a.display_name)}</option>`).join('')}</select></label>` : ''}`,
    { title: 'Transaction' },
  );
  if (!r) return;
  const patch: Partial<Transaction> = {};
  if (r.category !== t.category || r.merchant !== t.merchant) Object.assign(patch, { category: r.category, merchant: r.merchant, categorized_by: 'user' });
  if (r.fix === 'confirm') patch.status = 'confirmed';
  if (r.fix === 'dup') patch.status = 'superseded';
  if (r.acc) Object.assign(patch, { account_id: r.acc, status: 'provisional' });
  if (Object.keys(patch).length) {
    db.update(db.transactions, t.id, patch);
    await db.flush();
  }
  if (r.rule && r.category && r.pattern) {
    const { retagged } = await addRule(r.pattern, r.category, r.merchant ?? '');
    toast(`Rule added · ${retagged} transactions retagged`, 'ok');
  } else toast('Saved', 'ok');
}

function suggestFragment(t: Transaction): string {
  const m = (t.merchant || t.narration).toLowerCase().replace(/[^a-z0-9@.]/g, '');
  return m.slice(0, 24);
}

async function addManual(): Promise<void> {
  const r = await modal(
    `<label class="field">Account <select name="acc">${db.accounts.rows.map((a) => `<option value="${a.id}">${escapeHtml(a.display_name)}</option>`).join('')}</select></label>
     <label class="field">Date <input type="date" name="date" value="${todayIso()}" required /></label>
     <label class="field">Amount (₹) <input name="amount" inputmode="decimal" required /></label>
     <label class="field">Direction <select name="dir"><option value="debit">Spent / debit</option><option value="credit">Received / credit</option></select></label>
     <label class="field">Description <input name="narration" required /></label>
     <label class="field">Category <select name="category">${categoryOptions('', SPEND_CATEGORIES)}</select></label>`,
    { title: 'Manual transaction', submit: 'Add' },
  );
  if (!r) return;
  if (!db.accounts.rows.length) return toast('Add an account first', 'error');
  const amount = Math.abs(parseAmountToPaise(r.amount!));
  const fp = txnFingerprint({ accountId: r.acc!, postedAt: r.date!, direction: r.dir as 'debit', amountPaise: amount, narration: r.narration, refNo: `MANUAL${Date.now()}` });
  await db.append(db.transactions, [
    { id: `t_${fp.slice(0, 20)}`, account_id: r.acc!, account_hint: '', posted_at: r.date!, amount_paise: amount, direction: r.dir as 'debit', narration: r.narration!, ref_no: '', category: r.category ?? '', merchant: '', categorized_by: r.category ? 'user' : '', source: 'manual', status: 'confirmed', email_id: '', statement_id: '', created_at: stamp() },
  ]);
  toast('Added', 'ok');
}

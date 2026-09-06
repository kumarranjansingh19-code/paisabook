import { db, type Transaction } from '../store/db';
import { categoryKind } from './categories';
import { monthEnd, monthOf } from './dates';

/** Category kinds drive the numbers: only 'spend' debits are consumption; only 'refund' credits reduce it. */
const notSpend = (c: string) => {
  const k = categoryKind(c);
  return k === 'transfer' || k === 'investment';
};
const notIncome = (c: string) => {
  const k = categoryKind(c);
  return k === 'transfer' || k === 'investment' || k === 'refund';
};
const isRefund = (c: string) => categoryKind(c) === 'refund';

/** Is this row consumption spending (positive) or a spend-reducing credit (negative)? */
export function spendPaise(t: Transaction): number {
  if (t.direction === 'debit') return notSpend(t.category) ? 0 : t.amount_paise;
  return isRefund(t.category) ? -t.amount_paise : 0;
}

export interface CategoryTotal {
  category: string;
  total_paise: number;
  txn_count: number;
}

export function spendByCategory(rows: Transaction[]): CategoryTotal[] {
  const m = new Map<string, CategoryTotal>();
  for (const t of rows) {
    const p = spendPaise(t);
    if (!p) continue;
    const key = t.category || 'uncategorized';
    const e = m.get(key) ?? { category: key, total_paise: 0, txn_count: 0 };
    e.total_paise += p;
    e.txn_count++;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.total_paise - a.total_paise);
}

export function spendByAccount(rows: Transaction[]): Array<{ account_id: string; total_paise: number; txn_count: number }> {
  const m = new Map<string, { account_id: string; total_paise: number; txn_count: number }>();
  for (const t of rows) {
    const p = spendPaise(t);
    if (!p) continue;
    const e = m.get(t.account_id) ?? { account_id: t.account_id, total_paise: 0, txn_count: 0 };
    e.total_paise += p;
    e.txn_count++;
    m.set(t.account_id, e);
  }
  return [...m.values()].sort((a, b) => b.total_paise - a.total_paise);
}

export function topMerchants(rows: Transaction[], n = 8): Array<{ merchant: string; total_paise: number; txn_count: number }> {
  const m = new Map<string, { merchant: string; total_paise: number; txn_count: number }>();
  for (const t of rows) {
    const p = spendPaise(t);
    if (p <= 0) continue;
    const who = t.merchant || t.narration.slice(0, 28);
    const e = m.get(who) ?? { merchant: who, total_paise: 0, txn_count: 0 };
    e.total_paise += p;
    e.txn_count++;
    m.set(who, e);
  }
  return [...m.values()].sort((a, b) => b.total_paise - a.total_paise).slice(0, n);
}

export interface MonthCashflow {
  month: string;
  income_paise: number;
  salary_paise: number;
  spent_paise: number;
  invested_paise: number;
  family_paise: number;
  cc_payment_paise: number;
  net_paise: number; // accrual: income - spend - family - investment (card spends counted when made)
  cash_net_paise: number; // bank credits - all bank debits (except self transfers)
}

/** Where the salary goes, month by month. Income = credits into BANK accounts only. */
export function monthlyCashflow(rows: Transaction[]): MonthCashflow[] {
  const m = new Map<string, MonthCashflow>();
  const kindOf = (id: string) => db.accounts.get(id)?.kind ?? 'other';
  for (const t of rows) {
    const month = monthOf(t.posted_at);
    const e = m.get(month) ?? { month, income_paise: 0, salary_paise: 0, spent_paise: 0, invested_paise: 0, family_paise: 0, cc_payment_paise: 0, net_paise: 0, cash_net_paise: 0 };
    const kind = kindOf(t.account_id);
    const isBank = kind === 'bank' || kind === 'cash' || kind === 'wallet';
    if (t.direction === 'credit') {
      if (isBank && !notIncome(t.category)) {
        e.income_paise += t.amount_paise;
        if (t.category === 'salary_income') e.salary_paise += t.amount_paise;
        e.cash_net_paise += t.amount_paise;
      }
      if (isRefund(t.category)) e.spent_paise -= t.amount_paise;
    } else {
      if (!notSpend(t.category)) e.spent_paise += t.amount_paise;
      if (categoryKind(t.category) === 'investment') e.invested_paise += t.amount_paise;
      if (t.category === 'family_transfer') e.family_paise += t.amount_paise;
      if (t.category === 'cc_payment') e.cc_payment_paise += t.amount_paise;
      if (isBank && t.category !== 'self_transfer') e.cash_net_paise -= t.amount_paise;
    }
    m.set(month, e);
  }
  for (const e of m.values()) e.net_paise = e.income_paise - e.spent_paise - e.family_paise - e.invested_paise;
  return [...m.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

export function availableMonths(rows: Transaction[]): string[] {
  return [...new Set(rows.map((t) => monthOf(t.posted_at)))].sort().reverse();
}

export function inMonth(rows: Transaction[], month: string): Transaction[] {
  return rows.filter((t) => t.posted_at.startsWith(month));
}

export interface Settlement {
  settled: boolean;
  awaiting: string[]; // card display names without a statement covering the month
}

/** A month is settled when every card with activity has a statement whose period ends on/after month end. */
export function settlement(month: string): Settlement {
  const end = monthEnd(month);
  const awaiting: string[] = [];
  for (const acc of db.activeAccounts()) {
    if (acc.kind !== 'credit_card') continue;
    const hasActivity = db.transactions.rows.some((t) => t.account_id === acc.id && t.status !== 'superseded' && t.posted_at.startsWith(month));
    if (!hasActivity) continue;
    const covered = db.statements.rows.some((s) => s.account_id === acc.id && (s.status === 'imported' || s.status === 'needs_review') && s.period_end >= end);
    if (!covered) awaiting.push(acc.display_name);
  }
  return { settled: awaiting.length === 0, awaiting };
}

/** Upcoming / overdue card bills from statements & bill notices. */
export function upcomingBills(): Array<{ account: string; due_date: string; total_due_paise: number }> {
  const seen = new Map<string, { account: string; due_date: string; total_due_paise: number }>();
  for (const s of db.statements.rows) {
    if (!s.due_date || !s.total_due_paise || s.status === 'failed' || s.status === 'superseded') continue;
    const acc = db.accounts.get(s.account_id);
    if (!acc) continue;
    const cur = seen.get(acc.id);
    if (!cur || s.due_date > cur.due_date) seen.set(acc.id, { account: acc.display_name, due_date: s.due_date, total_due_paise: s.total_due_paise });
  }
  return [...seen.values()].sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
}

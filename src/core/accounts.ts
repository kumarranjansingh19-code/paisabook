import { db, newId, stamp, type Account, type AccountKind } from '../store/db';

/**
 * Best-effort account match from text seen in an alert or statement.
 * Kind-aware: a hint mentioning "credit card"/"card" prefers card accounts
 * (so "SBI Credit Card" never lands on SBI Savings), and vice versa.
 * account_ref may hold several masked numbers ("XX1987 / XX5218") since alerts
 * and statements sometimes mask the same card differently.
 */
export function matchAccount(text: string, kindHint?: 'bank' | 'credit_card' | 'unknown'): Account | undefined {
  const t = text.toUpperCase();
  const wantsCard = kindHint === 'credit_card' || (kindHint !== 'bank' && /CREDIT\s*CARD|\bCARD\b/.test(t));
  const ordered = [...db.activeAccounts()].sort(
    (a, b) => Number((a.kind === 'credit_card') !== wantsCard) - Number((b.kind === 'credit_card') !== wantsCard),
  );
  for (const a of ordered) {
    const last4s = (a.account_ref.match(/\d{4,}/g) ?? []).map((d) => d.slice(-4));
    if (last4s.some((l4) => t.includes(l4))) return a;
  }
  const hintDigits = t.match(/\d{4,}/g)?.map((d) => d.slice(-4)) ?? [];
  // Institution-only match is safe only when the hint carries no digits that
  // contradict every account of that institution.
  return ordered.find((a) => {
    if (!t.includes(instKey(a.institution))) return false;
    const refs = (a.account_ref.match(/\d{4,}/g) ?? []).map((d) => d.slice(-4));
    return hintDigits.length === 0 || refs.length === 0 || hintDigits.some((h) => refs.includes(h));
  });
}

export function instKey(institution: string): string {
  return institution.toUpperCase().replace(/\s+(BANK|LTD|LIMITED|CREDIT CARD|CARD)\b.*$/i, '').trim().split(/\s+/)[0] ?? institution.toUpperCase();
}

export async function addAccount(a: {
  kind: AccountKind;
  institution: string;
  display_name?: string;
  account_ref?: string;
  statement_sender?: string;
  password_hint?: string;
}): Promise<Account> {
  const rec: Account = {
    id: newId('acc'),
    kind: a.kind,
    institution: a.institution.trim(),
    display_name: (a.display_name?.trim() || defaultName(a.kind, a.institution, a.account_ref ?? '')),
    account_ref: a.account_ref?.trim() ?? '',
    statement_sender: a.statement_sender ?? '',
    password_hint: a.password_hint ?? '',
    is_active: true,
    created_at: stamp(),
  };
  await db.append(db.accounts, [rec]);
  return rec;
}

export function defaultName(kind: AccountKind, institution: string, ref: string): string {
  const last4 = ref.match(/\d{4,}/)?.[0]?.slice(-4);
  const what = kind === 'credit_card' ? 'Card' : kind === 'bank' ? 'Bank' : kind === 'cash' ? 'Cash' : kind === 'wallet' ? 'Wallet' : '';
  return [institution.trim(), what, last4 ? `••${last4}` : ''].filter(Boolean).join(' ');
}

export async function updateAccount(id: string, patch: Partial<Account>): Promise<void> {
  db.update(db.accounts, id, patch);
  await db.flush();
}

/**
 * After an account is added, alerts that had no home can be attached to it.
 * Returns how many were re-homed.
 */
export async function rehomeUnmatched(): Promise<number> {
  let n = 0;
  for (const t of db.transactions.rows) {
    if (t.status !== 'unmatched') continue;
    const acc = matchAccount(t.account_hint);
    if (!acc) continue;
    db.update(db.transactions, t.id, { account_id: acc.id, status: 'provisional' });
    n++;
  }
  if (n) await db.flush();
  return n;
}

/** Distinct account hints from unmatched alerts, grouped, for the accounts page. */
export function unmatchedHints(): Array<{ hint: string; count: number; last: string }> {
  const m = new Map<string, { hint: string; count: number; last: string }>();
  for (const t of db.transactions.rows) {
    if (t.status !== 'unmatched') continue;
    const key = t.account_hint.toUpperCase().replace(/\s+/g, ' ').trim();
    const e = m.get(key) ?? { hint: t.account_hint, count: 0, last: '' };
    e.count++;
    if (t.posted_at > e.last) e.last = t.posted_at;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

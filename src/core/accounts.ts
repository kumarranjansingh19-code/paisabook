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

/**
 * Alerts for an institution + masked number we haven't registered, seen at
 * least twice, are strong evidence of an account: create it and attach them.
 * Hints without a masked number stay unmatched for the user to place.
 */
export async function autoCreateFromUnmatched(): Promise<Account[]> {
  const groups = new Map<string, { hint: string; count: number }>();
  for (const t of db.transactions.rows) {
    if (t.status !== 'unmatched' || !t.account_hint) continue;
    const last4 = t.account_hint.match(/\d{4,}/g)?.pop()?.slice(-4);
    const institution = institutionFromHint(t.account_hint);
    if (!last4 || !institution) continue;
    const kind = /credit card|\bcard\b/i.test(t.account_hint) ? 'credit_card' : 'bank';
    const key = `${instKey(institution)}|${kind}|${last4}`;
    const g = groups.get(key) ?? { hint: t.account_hint, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  const created: Account[] = [];
  for (const [key, g] of groups) {
    if (g.count < 2) continue;
    const [, kind, last4] = key.split('|') as [string, AccountKind, string];
    if (matchAccount(g.hint, kind === 'credit_card' ? 'credit_card' : 'bank')) continue;
    created.push(await addAccount({ kind, institution: institutionFromHint(g.hint), account_ref: `XX${last4}` }));
  }
  if (created.length) await rehomeUnmatched();
  return created;
}

/** "Axis Bank Credit Card XX8194" → "Axis Bank"; "YES BANK credit card XX1568" → "YES BANK". */
export function institutionFromHint(hint: string): string {
  const m = /^(.*?)\s*(?:credit card|debit card|card|a\/c|account|acct|savings|current|xx|\*+|ending|no\.?)\b/i.exec(hint) ?? /^([A-Za-z][A-Za-z .&]{1,30}?)\s*(?=X|\*|\d)/.exec(hint);
  const inst = (m ? m[1]! : hint).replace(/[^A-Za-z .&]/g, '').trim();
  return inst.length >= 3 ? inst : '';
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

import { db, newId, stamp, type Account, type AccountKind } from '../store/db';
import { settings, saveSettings } from '../store/local';

/**
 * Best-effort account match from text seen in an alert or statement.
 * Kind-aware: a hint mentioning "credit card"/"card" prefers card accounts
 * (so "SBI Credit Card" never lands on SBI Savings), and vice versa.
 * account_ref may hold several masked numbers ("XX3375 / XX6690") since alerts
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

export interface NewAccount {
  kind: AccountKind;
  institution: string;
  display_name?: string;
  account_ref?: string;
  statement_sender?: string;
  password_hint?: string;
}

function buildAccount(a: NewAccount): Account {
  return {
    id: newId('acc'),
    kind: a.kind,
    institution: normalizeInstitution(a.institution),
    display_name: a.display_name?.trim() || defaultName(a.kind, a.institution, a.account_ref ?? ''),
    account_ref: a.account_ref?.trim() ?? '',
    statement_sender: a.statement_sender ?? '',
    password_hint: a.password_hint ?? '',
    is_active: true,
    created_at: stamp(),
  };
}

export async function addAccount(a: NewAccount): Promise<Account> {
  const twin = sameCardOrAccount(a.kind, a.account_ref ?? '');
  if (twin) return twin;
  const rec = buildAccount(a);
  await db.append(db.accounts, [rec]);
  return rec;
}

/** Several at once = one sheet write (the wizard's "Add selected"). */
export async function addAccounts(list: NewAccount[]): Promise<Account[]> {
  const recs = list.filter((a) => !sameCardOrAccount(a.kind, a.account_ref ?? '')).map(buildAccount);
  if (recs.length) await db.append(db.accounts, recs);
  return recs;
}

const last4s = (ref: string): string[] => (ref.match(/\d{4,}/g) ?? []).map((d) => d.slice(-4));

/**
 * The same card seen under two names — a statement says "RuPay Card XX4396",
 * the alerts say "Edge Credit Card XX4396" — is one account: same kind, same
 * masked number. Institution names differ too often to be part of the key.
 */
export function sameCardOrAccount(kind: AccountKind, ref: string): Account | undefined {
  const mine = last4s(ref);
  if (!mine.length) return undefined;
  return db.activeAccounts().find((a) => a.kind === kind && last4s(a.account_ref).some((l4) => mine.includes(l4)));
}

/**
 * Move everything that points at `drop` onto `keep` and retire `drop`:
 * transactions, statements and sheet sources are re-pointed, masked numbers
 * and the statement sender are unioned, the PDF password (device-only) is
 * carried over if `keep` has none. Writes are queued; caller flushes.
 */
function foldInto(keep: Account, drop: Account): void {
  for (const t of db.transactions.rows) if (t.account_id === drop.id) db.update(db.transactions, t.id, { account_id: keep.id });
  for (const s of db.statements.rows) if (s.account_id === drop.id) db.update(db.statements, s.id, { account_id: keep.id });
  for (const s of db.sources.rows) if (s.account_id === drop.id) db.update(db.sources, s.id, { account_id: keep.id });
  const refs = [...new Set([...keep.account_ref.split('/'), ...drop.account_ref.split('/')].map((r) => r.trim()).filter(Boolean))];
  db.update(db.accounts, keep.id, {
    account_ref: refs.join(' / '),
    statement_sender: keep.statement_sender || drop.statement_sender,
    password_hint: keep.password_hint || drop.password_hint,
  });
  db.update(db.accounts, drop.id, { is_active: false, display_name: `(merged) ${drop.display_name}` });
  const pw = settings().passwords;
  if (pw[drop.id] && !pw[keep.id]) saveSettings({ passwords: { ...pw, [keep.id]: pw[drop.id]! } });
}

/**
 * User-driven merge: "these two are the same account". `keepId` survives,
 * `dropId`'s rows move over and it is hidden. Returns how many transactions
 * moved. Any kinds allowed — the user knows better than the heuristics.
 */
export async function mergeAccounts(keepId: string, dropId: string): Promise<number> {
  const keep = db.accounts.get(keepId);
  const drop = db.accounts.get(dropId);
  if (!keep || !drop || keep.id === drop.id) return 0;
  const moved = db.transactions.rows.filter((t) => t.account_id === drop.id).length;
  foldInto(keep, drop);
  await db.flush();
  return moved;
}

/**
 * Fold accounts that share a kind and masked number into one: the one with
 * statements (else the older one) survives, its twin's rows move over and the
 * twin is deactivated. Returns the number of accounts merged away.
 */
export async function mergeDuplicateAccounts(): Promise<number> {
  const accs = [...db.activeAccounts()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const hasStatements = new Set(db.statements.rows.filter((s) => s.status !== 'failed' && s.status !== 'superseded').map((s) => s.account_id));
  const merged = new Set<string>();
  let n = 0;
  for (let i = 0; i < accs.length; i++) {
    const a = accs[i]!;
    if (merged.has(a.id)) continue;
    for (let j = i + 1; j < accs.length; j++) {
      const b = accs[j]!;
      if (merged.has(b.id) || b.kind !== a.kind) continue;
      const shared = last4s(a.account_ref).some((l4) => last4s(b.account_ref).includes(l4));
      if (!shared) continue;
      const [keep, drop] = hasStatements.has(b.id) && !hasStatements.has(a.id) ? [b, a] : [a, b];
      foldInto(keep, drop);
      merged.add(drop.id);
      n++;
    }
  }
  if (n) await db.flush();
  return n;
}

/** "The Federal Bank Ltd." → "Federal Bank"; "STATE BANK OF INDIA" → "SBI"; "HDFC BANK LIMITED" → "HDFC Bank". */
export function normalizeInstitution(raw: string): string {
  let s = raw.trim().replace(/^the\s+/i, '').replace(/[,.]?\s*(ltd\.?|limited|pvt\.?|private)\s*\.?$/i, '').trim();
  if (/^state bank of india$/i.test(s)) return 'SBI';
  if (s === s.toUpperCase() && s.length > 4) s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Hdfc|Icici|Sbi|Idfc|Rbl|Yes|Au|Dbs|Csb|Hsbc|Pnb|Idbi)\b/g, (m) => m.toUpperCase());
  return s;
}

export function defaultName(kind: AccountKind, institution: string, ref: string): string {
  const last4 = ref.match(/\d{4,}/)?.[0]?.slice(-4);
  const inst = normalizeInstitution(institution);
  const what = kind === 'credit_card' ? (/card$/i.test(inst) ? '' : 'Card') : kind === 'bank' ? (/bank$/i.test(inst) ? '' : 'Bank') : kind === 'cash' ? 'Cash' : kind === 'wallet' ? 'Wallet' : '';
  return [inst, what, last4 ? `XX${last4}` : ''].filter(Boolean).join(' ');
}

/**
 * Delete an account that has no transactions or statements (the sheet row is
 * blanked, never removed, so row numbers stay stable). Accounts with history
 * are hidden instead — their rows stay auditable but drop out of every number.
 */
export async function deleteAccount(id: string): Promise<'deleted' | 'has_data'> {
  const used = db.transactions.rows.some((t) => t.account_id === id) || db.statements.rows.some((s) => s.account_id === id);
  if (used) return 'has_data';
  db.update(db.accounts, id, { institution: '', display_name: '(deleted)', account_ref: '', statement_sender: '', is_active: false });
  await db.flush();
  db.accounts.rows = db.accounts.rows.filter((a) => a.id !== id);
  db.notify();
  return 'deleted';
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

/** "Axis Bank Credit Card XX9127" → "Axis Bank"; "YES BANK credit card XX2210" → "YES BANK". */
export function institutionFromHint(hint: string): string {
  const m = /^(.*?)\s*(?:credit card|debit card|card|a\/c|account|acct|savings|current|xx|\*+|ending|no\.?)\b/i.exec(hint) ?? /^([A-Za-z][A-Za-z .&]{1,30}?)\s*(?=X|\*|\d)/.exec(hint);
  const inst = (m ? m[1]! : hint).replace(/[^A-Za-z .&]/g, '').trim();
  return inst.length >= 3 ? inst : '';
}

const IGNORED_KEY = 'ignored_hints';
export const hintKey = (hint: string) => hint.toUpperCase().replace(/\s+/g, ' ').trim();

export function ignoredHints(): string[] {
  try {
    return JSON.parse(db.getSetting(IGNORED_KEY) || '[]') as string[];
  } catch {
    return [];
  }
}
export function isIgnoredHint(hint: string): boolean {
  const k = hintKey(hint);
  return ignoredHints().some((h) => h === k);
}

/**
 * "Not my account": hide every unmatched alert carrying this hint and skip
 * the hint in future syncs (wallets, someone else's card, FASTag…).
 */
export async function ignoreHint(hint: string): Promise<number> {
  const k = hintKey(hint);
  const list = ignoredHints();
  if (!list.includes(k)) await db.setSetting(IGNORED_KEY, JSON.stringify([...list, k]));
  let n = 0;
  for (const t of db.transactions.rows) {
    if (t.status === 'unmatched' && hintKey(t.account_hint) === k) {
      db.update(db.transactions, t.id, { status: 'superseded' });
      n++;
    }
  }
  await db.flush();
  return n;
}

/** "None of these are mine": ignore every unmatched hint in one go. */
export async function ignoreAllHints(): Promise<{ hints: number; alerts: number }> {
  const keys = new Set(ignoredHints());
  let hints = 0;
  let alerts = 0;
  for (const t of db.transactions.rows) {
    if (t.status !== 'unmatched') continue;
    const k = hintKey(t.account_hint);
    if (k && !keys.has(k)) {
      keys.add(k);
      hints++;
    }
    db.update(db.transactions, t.id, { status: 'superseded' });
    alerts++;
  }
  if (hints) await db.setSetting(IGNORED_KEY, JSON.stringify([...keys]));
  if (alerts) await db.flush();
  return { hints, alerts };
}

export async function restoreHint(k: string): Promise<number> {
  await db.setSetting(IGNORED_KEY, JSON.stringify(ignoredHints().filter((h) => h !== k)));
  let n = 0;
  for (const t of db.transactions.rows) {
    if (t.status === 'superseded' && t.source === 'email_alert' && !t.account_id && hintKey(t.account_hint) === k) {
      db.update(db.transactions, t.id, { status: 'unmatched' });
      n++;
    }
  }
  await db.flush();
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

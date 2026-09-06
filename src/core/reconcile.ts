import { db, stamp, type Transaction, type TxnSource } from '../store/db';
import { txnFingerprint, normalizeNarration } from './fingerprint';
import { daysBetween } from './dates';
import { instKey, isIgnoredHint } from './accounts';

export interface IncomingTxn {
  postedAt: string;
  amountPaise: number;
  direction: 'debit' | 'credit';
  narration: string;
  refNo: string | null;
  category?: string;
  categorizedBy?: Transaction['categorized_by'];
}

export interface ReconcileResult {
  total: number;
  matchedExact: number;
  matchedFuzzy: number;
  inserted: number;
  flaggedForReview: number;
}

const FUZZY_WINDOW_DAYS = 2;

/**
 * Merge authoritative rows (statement or imported sheet) into the ledger.
 * Matching provisional (alert-derived) rows are promoted to confirmed instead
 * of duplicated; unmatched rows are inserted as confirmed; provisional rows
 * inside the period with no counterpart are flagged for review.
 * Writes are queued on db; caller flushes. Returns the rows to append.
 */
export async function reconcile(
  accountId: string,
  sourceId: string,
  source: TxnSource,
  txns: IncomingTxn[],
  period: { start: string | null; end: string | null },
): Promise<ReconcileResult> {
  const result: ReconcileResult = { total: txns.length, matchedExact: 0, matchedFuzzy: 0, inserted: 0, flaggedForReview: 0 };
  const matchedIds = new Set<string>();
  const occurrenceCounter = new Map<string, number>();
  const toInsert: Transaction[] = [];
  const live = db.liveTransactions().filter((t) => t.account_id === accountId);

  for (const t of txns) {
    const narrKey = [t.postedAt, t.direction, t.amountPaise, normalizeNarration(t.narration)].join('|');
    const occurrence = (occurrenceCounter.get(narrKey) ?? 0) + 1;
    occurrenceCounter.set(narrKey, occurrence);
    const fingerprint = txnFingerprint({ accountId, postedAt: t.postedAt, direction: t.direction, amountPaise: t.amountPaise, refNo: t.refNo, narration: t.narration, occurrence });
    const id = `t_${fingerprint.slice(0, 20)}`;

    // 1. Exact fingerprint match (any status, any source).
    const exact = db.transactions.get(id);
    if (exact) {
      matchedIds.add(exact.id);
      if (exact.status === 'provisional' || exact.status === 'needs_review') {
        db.update(db.transactions, exact.id, { status: 'confirmed', statement_id: sourceId });
      }
      result.matchedExact++;
      continue;
    }

    // 2. Fuzzy: same amount/direction within ±2 days, provisional, not yet matched.
    const fuzzy = live.find(
      (row) =>
        !matchedIds.has(row.id) &&
        (row.status === 'provisional' || row.status === 'needs_review') &&
        row.amount_paise === t.amountPaise &&
        row.direction === t.direction &&
        Math.abs(daysBetween(row.posted_at, t.postedAt)) <= FUZZY_WINDOW_DAYS,
    );
    if (fuzzy) {
      matchedIds.add(fuzzy.id);
      db.update(db.transactions, fuzzy.id, { status: 'confirmed', statement_id: sourceId, posted_at: t.postedAt, ref_no: fuzzy.ref_no || (t.refNo ?? '') });
      result.matchedFuzzy++;
      continue;
    }

    // 2a. Near-amount: the alert said ₹1,15,000, the statement posts ₹1,16,357 (surcharge). Same merchant, same day.
    const near = live.find(
      (row) =>
        !matchedIds.has(row.id) &&
        (row.status === 'provisional' || row.status === 'needs_review') &&
        row.direction === t.direction &&
        row.amount_paise !== t.amountPaise &&
        nearAmount(row.amount_paise, t.amountPaise) &&
        similarNarration(row.narration, t.narration) &&
        Math.abs(daysBetween(row.posted_at, t.postedAt)) <= FUZZY_WINDOW_DAYS,
    );
    if (near) {
      matchedIds.add(near.id);
      // the statement's amount is the one that was charged
      db.update(db.transactions, near.id, { status: 'confirmed', statement_id: sourceId, posted_at: t.postedAt, amount_paise: t.amountPaise, ref_no: near.ref_no || (t.refNo ?? '') });
      result.matchedFuzzy++;
      continue;
    }

    // 2b. Cross-source dedup: overlapping statement periods present the same
    // confirmed txn again — same amount/direction/day from a different import.
    const cross = live.find(
      (row) =>
        !matchedIds.has(row.id) &&
        row.status === 'confirmed' &&
        row.amount_paise === t.amountPaise &&
        row.direction === t.direction &&
        row.posted_at === t.postedAt &&
        row.statement_id !== sourceId,
    );
    if (cross) {
      matchedIds.add(cross.id);
      result.matchedExact++;
      continue;
    }

    // 3. New confirmed row.
    const rec: Transaction = {
      id,
      account_id: accountId,
      account_hint: '',
      posted_at: t.postedAt,
      amount_paise: t.amountPaise,
      direction: t.direction,
      narration: t.narration,
      ref_no: t.refNo ?? '',
      category: t.category ?? '',
      merchant: '',
      categorized_by: t.category ? (t.categorizedBy ?? 'sheet') : '',
      source,
      status: 'confirmed',
      email_id: '',
      statement_id: sourceId,
      created_at: stamp(),
    };
    toInsert.push(rec);
    live.push(rec);
    matchedIds.add(id);
    result.inserted++;
  }

  // 4. Provisional rows in-period with no counterpart → review.
  if (period.start && period.end) {
    for (const orphan of live) {
      if (orphan.status !== 'provisional' || matchedIds.has(orphan.id)) continue;
      if (orphan.posted_at < period.start || orphan.posted_at > period.end) continue;
      db.update(db.transactions, orphan.id, { status: 'needs_review' });
      result.flaggedForReview++;
    }
  }

  await db.append(db.transactions, toInsert);
  await db.flush();
  return result;
}

/**
 * Pair provisional alerts with confirmed statement rows that arrived without
 * them (the account didn't exist yet when the statement was imported, or the
 * alert came in later). Same account, amount, direction within ±2 days; each
 * statement row absorbs at most one alert. The alert row is hidden and the
 * statement row keeps the alert's reference/narration if it had none.
 */
/**
 * Card statements sometimes post a slightly different amount from the alert:
 * a surcharge on education/fuel/rent payments, a forex markup, a rounding.
 * Same merchant, same day, within 3% (or ₹50) is the same transaction.
 */
export function nearAmount(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  return diff <= Math.max(5000, Math.round(Math.max(a, b) * 0.03));
}

export async function matchAlertsToStatements(): Promise<number> {
  const live = db.liveTransactions();
  const stmtRows = live.filter((t) => t.source === 'statement' && t.status === 'confirmed');
  const used = new Set<string>();
  let n = 0;
  const alerts = live.filter((a) => a.source === 'email_alert' && (a.status === 'provisional' || a.status === 'needs_review') && !!a.account_id);
  const find = (a: Transaction, tolerant: boolean) =>
    stmtRows.find(
      (r) =>
        !used.has(r.id) &&
        r.account_id === a.account_id &&
        r.direction === a.direction &&
        Math.abs(daysBetween(r.posted_at, a.posted_at)) <= FUZZY_WINDOW_DAYS &&
        (tolerant ? r.amount_paise !== a.amount_paise && nearAmount(r.amount_paise, a.amount_paise) && similarNarration(r.narration, a.narration) : r.amount_paise === a.amount_paise),
    );
  // exact amounts first (so a tolerant match never steals a row that has an exact twin), then near-amount + same merchant
  const pairs: Array<[Transaction, Transaction]> = [];
  for (const a of alerts) {
    const s = find(a, false);
    if (s) {
      used.add(s.id);
      pairs.push([a, s]);
    }
  }
  const matchedAlerts = new Set(pairs.map(([a]) => a.id));
  for (const a of alerts) {
    if (matchedAlerts.has(a.id)) continue;
    const s = find(a, true);
    if (s) {
      used.add(s.id);
      pairs.push([a, s]);
    }
  }
  for (const [a, s] of pairs) {
    used.add(s.id);
    const patch: Partial<Transaction> = {};
    if (!s.ref_no && a.ref_no) patch.ref_no = a.ref_no;
    if (isJunkNarration(s.narration) && !isJunkNarration(a.narration)) patch.narration = a.narration;
    if (!s.category && a.category) Object.assign(patch, { category: a.category, merchant: a.merchant, categorized_by: a.categorized_by });
    if (a.categorized_by === 'user') Object.assign(patch, { category: a.category, merchant: a.merchant, categorized_by: 'user' });
    if (Object.keys(patch).length) db.update(db.transactions, s.id, patch);
    db.update(db.transactions, a.id, { status: 'superseded', statement_id: s.statement_id });
    n++;
  }
  if (n) await db.flush();
  return n;
}

/** Narrations that carry no counterparty — a parser slip or the model's generic fallback. */
export function isJunkNarration(n: string): boolean {
  const s = n.trim();
  if (s.length < 3) return true;
  return /^(inform you|.*\bthat rs\b|.*credit card transaction$|.*bank transaction$|sbi ?!|dear|greetings|transaction alert|payment alert|upi transfer|transaction$)/i.test(s);
}

/** "URBAN COMPANY LIMITED" ~ "URBANCOMPANY": one contains the other once spaces/punctuation are gone. */
export function similarNarration(a: string, b: string): boolean {
  const na = normalizeNarration(a).replace(/\s+/g, '');
  const nb = normalizeNarration(b).replace(/\s+/g, '');
  if (na.length < 4 || nb.length < 4) return false;
  return na.includes(nb) || nb.includes(na) || na.slice(0, 8) === nb.slice(0, 8);
}

/**
 * One-off cleanup for ledgers built before alert dedup existed: among alert
 * rows on the same account with the same amount/direction within a day, keep
 * the one with a reference (or the earliest) and supersede the rest.
 */
export async function dedupeAlerts(): Promise<number> {
  const rows = db.liveTransactions().filter((t) => t.source === 'email_alert').sort((a, b) => (a.posted_at < b.posted_at ? -1 : 1));
  const gone = new Set<string>();
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!;
    if (gone.has(a.id)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j]!;
      if (gone.has(b.id) || b.amount_paise !== a.amount_paise || b.direction !== a.direction) continue;
      if (daysBetween(a.posted_at, b.posted_at) > 1) break;
      const sameAcc = a.account_id ? a.account_id === b.account_id : !b.account_id && instKey(a.account_hint) === instKey(b.account_hint);
      if (!sameAcc) continue;
      const ra = a.ref_no.replace(/\s+/g, '').toUpperCase();
      const rb = b.ref_no.replace(/\s+/g, '').toUpperCase();
      if (ra && rb && ra !== rb && !similarNarration(a.narration, b.narration)) continue;
      // keep the row with a reference; fold the other's better narration into it
      const [keep, drop] = ra || !rb ? [a, b] : [b, a];
      const patch: Partial<Transaction> = {};
      if (!keep.ref_no && drop.ref_no) patch.ref_no = drop.ref_no;
      if ((isJunkNarration(keep.narration) && !isJunkNarration(drop.narration)) || (drop.narration.length > keep.narration.length && !isJunkNarration(drop.narration))) patch.narration = drop.narration;
      if (!keep.category && drop.category) Object.assign(patch, { category: drop.category, merchant: drop.merchant, categorized_by: drop.categorized_by });
      if (Object.keys(patch).length) db.update(db.transactions, keep.id, patch);
      db.update(db.transactions, drop.id, { status: 'superseded' });
      gone.add(drop.id);
      n++;
    }
  }
  await db.flush();
  return n;
}

/** Record a provisional transaction from an alert email. Returns the outcome. */
export function recordAlert(
  alert: { accountId: string | null; accountHint: string; postedAt: string; amountPaise: number; direction: 'debit' | 'credit'; narration: string; refNo: string | null },
  emailId: string,
  pendingBatch: Transaction[],
): 'inserted' | 'duplicate' | 'unmatched' | 'ignored' {
  const accountId = alert.accountId ?? '';
  if (!accountId && isIgnoredHint(alert.accountHint)) return 'ignored';
  const fingerprint = txnFingerprint({
    accountId: accountId || `hint:${alert.accountHint.toUpperCase().replace(/\s+/g, '')}`,
    postedAt: alert.postedAt,
    direction: alert.direction,
    amountPaise: alert.amountPaise,
    refNo: alert.refNo,
    narration: alert.narration,
  });
  const id = `t_${fingerprint.slice(0, 20)}`;
  const exact = db.transactions.get(id);
  if (exact) {
    // Re-reading mail with a better parser: repair a junk narration on the existing row and let it be re-categorized.
    if (exact.categorized_by !== 'user' && isJunkNarration(exact.narration) && !isJunkNarration(alert.narration)) {
      db.update(db.transactions, exact.id, { narration: alert.narration, merchant: '', category: '', categorized_by: '' });
    }
    return 'duplicate';
  }
  if (pendingBatch.some((p) => p.id === id)) return 'duplicate';

  // Banks (and the apps in front of them) often send two mails for one
  // transaction: a UPI alert with the reference, then a generic "your account
  // was debited" without it — or the same payment with two different
  // reference systems. Same account, amount, direction within a day is the
  // same transaction unless both carry different references AND the
  // narrations look unrelated.
  const inst = instKey(alert.accountHint);
  const sameAccount = (r: Transaction) => (accountId ? r.account_id === accountId : !r.account_id && instKey(r.account_hint) === inst);
  const twins = [...db.liveTransactions(), ...pendingBatch].filter(
    (r) => sameAccount(r) && r.amount_paise === alert.amountPaise && r.direction === alert.direction && Math.abs(daysBetween(r.posted_at, alert.postedAt)) <= 1,
  );
  const newRef = alert.refNo?.replace(/\s+/g, '').toUpperCase() ?? '';
  for (const t of twins) {
    const oldRef = t.ref_no.replace(/\s+/g, '').toUpperCase();
    if (oldRef && newRef && oldRef !== newRef && !similarNarration(t.narration, alert.narration)) continue; // genuinely two transactions
    if (db.transactions.has(t.id)) {
      const patch: Partial<Transaction> = {};
      if (!oldRef && newRef) patch.ref_no = alert.refNo ?? '';
      if (isJunkNarration(t.narration) && !isJunkNarration(alert.narration)) Object.assign(patch, { narration: alert.narration, merchant: '', category: t.categorized_by === 'user' ? t.category : '', categorized_by: t.categorized_by === 'user' ? 'user' : '' });
      else if (alert.narration.length > t.narration.length && !isJunkNarration(alert.narration) && t.categorized_by !== 'user') patch.narration = alert.narration;
      if (Object.keys(patch).length) db.update(db.transactions, t.id, patch);
    }
    return 'duplicate';
  }
  pendingBatch.push({
    id,
    account_id: accountId,
    account_hint: alert.accountHint,
    posted_at: alert.postedAt,
    amount_paise: alert.amountPaise,
    direction: alert.direction,
    narration: alert.narration,
    ref_no: alert.refNo ?? '',
    category: '',
    merchant: '',
    categorized_by: '',
    source: 'email_alert',
    status: accountId ? 'provisional' : 'unmatched',
    email_id: emailId,
    statement_id: '',
    created_at: stamp(),
  });
  return accountId ? 'inserted' : 'unmatched';
}

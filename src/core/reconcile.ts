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
      if (ra && rb && ra !== rb) continue;
      // keep the row with a reference; fold the other's better narration into it
      const [keep, drop] = ra || !rb ? [a, b] : [b, a];
      const patch: Partial<Transaction> = {};
      if (!keep.ref_no && drop.ref_no) patch.ref_no = drop.ref_no;
      if (drop.narration.length > keep.narration.length) patch.narration = drop.narration;
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
  if (db.transactions.has(id) || pendingBatch.some((p) => p.id === id)) return 'duplicate';

  // Banks often send two mails for one transaction (a UPI alert with the
  // reference, then a generic "your account was debited" without it). Same
  // account, amount, direction within a day is the same transaction unless
  // both carry different reference numbers.
  const inst = instKey(alert.accountHint);
  const sameAccount = (r: Transaction) => (accountId ? r.account_id === accountId : !r.account_id && instKey(r.account_hint) === inst);
  const twins = [...db.liveTransactions(), ...pendingBatch].filter(
    (r) => sameAccount(r) && r.amount_paise === alert.amountPaise && r.direction === alert.direction && Math.abs(daysBetween(r.posted_at, alert.postedAt)) <= 1,
  );
  const newRef = alert.refNo?.replace(/\s+/g, '').toUpperCase() ?? '';
  for (const t of twins) {
    const oldRef = t.ref_no.replace(/\s+/g, '').toUpperCase();
    if (oldRef && newRef && oldRef !== newRef) continue; // two distinct references: genuinely two transactions
    if (!oldRef && newRef && db.transactions.has(t.id)) {
      // the earlier generic alert learns the reference (and a better narration) from this one
      db.update(db.transactions, t.id, { ref_no: alert.refNo ?? '', narration: alert.narration.length > t.narration.length ? alert.narration : t.narration });
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

import { db, stamp, type Transaction, type TxnSource } from '../store/db';
import { txnFingerprint, normalizeNarration } from './fingerprint';
import { daysBetween } from './dates';

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

/** Record a provisional transaction from an alert email. Returns the outcome. */
export function recordAlert(
  alert: { accountId: string | null; accountHint: string; postedAt: string; amountPaise: number; direction: 'debit' | 'credit'; narration: string; refNo: string | null },
  emailId: string,
  pendingBatch: Transaction[],
): 'inserted' | 'duplicate' | 'unmatched' {
  const accountId = alert.accountId ?? '';
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
  // An alert for an amount already confirmed by a statement on the same day is the same txn.
  if (accountId) {
    const dup = db.liveTransactions().find(
      (r) => r.account_id === accountId && r.amount_paise === alert.amountPaise && r.direction === alert.direction && Math.abs(daysBetween(r.posted_at, alert.postedAt)) <= 1 && (r.ref_no && alert.refNo ? r.ref_no.toUpperCase() === alert.refNo.toUpperCase() : r.source === 'statement'),
    );
    if (dup) return 'duplicate';
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

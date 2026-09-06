import { generateJson } from '../llm/gemini';
import { emailBatchSchema, type EmailBatchResult } from '../llm/schemas';
import { downloadAttachment, fetchFull, fetchMetas, listMessageIds, type EmailMeta, type FetchedEmail } from '../google/gmail';
import { db, stamp, type EmailLog, type Transaction } from '../store/db';
import { settings } from '../store/local';
import { chunk, mapPool } from './pool';
import { emailAddress, passwordHint, redactPii } from './text';
import { gmailDate } from './dates';
import { matchAccount } from './accounts';
import { parseAmountToPaise } from './money';
import { recordAlert } from './reconcile';
import { recordBillNotice, shaOf, type PendingPdf } from './statements';

/** Cheap pre-filter so the LLM only sees plausible financial mail. */
const FIN_WORDS =
  /(debited|credited|spent|transaction|txn|payment|paid|purchase|withdraw|received|upi|imps|neft|rtgs|statement|e-statement|bill|due|a\/c|account|card|balance)/i;
const AMOUNT = /(rs\.?|inr|₹)\s?\d[\d,]*(\.\d+)?|\d[\d,]*(\.\d+)?\s?(rs|inr)/i;
const FIN_SENDER =
  /(bank|card|alerts?|statement|nach|hdfc|icici|axis|sbi|kotak|yesbank|idfc|indusind|federal|rbl|amex|americanexpress|citi|hsbc|sc\.com|aubank|bob|pnb|canara|unionbank|onecard|slice|jupiter|fi\.money|niyo|dbs|standardchartered)/i;
const NOISE_SENDER = /(noreply@github|linkedin|facebook|twitter|instagram|youtube|medium\.com|substack|quora|zomato|swiggy|uber\.com|ola|amazon\.in|flipkart|myntra)/i;

export function looksFinancial(m: EmailMeta): boolean {
  const text = `${m.subject} ${m.snippet}`;
  const from = emailAddress(m.from);
  if (NOISE_SENDER.test(from) && !/statement|debited|credited/i.test(text)) return false;
  if (m.hasPdf && FIN_SENDER.test(from)) return true;
  if (FIN_SENDER.test(from) && FIN_WORDS.test(text)) return true;
  return FIN_WORDS.test(text) && AMOUNT.test(text);
}

/**
 * Server-side pre-filter: lets Gmail find money-related mail so we read a few
 * hundred headers instead of every email in the period. "Broad" scans skip it.
 */
const FOCUSED_TERMS =
  '(debited OR credited OR spent OR statement OR "e-statement" OR transaction OR txn OR "credit card" OR "debit card" OR UPI OR IMPS OR NEFT OR "amount due" OR "total due" OR "minimum due" OR "payment received" OR withdrawn OR deposited OR "Rs." OR INR OR "a/c")';

export function buildQuery(from: string, to: string, broad = false): string {
  const extra = settings().gmailExtraQuery.trim();
  return `after:${gmailDate(from)} before:${gmailDate(to, 1)} -in:spam -in:trash -category:social -category:forums${broad ? '' : ` ${FOCUSED_TERMS}`}${extra ? ` ${extra}` : ''}`;
}

export interface ScanProgress {
  phase: string;
  done: number;
  total: number;
  note?: string;
}

export interface ScanResult {
  listed: number;
  candidates: number;
  alreadyDone: number;
  emails: FetchedEmail[]; // full bodies of candidates (for discovery + processing)
}

/** List → metadata → prefilter → full bodies for candidates not yet processed. */
export async function scanMailbox(from: string, to: string, opts: { reprocess?: boolean; broad?: boolean; onProgress?: (p: ScanProgress) => void; signal?: AbortSignal } = {}): Promise<ScanResult> {
  const p = opts.onProgress ?? (() => {});
  p({ phase: 'Listing mail', done: 0, total: 0 });
  const ids = await listMessageIds(buildQuery(from, to, opts.broad), 8000, opts.signal);
  const fresh = opts.reprocess ? ids : ids.filter((id) => !db.emails.has(id));
  p({ phase: 'Reading headers', done: 0, total: fresh.length, note: `${ids.length} emails in range, ${ids.length - fresh.length} already processed` });
  const metas = await fetchMetas(fresh, (n) => p({ phase: 'Reading headers', done: n, total: fresh.length }), opts.signal);
  // Anything that never gets a full read is logged as skipped so we don't re-read it next time.
  const skipped: EmailLog[] = [];
  const candidateIds: string[] = [];
  for (const m of metas) {
    if (looksFinancial(m)) candidateIds.push(m.id);
    else skipped.push({ id: m.id, received_at: m.receivedAt, from: emailAddress(m.from), subject: m.subject.slice(0, 80), kind: 'skipped', outcome: 'prefilter', processed_at: stamp() });
  }
  p({ phase: 'Downloading candidates', done: 0, total: candidateIds.length });
  const emails = await fetchFull(candidateIds, (n) => p({ phase: 'Downloading candidates', done: n, total: candidateIds.length }), opts.signal);
  await db.append(db.emails, skipped);
  return { listed: ids.length, candidates: emails.length, alreadyDone: ids.length - fresh.length, emails };
}

export interface ProcessSummary {
  alerts: number;
  duplicates: number;
  unmatched: number;
  bills: number;
  pdfs: PendingPdf[];
  llmErrors: number;
}

/**
 * Classify + extract in batches (one LLM call per 12 emails), record alert
 * transactions, bill notices, and collect statement PDFs for the import step.
 */
export async function processEmails(emails: FetchedEmail[], opts: { onProgress?: (p: ScanProgress) => void; signal?: AbortSignal } = {}): Promise<ProcessSummary> {
  const p = opts.onProgress ?? (() => {});
  const summary: ProcessSummary = { alerts: 0, duplicates: 0, unmatched: 0, bills: 0, pdfs: [], llmErrors: 0 };
  const batches = chunk(emails, 12);
  let done = 0;
  p({ phase: 'AI reading emails', done: 0, total: emails.length });
  const pendingTxns: Transaction[] = [];
  const logs: EmailLog[] = [];
  const knownSenders = new Set(db.activeAccounts().map((a) => a.statement_sender).filter(Boolean));

  await mapPool(
    batches,
    3,
    async (batch) => {
      let results: EmailBatchResult['results'] = [];
      try {
        const r = await generateJson<EmailBatchResult>(
          emailBatchSchema,
          `These are emails from a personal Gmail inbox in India. For each one decide the kind and, for transaction alerts, extract the transaction. ` +
            `Long digit runs are masked to the last 4 (XXXX1234) — treat that as the account hint. Amounts must be copied exactly as written. ` +
            `Only bank accounts and credit/debit cards count; wallet/broker/MF/loan mails are 'other'. A card "payment received" credit IS a txn_alert (credit on the card).\n\n` +
            batch.map((e, i) => `--- EMAIL ${i} ---\nFrom: ${e.from}\nSubject: ${e.subject}\nReceived: ${e.receivedAt.slice(0, 10)}\nBody: ${redactPii(e.bodyText.slice(0, 2500))}`).join('\n\n'),
          { tier: 'bulk', signal: opts.signal },
        );
        results = r.results;
      } catch {
        summary.llmErrors += batch.length;
        // leave unlogged so the next run retries them
        done += batch.length;
        p({ phase: 'AI reading emails', done, total: emails.length });
        return;
      }
      const byIndex = new Map(results.map((r) => [r.index, r]));
      for (let i = 0; i < batch.length; i++) {
        const e = batch[i]!;
        const r = byIndex.get(i);
        let outcome = 'ignored';
        const kind = r?.kind ?? 'other';
        const isStatementish = kind === 'cc_statement' || kind === 'bank_statement' || knownSenders.has(emailAddress(e.from));
        if (r?.kind === 'txn_alert' && r.txn) {
          try {
            const amount = Math.abs(parseAmountToPaise(r.txn.amount));
            const acc = matchAccount(r.txn.account_hint, r.txn.account_kind);
            const res = recordAlert(
              { accountId: acc?.id ?? null, accountHint: r.txn.account_hint, postedAt: r.txn.date, amountPaise: amount, direction: r.txn.direction, narration: r.txn.narration, refNo: r.txn.ref_no || null },
              e.id,
              pendingTxns,
            );
            if (res === 'inserted') summary.alerts++;
            else if (res === 'duplicate') summary.duplicates++;
            else summary.unmatched++;
            outcome = res;
          } catch (err) {
            outcome = `parse_error: ${String(err).slice(0, 60)}`;
          }
        }
        if ((kind === 'cc_bill_notice' || kind === 'cc_statement') && r?.bill) {
          if (await recordBillNotice(e.id, e.subject, r.bill)) {
            summary.bills++;
            outcome = outcome === 'ignored' ? 'bill_recorded' : `${outcome}+bill`;
          }
        }
        if (isStatementish || e.hasPdf) {
          for (const att of e.attachments) {
            if (!/pdf/i.test(att.mimeType) && !/\.pdf$/i.test(att.filename)) continue;
            if (!isStatementish && !/statement|stmt|estatement|e-statement/i.test(`${att.filename} ${e.subject}`)) continue;
            try {
              const data = await downloadAttachment(e.id, att.attachmentId);
              const sha = await shaOf(data);
              if (db.statements.has(sha) && db.statements.get(sha)!.status !== 'failed') {
                outcome = outcome === 'ignored' ? 'statement_already_imported' : outcome;
                continue;
              }
              const guess = db.activeAccounts().find((a) => a.statement_sender && a.statement_sender === emailAddress(e.from));
              summary.pdfs.push({ sha, filename: att.filename, data, emailId: e.id, from: e.from, subject: e.subject, receivedAt: e.receivedAt, hint: passwordHint(e.bodyText), accountGuess: guess?.id ?? '' });
              outcome = outcome === 'ignored' ? 'pdf_queued' : `${outcome}+pdf`;
            } catch (err) {
              outcome = `attachment_error: ${String(err).slice(0, 60)}`;
            }
          }
        }
        logs.push({ id: e.id, received_at: e.receivedAt, from: emailAddress(e.from), subject: e.subject.slice(0, 80), kind, outcome, processed_at: stamp() });
      }
      done += batch.length;
      p({ phase: 'AI reading emails', done, total: emails.length, note: `${summary.alerts} alerts, ${summary.pdfs.length} PDFs` });
    },
    opts.signal,
  );

  await db.append(db.transactions, pendingTxns);
  await db.append(db.emails, logs);
  return summary;
}

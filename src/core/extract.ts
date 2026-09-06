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
import { detectStatement, parseAlert, parseBill } from './heuristics';
import { getCachedEmails, getCachedMetas, putCachedEmails, putCachedMetas } from '../store/mailcache';

/** Cheap pre-filter so the LLM only sees plausible financial mail. */
const FIN_WORDS =
  /(debited|credited|spent|transaction|txn|payment|paid|purchase|withdraw|received|upi|imps|neft|rtgs|statement|e-statement|bill|due|a\/c|account|card|balance)/i;
const AMOUNT = /(rs\.?|inr|₹)\s?\d[\d,]*(\.\d+)?|\d[\d,]*(\.\d+)?\s?(rs|inr)/i;
const FIN_SENDER =
  /(bank|card|alerts?|statement|nach|hdfc|icici|axis|sbi|kotak|yesbank|idfc|indusind|federal|rbl|amex|americanexpress|citi|hsbc|sc\.com|aubank|bob|pnb|canara|unionbank|onecard|slice|jupiter|fi\.money|niyo|dbs|standardchartered)/i;
const NOISE_SENDER = /(noreply@github|linkedin|facebook|twitter|instagram|youtube|medium\.com|substack|quora|zomato|swiggy|uber\.com|ola|amazon\.in|flipkart|myntra)/i;
/** PDFs that are never bank/card statements: broker ledgers, demat/CAS, mutual funds, NPS, insurance. */
const PDF_NOISE = /(zerodha|kite|coin\b|groww|upstox|angelone|indmoney|cdsl|nsdl|cams|kfintech|karvy|protean|\bnps\b|\bcra\b|demat|holding|consolidated account|mutual fund|folio|\bsip\b|epfo|insurance|policy|premium receipt|invoice|receipt|ticket|itinerary|boarding)/i;

const MARKETING_SUBJECT =
  /(offer|reward|voucher|milestone|emi\b|upgrade|festival|sale\b|% ?off|congratulations|refer|pre-?approved|loan\b|insurance|invitation|webinar|newsletter|tips|beware|awareness|survey|feedback|unlock|exciting|introducing|announc)/i;

/**
 * Should this email be downloaded and read? Mail from a bank or card issuer
 * is read unless the subject is plainly marketing (snippets are too short to
 * judge a transaction alert by); everything else needs money words + an amount.
 */
export function looksFinancial(m: EmailMeta): boolean {
  const text = `${m.subject} ${m.snippet}`;
  const from = emailAddress(m.from);
  if (NOISE_SENDER.test(from) && !/statement|debited|credited/i.test(text)) return false;
  if (FIN_SENDER.test(from)) {
    if (m.hasPdf) return true;
    if (FIN_WORDS.test(text) || AMOUNT.test(text)) return true;
    return !MARKETING_SUBJECT.test(m.subject);
  }
  return FIN_WORDS.test(text) && AMOUNT.test(text);
}

/** Bank-sender mail the bulk model called "other" but which mentions an amount deserves a second, stronger read. */
export function deservesSecondLook(e: FetchedEmail): boolean {
  return FIN_SENDER.test(emailAddress(e.from)) && AMOUNT.test(e.bodyText) && !MARKETING_SUBJECT.test(e.subject);
}

/**
 * Server-side pre-filter: lets Gmail find money-related mail so we read a few
 * hundred headers instead of every email in the period. "Broad" scans skip it.
 */
const FOCUSED_TERMS =
  '(debited OR credited OR spent OR statement OR "e-statement" OR transaction OR txn OR "credit card" OR "debit card" OR UPI OR IMPS OR NEFT OR "amount due" OR "total due" OR "minimum due" OR "payment received" OR withdrawn OR deposited OR "Rs." OR INR OR "a/c" OR from:(bank OR card OR alerts OR alert OR statement OR statements OR jupiter OR onecard OR slice))';

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
  /** headers read so far / headers to read — equal when the scan completed */
  read: number;
  total: number;
  /** set when Gmail cut the scan short; what was read is returned and checkpointed for a resume */
  interrupted?: string;
}

/**
 * Scan checkpoint: the message ids for a period plus every header read so
 * far. Kept on the device until the same scan completes, so a run that
 * Gmail cuts short continues from the last batch instead of starting over.
 */
export interface ScanCheckpoint {
  key: string;
  from: string;
  to: string;
  ids: string[];
  metas: EmailMeta[];
  savedAt: string;
}
const CK_KEY = 'paisabook.scan.v1';

export function scanCheckpoint(): ScanCheckpoint | null {
  try {
    const raw = localStorage.getItem(CK_KEY);
    return raw ? (JSON.parse(raw) as ScanCheckpoint) : null;
  } catch {
    return null;
  }
}
export function clearScanCheckpoint(): void {
  try {
    localStorage.removeItem(CK_KEY);
  } catch {
    /* ignore */
  }
}
function saveCheckpoint(ck: ScanCheckpoint): void {
  try {
    localStorage.setItem(CK_KEY, JSON.stringify({ ...ck, savedAt: new Date().toISOString() }));
  } catch {
    /* quota — the scan still works, just without resume */
  }
}
export function scanKey(from: string, to: string, broad?: boolean, reprocess?: boolean): string {
  return `${from}|${to}|${broad ? 1 : 0}|${reprocess ? 1 : 0}`;
}

const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError';

/**
 * List → metadata → prefilter → full bodies for candidates not yet processed.
 * Never throws on a rate limit after listing: returns what it read, with
 * `interrupted` set, and leaves a checkpoint so the next call resumes.
 */
export async function scanMailbox(
  from: string,
  to: string,
  opts: {
    reprocess?: boolean;
    broad?: boolean;
    /** headers + snippet only (account discovery) — 1 read per email, no bodies */
    metaOnly?: boolean;
    /** newest-first cap on how many emails to read (discovery doesn't need the whole period) */
    maxEmails?: number;
    onProgress?: (p: ScanProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ScanResult> {
  const p = opts.onProgress ?? (() => {});
  const key = scanKey(from, to, opts.broad, opts.reprocess);
  let ck = scanCheckpoint();
  if (ck && ck.key !== key) ck = null;

  let ids: string[];
  if (ck) {
    ids = ck.ids;
  } else {
    p({ phase: 'Listing mail', done: 0, total: 0 });
    ids = await listMessageIds(buildQuery(from, to, opts.broad), opts.maxEmails ?? 8000, opts.signal);
    ck = { key, from, to, ids, metas: [], savedAt: '' };
    saveCheckpoint(ck);
  }
  const fresh = opts.reprocess ? ids : ids.filter((id) => !db.emails.has(id));
  const have = new Map(ck.metas.map((m) => [m.id, m]));
  // Headers downloaded in any earlier scan (discovery, an interrupted run) are served from the device cache.
  for (const [id, m] of await getCachedMetas(fresh.filter((id) => !have.has(id)))) have.set(id, m);
  const remaining = fresh.filter((id) => !have.has(id));
  const already = fresh.length - remaining.length;
  p({ phase: 'Reading headers', done: already, total: fresh.length, note: `${ids.length} emails in range${already ? `, ${already} already on this device` : ''}` });

  let interrupted: string | undefined;
  let lastSave = Date.now();
  try {
    await fetchMetas(remaining, {
      signal: opts.signal,
      onBatch: (ms) => {
        for (const m of ms) have.set(m.id, m);
        void putCachedMetas(ms);
        if (Date.now() - lastSave > 2500) {
          ck!.metas = [...have.values()];
          saveCheckpoint(ck!);
          lastSave = Date.now();
        }
      },
      onProgress: (n) => p({ phase: 'Reading headers', done: already + n, total: fresh.length }),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    interrupted = String((err as Error).message ?? err);
  }
  ck.metas = [...have.values()];
  saveCheckpoint(ck);
  const metas = fresh.map((id) => have.get(id)).filter((m): m is EmailMeta => !!m);

  // Anything that never gets a full read is logged as skipped so we don't re-read it next time.
  const skipped: EmailLog[] = [];
  const candidates: EmailMeta[] = [];
  for (const m of metas) {
    if (looksFinancial(m)) candidates.push(m);
    else skipped.push({ id: m.id, received_at: m.receivedAt, from: emailAddress(m.from), subject: m.subject.slice(0, 80), kind: 'skipped', outcome: 'prefilter', processed_at: stamp() });
  }
  const base = { listed: ids.length, alreadyDone: ids.length - fresh.length, read: metas.length, total: fresh.length, ...(interrupted ? { interrupted } : {}) };

  if (opts.metaOnly) {
    if (!interrupted) clearScanCheckpoint();
    return { ...base, candidates: candidates.length, emails: candidates.map((m) => ({ ...m, bodyText: m.snippet, attachments: [] })) };
  }

  // Full bodies for candidates. On a rate limit, keep what landed: the caller
  // processes it and the email log makes the next run skip it.
  const candidateIds = candidates.filter((m) => opts.reprocess || !db.emails.has(m.id)).map((m) => m.id);
  const cachedFull = await getCachedEmails(candidateIds);
  const emails: FetchedEmail[] = [...cachedFull.values()];
  const wanted = candidateIds.filter((id) => !cachedFull.has(id));
  p({ phase: 'Downloading candidates', done: 0, total: wanted.length, note: cachedFull.size ? `${cachedFull.size} already on this device` : undefined });
  try {
    await fetchFull(wanted, {
      signal: opts.signal,
      onBatch: (es) => {
        emails.push(...es);
        void putCachedEmails(es);
      },
      onProgress: (n) => p({ phase: 'Downloading candidates', done: n, total: wanted.length }),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    interrupted = interrupted ?? String((err as Error).message ?? err);
  }
  if (!opts.reprocess) await db.append(db.emails, skipped);
  if (!interrupted) clearScanCheckpoint();
  return { ...base, ...(interrupted ? { interrupted } : {}), candidates: emails.length, emails };
}

export interface ProcessSummary {
  alerts: number;
  duplicates: number;
  unmatched: number;
  bills: number;
  pdfs: PendingPdf[];
  llmErrors: number;
  /** emails read by rules alone (no AI call) */
  heuristic: number;
  /** emails the AI had to read */
  ai: number;
}

type EmailResult = EmailBatchResult['results'][number];

/**
 * Rules first, AI for the rest. Every batch is persisted (transactions +
 * email log) as soon as it's done, so a run cut short by any rate limit
 * resumes from where it stopped instead of re-reading — and re-paying for —
 * the same mail.
 */
export async function processEmails(emails: FetchedEmail[], opts: { onProgress?: (p: ScanProgress) => void; signal?: AbortSignal } = {}): Promise<ProcessSummary> {
  const p = opts.onProgress ?? (() => {});
  const summary: ProcessSummary = { alerts: 0, duplicates: 0, unmatched: 0, bills: 0, pdfs: [], llmErrors: 0, heuristic: 0, ai: 0 };
  const knownSenders = new Set(db.activeAccounts().map((a) => a.statement_sender).filter(Boolean));
  const pendingTxns: Transaction[] = [];
  const logs: EmailLog[] = [];
  const persist = async () => {
    const txns = pendingTxns.splice(0);
    const l = logs.splice(0);
    await db.append(db.transactions, txns);
    await db.append(db.emails, l);
  };

  // Pass 1 — deterministic readers. Whatever they can't read confidently is queued for the AI.
  const leftovers: FetchedEmail[] = [];
  p({ phase: 'Reading emails (rules)', done: 0, total: emails.length });
  for (const e of emails) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const stmt = detectStatement(e);
    const alert = stmt ? null : parseAlert(e);
    const bill = alert ? null : parseBill(e);
    if (!stmt && !alert && !bill) {
      leftovers.push(e);
      continue;
    }
    const r: EmailResult = stmt
      ? { index: 0, kind: stmt, ...(bill ? { bill } : {}) }
      : alert
        ? { index: 0, kind: 'txn_alert', txn: alert }
        : { index: 0, kind: 'cc_bill_notice', bill: bill! };
    await handleOne(e, r, 'rules');
    summary.heuristic++;
  }
  await persist();
  p({ phase: 'AI reading emails', done: 0, total: leftovers.length, note: `${summary.heuristic} read by rules` });

  // Pass 2 — AI (cheap model), in small batches, persisted after each batch.
  // Bank-sender mail it calls "other" despite an amount is held back for pass 3.
  const PROMPT =
    `These are emails from a personal Gmail inbox in India. For each one decide the kind and, for transaction alerts, extract the transaction. ` +
    `Long digit runs are masked to the last 4 (XXXX1234) — treat that as the account hint. Amounts must be copied exactly as written, every digit. ` +
    `Only bank accounts and credit/debit cards count; wallet/broker/MF/loan mails are 'other'. A card "payment received" / "payment credited" IS a txn_alert with direction credit on the card. ` +
    `Dividend, interest, refund and NEFT/IMPS credits to a bank account are txn_alerts too.\n\n`;
  const listing = (batch: FetchedEmail[], chars: number) =>
    batch.map((e, i) => `--- EMAIL ${i} ---\nFrom: ${e.from}\nSubject: ${e.subject}\nReceived: ${e.receivedAt.slice(0, 10)}\nBody: ${redactPii(e.bodyText.slice(0, chars))}`).join('\n\n');
  const secondLook: FetchedEmail[] = [];
  let done = 0;
  const runPass = async (items: FetchedEmail[], tier: 'bulk' | 'reasoning', per: number, chars: number, phase: string, holdBack: boolean) => {
    done = 0;
    await mapPool(
      chunk(items, per),
      2,
      async (batch, _i, poolSignal) => {
        let results: EmailBatchResult['results'] = [];
        try {
          const r = await generateJson<EmailBatchResult>(emailBatchSchema, PROMPT + listing(batch, chars), { tier, signal: poolSignal });
          results = r.results;
        } catch (err) {
          if (poolSignal.aborted) throw err;
          summary.llmErrors += batch.length;
          done += batch.length; // left unlogged so the next run retries them
          p({ phase, done, total: items.length });
          return;
        }
        const byIndex = new Map(results.map((r) => [r.index, r]));
        for (let i = 0; i < batch.length; i++) {
          const e = batch[i]!;
          const r = byIndex.get(i);
          if (holdBack && (!r || r.kind === 'other') && deservesSecondLook(e)) {
            secondLook.push(e);
            continue;
          }
          await handleOne(e, r, 'ai');
          summary.ai++;
        }
        done += batch.length;
        await persist();
        p({ phase, done, total: items.length, note: `${summary.alerts} alerts, ${summary.pdfs.length} PDFs` });
      },
      opts.signal,
    );
  };
  await runPass(leftovers, 'bulk', 12, 2500, 'AI reading emails', true);
  // Pass 3 — the stronger model, fewer emails per call, fuller bodies.
  if (secondLook.length) {
    p({ phase: 'AI second look', done: 0, total: secondLook.length, note: `${secondLook.length} bank emails re-read closely` });
    await runPass(secondLook, 'reasoning', 5, 6000, 'AI second look', false);
  }
  await persist();
  return summary;

  async function handleOne(e: FetchedEmail, r: EmailResult | undefined, via: 'rules' | 'ai'): Promise<void> {
    {
      {
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
        if ((isStatementish || e.hasPdf) && !PDF_NOISE.test(`${e.from} ${e.subject}`)) {
          for (const att of e.attachments) {
            if (!/pdf/i.test(att.mimeType) && !/\.pdf$/i.test(att.filename)) continue;
            if (!isStatementish && !/statement|stmt|estatement|e-statement/i.test(`${att.filename} ${e.subject}`)) continue;
            if (PDF_NOISE.test(att.filename)) continue;
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
        logs.push({ id: e.id, received_at: e.receivedAt, from: emailAddress(e.from), subject: e.subject.slice(0, 80), kind: `${kind}${via === 'rules' ? ' (rules)' : ''}`, outcome, processed_at: stamp() });
      }
    }
  }
}

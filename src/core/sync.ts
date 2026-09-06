/**
 * The one-button pipeline: scan mail for a period → AI-read candidates →
 * import statement PDFs (pausing on ones that need a password) → categorize.
 * Progress is pushed to the UI; the run can be aborted at any point and every
 * completed step is already persisted in the sheet.
 */
import { db } from '../store/db';
import { categorizeAll } from './categorize';
import { fetchStatementMails, processEmails, scanMailbox, type ScanProgress } from './extract';
import { importStatement, type ImportOutcome, type PendingPdf } from './statements';
import { autoCreateFromUnmatched, rehomeUnmatched } from './accounts';
import { daysAgoIso, todayIso } from './dates';
import { usage } from '../llm/gemini';
import { mapPool } from './pool';
import { gmailPace, type FetchedEmail } from '../google/gmail';

export interface SyncOptions {
  from: string;
  to: string;
  reprocess?: boolean;
  /** read every email's headers instead of letting Gmail pre-filter for money-related mail */
  broad?: boolean;
  forceStatements?: boolean;
  skipCategorize?: boolean;
}

export interface SyncState {
  running: boolean;
  phase: string;
  progress: ScanProgress | null;
  log: string[];
  error: string | null;
  /** PDFs waiting for a password or an account; the user resolves them from the UI */
  pendingPdfs: PendingPdf[];
  lastEmails: FetchedEmail[];
  summary: Record<string, number>;
  startedAt: number;
  llmCallsAtStart: number;
}

export const syncState: SyncState = {
  running: false,
  phase: 'idle',
  progress: null,
  log: [],
  error: null,
  pendingPdfs: [],
  lastEmails: [],
  summary: {},
  startedAt: 0,
  llmCallsAtStart: 0,
};

const listeners = new Set<() => void>();
export function onSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(): void {
  listeners.forEach((fn) => fn());
}
function log(msg: string): void {
  syncState.log.push(`${new Date().toLocaleTimeString('en-IN', { hour12: false })}  ${msg}`);
  if (syncState.log.length > 200) syncState.log.shift();
  emit();
}
let controller: AbortController | null = null;

export function abortSync(): void {
  controller?.abort();
}

export function defaultPeriod(months = 3): { from: string; to: string } {
  return { from: daysAgoIso(months * 30 + 5), to: todayIso() };
}

export async function runSync(opts: SyncOptions): Promise<void> {
  if (syncState.running) return;
  controller = new AbortController();
  const signal = controller.signal;
  Object.assign(syncState, { running: true, phase: 'starting', progress: null, log: [], error: null, summary: {}, startedAt: Date.now(), llmCallsAtStart: usage.calls });
  emit();
  const onProgress = (p: ScanProgress) => {
    syncState.progress = p;
    syncState.phase = p.phase;
    emit();
  };
  let lastLimitLog = 0;
  const onLimit = (e: Event) => {
    const d = (e as CustomEvent<{ waitMs: number; status: number }>).detail;
    if (syncState.progress) syncState.progress = { ...syncState.progress, note: `Google rate limit (${d.status}), pausing ${Math.round(d.waitMs / 1000)}s` };
    if (Date.now() - lastLimitLog > 15_000) {
      lastLimitLog = Date.now();
      log(`⏸ Google rate limit hit — pausing ${Math.round(d.waitMs / 1000)}s before retrying`);
    } else emit();
  };
  window.addEventListener('paisabook:ratelimit', onLimit);
  try {
    log(`Scanning ${opts.from} → ${opts.to}${opts.reprocess ? ' (re-reading processed mail)' : ''}`);
    const scan = await scanMailbox(opts.from, opts.to, { reprocess: opts.reprocess, broad: opts.broad, onProgress, signal });
    syncState.lastEmails = scan.emails;
    syncState.summary.emails_in_range = scan.listed;
    syncState.summary.candidates = scan.candidates;
    log(`${scan.listed} emails in range, ${scan.alreadyDone} already processed, ${scan.candidates} look financial`);
    if (scan.interrupted) {
      log(`⏸ Gmail stopped us after ${scan.read}/${scan.total} headers (${scan.interrupted.slice(0, 90)}). Processing what was read; run Sync again to continue from there.`);
      syncState.summary.headers_read = scan.read;
      syncState.summary.headers_total = scan.total;
    }

    if (scan.emails.length) {
      const proc = await processEmails(scan.emails, { onProgress, signal });
      Object.assign(syncState.summary, { alerts: proc.alerts, duplicates: proc.duplicates, unmatched: proc.unmatched, bills: proc.bills, pdfs: proc.pdfs.length, llm_errors: proc.llmErrors });
      log(`${proc.alerts} new alerts, ${proc.duplicates} duplicates, ${proc.unmatched} for unknown accounts, ${proc.bills} bill notices, ${proc.pdfs.length} statement PDFs`);
      if (proc.llmErrors) log(`⚠ ${proc.llmErrors} emails failed AI reading — they'll be retried on the next sync`);
      // merge new PDFs with any left over from an earlier run
      const known = new Set(syncState.pendingPdfs.map((p) => p.sha));
      for (const p of proc.pdfs) if (!known.has(p.sha)) syncState.pendingPdfs.push(p);
    }

    await importPending({ force: opts.forceStatements, signal });
    const created = await autoCreateFromUnmatched();
    if (created.length) log(`Accounts created from repeated alerts: ${created.map((a) => a.display_name).join(', ')}`);

    if (!opts.skipCategorize) {
      syncState.phase = 'Categorizing';
      onProgress({ phase: 'Categorizing', done: 0, total: 0 });
      const cat = await categorizeAll((done, total) => onProgress({ phase: 'Categorizing', done, total }), signal);
      syncState.summary.categorized_rules = cat.byRule;
      syncState.summary.categorized_ai = cat.byLlm;
      log(`Categorized: ${cat.byRule} by rules, ${cat.byLlm} by AI`);
    }
    await db.setSetting('last_sync', new Date().toISOString());
    await db.setSetting('last_sync_to', opts.to);
    syncState.phase = scan.interrupted ? 'partial' : 'done';
    log(`${scan.interrupted ? 'Partial run finished' : 'Done'} in ${Math.round((Date.now() - syncState.startedAt) / 1000)}s using ${usage.calls - syncState.llmCallsAtStart} AI calls · Gmail pace now ${gmailPace()} reads/s`);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      syncState.phase = 'stopped';
      log('Stopped. Everything finished so far is saved.');
    } else {
      syncState.error = String((err as Error).message ?? err);
      syncState.phase = 'error';
      log(`✖ ${syncState.error}`);
    }
  } finally {
    window.removeEventListener('paisabook:ratelimit', onLimit);
    syncState.running = false;
    syncState.progress = null;
    controller = null;
    emit();
    db.notify();
  }
}

/**
 * The waiting queue is mirrored into the statements tab (status queued /
 * needs_password / needs_account, no bytes) so a reload, another device or a
 * later session can still see and resolve those PDFs.
 */
const pendId = (p: PendingPdf) => `pend_${p.emailId || 'local'}_${(p.attachmentId ?? p.sha).slice(0, 16)}`;

async function persistPending(pdf: PendingPdf, status: 'queued' | 'needs_password' | 'needs_account', note = ''): Promise<void> {
  if (!pdf.emailId || !pdf.attachmentId) return; // local files can't be re-downloaded — nothing to persist
  const id = pendId(pdf);
  const notes = JSON.stringify({ attachmentId: pdf.attachmentId, from: pdf.from, subject: pdf.subject, hint: pdf.hint, note });
  if (db.statements.has(id)) {
    db.update(db.statements, id, { status, notes, account_id: pdf.accountGuess });
    await db.flush();
  } else {
    await db.append(db.statements, [
      { id, account_id: pdf.accountGuess, kind: /card/i.test(pdf.subject) ? 'credit_card' : 'bank', period_start: '', period_end: '', txn_count: 0, inserted: 0, matched: 0, total_due_paise: 0, due_date: '', source: pdf.filename, email_id: pdf.emailId, status, notes, imported_at: new Date().toISOString() },
    ]);
  }
}

async function resolvePending(pdf: PendingPdf): Promise<void> {
  const id = pendId(pdf);
  if (db.statements.has(id)) {
    db.update(db.statements, id, { status: 'superseded' });
    await db.flush();
  }
}

/** Rebuild the in-memory queue from the sheet (called when the Sync page opens and before a sync). */
export function loadPendingFromSheet(): number {
  const known = new Set(syncState.pendingPdfs.map((p) => p.sha));
  let n = 0;
  for (const s of db.statements.rows) {
    if (s.status !== 'queued' && s.status !== 'needs_password' && s.status !== 'needs_account') continue;
    let meta: { attachmentId?: string; from?: string; subject?: string; hint?: string | null; note?: string } = {};
    try {
      meta = JSON.parse(s.notes || '{}');
    } catch {
      /* ignore */
    }
    if (!meta.attachmentId || !s.email_id) continue;
    const sha = s.id; // provisional identity until the bytes are back
    if (known.has(sha) || syncState.pendingPdfs.some((p) => p.emailId === s.email_id && p.attachmentId === meta.attachmentId)) continue;
    syncState.pendingPdfs.push({
      sha,
      filename: s.source,
      attachmentId: meta.attachmentId,
      emailId: s.email_id,
      from: meta.from ?? '',
      subject: meta.subject ?? '',
      receivedAt: s.imported_at,
      hint: meta.hint ?? null,
      accountGuess: s.account_id,
      lastError: s.status === 'needs_password' ? 'needs password' : s.status === 'needs_account' ? (meta.note || 'no matching account') : undefined,
    });
    n++;
  }
  if (n) emit();
  return n;
}

/** Import every queued PDF we can open; leave the rest queued with a reason. */
export async function importPending(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  loadPendingFromSheet();
  const queue = [...syncState.pendingPdfs];
  if (!queue.length) return;
  for (const pdf of queue) if (!db.statements.has(pendId(pdf))) await persistPending(pdf, 'queued');
  let n = 0;
  syncState.phase = 'Importing statements';
  syncState.progress = { phase: 'Importing statements', done: 0, total: queue.length };
  emit();
  // Three at a time: each import is mostly waiting on the model. Sheet appends are serialized in db.
  await mapPool(
    queue,
    3,
    async (pdf) => {
      if (opts.signal?.aborted) return;
      const res = await importStatement(pdf, { force: opts.force, signal: opts.signal });
      applyOutcome(pdf, res);
      n++;
      syncState.progress = { phase: 'Importing statements', done: n, total: queue.length, note: pdf.filename };
      emit();
    },
    opts.signal,
  ).catch((err) => log(`✖ statement import: ${String((err as Error).message ?? err)}`));
  const rehomed = await rehomeUnmatched();
  if (rehomed) log(`${rehomed} earlier alerts attached to accounts learned from statements`);
}

export function applyOutcome(pdf: PendingPdf, res: ImportOutcome): void {
  const drop = () => {
    syncState.pendingPdfs = syncState.pendingPdfs.filter((p) => p.sha !== pdf.sha);
    void resolvePending(pdf);
  };
  switch (res.status) {
    case 'imported': {
      const acc = db.accounts.get(res.statement.account_id);
      log(`✔ ${pdf.filename}: ${acc?.display_name ?? '?'} ${res.statement.period_start || ''}→${res.statement.period_end}: ${res.inserted} new, ${res.matched} matched alerts${res.review ? `, ${res.review} to review` : ''}${res.createdAccount ? ` · new account created: ${res.createdAccount}` : ''}${res.statement.notes ? ` — ${res.statement.notes}` : ''}`);
      drop();
      break;
    }
    case 'already_imported':
      drop();
      break;
    case 'ignored':
      log(`– ${pdf.filename}: ${res.reason}`);
      drop();
      break;
    case 'needs_password':
      pdf.lastError = 'needs password';
      log(`🔒 ${pdf.filename} needs a password${res.hint ? ` (hint: ${res.hint})` : ''}`);
      void persistPending(pdf, 'needs_password');
      break;
    case 'needs_account':
      pdf.lastError = `no account for "${res.hint}"`;
      pdf.accountGuess = '';
      log(`❓ ${pdf.filename}: no account matches "${res.hint}" — add it under Accounts, then retry`);
      void persistPending(pdf, 'needs_account', `no account for "${res.hint}"`);
      break;
    case 'failed':
      pdf.lastError = res.reason;
      log(`✖ ${pdf.filename}: ${res.reason}`);
      break;
  }
  emit();
}

/**
 * Statements only, for a period: find statement mails, queue their PDFs,
 * import what the saved passwords can open. Cheap — no inbox scan, no AI on
 * alerts. Use it after adding a password or when a month shows "pending".
 */
export async function fetchStatements(from: string, to: string): Promise<void> {
  if (syncState.running) return;
  controller = new AbortController();
  const signal = controller.signal;
  Object.assign(syncState, { running: true, phase: 'Finding statements', progress: null, log: [], error: null, summary: {}, startedAt: Date.now(), llmCallsAtStart: usage.calls });
  emit();
  const onProgress = (p: ScanProgress) => {
    syncState.progress = p;
    syncState.phase = p.phase;
    emit();
  };
  try {
    log(`Looking for statement emails ${from} → ${to} (statements only)`);
    const r = await fetchStatementMails(from, to, { onProgress, signal });
    const known = new Set(syncState.pendingPdfs.map((p) => p.sha));
    let queued = 0;
    for (const p of r.pdfs) {
      if (known.has(p.sha)) continue;
      syncState.pendingPdfs.push(p);
      queued++;
    }
    log(`${r.emails} statement emails; ${queued} new PDFs queued, ${r.alreadyImported} already imported`);
    syncState.summary = { statement_emails: r.emails, queued, already_imported: r.alreadyImported };
    await importPending({ signal });
    const rehomed = await rehomeUnmatched();
    if (rehomed) log(`${rehomed} alerts attached to accounts learned from statements`);
    if (syncState.pendingPdfs.length) log(`${syncState.pendingPdfs.length} PDF${syncState.pendingPdfs.length > 1 ? 's' : ''} still waiting for a password or an account (see below)`);
    await categorizeAll(undefined, signal).catch((err) => log(`categorize: ${String((err as Error).message)}`));
    syncState.phase = 'done';
    log(`Done in ${Math.round((Date.now() - syncState.startedAt) / 1000)}s using ${usage.calls - syncState.llmCallsAtStart} AI calls`);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      syncState.phase = 'stopped';
      log('Stopped.');
    } else {
      syncState.error = String((err as Error).message ?? err);
      syncState.phase = 'error';
      log(`✖ ${syncState.error}`);
    }
  } finally {
    syncState.running = false;
    syncState.progress = null;
    controller = null;
    emit();
    db.notify();
  }
}

/** Retry one queued PDF with a password / account chosen by the user. */
export async function retryPdf(sha: string, opts: { password?: string; rememberFor?: string; accountId?: string }): Promise<ImportOutcome> {
  const pdf = syncState.pendingPdfs.find((p) => p.sha === sha);
  if (!pdf) throw new Error('PDF no longer queued');
  if (opts.accountId) pdf.accountGuess = opts.accountId;
  const res = await importStatement(pdf, { password: opts.password ?? null, rememberFor: opts.rememberFor ?? null });
  applyOutcome(pdf, res);
  if (res.status === 'imported') {
    // A password that just worked is probably the same for that account's other queued statements: sweep them.
    if (syncState.pendingPdfs.length) await importPending();
    await rehomeUnmatched();
    await categorizeAll().catch((err) => log(`categorize: ${String(err)}`));
    db.notify();
  }
  return res;
}

/** After a password is saved on an account: try every waiting PDF with it, no sync needed. */
export async function importWithNewPassword(): Promise<{ imported: number; remaining: number }> {
  loadPendingFromSheet();
  const before = syncState.pendingPdfs.length;
  if (!before) return { imported: 0, remaining: 0 };
  await importPending();
  const remaining = syncState.pendingPdfs.length;
  if (before - remaining > 0) await categorizeAll().catch(() => {});
  db.notify();
  return { imported: before - remaining, remaining };
}

/** A PDF the user picked from their phone/computer. */
export async function queueLocalPdf(file: File): Promise<PendingPdf> {
  const data = new Uint8Array(await file.arrayBuffer());
  const { shaOf } = await import('./statements');
  const sha = await shaOf(data);
  const existing = syncState.pendingPdfs.find((p) => p.sha === sha);
  if (existing) return existing;
  const pdf: PendingPdf = { sha, filename: file.name, data, emailId: '', from: 'local file', subject: file.name, receivedAt: new Date().toISOString(), hint: null, accountGuess: '' };
  syncState.pendingPdfs.push(pdf);
  emit();
  return pdf;
}

export function dropPdf(sha: string): void {
  const pdf = syncState.pendingPdfs.find((p) => p.sha === sha);
  syncState.pendingPdfs = syncState.pendingPdfs.filter((p) => p.sha !== sha);
  if (pdf) void resolvePending(pdf);
  emit();
}

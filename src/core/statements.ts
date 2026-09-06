import { db, stamp, type Account, type Statement } from '../store/db';
import { generateJson } from '../llm/gemini';
import { statementSchema, type StatementExtract } from '../llm/schemas';
import { extractPdfText, PdfPasswordError } from './pdf';
import { reconcile, type IncomingTxn } from './reconcile';
import { addAccount, instKey, matchAccount } from './accounts';
import { parseAmountToPaise } from './money';
import { emailAddress, redactPii } from './text';
import { sha256HexAsync } from './hash';
import { settings, saveSettings } from '../store/local';
import { downloadAttachment } from '../google/gmail';
import { getCachedExtract, putCachedExtract } from '../store/mailcache';

export interface PendingPdf {
  /** stable id = sha256 of the bytes */
  sha: string;
  filename: string;
  /** absent when restored from the sheet — re-downloaded from Gmail on demand */
  data?: Uint8Array;
  attachmentId?: string;
  emailId: string;
  from: string;
  subject: string;
  receivedAt: string;
  hint: string | null;
  /** account we think it belongs to (from the sender) — may be empty */
  accountGuess: string;
  lastError?: string;
}

export type ImportOutcome =
  | { status: 'imported'; statement: Statement; inserted: number; matched: number; review: number; createdAccount?: string }
  | { status: 'already_imported' }
  | { status: 'ignored'; reason: string }
  | { status: 'needs_password'; hint: string | null }
  | { status: 'needs_account'; hint: string; institution: string }
  | { status: 'failed'; reason: string };

export async function shaOf(data: Uint8Array): Promise<string> {
  return sha256HexAsync(data);
}

/**
 * Try every password we know (device store) plus an explicit one. The account
 * whose password opens the file is a strong ownership hint.
 */
async function openPdf(data: Uint8Array, explicit?: string | null): Promise<{ text: string; account: Account | null }> {
  try {
    return { text: await extractPdfText(data, null), account: null };
  } catch (err) {
    if (!(err instanceof PdfPasswordError)) throw err;
  }
  const tried = new Set<string>();
  const candidates: Array<{ pw: string; account: Account | null }> = [];
  if (explicit) candidates.push({ pw: explicit, account: null });
  for (const [accId, pw] of Object.entries(settings().passwords)) {
    if (pw) candidates.push({ pw, account: db.accounts.get(accId) ?? null });
  }
  for (const c of candidates) {
    if (tried.has(c.pw)) continue;
    tried.add(c.pw);
    try {
      return { text: await extractPdfText(data, c.pw), account: c.account };
    } catch (err) {
      if (!(err instanceof PdfPasswordError)) throw err;
    }
  }
  throw new PdfPasswordError();
}

/**
 * Idempotent statement import: sha gate → open → LLM extraction → validate →
 * reconcile → statements row. `force` re-imports a file that was imported
 * before (old rows from it are superseded first).
 */
export async function importStatement(
  pdf: PendingPdf,
  opts: { password?: string | null; rememberFor?: string | null; force?: boolean; signal?: AbortSignal } = {},
): Promise<ImportOutcome> {
  const existing = db.statements.get(pdf.sha);
  if (existing && existing.status !== 'failed' && !opts.force) return { status: 'already_imported' };
  if (existing && opts.force) {
    for (const t of db.transactions.rows) {
      if (t.statement_id === pdf.sha && t.source === 'statement') db.update(db.transactions, t.id, { status: 'superseded' });
      else if (t.statement_id === pdf.sha) db.update(db.transactions, t.id, { status: 'provisional', statement_id: '' });
    }
    db.update(db.statements, pdf.sha, { status: 'superseded' });
    await db.flush();
  }

  if (!pdf.data) {
    if (!pdf.emailId || !pdf.attachmentId) return { status: 'failed', reason: 'PDF bytes are gone and there is no email to re-download from' };
    try {
      pdf.data = await downloadAttachment(pdf.emailId, pdf.attachmentId);
    } catch (err) {
      return { status: 'failed', reason: `could not re-download from Gmail: ${String((err as Error).message)}` };
    }
  }
  let text: string;
  let passwordAccount: Account | null;
  try {
    ({ text, account: passwordAccount } = await openPdf(pdf.data, opts.password));
  } catch (err) {
    if (err instanceof PdfPasswordError) return { status: 'needs_password', hint: pdf.hint };
    return { status: 'failed', reason: String(err) };
  }

  let extract: StatementExtract;
  const cacheKey = `stmt:${pdf.sha}`;
  const cachedExtract = await getCachedExtract<StatementExtract>(cacheKey);
  if (cachedExtract) extract = cachedExtract;
  else
  try {
    extract = await generateJson<StatementExtract>(
      statementSchema,
      'Extract this Indian bank or credit-card statement into structured form. ' +
        'Copy amounts EXACTLY as printed (never compute). Every transaction row must use its OWN printed date converted to YYYY-MM-DD ' +
        '(statements print DD-MM-YYYY or DD/MM/YY) — never reuse the statement period dates for rows. ' +
        'Include EVERY posted row, including small fee, tax, GST, markup, interest and charge lines — they are transactions. ' +
        'Skip summary/total lines, opening balance and reward-point lines. If this document is not a bank/card statement (receipt, invoice, broker ledger, insurance) set statement_kind=not_a_statement.\n\n' +
        trimStatementText(redactPii(text)),
      { tier: 'reasoning', signal: opts.signal, label: 'statement' },
    );
  } catch (err) {
    return { status: 'failed', reason: `AI extraction failed: ${String(err)}` };
  }
  if (!cachedExtract) void putCachedExtract(cacheKey, extract);
  if (extract.statement_kind === 'not_a_statement' || (extract.transactions.length < 2 && !extract.total_due)) {
    return { status: 'ignored', reason: 'not a bank/card statement' };
  }

  if (BROKER_RE.test(`${extract.institution} ${extract.account_hint} ${pdf.subject} ${pdf.filename}`)) {
    return { status: 'ignored', reason: 'broker / mutual fund / NPS document, not a bank statement' };
  }
  const hint = `${extract.institution} ${extract.account_hint}`.trim();
  const last4 = extract.account_hint.match(/\d{4,}/g)?.map((d) => d.slice(-4)) ?? [];
  // The password that opened the file is only an ownership hint when the institution and kind agree —
  // people reuse one password (DOB…) across banks.
  const sameInst = (a: Account | null) => !!a && (!extract.institution || instKey(a.institution) === instKey(extract.institution)) && a.kind === extract.statement_kind;
  let account = matchAccount(hint, extract.statement_kind) ?? (sameInst(passwordAccount) ? passwordAccount : null);
  if (!account && pdf.accountGuess) {
    const g = db.accounts.get(pdf.accountGuess) ?? null;
    if (sameInst(g)) account = g;
  }
  let createdAccount: string | undefined;
  if (!account && extract.institution && (last4.length || extract.transactions.length >= 3)) {
    // A statement is authoritative: it names the institution and the masked number. Create the account.
    account = await addAccount({ kind: extract.statement_kind, institution: extract.institution, account_ref: last4.map((l) => `XX${l}`).join(' / '), statement_sender: emailAddress(pdf.from) });
    createdAccount = account.display_name;
  }
  if (!account) return { status: 'needs_account', hint, institution: extract.institution };

  // Remember the password on this device only if asked.
  if (opts.password && opts.rememberFor) {
    saveSettings({ passwords: { ...settings().passwords, [opts.rememberFor]: opts.password } });
  }
  // Learn masked numbers we haven't seen for this account.
  const newRefs = (extract.account_hint.match(/\d{4,}/g) ?? []).map((d) => d.slice(-4)).filter((l4) => !account.account_ref.includes(l4));
  if (newRefs.length && account.account_ref) db.update(db.accounts, account.id, { account_ref: `${account.account_ref} / ${newRefs.map((r) => `XX${r}`).join(' / ')}` });
  else if (newRefs.length) db.update(db.accounts, account.id, { account_ref: newRefs.map((r) => `XX${r}`).join(' / ') });

  const txns: IncomingTxn[] = [];
  const bad: string[] = [];
  for (const t of extract.transactions) {
    try {
      txns.push({ postedAt: t.date, amountPaise: Math.abs(parseAmountToPaise(t.amount)), direction: t.direction, narration: t.narration, refNo: t.ref_no || null });
    } catch {
      bad.push(`${t.date} ${t.narration}: "${t.amount}"`);
    }
  }
  const warnings: string[] = bad.length ? [`${bad.length} rows with unparseable amounts skipped`] : [];
  const check = (dir: 'debit' | 'credit', printed: string) => {
    if (!printed) return;
    try {
      const expected = Math.abs(parseAmountToPaise(printed));
      const actual = txns.filter((t) => t.direction === dir).reduce((s, t) => s + t.amountPaise, 0);
      if (expected !== actual) warnings.push(`${dir} total mismatch: statement says ${expected / 100}, extracted ${actual / 100}`);
    } catch {
      /* unparseable printed total — ignore */
    }
  };
  check('debit', extract.total_debits);
  check('credit', extract.total_credits);

  const period = { start: extract.period_start || null, end: extract.period_end || null };
  const result = await reconcile(account.id, pdf.sha, 'statement', txns, period);
  const toPaise = (s: string) => {
    try {
      return s ? Math.abs(parseAmountToPaise(s)) : 0;
    } catch {
      return 0;
    }
  };
  const statement: Statement = {
    id: pdf.sha,
    account_id: account.id,
    kind: extract.statement_kind,
    period_start: extract.period_start,
    period_end: extract.period_end || pdf.receivedAt.slice(0, 10),
    txn_count: result.total,
    inserted: result.inserted,
    matched: result.matchedExact + result.matchedFuzzy,
    total_due_paise: extract.statement_kind === 'credit_card' ? toPaise(extract.total_due) : 0,
    due_date: extract.statement_kind === 'credit_card' ? extract.due_date : '',
    source: pdf.filename,
    email_id: pdf.emailId,
    status: warnings.length ? 'needs_review' : 'imported',
    notes: warnings.join('; '),
    imported_at: stamp(),
  };
  if (db.statements.has(pdf.sha)) {
    db.update(db.statements, pdf.sha, statement);
    await db.flush();
  } else {
    await db.append(db.statements, [statement]);
  }
  return { status: 'imported', statement, inserted: result.inserted, matched: statement.matched, review: result.flaggedForReview, ...(createdAccount ? { createdAccount } : {}) };
}

/**
 * Statements are mostly boilerplate (terms, offers, footers). Keep the header
 * region and every line that looks like a transaction, a date or a total —
 * typically a third of the text, and a third of the model cost.
 */
export function trimStatementText(text: string): string {
  const lines = text.split('\n');
  const keep: string[] = [];
  const DATE = /\d{1,2}[-/ .][A-Za-z0-9]{2,3}[-/ .]\d{2,4}|\d{4}-\d{2}-\d{2}/;
  const AMOUNT = /\d[\d,]*\.\d{2}\b/;
  const KEY = /\b(total|due|balance|limit|period|statement|account|card|from|to|opening|closing|summary|credit|debit|payment|purchase|withdrawal|deposit|interest|charges|gst|markup|fee)\b/i;
  lines.forEach((l, i) => {
    const s = l.trim();
    if (!s) return;
    if (i < 60 || DATE.test(s) || AMOUNT.test(s) || (KEY.test(s) && s.length < 160)) keep.push(s);
  });
  const out = keep.join('\n');
  return out.length > 4000 ? out.slice(0, 90_000) : text.slice(0, 90_000);
}

const BROKER_RE = /\b(zerodha|kite|coin|groww|upstox|angel ?one|indmoney|cdsl|nsdl|cams|kfintech|karvy|protean|nps|cra\b|demat|holding statement|consolidated account statement|mutual fund|folio|sip\b|ppf|epf|epfo|insurance|policy)\b/i;

/** Lightweight bill row from an email body (no PDF) so due dates work. */
export async function recordBillNotice(
  emailId: string,
  subject: string,
  bill: { card_hint: string; total_due: string; min_due: string; due_date: string; statement_date: string },
): Promise<boolean> {
  if (!bill.total_due && !bill.due_date) return false;
  const account = matchAccount(bill.card_hint, 'credit_card');
  if (!account || account.kind !== 'credit_card') return false;
  const id = `bill_${emailId}`;
  if (db.statements.has(id)) return true;
  let total = 0;
  try {
    total = bill.total_due ? Math.abs(parseAmountToPaise(bill.total_due)) : 0;
  } catch {
    /* ignore */
  }
  const row: Statement = {
      id,
      account_id: account.id,
      kind: 'credit_card',
      period_start: '',
      period_end: bill.statement_date,
      txn_count: 0,
      inserted: 0,
      matched: 0,
      total_due_paise: total,
      due_date: bill.due_date,
      source: subject.slice(0, 80),
      email_id: emailId,
      status: 'bill_only',
      notes: '',
      imported_at: stamp(),
    };
  await db.append(db.statements, [row]);
  return true;
}

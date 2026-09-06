/**
 * "Other sources": any Google Sheet the user points us at (an expense tracker,
 * a bank CSV pasted into a sheet, a Splitwise export). Gemini works out the
 * column mapping once; rows are then imported deterministically and deduped
 * through the same reconcile path as statements.
 */
import { getSpreadsheet, parseSpreadsheetId, readRange, type Cell } from '../google/sheets';
import { generateJson } from '../llm/gemini';
import { rowsExtractSchema, sheetMappingSchema, SPEND_CATEGORIES, type RowsExtract, type SheetMapping } from '../llm/schemas';
import { db, newId, stamp, type Source } from '../store/db';
import { parseLooseDate } from './dates';
import { parseAmountToPaise } from './money';
import { reconcile, type IncomingTxn } from './reconcile';
import { chunk } from './pool';

export async function listTabs(input: string): Promise<{ id: string; title: string; tabs: string[] }> {
  const id = parseSpreadsheetId(input);
  const info = await getSpreadsheet(id);
  return { id, title: info.title, tabs: info.sheets.map((s) => s.title) };
}

export async function previewRows(spreadsheetId: string, tab: string, n = 25): Promise<Cell[][]> {
  return readRange(spreadsheetId, `${tab}!A1:Z${n}`);
}

export async function proposeMapping(rows: Cell[][]): Promise<SheetMapping> {
  const listing = rows.map((r, i) => `row ${i + 1}: ${r.map((c) => JSON.stringify(c ?? '')).join(' | ')}`).join('\n');
  return generateJson<SheetMapping>(
    sheetMappingSchema,
    `Here are the first rows of a spreadsheet tab (1-based row and column numbers). Work out how to read it as a list of money transactions.\n\n${listing}`,
    { tier: 'reasoning' },
  );
}

export interface RowParseResult {
  txns: IncomingTxn[];
  failedRows: number[];
}

const toNum = (c: Cell): number | null => {
  if (c === null || c === undefined || c === '') return null;
  if (typeof c === 'number') return Math.round(c * 100);
  if (typeof c === 'boolean') return null;
  try {
    return parseAmountToPaise(String(c));
  } catch {
    return null;
  }
};

/** Deterministic row → transaction using the confirmed mapping. Rows it can't read are returned for the AI fallback. */
export function applyMapping(rows: Cell[][], m: SheetMapping, startRow = 1): RowParseResult {
  const txns: IncomingTxn[] = [];
  const failedRows: number[] = [];
  const debitWords = m.debit_words.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const cell = (r: Cell[], col: number): Cell => (col > 0 ? (r[col - 1] ?? '') : '');
  const catMap = new Map(SPEND_CATEGORIES.map((c) => [c.replace(/_/g, ''), c]));
  for (let i = 0; i < rows.length; i++) {
    const rowNo = startRow + i;
    if (rowNo < m.first_data_row) continue;
    const r = rows[i]!;
    if (r.every((c) => c === '' || c == null)) continue;
    const dateRaw = cell(r, m.date_col);
    const date = typeof dateRaw === 'number' ? parseLooseDate(dateRaw) : parseLooseDate(String(dateRaw), m.date_day_first);
    let amount: number | null = null;
    let direction: 'debit' | 'credit' | null = null;
    if (m.amount_mode === 'debit_credit_cols') {
      const d = toNum(cell(r, m.debit_col));
      const c = toNum(cell(r, m.credit_col));
      if (d) [amount, direction] = [Math.abs(d), 'debit'];
      else if (c) [amount, direction] = [Math.abs(c), 'credit'];
    } else {
      const raw = cell(r, m.amount_col);
      const rawStr = String(raw ?? '');
      const a = toNum(raw);
      if (a !== null) {
        amount = Math.abs(a);
        if (m.amount_mode === 'single_with_direction_col') {
          const dv = String(cell(r, m.direction_col) ?? '').toLowerCase().trim();
          direction = debitWords.some((w) => dv.includes(w)) ? 'debit' : 'credit';
        } else if (/\bdr\b/i.test(rawStr)) direction = 'debit';
        else if (/\bcr\b/i.test(rawStr)) direction = 'credit';
        else direction = (a < 0) !== m.positive_is_debit ? 'debit' : 'credit';
      }
    }
    if (!date || amount === null || !direction || amount === 0) {
      failedRows.push(rowNo);
      continue;
    }
    const narration = [cell(r, m.narration_col), m.account_col ? cell(r, m.account_col) : ''].map((c) => String(c ?? '').trim()).filter(Boolean).join(' · ') || `row ${rowNo}`;
    const catRaw = String(cell(r, m.category_col) ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const category = catRaw ? catMap.get(catRaw) : undefined;
    txns.push({ postedAt: date, amountPaise: amount, direction, narration, refNo: String(cell(r, m.ref_col) ?? '').trim() || null, ...(category ? { category, categorizedBy: 'sheet' as const } : {}) });
  }
  return { txns, failedRows };
}

/** AI fallback for rows the mapping couldn't read (free-text expense logs etc.). */
export async function aiParseRows(rows: Array<{ rowNo: number; cells: Cell[] }>, signal?: AbortSignal): Promise<IncomingTxn[]> {
  const out: IncomingTxn[] = [];
  for (const batch of chunk(rows, 60)) {
    const listing = batch.map((r) => `row ${r.rowNo}: ${r.cells.map((c) => String(c ?? '')).join(' | ')}`).join('\n');
    const r = await generateJson<RowsExtract>(
      rowsExtractSchema,
      `Each line is a row from a personal money-tracking spreadsheet in India. Extract one transaction per row that describes money moving; skip headers, totals and blank rows. Dates are DD/MM unless clearly otherwise.\n\n${listing}`,
      { tier: 'reasoning', signal },
    );
    for (const t of r.transactions) {
      try {
        out.push({ postedAt: t.date, amountPaise: Math.abs(parseAmountToPaise(t.amount)), direction: t.direction, narration: t.narration || `row ${t.row}`, refNo: t.ref_no || null });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

export interface SourceImportResult {
  read: number;
  parsed: number;
  aiParsed: number;
  inserted: number;
  matched: number;
}

/** Full import (or re-import) of a configured source tab into an account. */
export async function importSource(src: Source, opts: { useAiFallback?: boolean; onProgress?: (msg: string) => void; signal?: AbortSignal } = {}): Promise<SourceImportResult> {
  const p = opts.onProgress ?? (() => {});
  const mapping = JSON.parse(src.mapping_json) as SheetMapping;
  p('Reading rows…');
  const rows = await readRange(src.spreadsheet_id, `${src.sheet_name}!A1:Z100000`);
  const { txns, failedRows } = applyMapping(rows, mapping);
  let aiParsed = 0;
  if (failedRows.length && opts.useAiFallback) {
    p(`AI reading ${failedRows.length} unreadable rows…`);
    const extra = await aiParseRows(failedRows.map((rowNo) => ({ rowNo, cells: rows[rowNo - 1] ?? [] })), opts.signal);
    aiParsed = extra.length;
    txns.push(...extra);
  }
  p(`Reconciling ${txns.length} rows…`);
  const dates = txns.map((t) => t.postedAt).sort();
  const result = await reconcile(src.account_id, `src:${src.id}`, 'sheet', txns, { start: null, end: null });
  db.update(db.sources, src.id, { rows_imported: txns.length, last_imported_at: stamp() });
  await db.flush();
  void dates;
  return { read: rows.length, parsed: txns.length - aiParsed, aiParsed, inserted: result.inserted, matched: result.matchedExact + result.matchedFuzzy };
}

export async function addSource(a: { spreadsheet_id: string; sheet_name: string; label: string; account_id: string; mapping: SheetMapping }): Promise<Source> {
  const src: Source = {
    id: newId('src'),
    spreadsheet_id: a.spreadsheet_id,
    sheet_name: a.sheet_name,
    label: a.label,
    account_id: a.account_id,
    mapping_json: JSON.stringify(a.mapping),
    rows_imported: 0,
    last_imported_at: '',
    created_at: stamp(),
  };
  await db.append(db.sources, [src]);
  return src;
}

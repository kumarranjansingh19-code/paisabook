/**
 * The Google Sheet is the database. Each tab is a table with a header row;
 * rows are only ever appended or updated in place (never deleted), so the
 * sheet row number of a record is stable and doubles as its write address.
 * Everything is mirrored in memory for the dashboard; updates are queued and
 * flushed in one batchUpdate call (Sheets quotas are per request).
 */
import { addTabs, appendRows, batchRead, batchWrite, columnLetter, createSpreadsheet, getSpreadsheet, styleHeader, type Cell } from '../google/sheets';
import { settings, saveSettings } from './local';
import { nowIso } from '../core/dates';

export type Direction = 'debit' | 'credit';
export type AccountKind = 'bank' | 'credit_card' | 'cash' | 'wallet' | 'other';

export interface Account {
  id: string;
  kind: AccountKind;
  institution: string;
  display_name: string;
  /** masked numbers seen for this account, e.g. "XX1234 / XX5678" */
  account_ref: string;
  statement_sender: string;
  password_hint: string;
  is_active: boolean;
  created_at: string;
}

export type TxnStatus = 'provisional' | 'confirmed' | 'needs_review' | 'superseded' | 'unmatched';
export type TxnSource = 'email_alert' | 'statement' | 'manual' | 'sheet';

export interface Transaction {
  id: string; // fingerprint-derived, unique
  account_id: string; // '' when unmatched
  account_hint: string;
  posted_at: string; // YYYY-MM-DD
  amount_paise: number;
  direction: Direction;
  narration: string;
  ref_no: string;
  category: string; // '' = uncategorized
  merchant: string;
  categorized_by: '' | 'rule' | 'llm' | 'user' | 'sheet';
  source: TxnSource;
  status: TxnStatus;
  email_id: string;
  statement_id: string;
  created_at: string;
}

export interface Statement {
  id: string; // sha256 of the file (or bill:<email id>)
  account_id: string;
  kind: 'bank' | 'credit_card';
  period_start: string;
  period_end: string;
  txn_count: number;
  inserted: number;
  matched: number;
  total_due_paise: number;
  due_date: string;
  source: string; // filename / email subject
  email_id: string;
  status: 'imported' | 'needs_review' | 'failed' | 'bill_only' | 'superseded';
  notes: string;
  imported_at: string;
}

export interface Rule {
  id: string;
  pattern: string; // lowercase fragment, matched against ruleNorm(narration)
  category: string;
  merchant: string;
  source: 'user' | 'llm';
  created_at: string;
}

export interface EmailLog {
  id: string; // gmail message id
  received_at: string;
  from: string;
  subject: string;
  kind: string; // classification / event kind
  outcome: string; // what we did with it
  processed_at: string;
}

export interface Setting {
  key: string;
  value: string;
}

export interface Source {
  id: string;
  spreadsheet_id: string;
  sheet_name: string;
  label: string;
  account_id: string;
  mapping_json: string;
  rows_imported: number;
  last_imported_at: string;
  created_at: string;
}

export interface FamilyMember {
  id: string;
  name: string;
  relation: string;
  created_at: string;
}

type Row = Record<string, Cell>;

interface TableDef<T extends object> {
  name: string;
  columns: Array<keyof T & string>;
  numeric?: Array<keyof T & string>;
  boolean?: Array<keyof T & string>;
}

export const TABLES = {
  accounts: {
    name: 'accounts',
    columns: ['id', 'kind', 'institution', 'display_name', 'account_ref', 'statement_sender', 'password_hint', 'is_active', 'created_at'],
    boolean: ['is_active'],
  } satisfies TableDef<Account>,
  transactions: {
    name: 'transactions',
    columns: ['id', 'account_id', 'account_hint', 'posted_at', 'amount_paise', 'direction', 'narration', 'ref_no', 'category', 'merchant', 'categorized_by', 'source', 'status', 'email_id', 'statement_id', 'created_at'],
    numeric: ['amount_paise'],
  } satisfies TableDef<Transaction>,
  statements: {
    name: 'statements',
    columns: ['id', 'account_id', 'kind', 'period_start', 'period_end', 'txn_count', 'inserted', 'matched', 'total_due_paise', 'due_date', 'source', 'email_id', 'status', 'notes', 'imported_at'],
    numeric: ['txn_count', 'inserted', 'matched', 'total_due_paise'],
  } satisfies TableDef<Statement>,
  rules: { name: 'rules', columns: ['id', 'pattern', 'category', 'merchant', 'source', 'created_at'] } satisfies TableDef<Rule>,
  emails: { name: 'emails', columns: ['id', 'received_at', 'from', 'subject', 'kind', 'outcome', 'processed_at'] } satisfies TableDef<EmailLog>,
  settings: { name: 'settings', columns: ['key', 'value'] } satisfies TableDef<Setting>,
  sources: {
    name: 'sources',
    columns: ['id', 'spreadsheet_id', 'sheet_name', 'label', 'account_id', 'mapping_json', 'rows_imported', 'last_imported_at', 'created_at'],
    numeric: ['rows_imported'],
  } satisfies TableDef<Source>,
  family: { name: 'family', columns: ['id', 'name', 'relation', 'created_at'] } satisfies TableDef<FamilyMember>,
};
export type TableName = keyof typeof TABLES;
export const TAB_NAMES = Object.values(TABLES).map((t) => t.name);

export class Table<T extends object> {
  rows: T[] = [];
  private byId = new Map<string, T>();
  private rowNo = new Map<string, number>(); // id -> 1-based sheet row
  constructor(
    public def: TableDef<T>,
    private idKey: keyof T & string,
  ) {}

  load(values: Cell[][]): void {
    this.rows = [];
    this.byId.clear();
    this.rowNo.clear();
    const header = (values[0] ?? []).map((c) => String(c ?? ''));
    const colIdx = this.def.columns.map((c) => header.indexOf(c));
    for (let r = 1; r < values.length; r++) {
      const raw = values[r] ?? [];
      if (raw.every((c) => c === '' || c == null)) continue;
      const obj = {} as T;
      this.def.columns.forEach((col, i) => {
        const idx = colIdx[i]!;
        let v: Cell = idx >= 0 ? (raw[idx] ?? '') : '';
        if (this.def.numeric?.includes(col)) v = Number(v ?? 0) || 0;
        else if (this.def.boolean?.includes(col)) v = v === true || v === 'TRUE' || v === 'true' || v === 1;
        else v = v == null ? '' : String(v);
        (obj as unknown as Row)[col] = v;
      });
      const id = String((obj as unknown as Row)[this.idKey]);
      if (!id) continue;
      this.rows.push(obj);
      this.byId.set(id, obj);
      this.rowNo.set(id, r + 1);
    }
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  rowNumber(id: string): number | undefined {
    return this.rowNo.get(id);
  }
  idOf(rec: T): string {
    return String((rec as unknown as Row)[this.idKey]);
  }
  /** Register appended records (call after the append succeeded). */
  registerAppended(records: T[], firstRow: number): void {
    records.forEach((rec, i) => {
      const id = this.idOf(rec);
      this.rows.push(rec);
      this.byId.set(id, rec);
      this.rowNo.set(id, firstRow + i);
    });
  }
  nextRow(): number {
    let max = 1;
    for (const r of this.rowNo.values()) if (r > max) max = r;
    return max + 1;
  }
}

export class SheetDb {
  spreadsheetId = '';
  loaded = false;
  accounts = new Table<Account>(TABLES.accounts, 'id');
  transactions = new Table<Transaction>(TABLES.transactions, 'id');
  statements = new Table<Statement>(TABLES.statements, 'id');
  rules = new Table<Rule>(TABLES.rules, 'id');
  emails = new Table<EmailLog>(TABLES.emails, 'id');
  settingsTable = new Table<Setting>(TABLES.settings, 'key');
  sources = new Table<Source>(TABLES.sources, 'id');
  family = new Table<FamilyMember>(TABLES.family, 'id');
  private pending: Array<{ range: string; values: Cell[][] }> = [];
  private listeners = new Set<() => void>();
  private headerCache: Record<string, string[]> = {};

  private tables(): Array<Table<Row>> {
    return [this.accounts, this.transactions, this.statements, this.rules, this.emails, this.settingsTable, this.sources, this.family] as unknown as Array<Table<Row>>;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** Create a fresh workbook with all tabs and headers. */
  async create(title = 'PaisaBook Ledger'): Promise<string> {
    const info = await createSpreadsheet(title, TAB_NAMES);
    this.spreadsheetId = info.spreadsheetId;
    await this.ensureHeaders(info.sheets.map((s) => s.title));
    for (const s of info.sheets) await styleHeader(this.spreadsheetId, s.sheetId).catch(() => {});
    saveSettings({ spreadsheetId: this.spreadsheetId });
    await this.load();
    return this.spreadsheetId;
  }

  /** Connect to an existing workbook, adding any missing tabs/headers (also upgrades older layouts). */
  async connect(spreadsheetId: string): Promise<void> {
    const info = await getSpreadsheet(spreadsheetId);
    this.spreadsheetId = spreadsheetId;
    const existing = info.sheets.map((s) => s.title);
    const missing = TAB_NAMES.filter((t) => !existing.includes(t));
    await addTabs(spreadsheetId, missing);
    await this.ensureHeaders(existing);
    saveSettings({ spreadsheetId });
    await this.load();
  }

  private async ensureHeaders(existingTabs: string[]): Promise<void> {
    const ranges = TAB_NAMES.map((t) => `${t}!1:1`);
    const current = existingTabs.length ? await batchRead(this.spreadsheetId, ranges).catch(() => ({}) as Record<string, Cell[][]>) : {};
    const writes: Array<{ range: string; values: Cell[][] }> = [];
    for (const def of Object.values(TABLES)) {
      const have = (current[`${def.name}!1:1`]?.[0] ?? []).map(String);
      const want = def.columns as string[];
      // Keep any user-added columns; append ours that are missing. Never reorder existing ones.
      const merged = [...have.filter((h) => h), ...want.filter((w) => !have.includes(w))];
      if (merged.join('') !== have.join('')) {
        writes.push({ range: `${def.name}!A1:${columnLetter(merged.length)}1`, values: [merged] });
      }
    }
    if (writes.length) await batchWrite(this.spreadsheetId, writes);
  }

  async load(): Promise<void> {
    const id = this.spreadsheetId || settings().spreadsheetId;
    if (!id) throw new Error('No spreadsheet connected');
    this.spreadsheetId = id;
    const ranges = TAB_NAMES.map((t) => `${t}!A:${columnLetter(40)}`);
    const data = await batchRead(id, ranges);
    // Column order in the sheet may differ from ours (older layouts, user edits): load by header name.
    this.headerCache = {};
    for (const t of this.tables()) {
      const values = data[`${t.def.name}!A:${columnLetter(40)}`] ?? [];
      t.load(values);
      this.headerCache[t.def.name] = (values[0] ?? []).map(String);
    }
    this.loaded = true;
    this.notify();
  }

  private colOf(table: string, col: string): number {
    const idx = this.headerCache[table]?.indexOf(col) ?? -1;
    return idx >= 0 ? idx + 1 : -1;
  }

  /** Cells ordered by the sheet's actual header, so appended rows land under the right columns. */
  private cellsFor<T extends object>(t: Table<T>, rec: T): Cell[] {
    const header = this.headerCache[t.def.name]?.length ? this.headerCache[t.def.name]! : (t.def.columns as string[]);
    return header.map((h) => {
      const v = (rec as unknown as Row)[h];
      if (v === undefined || v === null) return '';
      return typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v;
    });
  }

  private appendChain: Promise<void> = Promise.resolve();

  /** Appends are serialized: two concurrent appends must not compute the same next row. */
  append<T extends object>(t: Table<T>, records: T[]): Promise<void> {
    const run = this.appendChain.then(() => this.appendNow(t, records));
    this.appendChain = run.catch(() => {});
    return run;
  }

  private async appendNow<T extends object>(t: Table<T>, records: T[]): Promise<void> {
    if (!records.length) return;
    const seen = new Set<string>();
    const fresh = records.filter((r) => {
      const id = t.idOf(r);
      if (t.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!fresh.length) return;
    const first = t.nextRow();
    // Append in chunks so one huge statement import can't exceed request limits.
    for (let i = 0; i < fresh.length; i += 500) {
      const slice = fresh.slice(i, i + 500);
      await appendRows(this.spreadsheetId, t.def.name, slice.map((r) => this.cellsFor(t, r)));
    }
    t.registerAppended(fresh, first);
    this.notify();
  }

  /** Patch fields on an existing record; the write is queued until flush(). */
  update<T extends object>(t: Table<T>, id: string, patch: Partial<T>): void {
    const rec = t.get(id);
    const row = t.rowNumber(id);
    if (!rec || !row) return;
    Object.assign(rec, patch);
    for (const [k, v] of Object.entries(patch)) {
      const c = this.colOf(t.def.name, k);
      if (c < 0) continue;
      const cell: Cell = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : ((v as Cell) ?? '');
      this.pending.push({ range: `${t.def.name}!${columnLetter(c)}${row}`, values: [[cell]] });
    }
  }

  async flush(): Promise<void> {
    if (!this.pending.length) {
      this.notify();
      return;
    }
    const batch = this.pending;
    this.pending = [];
    for (let i = 0; i < batch.length; i += 400) await batchWrite(this.spreadsheetId, batch.slice(i, i + 400));
    this.notify();
  }

  pendingCount(): number {
    return this.pending.length;
  }

  // convenience --------------------------------------------------------------
  getSetting(key: string): string {
    return this.settingsTable.get(key)?.value ?? '';
  }
  async setSetting(key: string, value: string): Promise<void> {
    if (this.settingsTable.has(key)) {
      this.update(this.settingsTable, key, { value });
      await this.flush();
    } else {
      await this.append(this.settingsTable, [{ key, value }]);
    }
  }

  activeAccounts(): Account[] {
    return this.accounts.rows.filter((a) => a.is_active);
  }
  /** Rows that count: not superseded, and not belonging to a hidden account. */
  liveTransactions(): Transaction[] {
    const hidden = new Set(this.accounts.rows.filter((a) => !a.is_active).map((a) => a.id));
    return this.transactions.rows.filter((t) => t.status !== 'superseded' && !(t.account_id && hidden.has(t.account_id)));
  }
  sheetUrl(): string {
    return `https://docs.google.com/spreadsheets/d/${this.spreadsheetId}`;
  }
}

export const db = new SheetDb();

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function stamp(): string {
  return nowIso();
}

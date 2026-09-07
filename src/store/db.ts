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
  /** add-on / supplementary cards billed to this account: "XX5678 (Priyanka) / XX9012" */
  addon_refs: string;
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
  /** queued / needs_password / needs_account = a PDF waiting for the user (persisted so a reload can't lose it) */
  status: 'imported' | 'needs_review' | 'failed' | 'bill_only' | 'superseded' | 'queued' | 'needs_password' | 'needs_account';
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

/**
 * Categories live in the sheet too. `kind` tells the dashboard how to treat
 * a category: spend (consumption), income, transfer (never spend or income),
 * investment (money kept, not spent), refund (a credit that reduces spend).
 */
export type CategoryKind = 'spend' | 'income' | 'transfer' | 'investment' | 'refund';
export interface Category {
  name: string; // the key used on transactions, e.g. "home_services"
  label: string; // shown in the UI
  kind: CategoryKind;
  description: string; // hint for the AI
  sort: number;
}

export const SEED_CATEGORIES: Category[] = [
  { name: 'groceries', label: 'Groceries', kind: 'spend', description: 'supermarkets, quick-commerce grocery, vegetables', sort: 10 },
  { name: 'dining', label: 'Dining', kind: 'spend', description: 'restaurants, food delivery, cafes', sort: 20 },
  { name: 'utilities', label: 'Utilities', kind: 'spend', description: 'electricity, water, gas, mobile, broadband, DTH', sort: 30 },
  { name: 'rent_housing', label: 'Rent / housing', kind: 'spend', description: 'rent, home loan interest, housing costs', sort: 40 },
  { name: 'society_maintenance', label: 'Society maintenance', kind: 'spend', description: 'apartment society dues', sort: 50 },
  { name: 'transport_fuel', label: 'Transport / fuel', kind: 'spend', description: 'fuel, cabs, metro, tolls, FASTag, parking', sort: 60 },
  { name: 'shopping', label: 'Shopping', kind: 'spend', description: 'online and offline retail, clothes, electronics', sort: 70 },
  { name: 'health_medical', label: 'Health / medical', kind: 'spend', description: 'doctors, pharmacy, diagnostics', sort: 80 },
  { name: 'home_services', label: 'Home services', kind: 'spend', description: 'maid, cook, cleaning, repairs, car wash', sort: 90 },
  { name: 'donation', label: 'Donation', kind: 'spend', description: 'charity, religious donations', sort: 100 },
  { name: 'insurance_premium', label: 'Insurance premium', kind: 'spend', description: 'health, term, vehicle insurance premiums', sort: 110 },
  { name: 'entertainment', label: 'Entertainment', kind: 'spend', description: 'streaming, movies, events, games', sort: 120 },
  { name: 'travel', label: 'Travel', kind: 'spend', description: 'flights, trains, hotels, holidays', sort: 130 },
  { name: 'education', label: 'Education', kind: 'spend', description: 'school, college fees, tuition', sort: 140 },
  { name: 'learning_development', label: 'Learning', kind: 'spend', description: 'courses, books, subscriptions for learning', sort: 150 },
  { name: 'emi_loan', label: 'EMI / loan', kind: 'spend', description: 'loan EMIs and repayments (not card bills)', sort: 160 },
  { name: 'fees_charges', label: 'Fees / charges', kind: 'spend', description: 'bank charges, GST on fees, markups, penalties', sort: 170 },
  { name: 'cash', label: 'Cash', kind: 'spend', description: 'ATM withdrawals and cash spending', sort: 180 },
  { name: 'other', label: 'Other', kind: 'spend', description: 'anything that fits nothing else', sort: 190 },
  { name: 'investment', label: 'Investment', kind: 'investment', description: 'transfers to broker/MF/PPF/NPS and capital coming back from them', sort: 200 },
  { name: 'cc_payment', label: 'Card bill payment', kind: 'transfer', description: "paying the user's own credit-card bill, and that credit on the card", sort: 300 },
  { name: 'self_transfer', label: 'Self transfer', kind: 'transfer', description: "moves between the user's own accounts", sort: 310 },
  { name: 'family_transfer', label: 'Family transfer', kind: 'transfer', description: 'money sent to family members', sort: 320 },
  { name: 'paid_for_others', label: 'Paid for others', kind: 'transfer', description: "amounts paid on someone else's behalf", sort: 330 },
  { name: 'received_for_others', label: 'Received for others', kind: 'transfer', description: 'their repayment of amounts paid for them', sort: 340 },
  { name: 'salary_income', label: 'Salary', kind: 'income', description: 'salary credits', sort: 400 },
  { name: 'dividend_income', label: 'Dividend / interest', kind: 'income', description: 'dividends, interest, SGB interest', sort: 410 },
  { name: 'refund', label: 'Refund', kind: 'refund', description: 'merchant refunds and reversals', sort: 500 },
];

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
    columns: ['id', 'kind', 'institution', 'display_name', 'account_ref', 'addon_refs', 'statement_sender', 'password_hint', 'is_active', 'created_at'],
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
  categories: { name: 'categories', columns: ['name', 'label', 'kind', 'description', 'sort'], numeric: ['sort'] } satisfies TableDef<Category>,
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
  categories = new Table<Category>(TABLES.categories, 'name');
  private pending: Array<{ range: string; values: Cell[][] }> = [];
  private listeners = new Set<() => void>();
  private headerCache: Record<string, string[]> = {};

  private tables(): Array<Table<Row>> {
    return [this.accounts, this.transactions, this.statements, this.rules, this.emails, this.settingsTable, this.sources, this.family, this.categories] as unknown as Array<Table<Row>>;
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
    let data: Record<string, Cell[][]>;
    try {
      data = await batchRead(id, ranges);
    } catch (err) {
      // A sheet made by an older build lacks a newer tab: add the missing tabs/headers once, then read again.
      if (!this.upgrading && /Unable to parse range|not found/i.test(String((err as Error).message))) {
        this.upgrading = true;
        try {
          await this.connect(id);
        } finally {
          this.upgrading = false;
        }
        return;
      }
      throw err;
    }
    // Column order in the sheet may differ from ours (older layouts, user edits): load by header name.
    this.headerCache = {};
    for (const t of this.tables()) {
      const values = data[`${t.def.name}!A:${columnLetter(40)}`] ?? [];
      t.load(values);
      this.headerCache[t.def.name] = (values[0] ?? []).map(String);
    }
    this.loaded = true;
    // First time: copy the built-in categories into the sheet so they can be edited and extended there.
    if (!this.categories.rows.length) await this.append(this.categories, SEED_CATEGORIES.map((c) => ({ ...c })));
    this.notify();
  }
  private upgrading = false;

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

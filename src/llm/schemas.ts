import type { JsonSchema } from './gemini';

const str = (description?: string): JsonSchema => ({ type: 'string', ...(description ? { description } : {}) });
const isoDate = (description: string): JsonSchema => str(`${description} — strictly YYYY-MM-DD`);
const isoDateOrEmpty = (description: string): JsonSchema => str(`${description} — YYYY-MM-DD or empty string`);

export const SPEND_CATEGORIES = [
  'groceries', 'dining', 'utilities', 'rent_housing', 'society_maintenance', 'transport_fuel', 'shopping',
  'health_medical', 'home_services', 'donation', 'insurance_premium', 'investment', 'entertainment', 'travel',
  'education', 'learning_development', 'emi_loan', 'cc_payment', 'self_transfer', 'family_transfer',
  'paid_for_others', 'received_for_others', 'salary_income', 'dividend_income', 'refund', 'fees_charges', 'cash', 'other',
] as const;
export type Category = (typeof SPEND_CATEGORIES)[number];

/** Categories that are transfers, never consumption or income. */
export const TRANSFER_CATEGORIES: ReadonlySet<string> = new Set(['cc_payment', 'self_transfer', 'family_transfer', 'paid_for_others', 'received_for_others']);
/** Credit categories that reduce spend (netted) rather than count as income. */
export const SPEND_NETTED: ReadonlySet<string> = new Set(['refund']);

/** One call per batch of candidate emails: classify AND extract the alert/bill in one go. */
export const emailBatchSchema: JsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'index of the email in the provided list' },
          kind: {
            type: 'string',
            enum: ['txn_alert', 'cc_statement', 'bank_statement', 'cc_bill_notice', 'other'],
            description:
              'txn_alert = a specific debit/credit with an amount on a bank account or card the user holds; cc_statement/bank_statement = a periodic statement delivered (usually PDF attached); cc_bill_notice = card bill summary in the body (total due, due date) without a PDF; other = OTP, promo, offer, reward, EMI marketing, balance summary, broker/MF/wallet mail',
          },
          txn: {
            type: 'object',
            description: 'filled only when kind = txn_alert',
            properties: {
              account_hint: str('bank/issuer name plus masked number as mentioned, e.g. "HDFC Bank XX1234" or "ICICI Credit Card XX5678"'),
              account_kind: { type: 'string', enum: ['bank', 'credit_card', 'unknown'] },
              date: isoDate('transaction date'),
              amount: str('amount exactly as written, e.g. "1,234.56"'),
              direction: { type: 'string', enum: ['debit', 'credit'] },
              narration: str('merchant / counterparty / description text'),
              ref_no: str('UPI or transaction reference number if present, else empty'),
            },
            required: ['account_hint', 'account_kind', 'date', 'amount', 'direction', 'narration', 'ref_no'],
          },
          bill: {
            type: 'object',
            description: 'filled only when kind = cc_bill_notice or cc_statement and the body states amounts',
            properties: {
              card_hint: str('issuer + masked card number, e.g. "Axis Bank XX8194"'),
              total_due: str('total amount due exactly as written, else empty'),
              min_due: str('minimum due as written, else empty'),
              due_date: isoDateOrEmpty('payment due date'),
              statement_date: isoDateOrEmpty('statement date / period end'),
            },
            required: ['card_hint', 'total_due', 'min_due', 'due_date', 'statement_date'],
          },
        },
        required: ['index', 'kind'],
      },
    },
  },
  required: ['results'],
};

export interface EmailBatchResult {
  results: Array<{
    index: number;
    kind: 'txn_alert' | 'cc_statement' | 'bank_statement' | 'cc_bill_notice' | 'other';
    txn?: { account_hint: string; account_kind: 'bank' | 'credit_card' | 'unknown'; date: string; amount: string; direction: 'debit' | 'credit'; narration: string; ref_no: string };
    bill?: { card_hint: string; total_due: string; min_due: string; due_date: string; statement_date: string };
  }>;
}

export const statementSchema: JsonSchema = {
  type: 'object',
  properties: {
    statement_kind: { type: 'string', enum: ['bank', 'credit_card', 'not_a_statement'] },
    institution: str('bank / card issuer name as printed'),
    account_hint: str('masked account/card number as printed, e.g. "XX1234" — plus name'),
    period_start: isoDateOrEmpty('statement period start'),
    period_end: isoDateOrEmpty('statement period end / statement date'),
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: isoDate("this row's own printed transaction date, converted (statements print DD-MM-YYYY or DD/MM/YY)"),
          amount: str('amount exactly as printed, e.g. "1,23,456.78"'),
          direction: { type: 'string', enum: ['debit', 'credit'] },
          narration: str('description as printed'),
          ref_no: str('reference / cheque / UPI number if printed, else empty'),
        },
        required: ['date', 'amount', 'direction', 'narration', 'ref_no'],
      },
    },
    total_debits: str('total debits/purchases as printed in the summary, else empty'),
    total_credits: str('total credits/payments as printed, else empty'),
    total_due: str('credit card: total amount due as printed; else empty'),
    min_due: str('credit card: minimum due as printed; else empty'),
    due_date: isoDateOrEmpty('credit card payment due date'),
  },
  required: ['statement_kind', 'institution', 'account_hint', 'period_start', 'period_end', 'transactions', 'total_debits', 'total_credits', 'total_due', 'min_due', 'due_date'],
};

export interface StatementExtract {
  statement_kind: 'bank' | 'credit_card' | 'not_a_statement';
  institution: string;
  account_hint: string;
  period_start: string;
  period_end: string;
  transactions: Array<{ date: string; amount: string; direction: 'debit' | 'credit'; narration: string; ref_no: string }>;
  total_debits: string;
  total_credits: string;
  total_due: string;
  min_due: string;
  due_date: string;
}

export const categorizationSchema: JsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: str('transaction id exactly as given'),
          category: { type: 'string', enum: [...SPEND_CATEGORIES] },
          merchant: str('normalized merchant / counterparty name (short, no bank codes), else empty'),
        },
        required: ['id', 'category', 'merchant'],
      },
    },
  },
  required: ['results'],
};
export interface CategorizationResult {
  results: Array<{ id: string; category: Category; merchant: string }>;
}

export const discoverySchema: JsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          is_account_email: { type: 'boolean', description: 'true only for alerts, statements, or bill notices from a bank account or credit card the user personally holds' },
          kind: { type: 'string', enum: ['bank', 'credit_card', 'none'] },
          institution: str('bank / issuer name, e.g. "HDFC Bank"; empty if none'),
          masked_number: str('masked account/card number as shown, e.g. "XX1234"; empty if absent'),
          is_statement_email: { type: 'boolean', description: 'true if this email delivers a periodic statement (usually a PDF)' },
        },
        required: ['index', 'is_account_email', 'kind', 'institution', 'masked_number', 'is_statement_email'],
      },
    },
  },
  required: ['results'],
};
export interface DiscoveryResult {
  results: Array<{ index: number; is_account_email: boolean; kind: 'bank' | 'credit_card' | 'none'; institution: string; masked_number: string; is_statement_email: boolean }>;
}

export const sheetMappingSchema: JsonSchema = {
  type: 'object',
  properties: {
    is_transaction_table: { type: 'boolean', description: 'false if the rows are not a list of money transactions' },
    header_row: { type: 'integer', description: '1-based row number holding the column headers; 0 if there is none' },
    first_data_row: { type: 'integer', description: '1-based row number of the first transaction row' },
    date_col: { type: 'integer', description: '1-based column number of the transaction date' },
    date_day_first: { type: 'boolean', description: 'true if dates read DD/MM (Indian), false if MM/DD' },
    narration_col: { type: 'integer', description: '1-based column with the description / merchant; 0 if none' },
    ref_col: { type: 'integer', description: '1-based column with a reference number; 0 if none' },
    amount_mode: {
      type: 'string',
      enum: ['single_signed', 'single_with_direction_col', 'debit_credit_cols'],
      description: 'single_signed = one amount column where negatives (or a Dr/Cr suffix) mark debits; single_with_direction_col = amount column plus a separate Dr/Cr or type column; debit_credit_cols = separate withdrawal and deposit columns',
    },
    amount_col: { type: 'integer', description: 'amount column (modes single_*); 0 otherwise' },
    direction_col: { type: 'integer', description: 'direction/type column (mode single_with_direction_col); 0 otherwise' },
    debit_col: { type: 'integer', description: 'withdrawal/debit column (mode debit_credit_cols); 0 otherwise' },
    credit_col: { type: 'integer', description: 'deposit/credit column (mode debit_credit_cols); 0 otherwise' },
    positive_is_debit: { type: 'boolean', description: 'single_signed: true if positive numbers are spends (expense trackers), false if positive = credit (bank exports)' },
    debit_words: str('for direction columns: comma-separated values meaning debit, e.g. "dr,debit,expense,withdrawal"'),
    account_col: { type: 'integer', description: '1-based column naming the account / card, 0 if none' },
    category_col: { type: 'integer', description: '1-based column with a category, 0 if none' },
    account_guess: str('what account these rows seem to belong to, e.g. "HDFC savings", "cash wallet", "Splitwise" — empty if unclear'),
    notes: str('one line on any quirk (e.g. amounts in thousands, dates as Excel serials)'),
  },
  required: ['is_transaction_table', 'header_row', 'first_data_row', 'date_col', 'date_day_first', 'narration_col', 'ref_col', 'amount_mode', 'amount_col', 'direction_col', 'debit_col', 'credit_col', 'positive_is_debit', 'debit_words', 'account_col', 'category_col', 'account_guess', 'notes'],
};
export interface SheetMapping {
  is_transaction_table: boolean;
  header_row: number;
  first_data_row: number;
  date_col: number;
  date_day_first: boolean;
  narration_col: number;
  ref_col: number;
  amount_mode: 'single_signed' | 'single_with_direction_col' | 'debit_credit_cols';
  amount_col: number;
  direction_col: number;
  debit_col: number;
  credit_col: number;
  positive_is_debit: boolean;
  debit_words: string;
  account_col: number;
  category_col: number;
  account_guess: string;
  notes: string;
}

export const rowsExtractSchema: JsonSchema = {
  type: 'object',
  properties: {
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          row: { type: 'integer', description: 'the source row number given' },
          date: isoDate('transaction date'),
          amount: str('amount as written'),
          direction: { type: 'string', enum: ['debit', 'credit'] },
          narration: str(''),
          ref_no: str('reference if any, else empty'),
        },
        required: ['row', 'date', 'amount', 'direction', 'narration', 'ref_no'],
      },
    },
  },
  required: ['transactions'],
};
export interface RowsExtract {
  transactions: Array<{ row: number; date: string; amount: string; direction: 'debit' | 'credit'; narration: string; ref_no: string }>;
}

export const ruleSuggestSchema: JsonSchema = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern_fragment: str('distinctive lowercase substring of the NARRATION with spaces/hyphens removed, min 5 chars, e.g. "swiggyinstamart" — never a generic word like "pay", "bank", "upi"'),
          category: { type: 'string', enum: [...SPEND_CATEGORIES] },
          merchant: str(''),
          reason: str('one short line'),
        },
        required: ['pattern_fragment', 'category', 'merchant', 'reason'],
      },
    },
  },
  required: ['suggestions'],
};
export interface RuleSuggestResult {
  suggestions: Array<{ pattern_fragment: string; category: Category; merchant: string; reason: string }>;
}

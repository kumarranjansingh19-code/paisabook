import { describe, expect, it } from 'vitest';
import { applyMapping } from '../src/core/sources';
import type { SheetMapping } from '../src/llm/schemas';

const base: SheetMapping = {
  is_transaction_table: true,
  header_row: 1,
  first_data_row: 2,
  date_col: 1,
  date_day_first: true,
  narration_col: 2,
  ref_col: 0,
  amount_mode: 'debit_credit_cols',
  amount_col: 0,
  direction_col: 0,
  debit_col: 3,
  credit_col: 4,
  positive_is_debit: false,
  debit_words: 'dr,debit',
  account_col: 0,
  category_col: 5,
  account_guess: '',
  notes: '',
};

describe('applyMapping', () => {
  it('reads debit/credit columns and categories', () => {
    const rows = [
      ['Date', 'Narration', 'Withdrawal', 'Deposit', 'Category'],
      ['01/08/2026', 'Swiggy', '450.00', '', 'Dining'],
      ['02/08/2026', 'Salary', '', '1,00,000', 'salary_income'],
      ['', '', '', '', ''],
      ['bad', 'row', 'x', '', ''],
    ];
    const r = applyMapping(rows, base);
    expect(r.txns).toHaveLength(2);
    expect(r.txns[0]).toMatchObject({ postedAt: '2026-08-01', amountPaise: 45000, direction: 'debit', narration: 'Swiggy', category: 'dining' });
    expect(r.txns[1]).toMatchObject({ postedAt: '2026-08-02', amountPaise: 10000000, direction: 'credit', category: 'salary_income' });
    expect(r.failedRows).toEqual([5]);
  });
  it('reads signed single columns (expense tracker style)', () => {
    const m: SheetMapping = { ...base, amount_mode: 'single_signed', amount_col: 3, debit_col: 0, credit_col: 0, positive_is_debit: true, category_col: 0 };
    const r = applyMapping([['d', 'n', 'amt'], ['5 Aug 2026', 'Cab', 250], ['6 Aug 2026', 'Refund', -100]], m);
    expect(r.txns.map((t) => t.direction)).toEqual(['debit', 'credit']);
  });
  it('reads a direction column', () => {
    const m: SheetMapping = { ...base, amount_mode: 'single_with_direction_col', amount_col: 3, direction_col: 4, debit_col: 0, credit_col: 0, category_col: 0 };
    const r = applyMapping([['d', 'n', 'amt', 'type'], ['2026-08-05', 'Cab', '250', 'DR'], ['2026-08-06', 'Interest', '10', 'CR']], m);
    expect(r.txns.map((t) => t.direction)).toEqual(['debit', 'credit']);
  });
});

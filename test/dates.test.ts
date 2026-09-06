import { describe, expect, it } from 'vitest';
import { addMonths, daysBetween, gmailDate, monthEnd, parseLooseDate } from '../src/core/dates';

describe('dates', () => {
  it('parses loose Indian dates', () => {
    expect(parseLooseDate('12-08-2026')).toBe('2026-08-12');
    expect(parseLooseDate('12/08/26')).toBe('2026-08-12');
    expect(parseLooseDate('2026-08-12')).toBe('2026-08-12');
    expect(parseLooseDate('12 Aug 2026')).toBe('2026-08-12');
    expect(parseLooseDate('08/12/2026', false)).toBe('2026-08-12');
    expect(parseLooseDate(46246)).toBe('2026-08-12');
    expect(parseLooseDate('nope')).toBeNull();
  });
  it('month helpers', () => {
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(daysBetween('2026-08-01', '2026-08-03')).toBe(2);
    expect(gmailDate('2026-08-31', 1)).toBe('2026/09/01');
  });
});

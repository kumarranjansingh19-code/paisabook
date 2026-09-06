import { describe, expect, it } from 'vitest';
import { formatPaise, parseAmountToPaise } from '../src/core/money';

describe('parseAmountToPaise', () => {
  it('handles Indian formats', () => {
    expect(parseAmountToPaise('1,23,456.78')).toBe(12345678);
    expect(parseAmountToPaise('Rs. 1,234.50')).toBe(123450);
    expect(parseAmountToPaise('INR 500')).toBe(50000);
    expect(parseAmountToPaise('₹2,000')).toBe(200000);
    expect(parseAmountToPaise('1234.5')).toBe(123450);
    expect(parseAmountToPaise('1,234.56 Dr')).toBe(123456);
    expect(parseAmountToPaise('-99.99')).toBe(-9999);
    expect(parseAmountToPaise('(45.00)')).toBe(-4500);
    expect(parseAmountToPaise(12.34)).toBe(1234);
  });
  it('rejects junk', () => {
    expect(() => parseAmountToPaise('twelve')).toThrow();
    expect(() => parseAmountToPaise('1.234.5')).toThrow();
  });
});

describe('formatPaise', () => {
  it('formats compact', () => {
    expect(formatPaise(12700000, { compact: true })).toBe('₹1.27L');
    expect(formatPaise(-500000, { compact: true })).toBe('-₹5,000');
  });
});

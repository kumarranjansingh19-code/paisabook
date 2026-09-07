import { describe, expect, it } from 'vitest';
import { buildPattern, describePattern, normalizePattern, parsePattern, patternMatches } from '../src/core/rulematch';

describe('rule patterns', () => {
  it('plain fragment behaves like before', () => {
    expect(patternMatches('swiggy', 'UPI-SWIGGY INSTAMART-123')).toBe(true);
    expect(patternMatches('swiggy', 'UPI-ZOMATO-123')).toBe(false);
  });
  it('all / any / none conditions', () => {
    expect(patternMatches('amazon&!prime', 'AMAZON PAY IN')).toBe(true);
    expect(patternMatches('amazon&!prime', 'AMAZON PRIME VIDEO')).toBe(false);
    expect(patternMatches('swiggy|zomato&food', 'ZOMATO FOOD ORDER')).toBe(true);
    expect(patternMatches('swiggy|zomato&food', 'ZOMATO GOLD')).toBe(false);
    expect(patternMatches('!prime', 'anything')).toBe(false);
  });
  it('builds, normalizes and round-trips', () => {
    expect(buildPattern({ all: ['Amazon Pay'], any: ['swiggy, zomato'], none: ['Prime'] })).toBe('amazonpay&swiggy|zomato&!prime');
    expect(normalizePattern('%Swiggy Instamart%')).toBe('swiggyinstamart');
    expect(parsePattern('amazonpay&swiggy|zomato&!prime')).toEqual({ all: ['amazonpay'], any: ['swiggy', 'zomato'], none: ['prime'] });
    expect(describePattern('amazonpay&swiggy|zomato&!prime')).toBe('amazonpay · swiggy or zomato · not prime');
    expect(() => buildPattern({ all: [], any: [], none: ['x'] })).toThrow();
    expect(() => buildPattern({ all: ['ab'], any: [], none: [] })).toThrow();
  });
});

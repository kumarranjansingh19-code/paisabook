import { describe, expect, it } from 'vitest';
import { normalizeNarration, ruleNorm, txnFingerprint } from '../src/core/fingerprint';
import { sha256Hex } from '../src/core/hash';

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
  });
});

describe('fingerprint', () => {
  const base = { accountId: 'acc_1', postedAt: '2026-08-01', direction: 'debit' as const, amountPaise: 12345 };
  it('prefers the ref no over narration', () => {
    const a = txnFingerprint({ ...base, refNo: 'UPI123456', narration: 'SWIGGY' });
    const b = txnFingerprint({ ...base, refNo: 'upi 123456', narration: 'Swiggy Instamart via UPI' });
    expect(a).toBe(b);
  });
  it('uses normalized narration when no ref', () => {
    const a = txnFingerprint({ ...base, narration: 'UPI/SWIGGY-INSTAMART/ref' });
    const b = txnFingerprint({ ...base, narration: 'swiggy instamart' });
    expect(a).toBe(b);
    expect(txnFingerprint({ ...base, narration: 'swiggy instamart', occurrence: 2 })).not.toBe(a);
  });
  it('normalizes', () => {
    expect(normalizeNarration('UPI/Mu- rali Yadav/okaxis')).toBe('MU RALI YADAV OKAXIS');
    expect(ruleNorm('Mu- rali Yadav')).toBe('muraliyadav');
  });
});

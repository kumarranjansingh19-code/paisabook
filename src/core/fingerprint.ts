import { sha256Hex } from './hash';

/** Normalize a bank narration: uppercase, strip boilerplate, collapse punctuation. */
export function normalizeNarration(narration: string): string {
  return narration
    .toUpperCase()
    .replace(/\b(UPI|IMPS|NEFT|RTGS|POS|ACH|TXN|REF|NO|VIA|BY|TO|FROM|INFO)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rule-matching form: lowercase, spaces and hyphens removed (PDF extraction splits words). */
export function ruleNorm(narration: string): string {
  return narration.toLowerCase().replace(/[-\s]/g, '');
}

export interface FingerprintInput {
  accountId: string;
  postedAt: string;
  direction: 'debit' | 'credit';
  amountPaise: number;
  refNo?: string | null;
  narration?: string | null;
  /** Distinguishes legitimate same-day identical txns within one statement. */
  occurrence?: number;
}

/** Stable transaction identity: prefers the bank ref no, else normalized narration. */
export function txnFingerprint(t: FingerprintInput): string {
  const ref = t.refNo?.replace(/\s+/g, '').toUpperCase();
  const key = ref && ref.length >= 4 ? `REF:${ref}` : `NARR:${normalizeNarration(t.narration ?? '')}#${t.occurrence ?? 1}`;
  return sha256Hex([t.accountId, t.postedAt, t.direction, t.amountPaise, key].join('|'));
}

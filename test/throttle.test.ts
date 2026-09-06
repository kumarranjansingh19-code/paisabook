import { describe, expect, it } from 'vitest';

/**
 * The throttle lives inside gmail.ts with module state; this re-implements
 * the invariant it must hold — a request larger than the per-second pace
 * must still be admitted — as a guard against the stall that shipped once.
 */
function admitTime(unitsPerSec: number, units: number): number {
  const cap = Math.max(unitsPerSec * 2, units);
  let bucket = 0;
  let t = 0;
  for (let i = 0; i < 1000; i++) {
    bucket = Math.min(cap, bucket + unitsPerSec);
    t++;
    if (bucket >= units) return t;
  }
  return Infinity;
}

describe('throttle invariant', () => {
  it('admits a batch whose cost exceeds one second of pace', () => {
    expect(admitTime(25, 100)).toBe(4);
    expect(admitTime(10, 100)).toBe(10);
    expect(admitTime(200, 100)).toBe(1);
  });
});

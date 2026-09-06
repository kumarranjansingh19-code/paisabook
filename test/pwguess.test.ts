import { describe, expect, it } from 'vitest';
import { passwordCandidates } from '../src/core/pwguess';

describe('passwordCandidates', () => {
  const r = { dob: '1990-08-12', pan: 'ABCDE1234F', mobile: '9876543210', name: 'Asha Verma' };
  it('covers the common bank recipes', () => {
    const c = passwordCandidates(r);
    for (const want of ['12081990', '120890', '1208', '19900812', 'ABCDE1234F', 'ASHA1208', 'ASHA3210', 'asha1208', 'ABCDE1234F12081990', '3210', '9876543210']) expect(c).toContain(want);
    expect(c.length).toBeLessThanOrEqual(60);
  });
  it('puts what the hint asks for first', () => {
    expect(passwordCandidates(r, 'your PAN in capital letters')[0]).toBe('ABCDE1234F');
    expect(passwordCandidates(r, 'date of birth in DDMMYYYY')[0]).toBe('12081990');
  });
  it('adds card-number recipes when a last-4 is known', () => {
    expect(passwordCandidates(r, '', '4396')).toContain('439612081990');
  });
  it('is empty without facts', () => {
    expect(passwordCandidates({ dob: '', pan: '', mobile: '', name: '' })).toEqual([]);
  });
});

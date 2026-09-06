import { describe, expect, it } from 'vitest';
import { sameNarration, similarNarration } from '../src/core/reconcile';
import { parseAlert, stripVpaDigits } from '../src/core/heuristics';

describe('wrapped statement narrations', () => {
  it('treats a line-wrapped narration as the same text', () => {
    expect(sameNarration('UPIOUT/XXXX5562/gp-', 'UPIOUT/XXXX5562/gpay-utility@okpayaxis/r/4900')).toBe(true);
    expect(sameNarration('UPIOUT/XXXX1731/so-ciety.payment@icici/UP- /7349', 'UPIOUT/XXXX1731/society.payment@icici/UP/7349')).toBe(true);
    expect(sameNarration('NFT/NEOSIEXEDDD2026080-', 'NFT/NEOSIEXEDDDXXXX5819 Asha Verma')).toBe(true);
  });
  it('keeps separate same-day payments apart when only the channel prefix agrees', () => {
    expect(sameNarration('UPIOUT/XXXX5038/an-', 'UPIOUT/XXXX0959/an-')).toBe(false);
    expect(sameNarration('Amazon India', 'Urban Company')).toBe(false);
  });
  it('similarNarration still accepts merchant spellings', () => {
    expect(similarNarration('URBAN COMPANY LIMITED', 'URBANCOMPANY')).toBe(true);
    expect(similarNarration('UPIOUT/XXXX8265/sw-', 'UPIOUT/XXXX8265/swiggyinstamart@axb/Pay /5411')).toBe(true);
  });
});

describe('UPI ids are not account numbers', () => {
  const mail = 'Hey, Asha Your UPI payment was successful You paid ₹114 Paid to Urban Company Limited paytm-urbancompany@ptybl Date Sep 05, 2026 From Asha XXXX9946@jupiteraxis Transaction ID XXXX7833';
  it('stripVpaDigits removes digits that belong to a VPA', () => {
    expect(stripVpaDigits('Federal Bank XX9946', mail)).toBe('Federal Bank');
    expect(stripVpaDigits('Jupiter XXXX9946@jupiteraxis', mail)).toBe('Jupiter');
    expect(stripVpaDigits('HDFC Bank XX1234', mail)).toBe('HDFC Bank XX1234');
  });
  it('the parser does not mint a masked number from a VPA', () => {
    const r = parseAlert({ from: 'Jupiter <alerts@jupiter.money>', subject: 'UPI transaction successful', bodyText: mail, receivedAt: '2026-09-05T10:00:00Z' } as never);
    expect(r?.account_hint ?? '').not.toMatch(/9946/);
  });
  it('failed or not-initiated orders are not transactions', () => {
    const r = parseAlert({ from: 'Coin <noreply-coin@example.net>', subject: 'Order report', bodyText: 'Order failed Fund SBI SMALL CAP FUND Remarks Payment not initiated from client end Order value: ₹1000.0000 Any funds debited from your bank account will be refunded', receivedAt: '2026-08-10T10:00:00Z' } as never);
    expect(r).toBeNull();
  });
});

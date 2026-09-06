import { describe, expect, it } from 'vitest';
import { detectStatement, discoverHeuristically, parseAlert, parseBill } from '../src/core/heuristics';

const mail = (from: string, subject: string, bodyText: string) => ({ from, subject, bodyText, receivedAt: '2026-08-13T05:00:00.000Z' });

describe('parseAlert', () => {
  it('reads an HDFC UPI debit', () => {
    const a = parseAlert(mail('HDFC Bank InstaAlerts <alerts@hdfcbank.net>', 'You have done a UPI txn. Check details!', 'Dear Customer, Rs.450.00 has been debited from account **1234 to VPA swiggy@icici SWIGGY on 12-08-26. Your UPI transaction reference number is 522412345678. If you did not authorize this transaction, call 18002586161.'));
    expect(a).toMatchObject({ amount: '450.00', direction: 'debit', date: '2026-08-12', account_kind: 'bank', ref_no: '522412345678', institution: 'HDFC Bank' });
    expect(a!.account_hint).toContain('XX1234');
    expect(a!.narration.toLowerCase()).toContain('swiggy');
  });
  it('reads an ICICI card spend and ignores the available limit', () => {
    const a = parseAlert(mail('ICICI Bank <credit_cards@icicibank.com>', 'Transaction alert for your ICICI Bank Credit Card', 'Your ICICI Bank Credit Card XX5678 has been used for a transaction of INR 1,299.00 on Aug 12, 2026 at 10:15:30 IST at AMAZON PAY INDIA. The available credit limit on your card is INR 2,50,000.00.'));
    expect(a).toMatchObject({ amount: '1,299.00', direction: 'debit', account_kind: 'credit_card', date: '2026-08-12' });
    expect(a!.account_hint).toBe('ICICI Bank Credit Card XX5678');
    expect(a!.narration).toMatch(/AMAZON PAY INDIA/);
  });
  it('reads a Federal NEFT salary credit', () => {
    const a = parseAlert(mail('Federal Bank <alerts@federalbank.co.in>', 'Credit alert', 'Rs 3,38,000.00 credited to your A/c XX6524 on 01-08-2026 by NEFT from CK 12 SOFTWARE PVT LTD. Ref no N213261234567.'));
    expect(a).toMatchObject({ amount: '3,38,000.00', direction: 'credit', date: '2026-08-01', account_kind: 'bank', ref_no: 'N213261234567' });
    expect(a!.narration).toContain('CK 12 SOFTWARE');
  });
  it('refuses ambiguous mail (OTP, two amounts, debit+credit pair)', () => {
    expect(parseAlert(mail('HDFC <a@hdfcbank.net>', 'OTP', 'Your OTP for transaction of Rs 500 at Amazon is 123456. Do not share.'))).toBeNull();
    expect(parseAlert(mail('Shop <news@shop.com>', 'Sale', 'Get items at Rs 499 and Rs 999 today!'))).toBeNull();
    expect(parseAlert(mail('Shop <news@shop.com>', 'Sale', 'Everything at Rs 499 today at MyShop.'))).toBeNull(); // no direction word, no account
  });
  it('reads card payment receipts as credits and skips FD renewals', () => {
    const yes = parseAlert(mail('YES BANK <alerts@custcom.yes.bank.in>', 'Payment received', 'Dear Customer, we have received the payment of Rs. 6,495.00 towards your YES BANK Credit Card XX5764 on 20-08-2026. Thank you for your payment.'));
    expect(yes).toMatchObject({ direction: 'credit', amount: '6,495.00', account_kind: 'credit_card' });
    const hdfc = parseAlert(mail('HDFC Bank <alerts@hdfcbank.net>', 'Payment credited', 'Payment of Rs 19,149.00 has been credited to your HDFC Bank Credit Card ending 4129 on 17-08-2026 via CRED. Available limit Rs 1,80,000.'));
    expect(hdfc).toMatchObject({ direction: 'credit', amount: '19,149.00' });
    expect(parseAlert(mail('ICICI Bank <noreply@icicibank.com>', 'Your Fixed Deposit', 'Your Fixed Deposit of Rs 1,00,00,000.00 in A/c XX1234 will automatically get renewed on maturity on 09-08-2026. Interest will be credited.'))).toBeNull();
  });
  it('reads real SBI CBS alerts (long masks, "has a debit by", text after the date)', () => {
    const nach = parseAlert(mail('<cbsalerts.sbi@alerts.sbi.bank.in>', 'CBSSBI ALERT', 'Greetings from SBI ! Dear Customer, Your A/C XXXXX092452 has a debit by NACH of Rs 1,000.00 on 12/08/26. Avl Bal Rs 1,19,591.35. Download YONO - SBI. Please do not reply to this auto generated email.'));
    expect(nach).toMatchObject({ direction: 'debit', amount: '1,000.00', date: '2026-08-12' });
    expect(nach!.account_hint).toBe('SBI A/c XX2452');
    expect(nach!.narration).toMatch(/NACH/);
    const ecs = parseAlert(mail('<cbsalerts.sbi@alerts.sbi.bank.in>', 'CBSSBI ALERT', 'Greetings from SBI ! Your AC XXXXX092452 Debited INR 295.00 on 03/08/26 -ECS/ACH RET CH. Avl Bal INR 18.35.-SBI Please do not reply.'));
    expect(ecs).toMatchObject({ direction: 'debit', amount: '295.00', date: '2026-08-03' });
    expect(ecs!.narration).toMatch(/ECS\/ACH RET CH/);
    const neft = parseAlert(mail('"neftinfo.itps" <neftinfo.itps@alerts.sbi.bank.in>', 'NEFT Transaction', 'Dear Customer, Thank you for banking with State Bank of India. Your account has been credited for NEFT received as per the details given below Credited to Your A/c: XX2452 Amount: INR 1,20,000.00 UTR No.: FBBT262161234567 Date: 04/08/2026 Sent by: Ranjan Kumar Singh Sender Bank IFSC: FDRL0009993'));
    expect(neft).toMatchObject({ direction: 'credit', amount: '1,20,000.00', date: '2026-08-04', ref_no: 'FBBT262161234567' });
    expect(neft!.narration).toBe('Ranjan Kumar Singh');
  });
  it('reads a CRED bill-payment confirmation as a credit on the card', () => {
    const a = parseAlert({ ...mail('CRED <protect@cred.club>', 'your credit card bill payment was successful', 'hey, your credit card bill payment was successful. ₹6,495.00 paid to YES Bank •••• 5764 on 20 Aug 2026. ref YDZJ6QQ1X3R. you earned 649 CRED coins.'), receivedAt: '2026-08-20T09:00:00.000Z' });
    expect(a).toMatchObject({ direction: 'credit', amount: '6,495.00', account_kind: 'credit_card', date: '2026-08-20' });
    expect(a!.account_hint).toContain('5764');
    expect(a!.narration).toMatch(/Card bill payment/);
  });
  it('keeps SBI NACH narrations away from footer verbs', () => {
    const a = parseAlert(mail('SBI <alerts@sbi.co.in>', 'CBSSBI ALERT', 'Dear Customer, Your A/c X2452 is debited by Rs 1,000.00 on 03/08/26 for NACH/ECS towards SIP. If not done by you, forward this SMS to 9223008333 to cancel.'));
    expect(a).toMatchObject({ direction: 'debit', amount: '1,000.00' });
    expect(a!.narration).not.toMatch(/cancel|forward/i);
  });
  it('reads an SBI IMPS debit where the beneficiary is also mentioned', () => {
    const a = parseAlert(mail('SBI <alerts@sbi.co.in>', 'Alert', 'Your A/c X2452 is debited for Rs 2,500.00 on 12/08/26 and A/c XX9999 credited (IMPS Ref no 123456789012).'));
    expect(a).toMatchObject({ direction: 'debit', amount: '2,500.00', date: '2026-08-12', ref_no: '123456789012' });
    expect(a!.account_hint).toBe('SBI A/c XX2452');
  });
});

describe('detectStatement / parseBill', () => {
  it('detects card statements by sender + attachment', () => {
    expect(detectStatement({ from: 'Axis Bank <cc.statements@axisbank.com>', subject: 'Your Axis Bank Credit Card Statement', attachments: [{ filename: 'stmt.pdf', mimeType: 'application/pdf' }] })).toBe('cc_statement');
    expect(detectStatement({ from: 'Federal Bank <estatement@federalbank.co.in>', subject: 'Account e-Statement for Aug 2026', attachments: [{ filename: 'x.pdf', mimeType: 'application/octet-stream' }] })).toBe('bank_statement');
    expect(detectStatement({ from: 'Random <a@b.com>', subject: 'invoice', attachments: [{ filename: 'inv.pdf', mimeType: 'application/pdf' }] })).toBeNull();
  });
  it('reads a bill notice', () => {
    const b = parseBill({ from: 'SBI Card <statements@sbicard.com>', subject: 'Your SBI Card statement is ready', bodyText: 'Statement date 05 Aug 2026. Card ending 1987. Total Amount Due: Rs 25,999.00. Minimum Amount Due Rs 1,300.00. Payment Due Date: 25 Aug 2026.' });
    expect(b).toMatchObject({ total_due: '25,999.00', min_due: '1,300.00', due_date: '2026-08-25', statement_date: '2026-08-05' });
    expect(b!.card_hint).toBe('SBI Card Credit Card XX1987');
  });
});

describe('discoverHeuristically', () => {
  it('groups by institution, kind and last4', () => {
    const r = discoverHeuristically([
      { from: 'alerts@hdfcbank.net', subject: 'UPI txn', snippet: 'Rs.450 debited from account **1234' },
      { from: 'alerts@hdfcbank.net', subject: 'UPI txn', snippet: 'Rs.50 debited from account **1234' },
      { from: 'cc.statements@axisbank.com', subject: 'Credit Card Statement', snippet: 'card XX8194 statement attached' },
      { from: 'news@shop.com', subject: 'Sale', snippet: 'Rs 499 only' },
    ]);
    expect(r.proposals.map((p) => `${p.institution}|${p.kind}|${p.last4}|${p.seen}`)).toEqual(['HDFC Bank|bank|1234|2', 'Axis Bank|credit_card|8194|1']);
    expect(r.proposals[1]!.statement_sender).toBe('cc.statements@axisbank.com');
  });
  it('ignores marketing, bank names inside bodies, and bare 4-digit numbers', () => {
    const r = discoverHeuristically([
      { from: 'offers@bandhanbank.com', subject: 'Sibling Showdown Recipe Contest & More', snippet: 'Win Rs 2000 vouchers. Card 2000 winners.' },
      { from: 'promo@yesbank.in', subject: 'Get Pre-Approved Express Loan on your YES BANK Credit Card', snippet: 'Rs 5,00,000 loan' },
      { from: 'noreply@zerodha.com', subject: 'Coin by Zerodha — Updates', snippet: 'SBI account statement of SBI Mutual Fund' },
      { from: 'alerts@indusind.com', subject: 'Stop losing out – Switch to premium banking now', snippet: 'A/c 1860 Rs 10,000' },
      { from: 'alerts@sbi.co.in', subject: 'CBSSBI ALERT', snippet: 'Your A/c X2452 is credited Rs 90.00 on 12/08/26 by RADICO' },
      { from: 'alerts@sbi.co.in', subject: 'NEFT Transaction', snippet: 'Your A/c X2452 is credited Rs 1,20,000 by NEFT' },
    ]);
    expect(r.proposals.map((p) => `${p.institution}|${p.kind}|${p.last4}`)).toEqual(['SBI|bank|2452']);
  });
});

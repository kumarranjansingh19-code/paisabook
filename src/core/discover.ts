import { generateJson } from '../llm/gemini';
import { discoverySchema, type DiscoveryResult } from '../llm/schemas';
import type { FetchedEmail } from '../google/gmail';
import { db } from '../store/db';
import { chunk, mapPool } from './pool';
import { emailAddress, redactPii } from './text';
import { instKey, allRefs } from './accounts';
import { discoverHeuristically } from './heuristics';

export interface AccountProposal {
  kind: 'bank' | 'credit_card';
  institution: string;
  last4: string;
  seen: number;
  statement_sender: string;
  example_subject: string;
}

/** Propose bank/card accounts from already-fetched emails, deduplicated against registered ones. */
export async function discoverAccounts(emails: FetchedEmail[], signal?: AbortSignal): Promise<AccountProposal[]> {
  const found = new Map<string, AccountProposal>();
  // Rules first: known bank senders + masked numbers need no AI at all.
  const h = discoverHeuristically(emails);
  for (const p of h.proposals) found.set(`${instKey(p.institution)}|${p.kind}|${p.last4}`, { ...p });
  // The AI only sees mail from senders the rules couldn't place (capped — this is discovery, not a sync).
  const forAi = h.unresolved.slice(0, 200).map((i) => emails[i]!);
  await mapPool(
    chunk(forAi, 20),
    4,
    async (batch) => {
      const listing = batch
        .map((e, i) => `--- EMAIL ${i} ---\nFrom: ${e.from}\nSubject: ${e.subject}\nBody: ${redactPii((e.bodyText || e.snippet).slice(0, 500))}`)
        .join('\n\n');
      let r: DiscoveryResult;
      try {
        r = await generateJson<DiscoveryResult>(
          discoverySchema,
          `For each email, identify whether it is from a BANK ACCOUNT or CREDIT CARD the user personally holds ` +
            `(transaction alert, statement delivery, balance/bill notice). NOT account emails: marketing, offers, OTPs, ` +
            `brokers/demat/mutual funds (Zerodha, Groww, NSE, CDSL...), payment/rewards apps (CRED, Paytm, PhonePe...), ` +
            `insurers, and loan/EMI notices. The institution must be an actual bank or card issuer.\n\n${listing}`,
          { tier: 'bulk', signal, label: 'discovery' },
        );
      } catch {
        return;
      }
      for (const res of r.results) {
        if (!res.is_account_email || res.kind === 'none' || !res.institution) continue;
        const email = batch[res.index];
        if (!email) continue;
        const last4 = res.masked_number.replace(/\D/g, '').slice(-4);
        const key = `${instKey(res.institution)}|${res.kind}|${last4}`;
        const sender = emailAddress(email.from);
        const cur = found.get(key);
        if (cur) {
          cur.seen++;
          if (!cur.statement_sender && res.is_statement_email) cur.statement_sender = sender;
        } else {
          found.set(key, { kind: res.kind, institution: res.institution, last4, seen: 1, statement_sender: res.is_statement_email ? sender : '', example_subject: email.subject.slice(0, 70) });
        }
      }
    },
    signal,
  );
  const existing = db.activeAccounts();
  return [...found.values()]
    .filter((p) => p.seen >= 2 || p.statement_sender || p.last4)
    .filter(
      (p) =>
        !existing.some((a) => {
          const refs = (allRefs(a).match(/\d{2,}/g) ?? []).map((d) => d.slice(-4));
          if (p.last4 && refs.some((r) => r.endsWith(p.last4) || p.last4.endsWith(r))) return true;
          return a.kind === p.kind && instKey(a.institution) === instKey(p.institution) && (!p.last4 || !a.account_ref);
        }),
    )
    .sort((a, b) => b.seen - a.seen);
}

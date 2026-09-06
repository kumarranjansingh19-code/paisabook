import { db, newId, stamp, type Rule, type Transaction } from '../store/db';
import { generateJson } from '../llm/gemini';
import { categorizationSchema, ruleSuggestSchema, SPEND_CATEGORIES, type CategorizationResult, type RuleSuggestResult } from '../llm/schemas';
import { ruleNorm } from './fingerprint';
import { formatPaise } from './money';
import { chunk } from './pool';

const BATCH_SIZE = 40;

function ruleMatches(rule: Rule, narration: string): boolean {
  return ruleNorm(narration).includes(rule.pattern);
}

/** Deterministic rules first; they also override earlier LLM guesses, never user picks. */
export function applyRules(): number {
  let n = 0;
  const rules = db.rules.rows;
  if (!rules.length) return 0;
  for (const t of db.transactions.rows) {
    if (t.status === 'superseded' || t.categorized_by === 'user') continue;
    for (const r of rules) {
      if (!ruleMatches(r, t.narration)) continue;
      if (t.category !== r.category || (r.merchant && t.merchant !== r.merchant)) {
        db.update(db.transactions, t.id, { category: r.category, merchant: r.merchant || t.merchant, categorized_by: 'rule' });
        n++;
      }
      break;
    }
  }
  return n;
}

/** Memory for the LLM prompt: user corrections are authoritative, history is guidance. */
export function buildMemory(): string {
  const live = db.liveTransactions();
  const user = new Map<string, Map<string, number>>();
  const hist = new Map<string, Map<string, number>>();
  for (const t of live) {
    if (!t.category) continue;
    const who = t.merchant || t.narration.slice(0, 30);
    if (!who) continue;
    const target = t.categorized_by === 'user' ? user : t.merchant ? hist : null;
    if (!target) continue;
    const m = target.get(who) ?? new Map<string, number>();
    m.set(t.category, (m.get(t.category) ?? 0) + 1);
    target.set(who, m);
  }
  const ruleFrags = db.rules.rows.map((r) => r.pattern);
  const covered = (who: string) => {
    const norm = who.toLowerCase().replace(/[^a-z0-9]/g, '');
    return ruleFrags.some((f) => norm.includes(f) || f.includes(norm));
  };
  const userLines = [...user.entries()].slice(-25).map(([who, cats]) => {
    const [cat, n] = [...cats.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return `- "${who}" → ${cat} (user-confirmed${n > 1 ? ` ×${n}` : ''})`;
  });
  const histLines: string[] = [];
  for (const [who, cats] of hist) {
    if (user.has(who) || covered(who)) continue;
    const total = [...cats.values()].reduce((s, n) => s + n, 0);
    if (total < 2) continue;
    const sorted = [...cats.entries()].sort((a, b) => b[1] - a[1]);
    const [topCat, topN] = sorted[0]!;
    histLines.push(
      topN / total >= 0.8
        ? `- "${who}" → usually ${topCat} (${topN}/${total})`
        : `- "${who}": mixed (${sorted.map(([c, n]) => `${c} ${n}`).join(', ')}) — judge from context`,
    );
    if (histLines.length >= 40) break;
  }
  const parts: string[] = [];
  if (userLines.length) parts.push(`USER-CONFIRMED mappings (follow unless this transaction clearly differs):\n${userLines.join('\n')}`);
  if (histLines.length) parts.push(`Historical patterns (guidance, not law):\n${histLines.join('\n')}`);
  return parts.length ? parts.join('\n\n') + '\n\n' : '';
}

function householdHints(): string {
  const fam = db.family.rows;
  const self = fam.find((f) => f.relation === 'self');
  const others = fam.filter((f) => f.relation !== 'self');
  const parts: string[] = [];
  if (self) parts.push(`the user is ${self.name}`);
  if (others.length) parts.push(`family members: ${others.map((f) => `${f.name} (${f.relation})`).join(', ')} — payments to them are family_transfer`);
  return parts.length ? `(${parts.join('; ')}) ` : '';
}

export interface CategorizeProgress {
  (done: number, total: number): void;
}

/** Categorize uncategorized live transactions: rules, then LLM in batches. */
export async function categorizeAll(onProgress?: CategorizeProgress, signal?: AbortSignal): Promise<{ byRule: number; byLlm: number }> {
  const byRule = applyRules();
  await db.flush();
  const todo = db.liveTransactions().filter((t) => !t.category && t.status !== 'unmatched');
  let byLlm = 0;
  const accountName = (id: string) => db.accounts.get(id);
  for (const batch of chunk(todo, BATCH_SIZE)) {
    if (signal?.aborted) break;
    const listing = batch
      .map((t) => {
        const acc = accountName(t.account_id);
        return `id=${t.id} | ${t.posted_at} | ${t.direction} ${formatPaise(t.amount_paise)} | account: ${acc?.display_name ?? '?'} (${acc?.kind ?? '?'}) | ${t.narration}`;
      })
      .join('\n');
    const result = await generateJson<CategorizationResult>(
      categorizationSchema,
      buildMemory() +
        `Categorize these Indian personal-finance transactions. Allowed categories: ${SPEND_CATEGORIES.join(', ')}.\n` +
        `Use cc_payment for payments toward the user's own credit-card bill (and the matching credit on the card); self_transfer for moves between the user's own accounts ` +
        `${householdHints()}; paid_for_others for amounts paid on someone else's behalf, received_for_others for their repayment credits; ` +
        `salary_income for salary credits; dividend_income for dividend/SGB-interest credits; refund for merchant refunds/reversals; ` +
        `investment for transfers TO broker/MF/PPF/NPS and also for capital coming BACK from broker platforms (withdrawals, sale proceeds).\n\n${listing}`,
      { tier: 'reasoning', signal },
    );
    const valid = new Set(batch.map((t) => t.id));
    for (const r of result.results) {
      if (!valid.has(r.id) || !SPEND_CATEGORIES.includes(r.category)) continue;
      db.update(db.transactions, r.id, { category: r.category, merchant: r.merchant || '', categorized_by: 'llm' });
      byLlm++;
    }
    await db.flush();
    onProgress?.(byLlm, todo.length);
  }
  const promoted = promoteStablePatterns();
  if (promoted.length) await db.append(db.rules, promoted);
  if (promoted.length) {
    applyRules();
    await db.flush();
  }
  return { byRule, byLlm };
}

/** Precision of a candidate pattern across ALL live transactions. */
export function checkRulePrecision(pattern: string, category: string): { total: number; same: number; userClash: number; precision: number } {
  let total = 0, same = 0, userClash = 0;
  for (const t of db.liveTransactions()) {
    if (!ruleNorm(t.narration).includes(pattern)) continue;
    total++;
    if (t.category === category) same++;
    if (t.categorized_by === 'user' && t.category && t.category !== category) userClash++;
  }
  return { total, same, userClash, precision: total ? same / total : 0 };
}

/**
 * Promote unanimous LLM verdicts into rules so repeat merchants stop costing
 * LLM calls: ≥2 occurrences, one category, fragment occurs in ≥80% of those
 * narrations, ≥90% precision globally, and no clash with a user pick.
 */
export function promoteStablePatterns(): Rule[] {
  const byMerchant = new Map<string, { cats: Map<string, number>; rows: Transaction[] }>();
  for (const t of db.liveTransactions()) {
    if (!t.merchant || !t.category || t.categorized_by !== 'llm' || t.category === 'other' || t.category === 'cash') continue;
    const e = byMerchant.get(t.merchant) ?? { cats: new Map<string, number>(), rows: [] as Transaction[] };
    e.cats.set(t.category, (e.cats.get(t.category) ?? 0) + 1);
    e.rows.push(t);
    byMerchant.set(t.merchant, e);
  }
  const existing = new Set(db.rules.rows.map((r) => r.pattern));
  const out: Rule[] = [];
  for (const [merchant, e] of byMerchant) {
    if (e.cats.size !== 1) continue;
    const [category, n] = [...e.cats.entries()][0]!;
    if (n < 2) continue;
    const frag = merchant.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (frag.length < 4 || existing.has(frag)) continue;
    const hits = e.rows.filter((r) => ruleNorm(r.narration).includes(frag)).length;
    if (hits / e.rows.length < 0.8) continue;
    const p = checkRulePrecision(frag, category);
    if (!p.total || p.precision < 0.9 || p.userClash > 0) continue;
    existing.add(frag);
    out.push({ id: newId('rule'), pattern: frag, category, merchant, source: 'llm', created_at: stamp() });
  }
  return out;
}

export async function addRule(pattern: string, category: string, merchant: string, source: Rule['source'] = 'user'): Promise<{ rule: Rule; retagged: number }> {
  const frag = pattern.toLowerCase().replace(/%/g, '').replace(/[-\s]/g, '');
  if (frag.length < 3) throw new Error('Pattern too short');
  const rule: Rule = { id: newId('rule'), pattern: frag, category, merchant: merchant.trim(), source, created_at: stamp() };
  await db.append(db.rules, [rule]);
  const retagged = applyRules();
  await db.flush();
  return { rule, retagged };
}

/** Rules are never deleted from the sheet — they're blanked so row numbers stay stable. */
export async function deleteRule(id: string): Promise<void> {
  db.update(db.rules, id, { pattern: '', category: '', merchant: '' });
  await db.flush();
  db.rules.rows = db.rules.rows.filter((r) => r.id !== id);
  db.notify();
}

export interface RuleSuggestion {
  pattern: string;
  category: string;
  merchant: string;
  reason: string;
  matches: number;
  precision: number;
}

/** Ask the model for rule candidates, then validate each with the precision guard. */
export async function suggestRules(): Promise<RuleSuggestion[]> {
  const covered = db.rules.rows.map((r) => r.pattern);
  const groups = new Map<string, { n: number; samples: Set<string> }>();
  for (const t of db.liveTransactions()) {
    if (!t.merchant || !t.category) continue;
    const key = `${t.merchant} → ${t.category}`;
    const g = groups.get(key) ?? { n: 0, samples: new Set() };
    g.n++;
    if (g.samples.size < 3) g.samples.add(t.narration.slice(0, 40));
    groups.set(key, g);
  }
  const lines = [...groups.entries()]
    .filter(([k]) => !covered.some((c) => k.toLowerCase().replace(/[^a-z0-9→]/g, '').includes(c)))
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 80)
    .map(([k, g]) => `${k} (${g.n}×) | narration samples: ${[...g.samples].join(' ; ')}`);
  if (!lines.length) return [];
  const r = await generateJson<RuleSuggestResult>(
    ruleSuggestSchema,
    `From this merchant history, suggest categorization RULES — only where the mapping is unambiguous and the fragment is distinctive ` +
      `(a substring that could never appear in unrelated narrations). Skip merchants whose category legitimately varies by context.\n\n${lines.join('\n')}`,
    { tier: 'reasoning' },
  );
  const out: RuleSuggestion[] = [];
  for (const s of r.suggestions) {
    const frag = s.pattern_fragment.toLowerCase().replace(/[^a-z0-9@.]/g, '');
    if (frag.length < 5 || covered.includes(frag)) continue;
    const p = checkRulePrecision(frag, s.category);
    if (p.total < 2 || p.precision < 0.9 || p.userClash > 0) continue;
    out.push({ pattern: frag, category: s.category, merchant: s.merchant, reason: s.reason, matches: p.total, precision: Math.round(p.precision * 100) });
  }
  return out;
}

/** Manual override from the UI: immune to rules and future LLM passes. */
export async function setCategory(id: string, category: string, merchant?: string): Promise<void> {
  const patch: Partial<Transaction> = { category, categorized_by: 'user' };
  if (merchant !== undefined) patch.merchant = merchant;
  db.update(db.transactions, id, patch);
  await db.flush();
}

import { ruleNorm } from './fingerprint';

/**
 * Rule patterns are stored in one cell as a tiny expression over narration
 * fragments (lowercased, spaces/dashes removed, like the narration itself):
 *
 *   swiggy                     contains "swiggy"
 *   amazon&!prime              contains "amazon" and not "prime"
 *   swiggy|zomato&food         contains "swiggy" or "zomato", and "food"
 *
 * `&` separates conditions that must all hold; inside one condition `|` lists
 * alternatives (any one suffices); a leading `!` negates the condition.
 * A plain fragment (every rule made before this syntax) is one condition.
 */
export interface RuleConditions {
  all: string[];
  any: string[];
  none: string[];
}

const frag = (s: string): string => s.toLowerCase().replace(/%/g, '').replace(/[-\s]/g, '');

export function parsePattern(pattern: string): RuleConditions {
  const c: RuleConditions = { all: [], any: [], none: [] };
  for (const raw of pattern.split('&')) {
    const term = raw.trim();
    if (!term) continue;
    const neg = term.startsWith('!');
    const alts = (neg ? term.slice(1) : term).split('|').map(frag).filter(Boolean);
    if (!alts.length) continue;
    if (neg) c.none.push(...alts);
    else if (alts.length > 1) c.any.push(...alts);
    else c.all.push(alts[0]!);
  }
  return c;
}

/** Build the stored pattern from the three lists; throws on empty / too-short input. */
export function buildPattern(c: RuleConditions): string {
  const clean = (xs: string[]) => xs.flatMap((x) => x.split(/[,\n]/)).map(frag).filter(Boolean);
  const all = clean(c.all), any = clean(c.any), none = clean(c.none);
  for (const f of [...all, ...any, ...none]) if (f.length < 3) throw new Error(`"${f}" is too short — use at least 3 characters`);
  if (!all.length && !any.length) throw new Error('Give at least one fragment the narration must contain');
  return [...all, ...(any.length ? [any.join('|')] : []), ...none.map((n) => `!${n}`)].join('&');
}

/** Normalize a user-typed pattern (also accepts the old single-fragment form). */
export function normalizePattern(pattern: string): string {
  return buildPattern(parsePattern(pattern));
}

export function patternMatches(pattern: string, narration: string): boolean {
  const n = ruleNorm(narration);
  const c = parsePattern(pattern);
  if (!c.all.length && !c.any.length) return false;
  if (!c.all.every((f) => n.includes(f))) return false;
  if (c.any.length && !c.any.some((f) => n.includes(f))) return false;
  return !c.none.some((f) => n.includes(f));
}

/** Human-readable form for lists: `amazon&!prime` → "amazon · not prime". */
export function describePattern(pattern: string): string {
  const c = parsePattern(pattern);
  return [...c.all, ...(c.any.length ? [c.any.join(' or ')] : []), ...c.none.map((n) => `not ${n}`)].join(' · ');
}

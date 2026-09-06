/**
 * Categories come from the sheet's `categories` tab (seeded from the built-in
 * list on first load). Everything that needs the list — dropdowns, the AI's
 * allowed values, the dashboard's treatment of each category — reads it here.
 */
import { db, SEED_CATEGORIES, type Category, type CategoryKind } from '../store/db';
import type { JsonSchema } from '../llm/gemini';

export function categories(): Category[] {
  const rows = db.loaded && db.categories.rows.length ? db.categories.rows : SEED_CATEGORIES;
  return [...rows].filter((c) => c.name).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export function categoryNames(): string[] {
  return categories().map((c) => c.name);
}

export function categoryLabel(name: string): string {
  if (!name) return 'uncategorized';
  return categories().find((c) => c.name === name)?.label ?? name.replace(/_/g, ' ');
}

export function categoryKind(name: string): CategoryKind {
  return categories().find((c) => c.name === name)?.kind ?? 'spend';
}

export const isTransfer = (name: string) => categoryKind(name) === 'transfer';
export const isInvestment = (name: string) => categoryKind(name) === 'investment';
export const isRefund = (name: string) => categoryKind(name) === 'refund';
export const isIncome = (name: string) => categoryKind(name) === 'income';

/** The AI's allowed values plus a one-line description of each, straight from the sheet. */
export function categoryPromptBlock(): string {
  return categories()
    .map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}${c.kind !== 'spend' ? ` [${c.kind}]` : ''}`)
    .join('\n');
}

/** A JSON schema clone whose `category` enum is the live list. */
export function withCategoryEnum(schema: JsonSchema): JsonSchema {
  const names = categoryNames();
  const clone = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  const patch = (node: JsonSchema) => {
    if (node.properties?.category) node.properties.category = { type: 'string', enum: names };
    if (node.items) patch(node.items);
    for (const v of Object.values(node.properties ?? {})) patch(v);
  };
  patch(clone);
  return clone;
}

export function normalizeCategoryName(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

export async function addCategory(label: string, kind: CategoryKind, description = ''): Promise<Category> {
  const name = normalizeCategoryName(label);
  if (!name) throw new Error('Give the category a name');
  if (db.categories.has(name)) throw new Error(`"${name}" already exists`);
  const cat: Category = { name, label: label.trim(), kind, description: description.trim(), sort: 190 + db.categories.rows.length };
  await db.append(db.categories, [cat]);
  return cat;
}

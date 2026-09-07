import type { View } from '../app/router';
import { html, raw, onAction, toast, modal, spinner, mdCategoryOptions, catLabel, deferWhileTyping } from '../app/ui';
import { db } from '../store/db';
import { addRule, deleteRule, suggestRules, checkRulePrecision, updateRule, type RuleSuggestion } from '../core/categorize';
import { buildPattern, describePattern, parsePattern, patternMatches } from '../core/rulematch';
import type { Rule } from '../store/db';
import { categoryNames } from '../core/categories';
import { escapeHtml } from '../core/text';

export const rulesView: View = {
  title: 'Rules',
  render(root) {
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    onAction(root, {
      add: async () => {
        const r = await ruleDialog();
        if (!r) return;
        const p = checkRulePrecision(r.pattern, r.category);
        if (p.userClash) toast(`Careful: ${p.userClash} transactions you categorized differently also match`, 'error');
        const { retagged } = await addRule(r.pattern, r.category, r.merchant);
        toast(`Rule added · ${retagged} transactions retagged`, 'ok');
      },
      edit: async (el) => {
        const rule = db.rules.get(el.dataset.id!);
        if (!rule) return;
        const r = await ruleDialog(rule);
        if (!r) return;
        const p = checkRulePrecision(r.pattern, r.category);
        if (p.userClash) toast(`Careful: ${p.userClash} transactions you categorized differently also match`, 'error');
        const { retagged, released } = await updateRule(rule.id, r.pattern, r.category, r.merchant);
        toast(`Rule saved · ${retagged} retagged${released ? ` · ${released} no longer match and will be re-categorized` : ''}`, 'ok');
      },
      del: async (el) => {
        await deleteRule(el.dataset.id!);
        toast('Rule removed (existing categories kept)');
      },
      suggest: async () => {
        const box = root.querySelector<HTMLElement>('#sug')!;
        box.innerHTML = spinner('Gemini is looking for stable patterns…');
        const s = await suggestRules();
        box.innerHTML = s.length
          ? s
              .map(
                (x, i) => `<div class="list-item"><div class="grow"><div class="title"><code>${escapeHtml(x.pattern)}</code> → ${catLabel(x.category)} <span class="muted small">(${escapeHtml(x.merchant)})</span></div>
                  <div class="sub">${escapeHtml(x.reason)} · matches ${x.matches} · ${x.precision}% already this category</div></div>
                  <md-filled-button data-small data-action="accept" data-i="${i}">Add</md-filled-button></div>`,
              )
              .join('')
          : '<p class="muted">No safe suggestions right now.</p>';
        (box as HTMLElement & { suggestions?: RuleSuggestion[] }).suggestions = s;
      },
      accept: async (el) => {
        const box = root.querySelector<HTMLElement & { suggestions?: RuleSuggestion[] }>('#sug')!;
        const s = box.suggestions?.[Number(el.dataset.i)];
        if (!s) return;
        const { retagged } = await addRule(s.pattern, s.category, s.merchant, 'llm');
        el.closest('.list-item')?.remove();
        toast(`Added · ${retagged} retagged`, 'ok');
      },
    });
    return db.onChange(deferWhileTyping(root, draw));
  },
};

function page(): string {
  const rules = db.rules.rows.filter((r) => r.pattern);
  const hits = (pattern: string) => db.liveTransactions().filter((t) => patternMatches(pattern, t.narration)).length;
  return html`
    <div class="row between"><h2>Categorization rules</h2><md-filled-button data-action="add">+ Rule</md-filled-button></div>
    <p class="muted small">Rules run before the AI and cost nothing. A rule matches when the narration (lowercased, spaces removed) satisfies all of its conditions: fragments it must contain, any-of alternatives, and fragments it must not contain. The first matching rule wins; your manual picks on a transaction always win.</p>
    <div class="card">${rules.length
      ? raw(rules
          .map(
            (r) => `<div class="list-item"><div class="grow"><div class="title"><code>${escapeHtml(describePattern(r.pattern))}</code> → ${catLabel(r.category)}${r.merchant ? ` <span class="muted small">(${escapeHtml(r.merchant)})</span>` : ''}</div>
            <div class="sub">${r.source === 'llm' ? '✨ AI-suggested' : 'yours'} · matches ${hits(r.pattern)}</div></div><md-outlined-button data-small data-action="edit" data-id="${r.id}">Edit</md-outlined-button><md-text-button data-small data-action="del" data-id="${r.id}">✕</md-text-button></div>`,
          )
          .join(''))
      : raw('<p class="muted">No rules yet. The AI promotes repeat merchants into rules automatically after a few sightings; you can also ask for suggestions below.</p>')}</div>
    <div class="card"><div class="row between"><h3>✨ Suggest rules</h3><md-outlined-button data-action="suggest">Ask Gemini</md-outlined-button></div>
      <p class="small muted">Each suggestion is validated against your history (≥90% precision, no clash with your picks) before it's shown.</p><div id="sug"></div></div>`;
}

/** Shared add/edit form: three condition lists plus the outcome. Returns the stored pattern or null on cancel. */
async function ruleDialog(rule?: Rule): Promise<{ pattern: string; category: string; merchant: string } | null> {
  const c = rule ? parsePattern(rule.pattern) : { all: [], any: [], none: [] };
  const r = await modal(
    `<p class="small muted">Fragments are matched against the narration with spaces and dashes removed, case-insensitive. Separate several with commas.</p>
     <md-outlined-text-field class="field" label="Must contain all of" name="all" value="${escapeHtml(c.all.join(', '))}" placeholder="amazon, pay"></md-outlined-text-field>
     <md-outlined-text-field class="field" label="Must contain any of (optional)" name="any" value="${escapeHtml(c.any.join(', '))}" placeholder="swiggy, zomato"></md-outlined-text-field>
     <md-outlined-text-field class="field" label="Must not contain (optional)" name="none" value="${escapeHtml(c.none.join(', '))}" placeholder="prime, refund"></md-outlined-text-field>
     <md-outlined-select class="field" label="Category" name="category" required>${mdCategoryOptions(rule?.category ?? '', categoryNames(), false)}</md-outlined-select>
     <md-outlined-text-field class="field" label="Merchant label (optional)" name="merchant" value="${escapeHtml(rule?.merchant ?? '')}" placeholder="Swiggy Instamart"></md-outlined-text-field>`,
    { title: rule ? 'Edit rule' : 'New rule', submit: rule ? 'Save & apply' : 'Add & apply' },
  );
  if (!r?.category) return null;
  const split = (v: string | undefined) => (v ?? '').split(',');
  const pattern = buildPattern({ all: split(r.all), any: split(r.any), none: split(r.none) });
  return { pattern, category: r.category, merchant: r.merchant ?? '' };
}

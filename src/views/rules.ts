import type { View } from '../app/router';
import { html, raw, onAction, toast, modal, spinner, mdCategoryOptions, catLabel } from '../app/ui';
import { db } from '../store/db';
import { addRule, deleteRule, suggestRules, checkRulePrecision, type RuleSuggestion } from '../core/categorize';
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
        const r = await modal(
          `<md-outlined-text-field class="field" label="Narration contains (lowercase, no spaces)" name="pattern" placeholder="swiggyinstamart" required></md-outlined-text-field>
           <md-outlined-select class="field" label="Category" name="category" required>${mdCategoryOptions('', categoryNames(), false)}</md-outlined-select>
           <md-outlined-text-field class="field" label="Merchant label (optional)" name="merchant" placeholder="Swiggy Instamart"></md-outlined-text-field>`,
          { title: 'New rule', submit: 'Add & apply' },
        );
        if (!r?.pattern || !r.category) return;
        const p = checkRulePrecision(r.pattern.toLowerCase().replace(/[-\s]/g, ''), r.category);
        if (p.userClash) toast(`Careful: ${p.userClash} transactions you categorized differently also match`, 'error');
        const { retagged } = await addRule(r.pattern, r.category, r.merchant ?? '');
        toast(`Rule added · ${retagged} transactions retagged`, 'ok');
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
    return db.onChange(draw);
  },
};

function page(): string {
  const rules = db.rules.rows.filter((r) => r.pattern);
  const hits = (pattern: string) => db.liveTransactions().filter((t) => t.narration.toLowerCase().replace(/[-\s]/g, '').includes(pattern)).length;
  return html`
    <div class="row between"><h2>Categorization rules</h2><md-filled-button data-action="add">+ Rule</md-filled-button></div>
    <p class="muted small">Rules run before the AI and cost nothing. A rule matches when the fragment appears in the narration (lowercased, spaces removed). Your manual picks on a transaction always win.</p>
    <div class="card">${rules.length
      ? raw(rules
          .map(
            (r) => `<div class="list-item"><div class="grow"><div class="title"><code>${escapeHtml(r.pattern)}</code> → ${catLabel(r.category)}${r.merchant ? ` <span class="muted small">(${escapeHtml(r.merchant)})</span>` : ''}</div>
            <div class="sub">${r.source === 'llm' ? '✨ AI-suggested' : 'yours'} · matches ${hits(r.pattern)}</div></div><md-text-button data-small data-action="del" data-id="${r.id}">✕</md-text-button></div>`,
          )
          .join(''))
      : raw('<p class="muted">No rules yet. The AI promotes repeat merchants into rules automatically after a few sightings; you can also ask for suggestions below.</p>')}</div>
    <div class="card"><div class="row between"><h3>✨ Suggest rules</h3><md-outlined-button data-action="suggest">Ask Gemini</md-outlined-button></div>
      <p class="small muted">Each suggestion is validated against your history (≥90% precision, no clash with your picks) before it's shown.</p><div id="sug"></div></div>`;
}

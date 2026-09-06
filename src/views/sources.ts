import type { View } from '../app/router';
import { html, raw, onAction, toast, modal, spinner, confirmDialog } from '../app/ui';
import { db, type Source } from '../store/db';
import { addSource, applyMapping, importSource, listTabs, previewRows, proposeMapping } from '../core/sources';
import { addAccount } from '../core/accounts';
import { escapeHtml } from '../core/text';
import { money } from '../app/ui';
import type { SheetMapping } from '../llm/schemas';
import type { Cell } from '../google/sheets';

export const sourcesView: View = {
  title: 'Other sources',
  render(root) {
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    onAction(root, {
      add: () => wizard(root),
      import: async (el) => {
        const src = db.sources.get(el.dataset.id!)!;
        el.setAttribute('disabled', '');
        try {
          const r = await importSource(src, { useAiFallback: true, onProgress: (m) => toast(m) });
          toast(`${r.parsed + r.aiParsed} rows read (${r.aiParsed} by AI) · ${r.inserted} new, ${r.matched} already known`, 'ok');
        } finally {
          el.removeAttribute('disabled');
        }
      },
      remove: async (el) => {
        const src = db.sources.get(el.dataset.id!)!;
        if (!(await confirmDialog(`Forget "${src.label}"? Imported transactions stay in the ledger.`, 'Forget'))) return;
        db.update(db.sources, src.id, { label: `(removed) ${src.label}`, sheet_name: '' });
        await db.flush();
        db.sources.rows = db.sources.rows.filter((s) => s.id !== src.id);
        draw();
      },
    });
    return db.onChange(draw);
  },
};

function page(): string {
  const srcs = db.sources.rows.filter((s) => s.sheet_name);
  return html`
    <div class="row between"><h2>Other sources</h2><button class="btn primary" data-action="add">+ Add a sheet</button></div>
    <p class="muted small">Point PaisaBook at any Google Sheet with money in it: a manual expense log, a bank CSV you pasted, a Splitwise export, a cash diary. Gemini figures out the columns once; imports are deduplicated against alerts and statements.</p>
    <div class="card">${srcs.length
      ? raw(srcs
          .map(
            (s) => `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(s.label)}</div>
            <div class="sub">tab “${escapeHtml(s.sheet_name)}” → ${escapeHtml(db.accounts.get(s.account_id)?.display_name ?? '?')} · ${s.rows_imported} rows · ${s.last_imported_at ? `last ${s.last_imported_at.slice(0, 10)}` : 'never imported'}</div></div>
            <button class="btn small primary" data-action="import" data-id="${s.id}">Import</button><button class="btn small ghost" data-action="remove" data-id="${s.id}">✕</button></div>`,
          )
          .join(''))
      : raw('<p class="muted">No extra sources yet.</p>')}</div>`;
}

async function wizard(root: HTMLElement): Promise<void> {
  const step1 = await modal(`<label class="field">Google Sheet URL <input name="url" placeholder="https://docs.google.com/spreadsheets/d/…" required /></label><p class="small muted">Must be a sheet your Google account can open.</p>`, { title: 'Add a source', submit: 'Next' });
  if (!step1?.url) return;
  const box = document.createElement('div');
  box.className = 'card';
  box.innerHTML = spinner('Reading the sheet…');
  root.prepend(box);
  try {
    const { id, title, tabs } = await listTabs(step1.url);
    const step2 = await modal(
      `<p><strong>${escapeHtml(title)}</strong></p><label class="field">Which tab? <select name="tab">${tabs.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select></label>`,
      { title: 'Pick a tab', submit: 'Analyse with AI' },
    );
    if (!step2?.tab) return box.remove();
    box.innerHTML = spinner('Gemini is working out the columns…');
    const rows = await previewRows(id, step2.tab, 25);
    const mapping = await proposeMapping(rows);
    if (!mapping.is_transaction_table) {
      box.innerHTML = `<p class="pill bad">That tab doesn't look like a list of transactions.</p><p class="small muted">${escapeHtml(mapping.notes)}</p>`;
      return;
    }
    const sample = applyMapping(rows, mapping);
    const accounts = db.activeAccounts();
    const step3 = await modal(
      `<p class="small">Gemini's reading: <em>${escapeHtml(describe(mapping))}</em>${mapping.notes ? `<br/>${escapeHtml(mapping.notes)}` : ''}</p>
       <p class="small muted">${sample.txns.length} of the first rows parsed cleanly${sample.failedRows.length ? `, ${sample.failedRows.length} couldn't be read mechanically (AI will read those)` : ''}.</p>
       ${previewTable(rows, mapping, sample.txns.slice(0, 5))}
       <label class="field">Label <input name="label" value="${escapeHtml(`${title} / ${step2.tab}`)}" /></label>
       <label class="field">Import into account <select name="acc"><option value="__new">＋ New account: ${escapeHtml(mapping.account_guess || 'from this sheet')}</option>${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.display_name)}</option>`).join('')}</select></label>
       <textarea name="mapping" hidden>${escapeHtml(JSON.stringify(mapping))}</textarea>`,
      { title: 'Confirm', submit: 'Save & import', wide: true },
    );
    if (!step3) return box.remove();
    let accId = step3.acc!;
    if (accId === '__new') {
      const acc = await addAccount({ kind: 'other', institution: mapping.account_guess || step2.tab, display_name: mapping.account_guess || `${title} / ${step2.tab}` });
      accId = acc.id;
    }
    const src = await addSource({ spreadsheet_id: id, sheet_name: step2.tab, label: step3.label || `${title} / ${step2.tab}`, account_id: accId, mapping: JSON.parse(step3.mapping!) as SheetMapping });
    box.innerHTML = spinner('Importing…');
    const r = await importSource(src, { useAiFallback: true, onProgress: (m) => (box.innerHTML = spinner(m)) });
    box.remove();
    toast(`${r.parsed + r.aiParsed} rows read · ${r.inserted} new, ${r.matched} already known`, 'ok');
  } catch (err) {
    box.innerHTML = `<p class="pill bad">${escapeHtml(String((err as Error).message))}</p>`;
  }
}

function describe(m: SheetMapping): string {
  const parts = [`date in column ${m.date_col} (${m.date_day_first ? 'DD/MM' : 'MM/DD'})`];
  if (m.narration_col) parts.push(`description in ${m.narration_col}`);
  if (m.amount_mode === 'debit_credit_cols') parts.push(`debits in ${m.debit_col}, credits in ${m.credit_col}`);
  else if (m.amount_mode === 'single_with_direction_col') parts.push(`amount in ${m.amount_col}, Dr/Cr in ${m.direction_col}`);
  else parts.push(`signed amount in ${m.amount_col} (${m.positive_is_debit ? 'positive = spend' : 'positive = credit'})`);
  if (m.category_col) parts.push(`category in ${m.category_col}`);
  return parts.join(', ');
}

function previewTable(rows: Cell[][], m: SheetMapping, parsed: Array<{ postedAt: string; amountPaise: number; direction: string; narration: string }>): string {
  const head = rows[Math.max(m.header_row - 1, 0)] ?? [];
  return `<div class="table-wrap"><table><thead><tr>${head.slice(0, 8).map((c) => `<th>${escapeHtml(String(c ?? ''))}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(m.first_data_row - 1, m.first_data_row + 2).map((r) => `<tr>${r.slice(0, 8).map((c) => `<td class="small">${escapeHtml(String(c ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="small muted">Read as:</p><ul class="small">${parsed.map((t) => `<li>${t.postedAt} · ${t.direction} ${money(t.amountPaise)} · ${escapeHtml(t.narration)}</li>`).join('')}</ul>`;
}

export type { Source };

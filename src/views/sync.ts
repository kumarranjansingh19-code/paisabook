import type { View } from '../app/router';
import { html, raw, onAction, toast, modal, pct } from '../app/ui';
import { db } from '../store/db';
import { abortSync, defaultPeriod, dropPdf, loadPendingFromSheet, onSync, queueLocalPdf, retryPdf, runSync, syncState } from '../core/sync';
import { escapeHtml } from '../core/text';
import { daysAgoIso, todayIso } from '../core/dates';
import { categorizeAll } from '../core/categorize';
import { usage } from '../llm/gemini';
import { scanCheckpoint } from '../core/extract';
import { dedupeAlerts } from '../core/reconcile';

let period = defaultPeriod(3);

export const syncView: View = {
  title: 'Sync',
  render(root) {
    loadPendingFromSheet();
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    root.addEventListener('change', async (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'from') period.from = t.value;
      if (t.name === 'to') period.to = t.value;
      if (t.name === 'preset' && t.value) {
        period = t.value === 'all' ? { from: daysAgoIso(365 * 3), to: todayIso() } : defaultPeriod(Number(t.value));
        draw();
      }
      if (t.name === 'pdf' && t.files?.length) {
        for (const f of [...t.files]) await queueLocalPdf(f);
        toast(`${t.files.length} PDF(s) queued — enter passwords below if needed`);
        const { importPending } = await import('../core/sync');
        await importPending();
      }
    });
    onAction(root, {
      run: () => {
        const reprocess = root.querySelector<HTMLInputElement>('input[name=reprocess]')!.checked;
        const force = root.querySelector<HTMLInputElement>('input[name=force]')!.checked;
        const broad = root.querySelector<HTMLInputElement>('input[name=broad]')!.checked;
        if (period.from > period.to) return toast('"From" must be before "To"', 'error');
        void runSync({ from: period.from, to: period.to, reprocess, broad, forceStatements: force });
      },
      stop: () => abortSync(),
      dedupe: async (el) => {
        el.setAttribute('disabled', '');
        const n = await dedupeAlerts();
        toast(n ? `${n} duplicate alerts merged` : 'No duplicates found', 'ok');
        el.removeAttribute('disabled');
      },
      categorize: async (el) => {
        el.setAttribute('disabled', '');
        const r = await categorizeAll();
        toast(`Categorized ${r.byRule} by rules, ${r.byLlm} by AI`, 'ok');
        el.removeAttribute('disabled');
      },
      unlock: (el) => unlock(el.dataset.sha!),
      drop: (el) => dropPdf(el.dataset.sha!),
    });
    const off1 = onSync(() => {
      // keep the inputs, refresh only the dynamic parts
      const s = root.querySelector('#status');
      if (s) s.innerHTML = status();
      const q = root.querySelector('#queue');
      if (q) q.innerHTML = queue();
    });
    const off2 = db.onChange(() => {
      const q = root.querySelector('#queue');
      if (q) q.innerHTML = queue();
    });
    return () => {
      off1();
      off2();
    };
  },
};

function page(): string {
  const last = db.getSetting('last_sync');
  return html`
    <div class="card">
      <h2>Sync from Gmail</h2>
      <p class="muted small">${last ? `Last sync ${new Date(last).toLocaleString('en-IN')}.` : 'Never synced.'} Already-processed emails and statements are skipped, so re-running a period is cheap.</p>
      <div class="row">
        <label class="field grow">Quick pick <select name="preset"><option value="">custom</option><option value="1">last month</option><option value="3" selected>last 3 months</option><option value="6">last 6 months</option><option value="12">last year</option><option value="all">everything (3 yrs)</option></select></label>
        <label class="field grow">From <input type="date" name="from" value="${period.from}" /></label>
        <label class="field grow">To <input type="date" name="to" value="${period.to}" /></label>
      </div>
      <label class="check"><input type="checkbox" name="reprocess" /> Re-read emails already processed in this period (after adding accounts, or to fix misses)</label>
      <label class="check"><input type="checkbox" name="force" /> Re-import statements already imported (replaces their rows)</label>
      <label class="check"><input type="checkbox" name="broad" /> Broad scan: read every email's headers instead of Gmail's money-related search (slower, catches odd senders)</label>
      <div id="status">${raw(status())}</div>
    </div>
    <div class="card">
      <h3>Statement PDFs</h3>
      <p class="muted small">Statements found in mail land here. Ones that need a password wait for you. You can also pick PDFs from your device.</p>
      <label class="field">Import a PDF from this device <input type="file" name="pdf" accept="application/pdf,.pdf" multiple /></label>
      <div id="queue">${raw(queue())}</div>
    </div>
    <div class="card">
      <div class="row between"><h3>Merge duplicate alerts</h3><button class="btn" data-action="dedupe">Run now</button></div>
      <p class="muted small">Banks often mail twice about one transaction (with and without the reference number). New syncs merge these automatically; run this once for rows imported earlier.</p>
    </div>
    <div class="card">
      <div class="row between"><h3>Categorize</h3><button class="btn" data-action="categorize">Run now</button></div>
      <p class="muted small">Runs at the end of every sync; use this after editing rules. ${db.liveTransactions().filter((t) => !t.category && t.status !== 'unmatched').length} uncategorized right now.</p>
    </div>`;
}

function status(): string {
  const s = syncState;
  const p = s.progress;
  const bar = p && p.total ? `<div class="progress"><div style="width:${pct(p.done, p.total)}%"></div></div>` : s.running ? '<div class="progress"><div style="width:100%;opacity:.4"></div></div>' : '';
  const summary = Object.entries(s.summary)
    .map(([k, v]) => `<span class="pill muted">${k.replace(/_/g, ' ')}: ${v}</span>`)
    .join(' ');
  return `
    <div class="row" style="margin:.6rem 0">
      ${s.running ? `<button class="btn danger" data-action="stop">Stop</button><span class="spinner"></span> <span>${escapeHtml(s.phase)}${p && p.total ? ` ${p.done}/${p.total}` : ''}${p?.note ? ` · ${escapeHtml(p.note)}` : ''}</span>` : `<button class="btn primary" data-action="run">${resumeLabel()}</button>`}
    </div>
    ${bar}
    ${summary ? `<p>${summary}</p>` : ''}
    ${s.error ? `<p class="pill bad">${escapeHtml(s.error)}</p>` : ''}
    ${s.log.length ? `<div class="log">${s.log.map(escapeHtml).join('\n')}</div>` : ''}
    ${usage.calls ? `<p class="muted small">AI usage this session: ${usage.calls} calls · ${Math.round(usage.inputTokens / 1000)}k in / ${Math.round(usage.outputTokens / 1000)}k out tokens</p>` : ''}`;
}

function resumeLabel(): string {
  const ck = scanCheckpoint();
  if (ck && ck.from === period.from && ck.to === period.to && ck.metas.length && ck.metas.length < ck.ids.length) {
    return `Resume sync (${ck.metas.length}/${ck.ids.length} headers read)`;
  }
  return `Sync ${period.from} → ${period.to}`;
}

function queue(): string {
  const q = syncState.pendingPdfs;
  const recent = db.statements.rows.filter((s) => !['bill_only', 'queued', 'needs_password', 'needs_account', 'superseded'].includes(s.status)).slice(-8).reverse();
  return `
    ${q.length
      ? q
          .map(
            (p) => `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(p.filename)}</div>
              <div class="sub">${escapeHtml(p.subject)} · ${p.receivedAt.slice(0, 10)}${p.lastError ? ` · <span class="pill warn">${escapeHtml(p.lastError)}</span>` : ''}${p.hint ? `<br/>hint from the email: <em>${escapeHtml(p.hint)}</em>` : ''}</div></div>
              <button class="btn small primary" data-action="unlock" data-sha="${p.sha}">Open</button><button class="btn small ghost" data-action="drop" data-sha="${p.sha}">✕</button></div>`,
          )
          .join('')
      : '<p class="muted small">Nothing waiting.</p>'}
    ${recent.length
      ? `<details style="margin-top:.6rem"><summary>Recently imported statements</summary>${recent
          .map(
            (s) => `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(db.accounts.get(s.account_id)?.display_name ?? '?')} <span class="pill ${s.status === 'imported' ? 'ok' : s.status === 'failed' ? 'bad' : 'warn'}">${s.status.replace('_', ' ')}</span></div>
              <div class="sub">${s.period_start || '?'} → ${s.period_end} · ${s.txn_count} rows, ${s.inserted} new, ${s.matched} matched · ${escapeHtml(s.source)}${s.notes ? `<br/>${escapeHtml(s.notes)}` : ''}</div></div></div>`,
          )
          .join('')}</details>`
      : ''}`;
}

async function unlock(sha: string): Promise<void> {
  const pdf = syncState.pendingPdfs.find((p) => p.sha === sha);
  if (!pdf) return;
  const accounts = db.activeAccounts();
  const needsAccount = /no account/.test(pdf.lastError ?? '');
  const r = await modal(
    `<p class="small muted">${escapeHtml(pdf.filename)}${pdf.hint ? `<br/>Hint from the bank's email: <em>${escapeHtml(pdf.hint)}</em>` : ''}</p>
     <label class="field">PDF password (leave empty if the file isn't protected) <input name="pw" autocomplete="off" autocapitalize="off" /></label>
     <label class="field">${needsAccount ? 'This statement belongs to' : 'Remember the password for'} <select name="acc"><option value="">— pick an account —</option>${accounts.map((a) => `<option value="${a.id}" ${a.id === pdf.accountGuess ? 'selected' : ''}>${escapeHtml(a.display_name)}</option>`).join('')}</select></label>
     <label class="check"><input type="checkbox" name="remember" checked /> Remember this password on this device for that account</label>`,
    { title: 'Open statement', submit: 'Import' },
  );
  if (!r) return;
  toast('Importing…');
  const res = await retryPdf(sha, { password: r.pw || undefined, rememberFor: r.remember && r.acc ? r.acc : undefined, accountId: r.acc || undefined });
  if (res.status === 'imported') toast(`Imported: ${res.inserted} new, ${res.matched} matched`, 'ok');
  else if (res.status === 'needs_password') toast('Wrong password', 'error');
  else if (res.status === 'needs_account') toast(`No account matches "${res.hint}" — pick one in the dialog`, 'error');
  else if (res.status === 'failed') toast(res.reason, 'error');
  else toast(res.status);
}

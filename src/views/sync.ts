import type { View } from '../app/router';
import { html, raw, onAction, toast, modal, pct } from '../app/ui';
import { db } from '../store/db';
import { abortSync, defaultPeriod, dropPdf, fetchStatements, loadPendingFromSheet, onSync, queueLocalPdf, retryPdf, runSync, syncState } from '../core/sync';
import { escapeHtml } from '../core/text';
import { daysAgoIso, todayIso } from '../core/dates';
import { categorizeAll } from '../core/categorize';
import { usage } from '../llm/gemini';
import { learnedSenders, scanCheckpoint } from '../core/extract';
import { dedupeAlerts, matchAlertsToStatements } from '../core/reconcile';

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
      if (t.name === 'preset') {
        if (t.value === 'custom') {
          root.querySelector('#custom-range')?.removeAttribute('hidden');
        } else {
          period = t.value === 'all' ? { from: daysAgoIso(365 * 3), to: todayIso() } : defaultPeriod(Number(t.value));
          root.querySelector('#custom-range')?.setAttribute('hidden', '');
          root.querySelector<HTMLInputElement>('input[name=from]')!.value = period.from;
          root.querySelector<HTMLInputElement>('input[name=to]')!.value = period.to;
          const btn = root.querySelector('[data-action=run]');
          if (btn) btn.textContent = resumeLabel();
        }
      }
      if (t.name === 'pdf' && t.files?.length) {
        for (const f of [...t.files]) await queueLocalPdf(f);
        toast(`${t.files.length} PDF(s) queued — enter passwords below if needed`);
        const { importPending } = await import('../core/sync');
        await importPending();
      }
    });
    onAction(root, {
      refresh: () => {
        const lastTo = db.getSetting('last_sync_to');
        const from = lastTo ? shiftDays(lastTo, -2) : daysAgoIso(30);
        const senders = learnedSenders();
        void runSync({ from, to: todayIso(), senders: senders.length >= 3 ? senders : undefined });
      },
      start: () => {
        if (period.from > period.to) return toast('"From" must be before "To"', 'error');
        void runSync({ from: period.from, to: period.to });
      },
      run: () => {
        const reprocess = root.querySelector<HTMLInputElement>('input[name=reprocess]')?.checked ?? false;
        const force = root.querySelector<HTMLInputElement>('input[name=force]')?.checked ?? false;
        const scope = root.querySelector<HTMLSelectElement>('select[name=scope]')?.value ?? 'focused';
        if (period.from > period.to) return toast('"From" must be before "To"', 'error');
        void runSync({ from: period.from, to: period.to, reprocess, broad: scope === 'broad', senders: scope === 'known' ? learnedSenders() : undefined, forceStatements: force });
      },
      stop: () => abortSync(),
      'fetch-statements': () => {
        if (period.from > period.to) return toast('"From" must be before "To"', 'error');
        void fetchStatements(period.from, period.to);
      },
      match: async (el) => {
        el.setAttribute('disabled', '');
        const n = await matchAlertsToStatements();
        toast(n ? `${n} alerts matched to statement rows` : 'Nothing to match', 'ok');
        el.removeAttribute('disabled');
      },
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
      const s = root.querySelector('#status');
      if (s) s.innerHTML = status();
      const q = root.querySelector('#queue');
      if (q) q.innerHTML = queue();
      root.querySelectorAll<HTMLButtonElement>('[data-action=refresh],[data-action=run],[data-action=fetch-statements]').forEach((b) => (syncState.running ? b.setAttribute('disabled', '') : b.removeAttribute('disabled')));
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

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function page(): string {
  const last = db.getSetting('last_sync');
  const lastTo = db.getSetting('last_sync_to');
  const known = learnedSenders().length;
  const busy = syncState.running;
  if (!last) {
    return html`
      <div class="card">
        <h2>Get started</h2>
        <p class="muted small">PaisaBook will read the last 3 months of your bank mail: alerts, statements (asking for PDF passwords when needed) and card bills, then categorize everything. Takes a few minutes; you can leave and come back — progress is saved.</p>
        <button class="btn primary" data-action="start" ${busy ? 'disabled' : ''}>Read my last 3 months</button>
        <details style="margin-top:12px"><summary class="small">Choose a different period</summary>
          <label class="field">Period <select name="preset"><option value="1">Last month</option><option value="3" selected>Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last year</option><option value="custom">Custom dates…</option></select></label>
          <div id="custom-range" class="row" hidden>
            <label class="field grow">From <input type="date" name="from" value="${period.from}" /></label>
            <label class="field grow">To <input type="date" name="to" value="${period.to}" /></label>
          </div>
        </details>
        <div id="status">${raw(status())}</div>
      </div>
      <div class="card">
        <h3>Statement PDFs</h3>
        <p class="muted small">Statements found in mail land here. Ones that need a password wait and are imported the moment you add it (key button on the account).</p>
        <label class="field">Import a PDF from this device <input type="file" name="pdf" accept="application/pdf,.pdf" multiple /></label>
        <div id="queue">${raw(queue())}</div>
      </div>`;
  }
  return html`
    <div class="card">
      <h2>Refresh</h2>
      <p class="muted small">${last ? `Mail is fetched up to <strong>${lastTo}</strong> (last run ${new Date(last).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}).` : 'Nothing fetched yet.'}
        Reads new mail from your banks since then and updates the ledger. ${known >= 3 ? `Only your ${known} known bank senders are read, so this takes seconds.` : ''}</p>
      <button class="btn primary" data-action="refresh" ${busy ? 'disabled' : ''}>Refresh now</button>
    </div>

    <div class="card">
      <h2>Load history</h2>
      <p class="muted small">Pull a longer period, e.g. when you first set up or after adding an account. Mail already processed is skipped, so repeating a period is cheap.</p>
      <label class="field">Period
        <select name="preset">
          <option value="1">Last month</option>
          <option value="3" selected>Last 3 months</option>
          <option value="6">Last 6 months</option>
          <option value="12">Last year</option>
          <option value="all">Everything (3 years)</option>
          <option value="custom">Custom dates…</option>
        </select>
      </label>
      <div id="custom-range" class="row" hidden>
        <label class="field grow">From <input type="date" name="from" value="${period.from}" /></label>
        <label class="field grow">To <input type="date" name="to" value="${period.to}" /></label>
      </div>
      <details>
        <summary>Advanced</summary>
        <label class="field">What to read
          <select name="scope">
            <option value="focused" ${known < 3 ? 'selected' : ''}>Money-related mail (default — also finds new bank senders)</option>
            <option value="known" ${known >= 3 ? 'selected' : 'disabled'}>Only my ${known} known bank senders (fastest)</option>
            <option value="broad">Every email (slowest, catches odd senders)</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" name="reprocess" /> <span>Re-read mail already processed in this period (after adding an account, or to fix misses)</span></label>
        <label class="check"><input type="checkbox" name="force" /> <span>Re-import statements already imported (replaces their rows)</span></label>
        <p class="small muted">Statements only: <button class="btn small" data-action="fetch-statements" ${busy ? 'disabled' : ''}>Find statement emails in this period</button> — a few quota units, no alert reading.</p>
      </details>
      <div id="status">${raw(status())}</div>
    </div>

    <div class="card">
      <h3>Statement PDFs</h3>
      <p class="muted small">Statements found in mail land here. Ones that need a password wait and are imported the moment you add it (key button on the account). You can also pick a PDF from this device.</p>
      <label class="field">Import a PDF from this device <input type="file" name="pdf" accept="application/pdf,.pdf" multiple /></label>
      <div id="queue">${raw(queue())}</div>
    </div>

    <details class="card">
      <summary>Maintenance</summary>
      <div class="list-item"><div class="grow"><div class="title">Match alerts to statements</div><div class="sub">Pairs alert rows with the statement rows for the same purchase and hides the alert. Runs after every sync; use it if you see both.</div></div><button class="btn small" data-action="match">Run</button></div>
      <div class="list-item"><div class="grow"><div class="title">Merge duplicate alerts</div><div class="sub">Banks often mail twice about one transaction. New syncs merge these automatically; run once for older rows.</div></div><button class="btn small" data-action="dedupe">Run</button></div>
      <div class="list-item"><div class="grow"><div class="title">Categorize</div><div class="sub">Runs after every sync; use after editing rules. ${db.liveTransactions().filter((t) => !t.category && t.status !== 'unmatched').length} uncategorized now.</div></div><button class="btn small" data-action="categorize">Run</button></div>
    </details>`;
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
      ${s.running ? `<button class="btn danger" data-action="stop">Stop</button><span class="spinner"></span> <span>${escapeHtml(s.phase)}${p && p.total ? ` ${p.done}/${p.total}` : ''}${p?.note ? ` · ${escapeHtml(p.note)}` : ''}</span>` : db.getSetting('last_sync') ? `<button class="btn primary" data-action="run">${resumeLabel()}</button>` : ''}
    </div>
    ${bar}
    ${summary ? `<p>${summary}</p>` : ''}
    ${s.error ? `<p class="pill bad">${escapeHtml(s.error)}</p>` : ''}
    ${s.log.length ? `<details ${s.running || s.error ? 'open' : ''}><summary class="small">Log</summary><div class="log">${s.log.map(escapeHtml).join('\n')}</div></details>` : ''}
    ${usage.calls ? `<p class="muted small">AI usage this session: ${usage.calls} calls · ${Math.round(usage.inputTokens / 1000)}k in / ${Math.round(usage.outputTokens / 1000)}k out tokens</p>` : ''}`;
}

function resumeLabel(): string {
  const ck = scanCheckpoint();
  if (ck && ck.from === period.from && ck.to === period.to && ck.metas.length && ck.metas.length < ck.ids.length) {
    return `Resume (${ck.metas.length}/${ck.ids.length} read)`;
  }
  return `Load ${period.from} → ${period.to}`;
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

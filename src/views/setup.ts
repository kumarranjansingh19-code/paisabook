import type { View } from '../app/router';
import { navigate } from '../app/router';
import { html, raw, onAction, toast, spinner, modal } from '../app/ui';
import { settings, saveSettings } from '../store/local';
import { hasValidToken, redirectUri, startSignIn, whoAmI } from '../google/auth';
import { testGemini } from '../llm/gemini';
import { db } from '../store/db';
import { parseSpreadsheetId } from '../google/sheets';
import { scanMailbox } from '../core/extract';
import { discoverAccounts, type AccountProposal } from '../core/discover';
import { discoverHeuristically } from '../core/heuristics';
import { addAccount } from '../core/accounts';
import { daysAgoIso, todayIso } from '../core/dates';
import { escapeHtml } from '../core/text';

type Step = 'google' | 'gemini' | 'sheet' | 'accounts' | 'done';
let discovering = false;
const ORDER: Step[] = ['google', 'gemini', 'sheet', 'accounts', 'done'];

function currentStep(): Step {
  const s = settings();
  if (!s.googleClientId || !hasValidToken()) return 'google';
  if (!s.geminiApiKey) return 'gemini';
  if (!s.spreadsheetId) return 'sheet';
  if (!s.setupDone) return 'accounts';
  return 'done';
}

export const setupView: View = {
  title: 'Setup',
  requiresDb: false,
  render(root, params) {
    const forced = params.get('step') as Step | null;
    const step = forced && ORDER.includes(forced) ? forced : currentStep();
    root.innerHTML = layout(step);
    wire(root, step);
  },
};

function layout(step: Step): string {
  const idx = ORDER.indexOf(step);
  const steps = ['Google', 'Gemini', 'Sheet', 'Accounts'].map((label, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${i + 1}. ${label}</span>`).join('');
  return `<div class="steps">${steps}</div>${STEP_HTML[step]()}`;
}

const STEP_HTML: Record<Step, () => string> = {
  google: () => {
    const s = settings();
    return html`<div class="card">
      <h2>1. Connect Google</h2>
      <p class="muted">PaisaBook reads Gmail and writes to a Google Sheet <em>from your browser</em>. You need your own free OAuth client so no one else ever holds your tokens.</p>
      <details ${s.googleClientId ? '' : 'open'}>
        <summary>How to create the OAuth client (one time, ~5 minutes)</summary>
        <ol class="help">
          <li>Open <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">Google Cloud Console → APIs & Services</a>. Create a project (any name).</li>
          <li>Enable the <strong>Gmail API</strong> and the <strong>Google Sheets API</strong>.</li>
          <li><strong>OAuth consent screen</strong> → External → fill the app name and your email → add yourself under <em>Test users</em>. Leave it in Testing mode (no verification needed for yourself).</li>
          <li><strong>Credentials → Create credentials → OAuth client ID → Web application</strong>. Add this exact URL to BOTH <em>Authorized JavaScript origins</em> (without the trailing slash) and <em>Authorized redirect URIs</em> (with it):
            <div class="copy" data-copy="${redirectUri()}">${redirectUri()} <button type="button" class="btn small" data-action="copy">copy</button></div>
            <div class="copy" data-copy="${location.origin}">${location.origin} <button type="button" class="btn small" data-action="copy">copy</button></div>
          </li>
          <li>Download the client JSON (or copy the Client ID) and paste it below.</li>
        </ol>
      </details>
      <label class="field">Client JSON or Client ID
        <textarea name="clientJson" placeholder='{"web":{"client_id":"1234-abc.apps.googleusercontent.com", ...}}  — or just the client_id'>${s.googleClientId}</textarea>
      </label>
      <label class="field">Or upload the JSON file <input type="file" accept=".json,application/json" name="clientFile" /></label>
      <div class="row">
        <button class="btn primary" data-action="google">Save & sign in with Google</button>
        ${hasValidToken() ? raw('<span class="pill ok">signed in</span> <a class="btn" href="#/setup?step=gemini">Next →</a>') : ''}
      </div>
      <p class="small muted">Scopes requested: read Gmail, edit Sheets, create files in Drive. Tokens live only in this browser.</p>
    </div>`;
  },
  gemini: () => {
    const s = settings();
    return html`<div class="card">
      <h2>2. Gemini API key</h2>
      <p class="muted">Gemini reads your bank emails and statements. Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>.</p>
      <p class="small"><strong>Enable billing</strong> on that key's project: on the free tier Google may use your prompts (i.e. your financial data) to improve its products. The paid tier costs a few rupees per month for a normal inbox.</p>
      <label class="field">API key <input name="geminiKey" type="password" autocomplete="off" value="${s.geminiApiKey}" placeholder="AIza…" /></label>
      <div class="row">
        <label class="field grow">Bulk model (cheap: email reading) <input name="modelBulk" value="${s.modelBulk}" /></label>
        <label class="field grow">Reasoning model (statements, categorization) <input name="modelReasoning" value="${s.modelReasoning}" /></label>
      </div>
      <div class="row">
        <a class="btn ghost" href="#/setup?step=google">← Back</a>
        <button class="btn primary" data-action="gemini">Test & continue</button>
      </div>
      <div id="gemini-status"></div>
    </div>`;
  },
  sheet: () => {
    const s = settings();
    return html`<div class="card">
      <h2>3. Your ledger: a Google Sheet</h2>
      <p class="muted">Every transaction, account, rule and import log is a row in a spreadsheet you own. Open it any time, make charts, or delete it when you're done.</p>
      <div class="row">
        <button class="btn primary" data-action="create-sheet">Create a new sheet</button>
      </div>
      <p class="muted small">…or connect one PaisaBook created earlier (e.g. from another device):</p>
      <label class="field">Spreadsheet URL or ID <input name="sheetId" value="${s.spreadsheetId}" placeholder="https://docs.google.com/spreadsheets/d/…" /></label>
      <div class="row">
        <a class="btn ghost" href="#/setup?step=gemini">← Back</a>
        <button class="btn" data-action="connect-sheet">Connect existing</button>
      </div>
      <div id="sheet-status"></div>
    </div>`;
  },
  accounts: () => html`<div class="card">
      <h2>4. Your accounts</h2>
      <p class="muted">PaisaBook will scan the last 60 days of mail and propose the bank accounts and cards it sees. Tick the ones that are yours. You can add more later under Accounts.</p>
      <div class="row">
        <button class="btn primary" data-action="discover">Scan my mail for accounts</button>
        <button class="btn ghost" data-action="skip-accounts">Skip, I'll add them manually</button>
      </div>
      <div id="discover-status"></div>
    </div>`,
  done: () => html`<div class="card ok center">
      <h2>You're set</h2>
      <p>Next: run your first sync. It reads the last three months of mail, imports statements (asking for PDF passwords when needed) and categorizes everything.</p>
      <a class="btn primary" href="#/sync">Go to Sync →</a>
    </div>`,
};

function wire(root: HTMLElement, step: Step): void {
  root.querySelector<HTMLInputElement>('input[name=clientFile]')?.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    root.querySelector<HTMLTextAreaElement>('textarea[name=clientJson]')!.value = await f.text();
  });
  onAction(root, {
    copy: (el) => {
      const text = el.closest<HTMLElement>('[data-copy]')?.dataset.copy ?? '';
      navigator.clipboard?.writeText(text).then(() => toast('Copied'));
    },
    google: () => {
      const rawText = root.querySelector<HTMLTextAreaElement>('textarea[name=clientJson]')!.value.trim();
      const id = extractClientId(rawText);
      if (!id) {
        toast('Could not find a client_id in that text', 'error');
        return;
      }
      saveSettings({ googleClientId: id });
      startSignIn('#/setup?step=gemini');
    },
    gemini: async () => {
      const key = root.querySelector<HTMLInputElement>('input[name=geminiKey]')!.value.trim();
      const modelBulk = root.querySelector<HTMLInputElement>('input[name=modelBulk]')!.value.trim();
      const modelReasoning = root.querySelector<HTMLInputElement>('input[name=modelReasoning]')!.value.trim();
      if (!key) return toast('Enter the API key', 'error');
      saveSettings({ geminiApiKey: key, modelBulk, modelReasoning });
      const status = root.querySelector('#gemini-status')!;
      status.innerHTML = spinner('Testing the key…');
      try {
        const name = await testGemini();
        status.innerHTML = `<p class="pill ok">Gemini responded (${escapeHtml(name)})</p>`;
        navigate('/setup?step=sheet');
      } catch (err) {
        status.innerHTML = `<p class="pill bad">${escapeHtml(String((err as Error).message))}</p>`;
      }
    },
    'create-sheet': async () => {
      const status = root.querySelector('#sheet-status')!;
      status.innerHTML = spinner('Creating the sheet…');
      try {
        const id = await db.create();
        status.innerHTML = `<p class="pill ok">Created</p> <a href="https://docs.google.com/spreadsheets/d/${id}" target="_blank" rel="noopener">open it ↗</a>`;
        navigate('/setup?step=accounts');
      } catch (err) {
        status.innerHTML = `<p class="pill bad">${escapeHtml(String((err as Error).message))}</p>`;
      }
    },
    'connect-sheet': async () => {
      const input = root.querySelector<HTMLInputElement>('input[name=sheetId]')!.value.trim();
      if (!input) return toast('Paste the sheet URL', 'error');
      const status = root.querySelector('#sheet-status')!;
      status.innerHTML = spinner('Connecting…');
      try {
        await db.connect(parseSpreadsheetId(input));
        status.innerHTML = `<p class="pill ok">Connected: ${db.accounts.rows.length} accounts, ${db.transactions.rows.length} transactions</p>`;
        if (db.accounts.rows.length) {
          saveSettings({ setupDone: true });
          navigate('/');
        } else navigate('/setup?step=accounts');
      } catch (err) {
        status.innerHTML = `<p class="pill bad">${escapeHtml(String((err as Error).message))}</p>`;
      }
    },
    discover: async (btn) => {
      if (discovering) return toast('A scan is already running');
      discovering = true;
      btn.setAttribute('disabled', '');
      const status = root.querySelector<HTMLElement>('#discover-status')!;
      let note = '';
      const onLimit = (e: Event) => {
        const d = (e as CustomEvent<{ waitMs: number }>).detail;
        note = ` · Gmail rate limit, pausing ${Math.round(d.waitMs / 1000)}s`;
      };
      window.addEventListener('paisabook:ratelimit', onLimit);
      try {
        if (!db.loaded) await db.load();
        // Bodies cost the same quota as headers and are cached on the device, so the
        // first sync reuses everything this scan downloads.
        const scan = await scanMailbox(daysAgoIso(60), todayIso(), {
          reprocess: true,
          maxEmails: 1500,
          onProgress: (p) => {
            status.innerHTML = spinner(`${p.phase} ${p.total ? `${p.done}/${p.total}` : ''}${note}`);
            note = '';
          },
        });
        status.innerHTML = spinner(`Looking for account names in ${scan.emails.length} emails…`);
        let proposals: AccountProposal[];
        try {
          proposals = await discoverAccounts(scan.emails);
        } catch (err) {
          // AI unavailable (rate limit) — rules alone still give us the known banks
          proposals = discoverHeuristically(scan.emails).proposals.map((p) => ({ ...p }));
          toast(`AI step skipped: ${String((err as Error).message).slice(0, 80)}`, 'error');
        }
        renderProposals(status, proposals, scan.interrupted ? { read: scan.read, total: scan.total, reason: scan.interrupted } : undefined);
      } catch (err) {
        status.innerHTML = `<p class="pill bad">${escapeHtml(String((err as Error).message))}</p><p class="small muted">Wait a minute and press Scan again — it continues from where it stopped.</p>`;
      } finally {
        discovering = false;
        btn.removeAttribute('disabled');
        window.removeEventListener('paisabook:ratelimit', onLimit);
      }
    },
    'skip-accounts': () => {
      saveSettings({ setupDone: true });
      navigate('/accounts');
    },
    'add-selected': async (el) => {
      const box = el.closest<HTMLElement>('#discover-status')!;
      const picks = [...box.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')];
      for (const p of picks) {
        const d = JSON.parse(p.dataset.proposal!) as AccountProposal;
        await addAccount({ kind: d.kind, institution: d.institution, account_ref: d.last4 ? `XX${d.last4}` : '', statement_sender: d.statement_sender });
      }
      toast(`${picks.length} accounts added`, 'ok');
      saveSettings({ setupDone: true });
      navigate('/setup?step=done');
    },
    'add-manual': async () => {
      const r = await modal(
        `<label class="field">Type <select name="kind"><option value="bank">Bank account</option><option value="credit_card">Credit card</option><option value="cash">Cash</option><option value="wallet">Wallet</option></select></label>
         <label class="field">Institution <input name="institution" placeholder="HDFC Bank" required /></label>
         <label class="field">Masked number (last 4) <input name="ref" placeholder="XX1234" /></label>`,
        { title: 'Add account', submit: 'Add' },
      );
      if (!r) return;
      await addAccount({ kind: r.kind as 'bank', institution: r.institution!, account_ref: r.ref ?? '' });
      toast('Added', 'ok');
    },
  });
  void step;
}

function renderProposals(box: HTMLElement, proposals: AccountProposal[], partial?: { read: number; total: number; reason: string }): void {
  const banner = partial
    ? `<div class="card warn small">⏸ Gmail cut the scan short after <strong>${partial.read} of ${partial.total}</strong> emails (${escapeHtml(partial.reason.slice(0, 80))}).
        Here's what was found so far. <button class="btn small" data-action="discover">Continue scanning from there</button> or add these and move on.</div>`
    : '';
  if (!proposals.length) {
    box.innerHTML = `${banner}<p class="muted">No bank or card emails found${partial ? ' yet' : ' in the last 60 days'}. Add accounts manually.</p>
      <div class="row"><button class="btn" data-action="add-manual">Add manually</button><button class="btn primary" data-action="skip-accounts">Continue</button></div>`;
    return;
  }
  box.innerHTML = `${banner}<div class="stack">${proposals
    .map(
      (p) => `<label class="check"><input type="checkbox" checked data-proposal='${escapeHtml(JSON.stringify(p))}' />
        <span><strong>${escapeHtml(p.institution)}</strong> ${p.kind === 'credit_card' ? 'card' : 'account'} ${p.last4 ? `••${p.last4}` : ''}
        <span class="muted small">— seen ${p.seen}× · e.g. “${escapeHtml(p.example_subject)}”${p.statement_sender ? ` · statements from ${escapeHtml(p.statement_sender)}` : ''}</span></span></label>`,
    )
    .join('')}
    <div class="row"><button class="btn primary" data-action="add-selected">Add selected</button><button class="btn" data-action="add-manual">Add another manually</button></div></div>`;
}

export function extractClientId(text: string): string {
  const m = /[\w-]+\.apps\.googleusercontent\.com/.exec(text);
  return m ? m[0] : '';
}

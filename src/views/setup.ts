import type { View } from '../app/router';
import { navigate } from '../app/router';
import { html, raw, onAction, toast, spinner, modal } from '../app/ui';
import { settings, saveSettings } from '../store/local';
import { hasValidToken, isLocalhost, redirectUri, startSignIn } from '../google/auth';
import { testGemini } from '../llm/gemini';
import { db, newId, stamp } from '../store/db';
import { listOwnSpreadsheets, parseSpreadsheetId } from '../google/sheets';
import { scanMailbox } from '../core/extract';
import { discoverAccounts, type AccountProposal } from '../core/discover';
import { discoverHeuristically } from '../core/heuristics';
import { addAccount, addAccounts } from '../core/accounts';
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
      <p class="muted">PaisaBook reads Gmail and writes to a Google Sheet <em>from your browser</em>. You need your own free OAuth client so no one else ever holds your tokens. Paste the downloaded client JSON and you sign in once; the app renews its own access after that.</p>
      ${isLocalhost() ? raw('<p class="small"><span class="pill ok">localhost</span> A <strong>Desktop app</strong> client JSON works here as-is (the same file the old finance app used). No URLs to register.</p>') : ''}
      <details ${s.googleClientId ? '' : 'open'}>
        <summary>How to create the OAuth client (one time, ~5 minutes)</summary>
        <ol class="help">
          <li>Open <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">Google Cloud Console → APIs & Services</a>. Create a project (any name).</li>
          <li>Enable the <strong>Gmail API</strong> and the <strong>Google Sheets API</strong>.</li>
          <li><strong>OAuth consent screen</strong> → External → fill the app name and your email → add yourself under <em>Test users</em>. Leave it in Testing mode (no verification needed for yourself).</li>
          <li><strong>Credentials → Create credentials → OAuth client ID</strong>. For a phone or hosted URL choose <strong>Web application</strong> and add this exact URL to BOTH <em>Authorized JavaScript origins</em> (without the trailing slash) and <em>Authorized redirect URIs</em> (with it):
            <div class="copy" data-copy="${redirectUri()}">${redirectUri()} <md-text-button data-small data-action="copy">copy</md-text-button></div>
            <div class="copy" data-copy="${location.origin}">${location.origin} <md-text-button data-small data-action="copy">copy</md-text-button></div>
            For localhost only, a <strong>Desktop app</strong> client needs no URLs.
          </li>
          <li>Download the client JSON and paste it below (a bare Client ID also works, but then you'll be asked to sign in again every hour).</li>
        </ol>
      </details>
      <md-outlined-text-field type="textarea" rows="4" class="field" label="Client JSON or Client ID" name="clientJson" placeholder='{"web":{"client_id":"1234-abc.apps.googleusercontent.com", ...}}  — or just the client_id' value="${s.googleClientId}"></md-outlined-text-field>
      <label class="field">Or upload the JSON file <input type="file" accept=".json,application/json" name="clientFile" /></label>
      <div class="row">
        <md-filled-button data-action="google">Save & sign in with Google</md-filled-button>
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
      <md-outlined-text-field class="field" label="API key" name="geminiKey" type="password" autocomplete="off" value="${s.geminiApiKey}" placeholder="AIza…"></md-outlined-text-field>
      <div class="row">
        <md-outlined-text-field class="field grow" label="Bulk model (cheap: email reading)" name="modelBulk" value="${s.modelBulk}"></md-outlined-text-field>
        <md-outlined-text-field class="field grow" label="Reasoning model (statements, categorization)" name="modelReasoning" value="${s.modelReasoning}"></md-outlined-text-field>
      </div>
      <div class="row">
        <a class="btn ghost" href="#/setup?step=google">← Back</a>
        <md-filled-button data-action="gemini">Test & continue</md-filled-button>
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
        <md-filled-button data-action="create-sheet">Create a new sheet</md-filled-button>
      </div>
      <p class="muted small">…or connect one PaisaBook created earlier (e.g. from another device):</p>
      <div class="row"><md-outlined-button data-action="find-sheets">Find my PaisaBook sheets</md-outlined-button></div>
      <div id="sheet-list"></div>
      <md-outlined-text-field class="field" label="Or paste the spreadsheet URL / ID" name="sheetId" value="${s.spreadsheetId}" placeholder="https://docs.google.com/spreadsheets/d/…"></md-outlined-text-field>
      <div class="row">
        <a class="btn ghost" href="#/setup?step=gemini">← Back</a>
        <md-outlined-button data-action="connect-sheet">Connect existing</md-outlined-button>
      </div>
      <div id="sheet-status"></div>
    </div>`;
  },
  accounts: () => html`<div class="card">
      <h2>4. Your accounts</h2>
      <p class="muted">PaisaBook will scan the last 60 days of mail and propose the bank accounts and cards it sees. Tick the ones that are yours. You can add more later under Accounts.</p>
      <md-outlined-text-field class="field" label="Your name as it appears in bank transfers (so money you move between your own accounts isn't counted as spending)" name="selfName" placeholder="e.g. Asha Verma"></md-outlined-text-field>
      <div class="row">
        <md-filled-button data-action="discover">Scan my mail for accounts</md-filled-button>
        <md-text-button data-action="skip-accounts">Skip, I'll add them manually</md-text-button>
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
  root.querySelector<HTMLInputElement>('[name=clientFile]')?.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    root.querySelector<HTMLTextAreaElement>('[name=clientJson]')!.value = await f.text();
  });
  onAction(root, {
    copy: (el) => {
      const text = el.closest<HTMLElement>('[data-copy]')?.dataset.copy ?? '';
      navigator.clipboard?.writeText(text).then(() => toast('Copied'));
    },
    google: async () => {
      const rawText = root.querySelector<HTMLTextAreaElement>('[name=clientJson]')!.value.trim();
      const c = parseClientJson(rawText);
      if (!c.clientId) {
        toast('Could not find a client_id in that text', 'error');
        return;
      }
      if (c.kind === 'installed' && !isLocalhost()) {
        toast('That is a Desktop-app client: it only works at http://localhost. On a phone or a hosted URL you need a Web application client.', 'error');
        return;
      }
      saveSettings({ googleClientId: c.clientId, googleClientSecret: c.clientSecret });
      await startSignIn('#/setup?step=gemini');
    },
    gemini: async () => {
      const key = root.querySelector<HTMLInputElement>('[name=geminiKey]')!.value.trim();
      const modelBulk = root.querySelector<HTMLInputElement>('[name=modelBulk]')!.value.trim();
      const modelReasoning = root.querySelector<HTMLInputElement>('[name=modelReasoning]')!.value.trim();
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
    'find-sheets': async (el) => {
      const box = root.querySelector<HTMLElement>('#sheet-list')!;
      el.setAttribute('disabled', '');
      box.innerHTML = spinner('Looking in your Drive…');
      try {
        const files = await listOwnSpreadsheets();
        box.innerHTML = files.length
          ? files.map((f) => `<div class="list-item"><div class="grow"><div class="title">${escapeHtml(f.name)}</div><div class="sub">last changed ${new Date(f.modifiedTime).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div></div><md-filled-button data-small data-action="pick-sheet" data-id="${f.id}">Connect</md-filled-button></div>`).join('')
          : `<p class="small muted">No PaisaBook sheets found in this Google account. (Only sheets created by this app are visible; a sheet you created by hand needs its URL pasted below.)</p>`;
      } catch (err) {
        box.innerHTML = `<p class="pill bad">${escapeHtml(String((err as Error).message))}</p>`;
      } finally {
        el.removeAttribute('disabled');
      }
    },
    'pick-sheet': async (el) => {
      root.querySelector<HTMLInputElement>('[name=sheetId]')!.value = el.dataset.id!;
      root.querySelector<HTMLElement>('[data-action=connect-sheet]')?.click();
    },
    'connect-sheet': async () => {
      const input = root.querySelector<HTMLInputElement>('[name=sheetId]')!.value.trim();
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
        // Headers + snippets from bank-ish senders only: enough for discovery at a
        // fraction of the Gmail quota. Bodies are downloaded (and cached) by the sync.
        const scan = await scanMailbox(daysAgoIso(60), todayIso(), {
          reprocess: true,
          metaOnly: true,
          sendersOnly: true,
          maxEmails: 500,
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
    'skip-accounts': async (el) => {
      el.setAttribute('disabled', '');
      await saveSelf(root).catch(() => {});
      saveSettings({ setupDone: true });
      navigate('/accounts');
    },
    'add-selected': async (el) => {
      const box = el.closest<HTMLElement>('#discover-status')!;
      const picks = [...box.querySelectorAll<HTMLInputElement>('md-checkbox[data-proposal]')].filter((c) => c.checked);
      if (!picks.length) return toast('Tick at least one account, or skip', 'error');
      const buttons = [...box.querySelectorAll<HTMLButtonElement>('button')];
      buttons.forEach((b) => b.setAttribute('disabled', ''));
      const busy = document.createElement('div');
      busy.innerHTML = spinner(`Adding ${picks.length} account${picks.length > 1 ? 's' : ''} to your sheet…`);
      box.appendChild(busy);
      try {
        await saveSelf(root);
        await addAccounts(
          picks.map((p) => {
            const d = JSON.parse(p.dataset.proposal!) as AccountProposal;
            return { kind: d.kind, institution: d.institution, account_ref: d.last4 ? `XX${d.last4}` : '', statement_sender: d.statement_sender };
          }),
        );
        toast(`${picks.length} accounts added`, 'ok');
        saveSettings({ setupDone: true });
        navigate('/setup?step=done');
      } catch (err) {
        busy.remove();
        buttons.forEach((b) => b.removeAttribute('disabled'));
        toast(`Couldn't add accounts: ${String((err as Error).message)}`, 'error');
      }
    },
    'add-manual': async () => {
      const r = await modal(
        `<md-outlined-select class="field" label="Type" name="kind"><md-select-option value="bank"><div slot="headline">Bank account</div></md-select-option><md-select-option value="credit_card"><div slot="headline">Credit card</div></md-select-option><md-select-option value="cash"><div slot="headline">Cash</div></md-select-option><md-select-option value="wallet"><div slot="headline">Wallet</div></md-select-option></md-outlined-select>
         <md-outlined-text-field class="field" label="Institution" name="institution" placeholder="HDFC Bank" required></md-outlined-text-field>
         <md-outlined-text-field class="field" label="Masked number (last 4)" name="ref" placeholder="XX1234"></md-outlined-text-field>`,
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
        Here's what was found so far. <md-outlined-button data-small data-action="discover">Continue scanning from there</md-outlined-button> or add these and move on.</div>`
    : '';
  if (!proposals.length) {
    box.innerHTML = `${banner}<p class="muted">No bank or card emails found${partial ? ' yet' : ' in the last 60 days'}. Add accounts manually.</p>
      <div class="row"><md-outlined-button data-action="add-manual">Add manually</md-outlined-button><md-filled-button data-action="skip-accounts">Continue</md-filled-button></div>`;
    return;
  }
  box.innerHTML = `${banner}<div class="stack">${proposals
    .map(
      (p) => `<label class="check"><md-checkbox touch-target="wrapper" checked data-proposal='${escapeHtml(JSON.stringify(p))}'></md-checkbox>
        <span><strong>${escapeHtml(p.institution)}</strong> ${p.kind === 'credit_card' ? 'card' : 'account'} ${p.last4 ? `••${p.last4}` : ''}
        <span class="muted small">— seen ${p.seen}× · e.g. “${escapeHtml(p.example_subject)}”${p.statement_sender ? ` · statements from ${escapeHtml(p.statement_sender)}` : ''}</span></span></label>`,
    )
    .join('')}
    <div class="row"><md-filled-button data-action="add-selected">Add selected</md-filled-button><md-outlined-button data-action="add-manual">Add another manually</md-outlined-button></div></div>`;
}

async function saveSelf(root: HTMLElement): Promise<void> {
  const name = root.querySelector<HTMLInputElement>('[name=selfName]')?.value.trim();
  if (!name || db.family.rows.some((f) => f.relation === 'self')) return;
  await db.append(db.family, [{ id: newId('fam'), name, relation: 'self', created_at: stamp() }]);
}

/** Accepts the downloaded client JSON (web or installed) or a bare client id. */
export function parseClientJson(text: string): { clientId: string; clientSecret: string; kind: 'web' | 'installed' | 'id' } {
  try {
    const j = JSON.parse(text) as { web?: { client_id?: string; client_secret?: string }; installed?: { client_id?: string; client_secret?: string } };
    const kind = j.web ? 'web' : j.installed ? 'installed' : null;
    const c = j.web ?? j.installed;
    if (kind && c?.client_id) return { clientId: c.client_id, clientSecret: c.client_secret ?? '', kind };
  } catch {
    /* not JSON */
  }
  const m = /[\w-]+\.apps\.googleusercontent\.com/.exec(text);
  return { clientId: m ? m[0] : '', clientSecret: '', kind: 'id' };
}

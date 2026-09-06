# PaisaBook

An open-source personal-finance PWA for India that runs **entirely in your
browser**. It reads your bank and card alerts from Gmail, opens the
password-protected statement PDFs the banks email you, deduplicates
everything into one ledger, categorizes it with Gemini, and stores it all in
a **Google Sheet you own**. Install it on your phone from the browser.

No server. No database of yours on anyone else's machine. The only things
that ever see your data are Google (Gmail, Sheets) and the Gemini API key you
bring.

## What it does

- **Setup wizard**: paste your Google OAuth client JSON → Gemini key → create
  or connect the ledger sheet → scan mail and tick the accounts it proposes.
- **Sync any period**: last 3 months by default, or any date range. Skips
  already-processed mail, so re-running is cheap. Stop any time; completed
  work is already in the sheet.
- **Statement PDFs**: found in mail (or picked from your device), opened with
  the password you enter (remembered per account on the device only),
  extracted by Gemini, reconciled against alerts (statement is authoritative,
  alerts are promoted, not duplicated).
- **Categorization**: your rules → AI with memory of your corrections. Stable
  AI verdicts are promoted to rules behind a precision guard so repeat
  merchants stop costing API calls.
- **Dashboard**: real spend (transfers, card-bill payments and investments
  excluded), income, invested, accrual net vs cash net, category bars, top
  merchants, month-by-month table, card bills due, settlement status
  (✓ once every card's statement for the month has landed).
- **Other sources**: point it at any Google Sheet (expense log, pasted bank
  CSV, Splitwise export). Gemini proposes the column mapping, you confirm,
  rows import with the same dedup.
- **Ledger**: filter by month/account/category/status, search, re-categorize
  inline, mark duplicates, attach unmatched alerts to accounts, add manual
  cash entries, export CSV.

Source: https://github.com/kumarranjansingh19-code/paisabook

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

For your phone you need an **https** origin (Google OAuth won't accept a LAN
IP). Easiest: deploy to GitHub Pages — fork the repo, enable Pages
(Settings → Pages → Source: GitHub Actions), and the included workflow
publishes `https://<you>.github.io/paisabook/` on every push. Or expose your
dev server with any https tunnel (`cloudflared tunnel --url http://localhost:5173`).

Then open it, run the wizard, and use the browser's *Add to Home Screen*.

## Google setup (one time)

1. [Google Cloud Console](https://console.cloud.google.com/) → new project.
2. Enable **Gmail API** and **Google Sheets API**.
3. OAuth consent screen → External → add yourself as a *test user*. Leave it
   in Testing (no verification needed for personal use).
4. Credentials → OAuth client ID → **Web application** → add your app URL to
   *Authorized JavaScript origins* (no trailing slash) **and** *Authorized
   redirect URIs* (with trailing slash, exactly what the wizard shows).
5. Download the JSON; paste it in the wizard.
6. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) for a Gemini
   key. **Enable billing** on its project — on the free tier Google may train
   on your prompts, which here means your bank statements.

## How the ledger stays honest

- Every transaction carries a fingerprint: `account | date | direction |
  amount | ref-no-or-normalized-narration`. Alerts create *provisional* rows;
  statements *confirm* matches (exact → fuzzy ±2 days → cross-statement).
- Statement re-imports are no-ops (file hash). Emails are logged so they are
  never re-read unless you ask.
- Amounts are integer paise; the model never does arithmetic. Extracted
  statement totals are checked against the printed totals and flagged.
- Rows are never deleted from the sheet, only marked `superseded`, so sheet
  row numbers stay stable and you can always audit history.

## The sheet

Tabs: `accounts`, `transactions`, `statements`, `rules`, `emails`,
`settings`, `sources`, `family`. Header row = schema; you may add columns of
your own. Secrets (OAuth client id, Gemini key, PDF passwords, tokens) are
**never** written to the sheet — they stay in the browser's localStorage.

## Security notes

- The OAuth token (1 hour) lives in localStorage of your browser only. Sign
  out from Settings to revoke it.
- Restrict the Gemini key to your app's HTTP referrer in Google Cloud.
- Anyone with access to your device's browser profile can read the stored
  keys — treat it like your banking app.

## Development

```bash
npm run typecheck
npm test
npm run build && npm run preview
```

`src/core` is framework-free logic (also what the tests cover); `src/views`
is plain DOM. No UI framework, no state library — the sheet mirror in
`src/store/db.ts` is the state.

Deploying under a sub-path: `BASE_PATH=/paisabook/ npm run build`.

## License

MIT
